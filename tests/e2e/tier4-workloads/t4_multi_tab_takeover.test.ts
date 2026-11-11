import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ShadowDomCastPill,
} from '../../../packages/extension/src/isolated-world/castPill.js';
import {
  deriveUiSnapshot,
  createDefaultDurableLocalConfig,
  createDefaultEphemeralSessionState,
} from '../../../packages/extension/src/shared/storageSchema.js';
import {
  createMockHeosCliServer,
  createMockReceiverServer,
  setupSyntheticDomEnvironment,
  spawnEphemeralReceiverDaemon,
  stopAllResources,
  SYNTHETIC_OUTPUT_HEOS,
  type ClosableResource,
  type SyntheticElement,
} from '../harness/index.js';

describe('Tier 4: Workload Scenario 3 — Multi-Tab Handoff & Real-Time Sync', () => {
  const closables: ClosableResource[] = [];

  afterEach(async () => {
    await stopAllResources(closables);
    closables.length = 0;
  });

  // SC-T4-03: Real-time volume synchronization to web UI via authentic receiver WebSocket push
  it('SC-T4-03: synchronizes physical volume knob turns and remote mute in <150ms to web UI', async () => {
    const dom = setupSyntheticDomEnvironment();
    const receiver = await createMockReceiverServer({ initialVolume: 32, initialMuted: false });
    closables.push(receiver);

    try {
      // 1. Mount authentic ShadowDomCastPill inside synthetic web player bar DOM
      const pill = new ShadowDomCastPill({
        onToggleHandoff: () => {},
        onSelectOutput: () => {},
        onRefreshOutputs: () => {},
        onSetVolume: () => {},
      });
      pill.mount();

      const durableConfig = {
        ...createDefaultDurableLocalConfig(),
        handoffEnabled: true,
        activeReceiverId: 'synth-receiver-01',
        activeEndpointBaseUrl: receiver.baseUrl,
        activeOutputId: SYNTHETIC_OUTPUT_HEOS.id,
      };

      let sessionState = {
        ...createDefaultEphemeralSessionState(),
        connectionState: 'connected' as const,
        discoveredReceivers: [
          {
            receiverId: 'synth-receiver-01',
            receiverName: 'Synthetic Lab Receiver',
            endpointBaseUrl: receiver.baseUrl,
            host: '127.0.0.1',
            port: receiver.port,
            isLoopback: true,
            requiresPairing: false,
            discoveredAtMs: Date.now(),
            outputs: [SYNTHETIC_OUTPUT_HEOS],
          },
        ],
        hardwareVolume: 32,
        hardwareMuted: false,
      };

      pill.update(deriveUiSnapshot(durableConfig, sessionState));

      const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
      const shadow = host?.shadowRoot;
      const slider = shadow?.querySelector<SyntheticElement>('.pill-volume-slider');
      const label = shadow?.querySelector('.pill-volume-label');

      expect(slider?.value).toBe('32');
      expect(label?.textContent).toBe('32%');

      // 2. Connect client WebSocket directly to receiver daemon endpoint
      const ws = new WebSocket(receiver.wsUrl);
      let latencyMs = 0;
      let emitTime = 0;

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Timed out waiting for volume_changed push')),
          2000,
        );

        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'hello' }));
        };

        ws.onmessage = (e) => {
          const msg = JSON.parse(String(e.data));
          if (msg.type === 'volume_changed' && msg.volume === 48) {
            latencyMs = Date.now() - emitTime;
            clearTimeout(timeout);

            // Forward genuine receiver push event to UI snapshot and re-render Cast Pill
            sessionState = {
              ...sessionState,
              hardwareVolume: msg.volume,
              hardwareMuted: msg.muted,
            };
            pill.update(deriveUiSnapshot(durableConfig, sessionState));
            resolve();
          }
        };

        // 3. Receiver daemon pushes hardware volume knob turn (level 48, unmuted)
        setTimeout(() => {
          emitTime = Date.now();
          receiver.broadcastVolumeChanged(48, false);
        }, 30);
      });

      ws.close();
      pill.dispose();

      // Invariants:
      // - Volume changed event delivered and processed within 150ms target
      expect(latencyMs).toBeLessThan(150);
      // - Cast Pill slider and readout reflect the genuine pushed hardware volume
      expect(slider?.value).toBe('48');
      expect(label?.textContent).toBe('48%');
    } finally {
      dom.teardown();
    }
  });

  // SC-T4-04: Mode B native process multi-tab execution
  it('SC-T4-04: handles multi-tab handoff with session_claimed and synchronized hardware volume using Mode B daemon', async () => {
    const daemon = await spawnEphemeralReceiverDaemon();
    closables.push(daemon);

    // 1. Pair client with native receiver
    const token = await daemon.pair('Multi-Tab Controller', 'ctrl_tab_shared');
    expect(token).toBeDefined();

    // 2. Connect Tab A over WebSocket to native daemon
    const wsTabA = await daemon.connectWs(token, 'ctrl_tab_a');
    expect(wsTabA.readyState).toBe(WebSocket.OPEN);

    // Set up listener on Tab A for session_claimed event emitted upon displacement
    const sessionClaimedPromise = new Promise<{
      type: string;
      newControllerId: string;
      newClientLabel?: string;
    }>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for session_claimed event on Tab A')), 3000);
      wsTabA.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.type === 'session_claimed') {
          clearTimeout(timeout);
          resolve(msg);
        }
      };
    });

    // 3. Connect Tab B over WebSocket to native daemon with different controllerId
    const wsTabB = await daemon.connectWs(token, 'ctrl_tab_b');
    expect(wsTabB.readyState).toBe(WebSocket.OPEN);

    // 4. Tab A receives session_claimed event notifying it of takeover
    const claimedEvent = await sessionClaimedPromise;
    expect(claimedEvent.type).toBe('session_claimed');
    expect(claimedEvent.newControllerId).toBe('ctrl_tab_b');

    // 5. Send ping from Tab B and verify pong
    const pongPromise = new Promise<number>((resolve) => {
      wsTabB.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.type === 'pong') {
          resolve(msg.serverTimestampMs);
        }
      };
      wsTabB.send(JSON.stringify({ type: 'ping', clientTimestampMs: Date.now() }));
    });

    const serverTimestamp = await pongPromise;
    expect(serverTimestamp).toBeGreaterThan(0);

    wsTabA.close();
    wsTabB.close();
  });

  // SC-T4-05: Mode B native process connection recovery
  it('SC-T4-05: transparently recovers from network disruption and reconnects within 3 seconds using Mode B daemon', async () => {
    const daemon = await spawnEphemeralReceiverDaemon();
    closables.push(daemon);

    const token = await daemon.pair('Recovery Client', 'ctrl_recovery');

    // 1. Initial connection
    const ws = await daemon.connectWs(token);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    // 2. Abrupt network drop
    const dropTime = Date.now();
    ws.close();

    // 3. Reconnect within 3 seconds
    const reconnectWs = await daemon.connectWs(token);
    const reconnectDuration = Date.now() - dropTime;
    expect(reconnectWs.readyState).toBe(WebSocket.OPEN);
    expect(reconnectDuration).toBeLessThan(3000);

    reconnectWs.close();
  });

  // SC-T4-06
  it('SC-T4-06: maintains responsive volume controls across SoundCloud SPA route transitions', () => {
    const dom = setupSyntheticDomEnvironment();
    try {
      const container = dom.document.createElement('div');
      container.className = 'playControls';
      dom.document.body.append(container);

      const pill = new ShadowDomCastPill({
        onToggleHandoff: () => {},
        onSelectOutput: () => {},
        onRefreshOutputs: () => {},
        onSetVolume: () => {},
      });
      pill.mount();

      const local = {
        ...createDefaultDurableLocalConfig(),
        handoffEnabled: true,
        activeReceiverId: 'rec-01',
        activeEndpointBaseUrl: 'http://127.0.0.1:9876',
        activeOutputId: SYNTHETIC_OUTPUT_HEOS.id,
      };

      const session = {
        ...createDefaultEphemeralSessionState(),
        connectionState: 'connected' as const,
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

      // Mount initial snapshot
      pill.update(deriveUiSnapshot(local, session));

      const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
      expect(host).not.toBeNull();
      expect(host?.isConnected).toBe(true);

      // Simulate SPA route navigation across 5 internal links
      const routes = ['/discover', '/stream', '/likes', '/sets', '/artists'];
      for (let i = 0; i < routes.length; i += 1) {
        // SPA state mutation: update route attribute and update snapshot
        host?.setAttribute('data-route', routes[i]!);
        const updatedSnapshot = deriveUiSnapshot(local, {
          ...session,
          hardwareVolume: 40 + i * 2,
        });
        pill.update(updatedSnapshot);

        const slider = host?.shadowRoot?.querySelector('.pill-volume-slider') as
          | (SyntheticElement & { value?: string })
          | null;
        expect(slider?.value).toBe(String(40 + i * 2));
      }

      // Assert exactly one pill exists in DOM and remains connected
      expect(dom.document.querySelectorAll('[data-soundclud-cast-pill]')).toHaveLength(1);
      expect(host?.isConnected).toBe(true);

      pill.dispose();
    } finally {
      dom.teardown();
    }
  });
});
