/**
 * Maestro player virtualizer & mixed-queue Widevine `drm_local_fallback` controller (`MAIN` world).
 *
 * Coordinates remote playback handoff (`load_track`, `set_paused`, `seek`, `stop`),
 * mirrors receiver `PlaybackTelemetry` into virtualized `HTMLMediaElement` state,
 * enforces the strict `0 dB` Amp-Volume invariant (never forwarding volume changes),
 * and seamlessly plays CENC-only tracks locally before auto-resuming remote handoff.
 */

import {
  TOSLINK_SEEK_DEBOUNCE_MS,
  type PlaybackTelemetry,
} from '@soundclud/protocol';
import type {
  IsolatedToMainMessage,
  MainToIsolatedMessage,
} from '../shared/messages.js';
import {
  isKeepaliveAudioElement,
  type MediaKeyKeepaliveController,
} from './mediaKeyKeepalive.js';
import { SeekDebouncer } from './seekDebouncer.js';
import type { SoundCloudSessionObserver } from './sessionObserver.js';
import type {
  CatalogTrackEntry,
  SoundCloudTrackCatalog,
} from './trackCatalog.js';

export type VirtualizerMode = 'disabled' | 'remote' | 'drm_local_fallback';

export interface DomTrackHint {
  readonly trackId?: string | undefined;
  readonly permalinkOrPath?: string | undefined;
}

export interface NativeMediaBridge {
  pauseElement(element: EventTarget): void;
  getNativeCurrentTimeSeconds(element: EventTarget): number;
  getNativePaused(element: EventTarget): boolean;
}

export interface MaestroVirtualizerOptions {
  readonly catalog: SoundCloudTrackCatalog;
  readonly sessionObserver: SoundCloudSessionObserver;
  readonly sendToIsolated: (message: MainToIsolatedMessage) => void;
  readonly keepalive?: MediaKeyKeepaliveController | undefined;
  readonly nativeBridge?: NativeMediaBridge | undefined;
  readonly resolveDomTrackHint?: (() => DomTrackHint | undefined) | undefined;
  readonly onNavigateQueue?: ((direction: 'next' | 'previous') => void) | undefined;
}

export function createVirtualTimeRanges(endSeconds: number): TimeRanges {
  const safeEnd = Number.isFinite(endSeconds) && endSeconds > 0 ? endSeconds : 0;
  if (safeEnd <= 0) {
    return {
      length: 0,
      start(): number {
        throw new DOMException('Index out of bounds', 'IndexSizeError');
      },
      end(): number {
        throw new DOMException('Index out of bounds', 'IndexSizeError');
      },
    };
  }
  return {
    length: 1,
    start(index: number): number {
      if (index !== 0) {
        throw new DOMException('Index out of bounds', 'IndexSizeError');
      }
      return 0;
    },
    end(index: number): number {
      if (index !== 0) {
        throw new DOMException('Index out of bounds', 'IndexSizeError');
      }
      return safeEnd;
    },
  };
}

function dispatchMediaEvent(target: EventTarget | null, eventName: string): void {
  if (target === null || typeof Event === 'undefined') {
    return;
  }
  try {
    target.dispatchEvent(new Event(eventName));
  } catch {
    // Ignore detached target dispatch failures.
  }
}

export class MaestroVirtualizerController {
  private readonly catalog: SoundCloudTrackCatalog;
  private readonly sessionObserver: SoundCloudSessionObserver;
  private readonly sendToIsolated: (message: MainToIsolatedMessage) => void;
  private readonly keepalive: MediaKeyKeepaliveController | undefined;
  private readonly nativeBridge: NativeMediaBridge | undefined;
  private readonly resolveDomTrackHint: (() => DomTrackHint | undefined) | undefined;
  private readonly seekDebouncer: SeekDebouncer;
  private readonly unsubscribeCatalog: () => void;

  private handoffEnabled = false;
  private mode: VirtualizerMode = 'disabled';
  private commandSeqCounter = 0;

  private primaryMediaElement: EventTarget | null = null;
  private activeRemoteTrackId: string | null = null;
  private activeLocatorId: string | null = null;

  private virtualPaused = true;
  private virtualEnded = false;
  private virtualVolume = 1;
  private virtualMuted = false;

  private telemetryPositionMs = 0;
  private telemetryDurationMs = 0;
  private telemetryBufferedMs = 0;

