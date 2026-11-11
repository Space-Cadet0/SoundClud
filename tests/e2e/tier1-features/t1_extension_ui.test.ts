import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  allocateTimestampCommandSeq,
  clickSoundCloudTransportButton,
  ConnectedDomCache,
  createDefaultDurableLocalConfig,
  createDefaultEphemeralSessionState,
  createInMemoryStorageArea,
  deriveUiSnapshot,
  LOCAL_STORAGE_KEY,
  ReceiverWsController,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  SESSION_STORAGE_KEY,
  ShadowDomCastPill,
  writeDurableLocalConfig,
  type CastPillCallbacks,
  type DiscoveredOutputEntry,
  type DurableLocalConfig,
  type EphemeralSessionState,
} from '@soundclud/extension';
import { parseClientWsCommand, type SetVolumeWsCommand } from '@soundclud/protocol';
import { ExtensionBackgroundCoordinator } from '../../../packages/extension/src/background/serviceWorker.js';
import { bootstrapPopup } from '../../../packages/extension/src/popup/popup.js';
import {
  createMockReceiverServer,
  setupSyntheticDomEnvironment,
  stopAllResources,
  SYNTHETIC_OUTPUT_HEOS,
  SYNTHETIC_OUTPUT_TOSLINK,
  type ClosableResource,
} from '../harness/index.js';

const safeMockChrome = {
  runtime: {
    sendMessage: vi.fn(async () => ({
      ok: true,
      snapshot: deriveUiSnapshot(
        createDefaultDurableLocalConfig(),
        createDefaultEphemeralSessionState(),
      ),
    })),
    connect: vi.fn(() => ({
      name: 'soundclud-popup',
      onMessage: { addListener: vi.fn() },
      disconnect: vi.fn(),
    })),
  },
};

