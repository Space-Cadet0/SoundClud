/**
 * Adversarial Challenger 2 Test Suite — Milestone 2 (Extension Volume Architecture & Cast Pill UI).
 *
 * EMPIRICAL ADVERSARIAL VERIFICATION:
 * 1. Firmware Unmute Bug Invariant:
 *    - Mute button click in popup or cast pill MUST dispatch payload with `muted: boolean` and `volume === undefined`.
 *    - Slider or step buttons click MUST dispatch payload with `volume: number` and `muted === undefined`.
 *    - Under no user interaction may both `volume` and `muted` be dispatched together from the frontend.
 * 2. Zero Direct HTTP Fetch Invariant:
 *    - Statically inspect `packages/extension/src/popup/popup.ts` to assert `fetch(` is called 0 times.
 *    - Statically inspect `packages/extension/src/isolated-world/castPill.ts` and `entry.ts` for zero `fetch(`.
 * 3. Service Worker Validation Hardening:
 *    - Empty request `{ type: 'set_volume' }` -> rejected (`ok: false`).
 *    - Non-integer volume `{ type: 'set_volume', volume: 45.5 }` -> rejected (`ok: false`).
 *    - Negative volume `{ type: 'set_volume', volume: -1 }` -> rejected (`ok: false`).
 *    - Out of bounds volume `{ type: 'set_volume', volume: 101 }` -> rejected (`ok: false`).
 *    - Non-boolean mute `{ type: 'set_volume', muted: 'true' as any }` -> rejected (`ok: false`).
 *    - Disconnect failure: mock `wsController.sendCommand` returning `false` -> returns `{ ok: false, error: ... }`.
 *    - Valid payload: sequence number is generated via `allocateTimestampCommandSeq()`.
 *    - Boundary checks (0, 100, false, true, NaN, Infinity, -Infinity).
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setupSyntheticDomEnvironment, type SyntheticDomScope } from './e2e/harness/syntheticDomEnvironment.js';
import { ShadowDomCastPill, type CastPillCallbacks } from '../packages/extension/src/isolated-world/castPill.js';
import { bootstrapPopup } from '../packages/extension/src/popup/popup.js';
import { ExtensionBackgroundCoordinator } from '../packages/extension/src/background/serviceWorker.js';
import { allocateTimestampCommandSeq, COMMAND_SEQ_MODULUS } from '../packages/extension/src/background/wsController.js';
import { createInMemoryStorageArea } from '../packages/extension/src/shared/storageSchema.js';
import type {
  DiscoveredOutputEntry,
  ExtensionRuntimeRequest,
  ExtensionRuntimeResponse,
  ExtensionUiSnapshot,
} from '../packages/extension/src/shared/messages.js';

function createMockOutputEntry(overrides?: {
  readonly id?: string;
  readonly kind?: 'heos_upnp' | 'coreaudio';
  readonly supportsHardwareVolume?: boolean;
}): DiscoveredOutputEntry {
  const kind = overrides?.kind ?? 'heos_upnp';
  const supportsHardwareVolume =
    overrides?.supportsHardwareVolume ?? (kind === 'heos_upnp');
  return {
    compositeKey: overrides?.id ?? 'heos-denon-pm7000n',
    endpointBaseUrl: 'http://127.0.0.1:9876',
    receiverId: 'rcv_test_heos',
    receiverName: 'Marantz PM7000N Living Room',
    isLoopback: true,
    output: {
      id: overrides?.id ?? 'heos-denon-pm7000n',
      name: 'Marantz PM7000N',
      kind,
      transport: 'heos_lan_wav',
      isAvailable: true,
      isRecommendedDefault: true,
      standbyState: 'on',
      capabilities: {
        bitPerfect: true,
        fixedGainDb: 0,
        targetSampleRateHz: 44100,
        targetBitDepth: 24,
        autoWakeFromStandby: false,
        displaysTrackMetadataOnDevice: true,
        seekDebounceMs: 250,
        supportsHardwareVolume,
      },
    },
  };
}

function createTestSnapshot(overrides?: Partial<ExtensionUiSnapshot>): ExtensionUiSnapshot {
  const defaultEntry = createMockOutputEntry();
  return {
    handoffEnabled: true,
    connectionState: 'connected',
    activeEndpointBaseUrl: 'http://127.0.0.1:9876',
    activeReceiverId: 'rcv_test_heos',
    activeReceiverName: 'Marantz PM7000N Living Room',
    activeOutputId: defaultEntry.output.id,
    activeOutput: defaultEntry.output,
    seekDebounceMs: 250,
    outputs: [defaultEntry],
    knownEndpoints: ['http://127.0.0.1:9876'],
    telemetry: null,
    lastAckedCommandSeq: 0,
    accountTier: 'go_plus',
    drmFallback: null,
    lastError: null,
    hardwareVolume: 35,
    hardwareMuted: false,
    ...overrides,
  };
}

describe('Challenger 2 — Milestone 2 Volume Architecture & Firmware Unmute Invariants', () => {
  // =========================================================================
  // SECTION 1: Zero Direct HTTP Fetch Invariant (Static Source Inspection)
  // =========================================================================
  describe('Invariant 2: Zero Direct HTTP Fetch Invariant', () => {
    it('statically asserts that packages/extension/src/popup/popup.ts has 0 calls to fetch(', () => {
      const popupPath = path.resolve(
        __dirname,
        '../packages/extension/src/popup/popup.ts',
      );
      const content = fs.readFileSync(popupPath, 'utf8');

      // Match any occurrence of `fetch(` not preceded by alphanumeric (to avoid e.g. `prefetch(`)
      const fetchMatches = content.match(/(?<![a-zA-Z0-9_])fetch\s*\(/g);
      expect(fetchMatches).toBeNull();

      // Specifically check for any /api/v1/audio/volume endpoint mentions
      expect(content).not.toContain('/api/v1/audio/volume');
    });

    it('statically asserts that packages/extension/src/isolated-world/castPill.ts has 0 calls to fetch(', () => {
      const castPillPath = path.resolve(
        __dirname,
        '../packages/extension/src/isolated-world/castPill.ts',
      );
      const content = fs.readFileSync(castPillPath, 'utf8');
      const fetchMatches = content.match(/(?<![a-zA-Z0-9_])fetch\s*\(/g);
      expect(fetchMatches).toBeNull();
      expect(content).not.toContain('/api/v1/audio/volume');
    });

    it('statically asserts that packages/extension/src/isolated-world/entry.ts has 0 calls to fetch(', () => {
      const entryPath = path.resolve(
        __dirname,
        '../packages/extension/src/isolated-world/entry.ts',
      );
      const content = fs.readFileSync(entryPath, 'utf8');
      const fetchMatches = content.match(/(?<![a-zA-Z0-9_])fetch\s*\(/g);
      expect(fetchMatches).toBeNull();
      expect(content).not.toContain('/api/v1/audio/volume');
    });
  });

  // =========================================================================
  // SECTION 2: Firmware Unmute Bug Invariant — Popup Controller UI
  // =========================================================================
  describe('Invariant 1: Firmware Unmute Bug Prevention in Popup Controller', () => {
    let dom: SyntheticDomScope;
    let originalChrome: unknown;
    let sentRequests: ExtensionRuntimeRequest[];

    beforeEach(() => {
      dom = setupSyntheticDomEnvironment();
      (dom.document as any).getElementById = (id: string) =>
        dom.document.querySelector('#' + id);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      sentRequests = [];

      originalChrome = (globalThis as any).chrome;
      (globalThis as any).chrome = {
        runtime: {
          sendMessage: vi.fn(
            async (req: ExtensionRuntimeRequest): Promise<ExtensionRuntimeResponse> => {
              sentRequests.push(req);
              return { ok: true, snapshot: createTestSnapshot() };
            },
          ),
          connect: vi.fn(() => ({
            name: 'soundclud-popup',
            onMessage: { addListener: vi.fn() },
            disconnect: vi.fn(),
          })),
        },
      };
    });

    afterEach(() => {
      vi.useRealTimers();
      (globalThis as any).chrome = originalChrome;
      dom.teardown();
    });

    function setupPopupDom() {
      const card = dom.document.createElement('div');
      card.id = 'amp-volume-card';

      const slider = dom.document.createElement('input');
      slider.id = 'amp-volume-slider';
      slider.setAttribute('type', 'range');
      slider.setAttribute('value', '25');

      const label = dom.document.createElement('span');
      label.id = 'amp-volume-label';
      label.textContent = '25%';

      const muteBtn = dom.document.createElement('button');
      muteBtn.id = 'amp-mute-btn';
      muteBtn.setAttribute('aria-pressed', 'false');

      const downBtn = dom.document.createElement('button');
      downBtn.id = 'amp-vol-down-btn';

      const upBtn = dom.document.createElement('button');
      upBtn.id = 'amp-vol-up-btn';

      dom.document.body.append(card, slider, label, muteBtn, downBtn, upBtn);

      bootstrapPopup();
      return { card, slider, label, muteBtn, downBtn, upBtn };
    }

    it('POPUP: mute toggle sends payload with muted: boolean and volume === undefined', async () => {
      const { muteBtn } = setupPopupDom();
      await vi.runAllTicks();
      sentRequests.length = 0;

      // Click mute button to mute
      muteBtn.click();
      expect(sentRequests).toHaveLength(1);
      const req1 = sentRequests[0] as Extract<ExtensionRuntimeRequest, { type: 'set_volume' }>;
      expect(req1.type).toBe('set_volume');
      expect(req1.muted).toBe(true);
      expect(req1.volume).toBeUndefined();
      expect('volume' in req1).toBe(false);

      // Click mute button again to unmute
      muteBtn.click();
      expect(sentRequests).toHaveLength(2);
      const req2 = sentRequests[1] as Extract<ExtensionRuntimeRequest, { type: 'set_volume' }>;
      expect(req2.type).toBe('set_volume');
      expect(req2.muted).toBe(false);
      expect(req2.volume).toBeUndefined();
      expect('volume' in req2).toBe(false);
    });

    it('POPUP: slider input and change send payload with volume: number and muted === undefined', async () => {
      const { slider } = setupPopupDom();
      await vi.runAllTicks();
      sentRequests.length = 0;

      // Slider input event (debounced 100ms)
      slider.value = '52';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      vi.advanceTimersByTime(100);

      expect(sentRequests).toHaveLength(1);
      const reqInput = sentRequests[0] as Extract<ExtensionRuntimeRequest, { type: 'set_volume' }>;
      expect(reqInput.type).toBe('set_volume');
      expect(reqInput.volume).toBe(52);
      expect(reqInput.muted).toBeUndefined();
      expect('muted' in reqInput).toBe(false);

      // Slider change event (immediate dispatch)
      slider.value = '74';
      slider.dispatchEvent(new Event('change', { bubbles: true }));

      expect(sentRequests).toHaveLength(2);
      const reqChange = sentRequests[1] as Extract<ExtensionRuntimeRequest, { type: 'set_volume' }>;
      expect(reqChange.type).toBe('set_volume');
      expect(reqChange.volume).toBe(74);
      expect(reqChange.muted).toBeUndefined();
      expect('muted' in reqChange).toBe(false);
    });

    it('POPUP: step buttons send payload with volume: number and muted === undefined', async () => {
      const { downBtn, upBtn } = setupPopupDom();
      await vi.runAllTicks();
      sentRequests.length = 0;

      // Step down: 25 -> 23
      downBtn.click();
      expect(sentRequests).toHaveLength(1);
      const reqDown = sentRequests[0] as Extract<ExtensionRuntimeRequest, { type: 'set_volume' }>;
      expect(reqDown.type).toBe('set_volume');
      expect(reqDown.volume).toBe(23);
      expect(reqDown.muted).toBeUndefined();
      expect('muted' in reqDown).toBe(false);

      // Step up: 23 -> 25
      upBtn.click();
      expect(sentRequests).toHaveLength(2);
      const reqUp = sentRequests[1] as Extract<ExtensionRuntimeRequest, { type: 'set_volume' }>;
      expect(reqUp.type).toBe('set_volume');
      expect(reqUp.volume).toBe(25);
      expect(reqUp.muted).toBeUndefined();
      expect('muted' in reqUp).toBe(false);
    });

    it('POPUP ADVERSARIAL STRESS: 50 randomized interleaved user interactions NEVER dispatch both volume and muted', async () => {
      const { slider, muteBtn, downBtn, upBtn } = setupPopupDom();
      await vi.runAllTicks();
      sentRequests.length = 0;

      const actions = [
        () => {
          const val = Math.floor(Math.random() * 101);
          slider.value = String(val);
          slider.dispatchEvent(new Event('input', { bubbles: true }));
          vi.advanceTimersByTime(100);
        },
        () => {
          const val = Math.floor(Math.random() * 101);
          slider.value = String(val);
          slider.dispatchEvent(new Event('change', { bubbles: true }));
        },
        () => downBtn.click(),
        () => upBtn.click(),
        () => muteBtn.click(),
      ];

      for (let i = 0; i < 50; i++) {
        const action = actions[i % actions.length]!;
        action();
      }

      expect(sentRequests.length).toBeGreaterThan(30);

      for (const req of sentRequests) {
        if (req.type === 'set_volume') {
          const hasVol = req.volume !== undefined;
          const hasMute = req.muted !== undefined;

          // Law 1 / Firmware Unmute Invariant: exactly one must be present, NEVER both
          expect(hasVol !== hasMute).toBe(true);
          if (hasVol) {
            expect(hasMute).toBe(false);
            expect('muted' in req).toBe(false);
            expect(typeof req.volume).toBe('number');
          }
          if (hasMute) {
            expect(hasVol).toBe(false);
            expect('volume' in req).toBe(false);
            expect(typeof req.muted).toBe('boolean');
          }
        }
      }
    });
  });

  // =========================================================================
  // SECTION 3: Firmware Unmute Bug Invariant — Shadow DOM Cast Pill UI
  // =========================================================================
  describe('Invariant 1: Firmware Unmute Bug Prevention in Cast Pill UI', () => {
    let dom: SyntheticDomScope;
    let dispatchedCalls: Array<{ volume?: number | undefined; muted?: boolean | undefined }>;

    beforeEach(() => {
      dom = setupSyntheticDomEnvironment();
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      dispatchedCalls = [];
    });

    afterEach(() => {
      vi.useRealTimers();
      dom.teardown();
    });

    function setupCastPill() {
      const callbacks: CastPillCallbacks = {
        onToggleHandoff: vi.fn(),
        onSelectOutput: vi.fn(),
        onRefreshOutputs: vi.fn(),
        onSetVolume: (volume, muted) => {
          dispatchedCalls.push({ volume, muted });
        },
      };

      const pill = new ShadowDomCastPill(callbacks);
      pill.mount();
      pill.update(createTestSnapshot({ hardwareVolume: 40, hardwareMuted: false }));

      const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
      const shadow = host?.shadowRoot;
      expect(shadow).not.toBeNull();

      const slider = shadow!.querySelector('.pill-volume-slider')!;
      const downBtn = shadow!.querySelector('.pill-vol-down-btn')!;
      const upBtn = shadow!.querySelector('.pill-vol-up-btn')!;
      const muteBtn = shadow!.querySelector('.pill-mute-btn')!;

      return { pill, slider, downBtn, upBtn, muteBtn };
    }

    it('CAST PILL: mute click dispatches muted: boolean with volume === undefined', () => {
      const { muteBtn } = setupCastPill();

      // Click mute button
      muteBtn.click();
      expect(dispatchedCalls).toHaveLength(1);
      expect(dispatchedCalls[0]!.muted).toBe(true);
      expect(dispatchedCalls[0]!.volume).toBeUndefined();

      // Click again to unmute
      muteBtn.click();
      expect(dispatchedCalls).toHaveLength(2);
      expect(dispatchedCalls[1]!.muted).toBe(false);
      expect(dispatchedCalls[1]!.volume).toBeUndefined();
    });

    it('CAST PILL: slider input and change dispatch volume: number with muted === undefined', () => {
      const { slider } = setupCastPill();

      // Slider input (debounced 100ms)
      slider.value = '62';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
      vi.advanceTimersByTime(100);

      expect(dispatchedCalls).toHaveLength(1);
      expect(dispatchedCalls[0]!.volume).toBe(62);
      expect(dispatchedCalls[0]!.muted).toBeUndefined();

      // Slider change (immediate)
      slider.value = '80';
      slider.dispatchEvent(new Event('change', { bubbles: true }));

      expect(dispatchedCalls).toHaveLength(2);
      expect(dispatchedCalls[1]!.volume).toBe(80);
      expect(dispatchedCalls[1]!.muted).toBeUndefined();
    });

    it('CAST PILL: step down and step up dispatch volume: number with muted === undefined', () => {
      const { downBtn, upBtn } = setupCastPill();

      // Step down: 40 -> 38
      downBtn.click();
      expect(dispatchedCalls).toHaveLength(1);
      expect(dispatchedCalls[0]!.volume).toBe(38);
      expect(dispatchedCalls[0]!.muted).toBeUndefined();

      // Step up: 38 -> 40
      upBtn.click();
      expect(dispatchedCalls).toHaveLength(2);
      expect(dispatchedCalls[1]!.volume).toBe(40);
      expect(dispatchedCalls[1]!.muted).toBeUndefined();
    });

    it('CAST PILL ADVERSARIAL STRESS: 50 randomized interleaved interactions NEVER dispatch both volume and muted', () => {
      const { slider, downBtn, upBtn, muteBtn } = setupCastPill();

      const actions = [
        () => {
          const val = Math.floor(Math.random() * 101);
          slider.value = String(val);
          slider.dispatchEvent(new Event('input', { bubbles: true }));
          vi.advanceTimersByTime(100);
        },
        () => {
          const val = Math.floor(Math.random() * 101);
          slider.value = String(val);
          slider.dispatchEvent(new Event('change', { bubbles: true }));
        },
        () => downBtn.click(),
        () => upBtn.click(),
        () => muteBtn.click(),
      ];

      for (let i = 0; i < 50; i++) {
        const action = actions[i % actions.length]!;
        action();
      }

      expect(dispatchedCalls.length).toBeGreaterThan(30);

      for (const call of dispatchedCalls) {
        const hasVol = call.volume !== undefined;
        const hasMute = call.muted !== undefined;

        // Invariant: mutually exclusive, never both
        expect(hasVol !== hasMute).toBe(true);
        if (hasVol) {
          expect(call.muted).toBeUndefined();
          expect(typeof call.volume).toBe('number');
        }
        if (hasMute) {
          expect(call.volume).toBeUndefined();
          expect(typeof call.muted).toBe('boolean');
        }
      }
    });
  });

  // =========================================================================
  // SECTION 4: Service Worker Validation Hardening
  // =========================================================================
  describe('Invariant 3: Service Worker Validation Hardening (ExtensionBackgroundCoordinator)', () => {
    let coordinator: ExtensionBackgroundCoordinator;

    beforeEach(() => {
      coordinator = new ExtensionBackgroundCoordinator({
        storage: {
          local: createInMemoryStorageArea(),
          session: createInMemoryStorageArea(),
        },
      });
    });

    it('SW-VAL-01: rejects empty request where neither volume nor muted is provided', async () => {
      const res = await coordinator.handleRequest({
        type: 'set_volume',
      } as any);

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBe("At least one of 'volume' or 'muted' must be specified");
      }
    });

    it('SW-VAL-02: rejects non-integer volume (e.g. 45.5)', async () => {
      const res = await coordinator.handleRequest({
        type: 'set_volume',
        volume: 45.5,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBe('Volume must be an integer between 0 and 100');
      }
    });

    it('SW-VAL-03: rejects negative volume (e.g. -1)', async () => {
      const res = await coordinator.handleRequest({
        type: 'set_volume',
        volume: -1,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBe('Volume must be an integer between 0 and 100');
      }
    });

    it('SW-VAL-04: rejects out-of-bounds volume (e.g. 101)', async () => {
      const res = await coordinator.handleRequest({
        type: 'set_volume',
        volume: 101,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBe('Volume must be an integer between 0 and 100');
      }
    });

    it('SW-VAL-05: rejects non-boolean mute (e.g. string "true", number 1, object)', async () => {
      const resString = await coordinator.handleRequest({
        type: 'set_volume',
        muted: 'true' as any,
      });
      expect(resString.ok).toBe(false);
      if (!resString.ok) {
        expect(resString.error).toBe('Muted must be a boolean');
      }

      const resNum = await coordinator.handleRequest({
        type: 'set_volume',
        muted: 1 as any,
      });
      expect(resNum.ok).toBe(false);
      if (!resNum.ok) {
        expect(resNum.error).toBe('Muted must be a boolean');
      }

      const resObj = await coordinator.handleRequest({
        type: 'set_volume',
        muted: { muted: true } as any,
      });
      expect(resObj.ok).toBe(false);
      if (!resObj.ok) {
        expect(resObj.error).toBe('Muted must be a boolean');
      }
    });

    it('SW-VAL-06: rejects NaN, Infinity, -Infinity, and type errors for volume', async () => {
      for (const badVol of [NaN, Infinity, -Infinity, '50' as any, null as any, [] as any]) {
        const res = await coordinator.handleRequest({
          type: 'set_volume',
          volume: badVol,
        });
        expect(res.ok).toBe(false);
        if (!res.ok) {
          expect(res.error).toBe('Volume must be an integer between 0 and 100');
        }
      }
    });

    it('SW-VAL-07: disconnect failure returns { ok: false, error: ... } when wsController fails delivery', async () => {
      vi.spyOn(coordinator.getWsController(), 'sendCommand').mockResolvedValue(false);

      const res = await coordinator.handleRequest({
        type: 'set_volume',
        volume: 50,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBe('Failed to deliver volume command to receiver');
      }
    });

    it('SW-VAL-08: valid payload generates commandSeq via allocateTimestampCommandSeq()', async () => {
      const sendCommandSpy = vi
        .spyOn(coordinator.getWsController(), 'sendCommand')
        .mockResolvedValue(true);

      const before = Date.now() % COMMAND_SEQ_MODULUS;
      const res = await coordinator.handleRequest({
        type: 'set_volume',
        volume: 42,
      });
      const after = Date.now() % COMMAND_SEQ_MODULUS;

      expect(res.ok).toBe(true);
      expect(sendCommandSpy).toHaveBeenCalledTimes(1);

      const sentCmd = sendCommandSpy.mock.calls[0]?.[0];
      expect(sentCmd?.type).toBe('set_volume');
      expect((sentCmd as any)?.volume).toBe(42);
      expect((sentCmd as any)?.muted).toBeUndefined();

      const seq = (sentCmd as any)?.commandSeq;
      expect(typeof seq).toBe('number');
      expect(Number.isInteger(seq)).toBe(true);
      expect(seq).toBeGreaterThanOrEqual(0);
      expect(seq).toBeLessThan(COMMAND_SEQ_MODULUS);

      // Verify sequence matches allocateTimestampCommandSeq logic
      expect(seq).toBeGreaterThanOrEqual(Math.min(before, after));
      expect(seq).toBeLessThanOrEqual(Math.max(before, after));
    });

    it('SW-VAL-09: boundary volumes 0 and 100, and boolean mutes true/false are accepted', async () => {
      const sendCommandSpy = vi
        .spyOn(coordinator.getWsController(), 'sendCommand')
        .mockResolvedValue(true);

      // Boundary 0
      const res0 = await coordinator.handleRequest({
        type: 'set_volume',
        volume: 0,
      });
      expect(res0.ok).toBe(true);
      expect(sendCommandSpy.mock.calls[0]?.[0]).toMatchObject({
        type: 'set_volume',
        volume: 0,
      });

      // Boundary 100
      const res100 = await coordinator.handleRequest({
        type: 'set_volume',
        volume: 100,
      });
      expect(res100.ok).toBe(true);
      expect(sendCommandSpy.mock.calls[1]?.[0]).toMatchObject({
        type: 'set_volume',
        volume: 100,
      });

      // Mute true
      const resMuteTrue = await coordinator.handleRequest({
        type: 'set_volume',
        muted: true,
      });
      expect(resMuteTrue.ok).toBe(true);
      expect(sendCommandSpy.mock.calls[2]?.[0]).toMatchObject({
        type: 'set_volume',
        muted: true,
      });

      // Mute false
      const resMuteFalse = await coordinator.handleRequest({
        type: 'set_volume',
        muted: false,
      });
      expect(resMuteFalse.ok).toBe(true);
      expect(sendCommandSpy.mock.calls[3]?.[0]).toMatchObject({
        type: 'set_volume',
        muted: false,
      });
    });
  });
});
