/**
 * Dynamic waveform scrub debouncer & optimistic `currentTime` pin (`MAIN` world).
 *
 * Adapts debounce window to the active receiver output's `capabilities.seekDebounceMs`
 * (`60 ms` for local `mpv` CoreAudio/TOSLINK; `180 ms` for HEOS UPnP network targets)
 * and pins optimistic `currentTime` until `state_tick.lastAckedCommandSeq >= commandSeq`.
 */

import { TOSLINK_SEEK_DEBOUNCE_MS } from '@soundclud/protocol';

export interface SeekDebouncerOptions {
  readonly initialDebounceMs?: number | undefined;
  readonly ackPinTimeoutMs?: number | undefined;
  readonly allocateCommandSeq: () => number;
  readonly onCommitSeek: (positionMs: number, commandSeq: number) => void;
  readonly onSeekSettled?: (() => void) | undefined;
  readonly now?: (() => number) | undefined;
}

const DEFAULT_ACK_PIN_TIMEOUT_MS = 3000;
const MIN_DEBOUNCE_MS = 15;
const MAX_DEBOUNCE_MS = 1000;

export class SeekDebouncer {
  private debounceMs: number;
  private readonly ackPinTimeoutMs: number;
  private readonly allocateCommandSeq: () => number;
  private readonly onCommitSeek: (positionMs: number, commandSeq: number) => void;
  private readonly onSeekSettled: (() => void) | undefined;
  private readonly now: () => number;

  private debounceTimerId: ReturnType<typeof setTimeout> | null = null;
  private optimisticPositionMs: number | null = null;
  private awaitingAckCommandSeq: number | null = null;
  private awaitingAckDeadlineMs = 0;

  public constructor(options: SeekDebouncerOptions) {
    this.debounceMs = this.clampDebounce(
      options.initialDebounceMs ?? TOSLINK_SEEK_DEBOUNCE_MS,
    );
    this.ackPinTimeoutMs = options.ackPinTimeoutMs ?? DEFAULT_ACK_PIN_TIMEOUT_MS;
    this.allocateCommandSeq = options.allocateCommandSeq;
    this.onCommitSeek = options.onCommitSeek;
    this.onSeekSettled = options.onSeekSettled;
    this.now = options.now ?? (() => Date.now());
  }

  public getDebounceMs(): number {
    return this.debounceMs;
  }

  public setDebounceMs(nextDebounceMs: number): void {
    this.debounceMs = this.clampDebounce(nextDebounceMs);
  }

  public get isSeeking(): boolean {
    if (this.debounceTimerId !== null) {
      return true;
    }
    if (this.awaitingAckCommandSeq !== null) {
      if (this.now() <= this.awaitingAckDeadlineMs) {
        return true;
      }
      this.clearAckPin();
    }
    return false;
  }

  public get pendingCommandSeq(): number | null {
    return this.awaitingAckCommandSeq;
  }

  public requestSeekSeconds(seconds: number): void {
    if (!Number.isFinite(seconds)) {
      return;
    }
    this.requestSeekMs(Math.max(0, Math.round(seconds * 1000)));
  }

  public requestSeekMs(positionMs: number): void {
    const clampedMs = Math.max(0, Math.round(positionMs));
    this.optimisticPositionMs = clampedMs;

    if (this.debounceTimerId !== null) {
      clearTimeout(this.debounceTimerId);
    }

    this.debounceTimerId = setTimeout(() => {
      this.debounceTimerId = null;
      const targetMs = this.optimisticPositionMs ?? clampedMs;
      const seq = this.allocateCommandSeq();
      this.awaitingAckCommandSeq = seq;
      this.awaitingAckDeadlineMs = this.now() + this.ackPinTimeoutMs;
      this.onCommitSeek(targetMs, seq);
    }, this.debounceMs);
  }

  public acknowledgeCommandSeq(lastAckedCommandSeq: number): boolean {
    if (
      this.awaitingAckCommandSeq !== null &&
      lastAckedCommandSeq >= this.awaitingAckCommandSeq
    ) {
      this.awaitingAckCommandSeq = null;
      this.awaitingAckDeadlineMs = 0;
      if (this.debounceTimerId === null) {
        this.optimisticPositionMs = null;
        this.onSeekSettled?.();
      }
      return true;
    }
    return false;
  }

  public getEffectivePositionMs(telemetryPositionMs: number): number {
    if (this.debounceTimerId !== null && this.optimisticPositionMs !== null) {
      return this.optimisticPositionMs;
    }
    if (this.awaitingAckCommandSeq !== null && this.optimisticPositionMs !== null) {
      if (this.now() <= this.awaitingAckDeadlineMs) {
        return this.optimisticPositionMs;
      }
      this.clearAckPin();
    }
    return Math.max(0, Math.round(telemetryPositionMs));
  }

  public reset(): void {
    if (this.debounceTimerId !== null) {
      clearTimeout(this.debounceTimerId);
      this.debounceTimerId = null;
    }
    this.clearAckPin();
  }

  private clearAckPin(): void {
    this.awaitingAckCommandSeq = null;
    this.awaitingAckDeadlineMs = 0;
    this.optimisticPositionMs = null;
  }

  private clampDebounce(ms: number): number {
    if (!Number.isFinite(ms)) {
      return TOSLINK_SEEK_DEBOUNCE_MS;
    }
    return Math.min(MAX_DEBOUNCE_MS, Math.max(MIN_DEBOUNCE_MS, Math.round(ms)));
  }
}