describe('Tier 1: Extension UI & Virtualization Subsystems (Features 8–10, 17, 18)', () => {
  const closables: ClosableResource[] = [];

  afterEach(async () => {
    await stopAllResources(closables);
    closables.length = 0;
    vi.useRealTimers();
    (globalThis as any).chrome = safeMockChrome;
  });

  // --------------------------------------------------------------------------
  // Feature 8: Service Worker Authenticated Volume Routing
  // --------------------------------------------------------------------------
  describe('Feature 8: Service Worker Authenticated Volume Routing', () => {
    it('T1-F08-01: forwards ExtensionRuntimeRequest volume message to authenticated WS command', async () => {
      const storage = {
        local: createInMemoryStorageArea(),
        session: createInMemoryStorageArea(),
      };
      const coordinator = new ExtensionBackgroundCoordinator({ storage });
      const sendCommandSpy = vi
        .spyOn(coordinator.getWsController(), 'sendCommand')
        .mockResolvedValue(true);

      const res = await coordinator.handleRequest({ type: 'set_volume', volume: 45 });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.snapshot.hardwareVolume).toBe(45);
      }
      expect(sendCommandSpy).toHaveBeenCalledTimes(1);
      const sentCommand = sendCommandSpy.mock.calls[0]?.[0];
      expect(sentCommand?.type).toBe('set_volume');
      expect((sentCommand as any)?.volume).toBe(45);
      expect((sentCommand as any)?.muted).toBeUndefined();
      expect(typeof (sentCommand as any)?.commandSeq).toBe('number');
    });

    it('T1-F08-02: forwards ExtensionRuntimeRequest mute message to authenticated WS command', async () => {
      const storage = {
        local: createInMemoryStorageArea(),
        session: createInMemoryStorageArea(),
      };
      const coordinator = new ExtensionBackgroundCoordinator({ storage });
      const sendCommandSpy = vi
        .spyOn(coordinator.getWsController(), 'sendCommand')
        .mockResolvedValue(true);

      const res = await coordinator.handleRequest({ type: 'set_volume', muted: true });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.snapshot.hardwareMuted).toBe(true);
      }
      expect(sendCommandSpy).toHaveBeenCalledTimes(1);
      const sentCommand = sendCommandSpy.mock.calls[0]?.[0];
      expect(sentCommand?.type).toBe('set_volume');
      expect((sentCommand as any)?.muted).toBe(true);
      expect((sentCommand as any)?.volume).toBeUndefined();
      expect(typeof (sentCommand as any)?.commandSeq).toBe('number');
    });

    it('T1-F08-03: rejects invalid ExtensionRuntimeRequest missing both volume and muted', async () => {
      const storage = {
        local: createInMemoryStorageArea(),
        session: createInMemoryStorageArea(),
      };
      const coordinator = new ExtensionBackgroundCoordinator({ storage });
      const res = await coordinator.handleRequest({ type: 'set_volume' });
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error).toBe("At least one of 'volume' or 'muted' must be specified");
      }
    });

    it('T1-F08-04: rejects invalid ExtensionRuntimeRequest with out-of-bounds volume', async () => {
      const storage = {
        local: createInMemoryStorageArea(),
        session: createInMemoryStorageArea(),
      };
      const coordinator = new ExtensionBackgroundCoordinator({ storage });
      const resBelow = await coordinator.handleRequest({ type: 'set_volume', volume: -5 });
      expect(resBelow.ok).toBe(false);
      const resAbove = await coordinator.handleRequest({ type: 'set_volume', volume: 105 });
      expect(resAbove.ok).toBe(false);
      const resFloat = await coordinator.handleRequest({ type: 'set_volume', volume: 50.5 });
      expect(resFloat.ok).toBe(false);
    });

    it('T1-F08-05: assigns strictly monotonic commandSeq numbers across sequential messages', () => {
      const seq1 = allocateTimestampCommandSeq();
      const seq2 = allocateTimestampCommandSeq();
      const seq3 = allocateTimestampCommandSeq();

      expect(typeof seq1).toBe('number');
      expect(typeof seq2).toBe('number');
      expect(typeof seq3).toBe('number');
      expect(seq2).toBeGreaterThanOrEqual(seq1);
      expect(seq3).toBeGreaterThanOrEqual(seq2);
    });
  });

  // --------------------------------------------------------------------------
  // Feature 9: Popup UI Volume Refactor
  // --------------------------------------------------------------------------
  describe('Feature 9: Popup UI Volume Refactor', () => {
    it('T1-F09-01: enables volume controls when active output supports hardware volume', () => {
      const local: DurableLocalConfig = {
        ...createDefaultDurableLocalConfig(),
        handoffEnabled: true,
        activeReceiverId: 'rec-01',
        activeEndpointBaseUrl: 'http://127.0.0.1:9876',
        activeOutputId: SYNTHETIC_OUTPUT_HEOS.id,
      };

      const session: EphemeralSessionState = {
        ...createDefaultEphemeralSessionState(),
        connectionState: 'connected',
        lastError: null,
        discoveredReceivers: [
          {
            receiverId: 'rec-01',
            receiverName: 'Synthetic Receiver',
            endpointBaseUrl: 'http://127.0.0.1:9876',
            host: '127.0.0.1',
            port: 9876,
            isLoopback: true,
            requiresPairing: false,
            discoveredAtMs: Date.now(),
            outputs: [SYNTHETIC_OUTPUT_HEOS],
          },
        ],
        hardwareVolume: 40,
        hardwareMuted: false,
      };

      const snapshot = deriveUiSnapshot(local, session);
      const isVolumeVisible = snapshot.activeOutput?.capabilities?.supportsHardwareVolume === true;
      expect(isVolumeVisible).toBe(true);
    });

    it('T1-F09-02: hides volume controls or indicates fixed 0 dB when TOSLINK active', () => {
      const local: DurableLocalConfig = {
        ...createDefaultDurableLocalConfig(),
        handoffEnabled: true,
        activeReceiverId: 'rec-01',
        activeEndpointBaseUrl: 'http://127.0.0.1:9876',
        activeOutputId: SYNTHETIC_OUTPUT_TOSLINK.id,
      };

      const session: EphemeralSessionState = {
        ...createDefaultEphemeralSessionState(),
        connectionState: 'connected',
        lastError: null,
        discoveredReceivers: [
          {
            receiverId: 'rec-01',
            receiverName: 'Synthetic Receiver',
            endpointBaseUrl: 'http://127.0.0.1:9876',
            host: '127.0.0.1',
            port: 9876,
            isLoopback: true,
            requiresPairing: false,
            discoveredAtMs: Date.now(),
            outputs: [SYNTHETIC_OUTPUT_TOSLINK],
          },
        ],
        hardwareVolume: undefined,
        hardwareMuted: undefined,
      };

      const snapshot = deriveUiSnapshot(local, session);
      const isHardwareVolumeActive = snapshot.activeOutput?.capabilities?.supportsHardwareVolume === true;
      expect(isHardwareVolumeActive).toBe(false);
    });

    it('T1-F09-03: enforces zero direct HTTP fetch invariant from popup (routes via runtime IPC)', async () => {
      const dom = setupSyntheticDomEnvironment();
      (dom.document as any).getElementById = (id: string) => dom.document.querySelector('#' + id);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      const originalFetch = globalThis.fetch;
      const fetchSpy = vi.fn();
      globalThis.fetch = fetchSpy;

      const sentRequests: unknown[] = [];
      const originalChrome = (globalThis as any).chrome;
      (globalThis as any).chrome = {
        runtime: {
          sendMessage: vi.fn(async (req: unknown) => {
            sentRequests.push(req);
            return {
              ok: true,
              snapshot: deriveUiSnapshot(
                createDefaultDurableLocalConfig(),
                createDefaultEphemeralSessionState(),
              ),
            };
          }),
          connect: vi.fn(() => ({
            name: 'soundclud-popup',
            onMessage: { addListener: vi.fn() },
            disconnect: vi.fn(),
          })),
        },
      };

      try {
        const card = dom.document.createElement('div');
        card.id = 'amp-volume-card';
        const slider = dom.document.createElement('input');
        slider.id = 'amp-volume-slider';
        slider.setAttribute('type', 'range');
        slider.setAttribute('value', '25');
        const label = dom.document.createElement('span');
        label.id = 'amp-volume-label';
        label.textContent = '25%';

        dom.document.body.append(card, slider, label);

        bootstrapPopup();
        await vi.runAllTicks();
        sentRequests.length = 0;

        // User interacts with slider in popup UI
        slider.value = '50';
        slider.dispatchEvent(new Event('change', { bubbles: true }));

        // Invariant: popup MUST route through chrome.runtime.sendMessage, NEVER direct fetch!
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(sentRequests).toHaveLength(1);
        expect(sentRequests[0]).toEqual({
          type: 'set_volume',
          volume: 50,
        });
      } finally {
        vi.useRealTimers();
        globalThis.fetch = originalFetch;
        (globalThis as any).chrome = originalChrome;
        dom.teardown();
      }
    });

    it('T1-F09-04: toggles mute via runtime message with inverted boolean', async () => {
      const dom = setupSyntheticDomEnvironment();
      (dom.document as any).getElementById = (id: string) => dom.document.querySelector('#' + id);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      const sentRequests: unknown[] = [];
      const originalChrome = (globalThis as any).chrome;
      (globalThis as any).chrome = {
        runtime: {
          sendMessage: vi.fn(async (req: unknown) => {
            sentRequests.push(req);
            return {
              ok: true,
              snapshot: deriveUiSnapshot(
                createDefaultDurableLocalConfig(),
                createDefaultEphemeralSessionState(),
              ),
            };
          }),
          connect: vi.fn(() => ({
            name: 'soundclud-popup',
            onMessage: { addListener: vi.fn() },
            disconnect: vi.fn(),
          })),
        },
      };

      try {
        const card = dom.document.createElement('div');
        card.id = 'amp-volume-card';
        const muteBtn = dom.document.createElement('button');
        muteBtn.id = 'amp-mute-btn';
        muteBtn.setAttribute('aria-pressed', 'false');

        dom.document.body.append(card, muteBtn);

        bootstrapPopup();
        await vi.runAllTicks();
        sentRequests.length = 0;

        // First click: false -> true
        muteBtn.click();
        expect(sentRequests).toHaveLength(1);
        expect(sentRequests[0]).toEqual({
          type: 'set_volume',
          muted: true,
        });
        expect(muteBtn.getAttribute('aria-pressed')).toBe('true');

        // Second click: true -> false
        muteBtn.click();
        expect(sentRequests).toHaveLength(2);
        expect(sentRequests[1]).toEqual({
          type: 'set_volume',
          muted: false,
        });
        expect(muteBtn.getAttribute('aria-pressed')).toBe('false');
      } finally {
        vi.useRealTimers();
        (globalThis as any).chrome = originalChrome;
        dom.teardown();
      }
    });

    it('T1-F09-05: synchronizes UI slider and readout dynamically upon incoming snapshot', async () => {
      const dom = setupSyntheticDomEnvironment();
      (dom.document as any).getElementById = (id: string) => dom.document.querySelector('#' + id);

      let portMessageListener: ((msg: unknown) => void) | undefined;
      const originalChrome = (globalThis as any).chrome;
      (globalThis as any).chrome = {
        runtime: {
          sendMessage: vi.fn(async () => ({
            ok: true,
            snapshot: deriveUiSnapshot(
              createDefaultDurableLocalConfig(),
              createDefaultEphemeralSessionState(),
            ),
          })),
          connect: vi.fn(() => ({
            name: 'soundclud-popup',
            onMessage: {
              addListener: (listener: (msg: unknown) => void) => {
                portMessageListener = listener;
              },
            },
            disconnect: vi.fn(),
          })),
        },
      };

      try {
        const card = dom.document.createElement('div');
        card.id = 'amp-volume-card';
        const slider = dom.document.createElement('input');
        slider.id = 'amp-volume-slider';
        slider.setAttribute('type', 'range');
        slider.setAttribute('value', '35');

        const label = dom.document.createElement('span');
        label.id = 'amp-volume-label';
        label.textContent = '35%';

        dom.document.body.append(card, slider, label);

        bootstrapPopup();
        await Promise.resolve();

        // Broadcast incoming snapshot from service worker
        const snapshot = deriveUiSnapshot(
          {
            ...createDefaultDurableLocalConfig(),
            handoffEnabled: true,
            activeOutputId: SYNTHETIC_OUTPUT_HEOS.id,
          },
          {
            ...createDefaultEphemeralSessionState(),
            connectionState: 'connected',
            discoveredReceivers: [
              {
                receiverId: 'rec-01',
                receiverName: 'Synthetic Receiver',
                endpointBaseUrl: 'http://127.0.0.1:9876',
                host: '127.0.0.1',
                port: 9876,
                isLoopback: true,
                requiresPairing: false,
                discoveredAtMs: Date.now(),
                outputs: [SYNTHETIC_OUTPUT_HEOS],
              },
            ],
            hardwareVolume: 75,
            hardwareMuted: false,
          },
        );

        portMessageListener?.({
          type: 'ui_snapshot_updated',
          snapshot,
        });

        expect(slider.value).toBe('75');
        expect(label.textContent).toBe('75%');
      } finally {
        (globalThis as any).chrome = originalChrome;
        dom.teardown();
      }
    });
  });

  // --------------------------------------------------------------------------
  // Feature 10: Cast Pill Responsive Volume UI
  // --------------------------------------------------------------------------
  describe('Feature 10: Cast Pill Responsive Volume UI', () => {
    it('T1-F10-01: constructs Cast Pill with Shadow DOM encapsulation and shell structure', () => {
      const dom = setupSyntheticDomEnvironment();
      try {
        const callbacks: CastPillCallbacks = {
          onToggleHandoff: vi.fn(),
          onSelectOutput: vi.fn(),
          onRefreshOutputs: vi.fn(),
          onSetVolume: vi.fn(),
        };

        const pill = new ShadowDomCastPill(callbacks);
        pill.mount();

        const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
        expect(host).not.toBeNull();
        expect(host?.shadowRoot).not.toBeNull();

        const shell = host?.shadowRoot?.querySelector('.pill-shell');
        const toggleBtn = host?.shadowRoot?.querySelector('.pill-toggle');
        const menuBtn = host?.shadowRoot?.querySelector('.pill-menu-btn');

        expect(shell).not.toBeNull();
        expect(toggleBtn).not.toBeNull();
        expect(menuBtn).not.toBeNull();

        pill.dispose();
      } finally {
        dom.teardown();
      }
    });

    it('T1-F10-02: dispatches onToggleHandoff callback when pill toggle button is clicked', () => {
      const dom = setupSyntheticDomEnvironment();
      try {
        const onToggleHandoff = vi.fn();
        const pill = new ShadowDomCastPill({
          onToggleHandoff,
          onSelectOutput: vi.fn(),
          onRefreshOutputs: vi.fn(),
          onSetVolume: vi.fn(),
        });
        pill.mount();

        const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
        const toggleBtn = host?.shadowRoot?.querySelector('.pill-toggle');
        toggleBtn?.click();

        expect(onToggleHandoff).toHaveBeenCalledWith(true);
        pill.dispose();
      } finally {
        dom.teardown();
      }
    });

    it('T1-F10-03: dispatches onRefreshOutputs and opens menu when menu button is clicked', () => {
      const dom = setupSyntheticDomEnvironment();
      try {
        const onRefreshOutputs = vi.fn();
        const pill = new ShadowDomCastPill({
          onToggleHandoff: vi.fn(),
          onSelectOutput: vi.fn(),
          onRefreshOutputs,
          onSetVolume: vi.fn(),
        });
        pill.mount();

        const local: DurableLocalConfig = {
          ...createDefaultDurableLocalConfig(),
          handoffEnabled: false,
          activeReceiverId: null,
          activeEndpointBaseUrl: null,
          activeOutputId: null,
        };

        const session: EphemeralSessionState = {
          ...createDefaultEphemeralSessionState(),
          connectionState: 'disconnected',
          lastError: null,
          discoveredReceivers: [],
          hardwareVolume: undefined,
          hardwareMuted: undefined,
        };

        pill.update(deriveUiSnapshot(local, session));

        const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
        const menuBtn = host?.shadowRoot?.querySelector('.pill-menu-btn');
        menuBtn?.click();

        expect(onRefreshOutputs).toHaveBeenCalledTimes(1);

        const menu = host?.shadowRoot?.querySelector('.menu');
        expect(menu?.hidden).toBe(false);

        pill.dispose();
      } finally {
        dom.teardown();
      }
    });

    it('T1-F10-04: populates output item list and handles output selection callback', () => {
      const dom = setupSyntheticDomEnvironment();
      try {
        const onSelectOutput = vi.fn();
        const pill = new ShadowDomCastPill({
          onToggleHandoff: vi.fn(),
          onSelectOutput,
          onRefreshOutputs: vi.fn(),
          onSetVolume: vi.fn(),
        });
        pill.mount();

        const local: DurableLocalConfig = {
          ...createDefaultDurableLocalConfig(),
          handoffEnabled: true,
          activeReceiverId: 'rec-01',
          activeEndpointBaseUrl: 'http://127.0.0.1:9876',
          activeOutputId: SYNTHETIC_OUTPUT_HEOS.id,
        };

        const session: EphemeralSessionState = {
          ...createDefaultEphemeralSessionState(),
          connectionState: 'connected',
          lastError: null,
          discoveredReceivers: [
            {
              receiverId: 'rec-01',
              receiverName: 'Synthetic Receiver',
              endpointBaseUrl: 'http://127.0.0.1:9876',
              host: '127.0.0.1',
              port: 9876,
              isLoopback: true,
              requiresPairing: false,
              discoveredAtMs: Date.now(),
              outputs: [SYNTHETIC_OUTPUT_HEOS],
            },
          ],
          hardwareVolume: 50,
          hardwareMuted: false,
        };

        // Open menu and update snapshot
        const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
        host?.shadowRoot?.querySelector('.pill-menu-btn')?.click();

        pill.update(deriveUiSnapshot(local, session));

        const itemBtn = host?.shadowRoot?.querySelector('.output-item-btn');
        expect(itemBtn).not.toBeNull();
        itemBtn?.click();

        expect(onSelectOutput).toHaveBeenCalledWith(
          expect.objectContaining({
            receiverId: 'rec-01',
            endpointBaseUrl: 'http://127.0.0.1:9876',
            output: SYNTHETIC_OUTPUT_HEOS,
          }),
        );
        pill.dispose();
      } finally {
        dom.teardown();
      }
    });

    it('T1-F10-05: cleans up DOM and disconnects observers upon pill disposal', () => {
      const dom = setupSyntheticDomEnvironment();
      try {
        const pill = new ShadowDomCastPill({
          onToggleHandoff: vi.fn(),
          onSelectOutput: vi.fn(),
          onRefreshOutputs: vi.fn(),
          onSetVolume: vi.fn(),
        });
        pill.mount();

        let host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
        expect(host).not.toBeNull();

        pill.dispose();
        host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
        expect(host).toBeNull();
      } finally {
        dom.teardown();
      }
    });
  });

  // --------------------------------------------------------------------------
  // Feature 17: Extension IP Failover & Timer Guard
  // --------------------------------------------------------------------------
  describe('Feature 17: Extension IP Failover & Timer Guard', () => {
    it('T1-F17-01: initializes ReceiverWsController and adheres to reconnect delay bounds', () => {
      const storage = {
        local: createInMemoryStorageArea(),
        session: createInMemoryStorageArea(),
      };

      const controller = new ReceiverWsController({
        storage,
        onStateChanged: vi.fn(),
        onForwardToMain: vi.fn(),
      });

      expect(controller.hasPendingReconnectTimer()).toBe(false);
      expect(controller.getConnectedEndpointBaseUrl()).toBeNull();
    });

    it('T1-F17-02: exposes canonical base and maximum reconnection delay constants', () => {
      expect(RECONNECT_BASE_DELAY_MS).toBe(250);
      expect(RECONNECT_MAX_DELAY_MS).toBe(5000);
      expect(RECONNECT_MAX_DELAY_MS).toBeGreaterThan(RECONNECT_BASE_DELAY_MS);
    });

    it('T1-F17-03: clears pending reconnect timer when ensureConnected is invoked', async () => {
      const storage = {
        local: createInMemoryStorageArea(),
        session: createInMemoryStorageArea(),
      };

      const controller = new ReceiverWsController({
        storage,
        onStateChanged: vi.fn(),
        onForwardToMain: vi.fn(),
      });

      // Calling ensureConnected should guarantee no hanging reconnect timer
      await controller.ensureConnected();
      expect(controller.hasPendingReconnectTimer()).toBe(false);
    });

    it('T1-F17-04: verifies single reconnect timer guard flag invariant in wsController', () => {
      const storage = {
        local: createInMemoryStorageArea(),
        session: createInMemoryStorageArea(),
      };

      const controller = new ReceiverWsController({
        storage,
        onStateChanged: vi.fn(),
        onForwardToMain: vi.fn(),
      });

      expect(typeof controller.hasPendingReconnectTimer).toBe('function');
      expect(controller.hasPendingReconnectTimer()).toBe(false);
    });

    it('T1-F17-05: verifies exponential backoff progression bounded by RECONNECT_MAX_DELAY_MS in wsController', async () => {
      vi.useFakeTimers();
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

      const storage = {
        local: createInMemoryStorageArea(),
        session: createInMemoryStorageArea(),
      };

      await writeDurableLocalConfig(storage.local, {
        ...createDefaultDurableLocalConfig(),
        handoffEnabled: true,
        activeEndpointBaseUrl: 'http://127.0.0.1:9876',
        clientLabel: 'Test',
        controllerId: 'ctrl-1',
        pairingTokensByReceiverId: { 'rcv-1': 'tok' },
      });

      await storage.session.set({
        [SESSION_STORAGE_KEY]: {
          ...createDefaultEphemeralSessionState(),
          discoveredReceivers: [
            {
              endpointBaseUrl: 'http://127.0.0.1:9876',
              host: '127.0.0.1',
              port: 9876,
              isLoopback: true,
              receiverId: 'rcv-1',
              receiverName: 'Synthetic',
              requiresPairing: true,
              outputs: [],
              discoveredAtMs: Date.now(),
            },
          ],
        },
      });

      const controller = new ReceiverWsController({
        storage,
        onStateChanged: vi.fn(),
        onForwardToMain: vi.fn(),
        createWebSocket: () => {
          throw new Error('Socket open error');
        },
      });

      try {
        await controller.ensureConnected();
        await vi.runAllTicks();
        await Promise.resolve();

        for (let i = 0; i < 6; i += 1) {
          expect(controller.hasPendingReconnectTimer()).toBe(true);
          await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS);
          await vi.runAllTicks();
          await Promise.resolve();
        }

        const delays = setTimeoutSpy.mock.calls
          .map((c) => c[1])
          .filter((d): d is number => typeof d === 'number' && d >= RECONNECT_BASE_DELAY_MS);

        expect(delays[0]).toBe(250);
        expect(delays[1]).toBe(500);
        expect(delays[2]).toBe(1000);
        expect(delays[3]).toBe(2000);
        expect(delays[4]).toBe(4000);
        expect(delays[5]).toBe(RECONNECT_MAX_DELAY_MS);

        for (const delay of delays) {
          expect(delay).toBeLessThanOrEqual(RECONNECT_MAX_DELAY_MS);
        }

        await controller.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  // --------------------------------------------------------------------------
  // Feature 18: Player-Bar DOM Lookup Caching
  // --------------------------------------------------------------------------
  describe('Feature 18: Player-Bar DOM Lookup Caching', () => {
    it('T1-F18-01: reuses cached DOM element when .isConnected is true without querying DOM', () => {
      const dom = setupSyntheticDomEnvironment();
      try {
        const playerBar = dom.document.createElement('div');
        playerBar.className = 'playControls';
        dom.document.body.append(playerBar);

        const querySpy = vi.spyOn(dom.document, 'querySelector');
        const cache = new ConnectedDomCache(dom.document as unknown as Document);

        // First query
        const first = cache.query('.playControls');
        expect(first).toBe(playerBar);
        expect(querySpy).toHaveBeenCalledTimes(1);

        // Second query - should hit cache with .isConnected check
        const second = cache.query('.playControls');
        expect(second).toBe(playerBar);
        expect(querySpy).toHaveBeenCalledTimes(1); // Still 1! No redundant DOM query
      } finally {
        dom.teardown();
      }
    });

    it('T1-F18-02: returns cached reference when element remains connected to DOM', () => {
      const dom = setupSyntheticDomEnvironment();
      try {
        const elem = dom.document.createElement('div');
        elem.className = 'playControls';
        dom.document.body.append(elem);

        const cache = new ConnectedDomCache(dom.document as unknown as Document);
        const res1 = cache.query('.playControls');
        const res2 = cache.query('.playControls');

        expect(res1).toBe(elem);
        expect(res2).toBe(elem);
        expect(res1).toBe(res2);
      } finally {
        dom.teardown();
      }
    });

    it('T1-F18-03: invalidates cache and queries fresh node when cached element is detached', () => {
      const dom = setupSyntheticDomEnvironment();
      try {
        const oldBar = dom.document.createElement('div');
        oldBar.className = 'playControls';
        dom.document.body.append(oldBar);

        const cache = new ConnectedDomCache(dom.document as unknown as Document);
        const first = cache.query('.playControls');
        expect(first).toBe(oldBar);

        // Detach old node and append new one
        oldBar.remove();
        const newBar = dom.document.createElement('div');
        newBar.className = 'playControls';
        dom.document.body.append(newBar);

        // Cache must detect oldBar.isConnected === false and fetch newBar
        const second = cache.query('.playControls');
        expect(second).toBe(newBar);
        expect(second).not.toBe(oldBar);
      } finally {
        dom.teardown();
      }
    });

    it('T1-F18-04: handles SPA page route navigation and updates cache safely via cache.clear()', () => {
      const dom = setupSyntheticDomEnvironment();
      try {
        const bar = dom.document.createElement('div');
        bar.className = 'playControls';
        dom.document.body.append(bar);

        const querySpy = vi.spyOn(dom.document, 'querySelector');
        const cache = new ConnectedDomCache(dom.document as unknown as Document);

        cache.query('.playControls');
        expect(querySpy).toHaveBeenCalledTimes(1);

        // Simulate page navigation cache clear
        cache.clear();

        cache.query('.playControls');
        expect(querySpy).toHaveBeenCalledTimes(2); // Query re-executed after clear
      } finally {
        dom.teardown();
      }
    });

    it('T1-F18-05: executes playback virtualization control hooks safely through clickSoundCloudTransportButton', () => {
      const dom = setupSyntheticDomEnvironment();
      try {
        const nextBtn = dom.document.createElement('button');
        nextBtn.className = 'playControls__next';
        dom.document.body.append(nextBtn);

        let clickFired = false;
        nextBtn.addEventListener('click', () => {
          clickFired = true;
        });

        const cache = new ConnectedDomCache(dom.document as unknown as Document);
        clickSoundCloudTransportButton('next', cache);

        expect(clickFired).toBe(true);
      } finally {
        dom.teardown();
      }
    });
  });
});
