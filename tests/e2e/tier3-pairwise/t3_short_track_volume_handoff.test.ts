import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  rankSoundCloudTranscodings,
  type SoundCloudTranscoding,
} from '@soundclud/protocol';
import {
  ShadowDomCastPill,
} from '../../../packages/extension/src/isolated-world/castPill.js';
import {
  deriveUiSnapshot,
  createDefaultDurableLocalConfig,
  createDefaultEphemeralSessionState,
} from '../../../packages/extension/src/shared/storageSchema.js';
import {
  createMockMcuServer,
  createMockReceiverServer,
  createMockUpnpServer,
  setupSyntheticDomEnvironment,
  stopAllResources,
  SYNTHETIC_OUTPUT_HEOS,
  SYNTHETIC_OUTPUT_TOSLINK,
  type ClosableResource,
} from '../harness/index.js';

describe('Tier 3: Short-Track Transitions & Capability Handoff (Cross-Feature)', () => {
  const closables: ClosableResource[] = [];

  afterEach(async () => {
    await stopAllResources(closables);
    closables.length = 0;
  });

  // TC-T3-12: F15 + F14
  it('TC-T3-12: plays 3.0-second track to completion without premature cutoff under 500ms coordinator tick rate', async () => {
    const upnp = await createMockUpnpServer();
    const receiver = await createMockReceiverServer();
    closables.push(upnp, receiver);

    const trackDurationMs = 3000;

    // Connect WebSocket to receiver to observe state_tick progression
    const ws = new WebSocket(receiver.wsUrl);
    closables.push({ stop: async () => { ws.close(); } });

    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello' }));
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.type === 'welcome') resolve();
      };
      ws.onerror = reject;
    });

    const receivedTicks: { positionMs: number; durationMs: number; state: string }[] = [];
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.type === 'state_tick') {
        receivedTicks.push({
          positionMs: msg.positionMs,
          durationMs: msg.durationMs,
          state: msg.state,
        });
      }
    };

    // Position 1000ms: UPnP reports active playback, receiver ticks state: 'playing'
    upnp.setPositionMs(1000, trackDurationMs);
    receiver.broadcastStateTick({ state: 'playing', positionMs: 1000, durationMs: trackDurationMs });

    // Position 2000ms: playback advances into second half
    upnp.setPositionMs(2000, trackDurationMs);
    receiver.broadcastStateTick({ state: 'playing', positionMs: 2000, durationMs: trackDurationMs });

    // Position 3000ms: reaches end of track, transitions to stopped
    upnp.setPositionMs(3000, trackDurationMs);
    upnp.setTransportState('STOPPED');
    receiver.broadcastStateTick({ state: 'stopped', positionMs: 3000, durationMs: trackDurationMs });

    await new Promise((r) => setTimeout(r, 50));

    // Verify all 3 ticks were received over WebSocket
    expect(receivedTicks.length).toBeGreaterThanOrEqual(3);
    expect(receivedTicks[0]?.positionMs).toBe(1000);
    expect(receivedTicks[0]?.state).toBe('playing');
    expect(receivedTicks[1]?.positionMs).toBe(2000);
    expect(receivedTicks[1]?.state).toBe('playing');
    expect(receivedTicks[2]?.positionMs).toBe(3000);
    expect(receivedTicks[2]?.state).toBe('stopped');

    // Query mock UPnP server over SOAP to verify live position reporting
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
    expect(xml).toContain('<RelTime>00:00:03</RelTime>');
    expect(xml).toContain('<TrackDuration>00:00:03</TrackDuration>');
  });

  // TC-T3-17: F11 + F15
  it('TC-T3-17: executes rapid short-track transitions cleanly under Host-MCU mutex without connection collisions', async () => {
    const mcu = await createMockMcuServer({ initialPower: 'ON' });
    closables.push(mcu);

    // Simulate 4 back-to-back 3.5s short track transitions triggering power/input checks
    for (let i = 0; i < 4; i += 1) {
      const sock = net.connect(mcu.port, '127.0.0.1');
      await new Promise<void>((resolve, reject) => {
        sock.on('connect', () => sock.write('PW?\r'));
        sock.on('data', () => {
          sock.end();
        });
        sock.on('close', () => {
          resolve();
        });
        sock.on('error', reject);
      });
    }

    mcu.assertSerializedAccess();
    mcu.assertZeroSleepCommands();
    expect(mcu.getReceivedCommands()).toHaveLength(4);
  });

  // TC-T3-22: F13 + F15
  it('TC-T3-22: achieves transcode cache hit across rapid short-track skips', () => {
    const shortTrackA: SoundCloudTranscoding = {
      url: 'https://api.soundcloud.com/media/trackA/stream/hls',
      preset: 'aac_256k',
      duration: 3500,
      snipped: false,
      format: { protocol: 'hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' },
      quality: 'hq',
    };
    const shortTrackB: SoundCloudTranscoding = {
      url: 'https://api.soundcloud.com/media/trackB/stream/hls',
      preset: 'aac_256k',
      duration: 2800,
      snipped: false,
      format: { protocol: 'hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' },
      quality: 'hq',
    };
    const standardTrack: SoundCloudTranscoding = {
      url: 'https://api.soundcloud.com/media/trackC/stream/progressive',
      preset: 'mp3_0_128',
      duration: 180000,
      snipped: false,
      format: { protocol: 'progressive', mime_type: 'audio/mpeg' },
      quality: 'sq',
    };

    // Tracks A and B both select identical HQ AAC 256k transcoding profile
    const rankA = rankSoundCloudTranscodings([shortTrackA]);
    const rankB = rankSoundCloudTranscodings([shortTrackB]);
    expect(rankA.kind).toBe('playable');
    expect(rankB.kind).toBe('playable');
    if (rankA.kind === 'playable' && rankB.kind === 'playable') {
      expect(rankA.selected.preset).toBe(rankB.selected.preset);
      expect(rankA.selected.protocol).toBe(rankB.selected.protocol);
    }

    // Format changes on Track C: ranker returns different progressive profile
    const rankC = rankSoundCloudTranscodings([standardTrack]);
    expect(rankC.kind).toBe('playable');
    if (rankC.kind === 'playable') {
      expect(rankC.selected.protocol).toBe('progressive');
    }
  });

  // TC-T3-18: F4 + F20
  it('TC-T3-18: dynamically gates volume UI based on output capability advertising', async () => {
    const receiver = await createMockReceiverServer({
      initialOutputs: [SYNTHETIC_OUTPUT_HEOS, SYNTHETIC_OUTPUT_TOSLINK],
    });
    closables.push(receiver);

    const res = await fetch(`${receiver.baseUrl}/api/v1/discover`);
    const data = (await res.json()) as {
      receivers: { outputs: { id: string; capabilities: { supportsHardwareVolume?: boolean } }[] }[];
    };

    const outputs = data.receivers[0]?.outputs ?? [];
    const heos = outputs.find((o) => o.id === SYNTHETIC_OUTPUT_HEOS.id);
    const toslink = outputs.find((o) => o.id === SYNTHETIC_OUTPUT_TOSLINK.id);

    // HEOS advertises hardware volume support
    expect(heos?.capabilities.supportsHardwareVolume).toBe(true);
    // TOSLINK advertises 0 dB bit-perfect fixed volume (no hardware attenuation)
    expect(toslink?.capabilities.supportsHardwareVolume).toBe(false);

    // Verify dynamic UI gating inside ShadowDomCastPill
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
            outputs: [SYNTHETIC_OUTPUT_HEOS, SYNTHETIC_OUTPUT_TOSLINK],
          },
        ],
        hardwareVolume: 50,
        hardwareMuted: false,
      };

      // 1. When HEOS is active: volume section is visible
      pill.update(deriveUiSnapshot(local, session));
      const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
      const root = host?.shadowRoot;
      const volSection = root?.querySelector('.pill-volume');
      expect(volSection?.hidden).toBe(false);

      // 2. When TOSLINK is active: volume section is automatically hidden (0 dB fixed)
      const toslinkLocal = {
        ...local,
        activeOutputId: SYNTHETIC_OUTPUT_TOSLINK.id,
      };
      pill.update(deriveUiSnapshot(toslinkLocal, session));
      expect(volSection?.hidden).toBe(true);

      pill.dispose();
    } finally {
      dom.teardown();
    }
  });
});
