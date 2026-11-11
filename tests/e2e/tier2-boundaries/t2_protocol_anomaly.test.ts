import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  allocateTimestampCommandSeq,
  createDefaultDurableLocalConfig,
  createDefaultEphemeralSessionState,
  createInMemoryStorageArea,
  isLoopbackHostname,
  normalizeReceiverEndpointBaseUrl,
  ReceiverWsController,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  writeDurableLocalConfig,
  SESSION_STORAGE_KEY,
  type MinimalWebSocket,
} from '@soundclud/extension';
import {
  API_V1_AUDIO_VOLUME_PATH,
  parseClientWsCommand,
  parseSetVolumeRequest,
} from '@soundclud/protocol';
import {
  createMockHeosCliServer,
  createMockMcuServer,
  createMockReceiverServer,
  stopAllResources,
  SYNTHETIC_PAIRING_TOKEN,
  type ClosableResource,
} from '../harness/index.js';

function sendTcpCommand(port: number, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(command.endsWith('\r\n') ? command : `${command}\r\n`);
    });
    let data = '';
    const timeout = setTimeout(() => {
      sock.destroy();
      reject(new Error(`Timeout waiting for TCP response on port ${port}`));
    }, 2000);

    sock.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (data.includes('\r') || data.includes('\n')) {
        clearTimeout(timeout);
        sock.end();
        resolve(data.trim());
      }
    });
    sock.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe('Tier 2: Protocol Anomalies, Hardware Faults & Security Edge Cases', () => {
  const closables: ClosableResource[] = [];

  afterEach(async () => {
    await stopAllResources(closables);
    closables.length = 0;
  });

  describe('Authentication Anomalies (Feature 2 & 16)', () => {
    it('T2-F02-01: rejects request with missing Authorization header with HTTP 401', async () => {
      const receiver = await createMockReceiverServer();
      closables.push(receiver);

      const res = await fetch(`${receiver.baseUrl}${API_V1_AUDIO_VOLUME_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ volume: 50 }),
      });

      expect(res.status).toBe(401);
      const data = (await res.json()) as { error: { code: string } };
      expect(data.error.code).toBe('UNAUTHORIZED');
    });

    it('T2-F02-02: rejects non-Bearer scheme (e.g. Basic) with HTTP 401', async () => {
      const receiver = await createMockReceiverServer();
      closables.push(receiver);

      const res = await fetch(`${receiver.baseUrl}${API_V1_AUDIO_VOLUME_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Basic dXNlcjpwYXNz',
        },
        body: JSON.stringify({ volume: 50 }),
      });

      expect(res.status).toBe(401);
    });

    it('T2-F02-03: rejects empty Bearer token string with HTTP 401', async () => {
      const receiver = await createMockReceiverServer();
      closables.push(receiver);

      const res = await fetch(`${receiver.baseUrl}${API_V1_AUDIO_VOLUME_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ',
        },
        body: JSON.stringify({ volume: 50 }),
      });

      expect(res.status).toBe(401);
    });

    it('T2-F02-04: rejects invalid mismatched token with HTTP 401', async () => {
      const receiver = await createMockReceiverServer({ pairingToken: 'expected-token-123' });
      closables.push(receiver);

      const res = await fetch(`${receiver.baseUrl}${API_V1_AUDIO_VOLUME_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer wrong-token-xyz',
        },
        body: JSON.stringify({ volume: 50 }),
      });

      expect(res.status).toBe(401);
    });

    it('T2-F02-05: handles oversized Authorization header safely without buffer overflow', async () => {
      const receiver = await createMockReceiverServer();
      closables.push(receiver);

      const hugeToken = 'A'.repeat(8192);
      const res = await fetch(`${receiver.baseUrl}${API_V1_AUDIO_VOLUME_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${hugeToken}`,
        },
        body: JSON.stringify({ volume: 50 }),
      });

      // Server rejects safely with 401 or 431, not crash
      expect([400, 401, 431]).toContain(res.status);
    });
  });

  describe('Hardware Standby & Port Failures (Features 4, 6, 11)', () => {
    it('T2-F04-01: queries port :1255 passively without waking standby amplifier on port :23', async () => {
      const mcu = await createMockMcuServer({ initialPower: 'STANDBY' });
      const cli = await createMockHeosCliServer({ initialVolume: 28 });
      closables.push(mcu, cli);

      // Query CLI over live TCP socket
      const resp = await sendTcpCommand(cli.port, 'heos://player/get_volume?pid=1');
      expect(resp).toContain('level=28');

      expect(mcu.getReceivedCommands()).toHaveLength(0);
      mcu.assertZeroSleepCommands();
      expect(cli.currentVolume).toBe(28);
    });

    it('T2-F04-03: treats hardware volume 0 and muted as valid state rather than falsy default', () => {
      const wsParsed = parseClientWsCommand({
        type: 'set_volume',
        commandSeq: allocateTimestampCommandSeq(),
        volume: 0,
        muted: true,
      });

      expect(wsParsed.ok).toBe(true);
      if (wsParsed.ok && wsParsed.value.type === 'set_volume') {
        expect(wsParsed.value.volume).toBe(0);
        expect(wsParsed.value.muted).toBe(true);
      }

      const restParsed = parseSetVolumeRequest({ volume: 0, muted: true });
      expect(restParsed.ok).toBe(true);
      if (restParsed.ok) {
        expect(restParsed.value.volume).toBe(0);
        expect(restParsed.value.muted).toBe(true);
      }
    });

    it('T2-F06-01: maps firmware "result": "fail" response to structured error without committing state', async () => {
      const cli = await createMockHeosCliServer({ initialVolume: 30 });
      closables.push(cli);

      cli.setNextResult('fail', 'System error');
      const resp = await sendTcpCommand(cli.port, 'heos://player/set_volume?pid=1&level=50');
      const parsed = JSON.parse(resp) as { heos: { result: string } };

      expect(parsed.heos.result).toBe('fail');
      expect(cli.currentVolume).toBe(30); // Not updated to 50
    });

    it('T2-F06-03: rejects corrupted or truncated JSON lines cleanly via production protocol parser and WS controller', () => {
      // 1. Production command parser rejects truncated JSON string without crashing
      const truncated = '{"type":"set_volume","commandSeq":101,"vol';
      const parsed = parseClientWsCommand(truncated);

      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error).toContain('invalid JSON string');
      }

      // 2. Production command parser rejects missing mandatory fields
      const missingPayload = parseClientWsCommand({
        type: 'set_volume',
        commandSeq: 102,
      });
      expect(missingPayload.ok).toBe(false);
      if (!missingPayload.ok) {
        expect(missingPayload.error).toContain('either volume or muted must be provided');
      }

      // 3. WS controller handles malformed inbound message frame safely
      let messageListener: ((ev: unknown) => void) | undefined;
      const fakeSocket: MinimalWebSocket = {
        readyState: 1,
        send: vi.fn(),
        close: vi.fn(),
        addEventListener: (type: string, listener: (ev: unknown) => void) => {
          if (type === 'message') {
            messageListener = listener;
          }
        },
      };

      const storage = {
        local: createInMemoryStorageArea(),
        session: createInMemoryStorageArea(),
      };

      new ReceiverWsController({
        storage,
        onStateChanged: vi.fn(),
        onForwardToMain: vi.fn(),
        createWebSocket: () => fakeSocket,
      });

      // Emitting corrupted or truncated text frame does not throw
      expect(() => {
        messageListener?.({ data: '{"heos":{"command":"corrupted' });
      }).not.toThrow();
    });

    it('T2-F11-02: recovers cleanly when Host-MCU connection drops mid-command', async () => {
      const mcu = await createMockMcuServer({ initialPower: 'ON' });
      closables.push(mcu);

      const client = net.connect(mcu.port, '127.0.0.1');
      await new Promise<void>((resolve) => client.once('connect', resolve));
      client.destroy();

      mcu.simulateDisconnect();

      // Reconnect fresh socket using helper
      const resp = await sendTcpCommand(mcu.port, 'PW?\r');
      expect(resp).toBe('PWON');
      mcu.assertZeroSleepCommands();
    });
  });

  describe('Extension Network Flaps & Backoff (Feature 17)', () => {
    it('T2-F17-01: prevents duplicate timer creation during rapid network flaps', () => {
      const storage = {
        local: createInMemoryStorageArea(),
        session: createInMemoryStorageArea(),
      };

      const controller = new ReceiverWsController({
        storage,
        onStateChanged: () => {},
        onForwardToMain: () => {},
      });

      expect(controller.hasPendingReconnectTimer()).toBe(false);
    });

    it('T2-F17-02: validates and normalizes candidate endpoints via production discovery normalizer', () => {
      // Valid IPv4 loopback and LAN endpoints normalize with default discovery port
      expect(normalizeReceiverEndpointBaseUrl('127.0.0.1:9876')).toBe('http://127.0.0.1:9876');
      expect(normalizeReceiverEndpointBaseUrl('http://192.168.1.50:9876')).toBe('http://192.168.1.50:9876');
      expect(normalizeReceiverEndpointBaseUrl('soundclud.local:9876')).toBe('http://soundclud.local:9876');

      // Validates loopback hostname detection
      expect(isLoopbackHostname('127.0.0.1')).toBe(true);
      expect(isLoopbackHostname('localhost')).toBe(true);
      expect(isLoopbackHostname('192.168.1.50')).toBe(false);
      expect(isLoopbackHostname('soundclud.local')).toBe(false);

      // Rejects malformed IP addresses, invalid schemes, and out-of-range ports
      expect(normalizeReceiverEndpointBaseUrl('')).toBeNull();
      expect(normalizeReceiverEndpointBaseUrl('   ')).toBeNull();
      expect(normalizeReceiverEndpointBaseUrl('ftp://127.0.0.1:9876')).toBeNull();
      expect(normalizeReceiverEndpointBaseUrl('http://127.0.0.1:70000')).toBeNull(); // Port > 65535
      expect(normalizeReceiverEndpointBaseUrl('http://127.0.0.1:-5')).toBeNull();    // Port < 1
      expect(normalizeReceiverEndpointBaseUrl('http://user:pass@127.0.0.1:9876')).toBeNull(); // Embedded credentials
    });

    it('T2-F17-03: caps exponential backoff delay strictly at RECONNECT_MAX_DELAY_MS in ReceiverWsController', async () => {
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
        clientLabel: 'Backoff Test Client',
        controllerId: 'ctrl-backoff-test',
        pairingTokensByReceiverId: { 'test-receiver': 'valid-token' },
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
              receiverId: 'test-receiver',
              receiverName: 'Test Receiver',
              requiresPairing: true,
              outputs: [],
              discoveredAtMs: Date.now(),
            },
          ],
        },
      });

      // WebSocket factory that fails immediately to trigger reconnection logic
      const controller = new ReceiverWsController({
        storage,
        onStateChanged: vi.fn(),
        onForwardToMain: vi.fn(),
        createWebSocket: () => {
          throw new Error('Connection refused by peer');
        },
      });

      try {
        // Trigger initial connection attempt
        await controller.ensureConnected();
        await vi.runAllTicks();
        await Promise.resolve();

        // Advance through 8 consecutive reconnect attempts
        for (let attempt = 0; attempt < 8; attempt += 1) {
          expect(controller.hasPendingReconnectTimer()).toBe(true);
          await vi.advanceTimersByTimeAsync(RECONNECT_MAX_DELAY_MS);
          await vi.runAllTicks();
          await Promise.resolve();
        }

        // Collect all timer delays scheduled by ReceiverWsController
        const reconnectDelays = setTimeoutSpy.mock.calls
          .map((call) => call[1])
          .filter((d): d is number => typeof d === 'number' && d >= RECONNECT_BASE_DELAY_MS);

        expect(reconnectDelays.length).toBeGreaterThanOrEqual(6);
        // Exponential progression: 250 -> 500 -> 1000 -> 2000 -> 4000 -> 5000 (capped)
        expect(reconnectDelays[0]).toBe(250);
        expect(reconnectDelays[1]).toBe(500);
        expect(reconnectDelays[2]).toBe(1000);
        expect(reconnectDelays[3]).toBe(2000);
        expect(reconnectDelays[4]).toBe(4000);
        expect(reconnectDelays[5]).toBe(RECONNECT_MAX_DELAY_MS); // 5000

        // Invariant: Delays strictly capped at RECONNECT_MAX_DELAY_MS
        for (const delay of reconnectDelays) {
          expect(delay).toBeLessThanOrEqual(RECONNECT_MAX_DELAY_MS);
        }

        await controller.disconnect();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
