/**
 * Hardware media-key keepalive synthesizer & `navigator.mediaSession` bridge (`MAIN` world).
 *
 * Generates an in-memory 10-second `8,000 Hz` mono `16-bit` PCM WAV with `±1` LSB
 * amplitude (inaudible `< -100 dBFS` at `volume = 0.01`, `muted = false`) played on a
 * tagged `<audio>` element (`__soundcludKeepalive = true`) so Chromium routes MacBook
 * Play/Pause/Prev/Next media keys to `navigator.mediaSession` during remote handoff.
 */

import type { TrackMetadata } from '@soundclud/protocol';

export const KEEPALIVE_AUDIO_FLAG = '__soundcludKeepalive' as const;
export const KEEPALIVE_SAMPLE_RATE_HZ = 8000 as const;
export const KEEPALIVE_DURATION_SECONDS = 10 as const;
export const KEEPALIVE_VOLUME = 0.01 as const;

export interface MediaKeyActionHandlers {
  readonly onPlay: () => void;
  readonly onPause: () => void;
  readonly onPreviousTrack: () => void;
  readonly onNextTrack: () => void;
  readonly onSeekTo: (positionSeconds: number) => void;
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) {
    view.setUint8(offset + i, text.charCodeAt(i));
  }
}

/**
 * Generates a valid 44-byte RIFF/WAVE header + `durationSeconds * sampleRateHz`
 * 16-bit signed mono PCM frames alternating `+1` and `-1` LSB (`-90.3 dBFS` raw,
 * `-130.3 dBFS` effective at `volume = 0.01`).
 */
export function generateInaudibleKeepaliveWavBytes(
  durationSeconds: number = KEEPALIVE_DURATION_SECONDS,
  sampleRateHz: number = KEEPALIVE_SAMPLE_RATE_HZ,
): Uint8Array {
  const safeDuration = Math.max(1, Math.round(durationSeconds));
  const safeRate = Math.max(1000, Math.round(sampleRateHz));
  const numChannels = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = safeRate * blockAlign;
  const sampleFrames = safeDuration * safeRate;
  const pcmByteLength = sampleFrames * blockAlign;
  const totalByteLength = 44 + pcmByteLength;

  const buffer = new ArrayBuffer(totalByteLength);
  const view = new DataView(buffer);

  // RIFF chunk descriptor
  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, totalByteLength - 8, true);
  writeAscii(view, 8, 'WAVE');

  // fmt subchunk
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // AudioFormat = 1 (Linear PCM)
  view.setUint16(22, numChannels, true);
  view.setUint32(24, safeRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitsPerSample, true);

  // data subchunk
  writeAscii(view, 36, 'data');
  view.setUint32(40, pcmByteLength, true);

  // ±1 LSB alternating samples so Chromium's silent-stream detector sees non-zero energy
  for (let i = 0; i < sampleFrames; i += 1) {
    const sample = (i & 1) === 0 ? 1 : -1;
    view.setInt16(44 + i * 2, sample, true);
  }

  return new Uint8Array(buffer);
}

export function markAsKeepaliveAudioElement(element: HTMLAudioElement): HTMLAudioElement {
  Object.defineProperty(element, KEEPALIVE_AUDIO_FLAG, {
    value: true,
    writable: false,
    enumerable: false,
    configurable: true,
  });
  return element;
}

export function isKeepaliveAudioElement(candidate: unknown): boolean {
  if (typeof candidate !== 'object' || candidate === null) {
    return false;
  }
  return (candidate as Record<string, unknown>)[KEEPALIVE_AUDIO_FLAG] === true;
}

export class MediaKeyKeepaliveController {
  private audioEl: HTMLAudioElement | null = null;
  private blobUrl: string | null = null;
  private handlersBound = false;
  private readonly handlers: MediaKeyActionHandlers;
  private readonly createAudioElement: (() => HTMLAudioElement) | undefined;

  public constructor(
    handlers: MediaKeyActionHandlers,
    options?: {
      readonly createAudioElement?: (() => HTMLAudioElement) | undefined;
    },
  ) {
    this.handlers = handlers;
    this.createAudioElement = options?.createAudioElement;
  }

  public async setActive(playing: boolean): Promise<void> {
    if (!playing) {
      this.pauseKeepalive();
      this.setMediaSessionPlaybackState('paused');
      return;
    }

    this.bindMediaSessionHandlers();
    this.setMediaSessionPlaybackState('playing');
    const audio = this.ensureAudioElement();
    if (audio === null) {
      return;
    }
    audio.loop = true;
    audio.muted = false;
    audio.volume = KEEPALIVE_VOLUME;
    try {
      await audio.play();
    } catch {
      // Autoplay may block before first user gesture; next user click unlocks cleanly.
    }
  }

