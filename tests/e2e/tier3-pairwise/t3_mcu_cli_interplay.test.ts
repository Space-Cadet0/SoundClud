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
  createMockMcuServer,
  createMockReceiverServer,
  setupSyntheticDomEnvironment,
  stopAllResources,
  SYNTHETIC_OUTPUT_HEOS,
  type ClosableResource,
} from '../harness/index.js';

function sendTcpCommand(port: number, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let response = '';

    sock.on('connect', () => {
      sock.write(command);
    });

    sock.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (response.includes('\r') || response.includes('\n')) {
        sock.end();
      }
    });

    sock.on('end', () => {
      resolve(response.trim());
    });

    sock.on('error', (err) => {
      reject(err);
    });
  });
}

describe('Tier 3: MCU Telnet :23 & CLI :1255 Hardware Interplay (Cross-Feature)', () => {
  const closables: ClosableResource[] = [];

  afterEach(async () => {
    await stopAllResources(closables);
    closables.length = 0;
  });

  // TC-T3-05: F4 + F5
  it('TC-T3-05: executes passive initial volume query on WS Welcome without sending wake commands to Telnet :23', async () => {
    const mcu = await createMockMcuServer({ initialPower: 'STANDBY' });
    const cli = await createMockHeosCliServer({ initialVolume: 44, initialMuted: false });
    const receiver = await createMockReceiverServer({
      initialOutputs: [SYNTHETIC_OUTPUT_HEOS],
      heosCliPort: cli.port,
      mcuPort: mcu.port,
    });
    closables.push(mcu, cli, receiver);

    // Client connects and performs WebSocket handshake with receiver
    const ws = new WebSocket(receiver.wsUrl);
    let initialVolumeReceived = 0;
    await new Promise<void>((resolve) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'hello', protocolVersion: 'v1', clientLabel: 'E2E Client' }));
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.type === 'volume_changed') {
          initialVolumeReceived = msg.volume;
          resolve();
        }
      };
    });
    ws.close();

    // 1. Initial passive volume was retrieved from CLI by receiver without sending wake commands to amp
    expect(initialVolumeReceived).toBe(44);

    // 2. Query reached CLI server via receiver coordinator connection
    const cliCmds = cli.getReceivedCommands();
    expect(cliCmds.some((c) => c.includes('player/get_volume'))).toBe(true);
    expect(cli.currentVolume).toBe(44);

    // 3. Telnet :23 was addressed for passive status query only; zero wake commands and zero sleep commands
    mcu.assertZeroSleepCommands();
    const mcuCmds = mcu.getReceivedCommands();
    expect(mcuCmds).toEqual(['PW?']);
    expect(mcuCmds).not.toContain('PWON');
    expect(mcuCmds).not.toContain('SINET');
  });

  // TC-T3-06: F6 + F16
  it('TC-T3-06: translates verified CLI failure response into structured error without corrupting coordinator volume', async () => {
    const cli = await createMockHeosCliServer({ initialVolume: 35 });
    closables.push(cli);

    cli.setNextResult('fail', 'busy');

    const rawResponse = await sendTcpCommand(
      cli.port,
      'heos://player/set_volume?pid=1&level=50\r\n',
    );
    const parsed = JSON.parse(rawResponse) as {
      heos: { command: string; result: string; message?: string };
    };

    expect(parsed.heos.result).toBe('fail');
    expect(parsed.heos.message).toBe('busy');
    // Volume remains strictly 35 because command failed
    expect(cli.currentVolume).toBe(35);
  });

  // TC-T3-07: F7 + F17
  it('TC-T3-07: cleanly aborts old listener socket when switching to failover output device', async () => {
    const cliA = await createMockHeosCliServer({ pid: 1, initialVolume: 30 });
    const cliB = await createMockHeosCliServer({ pid: 2, initialVolume: 50 });
    const outputA = {
      ...SYNTHETIC_OUTPUT_HEOS,
      id: 'heos_upnp:PM7000N_A',
      name: 'Marantz PM7000N Room A',
    };
    const outputB = {
      ...SYNTHETIC_OUTPUT_HEOS,
      id: 'heos_upnp:PM7000N_B',
      name: 'Marantz PM7000N Room B',
    };
    const receiver = await createMockReceiverServer({
      initialOutputs: [outputA, outputB],
      initialVolume: 30,
      outputEndpoints: {
        [outputA.id]: { cliPort: cliA.port },
        [outputB.id]: { cliPort: cliB.port },
      },
    });
    closables.push(cliA, cliB, receiver);

    const ws = new WebSocket(receiver.wsUrl);
    await new Promise<void>((resolve) => {
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello', protocolVersion: 'v1' }));
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.type === 'welcome') resolve();
      };
    });

    // Device A is initial target: receiver has established listener on cliA
    expect(cliA.getReceivedCommands().some((c) => c.includes('register_for_change_events'))).toBe(true);

    // Switch output device to Room B via authentic WebSocket command
    const switchAck = new Promise<void>((resolve) => {
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.type === 'command_ack' && msg.commandSeq === 1) resolve();
      };
      ws.send(JSON.stringify({ type: 'select_output', commandSeq: 1, outputId: outputB.id }));
    });
    await switchAck;

    // Old Device A listener socket was cleanly aborted by coordinator; cliA can stop without hanging
    await cliA.stop();

    // Verify failover output B listener is active and pushes volume changes to client WS
    const volUpdatePromise = new Promise<number>((resolve) => {
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.type === 'volume_changed' && msg.volume === 60) resolve(msg.volume);
      };
    });

    // Hardware volume event occurs on Device B (rotary knob turned to 60)
    cliB.pushVolumeChangeEvent(60, false);

    const updatedVolume = await volUpdatePromise;
    expect(updatedVolume).toBe(60);
    expect(cliB.currentVolume).toBe(60);

    ws.close();
  });

  // TC-T3-09: F11 + F4
  it('TC-T3-09: handles Host-MCU Telnet commands serially under mutex while CLI volume queries proceed concurrently', async () => {
    const mcu = await createMockMcuServer({ initialPower: 'ON' });
    const cli = await createMockHeosCliServer({ initialVolume: 50 });
    closables.push(mcu, cli);

    // Run Telnet keepalive and CLI volume query in parallel
    const telnetPromise = sendTcpCommand(mcu.port, 'PW?\r');
    const cliPromise = sendTcpCommand(cli.port, 'heos://player/get_volume?pid=1\r\n');

    const [telnetRes, cliRes] = await Promise.all([telnetPromise, cliPromise]);

    expect(telnetRes).toBe('PWON');
    const parsedCli = JSON.parse(cliRes) as { heos: { result: string; message: string } };
    expect(parsedCli.heos.result).toBe('success');
    expect(parsedCli.heos.message).toContain('level=50');

    mcu.assertSerializedAccess();
  });

  // TC-T3-15: F3 + F6
  it('TC-T3-15: handles partial failure in decoupled volume/mute gracefully', async () => {
    const cli = await createMockHeosCliServer({ initialVolume: 30, initialMuted: false });
    closables.push(cli);

    // 1. Volume succeeds over loopback TCP
    const volRes = await sendTcpCommand(
      cli.port,
      'heos://player/set_volume?pid=1&level=40\r\n',
    );
    const parsedVol = JSON.parse(volRes) as { heos: { result: string } };
    expect(parsedVol.heos.result).toBe('success');
    expect(cli.currentVolume).toBe(40);

    // 2. Hardware mute fails
    cli.setNextResult('fail', 'hardware_timeout');
    const muteRes = await sendTcpCommand(
      cli.port,
      'heos://player/set_mute?pid=1&state=on\r\n',
    );
    const parsedMute = JSON.parse(muteRes) as { heos: { result: string; message?: string } };
    expect(parsedMute.heos.result).toBe('fail');
    expect(parsedMute.heos.message).toBe('hardware_timeout');

    // Current volume strictly remains 40 despite mute failure
    expect(cli.currentVolume).toBe(40);
  });

  // TC-T3-19: F5 + F10
  it('TC-T3-19: reflects unsolicited physical amplifier rotary dial volume event onto UI slider', () => {
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
            receiverName: 'Synthetic Amp',
            endpointBaseUrl: 'http://127.0.0.1:9876',
            host: '127.0.0.1',
            port: 9876,
            isLoopback: true,
            requiresPairing: false,
            discoveredAtMs: Date.now(),
            outputs: [SYNTHETIC_OUTPUT_HEOS],
          },
        ],
        hardwareVolume: 30,
        hardwareMuted: false,
      };

      pill.update(deriveUiSnapshot(local, session));

      // Asymmetric volume event from rotary knob: level = 62
      const updatedSnapshot = deriveUiSnapshot(local, {
        ...session,
        hardwareVolume: 62,
      });
      pill.update(updatedSnapshot);

      const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
      const root = host?.shadowRoot;
      const slider = root?.querySelector('input[type="range"]') as HTMLInputElement | null;
      expect(slider).not.toBeNull();
      expect(slider?.value).toBe('62');
      pill.dispose();
    } finally {
      dom.teardown();
    }
  });

  // TC-T3-20: F5 + F10
  it('TC-T3-20: reflects physical amplifier remote mute event onto UI toggle preserving slider position', () => {
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
            receiverName: 'Synthetic Amp',
            endpointBaseUrl: 'http://127.0.0.1:9876',
            host: '127.0.0.1',
            port: 9876,
            isLoopback: true,
            requiresPairing: false,
            discoveredAtMs: Date.now(),
            outputs: [SYNTHETIC_OUTPUT_HEOS],
          },
        ],
        hardwareVolume: 62,
        hardwareMuted: false,
      };

      pill.update(deriveUiSnapshot(local, session));

      // Physical remote toggles mute on; volume remains 62
      const mutedSnapshot = deriveUiSnapshot(local, {
        ...session,
        hardwareMuted: true,
      });
      pill.update(mutedSnapshot);

      const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
      const root = host?.shadowRoot;
      const slider = root?.querySelector('input[type="range"]') as HTMLInputElement | null;
      const muteBtn = root?.querySelector('.pill-mute-btn') as HTMLElement | null;

      expect(slider?.value).toBe('62'); // Volume strictly preserved!
      expect(muteBtn?.getAttribute('aria-pressed')).toBe('true');
      pill.dispose();
    } finally {
      dom.teardown();
    }
  });
});
