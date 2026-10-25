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
  type PlaybackPhase,
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
import {
  normalizeSoundCloudPermalinkPath,
  type CatalogTrackEntry,
  type SoundCloudTrackCatalog,
} from './trackCatalog.js';

export type VirtualizerMode = 'disabled' | 'remote' | 'drm_local_fallback';

export interface DomTrackHint {
  readonly trackId?: string | undefined;
  readonly permalinkOrPath?: string | undefined;
  readonly title?: string | undefined;
  readonly isPlayerBadge?: boolean | undefined;
}

export interface NativeMediaBridge {
  pauseElement(element: EventTarget): void;
  getNativeCurrentTimeSeconds(element: EventTarget): number;
  getNativePaused(element: EventTarget): boolean;
  readonly playElement?: ((element: EventTarget) => void) | undefined;
  readonly setNativeCurrentTimeSeconds?:
    | ((element: EventTarget, seconds: number) => void)
    | undefined;
}

export interface MaestroVirtualizerOptions {
  readonly catalog: SoundCloudTrackCatalog;
  readonly sessionObserver: SoundCloudSessionObserver;
  readonly sendToIsolated: (message: MainToIsolatedMessage) => void;
  readonly keepalive?: MediaKeyKeepaliveController | undefined;
  readonly nativeBridge?: NativeMediaBridge | undefined;
  readonly resolveDomTrackHint?: (() => DomTrackHint | undefined) | undefined;
  readonly onNavigateQueue?: ((direction: 'next' | 'previous') => void) | undefined;
  readonly nowPerfMs?: (() => number) | undefined;
}

const HEALTHY_FORWARD_BUFFER_SECONDS = 120;
const TIMEUPDATE_INTERVAL_MS = 250;
const PLAY_CREEP_RATE = 0.12;
const PLAY_CREEP_MAX_MS = 250;
const MINOR_BACKWARD_JITTER_MS = 1_200;
const MAX_SOFT_DRIFT_MS = 2_500;
const STALL_NUDGE_MIN_SECONDS = 0.04;
const STALL_NUDGE_MAX_SECONDS = 0.22;
const USER_INTERACTION_WINDOW_MS = 750;
const PENDING_STREAM_DOM_POLL_MS = 60;