  public stopAll(): void {
    this.pauseKeepalive();
    this.setMediaSessionPlaybackState('none');
  }

  public updateMetadata(track: TrackMetadata | undefined): void {
    if (
      track === undefined ||
      typeof navigator === 'undefined' ||
      !('mediaSession' in navigator) ||
      navigator.mediaSession === null
    ) {
      return;
    }
    this.bindMediaSessionHandlers();
    if (typeof MediaMetadata !== 'undefined') {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: track.title,
          artist: track.artist,
          album: 'SoundClud • 44.1 kHz / 0 dB',
          ...(track.artworkUrl !== undefined
            ? {
                artwork: [
                  {
                    src: track.artworkUrl,
                    sizes: '500x500',
                    type: 'image/jpeg',
                  },
                ],
              }
            : {}),
        });
      } catch {
        // Ignore non-fatal MediaMetadata construction edge cases.
      }
    }
  }

  public updatePositionState(positionMs: number, durationMs: number): void {
    if (
      typeof navigator === 'undefined' ||
      !('mediaSession' in navigator) ||
      navigator.mediaSession === null ||
      typeof navigator.mediaSession.setPositionState !== 'function'
    ) {
      return;
    }
    const durationSec = durationMs / 1000;
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      return;
    }
    const positionSec = Math.min(durationSec, Math.max(0, positionMs / 1000));
    try {
      navigator.mediaSession.setPositionState({
        duration: durationSec,
        playbackRate: 1,
        position: positionSec,
      });
    } catch {
      // Ignore transient position-bounds race during track transitions.
    }
  }

  public dispose(): void {
    this.stopAll();
    if (
      this.blobUrl !== null &&
      typeof URL !== 'undefined' &&
      typeof URL.revokeObjectURL === 'function'
    ) {
      URL.revokeObjectURL(this.blobUrl);
      this.blobUrl = null;
    }
    this.audioEl = null;
  }

  private pauseKeepalive(): void {
    if (this.audioEl !== null) {
      try {
        this.audioEl.pause();
      } catch {
        // Ignore detached DOM errors.
      }
    }
  }

  private ensureAudioElement(): HTMLAudioElement | null {
    if (this.audioEl !== null) {
      return this.audioEl;
    }
    if (this.createAudioElement === undefined && typeof Audio === 'undefined') {
      return null;
    }

    const el = this.createAudioElement ? this.createAudioElement() : new Audio();
    markAsKeepaliveAudioElement(el);
    el.loop = true;
    el.muted = false;
    el.volume = KEEPALIVE_VOLUME;
    el.preload = 'auto';

    if (
      typeof Blob !== 'undefined' &&
      typeof URL !== 'undefined' &&
      typeof URL.createObjectURL === 'function'
    ) {
      const wavBytes = generateInaudibleKeepaliveWavBytes();
      const wavBuffer = new ArrayBuffer(wavBytes.byteLength);
      new Uint8Array(wavBuffer).set(wavBytes);
      const blob = new Blob([wavBuffer], { type: 'audio/wav' });
      this.blobUrl = URL.createObjectURL(blob);
      el.src = this.blobUrl;
    }

    this.audioEl = el;
    return el;
  }

  private setMediaSessionPlaybackState(
    state: 'none' | 'paused' | 'playing',
  ): void {
    if (
      typeof navigator === 'undefined' ||
      !('mediaSession' in navigator) ||
      navigator.mediaSession === null
    ) {
      return;
    }
    try {
      navigator.mediaSession.playbackState = state;
    } catch {
      // Ignore read-only environments.
    }
  }

  private bindMediaSessionHandlers(): void {
    if (
      this.handlersBound ||
      typeof navigator === 'undefined' ||
      !('mediaSession' in navigator) ||
      navigator.mediaSession === null
    ) {
      return;
    }
    this.handlersBound = true;
    const ms = navigator.mediaSession;
    const safeBind = (
      action: MediaSessionAction,
      handler: MediaSessionActionHandler,
    ): void => {
      try {
        ms.setActionHandler(action, handler);
      } catch {
        // Unsupported action in older Chromium variants.
      }
    };

    safeBind('play', () => {
      this.handlers.onPlay();
    });
    safeBind('pause', () => {
      this.handlers.onPause();
    });
    safeBind('previoustrack', () => {
      this.handlers.onPreviousTrack();
    });
    safeBind('nexttrack', () => {
      this.handlers.onNextTrack();
    });
    safeBind('seekto', (details) => {
      if (typeof details.seekTime === 'number' && Number.isFinite(details.seekTime)) {
        this.handlers.onSeekTo(details.seekTime);
      }
    });
  }
}
