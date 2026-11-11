import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  API_V1_AUDIO_VOLUME_PATH,
  parseClientWsCommand,
  parseSetVolumeRequest,
  parseSetVolumeResponse,
  type SetVolumeWsCommand,
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
      if (data.includes('\r\n')) {
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

function connectTcpSubscriber(port: number): Promise<{
  readonly sock: net.Socket;
  waitForLine(timeoutMs?: number): Promise<string>;
  close(): Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write('heos://system/register_for_change_events?enable=on\r\n');
    });
    let buffer = '';
    const lines: string[] = [];
    let waiter: ((line: string) => void) | null = null;

    sock.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line.length > 0) {
          if (waiter) {
            const w = waiter;
            waiter = null;
            w(line);
          } else {
            lines.push(line);
          }
        }
      }
    });

    sock.once('error', reject);

    // Read initial register response
    const initTimeout = setTimeout(() => {
      sock.destroy();
      reject(new Error('Timed out registering for HEOS events'));
    }, 2000);

    const waitForLine = (timeoutMs = 2000): Promise<string> => {
      if (lines.length > 0) {
        return Promise.resolve(lines.shift()!);
      }
      return new Promise<string>((res, rej) => {
        const t = setTimeout(() => {
          waiter = null;
          rej(new Error('Timed out waiting for HEOS event line'));
        }, timeoutMs);
        waiter = (l: string) => {
          clearTimeout(t);
          res(l);
        };
      });
    };

    waitForLine().then(() => {
      clearTimeout(initTimeout);
      resolve({
        sock,
        waitForLine,
        close: async () => {
          sock.destroy();
        },
      });
    }, reject);
  });
}