  public constructor(options: MaestroVirtualizerOptions) {
    this.catalog = options.catalog;
    this.sessionObserver = options.sessionObserver;
    this.sendToIsolated = options.sendToIsolated;
    this.keepalive = options.keepalive;
    this.nativeBridge = options.nativeBridge;
    this.resolveDomTrackHint = options.resolveDomTrackHint;

    this.seekDebouncer = new SeekDebouncer({
      initialDebounceMs: TOSLINK_SEEK_DEBOUNCE_MS,
      allocateCommandSeq: () => this.allocateCommandSeq(),
      onCommitSeek: (positionMs, commandSeq) => {
        this.sendToIsolated({
          type: 'request_seek',
          commandSeq,
          positionMs,
        });
      },
      onSeekSettled: () => {
        dispatchMediaEvent(this.primaryMediaElement, 'seeked');
        dispatchMediaEvent(this.primaryMediaElement, 'timeupdate');
      },
    });

    // Proactively switch mode before MSE `SourceBuffer.appendBuffer` runs on mixed queues!
    this.unsubscribeCatalog = this.catalog.onTrackStreamResolved(
      (track, selection) => {
        if (!this.handoffEnabled) {
          return;
        }
        if (selection.kind === 'drm_local_fallback') {
          this.enterDrmLocalFallback(track);
        } else if (
          selection.kind === 'playable' &&
          this.mode === 'drm_local_fallback'
        ) {
          this.mode = 'remote';
          if (this.primaryMediaElement !== null) {
            this.nativeBridge?.pauseElement(this.primaryMediaElement);
          }
          this.sendToIsolated({ type: 'drm_local_fallback_cleared' });
        }
      },
    );
  }

  public getMode(): VirtualizerMode {
    return this.mode;
  }

  public isHandoffEnabled(): boolean {
    return this.handoffEnabled;
  }

  public getSeekDebounceMs(): number {
    return this.seekDebouncer.getDebounceMs();
  }

  public isElementVirtualized(element: unknown): boolean {
    if (!this.handoffEnabled || this.mode !== 'remote') {
      return false;
    }
    if (isKeepaliveAudioElement(element)) {
      return false;
    }
    return true;
  }

  public shouldVirtualizeSourceBuffer(): boolean {
    return this.handoffEnabled && this.mode === 'remote';
  }

  public handleIsolatedMessage(message: IsolatedToMainMessage): void {
    switch (message.type) {
      case 'sync_runtime_state': {
        this.seekDebouncer.setDebounceMs(message.seekDebounceMs);
        this.setHandoffEnabled(message.handoffEnabled);
        if (message.telemetry !== undefined) {
          this.applyTelemetry(message.telemetry, message.lastAckedCommandSeq);
        } else {
          this.seekDebouncer.acknowledgeCommandSeq(message.lastAckedCommandSeq);
        }
        break;
      }
      case 'telemetry_tick': {
        this.applyTelemetry(message.telemetry, message.lastAckedCommandSeq);
        break;
      }
      case 'track_ended': {
        this.handleTrackEnded(message.trackId, message.locatorId);
        break;
      }
      case 'refresh_locator_request': {
        this.handleRefreshLocatorRequest(message.requestId, message.trackId);
        break;
      }
      case 'session_claimed': {
        this.handleSessionClaimed();
        break;
      }
    }
  }

  public setHandoffEnabled(enabled: boolean): void {
    if (this.handoffEnabled === enabled) {
      return;
    }
    this.handoffEnabled = enabled;

    if (!enabled) {
      this.mode = 'disabled';
      this.seekDebouncer.reset();
      this.keepalive?.stopAll();
      if (this.activeRemoteTrackId !== null) {
        this.sendToIsolated({
          type: 'request_stop',
          commandSeq: this.allocateCommandSeq(),
          reason: 'handoff_disabled',
        });
      }
      this.activeRemoteTrackId = null;
      this.activeLocatorId = null;
      this.virtualPaused = true;
      dispatchMediaEvent(this.primaryMediaElement, 'pause');
      return;
    }

    this.mode = 'remote';
    // If SoundCloud was already playing locally when handoff toggled ON, seamlessly hand off!
    if (
      this.primaryMediaElement !== null &&
      this.nativeBridge !== undefined &&
      !this.nativeBridge.getNativePaused(this.primaryMediaElement)
    ) {
      const currentSec = this.nativeBridge.getNativeCurrentTimeSeconds(
        this.primaryMediaElement,
      );
      this.nativeBridge.pauseElement(this.primaryMediaElement);
      this.interceptPlay(this.primaryMediaElement, undefined, currentSec * 1000);
    }
  }

