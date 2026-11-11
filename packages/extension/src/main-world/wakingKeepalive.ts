/**
 * Waking device playhead keepalive state machine (`MAIN` world).
 *
 * Formal state machine managing synthetic micro-advancement of the virtual playhead
 * during receiver connection and physical hardware DAC/amplifier wake-up.
 *
 * Invariant Rationale:
 * SoundCloud's web audio runtime implements a 2.0-second watchdog timer (`_determineIfPlaying()`).
 * If `HTMLAudioElement.currentTime` does not monotonically advance within this window,
 * SoundCloud assumes audio decoding or hardware output has failed and abruptly resets the player.
 * Physical network amplifiers (e.g. Marantz PM7000N via HEOS AIOS / UPnP AVTransport) require
 * 1.5s–3.5s to establish network audio buffers, negotiate DAC sample clocks, and un-mute analog stages.
 *
 * By advancing the playhead at a fractional rate (12% speed up to a maximum cap of 250ms),
 * the virtualizer satisfies the watchdog without producing perceptible audio-visual time jumps
 * once real receiver telemetry ticks arrive.
 */

export interface WakingKeepaliveConfig {
  readonly creepRate: number;
  readonly maxAdvanceMs: number;
  readonly watchdogBudgetMs: number;
}

export const DEFAULT_WAKING_KEEPALIVE_CONFIG: WakingKeepaliveConfig = {
  creepRate: 0.12,
  maxAdvanceMs: 250,
  watchdogBudgetMs: 2000,
} as const;

export type WakingKeepaliveState = 'idle' | 'waking' | 'settled';

export class WakingDevicePlayheadKeepalive {
  private state: WakingKeepaliveState = 'idle';
  private originPositionMs = 0;
  private startPerfMs = 0;
  private readonly config: WakingKeepaliveConfig;

  public constructor(config: WakingKeepaliveConfig = DEFAULT_WAKING_KEEPALIVE_CONFIG) {
    this.config = config;
  }

  public start(originPositionMs: number, nowPerfMs: number): void {
    this.state = 'waking';
    this.originPositionMs = Math.max(0, originPositionMs);
    this.startPerfMs = nowPerfMs;
  }

  public resetOrigin(originPositionMs: number, nowPerfMs: number): void {
    this.originPositionMs = Math.max(0, originPositionMs);
    this.startPerfMs = nowPerfMs;
  }

  public settle(): void {
    this.state = 'settled';
  }

  public reset(): void {
    this.state = 'idle';
    this.originPositionMs = 0;
    this.startPerfMs = 0;
  }

  public isWaking(): boolean {
    return this.state === 'waking';
  }

  public getState(): WakingKeepaliveState {
    return this.state;
  }

  public computeCurrentPositionMs(anchorPositionMs: number, nowPerfMs: number): number {
    if (this.state !== 'waking') {
      return anchorPositionMs;
    }
    const elapsedPerfMs = Math.max(0, nowPerfMs - this.startPerfMs);
    const advanceMs = Math.min(
      this.config.maxAdvanceMs,
      elapsedPerfMs * this.config.creepRate,
    );
    return Math.max(anchorPositionMs, this.originPositionMs + advanceMs);
  }
}
