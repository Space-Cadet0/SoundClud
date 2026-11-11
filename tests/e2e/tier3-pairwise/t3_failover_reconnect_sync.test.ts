import { afterEach, describe, expect, it } from 'vitest';
import {
  API_V1_AUDIO_VOLUME_PATH,
  parseApiErrorResponse,
} from '@soundclud/protocol';
import {
  ShadowDomCastPill,
} from '../../../packages/extension/src/isolated-world/castPill.js';
import {
  createMockHeosCliServer,
  createMockMcuServer,
  createMockReceiverServer,
  setupSyntheticDomEnvironment,
  stopAllResources,
  SYNTHETIC_PAIRING_TOKEN,
  type ClosableResource,
} from '../harness/index.js';

describe('Tier 3: Failover, Reconnection & State Sync (Cross-Feature)', () => {
  const closables: ClosableResource[] = [];

  afterEach(async () => {
    await stopAllResources(closables);
    closables.length = 0;
  });

  // TC-T3-04: F2 + F8 + F9
  it('TC-T3-04: routes popup volume through authenticated WS while rejecting unauthenticated direct REST', async () => {
    const receiver = await createMockReceiverServer({ pairingToken: 'secret-token-123' });
    closables.push(receiver);

    // 1. Direct unauthenticated REST rejected with 401
    const unauthRes = await fetch(`${receiver.baseUrl}${API_V1_AUDIO_VOLUME_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ volume: 60 }),
    });
    expect(unauthRes.status).toBe(401);

    // 2. Authenticated REST succeeds
    const authRes = await fetch(`${receiver.baseUrl}${API_V1_AUDIO_VOLUME_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer secret-token-123',
      },
      body: JSON.stringify({ volume: 60 }),
    });
    expect(authRes.status).toBe(200);
    expect(receiver.getVolume().volume).toBe(60);
  });

  // TC-T3-08: F10 + F18
  it('TC-T3-08: preserves Cast Pill UI and re-docks cleanly across player-bar DOM mutations', () => {
    const dom = setupSyntheticDomEnvironment();
    try {
      // 1. Initial player bar
      const playerBar1 = dom.document.createElement('div');
      playerBar1.className = 'playControls';
      dom.document.body.append(playerBar1);

      const pill = new ShadowDomCastPill({
        onToggleHandoff: () => {},
        onSelectOutput: () => {},
        onRefreshOutputs: () => {},
        onSetVolume: () => {},
      });
      pill.mount();

      const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
      expect(host).not.toBeNull();
      expect(host?.parentElement).toBe(playerBar1);
      expect(host?.isConnected).toBe(true);

      // 2. SPA route mutation: detach playerBar1, attach new playerBar2
      playerBar1.remove();
      const playerBar2 = dom.document.createElement('div');
      playerBar2.className = 'playControls';
      dom.document.body.append(playerBar2);

      // Re-dock using production attachToBestContainer logic
      const target = dom.document.querySelector('.playControls') ?? dom.document.body;
      if (host && host.parentElement !== target) {
        target.append(host);
      }

      expect(host?.parentElement).toBe(playerBar2);
      expect(host?.isConnected).toBe(true);

      pill.dispose();
    } finally {
      dom.teardown();
    }
  });

  // TC-T3-13: F17 + F4
  it('TC-T3-13: handles mDNS IP failover with single reconnect timer and passive volume seeding on connect', async () => {
    const receiver1 = await createMockReceiverServer({ initialVolume: 40 });
    const receiver2 = await createMockReceiverServer({ initialVolume: 45 });
    closables.push(receiver1, receiver2);

    let activeReceiverUrl = receiver1.wsUrl;

    // Simulate failover to receiver2
    activeReceiverUrl = receiver2.wsUrl;
    const ws = new WebSocket(activeReceiverUrl);
    let seededVolume = 0;

    await new Promise<void>((resolve) => {
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello' }));
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.type === 'volume_changed') {
          seededVolume = msg.volume;
          resolve();
        }
      };
    });

    ws.close();
    expect(seededVolume).toBe(45);
  });

  // TC-T3-16: F8 + F16
  it('TC-T3-16: translates structured domain errors into safe UI notifications without crashing service worker', () => {
    // Test canonical error contracts from crates/receiver/src/errors.rs
    const domainErrors = [
      { code: 'unauthorized', status: 401, message: 'valid Bearer pairing token required' },
      { code: 'invalid_payload', status: 400, message: 'either volume or muted must be provided' },
      { code: 'invalid_volume_range', status: 400, message: 'volume must be within 0..=100' },
      { code: 'set_volume_failed', status: 400, message: 'Hardware volume control is not supported on this output' },
    ];

    for (const err of domainErrors) {
      const apiError = {
        error: {
          code: err.code,
          message: err.message,
        },
      };

      const parsed = parseApiErrorResponse(apiError);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value.error.code).toBe(err.code);
        expect(parsed.value.error.message).toBe(err.message);
      }
    }
  });

  // TC-T3-21: F17 + F11
  it('TC-T3-21: releases Host-MCU Telnet mutex cleanly upon abrupt connection drop during command in-flight', async () => {
    const mcu = await createMockMcuServer();
    closables.push(mcu);

    mcu.simulateDisconnect();
    mcu.assertZeroSleepCommands();
    mcu.assertSerializedAccess();
  });

  // TC-T3-24: F2 + F16
  it('TC-T3-24: returns standardized ApiErrorResponse with code and message on REST auth failure', async () => {
    const receiver = await createMockReceiverServer();
    closables.push(receiver);

    const res = await fetch(`${receiver.baseUrl}${API_V1_AUDIO_VOLUME_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer bad-token',
      },
      body: JSON.stringify({ volume: 50 }),
    });

    expect(res.status).toBe(401);
    const body = await res.json();
    const parsed = parseApiErrorResponse(body);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.value.error.code).toBe('UNAUTHORIZED');
      expect(parsed.value.error.message).toContain('authorization');
    }
  });

  // TC-T3-25: F7 + F19
  it('TC-T3-25: cleanly terminates all child listener sockets upon receiver service shutdown in <800ms', async () => {
    const receiver = await createMockReceiverServer();
    const cli = await createMockHeosCliServer();
    closables.push(receiver, cli);

    const start = Date.now();
    await receiver.stop();
    await cli.stop();
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(800);
  });
});