  public interceptPlay(
    element: EventTarget,
    mediaSrc?: string,
    explicitStartPositionMs?: number,
  ): { readonly handledRemotely: boolean } {
    if (isKeepaliveAudioElement(element)) {
      return { handledRemotely: false };
    }
    this.primaryMediaElement = element;

    if (!this.handoffEnabled) {
      return { handledRemotely: false };
    }

    const candidateTrack = this.resolveCandidateTrack(mediaSrc);
    if (candidateTrack === undefined) {
      return { handledRemotely: false };
    }

    const startPositionMs =
      explicitStartPositionMs ??
      (this.activeRemoteTrackId === candidateTrack.trackId && !this.virtualEnded
        ? this.getCurrentTimeSeconds() * 1000
        : 0);

    const resolution = this.catalog.buildLocatorForTrack(
      candidateTrack.trackId,
      this.sessionObserver.getSnapshot(),
      startPositionMs,
    );

    if (resolution.kind === 'drm_local_fallback') {
      this.enterDrmLocalFallback(resolution.track);
      return { handledRemotely: false };
    }

    if (resolution.kind === 'unplayable') {
      return { handledRemotely: false };
    }

    const wasDrmFallback = this.mode === 'drm_local_fallback';
    this.mode = 'remote';
    if (wasDrmFallback) {
      this.sendToIsolated({ type: 'drm_local_fallback_cleared' });
    }

    this.nativeBridge?.pauseElement(element);

    const isSameLoadedTrack =
      this.activeRemoteTrackId === resolution.track.trackId &&
      this.activeLocatorId !== null &&
      !this.virtualEnded;

    this.virtualPaused = false;
    this.virtualEnded = false;

    if (isSameLoadedTrack) {
      this.sendToIsolated({
        type: 'request_set_paused',
        commandSeq: this.allocateCommandSeq(),
        paused: false,
      });
    } else {
      this.seekDebouncer.reset();
      this.activeRemoteTrackId = resolution.track.trackId;
      this.activeLocatorId = resolution.locator.locatorId;
      this.telemetryPositionMs = resolution.locator.startPositionMs;
      this.telemetryDurationMs = resolution.track.durationMs;
      this.telemetryBufferedMs = Math.min(
        resolution.track.durationMs,
        resolution.locator.startPositionMs + 12_000,
      );
      this.sendToIsolated({
        type: 'request_load_track',
        commandSeq: this.allocateCommandSeq(),
        locator: resolution.locator,
      });
    }

    this.keepalive?.updateMetadata(resolution.locator.track);
    void this.keepalive?.setActive(true);
    dispatchMediaEvent(element, 'play');
    dispatchMediaEvent(element, 'playing');

    return { handledRemotely: true };
  }

  public interceptPause(element: EventTarget): boolean {
    if (!this.isElementVirtualized(element)) {
      return false;
    }
    this.primaryMediaElement = element;
    if (!this.virtualPaused) {
      this.virtualPaused = true;
      void this.keepalive?.setActive(false);
      this.sendToIsolated({
        type: 'request_set_paused',
        commandSeq: this.allocateCommandSeq(),
        paused: true,
      });
      dispatchMediaEvent(element, 'pause');
    }
    return true;
  }

  public interceptSeekSeconds(element: EventTarget, targetSeconds: number): boolean {
    if (!this.isElementVirtualized(element)) {
      return false;
    }
    this.primaryMediaElement = element;
    this.virtualEnded = false;
    this.seekDebouncer.requestSeekSeconds(targetSeconds);
    dispatchMediaEvent(element, 'seeking');
    dispatchMediaEvent(element, 'timeupdate');
    return true;
  }

  /**
   * Strict `0 dB` Amp-Volume Invariant: caches UI volume/mute state locally so
   * SoundCloud's web controls never throw, while emitting ZERO remote commands.
   */
  public recordLocalUiVolumeMutation(volume?: number, muted?: boolean): void {
    if (typeof volume === 'number' && Number.isFinite(volume)) {
      this.virtualVolume = Math.min(1, Math.max(0, volume));
    }
    if (typeof muted === 'boolean') {
      this.virtualMuted = muted;
    }
  }

  public getVirtualVolume(): number {
    return this.virtualVolume;
  }

  public getVirtualMuted(): boolean {
    return this.virtualMuted;
  }

  public getCurrentTimeSeconds(): number {
    return this.seekDebouncer.getEffectivePositionMs(this.telemetryPositionMs) / 1000;
  }

  public getDurationSeconds(fallbackSeconds: number): number {
    if (this.telemetryDurationMs > 0) {
      return this.telemetryDurationMs / 1000;
    }
    return fallbackSeconds;
  }

  public getBufferedTimeRanges(): TimeRanges {
    const posSec = this.getCurrentTimeSeconds();
    const bufSec = Math.max(posSec, this.telemetryBufferedMs / 1000);
    return createVirtualTimeRanges(bufSec);
  }

  public getPaused(): boolean {
    return this.virtualPaused;
  }

  public getSeeking(): boolean {
    return this.seekDebouncer.isSeeking;
  }

  public getEnded(): boolean {
    return this.virtualEnded;
  }

