/**
 * Challenger 2 Adversarial Stress Suite — Milestone 2 Iteration 2
 *
 * Focus:
 * 1. Optimistic session state updates and snapshot return in `serviceWorker.ts`.
 * 2. Snapback prevention when UI renders `res.snapshot`.
 * 3. Failure isolation when `sendCommand` fails or throws.
 * 4. Mutual exclusion of `volume` and `muted` parameters (firmware un-mute protection).
 * 5. Boundary conditions (volume 0, volume 100, mute false, mute true).
 * 6. Chaos stress with intermittent WebSocket transport failures.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { setupSyntheticDomEnvironment, type SyntheticDomScope } from './e2e/harness/syntheticDomEnvironment.js';
import { ExtensionBackgroundCoordinator } from '../packages/extension/src/background/serviceWorker.js';
import { createInMemoryStorageArea, updateEphemeralSessionState, readEphemeralSessionState } from '../packages/extension/src/shared/storageSchema.js';
import { ShadowDomCastPill, type CastPillCallbacks } from '../packages/extension/src/isolated-world/castPill.js';
import { bootstrapPopup } from '../packages/extension/src/popup/popup.js';
import type {
  DiscoveredOutputEntry,
  ExtensionRuntimeRequest,
  ExtensionRuntimeResponse,
  ExtensionUiSnapshot,
} from '../packages/extension/src/shared/messages.js';

function createMockHeosOutput(): DiscoveredOutputEntry {
  return {
    compositeKey: 'heos-denon-pm7000n',
    endpointBaseUrl: 'http://127.0.0.1:9876',
    receiverId: 'rcv_test_heos',
    receiverName: 'Marantz PM7000N Living Room',
    isLoopback: true,
    output: {
      id: 'heos-denon-pm7000n',
      name: 'Marantz PM7000N',
      kind: 'heos_upnp',
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
        supportsHardwareVolume: true,
      },
    },
  };
}

describe('Challenger 2 Adversarial Verification — Optimistic Session State & Snapback Prevention', () => {
  let storage: {
    local: ReturnType<typeof createInMemoryStorageArea>;
    session: ReturnType<typeof createInMemoryStorageArea>;
  };
  let coordinator: ExtensionBackgroundCoordinator;

  beforeEach(() => {
    storage = {
      local: createInMemoryStorageArea(),
      session: createInMemoryStorageArea(),
    };
    coordinator = new ExtensionBackgroundCoordinator({
      storage,
    });
  });

  // =========================================================================
  // 1. SNAPBACK PREVENTION: Optimistic Snapshot Return
  // =========================================================================
  describe('Snapback Prevention & Immediate Optimistic Snapshot Return', () => {
    it('returns optimistic snapshot with new volume immediately upon successful command delivery', async () => {
      // Seed initial state at 50%
      await updateEphemeralSessionState(storage.session, (prev) => ({
        ...prev,
        hardwareVolume: 50,
        hardwareMuted: false,
      }));

      const sendCommandSpy = vi
        .spyOn(coordinator.getWsController(), 'sendCommand')
        .mockResolvedValue(true);

      // User steps down to 48
      const res = await coordinator.handleRequest({
        type: 'set_volume',
        volume: 48,
      });

      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('Expected ok');

      // The returned snapshot MUST immediately reflect 48 to prevent snapback
      expect(res.snapshot.hardwareVolume).toBe(48);
      expect(res.snapshot.hardwareMuted).toBe(false);

      // Session storage MUST also be updated optimistically
      const session = await readEphemeralSessionState(storage.session);
      expect(session.hardwareVolume).toBe(48);
      expect(session.hardwareMuted).toBe(false);

      expect(sendCommandSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'set_volume',
          volume: 48,
        }),
      );
    });

    it('returns optimistic snapshot with new mute state immediately upon successful delivery', async () => {
      // Seed initial state at 48% and unmuted
      await updateEphemeralSessionState(storage.session, (prev) => ({
        ...prev,
        hardwareVolume: 48,
        hardwareMuted: false,
      }));

      vi.spyOn(coordinator.getWsController(), 'sendCommand').mockResolvedValue(true);

      // User clicks mute
      const res = await coordinator.handleRequest({
        type: 'set_volume',
        muted: true,
      });

      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error('Expected ok');

      // Returned snapshot MUST immediately reflect muted: true, preserving volume 48
      expect(res.snapshot.hardwareMuted).toBe(true);
      expect(res.snapshot.hardwareVolume).toBe(48);

      const session = await readEphemeralSessionState(storage.session);
      expect(session.hardwareMuted).toBe(true);
      expect(session.hardwareVolume).toBe(48);
    });

    it('prevents UI snapback in Cast Pill when applying optimistic snapshot', async () => {
      const dom = setupSyntheticDomEnvironment();
      try {
        let sentRequest: { volume?: number | undefined; muted?: boolean | undefined } | null = null;
        const callbacks: CastPillCallbacks = {
          onToggleHandoff: vi.fn(),
          onSelectOutput: vi.fn(),
          onRefreshOutputs: vi.fn(),
          onSetVolume: (volume, muted) => {
            sentRequest = { volume, muted };
          },
        };

        const pill = new ShadowDomCastPill(callbacks);
        pill.mount();

        // Initial snapshot: volume 50, unmuted
        const mockOutput = createMockHeosOutput();
        const initialSnapshot: ExtensionUiSnapshot = {
          handoffEnabled: true,
          connectionState: 'connected',
          activeEndpointBaseUrl: 'http://127.0.0.1:9876',
          activeReceiverId: 'rcv_test_heos',
          activeReceiverName: 'Marantz PM7000N Living Room',
          activeOutputId: mockOutput.output.id,
          activeOutput: mockOutput.output,
          seekDebounceMs: 250,
          outputs: [mockOutput],
          knownEndpoints: ['http://127.0.0.1:9876'],
          telemetry: null,
          lastAckedCommandSeq: 0,
          accountTier: 'go_plus',
          drmFallback: null,
          lastError: null,
          hardwareVolume: 50,
          hardwareMuted: false,
        };
        pill.update(initialSnapshot);

        const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
        const shadow = host?.shadowRoot;
        expect(shadow).not.toBeNull();

        const slider = shadow!.querySelector('.pill-volume-slider') as unknown as { value: string };
        const label = shadow!.querySelector('.pill-volume-label');
        const downBtn = shadow!.querySelector('.pill-vol-down-btn') as unknown as { click: () => void };

        expect(slider.value).toBe('50');
        expect(label?.textContent).toBe('50%');

        // Seed coordinator session storage
        await updateEphemeralSessionState(storage.session, (prev) => ({
          ...prev,
          hardwareVolume: 50,
          hardwareMuted: false,
        }));
        vi.spyOn(coordinator.getWsController(), 'sendCommand').mockResolvedValue(true);

        // Click step down button
        downBtn.click();
        expect(sentRequest).toEqual({ volume: 48, muted: undefined });

        // Service worker processes request and returns optimistic snapshot
        const res = await coordinator.handleRequest({
          type: 'set_volume',
          volume: sentRequest!.volume,
          muted: sentRequest!.muted,
        });
        expect(res.ok).toBe(true);
        if (!res.ok) throw new Error('Expected ok');

        // Pill updates with returned optimistic snapshot (mimicking entry.ts:170)
        pill.update({
          ...initialSnapshot,
          ...res.snapshot,
        });

        // UI MUST display 48% immediately — ZERO SNAPBACK TO 50
        expect(slider.value).toBe('48');
        expect(label?.textContent).toBe('48%');
        expect(shadow!.querySelector('.pill-quick-vol-text')?.textContent).toBe('48%');
      } finally {
        dom.teardown();
      }
    });
  });

  // =========================================================================
  // 2. FAILURE ISOLATION: Rejected or Failed Commands Do NOT Modify State
  // =========================================================================
  describe('Failure Isolation — State Protection on Command Failure', () => {
    it('preserves existing session state when sendCommand returns false (delivery failure)', async () => {
      // Initial state: volume 60, unmuted
      await updateEphemeralSessionState(storage.session, (prev) => ({
        ...prev,
        hardwareVolume: 60,
        hardwareMuted: false,
      }));

      // Mock delivery failure (e.g. receiver socket closed)
      vi.spyOn(coordinator.getWsController(), 'sendCommand').mockResolvedValue(false);

      const res = await coordinator.handleRequest({
        type: 'set_volume',
        volume: 85,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBe('Failed to deliver volume command to receiver');
      }

      // Invariant: session storage MUST NOT be updated to 85
      const session = await readEphemeralSessionState(storage.session);
      expect(session.hardwareVolume).toBe(60);
      expect(session.hardwareMuted).toBe(false);

      // Snapshot MUST NOT be updated to 85
      const snapshot = await coordinator.getSnapshot();
      expect(snapshot.hardwareVolume).toBe(60);
    });

    it('preserves existing session state when sendCommand throws an error', async () => {
      // Initial state: volume 60, unmuted
      await updateEphemeralSessionState(storage.session, (prev) => ({
        ...prev,
        hardwareVolume: 60,
        hardwareMuted: false,
      }));

      // Mock throwing error inside sendCommand
      vi.spyOn(coordinator.getWsController(), 'sendCommand').mockRejectedValue(
        new Error('WebSocket connection broken abruptly'),
      );

      const res = await coordinator.handleRequest({
        type: 'set_volume',
        volume: 90,
      });

      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBe('WebSocket connection broken abruptly');
        // Snapshot returned in catch handler must also reflect intact state
        expect(res.snapshot?.hardwareVolume).toBe(60);
      }

      // Session storage MUST remain intact
      const session = await readEphemeralSessionState(storage.session);
      expect(session.hardwareVolume).toBe(60);
    });

    it('preserves existing session state when request fails input validation', async () => {
      await updateEphemeralSessionState(storage.session, (prev) => ({
        ...prev,
        hardwareVolume: 33,
        hardwareMuted: false,
      }));

      const sendCommandSpy = vi.spyOn(coordinator.getWsController(), 'sendCommand');

      const invalidRequests = [
        { type: 'set_volume' as const },
        { type: 'set_volume' as const, volume: -10 },
        { type: 'set_volume' as const, volume: 150 },
        { type: 'set_volume' as const, volume: 33.3 },
        { type: 'set_volume' as const, volume: NaN },
        { type: 'set_volume' as const, muted: 'false' as any },
        { type: 'set_volume' as const, muted: null as any },
      ];

      for (const req of invalidRequests) {
        const res = await coordinator.handleRequest(req);
        expect(res.ok).toBe(false);
      }

      expect(sendCommandSpy).not.toHaveBeenCalled();

      const session = await readEphemeralSessionState(storage.session);
      expect(session.hardwareVolume).toBe(33);
      expect(session.hardwareMuted).toBe(false);
    });
  });

  // =========================================================================
  // 3. PARAMETER ISOLATION & FIRMWARE UN-MUTE PROTECTION
  // =========================================================================
  describe('Parameter Isolation: Mute clicks omit volume & Volume adjustments omit muted', () => {
    it('volume adjustment updates volume without clobbering or touching muted state', async () => {
      // Seed muted = true, volume = 20
      await updateEphemeralSessionState(storage.session, (prev) => ({
        ...prev,
        hardwareVolume: 20,
        hardwareMuted: true,
      }));

      const sendCommandSpy = vi
        .spyOn(coordinator.getWsController(), 'sendCommand')
        .mockResolvedValue(true);

      // Volume change: 20 -> 25 (muted omitted)
      const res = await coordinator.handleRequest({
        type: 'set_volume',
        volume: 25,
      });

      expect(res.ok).toBe(true);
      expect(sendCommandSpy).toHaveBeenCalledTimes(1);

      const sent = sendCommandSpy.mock.calls[0]?.[0] as any;
      expect(sent.volume).toBe(25);
      expect(sent.muted).toBeUndefined();
      expect('muted' in sent).toBe(false);

      // Optimistic snapshot: volume is 25, muted remains true
      expect(res.snapshot?.hardwareVolume).toBe(25);
      expect(res.snapshot?.hardwareMuted).toBe(true);

      const session = await readEphemeralSessionState(storage.session);
      expect(session.hardwareVolume).toBe(25);
      expect(session.hardwareMuted).toBe(true);
    });

    it('mute toggle updates mute without clobbering or touching volume state', async () => {
      // Seed muted = true, volume = 45
      await updateEphemeralSessionState(storage.session, (prev) => ({
        ...prev,
        hardwareVolume: 45,
        hardwareMuted: true,
      }));

      const sendCommandSpy = vi
        .spyOn(coordinator.getWsController(), 'sendCommand')
        .mockResolvedValue(true);

      // Mute toggle: true -> false (volume omitted)
      const res = await coordinator.handleRequest({
        type: 'set_volume',
        muted: false,
      });

      expect(res.ok).toBe(true);
      expect(sendCommandSpy).toHaveBeenCalledTimes(1);

      const sent = sendCommandSpy.mock.calls[0]?.[0] as any;
      expect(sent.muted).toBe(false);
      expect(sent.volume).toBeUndefined();
      expect('volume' in sent).toBe(false);

      // Optimistic snapshot: muted is false, volume remains 45
      expect(res.snapshot?.hardwareMuted).toBe(false);
      expect(res.snapshot?.hardwareVolume).toBe(45);

      const session = await readEphemeralSessionState(storage.session);
      expect(session.hardwareMuted).toBe(false);
      expect(session.hardwareVolume).toBe(45);
    });
  });

  // =========================================================================
  // 4. BOUNDARY VALUES & FALSY CHECK DEFENSE (Volume 0 & Mute false)
  // =========================================================================
  describe('Boundary Values: Falsy Value Handling (Volume 0 & Mute false)', () => {
    it('correctly handles volume: 0 without treating 0 as falsy/omitted', async () => {
      await updateEphemeralSessionState(storage.session, (prev) => ({
        ...prev,
        hardwareVolume: 50,
        hardwareMuted: false,
      }));

      const sendCommandSpy = vi
        .spyOn(coordinator.getWsController(), 'sendCommand')
        .mockResolvedValue(true);

      const res = await coordinator.handleRequest({
        type: 'set_volume',
        volume: 0,
      });

      expect(res.ok).toBe(true);
      const sent = sendCommandSpy.mock.calls[0]?.[0] as any;
      expect(sent.volume).toBe(0);
      expect(sent.muted).toBeUndefined();

      expect(res.snapshot?.hardwareVolume).toBe(0);
      expect(res.snapshot?.hardwareMuted).toBe(false);

      const session = await readEphemeralSessionState(storage.session);
      expect(session.hardwareVolume).toBe(0);
    });

    it('correctly handles volume: 100 maximum boundary', async () => {
      await updateEphemeralSessionState(storage.session, (prev) => ({
        ...prev,
        hardwareVolume: 50,
      }));

      vi.spyOn(coordinator.getWsController(), 'sendCommand').mockResolvedValue(true);

      const res = await coordinator.handleRequest({
        type: 'set_volume',
        volume: 100,
      });

      expect(res.ok).toBe(true);
      expect(res.snapshot?.hardwareVolume).toBe(100);

      const session = await readEphemeralSessionState(storage.session);
      expect(session.hardwareVolume).toBe(100);
    });

    it('correctly handles muted: false without treating false as falsy/omitted', async () => {
      await updateEphemeralSessionState(storage.session, (prev) => ({
        ...prev,
        hardwareVolume: 70,
        hardwareMuted: true,
      }));

      const sendCommandSpy = vi
        .spyOn(coordinator.getWsController(), 'sendCommand')
        .mockResolvedValue(true);

      const res = await coordinator.handleRequest({
        type: 'set_volume',
        muted: false,
      });

      expect(res.ok).toBe(true);
      const sent = sendCommandSpy.mock.calls[0]?.[0] as any;
      expect(sent.muted).toBe(false);
      expect(sent.volume).toBeUndefined();

      expect(res.snapshot?.hardwareMuted).toBe(false);
      expect(res.snapshot?.hardwareVolume).toBe(70);

      const session = await readEphemeralSessionState(storage.session);
      expect(session.hardwareMuted).toBe(false);
    });
  });

  // =========================================================================
  // 5. CHAOS & CONCURRENCY STRESS: Rapid In-Flight Operations
  // =========================================================================
  describe('Chaos & Concurrency Stress: Interleaved Operations & Flaky Transport', () => {
    it('maintains strict state consistency across 100 rapid random volume/mute commands with flaky transport', async () => {
      let currentSessionVol = 50;
      let currentSessionMuted = false;

      await updateEphemeralSessionState(storage.session, (prev) => ({
        ...prev,
        hardwareVolume: currentSessionVol,
        hardwareMuted: currentSessionMuted,
      }));

      // Simulate flaky transport: 30% chance of send failure
      const sendCommandSpy = vi
        .spyOn(coordinator.getWsController(), 'sendCommand')
        .mockImplementation(async (cmd: any) => {
          // Deterministic pseudo-random based on commandSeq
          const pseudoRand = ((cmd.commandSeq * 9301 + 49297) % 233280) / 233280;
          return pseudoRand > 0.3; // 70% success, 30% failure
        });

      for (let i = 0; i < 100; i++) {
        const isVol = i % 2 === 0;
        if (isVol) {
          const targetVol = i % 101;
          const res = await coordinator.handleRequest({
            type: 'set_volume',
            volume: targetVol,
          });

          if (res.ok) {
            // Success: state MUST be updated
            currentSessionVol = targetVol;
            expect(res.snapshot.hardwareVolume).toBe(targetVol);
            expect(res.snapshot.hardwareMuted).toBe(currentSessionMuted);
          } else {
            // Failure: state MUST NOT be updated to targetVol
            const session = await readEphemeralSessionState(storage.session);
            expect(session.hardwareVolume).toBe(currentSessionVol);
            expect(session.hardwareVolume).not.toBe(targetVol === currentSessionVol ? -1 : targetVol);
          }
        } else {
          const targetMute = i % 4 === 1;
          const res = await coordinator.handleRequest({
            type: 'set_volume',
            muted: targetMute,
          });

          if (res.ok) {
            currentSessionMuted = targetMute;
            expect(res.snapshot.hardwareMuted).toBe(targetMute);
            expect(res.snapshot.hardwareVolume).toBe(currentSessionVol);
          } else {
            const session = await readEphemeralSessionState(storage.session);
            expect(session.hardwareMuted).toBe(currentSessionMuted);
          }
        }
      }

      expect(sendCommandSpy).toHaveBeenCalledTimes(100);

      // Verify final session storage matches expected tracking
      const finalSession = await readEphemeralSessionState(storage.session);
      expect(finalSession.hardwareVolume).toBe(currentSessionVol);
      expect(finalSession.hardwareMuted).toBe(currentSessionMuted);
    });

    it('handles concurrent in-flight volume commands safely', async () => {
      await updateEphemeralSessionState(storage.session, (prev) => ({
        ...prev,
        hardwareVolume: 10,
        hardwareMuted: false,
      }));

      // Simulate slow transport (5ms latency)
      vi.spyOn(coordinator.getWsController(), 'sendCommand').mockImplementation(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          return true;
        },
      );

      // Launch 5 concurrent requests: 20, 30, 40, 50, 60
      const requests = [20, 30, 40, 50, 60].map((vol) =>
        coordinator.handleRequest({ type: 'set_volume', volume: vol }),
      );

      const results = await Promise.all(requests);

      // All must succeed
      for (const res of results) {
        expect(res.ok).toBe(true);
        expect(typeof res.snapshot?.hardwareVolume).toBe('number');
      }

      // Final session state must be one of the valid executed volumes
      const session = await readEphemeralSessionState(storage.session);
      expect([20, 30, 40, 50, 60]).toContain(session.hardwareVolume);
      expect(session.hardwareMuted).toBe(false);
    });
  });
});
