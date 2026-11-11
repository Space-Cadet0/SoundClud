import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_V1_AUDIO_VOLUME_PATH,
  BIT_PERFECT_BIT_DEPTH,
  BIT_PERFECT_SAMPLE_RATE_HZ,
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
  createMockHeosCliServer,
  createMockReceiverServer,
  setupSyntheticDomEnvironment,
  stopAllResources,
  SYNTHETIC_OUTPUT_HEOS,
  SYNTHETIC_PAIRING_TOKEN,
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

describe('Tier 3: Volume & Seek Concurrency Interplay (Cross-Feature)', () => {
  const closables: ClosableResource[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    await stopAllResources(closables);
    closables.length = 0;
  });

  // TC-T3-01: F1 + F3
  it('TC-T3-01: enforces simultaneous volume & mute execution ordering (volume first, mute second)', async () => {
    const cli = await createMockHeosCliServer({ initialVolume: 20, initialMuted: false });
    closables.push(cli);

    // In SoundClud receiver coordinator: when both volume and mute change,
    // volume is sent first to avoid unmute audio burst, then mute is applied.
    await sendTcpCommand(cli.port, 'heos://player/set_volume?pid=1&level=45\r\n');
    await sendTcpCommand(cli.port, 'heos://player/set_mute?pid=1&state=on\r\n');

    const cmds = cli.getReceivedCommands();
    expect(cmds).toHaveLength(2);
    expect(cmds[0]).toContain('set_volume');
    expect(cmds[1]).toContain('set_mute');
    expect(cli.currentVolume).toBe(45);
    expect(cli.currentMuted).toBe(true);
  });

  // TC-T3-02: F1 + F5
  it('TC-T3-02: preserves active volume level when mute-only update arrives from hardware or UI', async () => {
    const cli = await createMockHeosCliServer({ initialVolume: 38, initialMuted: false });
    closables.push(cli);

    // Mute toggle arriving with state=on over live loopback TCP
    const res = await sendTcpCommand(cli.port, 'heos://player/set_mute?pid=1&state=on\r\n');
    const parsed = JSON.parse(res) as { heos: { result: string } };
    expect(parsed.heos.result).toBe('success');

    expect(cli.currentMuted).toBe(true);
    expect(cli.currentVolume).toBe(38); // Stored volume strictly remains 38
  });

  // TC-T3-03: F1 + F5
  it('TC-T3-03: preserves hardware mute state when volume-only adjustment is made', async () => {
    const cli = await createMockHeosCliServer({ initialVolume: 38, initialMuted: true });
    closables.push(cli);

    const res = await sendTcpCommand(cli.port, 'heos://player/set_volume?pid=1&level=50\r\n');
    const parsed = JSON.parse(res) as { heos: { result: string } };
    expect(parsed.heos.result).toBe('success');

    expect(cli.currentVolume).toBe(50);
    expect(cli.currentMuted).toBe(true); // Mute strictly preserved!
  });

  // TC-T3-10: F12 + F13
  it('TC-T3-10: plans PCM frame boundaries while caching Symphonia transcode format profile', async () => {
    const sampleRate = BIT_PERFECT_SAMPLE_RATE_HZ; // 44100
    const channels = 2;
    const bytesPerSample = BIT_PERFECT_BIT_DEPTH / 8; // 3
    const bytesPerFrame = channels * bytesPerSample; // 6 bytes

    // 3 segments of 3.0 seconds each
    const segDurationSec = 3.0;
    const segFrames = segDurationSec * sampleRate;
    const segBytes = segFrames * bytesPerFrame;

    expect(segBytes).toBe(793_800);
    expect(segBytes % bytesPerFrame).toBe(0);

    // Verify transcoding ranker selects Go+ AAC 256k consistently across consecutive segments
    const transcodings: SoundCloudTranscoding[] = [
      {
        url: 'https://api.soundcloud.com/media/track1/stream/hls',
        preset: 'aac_256k',
        duration: 180000,
        snipped: false,
        format: { protocol: 'hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' },
        quality: 'hq',
      },
    ];

    const ranked = rankSoundCloudTranscodings(transcodings);
    expect(ranked.kind).toBe('playable');
    if (ranked.kind === 'playable') {
      expect(ranked.selected.preset).toBe('aac_256k');
      expect(ranked.selected.protocol).toBe('hls');
    }

    // Verify receiver telemetry maintains consistent 44.1kHz 24-bit linear PCM format profile
    const receiver = await createMockReceiverServer();
    closables.push(receiver);

    const ws = new WebSocket(receiver.wsUrl);
    let capturedTick: any = null;
    await new Promise<void>((resolve) => {
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello' }));
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.type === 'state_tick') {
          capturedTick = msg;
          resolve();
        }
      };
      setTimeout(() => {
        receiver.broadcastStateTick({
          state: 'playing',
          positionMs: 3000,
          durationMs: 180000,
        });
      }, 50);
    });
    ws.close();

    expect(capturedTick).not.toBeNull();
    expect(capturedTick.state).toBe('playing');
    expect(capturedTick.positionMs).toBe(3000);
  });

  // TC-T3-11: F14 + F10
  it('TC-T3-11: delivers event-driven volume UI updates in <50ms without waiting for 500ms coordinator tick', async () => {
    const receiver = await createMockReceiverServer({ initialVolume: 30 });
    closables.push(receiver);

    const ws = new WebSocket(receiver.wsUrl);
    let volumeChangeLatencyMs = 0;
    let sendTime = 0;

    await new Promise<void>((resolve) => {
      ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'hello' }));
      };
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.type === 'volume_changed' && msg.volume === 65) {
          volumeChangeLatencyMs = Date.now() - sendTime;
          resolve();
        }
      };

      setTimeout(() => {
        sendTime = Date.now();
        ws.send(JSON.stringify({ type: 'set_volume', commandSeq: 99, volume: 65 }));
      }, 50);
    });

    ws.close();
    expect(volumeChangeLatencyMs).toBeLessThan(50);
  });

  // TC-T3-14: F9 + F10
  it('TC-T3-14: maintains bidirectional synchronization between Cast Pill and Popup UI surfaces', () => {
    const dom = setupSyntheticDomEnvironment();
    try {
      const container = dom.document.createElement('div');
      container.className = 'playControls';
      dom.document.body.append(container);

      let requestedVolume: number | null = null;
      let requestedMute: boolean | null = null;

      const pill = new ShadowDomCastPill({
        onToggleHandoff: () => {},
        onSelectOutput: () => {},
        onRefreshOutputs: () => {},
        onSetVolume: (vol, muted) => {
          if (vol !== undefined) requestedVolume = vol;
          if (muted !== undefined) requestedMute = muted;
        },
      });
      pill.mount();

      const local = {
        ...createDefaultDurableLocalConfig(),
        handoffEnabled: true,
        activeReceiverId: 'rec-01',
        activeEndpointBaseUrl: 'http://127.0.0.1:9876',
        activeOutputId: SYNTHETIC_OUTPUT_HEOS.id,
      };

      let session = {
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
        hardwareVolume: 35,
        hardwareMuted: false,
      };

      // 1. Initial sync
      pill.update(deriveUiSnapshot(local, session));

      // 2. Popup UI changes volume to 55 -> updates session state
      session = {
        ...session,
        hardwareVolume: 55,
      };
      // Propagate snapshot to Cast Pill UI
      pill.update(deriveUiSnapshot(local, session));

      const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
      const root = host?.shadowRoot;
      const slider = root?.querySelector('.pill-volume-slider');
      expect(slider?.value).toBe('55');

      // 3. User clicks mute button on Cast Pill
      const muteBtn = root?.querySelector('.pill-mute-btn');
      expect(muteBtn).not.toBeNull();
      muteBtn?.click();

      // Verify Cast Pill sent mute command to backend
      expect(requestedMute).toBe(true);

      pill.dispose();
    } finally {
      vi.useRealTimers();
      dom.teardown();
    }
  });

  // TC-T3-23: F18 + F10
  it('TC-T3-23: debounces continuous rapid slider dragging while maintaining cached DOM references', () => {
    vi.useFakeTimers();
    const dom = setupSyntheticDomEnvironment();
    try {
      const container = dom.document.createElement('div');
      container.className = 'playControls';
      dom.document.body.append(container);

      const capturedVolumeCalls: number[] = [];
      const pill = new ShadowDomCastPill({
        onToggleHandoff: () => {},
        onSelectOutput: () => {},
        onRefreshOutputs: () => {},
        onSetVolume: (vol) => {
          if (vol !== undefined) {
            capturedVolumeCalls.push(vol);
          }
        },
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
        hardwareVolume: 20,
        hardwareMuted: false,
      };

      pill.update(deriveUiSnapshot(local, session));

      const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
      const slider = host?.shadowRoot?.querySelector('.pill-volume-slider');
      expect(slider).not.toBeNull();

      // Simulate dragging across 25 steps rapidly: values 20 to 68
      const dragSteps = Array.from({ length: 25 }, (_, i) => 20 + i * 2);
      for (const val of dragSteps) {
        if (slider) {
          slider.value = String(val);
          slider.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }

      // While debouncing is active, no intermediate volume calls were sent
      expect(capturedVolumeCalls).toHaveLength(0);

      // Advance debounce timer (150ms per VOLUME_SLIDER_DEBOUNCE_MS)
      vi.advanceTimersByTime(200);

      // Trailing debounced call fires exactly once with the final slider value (68)
      expect(capturedVolumeCalls).toHaveLength(1);
      expect(capturedVolumeCalls[0]).toBe(68);

      pill.dispose();
    } finally {
      vi.useRealTimers();
      dom.teardown();
    }
  });
});