  public applyTelemetry(
    telemetry: PlaybackTelemetry,
    lastAckedCommandSeq: number,
  ): void {
    this.seekDebouncer.acknowledgeCommandSeq(lastAckedCommandSeq);

    if (this.mode !== 'remote') {
      return;
    }

    this.telemetryPositionMs = telemetry.positionMs;
    if (telemetry.durationMs > 0) {
      this.telemetryDurationMs = telemetry.durationMs;
    }
    this.telemetryBufferedMs = Math.max(telemetry.positionMs, telemetry.bufferedMs);

    if (telemetry.phase === 'playing') {
      this.virtualPaused = false;
    } else if (telemetry.phase === 'paused') {
      this.virtualPaused = true;
    }

    this.keepalive?.updatePositionState(
      this.seekDebouncer.getEffectivePositionMs(this.telemetryPositionMs),
      this.telemetryDurationMs,
    );

    dispatchMediaEvent(this.primaryMediaElement, 'timeupdate');
    dispatchMediaEvent(this.primaryMediaElement, 'progress');
  }

  public handleTrackEnded(trackId: string, locatorId: string): void {
    if (
      this.activeRemoteTrackId !== null &&
      this.activeRemoteTrackId !== trackId &&
      this.activeLocatorId !== locatorId
    ) {
      return;
    }
    this.virtualPaused = true;
    this.virtualEnded = true;
    if (this.telemetryDurationMs > 0) {
      this.telemetryPositionMs = this.telemetryDurationMs;
    }
    this.activeLocatorId = null;
    void this.keepalive?.setActive(false);
    dispatchMediaEvent(this.primaryMediaElement, 'timeupdate');
    dispatchMediaEvent(this.primaryMediaElement, 'ended');
  }

  public handleSessionClaimed(): void {
    this.virtualPaused = true;
    this.activeRemoteTrackId = null;
    this.activeLocatorId = null;
    this.seekDebouncer.reset();
    this.keepalive?.stopAll();
    dispatchMediaEvent(this.primaryMediaElement, 'pause');
  }

  public handleRefreshLocatorRequest(requestId: string, trackId: string): void {
    const resolution = this.catalog.buildLocatorForTrack(
      trackId,
      this.sessionObserver.getSnapshot(),
      this.telemetryPositionMs,
    );
    if (resolution.kind === 'playable') {
      this.sendToIsolated({
        type: 'refresh_locator_result',
        requestId,
        locator: resolution.locator,
      });
    } else {
      this.sendToIsolated({
        type: 'refresh_locator_result',
        requestId,
        error: `Unable to refresh locator for track ${trackId} (${resolution.kind})`,
      });
    }
  }

  public registerObservedMediaElement(element: EventTarget): void {
    if (!isKeepaliveAudioElement(element) && this.primaryMediaElement === null) {
      this.primaryMediaElement = element;
    }
  }

  public dispose(): void {
    this.unsubscribeCatalog();
    this.seekDebouncer.reset();
    this.keepalive?.dispose();
  }

  private enterDrmLocalFallback(track: CatalogTrackEntry): void {
    const hadRemoteSession = this.activeRemoteTrackId !== null;
    this.mode = 'drm_local_fallback';
    this.activeRemoteTrackId = null;
    this.activeLocatorId = null;
    this.seekDebouncer.reset();
    this.keepalive?.stopAll();

    if (hadRemoteSession) {
      this.sendToIsolated({
        type: 'request_stop',
        commandSeq: this.allocateCommandSeq(),
        reason: 'drm_local_fallback',
      });
    }
    this.sendToIsolated({
      type: 'drm_local_fallback_active',
      trackId: track.trackId,
      title: track.title,
      artist: track.artist,
    });
  }

  private resolveCandidateTrack(mediaSrc?: string): CatalogTrackEntry | undefined {
    if (
      typeof mediaSrc === 'string' &&
      mediaSrc.length > 0 &&
      !mediaSrc.startsWith('blob:')
    ) {
      const byMedia = this.catalog.findTrackByMediaOrResolveUrl(mediaSrc);
      if (byMedia !== undefined) {
        return byMedia;
      }
    }

    const recent = this.catalog.getMostRecentlyResolvedTrack();
    if (recent !== undefined) {
      return recent;
    }

    const hint = this.resolveDomTrackHint?.();
    if (hint?.trackId !== undefined) {
      const byId = this.catalog.findTrackById(hint.trackId);
      if (byId !== undefined) {
        return byId;
      }
    }
    if (hint?.permalinkOrPath !== undefined) {
      const byPermalink = this.catalog.findTrackByPermalink(hint.permalinkOrPath);
      if (byPermalink !== undefined) {
        return byPermalink;
      }
    }
    return undefined;
  }

  private allocateCommandSeq(): number {
    this.commandSeqCounter += 1;
    return this.commandSeqCounter;
  }
}
