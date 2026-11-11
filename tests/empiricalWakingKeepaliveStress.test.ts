import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HEOS_SEEK_DEBOUNCE_MS,
  PROTOCOL_VERSION,
  type PlaybackTelemetry,
} from '@soundclud/protocol';
import {
  installMediaPrototypeHooks,
  MaestroVirtualizerController,
  SoundCloudSessionObserver,
  SoundCloudTrackCatalog,
  type MainToIsolatedMessage,
  type NativeMediaBridge,
} from '@soundclud/extension';
import {
  DEFAULT_WAKING_KEEPALIVE_CONFIG,
  WakingDevicePlayheadKeepalive,
} from '../packages/extension/src/main-world/wakingKeepalive.js';

let activeMediaGlobalsTeardown: (() => void) | null = null;

interface SyntheticBrowserMediaHarness {
  createAudioElement(): HTMLMediaElement;
  teardown(): void;
}

function installSyntheticBrowserMediaGlobals(): SyntheticBrowserMediaHarness {
  activeMediaGlobalsTeardown?.();

  const globalRecord = globalThis as unknown as Record<string, unknown>;
  const prevHTMLMediaElement = globalRecord['HTMLMediaElement'];

  class SyntheticDomMediaElement extends EventTarget {
    public nativePlayCalls = 0;
    public nativePauseCalls = 0;
    public nativeLoadCalls = 0;

    private nativeSrc = '';
    private nativeCurrentTime = 0;
    private nativeDuration = Number.NaN;
    private nativePaused = true;
    private nativeSeeking = false;
    private nativeEnded = false;
    private nativeVolume = 1;
    private nativeMuted = false;

    public play(): Promise<void> {
      this.nativePlayCalls += 1;
      this.nativePaused = false;
      return Promise.resolve();
    }

    public pause(): void {
      this.nativePauseCalls += 1;
      this.nativePaused = true;
    }

    public load(): void {
      this.nativeLoadCalls += 1;
      this.nativeCurrentTime = 0;
    }

    public removeAttribute(qualifiedName: string): void {
      if (qualifiedName.toLowerCase() === 'src') {
        this.nativeSrc = '';
      }
    }

    public setAttribute(qualifiedName: string, value: string): void {
      if (qualifiedName.toLowerCase() === 'src') {
        this.nativeSrc = value;
      }
    }

    public get currentSrc(): string {
      return this.nativeSrc;
    }

    public get src(): string {
      return this.nativeSrc;
    }

    public set src(value: string) {
      this.nativeSrc = value;
    }

    public get currentTime(): number {
      return this.nativeCurrentTime;
    }

    public set currentTime(val: number) {
      this.nativeCurrentTime = val;
    }

    public get duration(): number {
      return this.nativeDuration;
    }

    public set duration(val: number) {
      this.nativeDuration = val;
    }

    public get paused(): boolean {
      return this.nativePaused;
    }

    public set paused(val: boolean) {
      this.nativePaused = val;
    }

    public get seeking(): boolean {
      return this.nativeSeeking;
    }

    public set seeking(val: boolean) {
      this.nativeSeeking = val;
    }

    public get ended(): boolean {
      return this.nativeEnded;
    }

    public set ended(val: boolean) {
      this.nativeEnded = val;
    }

    public get volume(): number {
      return this.nativeVolume;
    }

    public set volume(val: number) {
      this.nativeVolume = val;
    }

    public get muted(): boolean {
      return this.nativeMuted;
    }

    public set muted(val: boolean) {
      this.nativeMuted = val;
    }
  }

  globalRecord['HTMLMediaElement'] = SyntheticDomMediaElement;
  globalRecord['HTMLAudioElement'] = SyntheticDomMediaElement;

  const teardown = (): void => {
    globalRecord['HTMLMediaElement'] = prevHTMLMediaElement;
  };
  activeMediaGlobalsTeardown = teardown;

  return {
    createAudioElement: () =>
      new SyntheticDomMediaElement() as unknown as HTMLMediaElement,
    teardown,
  };
}