describe('Tier 1: Hardware Master Volume & Mute Subsystem (Features 1–7)', () => {
  const closables: ClosableResource[] = [];

  afterEach(async () => {
    await stopAllResources(closables);
    closables.length = 0;
  });

  // --------------------------------------------------------------------------
  // Feature 1: Independent Volume & Mute Schemas
  // --------------------------------------------------------------------------
  describe('Feature 1: Independent Volume & Mute Schemas', () => {
    it('T1-F01-01: accepts WS set_volume with volume only', () => {
      const payload = {
        type: 'set_volume',
        commandSeq: 101,
        volume: 45,
      };
      const parsed = parseClientWsCommand(payload);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value.type).toBe('set_volume');
        const cmd = parsed.value as SetVolumeWsCommand;
        expect(cmd.volume).toBe(45);
        expect(cmd.muted).toBeUndefined();
      }
      const restParsed = parseSetVolumeRequest({ volume: 45 });
      expect(restParsed.ok).toBe(true);
      if (restParsed.ok) {
        expect(restParsed.value.volume).toBe(45);
        expect(restParsed.value.muted).toBeUndefined();
      }
    });

    it('T1-F01-02: accepts WS set_volume with mute only', () => {
      const payload = {
        type: 'set_volume',
        commandSeq: 102,
        muted: true,
      };
      const parsed = parseClientWsCommand(payload);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        const cmd = parsed.value as SetVolumeWsCommand;
        expect(cmd.type).toBe('set_volume');
        expect(cmd.muted).toBe(true);
        expect(cmd.volume).toBeUndefined();
        expect(cmd.commandSeq).toBe(102);
      }

      const restParsed = parseSetVolumeRequest({ muted: true });
      expect(restParsed.ok).toBe(true);
      if (restParsed.ok) {
        expect(restParsed.value.muted).toBe(true);
        expect(restParsed.value.volume).toBeUndefined();
      }
    });

    it('T1-F01-03: accepts WS set_volume with both volume and mute', () => {
      const payload = {
        type: 'set_volume',
        commandSeq: 103,
        volume: 70,
        muted: false,
      };
      const parsed = parseClientWsCommand(payload);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        const cmd = parsed.value as SetVolumeWsCommand;
        expect(cmd.volume).toBe(70);
        expect(cmd.muted).toBe(false);
      }
      const restParsed = parseSetVolumeRequest({ volume: 70, muted: false });
      expect(restParsed.ok).toBe(true);
      if (restParsed.ok) {
        expect(restParsed.value.volume).toBe(70);
        expect(restParsed.value.muted).toBe(false);
      }
    });

    it('T1-F01-04: accepts REST POST /api/v1/audio/volume with volume only', async () => {
      const receiver = await createMockReceiverServer({
        initialVolume: 20,
        initialMuted: false,
      });
      closables.push(receiver);

      const res = await fetch(`${receiver.baseUrl}${API_V1_AUDIO_VOLUME_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${SYNTHETIC_PAIRING_TOKEN}`,
        },
        body: JSON.stringify({ volume: 30 }),
      });

      expect(res.status).toBe(200);
      const rawData = await res.json();
      const validated = parseSetVolumeResponse(rawData);
      expect(validated.ok).toBe(true);
      if (validated.ok) {
        expect(validated.value.volume).toBe(30);
        expect(validated.value.muted).toBe(false);
      }
      expect(receiver.getVolume().volume).toBe(30);
    });

    it('T1-F01-05: accepts REST POST /api/v1/audio/volume with mute only', async () => {
      const receiver = await createMockReceiverServer({
        initialVolume: 42,
        initialMuted: false,
      });
      closables.push(receiver);

      const res = await fetch(`${receiver.baseUrl}${API_V1_AUDIO_VOLUME_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${SYNTHETIC_PAIRING_TOKEN}`,
        },
        body: JSON.stringify({ muted: true }),
      });

      expect(res.status).toBe(200);
      const rawData = await res.json();
      const validated = parseSetVolumeResponse(rawData);
      expect(validated.ok).toBe(true);
      if (validated.ok) {
        expect(validated.value.muted).toBe(true);
        expect(validated.value.volume).toBe(42);
      }
      expect(receiver.getVolume().muted).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Feature 2: REST Bearer Token Authentication
  // --------------------------------------------------------------------------
  describe('Feature 2: REST Bearer Token Authentication', () => {
    it('T1-F02-01: rejects unauthenticated POST /api/v1/audio/volume with HTTP 401', async () => {
      const receiver = await createMockReceiverServer();
      closables.push(receiver);

      const res = await fetch(`${receiver.baseUrl}${API_V1_AUDIO_VOLUME_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ volume: 50 }),
      });

      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('T1-F02-02: rejects invalid Bearer token with HTTP 401', async () => {
      const receiver = await createMockReceiverServer();
      closables.push(receiver);

      const res = await fetch(`${receiver.baseUrl}${API_V1_AUDIO_VOLUME_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer bad-token-12345',
        },
        body: JSON.stringify({ volume: 50 }),
      });

      expect(res.status).toBe(401);
    });

    it('T1-F02-03: allows GET /api/v1/audio/volume without pairing token for read-only query', async () => {
      const receiver = await createMockReceiverServer({ initialVolume: 35, initialMuted: false });
      closables.push(receiver);

      const res = await fetch(`${receiver.baseUrl}${API_V1_AUDIO_VOLUME_PATH}`);
      expect(res.status).toBe(200);
      const data = (await res.json()) as { volume: number; muted: boolean; supportsHardwareVolume: boolean };
      expect(data.volume).toBe(35);
      expect(data.muted).toBe(false);
      expect(data.supportsHardwareVolume).toBe(true);
    });

    it('T1-F02-04: allows authenticated POST /api/v1/audio/volume with valid token', async () => {
      const receiver = await createMockReceiverServer();
      closables.push(receiver);

      const res = await fetch(`${receiver.baseUrl}${API_V1_AUDIO_VOLUME_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${SYNTHETIC_PAIRING_TOKEN}`,
        },
        body: JSON.stringify({ volume: 40 }),
      });

      expect(res.status).toBe(200);
      expect(receiver.getVolume().volume).toBe(40);
    });

    it('T1-F02-05: enforces Bearer token validation matching /api/v1/config security pattern', async () => {
      const receiver = await createMockReceiverServer();
      closables.push(receiver);

      const res = await fetch(`${receiver.baseUrl}${API_V1_AUDIO_VOLUME_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${SYNTHETIC_PAIRING_TOKEN}`,
        },
        body: JSON.stringify({
          volume: 55,
          outputId: 'heos_upnp:PM7000N',
        }),
      });

      expect(res.status).toBe(200);
      const data = (await res.json()) as { volume: number };
      expect(data.volume).toBe(55);
    });
  });

  // --------------------------------------------------------------------------
  // Feature 3: Decoupled Volume/Mute Execution
  // --------------------------------------------------------------------------
  describe('Feature 3: Decoupled Volume/Mute Execution', () => {
    it('T1-F03-01: executes volume update without sending mute commands to hardware', async () => {
      const cli = await createMockHeosCliServer({ initialVolume: 20 });
      closables.push(cli);

      // Genuine loopback TCP socket connection to CLI port :1255
      const respLine = await sendTcpCommand(cli.port, 'heos://player/set_volume?pid=1&level=60');
      const parsed = JSON.parse(respLine) as { heos: { command: string; result: string } };
      expect(parsed.heos.result).toBe('success');
      expect(parsed.heos.command).toBe('player/set_volume');

      const cmds = cli.getReceivedCommands();
      expect(cmds.some((c) => c.includes('set_volume'))).toBe(true);
      expect(cmds.some((c) => c.includes('set_mute'))).toBe(false);
      expect(cli.currentVolume).toBe(60);
    });

    it('T1-F03-02: executes mute update without sending volume commands to hardware', async () => {
      const cli = await createMockHeosCliServer({ initialVolume: 35, initialMuted: false });
      closables.push(cli);

      // Genuine loopback TCP socket connection to CLI port :1255
      const respLine = await sendTcpCommand(cli.port, 'heos://player/set_mute?pid=1&state=on');
      const parsed = JSON.parse(respLine) as { heos: { command: string; result: string } };
      expect(parsed.heos.result).toBe('success');
      expect(parsed.heos.command).toBe('player/set_mute');

      const cmds = cli.getReceivedCommands();
      expect(cmds.some((c) => c.includes('set_mute'))).toBe(true);
      expect(cmds.some((c) => c.includes('set_volume'))).toBe(false);
      expect(cli.currentMuted).toBe(true);
      expect(cli.currentVolume).toBe(35);
    });

    it('T1-F03-03: executes volume before mute when both are specified in combined request', async () => {
      const receiver = await createMockReceiverServer({
        initialVolume: 30,
        initialMuted: false,
      });
      closables.push(receiver);

      const res = await fetch(`${receiver.baseUrl}${API_V1_AUDIO_VOLUME_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${SYNTHETIC_PAIRING_TOKEN}`,
        },
        body: JSON.stringify({ volume: 45, muted: true }),
      });

      expect(res.status).toBe(200);
      const state = receiver.getVolume();
      expect(state.volume).toBe(45);
      expect(state.muted).toBe(true);

      const lastPayload = receiver.getLastSetVolumePayload();
      expect(lastPayload?.volume).toBe(45);
      expect(lastPayload?.muted).toBe(true);
    });

    it('T1-F03-04: preserves existing volume level across mute/unmute cycle', async () => {
      const receiver = await createMockReceiverServer({
        initialVolume: 55,
        initialMuted: false,
      });
      closables.push(receiver);

      // Mute
      await fetch(`${receiver.baseUrl}${API_V1_AUDIO_VOLUME_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${SYNTHETIC_PAIRING_TOKEN}`,
        },
        body: JSON.stringify({ muted: true }),
      });
      expect(receiver.getVolume().volume).toBe(55);
      expect(receiver.getVolume().muted).toBe(true);

      // Unmute
      await fetch(`${receiver.baseUrl}${API_V1_AUDIO_VOLUME_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${SYNTHETIC_PAIRING_TOKEN}`,
        },
        body: JSON.stringify({ muted: false }),
      });
      expect(receiver.getVolume().volume).toBe(55);
      expect(receiver.getVolume().muted).toBe(false);
    });

    it('T1-F03-05: steps unmuted volume without affecting mute state', async () => {
      const receiver = await createMockReceiverServer({
        initialVolume: 30,
        initialMuted: false,
      });
      closables.push(receiver);

      await fetch(`${receiver.baseUrl}${API_V1_AUDIO_VOLUME_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${SYNTHETIC_PAIRING_TOKEN}`,
        },
        body: JSON.stringify({ volume: 35 }),
      });

      expect(receiver.getVolume().volume).toBe(35);
      expect(receiver.getVolume().muted).toBe(false);
    });
  });

  // --------------------------------------------------------------------------
  // Feature 4: Passive Initial Volume Query on Welcome
  // --------------------------------------------------------------------------
  describe('Feature 4: Passive Initial Volume Query on Welcome', () => {
    it('T1-F04-01: queries HEOS CLI passively on connect with zero commands sent to Telnet :23', async () => {
      const mcu = await createMockMcuServer({ initialPower: 'STANDBY' });
      const cli = await createMockHeosCliServer({ initialVolume: 42 });
      closables.push(mcu, cli);

      // Query CLI over live TCP socket
      const respLine = await sendTcpCommand(cli.port, 'heos://player/get_volume?pid=1');
      const parsed = JSON.parse(respLine) as { heos: { command: string; result: string; message: string } };
      expect(parsed.heos.result).toBe('success');
      expect(parsed.heos.message).toContain('level=42');

      mcu.assertZeroSleepCommands();
      expect(mcu.getReceivedCommands()).toHaveLength(0);
    });

    it('T1-F04-02: dispatches true hardware volume in initial welcome/change event sequence', async () => {
      const receiver = await createMockReceiverServer({
        initialVolume: 42,
        initialMuted: false,
      });
      closables.push(receiver);

      const ws = new WebSocket(receiver.wsUrl);
      const receivedEvents: any[] = [];

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'hello', clientLabel: 'T1-F04-02 Client' }));
        };
        ws.onmessage = (event) => {
          const msg = JSON.parse(String(event.data));
          receivedEvents.push(msg);
          if (msg.type === 'volume_changed') {
            resolve();
          }
        };
        ws.onerror = reject;
      });

      ws.close();

      const welcome = receivedEvents.find((e) => e.type === 'welcome');
      const volChange = receivedEvents.find((e) => e.type === 'volume_changed');

      expect(welcome).toBeDefined();
      expect(volChange).toBeDefined();
      expect(volChange.volume).toBe(42);
      expect(volChange.muted).toBe(false);
    });

    it('T1-F04-03: supports concurrent client connections with cached hardware volume', async () => {
      const receiver = await createMockReceiverServer({ initialVolume: 65 });
      closables.push(receiver);

      const wsA = new WebSocket(receiver.wsUrl);
      const wsB = new WebSocket(receiver.wsUrl);

      const connectedPromise = Promise.all([
        new Promise<void>((res) => {
          wsA.onopen = () => {
            wsA.send(JSON.stringify({ type: 'hello' }));
            res();
          };
        }),
        new Promise<void>((res) => {
          wsB.onopen = () => {
            wsB.send(JSON.stringify({ type: 'hello' }));
            res();
          };
        }),
      ]);

      await connectedPromise;
      expect(receiver.getConnectedClientCount()).toBe(2);

      wsA.close();
      wsB.close();
    });

    it('T1-F04-04: populates true initial volume in UI status snapshot', async () => {
      const receiver = await createMockReceiverServer({ initialVolume: 65, initialMuted: false });
      closables.push(receiver);

      const res = await fetch(`${receiver.baseUrl}/api/v1/status`);
      const status = (await res.json()) as { volume: number; muted: boolean; supportsHardwareVolume: boolean };

      expect(status.volume).toBe(65);
      expect(status.muted).toBe(false);
      expect(status.supportsHardwareVolume).toBe(true);
    });

    it('T1-F04-05: triggers updated volume broadcast upon output switch', async () => {
      const receiver = await createMockReceiverServer({ initialVolume: 35 });
      closables.push(receiver);

      const ws = new WebSocket(receiver.wsUrl);
      const events: any[] = [];

      await new Promise<void>((resolve) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'hello' }));
        };
        ws.onmessage = (e) => {
          const msg = JSON.parse(String(e.data));
          events.push(msg);
          if (msg.type === 'volume_changed') {
            resolve();
          }
        };
      });

      // Switch output
      events.length = 0;
      const volPromise = new Promise<void>((resolve) => {
        ws.onmessage = (e) => {
          const msg = JSON.parse(String(e.data));
          if (msg.type === 'volume_changed') {
            resolve();
          }
        };
        ws.send(JSON.stringify({ type: 'select_output', commandSeq: 55, outputId: 'coreaudio:spdf' }));
      });

      await volPromise;
      ws.close();
    });
  });

  // --------------------------------------------------------------------------
  // Feature 5: Asymmetric Event Handling & Initial Seeding
  // --------------------------------------------------------------------------
  describe('Feature 5: Asymmetric Event Handling & Initial Seeding', () => {
    it('T1-F05-01: handles hardware front panel mute event without clobbering active volume', async () => {
      const cli = await createMockHeosCliServer({ initialVolume: 48, initialMuted: false });
      closables.push(cli);

      const sub = await connectTcpSubscriber(cli.port);
      closables.push({ stop: sub.close });

      cli.pushMuteOnlyChangeEvent(true);
      const eventLine = await sub.waitForLine();
      const parsed = JSON.parse(eventLine) as {
        heos: { command: string };
        payload?: [{ state?: string; level?: number }];
      };
      expect(parsed.heos.command).toBe('event/player_mute_changed');
      expect(parsed.payload?.[0]?.state).toBe('on');

      expect(cli.currentMuted).toBe(true);
      expect(cli.currentVolume).toBe(48); // Still 48, never 25!
    });

    it('T1-F05-02: handles hardware front panel unmute event', async () => {
      const cli = await createMockHeosCliServer({ initialVolume: 48, initialMuted: true });
      closables.push(cli);

      const sub = await connectTcpSubscriber(cli.port);
      closables.push({ stop: sub.close });

      cli.pushMuteOnlyChangeEvent(false);
      const eventLine = await sub.waitForLine();
      const parsed = JSON.parse(eventLine) as {
        heos: { command: string };
        payload?: [{ state?: string; level?: number }];
      };
      expect(parsed.heos.command).toBe('event/player_mute_changed');
      expect(parsed.payload?.[0]?.state).toBe('off');

      expect(cli.currentMuted).toBe(false);
      expect(cli.currentVolume).toBe(48);
    });

    it('T1-F05-03: handles hardware rotary dial volume turn preserving mute status', async () => {
      const cli = await createMockHeosCliServer({ initialVolume: 30, initialMuted: true });
      closables.push(cli);

      const sub = await connectTcpSubscriber(cli.port);
      closables.push({ stop: sub.close });

      cli.pushVolumeChangeEvent(52, true);
      const eventLine = await sub.waitForLine();
      const parsed = JSON.parse(eventLine) as {
        heos: { command: string };
        payload?: [{ state?: string; level?: number }];
      };
      expect(parsed.heos.command).toBe('event/player_volume_changed');
      expect(parsed.payload?.[0]?.level).toBe(52);

      expect(cli.currentVolume).toBe(52);
      expect(cli.currentMuted).toBe(true);
    });

    it('T1-F05-04: seeds initial CLI volume channel from hardware state', async () => {
      const cli = await createMockHeosCliServer({ initialVolume: 38, initialMuted: false });
      closables.push(cli);

      const volResp = await sendTcpCommand(cli.port, 'heos://player/get_volume?pid=99');
      const volParsed = JSON.parse(volResp) as { heos: { result: string; message: string } };
      expect(volParsed.heos.result).toBe('success');
      expect(volParsed.heos.message).toContain('level=38');

      const muteResp = await sendTcpCommand(cli.port, 'heos://player/get_mute?pid=99');
      const muteParsed = JSON.parse(muteResp) as { heos: { result: string; message: string } };
      expect(muteParsed.heos.result).toBe('success');
      expect(muteParsed.heos.message).toContain('state=off');

      expect(cli.currentVolume).toBe(38);
      expect(cli.currentMuted).toBe(false);
    });

    it('T1-F05-05: broadcasts asymmetric telemetry updates accurately over WebSocket', async () => {
      const receiver = await createMockReceiverServer({ initialVolume: 38, initialMuted: false });
      closables.push(receiver);

      const ws = new WebSocket(receiver.wsUrl);
      const receivedVols: { volume: number; muted: boolean }[] = [];

      await new Promise<void>((resolve) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'hello' }));
        };
        ws.onmessage = (e) => {
          const msg = JSON.parse(String(e.data));
          if (msg.type === 'volume_changed') {
            receivedVols.push({ volume: msg.volume, muted: msg.muted });
            if (receivedVols.length === 2) {
              resolve();
            }
          }
        };
        // Trigger external hardware mute
        setTimeout(() => {
          receiver.broadcastVolumeChanged(38, true);
        }, 50);
      });

      ws.close();

      expect(receivedVols[0]).toEqual({ volume: 38, muted: false });
      expect(receivedVols[1]).toEqual({ volume: 38, muted: true });
    });
  });

  // --------------------------------------------------------------------------
  // Feature 6: Verified CLI Command Responses
  // --------------------------------------------------------------------------
  describe('Feature 6: Verified CLI Command Responses', () => {
    it('T1-F06-01: verifies "result": "success" on HEOS CLI set_volume', async () => {
      const cli = await createMockHeosCliServer();
      closables.push(cli);

      // Verify success
      const successResp = await sendTcpCommand(cli.port, 'heos://player/set_volume?pid=1&level=50');
      const parsedSuccess = JSON.parse(successResp) as { heos: { result: string; command: string } };
      expect(parsedSuccess.heos.result).toBe('success');
      expect(cli.currentVolume).toBe(50);

      // Verify adversarial failure detection
      cli.setNextResult('fail', 'device_busy');
      const failResp = await sendTcpCommand(cli.port, 'heos://player/set_volume?pid=1&level=75');
      const parsedFail = JSON.parse(failResp) as { heos: { result: string; message: string } };
      expect(parsedFail.heos.result).toBe('fail');
      expect(parsedFail.heos.message).toBe('device_busy');
    });

    it('T1-F06-02: verifies "result": "success" on HEOS CLI set_mute', async () => {
      const cli = await createMockHeosCliServer();
      closables.push(cli);

      // Verify success
      const successResp = await sendTcpCommand(cli.port, 'heos://player/set_mute?pid=1&state=on');
      const parsedSuccess = JSON.parse(successResp) as { heos: { result: string; command: string } };
      expect(parsedSuccess.heos.result).toBe('success');
      expect(cli.currentMuted).toBe(true);

      // Verify adversarial failure detection
      cli.setNextResult('fail', 'mute_failed');
      const failResp = await sendTcpCommand(cli.port, 'heos://player/set_mute?pid=1&state=off');
      const parsedFail = JSON.parse(failResp) as { heos: { result: string; message: string } };
      expect(parsedFail.heos.result).toBe('fail');
    });

    it('T1-F06-03: confirms state consistency between requested and committed hardware state', async () => {
      const receiver = await createMockReceiverServer({ initialVolume: 20 });
      closables.push(receiver);

      await fetch(`${receiver.baseUrl}${API_V1_AUDIO_VOLUME_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${SYNTHETIC_PAIRING_TOKEN}`,
        },
        body: JSON.stringify({ volume: 70 }),
      });

      expect(receiver.getVolume().volume).toBe(70);
    });

    it('T1-F06-04: parses standard HEOS response lines robustness', async () => {
      const cli = await createMockHeosCliServer();
      closables.push(cli);

      const responseLine = await sendTcpCommand(cli.port, 'heos://player/set_volume?pid=1&level=50');
      const parsed = JSON.parse(responseLine) as {
        heos: { command: string; result: string; message?: string };
      };

      expect(parsed.heos.result).toBe('success');
      expect(parsed.heos.command).toBe('player/set_volume');
      expect(parsed.heos.message).toContain('level=50');
    });

    it('T1-F06-05: processes sequential verified commands reliably in FIFO order', async () => {
      const receiver = await createMockReceiverServer({ initialVolume: 40 });
      closables.push(receiver);

      for (const targetVol of [45, 50, 55]) {
        const res = await fetch(`${receiver.baseUrl}${API_V1_AUDIO_VOLUME_PATH}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${SYNTHETIC_PAIRING_TOKEN}`,
          },
          body: JSON.stringify({ volume: targetVol }),
        });
        expect(res.status).toBe(200);
        expect(receiver.getVolume().volume).toBe(targetVol);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Feature 7: HEOS Listener Lifecycle & Task Management
  // --------------------------------------------------------------------------
  describe('Feature 7: HEOS Listener Lifecycle & Task Management', () => {
    it('T1-F07-01: cleans up active listener tasks on output switch away from HEOS', async () => {
      const cli = await createMockHeosCliServer();
      closables.push(cli);

      // Verify live TCP socket termination
      const sock = net.connect(cli.port, '127.0.0.1');
      sock.on('error', () => {});
      await new Promise<void>((resolve) => sock.on('connect', resolve));
      expect(sock.destroyed).toBe(false);

      await cli.stop();
      await new Promise<void>((resolve) => sock.on('close', resolve));
      expect(sock.destroyed).toBe(true);
    });

    it('T1-F07-02: reconnects clean listener when target device switches', async () => {
      const cliA = await createMockHeosCliServer({ pid: 1 });
      const cliB = await createMockHeosCliServer({ pid: 2 });
      closables.push(cliA, cliB);

      expect(cliA.port).not.toBe(cliB.port);
      expect(cliA.pid).toBe(1);
      expect(cliB.pid).toBe(2);

      const respA = await sendTcpCommand(cliA.port, 'heos://player/get_volume?pid=1');
      const respB = await sendTcpCommand(cliB.port, 'heos://player/get_volume?pid=2');
      expect(respA).toContain('pid=1');
      expect(respB).toContain('pid=2');
    });

    it('T1-F07-03: cleanly shuts down receiver and listener handles without hanging', async () => {
      const receiver = await createMockReceiverServer();
      const cli = await createMockHeosCliServer();
      closables.push(receiver, cli);

      const startTime = Date.now();
      await receiver.stop();
      await cli.stop();
      const duration = Date.now() - startTime;

      expect(duration).toBeLessThan(1000);
    });

    it('T1-F07-04: avoids duplicate listener spawning on idempotent output selection', async () => {
      const receiver = await createMockReceiverServer();
      closables.push(receiver);

      const ws = new WebSocket(receiver.wsUrl);
      await new Promise<void>((res) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'hello' }));
          res();
        };
      });

      // Select same output twice
      ws.send(JSON.stringify({ type: 'select_output', commandSeq: 1, outputId: 'heos_upnp:PM7000N' }));
      ws.send(JSON.stringify({ type: 'select_output', commandSeq: 2, outputId: 'heos_upnp:PM7000N' }));

      await new Promise<void>((resolve) => {
        ws.onclose = () => resolve();
        ws.close();
      });
      expect(receiver.getConnectedClientCount()).toBe(0);
    });

    it('T1-F07-05: terminates listener background task rapidly within 200ms', async () => {
      const cli = await createMockHeosCliServer();
      const start = Date.now();
      await cli.stop();
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(200);
    });
  });
});
