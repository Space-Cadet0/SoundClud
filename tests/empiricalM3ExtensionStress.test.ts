import { describe, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION } from '@soundclud/protocol';
import {
  ConnectedDomCache,
  createDefaultDurableLocalConfig,
  createDefaultEphemeralSessionState,
  createInMemoryStorageArea,
  readDurableLocalConfig,
  ReceiverWsController,
  updateDurableLocalConfig,
  updateEphemeralSessionState,
  type MinimalWebSocket,
} from '@soundclud/extension';

describe('Empirical M3 Challenger — wsController.ts mDNS IP Failover & Reconnect Timer Stress', () => {
  it('stresses receiver discovery updates: activeReceiverId discovered at new IP while activeEndpointBaseUrl holds stale IP', async () => {
    const storage = {
      local: createInMemoryStorageArea(),
      session: createInMemoryStorageArea(),
    };

    const STALE_IP_URL = 'http://192.168.1.10:9876';
    const NEW_IP_URL_1 = 'http://192.168.1.88:9876';
    const NEW_IP_URL_2 = 'http://192.168.1.99:9876';
    const RECEIVER_ID = 'denon_pm7000n_hifi';

    // 1. Initial configuration points to stale IP
    await updateDurableLocalConfig(storage.local, () => ({
      ...createDefaultDurableLocalConfig('sc-ext-stress-ctrl'),
      clientLabel: 'M3 Stress Controller',
      handoffEnabled: true,
      activeReceiverId: RECEIVER_ID,
      activeEndpointBaseUrl: STALE_IP_URL,
      pairingTokensByReceiverId: {
        [RECEIVER_ID]: 'valid_pairing_token_hifi',
      },
    }));

    // 2. Discovery publishes multiple receivers; RECEIVER_ID is discovered at NEW_IP_URL_1
    await updateEphemeralSessionState(storage.session, () => ({
      ...createDefaultEphemeralSessionState(),
      discoveredReceivers: [
        {
          receiverId: 'other_receiver_kitchen',
          endpointBaseUrl: 'http://192.168.1.50:9876',
          host: '192.168.1.50',
          port: 9876,
          receiverName: 'Kitchen Amp',
          isLoopback: false,
          requiresPairing: true,
          outputs: [],
          discoveredAtMs: Date.now(),
        },
        {
          receiverId: RECEIVER_ID,
          endpointBaseUrl: NEW_IP_URL_1,
          host: '192.168.1.88',
          port: 9876,
          receiverName: 'Marantz PM7000N',
          isLoopback: false,
          requiresPairing: true,
          outputs: [],
          discoveredAtMs: Date.now(),
        },
      ],
    }));

    const openedUrls: string[] = [];
    const mockWsFactory = (url: string): MinimalWebSocket => {
      openedUrls.push(url);
      const listeners = new Map<string, Array<(event: unknown) => void>>();
      const ws: MinimalWebSocket = {
        readyState: 0,
        send: vi.fn(),
        close: vi.fn(),
        addEventListener: (type, listener) => {
          const list = listeners.get(type) ?? [];
          list.push(listener);
          listeners.set(type, list);
        },
      };

      setTimeout(() => {
        (ws as { readyState: number }).readyState = 1;
        for (const l of listeners.get('open') ?? []) l({});
        for (const l of listeners.get('message') ?? []) {
          l({
            data: JSON.stringify({
              type: 'welcome',
              receiverId: RECEIVER_ID,
              receiverName: 'Marantz PM7000N',
              controllerId: 'sc-ext-stress-ctrl',
              protocolVersion: PROTOCOL_VERSION,
              config: {
                volumeMode: 'bit_perfect',
                opticalIdleKeepalive: true,
                opticalDitherSubaudible: false,
              },
              outputs: [],
              telemetry: {
                protocolVersion: PROTOCOL_VERSION,
                serverSeq: 1,
                phase: 'idle',
                volumeMode: 'bit_perfect',
                fixedGainDb: 0,
                sampleRateHz: 44100,
                bitDepth: 24,
                positionMs: 0,
                durationMs: 0,
                bufferedMs: 0,
                timestampMs: Date.now(),
              },
            }),
          });
        }
      }, 5);
      return ws;
    };

    const controller = new ReceiverWsController({
      storage,
      createWebSocket: mockWsFactory,
      onStateChanged: () => undefined,
      onForwardToMain: () => undefined,
    });

    // 3. Connect: must immediately target NEW_IP_URL_1 (ws://192.168.1.88:9876/api/v1/ws)
    const connected1 = await controller.ensureConnected();
    expect(connected1).toBe(true);
    expect(openedUrls).toEqual(['ws://192.168.1.88:9876/api/v1/ws']);
    expect(controller.getConnectedEndpointBaseUrl()).toBe(NEW_IP_URL_1);

    // Durable config must be healed to NEW_IP_URL_1
    const durable1 = await readDurableLocalConfig(storage.local);
    expect(durable1.activeEndpointBaseUrl).toBe(NEW_IP_URL_1);

    // 4. Now simulate another IP reassignment (DHCP renew to NEW_IP_URL_2) while socket was closed
    await controller.disconnect();
    expect(controller.getConnectedEndpointBaseUrl()).toBeNull();

    await updateEphemeralSessionState(storage.session, (prev) => ({
      ...prev,
      discoveredReceivers: prev.discoveredReceivers.map((r) =>
        r.receiverId === RECEIVER_ID ? { ...r, endpointBaseUrl: NEW_IP_URL_2, host: '192.168.1.99' } : r,
      ),
    }));

    // Reconnect: must immediately target NEW_IP_URL_2
    const connected2 = await controller.ensureConnected();
    expect(connected2).toBe(true);
    expect(openedUrls).toEqual([
      'ws://192.168.1.88:9876/api/v1/ws',
      'ws://192.168.1.99:9876/api/v1/ws',
    ]);
    expect(controller.getConnectedEndpointBaseUrl()).toBe(NEW_IP_URL_2);

    const durable2 = await readDurableLocalConfig(storage.local);
    expect(durable2.activeEndpointBaseUrl).toBe(NEW_IP_URL_2);

    await controller.disconnect();
  });

  it('stress-tests 100 concurrent ensureConnected() calls during active reconnectTimer: eliminates duplicate timers and orphan connections', async () => {
    vi.useFakeTimers();
    try {
      const storage = {
        local: createInMemoryStorageArea(),
        session: createInMemoryStorageArea(),
      };

      await updateDurableLocalConfig(storage.local, () => ({
        ...createDefaultDurableLocalConfig('sc-ext-race-ctrl'),
        clientLabel: 'Race Controller',
        handoffEnabled: true,
        activeReceiverId: 'rcv_race_test',
        activeEndpointBaseUrl: 'http://127.0.0.1:9876',
        pairingTokensByReceiverId: {
          rcv_race_test: 'valid_token_race',
        },
      }));

      const closeCallbacks: Array<() => void> = [];
      let totalSocketsCreated = 0;

      const mockWsFactory = (_url: string): MinimalWebSocket => {
        totalSocketsCreated += 1;
        const listeners = new Map<string, Array<(event: unknown) => void>>();
        const ws: MinimalWebSocket = {
          readyState: 0,
          send: vi.fn(),
          close: vi.fn(),
          addEventListener: (type, listener) => {
            const list = listeners.get(type) ?? [];
            list.push(listener);
            listeners.set(type, list);
          },
        };

        setTimeout(() => {
          (ws as { readyState: number }).readyState = 1;
          closeCallbacks.push(() => {
            for (const l of listeners.get('close') ?? []) l({});
          });
          for (const l of listeners.get('open') ?? []) l({});
          for (const l of listeners.get('message') ?? []) {
            l({
              data: JSON.stringify({
                type: 'welcome',
                receiverId: 'rcv_race_test',
                receiverName: 'Race Test Receiver',
                controllerId: 'sc-ext-race-ctrl',
                protocolVersion: PROTOCOL_VERSION,
                config: {
                  volumeMode: 'bit_perfect',
                  opticalIdleKeepalive: true,
                  opticalDitherSubaudible: false,
                },
                outputs: [],
                telemetry: {
                  protocolVersion: PROTOCOL_VERSION,
                  serverSeq: 1,
                  phase: 'idle',
                  volumeMode: 'bit_perfect',
                  fixedGainDb: 0,
                  sampleRateHz: 44100,
                  bitDepth: 24,
                  positionMs: 0,
                  durationMs: 0,
                  bufferedMs: 0,
                  timestampMs: Date.now(),
                },
              }),
            });
          }
        }, 10);
        return ws;
      };

      const controller = new ReceiverWsController({
        storage,
        createWebSocket: mockWsFactory,
        onStateChanged: () => undefined,
        onForwardToMain: () => undefined,
      });

      // 1. Initial connection
      const initP = controller.ensureConnected();
      await vi.runAllTimersAsync();
      const initOk = await initP;
      expect(initOk).toBe(true);
      expect(totalSocketsCreated).toBe(1);

      // 2. Simulate unexpected socket drop
      const closeLast = closeCallbacks[closeCallbacks.length - 1];
      expect(closeLast).toBeDefined();
      closeLast?.();

      // Drain microtasks for handleUnexpectedClose
      for (let i = 0; i < 25; i++) {
        await Promise.resolve();
      }

      // Assert reconnect timer is scheduled
      expect(controller.hasPendingReconnectTimer()).toBe(true);

      // 3. Blast 100 concurrent ensureConnected() calls while reconnect timer is pending
      const concurrentPromises: Array<Promise<boolean>> = [];
      for (let i = 0; i < 100; i++) {
        concurrentPromises.push(controller.ensureConnected());
      }

      // Invariant: The very first concurrent call MUST cancel the pending timer synchronously!
      expect(controller.hasPendingReconnectTimer()).toBe(false);

      // Resolve all timers and promises
      await vi.runAllTimersAsync();
      const results = await Promise.all(concurrentPromises);

      // Invariant: All 100 concurrent callers resolve true
      expect(results).toHaveLength(100);
      expect(results.every((r) => r === true)).toBe(true);

      // Invariant: Exactly ONE additional socket was created (no duplicate/orphan connections)
      expect(totalSocketsCreated).toBe(2);

      // Invariant: Advancing time by 30 seconds triggers zero additional reconnect attempts
      await vi.advanceTimersByTimeAsync(30_000);
      expect(controller.hasPendingReconnectTimer()).toBe(false);
      expect(totalSocketsCreated).toBe(2);

      await controller.disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it('resists rapid disconnect/reconnect flapping cycles with zero orphan timers', async () => {
    vi.useFakeTimers();
    try {
      const storage = {
        local: createInMemoryStorageArea(),
        session: createInMemoryStorageArea(),
      };

      await updateDurableLocalConfig(storage.local, () => ({
        ...createDefaultDurableLocalConfig('sc-ext-flap-ctrl'),
        clientLabel: 'Flap Controller',
        handoffEnabled: true,
        activeReceiverId: 'rcv_flap',
        activeEndpointBaseUrl: 'http://127.0.0.1:9876',
        pairingTokensByReceiverId: {
          rcv_flap: 'valid_token_flap',
        },
      }));

      let socketsCount = 0;
      const closeListeners: Array<() => void> = [];

      const mockWsFactory = (_url: string): MinimalWebSocket => {
        socketsCount += 1;
        const listeners = new Map<string, Array<(event: unknown) => void>>();
        const ws: MinimalWebSocket = {
          readyState: 0,
          send: vi.fn(),
          close: vi.fn(),
          addEventListener: (type, listener) => {
            const list = listeners.get(type) ?? [];
            list.push(listener);
            listeners.set(type, list);
          },
        };

        setTimeout(() => {
          (ws as { readyState: number }).readyState = 1;
          closeListeners.push(() => {
            for (const l of listeners.get('close') ?? []) l({});
          });
          for (const l of listeners.get('open') ?? []) l({});
          for (const l of listeners.get('message') ?? []) {
            l({
              data: JSON.stringify({
                type: 'welcome',
                receiverId: 'rcv_flap',
                receiverName: 'Flap Test Receiver',
                controllerId: 'sc-ext-flap-ctrl',
                protocolVersion: PROTOCOL_VERSION,
                config: {
                  volumeMode: 'bit_perfect',
                  opticalIdleKeepalive: true,
                  opticalDitherSubaudible: false,
                },
                outputs: [],
                telemetry: {
                  protocolVersion: PROTOCOL_VERSION,
                  serverSeq: 1,
                  phase: 'idle',
                  volumeMode: 'bit_perfect',
                  fixedGainDb: 0,
                  sampleRateHz: 44100,
                  bitDepth: 24,
                  positionMs: 0,
                  durationMs: 0,
                  bufferedMs: 0,
                  timestampMs: Date.now(),
                },
              }),
            });
          }
        }, 5);
        return ws;
      };

      const controller = new ReceiverWsController({
        storage,
        createWebSocket: mockWsFactory,
        onStateChanged: () => undefined,
        onForwardToMain: () => undefined,
      });

      // Execute 10 consecutive drop & concurrent reconnect cycles
      for (let cycle = 1; cycle <= 10; cycle++) {
        const connectP = controller.ensureConnected();
        await vi.runAllTimersAsync();
        expect(await connectP).toBe(true);
        expect(socketsCount).toBe((cycle - 1) * 2 + 1);

        // Simulate sudden drop
        const closeTrigger = closeListeners[closeListeners.length - 1];
        closeTrigger?.();
        for (let i = 0; i < 20; i++) await Promise.resolve();

        expect(controller.hasPendingReconnectTimer()).toBe(true);

        // Launch 5 concurrent ensureConnected calls mid-timer
        const burst = Promise.all([
          controller.ensureConnected(),
          controller.ensureConnected(),
          controller.ensureConnected(),
          controller.ensureConnected(),
          controller.ensureConnected(),
        ]);
        expect(controller.hasPendingReconnectTimer()).toBe(false);

        await vi.runAllTimersAsync();
        const burstRes = await burst;
        expect(burstRes.every((r) => r === true)).toBe(true);
        expect(socketsCount).toBe(cycle * 2);

        // Disconnect cleanly before next cycle
        await controller.disconnect();
      }

      await vi.advanceTimersByTimeAsync(20_000);
      expect(controller.hasPendingReconnectTimer()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Empirical M3 Challenger — entry.ts ConnectedDomCache Benchmark & Eviction Stress', () => {
  it('benchmarks 1,000 consecutive calls: verifies O(1) performance and 0 duplicate querySelector calls', () => {
    let querySelectorCalls = 0;
    const mockAnchor = {
      isConnected: true,
      tagName: 'A',
      getAttribute: (name: string) => (name === 'href' ? '/artist/track-1' : null),
      textContent: 'Track Title 1',
    } as unknown as HTMLAnchorElement;

    const mockDoc: Pick<Document, 'querySelector' | 'querySelectorAll'> = {
      querySelector: (selector: string) => {
        querySelectorCalls += 1;
        if (selector === '.playbackSoundBadge__titleLink') {
          return mockAnchor;
        }
        return null;
      },
      querySelectorAll: () => [] as unknown as NodeListOf<HTMLAnchorElement>,
    };

    const cache = new ConnectedDomCache(mockDoc);

    const startTime = performance.now();
    const ITERATIONS = 1_000;

    for (let i = 0; i < ITERATIONS; i++) {
      const el = cache.query<HTMLAnchorElement>('.playbackSoundBadge__titleLink');
      expect(el).toBe(mockAnchor);
    }
    const elapsedMs = performance.now() - startTime;

    // Invariant: querySelector was called EXACTLY ONCE on the initial cache miss
    expect(querySelectorCalls).toBe(1);

    // Invariant: Cache holds the single entry
    expect(cache.size()).toBe(1);

    // Invariant: 1,000 cached lookups complete well under 10ms (empirical O(1))
    expect(elapsedMs).toBeLessThan(15);
  });

  it('stresses disconnection and element re-mounting: asserts .isConnected === false, verifies cache eviction and re-query', () => {
    let querySelectorCalls = 0;
    let currentElementAttached = true;

    const element1 = {
      isConnected: true,
      id: 'element_gen_1',
      getAttribute: (attr: string) => (attr === 'href' ? '/artist/track-1' : null),
    } as unknown as Element;

    const element2 = {
      isConnected: true,
      id: 'element_gen_2',
      getAttribute: (attr: string) => (attr === 'href' ? '/artist/track-2' : null),
    } as unknown as Element;

    let docReturns: Element | null = element1;

    const mockDoc: Pick<Document, 'querySelector' | 'querySelectorAll'> = {
      querySelector: (selector: string) => {
        querySelectorCalls += 1;
        if (selector === '.playbackSoundBadge__titleLink' && currentElementAttached) {
          return docReturns;
        }
        return null;
      },
      querySelectorAll: () => [] as unknown as NodeListOf<HTMLAnchorElement>,
    };

    const cache = new ConnectedDomCache(mockDoc);

    // Phase 1: Query element 1 -> cache miss
    const r1 = cache.query('.playbackSoundBadge__titleLink');
    expect(r1).toBe(element1);
    expect(querySelectorCalls).toBe(1);
    expect(cache.size()).toBe(1);

    // Phase 2: 50 consecutive queries while connected -> 0 querySelector calls
    for (let i = 0; i < 50; i++) {
      expect(cache.query('.playbackSoundBadge__titleLink')).toBe(element1);
    }
    expect(querySelectorCalls).toBe(1);

    // Phase 3: SPA unmounts element 1
    Object.defineProperty(element1, 'isConnected', { value: false, configurable: true });
    expect(element1.isConnected).toBe(false);

    // Simulate DOM not having replacement yet
    currentElementAttached = false;
    docReturns = null;

    // Query on disconnected node: MUST detect isConnected === false, evict, and call querySelector
    const rDetached = cache.query('.playbackSoundBadge__titleLink');
    expect(rDetached).toBeNull();
    expect(querySelectorCalls).toBe(2);
    expect(cache.size()).toBe(0); // Evicted!

    // Phase 4: SPA re-renders and attaches element 2
    currentElementAttached = true;
    docReturns = element2;

    const r2 = cache.query('.playbackSoundBadge__titleLink');
    expect(r2).toBe(element2);
    expect(querySelectorCalls).toBe(3);
    expect(cache.size()).toBe(1);

    // Phase 5: 500 consecutive queries on element 2 -> 0 additional querySelector calls
    for (let i = 0; i < 500; i++) {
      expect(cache.query('.playbackSoundBadge__titleLink')).toBe(element2);
    }
    expect(querySelectorCalls).toBe(3);
  });

  it('tests multi-key scaling and selective cache eviction across 50 distinct selectors', () => {
    let querySelectorCalls = 0;
    const elements: Array<{ key: string; el: Element & { isConnected: boolean } }> = [];

    for (let i = 0; i < 50; i++) {
      const key = `.selector-item-${String(i)}`;
      const el = {
        isConnected: true,
        id: `node-${String(i)}`,
      } as unknown as Element & { isConnected: boolean };
      elements.push({ key, el });
    }

    const elementMap = new Map(elements.map((item) => [item.key, item.el]));

    const mockDoc: Pick<Document, 'querySelector' | 'querySelectorAll'> = {
      querySelector: (selector: string) => {
        querySelectorCalls += 1;
        const found = elementMap.get(selector);
        return found && found.isConnected ? found : null;
      },
      querySelectorAll: () => [] as unknown as NodeListOf<HTMLAnchorElement>,
    };

    const cache = new ConnectedDomCache(mockDoc);

    // Prime all 50 items
    for (const item of elements) {
      const res = cache.query(item.key);
      expect(res).toBe(item.el);
    }
    expect(querySelectorCalls).toBe(50);
    expect(cache.size()).toBe(50);

    // Query each 20 times (1,000 total queries) -> zero querySelector calls
    for (let round = 0; round < 20; round++) {
      for (const item of elements) {
        expect(cache.query(item.key)).toBe(item.el);
      }
    }
    expect(querySelectorCalls).toBe(50);

    // Invalidate 10 elements (indices 10 to 19)
    for (let i = 10; i < 20; i++) {
      const item = elements[i];
      if (item !== undefined) {
        Object.defineProperty(item.el, 'isConnected', { value: false, configurable: true });
      }
    }

    // Query all 50 items again
    for (let i = 0; i < 50; i++) {
      const item = elements[i];
      if (item === undefined) continue;
      const res = cache.query(item.key);
      if (i >= 10 && i < 20) {
        expect(res).toBeNull();
      } else {
        expect(res).toBe(item.el);
      }
    }

    // Exactly 10 querySelector calls for the 10 evicted elements, other 40 untouched!
    expect(querySelectorCalls).toBe(60);
    expect(cache.size()).toBe(40);
  });
});