function makePlayableTrackPayload(
  trackId: string,
  title: string,
  durationMs = 210_000,
): Record<string, unknown> {
  return {
    id: Number(trackId),
    title,
    permalink_url: `https://soundcloud.com/synthetic-artist/track-${trackId}`,
    full_duration: durationMs,
    duration: durationMs,
    artwork_url: `https://i1.sndcdn.com/artworks-synthetic-${trackId}-large.jpg`,
    waveform_url: `https://wis.sndcdn.com/synthetic-${trackId}_m.json`,
    track_authorization: `synthetic_test_track_auth_${trackId}`,
    user: { username: 'Synthetic Artist' },
    media: {
      transcodings: [
        {
          url: `https://api-v2.soundcloud.com/media/soundcloud:tracks:${trackId}/hq-aac/stream/encrypted-hls`,
          preset: 'aac_256k',
          duration: durationMs,
          quality: 'hq',
          format: { protocol: 'encrypted-hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' },
        },
      ],
    },
  };
}

function makeTelemetry(
  overrides?: Partial<PlaybackTelemetry>,
): PlaybackTelemetry {
  return {
    protocolVersion: PROTOCOL_VERSION,
    serverSeq: 1,
    phase: 'playing',
    activeOutputId: 'heos/marantz',
    activeBackend: 'heos_upnp',
    volumeMode: 'bit_perfect',
    fixedGainDb: 0,
    sampleRateHz: 44100,
    bitDepth: 24,
    positionMs: 10_000,
    durationMs: 200_000,
    bufferedMs: 30_000,
    timestampMs: 1_700_000_000_000,
    ...overrides,
  };
}

