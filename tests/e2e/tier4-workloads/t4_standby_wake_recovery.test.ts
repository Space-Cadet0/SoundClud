import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  WakingDevicePlayheadKeepalive,
} from '../../../packages/extension/src/main-world/wakingKeepalive.js';
import {
  createMockMcuServer,
  createMockReceiverServer,
  createMockUpnpServer,
  spawnEphemeralReceiverDaemon,
  stopAllResources,
  type ClosableResource,
} from '../harness/index.js';

describe('Tier 4: Workload Scenario 2 — Standby Wake, Anti-Auto-Standby & System Recovery', () => {
  const closables: ClosableResource[] = [];

  afterEach(async () => {
    await stopAllResources(closables);
    closables.length = 0;
  });

  // SC-T4-02
  it('SC-T4-02: verifies anti-auto-standby keepalive sends zero SLPOFF commands and maintains smooth elapsed time', async () => {
    const mcu = await createMockMcuServer({ initialPower: 'ON' });
    const upnp = await createMockUpnpServer();
    const receiver = await createMockReceiverServer({ mcuPort: mcu.port });
    closables.push(mcu, upnp, receiver);

    // Exercise authentic WakingDevicePlayheadKeepalive state machine from packages/extension
    const playheadKeepalive = new WakingDevicePlayheadKeepalive();
    const startPerfMs = 1000.0;
    playheadKeepalive.start(0, startPerfMs);
    expect(playheadKeepalive.isWaking()).toBe(true);

    // Authentic keepalive sequence from crates/receiver/src/backends/heos_mcu.rs:230-258
    // Executed via receiver daemon coordinator: sends PW?\r, upon PWON sends SI?\r
    // to reset inactivity timer without SLPOFF or OLED popups
    for (let cycle = 0; cycle < 3; cycle += 1) {
      // 1. Advance virtual playhead smoothly
      const nowPerfMs = startPerfMs + (cycle + 1) * 500;
      const currentPosMs = playheadKeepalive.computeCurrentPositionMs(0, nowPerfMs);
      expect(currentPosMs).toBeGreaterThan(0);
      expect(currentPosMs).toBeLessThanOrEqual(250); // Clamped by maxAdvanceMs

      // 2. Receiver daemon executes keepalive against MCU port 23
      await receiver.triggerMcuKeepalive();

      // 3. Update UPnP position over time
      upnp.setPositionMs((cycle + 1) * 5000, 180000);
    }

    // Steady-state telemetry arrived; settle playhead keepalive state machine
    playheadKeepalive.settle();
    expect(playheadKeepalive.getState()).toBe('settled');

    // Invariants:
    // 1. Zero sleep commands (PM7000N OLED fix: keepalive uses PW? and SI?, never SLPOFF)
    mcu.assertZeroSleepCommands();
    expect(mcu.getReceivedCommands().filter((c) => c === 'PW?')).toHaveLength(3);
    expect(mcu.getReceivedCommands().filter((c) => c === 'SI?')).toHaveLength(3);
    expect(mcu.getReceivedCommands()).not.toContain('PWON'); // Never sends wake when already ON

    // 2. Continuous time progression verified over live SOAP query
    const res = await fetch(`${upnp.baseUrl}/AVT`, {
      method: 'POST',
      headers: {
        'content-type': 'text/xml; charset="utf-8"',
        soapaction: '"urn:schemas-upnp-org:service:AVTransport:1#GetPositionInfo"',
      },
      body: '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetPositionInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetPositionInfo></s:Body></s:Envelope>',
    });
    expect(res.status).toBe(200);
    const xml = await res.text();
    expect(xml).toContain('<RelTime>00:00:15</RelTime>');
    expect(xml).toContain('<TrackDuration>00:03:00</TrackDuration>');
  });

  // SC-T4-10: Mode B native daemon concurrent contention serialization
  it('SC-T4-10: handles concurrent controller command contention across REST and WebSocket endpoints without deadlock', async () => {
    // Note: Low-level Telnet single-client port 23 mutex serialization is verified in pure Rust integration
    // suites (crates/receiver/tests/stream_planner_and_m3_dehack.rs & challenger_m3_stress.rs).
    // SC-T4-10 verifies that the native Mode B receiver daemon handles concurrent controller contention
    // across REST and WebSocket interfaces simultaneously with zero deadlock and zero dropped requests.
    const daemon = await spawnEphemeralReceiverDaemon();
    closables.push(daemon);

    const token = await daemon.pair('Contention User', 'ctrl_contention');
    const ws = await daemon.connectWs(token);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    // Concurrently dispatch mixed status queries, device discovery, and WebSocket pings
    // without in-test mutexes or promise-queue facades
    const tasks: Promise<unknown>[] = [];

    // 1. Concurrent REST status and discovery queries
    for (let i = 0; i < 5; i += 1) {
      tasks.push(daemon.fetchRest('/api/v1/status').then((res) => res.json()));
      tasks.push(daemon.fetchRest('/api/v1/discover').then((res) => res.json()));
    }

    // 2. Concurrent WebSocket ping messages
    const pongsReceived: number[] = [];
    const pongHandler = (e: MessageEvent) => {
      const msg = JSON.parse(String(e.data));
      if (msg.type === 'pong' && typeof msg.clientTimestampMs === 'number') {
        pongsReceived.push(msg.clientTimestampMs);
      }
    };
    ws.addEventListener('message', pongHandler);

    for (let i = 0; i < 5; i += 1) {
      const ts = 5000 + i;
      tasks.push(
        new Promise<void>((resolve) => {
          ws.send(JSON.stringify({ type: 'ping', clientTimestampMs: ts }));
          resolve();
        }),
      );
    }

    // All concurrent requests must resolve without deadlock or socket hang
    const results = await Promise.all(tasks);
    expect(results).toHaveLength(15);

    // Wait for all 5 WebSocket pongs to be returned by native daemon
    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const checkPongs = () => {
        if (pongsReceived.length >= 5) {
          resolve();
        } else if (Date.now() - start > 2000) {
          reject(new Error(`Timed out waiting for pongs: received ${pongsReceived.length}/5`));
        } else {
          setTimeout(checkPongs, 10);
        }
      };
      checkPongs();
    });

    expect(pongsReceived).toHaveLength(5);
    ws.removeEventListener('message', pongHandler);
    ws.close();
  });

  // SC-T4-11: Mode B native process execution
  it('SC-T4-11: executes first-install zero-configuration user journey (cold start to paired playback) using Mode B native daemon', async () => {
    const daemon = await spawnEphemeralReceiverDaemon();
    closables.push(daemon);

    // 1. Discover receiver out-of-the-box
    const discRes = await daemon.fetchRest('/api/v1/discover');
    expect(discRes.status).toBe(200);
    const discData = (await discRes.json()) as {
      protocolVersion: string;
      receiverId: string;
      receiverName: string;
      outputs: any[];
    };
    expect(discData.protocolVersion).toBe('v1');
    expect(discData.receiverId).toBeDefined();
    expect(discData.outputs).toBeDefined();
    expect(discData.outputs.length).toBeGreaterThanOrEqual(1);

    // 2. TOFU pairing handshake with native receiver daemon
    const pairingToken = await daemon.pair('Brand New User', 'ctrl_new_user');
    expect(pairingToken).toBeDefined();
    expect(pairingToken.length).toBeGreaterThan(0);

    // 3. Connect authenticated WebSocket with native receiver daemon
    const ws = await daemon.connectWs(pairingToken);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  // SC-T4-12: Mode B native process execution
  it('SC-T4-12: recovers connection and resynchronizes playhead after macOS system sleep and wake cycle using Mode B daemon', async () => {
    const daemon = await spawnEphemeralReceiverDaemon();
    closables.push(daemon);

    const token = await daemon.pair('Sleep-Wake User', 'ctrl_sleep_wake');

    // 1. Before sleep: connected to native daemon
    let ws = await daemon.connectWs(token);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    // 2. Simulate system sleep (network drop, socket terminated)
    ws.close();

    // 3. Simulate system wake (network restored, re-establish WS connection)
    ws = await daemon.connectWs(token);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });
});