type CandidateTrackOutcome =
  | { readonly status: 'resolved'; readonly track: CatalogTrackEntry }
  | { readonly status: 'awaiting_stream' }
  | { readonly status: 'none' };

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
  private readonly readPerfNowMs: () => number;
  private readonly seekDebouncer: SeekDebouncer;
  private readonly unsubscribeCatalog: () => void;

  private handoffEnabled = false;
  private mode: VirtualizerMode = 'disabled';
  private commandSeqCounter = 0;
  private latestTransportCommandSeq = 0;

  private primaryMediaElement: EventTarget | null = null;
  private activeRemoteTrackId: string | null = null;
  private activeRemoteTrackPermalink: string | null = null;
  private activeRemoteBlobUrl: string | null = null;
  private activeLocatorId: string | null = null;
  private activeTrackStreamObservationSeq = 0;

  private latestMediaElementSrc = '';
  private mediaElementAwaitingFreshTrack = false;
  private pendingPlayAwaitingStream = false;
  private pendingSeekPositionMs: number | null = null;
  private pendingDomPollTimerId: ReturnType<typeof setTimeout> | null = null;
  private pendingSeekEventTimerId: ReturnType<typeof setTimeout> | null = null;
  private timeupdateTimerId: ReturnType<typeof setInterval> | null = null;

  private virtualPaused = true;
  private virtualSeeking = false;
  private virtualEnded = false;
  private virtualVolume = 1;
  private virtualMuted = false;

  private telemetryPositionMs = 0;
  private telemetryDurationMs = 0;
  private telemetryBufferedMs = 0;

  private anchorPositionMs = 0;
  private anchorPerfNowMs = 0;
  private interpolationRate = 1;
  private receiverPhase: PlaybackPhase = 'idle';
  private hasReceivedPlayingTickForTrack = false;
  private playCreepOriginPositionMs = 0;
  private playCreepStartPerfNowMs = 0;
  private lastUserInteractionPerfMs = Number.NEGATIVE_INFINITY;

  public constructor(options: MaestroVirtualizerOptions) {
    this.catalog = options.catalog;
    this.sessionObserver = options.sessionObserver;
    this.sendToIsolated = options.sendToIsolated;
    this.keepalive = options.keepalive;
    this.nativeBridge = options.nativeBridge;
    this.resolveDomTrackHint = options.resolveDomTrackHint;
    this.readPerfNowMs =
      options.nowPerfMs ??
      ((): number =>
        typeof performance !== 'undefined' && typeof performance.now === 'function'
          ? performance.now()
          : Date.now());

    this.seekDebouncer = new SeekDebouncer({
      initialDebounceMs: TOSLINK_SEEK_DEBOUNCE_MS,
      allocateCommandSeq: () => this.allocateCommandSeq(),
      onCommitSeek: (positionMs, commandSeq) => {
        this.emitTransportCommand({
          type: 'request_seek',
          commandSeq,
          positionMs,
        });
      },
      onSeekSettled: () => {
        dispatchMediaEvent(this.primaryMediaElement, 'timeupdate');
      },
    });

    // Handle deferred play-before-resolve handoff AND mixed-queue Widevine switches!
    this.unsubscribeCatalog = this.catalog.onTrackStreamResolved(
      (track, selection) => {
        if (!this.handoffEnabled) {
          return;
        }
        if (this.pendingPlayAwaitingStream) {
          this.commitPendingStreamTrack(track);
          return;
        }

        // Ignore background queue preloads while another track is actively playing!
        const hasActivePlayingRemoteTrack =
          this.activeRemoteTrackId !== null &&
          this.activeRemoteTrackId !== track.trackId &&
          !this.virtualEnded &&
          !this.mediaElementAwaitingFreshTrack;
        if (hasActivePlayingRemoteTrack) {
          return;
        }

        if (selection.kind === 'drm_local_fallback') {
          this.enterDrmLocalFallback(track);
        } else if (
          selection.kind === 'playable' &&
          this.mode === 'drm_local_fallback'
        ) {
          const isLocalDrmActivelyPlaying =
            this.primaryMediaElement !== null &&
            this.nativeBridge !== undefined &&
            !this.nativeBridge.getNativePaused(this.primaryMediaElement);
          if (!isLocalDrmActivelyPlaying || this.mediaElementAwaitingFreshTrack) {
            this.mode = 'remote';
            if (this.primaryMediaElement !== null) {
              this.nativeBridge?.pauseElement(this.primaryMediaElement);
            }
            this.sendToIsolated({ type: 'drm_local_fallback_cleared' });
          }
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

  public recordUserInteraction(): void {
    this.lastUserInteractionPerfMs = this.readPerfNowMs();
  }

  public interceptMediaSourceReset(
    element: EventTarget,
    nextSrc?: string,
  ): void {
    if (isKeepaliveAudioElement(element)) {
      return;
    }
    this.primaryMediaElement = element;
    this.latestMediaElementSrc = typeof nextSrc === 'string' ? nextSrc.trim() : '';
    if (!this.handoffEnabled) {
      return;
    }
    this.resetElementForFreshTrackTransition();
  }

  public interceptMediaElementLoad(element: EventTarget): void {
    if (isKeepaliveAudioElement(element)) {
      return;
    }
    this.primaryMediaElement = element;
    if (!this.handoffEnabled) {
      return;
    }
    this.resetElementForFreshTrackTransition();
  }

  public setHandoffEnabled(enabled: boolean): void {
    if (this.handoffEnabled === enabled) {
      return;
    }
    this.handoffEnabled = enabled;

    if (!enabled) {
      this.mode = 'disabled';
      this.seekDebouncer.reset();
      this.clearPendingSeekEventTimer();
      this.clearPendingStreamState();
      this.stopTimeupdateLoop();
      this.keepalive?.stopAll();
      if (this.activeRemoteTrackId !== null) {
        this.emitTransportCommand({
          type: 'request_stop',
          commandSeq: this.allocateCommandSeq(),
          reason: 'handoff_disabled',
        });
      }
      this.activeRemoteTrackId = null;
      this.activeRemoteTrackPermalink = null;
      this.activeRemoteBlobUrl = null;
      this.activeLocatorId = null;
      this.virtualPaused = true;
      this.virtualSeeking = false;
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
    if (typeof mediaSrc === 'string' && mediaSrc.trim().length > 0) {
      this.latestMediaElementSrc = mediaSrc.trim();
    }

    if (!this.handoffEnabled) {
      return { handledRemotely: false };
    }

    const effectiveSrc =
      typeof mediaSrc === 'string' && mediaSrc.trim().length > 0
        ? mediaSrc.trim()
        : this.latestMediaElementSrc.length > 0
          ? this.latestMediaElementSrc
          : undefined;

    const candidateOutcome = this.resolveCandidateTrackOutcome(effectiveSrc);
    if (candidateOutcome.status === 'none') {
      return { handledRemotely: false };
    }

    if (candidateOutcome.status === 'awaiting_stream') {
      const startMs = explicitStartPositionMs ?? this.pendingSeekPositionMs ?? 0;
      const wasDrmFallback = this.mode === 'drm_local_fallback';
      this.mode = 'remote';
      if (wasDrmFallback) {
        this.sendToIsolated({ type: 'drm_local_fallback_cleared' });
      }
      this.nativeBridge?.pauseElement(element);
      this.seekDebouncer.reset();
      this.pendingPlayAwaitingStream = true;
      this.pendingSeekPositionMs = startMs > 0 ? startMs : null;
      this.virtualPaused = false;
      this.virtualEnded = false;
      this.primePlayheadAnchor(startMs, 'loading', false);
      this.syncTimeupdateLoop();
      this.schedulePendingStreamDomCheck();
      dispatchMediaEvent(element, 'play');
      dispatchMediaEvent(element, 'playing');
      return { handledRemotely: true };
    }

    const candidateTrack = candidateOutcome.track;
    const isFreshSrcTransition =
      this.mediaElementAwaitingFreshTrack ||
      (effectiveSrc !== undefined &&
        effectiveSrc.startsWith('blob:') &&
        this.activeRemoteBlobUrl !== null &&
        effectiveSrc !== this.activeRemoteBlobUrl);

    const isSameLoadedTrack =
      !isFreshSrcTransition &&
      this.activeRemoteTrackId === candidateTrack.trackId &&
      this.activeLocatorId !== null &&
      !this.virtualEnded;

    const startPositionMs =
      explicitStartPositionMs ??
      this.pendingSeekPositionMs ??
      (isSameLoadedTrack ? this.getCurrentTimeSeconds() * 1000 : 0);

    this.clearPendingStreamState();

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
    this.virtualPaused = false;
    this.virtualEnded = false;
    this.mediaElementAwaitingFreshTrack = false;

    if (isSameLoadedTrack) {
      this.primePlayheadAnchor(
        startPositionMs,
        this.receiverPhase === 'playing' ? 'playing' : 'loading',
        this.receiverPhase === 'playing',
      );
      this.emitTransportCommand({
        type: 'request_set_paused',
        commandSeq: this.allocateCommandSeq(),
        paused: false,
      });
    } else {
      this.activateResolvedRemoteTrack(resolution, effectiveSrc);
    }

    this.syncTimeupdateLoop();
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
      const frozenMs = this.getCurrentTimeSeconds() * 1000;
      this.anchorPositionMs = frozenMs;
      this.anchorPerfNowMs = this.readPerfNowMs();
      this.virtualPaused = true;
      this.stopTimeupdateLoop();
      this.clearPendingStreamState();
      void this.keepalive?.setActive(false);
      if (this.activeRemoteTrackId !== null) {
        this.emitTransportCommand({
          type: 'request_set_paused',
          commandSeq: this.allocateCommandSeq(),
          paused: true,
        });
      }
      dispatchMediaEvent(element, 'pause');
    }
    return true;
  }

  public pauseFromMediaSession(): void {
    if (this.primaryMediaElement !== null && this.interceptPause(this.primaryMediaElement)) {
      return;
    }
    if (this.handoffEnabled && this.mode === 'remote' && !this.virtualPaused) {
      this.anchorPositionMs = this.getCurrentTimeSeconds() * 1000;
      this.anchorPerfNowMs = this.readPerfNowMs();
      this.virtualPaused = true;
      this.stopTimeupdateLoop();
      void this.keepalive?.setActive(false);
      this.emitTransportCommand({
        type: 'request_set_paused',
        commandSeq: this.allocateCommandSeq(),
        paused: true,
      });
    }
  }

  public seekFromMediaSession(seconds: number): void {
    if (!Number.isFinite(seconds)) {
      return;
    }
    const clampedSec = Math.max(0, seconds);
    this.recordUserInteraction();
    if (this.handoffEnabled && this.mode === 'remote') {
      if (this.primaryMediaElement !== null) {
        this.interceptSeekSeconds(this.primaryMediaElement, clampedSec);
        return;
      }
      this.virtualEnded = false;
      const targetMs = Math.round(clampedSec * 1000);
      this.anchorPositionMs = targetMs;
      this.anchorPerfNowMs = this.readPerfNowMs();
      this.seekDebouncer.requestSeekSeconds(clampedSec);
      return;
    }
    if (this.primaryMediaElement !== null) {
      this.nativeBridge?.setNativeCurrentTimeSeconds?.(
        this.primaryMediaElement,
        clampedSec,
      );
    }
  }

  public interceptSeekSeconds(element: EventTarget, targetSeconds: number): boolean {
    if (!this.isElementVirtualized(element)) {
      return false;
    }
    if (!Number.isFinite(targetSeconds)) {
      return true;
    }
    this.primaryMediaElement = element;
    const clampedSec = Math.max(0, targetSeconds);

    // Defense-in-depth: suppress `hls.js` GapController `_tryNudgeBuffer()`
    // synthetic micro-nudges (`+0.04s .. +0.22s`) when no user scrub occurred!
    if (
      !this.mediaElementAwaitingFreshTrack &&
      !this.pendingPlayAwaitingStream &&
      !this.seekDebouncer.hasPendingDebounce()
    ) {
      const currentSec = this.getCurrentTimeSeconds();
      const deltaSec = clampedSec - currentSec;
      const hadRecentUserGesture =
        this.readPerfNowMs() - this.lastUserInteractionPerfMs <=
        USER_INTERACTION_WINDOW_MS;
      if (
        !hadRecentUserGesture &&
        deltaSec >= STALL_NUDGE_MIN_SECONDS &&
        deltaSec <= STALL_NUDGE_MAX_SECONDS
      ) {
        return true;
      }
    }

    const targetMs = Math.round(clampedSec * 1000);
    this.virtualEnded = false;
    this.anchorPositionMs = targetMs;
    this.anchorPerfNowMs = this.readPerfNowMs();

    if (this.mediaElementAwaitingFreshTrack || this.pendingPlayAwaitingStream) {
      this.pendingSeekPositionMs = targetMs;
    } else {
      this.seekDebouncer.requestSeekSeconds(clampedSec);
    }

    this.scheduleAsyncSeekLifecycleEvents(element);
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
    if (
      this.pendingSeekPositionMs !== null &&
      (this.mediaElementAwaitingFreshTrack || this.pendingPlayAwaitingStream)
    ) {
      return Math.max(0, this.pendingSeekPositionMs) / 1000;
    }

    const pinnedMs = this.seekDebouncer.getPinnedPositionMs();
    if (pinnedMs !== null) {
      return pinnedMs / 1000;
    }

    if (this.mode !== 'remote' || this.virtualPaused || this.virtualEnded) {
      return Math.max(0, this.anchorPositionMs) / 1000;
    }

    const now = this.readPerfNowMs();
    if (this.receiverPhase === 'playing') {
      const elapsedMs = Math.max(0, now - this.anchorPerfNowMs) * this.interpolationRate;
      let posMs = this.anchorPositionMs + elapsedMs;
      if (this.telemetryDurationMs > 0) {
        posMs = Math.min(this.telemetryDurationMs, posMs);
      }
      return Math.max(0, posMs) / 1000;
    }

    // Gentle monotonic play-detection creep during initial 'loading' / 'waking_device'
    // so SoundCloud's 2.0s `_determineIfPlaying()` watchdog never times out during HEOS wake!
    if (!this.hasReceivedPlayingTickForTrack) {
      const creepElapsedMs = Math.max(0, now - this.playCreepStartPerfNowMs);
      const creepMs = Math.min(PLAY_CREEP_MAX_MS, creepElapsedMs * PLAY_CREEP_RATE);
      let posMs = Math.max(
        this.anchorPositionMs,
        this.playCreepOriginPositionMs + creepMs,
      );
      if (this.telemetryDurationMs > 0) {
        posMs = Math.min(this.telemetryDurationMs, posMs);
      }
      return Math.max(0, posMs) / 1000;
    }

    return Math.max(0, this.anchorPositionMs) / 1000;
  }

  public getDurationSeconds(fallbackSeconds: number): number {
    if (this.telemetryDurationMs > 0) {
      return this.telemetryDurationMs / 1000;
    }
    return fallbackSeconds;
  }

  public getBufferedTimeRanges(): TimeRanges {
    const posSec = this.getCurrentTimeSeconds();
    const telBufSec = Math.max(0, this.telemetryBufferedMs / 1000);
    if (this.mode === 'remote') {
      const durSec = this.telemetryDurationMs > 0 ? this.telemetryDurationMs / 1000 : 0;
      const healthyEndSec = Math.max(
        durSec,
        telBufSec,
        posSec + HEALTHY_FORWARD_BUFFER_SECONDS,
      );
      return createVirtualTimeRanges(healthyEndSec);
    }
    return createVirtualTimeRanges(Math.max(posSec, telBufSec));
  }

  public getPaused(): boolean {
    return this.virtualPaused;
  }

  public getSeeking(): boolean {
    return this.virtualSeeking;
  }

  public isSeekPendingAck(): boolean {
    return this.seekDebouncer.isSeeking;
  }

  public getEnded(): boolean {
    return this.virtualEnded;
  }

  public applyTelemetry(
    telemetry: PlaybackTelemetry,
    lastAckedCommandSeq: number,
  ): void {
    // 1. Ignore previous-track telemetry while awaiting stream resolution for a newly clicked track.
    if (this.pendingPlayAwaitingStream) {
      return;
    }

    // 2. Track-ID fencing: ignore telemetry belonging to a previous remote track.
    if (
      this.activeRemoteTrackId !== null &&
      telemetry.track?.trackId !== undefined &&
      telemetry.track.trackId !== this.activeRemoteTrackId
    ) {
      return;
    }

    if (this.mode !== 'remote') {
      this.seekDebouncer.acknowledgeCommandSeq(lastAckedCommandSeq, telemetry.positionMs);
      return;
    }

    // 3. Command-sequence fencing: never let unacked pre-command telemetry clobber
    //    optimistic `virtualPaused` or `positionMs`.
    if (lastAckedCommandSeq < this.latestTransportCommandSeq) {
      if (
        telemetry.durationMs > 0 &&
        telemetry.track?.trackId === this.activeRemoteTrackId
      ) {
        this.telemetryDurationMs = telemetry.durationMs;
      }
      if (
        telemetry.phase === 'waking_device' ||
        telemetry.phase === 'loading' ||
        telemetry.phase === 'buffering'
      ) {
        this.receiverPhase = telemetry.phase;
      }
      return;
    }

    const now = this.readPerfNowMs();
    const prevEffectiveMs = this.getCurrentTimeSeconds() * 1000;
    const hadPin = this.seekDebouncer.getPinnedPositionMs() !== null;

    // Update telemetry fields BEFORE acknowledging `SeekDebouncer` so any synchronous
    // observer sees the post-seek playhead immediately upon pin release.
    this.telemetryPositionMs = telemetry.positionMs;
    if (telemetry.durationMs > 0) {
      this.telemetryDurationMs = telemetry.durationMs;
    }
    this.telemetryBufferedMs = Math.max(telemetry.positionMs, telemetry.bufferedMs);

    if (hadPin) {
      this.anchorPositionMs = telemetry.positionMs;
      this.anchorPerfNowMs = now;
      this.interpolationRate = 1;
    }

    const seekPinReleased = this.seekDebouncer.acknowledgeCommandSeq(
      lastAckedCommandSeq,
      telemetry.positionMs,
    );
    const remainingPinMs = this.seekDebouncer.getPinnedPositionMs();

    this.receiverPhase = telemetry.phase;

    if (telemetry.phase === 'playing') {
      this.hasReceivedPlayingTickForTrack = true;
      this.virtualPaused = false;

      if (remainingPinMs !== null) {
        this.anchorPositionMs = remainingPinMs;
        this.anchorPerfNowMs = now;
        this.interpolationRate = 1;
      } else if (seekPinReleased) {
        this.anchorPositionMs = telemetry.positionMs;
        this.anchorPerfNowMs = now;
        this.interpolationRate = 1;
      } else {
        const backwardDeltaMs = prevEffectiveMs - telemetry.positionMs;
        if (backwardDeltaMs <= 0 || backwardDeltaMs > MAX_SOFT_DRIFT_MS) {
          this.anchorPositionMs = telemetry.positionMs;
          this.anchorPerfNowMs = now;
          this.interpolationRate = 1;
        } else if (backwardDeltaMs < MINOR_BACKWARD_JITTER_MS) {
          this.anchorPositionMs = prevEffectiveMs;
          this.anchorPerfNowMs = now;
          this.interpolationRate = 1;
        } else {
          this.anchorPositionMs = prevEffectiveMs;
          this.anchorPerfNowMs = now;
          this.interpolationRate = 0.5;
        }
      }
      this.syncTimeupdateLoop();
    } else if (telemetry.phase === 'paused') {
      this.virtualPaused = true;
      if (remainingPinMs === null) {
        const backwardDeltaMs = prevEffectiveMs - telemetry.positionMs;
        this.anchorPositionMs =
          seekPinReleased ||
          backwardDeltaMs <= 0 ||
          backwardDeltaMs > MINOR_BACKWARD_JITTER_MS
            ? telemetry.positionMs
            : prevEffectiveMs;
        this.anchorPerfNowMs = now;
        this.interpolationRate = 1;
      }
      this.stopTimeupdateLoop();
    }

    this.keepalive?.updatePositionState(
      this.getCurrentTimeSeconds() * 1000,
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
    this.virtualSeeking = false;
    this.virtualEnded = true;
    this.stopTimeupdateLoop();
    if (this.telemetryDurationMs > 0) {
      this.telemetryPositionMs = this.telemetryDurationMs;
      this.anchorPositionMs = this.telemetryDurationMs;
      this.anchorPerfNowMs = this.readPerfNowMs();
    }
    this.activeLocatorId = null;
    void this.keepalive?.setActive(false);
    dispatchMediaEvent(this.primaryMediaElement, 'timeupdate');
    dispatchMediaEvent(this.primaryMediaElement, 'ended');
  }

  public handleSessionClaimed(): void {
    this.virtualPaused = true;
    this.virtualSeeking = false;
    this.activeRemoteTrackId = null;
    this.activeRemoteTrackPermalink = null;
    this.activeRemoteBlobUrl = null;
    this.activeLocatorId = null;
    this.seekDebouncer.reset();
    this.clearPendingSeekEventTimer();
    this.clearPendingStreamState();
    this.stopTimeupdateLoop();
    this.keepalive?.stopAll();
    dispatchMediaEvent(this.primaryMediaElement, 'pause');
  }

  public handleRefreshLocatorRequest(requestId: string, trackId: string): void {
    const startPositionMs =
      this.activeRemoteTrackId === trackId
        ? Math.round(this.getCurrentTimeSeconds() * 1000)
        : this.telemetryPositionMs;
    const resolution = this.catalog.buildLocatorForTrack(
      trackId,
      this.sessionObserver.getSnapshot(),
      startPositionMs,
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
    this.clearPendingSeekEventTimer();
    this.clearPendingStreamState();
    this.stopTimeupdateLoop();
    this.keepalive?.dispose();
  }

  private activateResolvedRemoteTrack(
    resolution: Extract<
      ReturnType<SoundCloudTrackCatalog['buildLocatorForTrack']>,
      { readonly kind: 'playable' }
    >,
    mediaSrc?: string,
  ): void {
    this.seekDebouncer.reset();
    this.activeRemoteTrackId = resolution.track.trackId;
    this.activeRemoteTrackPermalink =
      normalizeSoundCloudPermalinkPath(resolution.track.permalinkUrl) ?? null;
    this.activeRemoteBlobUrl =
      mediaSrc !== undefined && mediaSrc.startsWith('blob:') ? mediaSrc : null;
    this.activeLocatorId = resolution.locator.locatorId;
    this.activeTrackStreamObservationSeq = this.catalog.getStreamObservationSeq();
    this.telemetryPositionMs = resolution.locator.startPositionMs;
    this.telemetryDurationMs = resolution.track.durationMs;
    this.telemetryBufferedMs = Math.max(
      resolution.track.durationMs,
      resolution.locator.startPositionMs + HEALTHY_FORWARD_BUFFER_SECONDS * 1000,
    );
    this.primePlayheadAnchor(resolution.locator.startPositionMs, 'loading', false);
    this.emitTransportCommand({
      type: 'request_load_track',
      commandSeq: this.allocateCommandSeq(),
      locator: resolution.locator,
    });
  }

  private commitPendingStreamTrack(track: CatalogTrackEntry): void {
    const startPositionMs = this.pendingSeekPositionMs ?? 0;
    this.clearPendingStreamState();

    const resolution = this.catalog.buildLocatorForTrack(
      track.trackId,
      this.sessionObserver.getSnapshot(),
      startPositionMs,
    );

    if (resolution.kind === 'drm_local_fallback') {
      this.enterDrmLocalFallback(resolution.track);
      if (this.primaryMediaElement !== null) {
        this.nativeBridge?.playElement?.(this.primaryMediaElement);
      }
      return;
    }

    if (resolution.kind === 'unplayable') {
      return;
    }

    this.mode = 'remote';
    this.virtualPaused = false;
    this.virtualEnded = false;
    this.mediaElementAwaitingFreshTrack = false;
    const effectiveSrc =
      this.latestMediaElementSrc.length > 0 ? this.latestMediaElementSrc : undefined;
    this.activateResolvedRemoteTrack(resolution, effectiveSrc);
    this.syncTimeupdateLoop();
    this.keepalive?.updateMetadata(resolution.locator.track);
    void this.keepalive?.setActive(true);
    dispatchMediaEvent(this.primaryMediaElement, 'durationchange');
    dispatchMediaEvent(this.primaryMediaElement, 'timeupdate');
    dispatchMediaEvent(this.primaryMediaElement, 'playing');
  }

  private enterDrmLocalFallback(track: CatalogTrackEntry): void {
    const hadRemoteSession = this.activeRemoteTrackId !== null;
    this.mode = 'drm_local_fallback';
    this.activeRemoteTrackId = null;
    this.activeRemoteTrackPermalink = null;
    this.activeRemoteBlobUrl = null;
    this.activeLocatorId = null;
    this.mediaElementAwaitingFreshTrack = false;
    this.virtualSeeking = false;
    this.seekDebouncer.reset();
    this.clearPendingSeekEventTimer();
    this.clearPendingStreamState();
    this.stopTimeupdateLoop();
    this.keepalive?.stopAll();

    if (hadRemoteSession) {
      this.emitTransportCommand({
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

  private resolveCandidateTrackOutcome(mediaSrc?: string): CandidateTrackOutcome {
    const isBlobSrc = typeof mediaSrc === 'string' && mediaSrc.startsWith('blob:');
    const isNewBlobUrl =
      isBlobSrc &&
      this.activeRemoteBlobUrl !== null &&
      mediaSrc !== this.activeRemoteBlobUrl;
    const isFreshElementCycle = isNewBlobUrl || this.mediaElementAwaitingFreshTrack;

    // 1. Direct non-`blob:` media/resolve URL lookup.
    if (typeof mediaSrc === 'string' && mediaSrc.length > 0 && !isBlobSrc) {
      const byMedia = this.catalog.findTrackByMediaOrResolveUrl(mediaSrc);
      if (byMedia !== undefined) {
        return { status: 'resolved', track: byMedia };
      }
    }

    const freshStreamObserved =
      this.catalog.getStreamObservationSeq() > this.activeTrackStreamObservationSeq;
    const freshPlaylistTrack =
      this.catalog.getLastFetchedPlaylistSeq() > this.activeTrackStreamObservationSeq
        ? this.catalog.getLastFetchedPlaylistTrack()
        : undefined;
    const freshResolvedTrack = freshStreamObserved
      ? (freshPlaylistTrack ?? this.catalog.getExplicitlyResolvedTrack())
      : undefined;

    // 2. Check DOM player bar hint FIRST when `mediaSrc` is `blob:` or empty!
    const hint = this.resolveDomTrackHint?.();
    if (hint?.trackId !== undefined && hint.trackId.trim().length > 0) {
      const byId = this.catalog.findTrackById(hint.trackId);
      if (byId !== undefined) {
        return { status: 'resolved', track: byId };
      }
      if (
        (this.activeRemoteTrackId !== null && hint.trackId !== this.activeRemoteTrackId) ||
        isBlobSrc ||
        isFreshElementCycle
      ) {
        return { status: 'awaiting_stream' };
      }
    }

    const hintPermalink =
      hint?.permalinkOrPath !== undefined
        ? normalizeSoundCloudPermalinkPath(hint.permalinkOrPath)
        : undefined;
    const byHint =
      (hint?.permalinkOrPath !== undefined
        ? this.catalog.findTrackByPermalink(hint.permalinkOrPath)
        : undefined) ??
      (hint?.title !== undefined ? this.catalog.findTrackByTitle(hint.title) : undefined);

    const activeTrack =
      this.activeRemoteTrackId !== null
        ? this.catalog.findTrackById(this.activeRemoteTrackId)
        : undefined;
    const domBadgeShowsDifferentTrack =
      hint?.isPlayerBadge !== false &&
      ((this.activeRemoteTrackPermalink !== null &&
        hintPermalink !== undefined &&
        hintPermalink !== this.activeRemoteTrackPermalink) ||
        (activeTrack !== undefined &&
          hint?.title !== undefined &&
          hint.title.trim().length > 0 &&
          hint.title.trim().toLowerCase() !== activeTrack.title.trim().toLowerCase()));

    if (byHint !== undefined) {
      if (byHint.trackId !== this.activeRemoteTrackId) {
        return { status: 'resolved', track: byHint };
      }
      if (!isFreshElementCycle) {
        return { status: 'resolved', track: byHint };
      }
      // Fresh `blob:` / `load()` happened while DOM badge still shows the old track:
      // prefer a newly observed stream if one already fired, otherwise wait for stream!
      if (freshResolvedTrack !== undefined) {
        return { status: 'resolved', track: freshResolvedTrack };
      }
      return { status: 'awaiting_stream' };
    }

    // 3. DOM badge explicitly displays an unindexed new track -> wait for `/stream/hls`!
    if (domBadgeShowsDifferentTrack) {
      if (
        freshResolvedTrack !== undefined &&
        freshResolvedTrack.trackId !== this.activeRemoteTrackId
      ) {
        return { status: 'resolved', track: freshResolvedTrack };
      }
      return { status: 'awaiting_stream' };
    }

    // 4. Fresh `blob:` / `load()` transition without DOM match yet.
    if (isFreshElementCycle) {
      if (freshResolvedTrack !== undefined) {
        if (
          this.activeRemoteTrackId === null ||
          freshResolvedTrack.trackId !== this.activeRemoteTrackId ||
          freshPlaylistTrack !== undefined
        ) {
          return { status: 'resolved', track: freshResolvedTrack };
        }
      }
      if (this.activeRemoteTrackId === null && this.catalog.size === 1) {
        const soleTrack = this.catalog.getMostRecentlyResolvedTrack();
        if (soleTrack !== undefined) {
          const solePermalink = normalizeSoundCloudPermalinkPath(soleTrack.permalinkUrl);
          const badgeConflictsWithSole =
            hint?.isPlayerBadge === true &&
            hintPermalink !== undefined &&
            solePermalink !== undefined &&
            hintPermalink !== solePermalink;
          if (!badgeConflictsWithSole) {
            return { status: 'resolved', track: soleTrack };
          }
        }
      }
      return { status: 'awaiting_stream' };
    }

    // 5. Initial play (`activeRemoteTrackId === null`) vs resume of currently loaded track.
    if (this.activeRemoteTrackId === null) {
      const explicitTrack =
        this.catalog.getLastFetchedPlaylistTrack() ??
        this.catalog.getExplicitlyResolvedTrack();
      if (explicitTrack !== undefined) {
        return { status: 'resolved', track: explicitTrack };
      }
      if (isBlobSrc && this.catalog.size !== 1) {
        return { status: 'awaiting_stream' };
      }
      const fallback = this.catalog.getMostRecentlyResolvedTrack();
      return fallback !== undefined
        ? { status: 'resolved', track: fallback }
        : { status: 'none' };
    }

    const currentLoaded = this.catalog.findTrackById(this.activeRemoteTrackId);
    return currentLoaded !== undefined
      ? { status: 'resolved', track: currentLoaded }
      : { status: 'none' };
  }

  private resetElementForFreshTrackTransition(): void {
    this.seekDebouncer.reset();
    this.clearPendingSeekEventTimer();
    this.clearPendingStreamState();
    this.stopTimeupdateLoop();
    this.virtualEnded = false;
    this.virtualSeeking = false;
    this.virtualPaused = true;
    this.telemetryPositionMs = 0;
    this.anchorPositionMs = 0;
    this.anchorPerfNowMs = this.readPerfNowMs();
    this.interpolationRate = 1;
    this.mediaElementAwaitingFreshTrack = true;
  }

  private primePlayheadAnchor(
    positionMs: number,
    phase: PlaybackPhase,
    hasPlayingTick: boolean,
  ): void {
    const now = this.readPerfNowMs();
    const clampedMs = Math.max(0, positionMs);
    this.anchorPositionMs = clampedMs;
    this.anchorPerfNowMs = now;
    this.interpolationRate = 1;
    this.receiverPhase = phase;
    this.hasReceivedPlayingTickForTrack = hasPlayingTick;
    this.playCreepOriginPositionMs = clampedMs;
    this.playCreepStartPerfNowMs = now;
  }

  private scheduleAsyncSeekLifecycleEvents(targetElement: EventTarget): void {
    this.clearPendingSeekEventTimer();
    this.pendingSeekEventTimerId = setTimeout(() => {
      this.pendingSeekEventTimerId = null;
      if (!this.handoffEnabled || this.mode !== 'remote') {
        this.virtualSeeking = false;
        return;
      }
      this.virtualSeeking = true;
      dispatchMediaEvent(targetElement, 'seeking');
      this.virtualSeeking = false;
      dispatchMediaEvent(targetElement, 'timeupdate');
      dispatchMediaEvent(targetElement, 'seeked');
    }, 0);
  }

  private clearPendingSeekEventTimer(): void {
    if (this.pendingSeekEventTimerId !== null) {
      clearTimeout(this.pendingSeekEventTimerId);
      this.pendingSeekEventTimerId = null;
    }
    this.virtualSeeking = false;
  }

  private schedulePendingStreamDomCheck(): void {
    if (this.pendingDomPollTimerId !== null) {
      clearTimeout(this.pendingDomPollTimerId);
    }
    this.pendingDomPollTimerId = setTimeout(() => {
      this.pendingDomPollTimerId = null;
      if (!this.pendingPlayAwaitingStream || !this.handoffEnabled) {
        return;
      }
      const hint = this.resolveDomTrackHint?.();
      const matched =
        (hint?.trackId !== undefined ? this.catalog.findTrackById(hint.trackId) : undefined) ??
        (hint?.permalinkOrPath !== undefined
          ? this.catalog.findTrackByPermalink(hint.permalinkOrPath)
          : undefined) ??
        (hint?.title !== undefined ? this.catalog.findTrackByTitle(hint.title) : undefined);
      if (matched !== undefined && matched.trackId !== this.activeRemoteTrackId) {
        this.commitPendingStreamTrack(matched);
      }
    }, PENDING_STREAM_DOM_POLL_MS);
  }

  private clearPendingStreamState(): void {
    this.pendingPlayAwaitingStream = false;
    this.pendingSeekPositionMs = null;
    if (this.pendingDomPollTimerId !== null) {
      clearTimeout(this.pendingDomPollTimerId);
      this.pendingDomPollTimerId = null;
    }
  }

  private syncTimeupdateLoop(): void {
    if (!this.handoffEnabled || this.mode !== 'remote' || this.virtualPaused || this.virtualEnded) {
      this.stopTimeupdateLoop();
      return;
    }
    if (this.timeupdateTimerId !== null) {
      return;
    }
    this.timeupdateTimerId = setInterval(() => {
      if (
        !this.handoffEnabled ||
        this.mode !== 'remote' ||
        this.virtualPaused ||
        this.virtualEnded
      ) {
        this.stopTimeupdateLoop();
        return;
      }
      dispatchMediaEvent(this.primaryMediaElement, 'timeupdate');
    }, TIMEUPDATE_INTERVAL_MS);
  }

  private stopTimeupdateLoop(): void {
    if (this.timeupdateTimerId !== null) {
      clearInterval(this.timeupdateTimerId);
      this.timeupdateTimerId = null;
    }
  }

  private emitTransportCommand(
    message: MainToIsolatedMessage & { readonly commandSeq: number },
  ): void {
    if (message.commandSeq > this.latestTransportCommandSeq) {
      this.latestTransportCommandSeq = message.commandSeq;
    }
    this.sendToIsolated(message);
  }

  private allocateCommandSeq(): number {
    this.commandSeqCounter += 1;
    return this.commandSeqCounter;
  }
}