describe('Empirical Challenger — WakingDevicePlayheadKeepalive & Player Virtualizer Stress Harness', () => {
  afterEach(() => {
    activeMediaGlobalsTeardown?.();
    activeMediaGlobalsTeardown = null;
    vi.useRealTimers();
  });

  describe('1. WakingDevicePlayheadKeepalive State Machine & Mathematical Invariants', () => {
    it('initializes in idle state and returns anchor unchanged', () => {
      const keepalive = new WakingDevicePlayheadKeepalive();
      expect(keepalive.getState()).toBe('idle');
      expect(keepalive.isWaking()).toBe(false);

      expect(keepalive.computeCurrentPositionMs(5_000, 10_000)).toBe(5_000);
      expect(keepalive.computeCurrentPositionMs(0, 50_000)).toBe(0);
    });

    it('advances monotonically during device wake at exact 12% creep rate', () => {
      const keepalive = new WakingDevicePlayheadKeepalive();
      const originMs = 10_000;
      const startPerf = 1_000;

      keepalive.start(originMs, startPerf);
      expect(keepalive.getState()).toBe('waking');
      expect(keepalive.isWaking()).toBe(true);

      // t = 0ms elapsed -> 0ms advance
      expect(keepalive.computeCurrentPositionMs(originMs, startPerf)).toBe(originMs);

      // t = 100ms elapsed -> 100 * 0.12 = 12ms advance
      expect(keepalive.computeCurrentPositionMs(originMs, startPerf + 100)).toBe(originMs + 12);

      // t = 500ms elapsed -> 500 * 0.12 = 60ms advance
      const pos500 = keepalive.computeCurrentPositionMs(originMs, startPerf + 500);
      expect(pos500).toBe(originMs + 60);
      expect(pos500).toBeGreaterThan(originMs);

      // t = 1000ms elapsed -> 1000 * 0.12 = 120ms advance
      const pos1000 = keepalive.computeCurrentPositionMs(originMs, startPerf + 1_000);
      expect(pos1000).toBe(originMs + 120);
      expect(pos1000).toBeGreaterThan(pos500);

      // Stress test: dense monotonic stepping across 100 samples
      let prev = originMs;
      for (let dt = 10; dt <= 1_000; dt += 10) {
        const curr = keepalive.computeCurrentPositionMs(originMs, startPerf + dt);
        expect(curr).toBeGreaterThanOrEqual(prev);
        prev = curr;
      }
    });

    it('enforces watchdog budget capping at exactly 250ms max advance even under extreme delay', () => {
      const keepalive = new WakingDevicePlayheadKeepalive();
      const originMs = 5_000;
      const startPerf = 2_000;

      keepalive.start(originMs, startPerf);

      // 250ms / 0.12 = 2083.33ms to reach budget cap
      const capArrivalPerf = startPerf + Math.ceil(250 / 0.12); // ~4084ms

      const atCap = keepalive.computeCurrentPositionMs(originMs, capArrivalPerf);
      expect(atCap).toBe(originMs + 250);

      // 3 seconds elapsed: strictly capped at 250ms
      expect(keepalive.computeCurrentPositionMs(originMs, startPerf + 3_000)).toBe(originMs + 250);

      // 10 seconds elapsed: strictly capped at 250ms
      expect(keepalive.computeCurrentPositionMs(originMs, startPerf + 10_000)).toBe(originMs + 250);

      // 1 hour (3,600,000ms) elapsed: strictly capped at 250ms
      expect(keepalive.computeCurrentPositionMs(originMs, startPerf + 3_600_000)).toBe(originMs + 250);
    });

    it('seeking backward during wake resets origin and prevents forward time jumps', () => {
      const keepalive = new WakingDevicePlayheadKeepalive();
      const initialOriginMs = 20_000; // 20.0s
      let now = 10_000;

      keepalive.start(initialOriginMs, now);

      // Advance 500ms -> creep to 20,060ms
      now += 500;
      expect(keepalive.computeCurrentPositionMs(initialOriginMs, now)).toBe(20_060);

      // User seeks backward to 4,000ms (4.0s) while device is still waking!
      const backwardSeekTargetMs = 4_000;
      keepalive.resetOrigin(backwardSeekTargetMs, now);

      // Immediate check at seek instant: MUST be 4,000ms (NOT 20,060ms!)
      expect(keepalive.computeCurrentPositionMs(backwardSeekTargetMs, now)).toBe(backwardSeekTargetMs);

      // Advance 100ms -> creeps to 4,012ms (strictly starting from 4,000ms)
      now += 100;
      expect(keepalive.computeCurrentPositionMs(backwardSeekTargetMs, now)).toBe(4_012);

      // Advance another 400ms -> creeps to 4,060ms
      now += 400;
      expect(keepalive.computeCurrentPositionMs(backwardSeekTargetMs, now)).toBe(4_060);

      // Capped at 4,250ms (never jumping to 20s+)
      now += 5_000;
      expect(keepalive.computeCurrentPositionMs(backwardSeekTargetMs, now)).toBe(4_250);
    });

    it('handles backward clock anomalies and negative deltaPerf without jumping or NaN', () => {
      const keepalive = new WakingDevicePlayheadKeepalive();
      keepalive.start(10_000, 5_000);

      // System clock stepped backward by 500ms (now = 4500 < start = 5000)
      const backwardClockPos = keepalive.computeCurrentPositionMs(10_000, 4_500);
      expect(backwardClockPos).toBe(10_000);
      expect(Number.isFinite(backwardClockPos)).toBe(true);

      // System clock micro-jitter (-1ms)
      const microJitterPos = keepalive.computeCurrentPositionMs(10_000, 4_999);
      expect(microJitterPos).toBe(10_000);
    });

    it('clamps negative origin positions safely to 0', () => {
      const keepalive = new WakingDevicePlayheadKeepalive();
      keepalive.start(-1_000, 1_000);
      expect(keepalive.computeCurrentPositionMs(0, 1_000)).toBe(0);

      keepalive.resetOrigin(-500, 1_500);
      expect(keepalive.computeCurrentPositionMs(0, 1_500)).toBe(0);
    });

    it('handles rapid consecutive backward scrubs during wake without state leakage', () => {
      const keepalive = new WakingDevicePlayheadKeepalive();
      let now = 10_000;
      keepalive.start(60_000, now);

      // User scrubs 60s -> 45s -> 30s -> 15s -> 0s rapidly during wake
      const seekTargets = [45_000, 30_000, 15_000, 0];
      for (const target of seekTargets) {
        now += 50;
        keepalive.resetOrigin(target, now);
        // Immediate position must be target
        expect(keepalive.computeCurrentPositionMs(target, now)).toBe(target);
        // Step forward 100ms: creep must be target + 12ms
        expect(keepalive.computeCurrentPositionMs(target, now + 100)).toBe(target + 12);
      }
    });

    it('settling freezes keepalive and subsequent calls return anchor directly', () => {
      const keepalive = new WakingDevicePlayheadKeepalive();
      keepalive.start(10_000, 1_000);
      expect(keepalive.isWaking()).toBe(true);

      // Settle arrives
      keepalive.settle();
      expect(keepalive.getState()).toBe('settled');
      expect(keepalive.isWaking()).toBe(false);

      // computeCurrentPositionMs returns anchor directly without creep
      expect(keepalive.computeCurrentPositionMs(12_000, 50_000)).toBe(12_000);
      expect(keepalive.computeCurrentPositionMs(35_000, 100_000)).toBe(35_000);
    });

    it('resetting restores idle state', () => {
      const keepalive = new WakingDevicePlayheadKeepalive();
      keepalive.start(10_000, 1_000);
      keepalive.reset();
      expect(keepalive.getState()).toBe('idle');
      expect(keepalive.isWaking()).toBe(false);
      expect(keepalive.computeCurrentPositionMs(7_000, 2_000)).toBe(7_000);
    });
  });

  describe('2. MaestroVirtualizerController End-to-End Waking Playhead & Scrub Stress', () => {
    it('empirically verifies monotonic advance during wake, watchdog capping, and clean settling on playing telemetry', async () => {
      vi.useFakeTimers();
      const dom = installSyntheticBrowserMediaGlobals();

      let perfNowMs = 10_000;
      const advanceClockMs = (deltaMs: number): void => {
        perfNowMs += deltaMs;
        vi.advanceTimersByTime(deltaMs);
      };

      const catalog = new SoundCloudTrackCatalog();
      catalog.ingestPayload(makePlayableTrackPayload('1001', 'Adversarial Test Track 1', 300_000));

      const observer = new SoundCloudSessionObserver();
      observer.ingestHydration([{ hydratable: 'apiClient', data: { id: 'cid_test_stress' } }]);

      const outboundMessages: MainToIsolatedMessage[] = [];
      let nativeBridgeRef: NativeMediaBridge | null = null;
      const controller = new MaestroVirtualizerController({
        catalog,
        sessionObserver: observer,
        sendToIsolated: (msg) => outboundMessages.push(msg),
        nowPerfMs: () => perfNowMs,
        nativeBridge: {
          pauseElement: (el) => nativeBridgeRef?.pauseElement(el),
          getNativeCurrentTimeSeconds: (el) =>
            nativeBridgeRef?.getNativeCurrentTimeSeconds(el) ?? 0,
          getNativePaused: (el) => nativeBridgeRef?.getNativePaused(el) ?? true,
        },
      });
      nativeBridgeRef = installMediaPrototypeHooks(controller);

      controller.handleIsolatedMessage({
        type: 'sync_runtime_state',
        handoffEnabled: true,
        seekDebounceMs: HEOS_SEEK_DEBOUNCE_MS,
        connectionState: 'connected',
        lastAckedCommandSeq: 0,
      });

      const el = dom.createAudioElement();
      await el.play();

      expect(outboundMessages[0]?.type).toBe('request_load_track');

      // Check 1: Monotonic advance during wake (t500 > t0)
      const t0 = el.currentTime;
      expect(t0).toBe(0);

      advanceClockMs(500);
      const t500 = el.currentTime;
      expect(t500).toBeGreaterThan(t0);
      expect(t500).toBeCloseTo(0.06, 2); // 500ms * 0.12 = 60ms = 0.06s

      advanceClockMs(500);
      const t1000 = el.currentTime;
      expect(t1000).toBeGreaterThan(t500);
      expect(t1000).toBeCloseTo(0.12, 2); // 1000ms * 0.12 = 120ms = 0.12s

      // Check 2: Watchdog budget capping (max 250ms advance)
      advanceClockMs(2_500); // Total 3,500ms elapsed
      const t3500 = el.currentTime;
      expect(t3500).toBeCloseTo(0.25, 2); // Capped at exactly 250ms = 0.25s

      advanceClockMs(10_000); // Total 13,500ms elapsed
      const t13500 = el.currentTime;
      expect(t13500).toBe(t3500); // Remains strictly capped at 0.25s!

      // Check 3: Settling when playing telemetry arrives
      controller.handleIsolatedMessage({
        type: 'telemetry_tick',
        lastAckedCommandSeq: 1,
        telemetry: makeTelemetry({
          activeBackend: 'heos_upnp',
          positionMs: 1_000, // Real 1.0s position from receiver
          durationMs: 300_000,
          bufferedMs: 10_000,
          phase: 'playing',
        }),
      });

      // Now settled: real audio playback takes over at 1:1 rate
      expect(el.currentTime).toBe(1.0);

      advanceClockMs(1_000); // Advance 1 second of wall clock
      expect(el.currentTime).toBeCloseTo(2.0, 2); // Advances by full 1.0s, not 12% creep!

      controller.dispose();
    });

    it('empirically verifies seeking backward during device wake resets origin with zero forward time jumps', async () => {
      vi.useFakeTimers();
      const dom = installSyntheticBrowserMediaGlobals();

      let perfNowMs = 20_000;
      const advanceClockMs = (deltaMs: number): void => {
        perfNowMs += deltaMs;
        vi.advanceTimersByTime(deltaMs);
      };

      const catalog = new SoundCloudTrackCatalog();
      catalog.ingestPayload(makePlayableTrackPayload('1002', 'Adversarial Seek Track', 300_000));

      const observer = new SoundCloudSessionObserver();
      observer.ingestHydration([{ hydratable: 'apiClient', data: { id: 'cid_seek_wake' } }]);

      const outboundMessages: MainToIsolatedMessage[] = [];
      let nativeBridgeRef: NativeMediaBridge | null = null;
      const controller = new MaestroVirtualizerController({
        catalog,
        sessionObserver: observer,
        sendToIsolated: (msg) => outboundMessages.push(msg),
        nowPerfMs: () => perfNowMs,
        nativeBridge: {
          pauseElement: (el) => nativeBridgeRef?.pauseElement(el),
          getNativeCurrentTimeSeconds: (el) =>
            nativeBridgeRef?.getNativeCurrentTimeSeconds(el) ?? 0,
          getNativePaused: (el) => nativeBridgeRef?.getNativePaused(el) ?? true,
        },
      });
      nativeBridgeRef = installMediaPrototypeHooks(controller);

      controller.handleIsolatedMessage({
        type: 'sync_runtime_state',
        handoffEnabled: true,
        seekDebounceMs: HEOS_SEEK_DEBOUNCE_MS,
        connectionState: 'connected',
        lastAckedCommandSeq: 0,
      });

      const el = dom.createAudioElement();
      await el.play();

      // Start at 30.0s (e.g. user resumed or clicked mid-track)
      controller.recordUserInteraction();
      el.currentTime = 30.0;
      advanceClockMs(HEOS_SEEK_DEBOUNCE_MS + 50); // Debounce commit

      // Acknowledge seek 2 while amplifier is still waking
      controller.handleIsolatedMessage({
        type: 'telemetry_tick',
        lastAckedCommandSeq: 2,
        telemetry: makeTelemetry({
          activeBackend: 'heos_upnp',
          positionMs: 30_000,
          durationMs: 300_000,
          phase: 'waking_device',
        }),
      });

      // Now device is waking at origin ~30.0s
      advanceClockMs(500); // 500ms elapsed -> currentTime ~30.06s
      expect(el.currentTime).toBeGreaterThan(30.0);
      expect(el.currentTime).toBeLessThan(30.1);

      // USER SEEKS BACKWARD to 5.0s during wake!
      controller.recordUserInteraction();
      el.currentTime = 5.0;

      // Time MUST immediately reflect the seek position, NOT 30s!
      expect(el.currentTime).toBe(5.0);

      // Advance debounce commit
      advanceClockMs(HEOS_SEEK_DEBOUNCE_MS + 50);

      // Acknowledge backward seek 3 while amplifier is still waking
      controller.handleIsolatedMessage({
        type: 'telemetry_tick',
        lastAckedCommandSeq: 3,
        telemetry: makeTelemetry({
          activeBackend: 'heos_upnp',
          positionMs: 5_000,
          durationMs: 300_000,
          phase: 'waking_device',
        }),
      });

      // Advance 500ms during wake
      advanceClockMs(500);
      // Position MUST be creeping up from 5.0s (e.g. ~5.06s), NEVER jumping forward to 30s!
      expect(el.currentTime).toBeGreaterThan(5.0);
      expect(el.currentTime).toBeLessThan(5.15);
      expect(el.currentTime).toBeLessThan(10.0);

      controller.dispose();
    });

    it('empirically verifies rejection of synthetic hls.js +0.1s gap-controller stall nudges without user interaction', async () => {
      vi.useFakeTimers();
      const dom = installSyntheticBrowserMediaGlobals();

      let perfNowMs = 30_000;
      const advanceClockMs = (deltaMs: number): void => {
        perfNowMs += deltaMs;
        vi.advanceTimersByTime(deltaMs);
      };

      const catalog = new SoundCloudTrackCatalog();
      catalog.ingestPayload(makePlayableTrackPayload('1003', 'Adversarial GapController Track', 300_000));

      const observer = new SoundCloudSessionObserver();
      observer.ingestHydration([{ hydratable: 'apiClient', data: { id: 'cid_gap_controller' } }]);

      const outboundMessages: MainToIsolatedMessage[] = [];
      let nativeBridgeRef: NativeMediaBridge | null = null;
      const controller = new MaestroVirtualizerController({
        catalog,
        sessionObserver: observer,
        sendToIsolated: (msg) => outboundMessages.push(msg),
        nowPerfMs: () => perfNowMs,
        nativeBridge: {
          pauseElement: (el) => nativeBridgeRef?.pauseElement(el),
          getNativeCurrentTimeSeconds: (el) =>
            nativeBridgeRef?.getNativeCurrentTimeSeconds(el) ?? 0,
          getNativePaused: (el) => nativeBridgeRef?.getNativePaused(el) ?? true,
        },
      });
      nativeBridgeRef = installMediaPrototypeHooks(controller);

      controller.handleIsolatedMessage({
        type: 'sync_runtime_state',
        handoffEnabled: true,
        seekDebounceMs: HEOS_SEEK_DEBOUNCE_MS,
        connectionState: 'connected',
        lastAckedCommandSeq: 0,
      });

      const el = dom.createAudioElement();
      await el.play();

      // Put into steady playing state
      controller.handleIsolatedMessage({
        type: 'telemetry_tick',
        lastAckedCommandSeq: 1,
        telemetry: makeTelemetry({
          activeBackend: 'heos_upnp',
          positionMs: 40_000,
          durationMs: 300_000,
          phase: 'playing',
        }),
      });

      advanceClockMs(2_000); // 2s elapsed, playhead is at ~42.0s
      outboundMessages.length = 0;

      // Case A: hls.js synthetic stall nudge (+0.10s) with ZERO user gesture
      const preNudgeSec = el.currentTime;
      el.currentTime = preNudgeSec + 0.10; // Synthetic nudge
      advanceClockMs(500);

      // MUST NOT emit request_seek!
      const seekRequestsA = outboundMessages.filter((m) => m.type === 'request_seek');
      expect(seekRequestsA).toHaveLength(0);
      expect(controller.isSeekPendingAck()).toBe(false);

      // Case B: hls.js synthetic stall nudge (+0.05s) with ZERO user gesture
      outboundMessages.length = 0;
      const preNudgeB = el.currentTime;
      el.currentTime = preNudgeB + 0.05;
      advanceClockMs(500);

      const seekRequestsB = outboundMessages.filter((m) => m.type === 'request_seek');
      expect(seekRequestsB).toHaveLength(0);
      expect(controller.isSeekPendingAck()).toBe(false);

      // Case C: Legit user scrub (+0.10s) WITH recent recordUserInteraction()
      outboundMessages.length = 0;
      controller.recordUserInteraction();
      const preUserScrub = el.currentTime;
      el.currentTime = preUserScrub + 0.10;
      advanceClockMs(HEOS_SEEK_DEBOUNCE_MS + 50); // Allow debounce to fire

      const seekRequestsC = outboundMessages.filter((m) => m.type === 'request_seek');
      expect(seekRequestsC.length).toBeGreaterThan(0);

      // Case D: Major scrub (+5.0s) WITHOUT user gesture (should NOT be suppressed as it exceeds 0.22s)
      outboundMessages.length = 0;
      advanceClockMs(2_000); // Expire any user gesture window
      const preMajorScrub = el.currentTime;
      el.currentTime = preMajorScrub + 5.0;
      advanceClockMs(HEOS_SEEK_DEBOUNCE_MS + 50);

      const seekRequestsD = outboundMessages.filter((m) => m.type === 'request_seek');
      expect(seekRequestsD.length).toBeGreaterThan(0);

      // Case E: Range & user gesture boundary checks for HLS_GAP_NUDGE_SUPPRESSION
      // 1. Inside window: delta = 0.05s -> MUST BE SUPPRESSED
      outboundMessages.length = 0;
      advanceClockMs(2_000);
      const preBound1 = el.currentTime;
      el.currentTime = preBound1 + 0.05;
      advanceClockMs(500);
      expect(outboundMessages.filter((m) => m.type === 'request_seek')).toHaveLength(0);

      // 2. Inside window: delta = 0.20s -> MUST BE SUPPRESSED
      outboundMessages.length = 0;
      advanceClockMs(2_000);
      const preBound2 = el.currentTime;
      el.currentTime = preBound2 + 0.20;
      advanceClockMs(500);
      expect(outboundMessages.filter((m) => m.type === 'request_seek')).toHaveLength(0);

      // 3. Above window: delta = 0.30s (> 0.22s) -> MUST NOT BE SUPPRESSED
      outboundMessages.length = 0;
      advanceClockMs(2_000);
      const preBound3 = el.currentTime;
      el.currentTime = preBound3 + 0.30;
      advanceClockMs(HEOS_SEEK_DEBOUNCE_MS + 50);
      expect(outboundMessages.filter((m) => m.type === 'request_seek').length).toBeGreaterThan(0);

      // 4. Below window: delta = 0.02s (< 0.04s) -> MUST NOT BE SUPPRESSED
      outboundMessages.length = 0;
      advanceClockMs(2_000);
      const preBound4 = el.currentTime;
      el.currentTime = preBound4 + 0.02;
      advanceClockMs(HEOS_SEEK_DEBOUNCE_MS + 50);
      expect(outboundMessages.filter((m) => m.type === 'request_seek').length).toBeGreaterThan(0);

      // 5. User gesture at 740ms (<= 750ms grace) -> MUST NOT BE SUPPRESSED (legit scrub)
      outboundMessages.length = 0;
      advanceClockMs(2_000);
      controller.recordUserInteraction();
      advanceClockMs(740); // 740ms elapsed since gesture
      const preBound5 = el.currentTime;
      el.currentTime = preBound5 + 0.10;
      advanceClockMs(HEOS_SEEK_DEBOUNCE_MS + 50);
      expect(outboundMessages.filter((m) => m.type === 'request_seek').length).toBeGreaterThan(0);

      // 6. User gesture at 760ms (> 750ms grace expired) -> MUST BE SUPPRESSED (synthetic nudge)
      outboundMessages.length = 0;
      advanceClockMs(2_000);
      controller.recordUserInteraction();
      advanceClockMs(760); // 760ms elapsed -> gesture window expired
      const preBound6 = el.currentTime;
      el.currentTime = preBound6 + 0.10;
      advanceClockMs(500);
      expect(outboundMessages.filter((m) => m.type === 'request_seek')).toHaveLength(0);

      controller.dispose();
    });
  });
});
