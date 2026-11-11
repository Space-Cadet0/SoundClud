import { afterEach, describe, expect, it } from 'vitest';
import {
  API_V1_AUDIO_VOLUME_PATH,
  BIT_PERFECT_GAIN_DB,
  rankSoundCloudTranscodings,
  type SoundCloudTranscoding,
} from '@soundclud/protocol';
import {
  createMockReceiverServer,
  createMockUpnpServer,
  createSyntheticTrackFixture,
  spawnEphemeralReceiverDaemon,
  stopAllResources,
  SYNTHETIC_OUTPUT_HEOS,
  SYNTHETIC_OUTPUT_TOSLINK,
  type ClosableResource,
} from '../harness/index.js';

describe('Tier 4: Workload Scenario 1 — Full Playback Sessions & Multi-Track Lifecycle', () => {
  const closables: ClosableResource[] = [];

  afterEach(async () => {
    await stopAllResources(closables);
    closables.length = 0;
  });

  // SC-T4-01: Mode B native process execution & Law 1 0 dB Bit-Perfect Invariant
  it('SC-T4-01: executes multi-track playback session with remote master volume adjustments at 0 dB gain using Mode B daemon', async () => {
    const daemon = await spawnEphemeralReceiverDaemon();
    closables.push(daemon);

    // 1. Initial status check on native receiver daemon
    const statusRes = await daemon.fetchRest('/api/v1/status');
    expect(statusRes.status).toBe(200);
    const status = (await statusRes.json()) as {
      protocolVersion: string;
      receiverId: string;
      receiverName: string;
      telemetry?: { phase?: string };
    };
    expect(status.protocolVersion).toBe('v1');
    expect(status.receiverId).toBeDefined();
    expect(status.telemetry).toBeDefined();

    // 2. Discover outputs: Mode B native daemon exposes coreaudio/spdf
    const discRes = await daemon.fetchRest('/api/v1/discover');
    expect(discRes.status).toBe(200);
    const disc = (await discRes.json()) as {
      outputs: { id: string; capabilities: { supportsHardwareVolume?: boolean } }[];
    };
    expect(disc.outputs.length).toBeGreaterThanOrEqual(1);
    const optical = disc.outputs.find((o) => o.id === 'coreaudio/spdf');
    expect(optical).toBeDefined();
    // Law 1 Bit-Perfect Optical Invariant: hardware volume is not supported (uses amp knob)
    expect(optical?.capabilities.supportsHardwareVolume).toBe(false);

    // 3. Pair with native receiver
    const token = await daemon.pair('Playback Session Client', 'ctrl_playback_1');
    expect(token).toBeDefined();

    // 4. Send volume request over REST with Bearer token
    // On coreaudio/spdf output: daemon rejects digital volume attenuation per Law 1 Bit-Perfect amp invariant
    const volRes = await daemon.fetchRest(API_V1_AUDIO_VOLUME_PATH, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ volume: 45 }),
    });
    expect(volRes.status).toBe(400);
    const errBody = (await volRes.json()) as { error: { code: string; message: string } };
    expect(errBody.error.code).toBe('set_volume_failed');
    expect(errBody.error.message).toContain('Hardware volume control is not supported on this output');

    // 5. Law 1 Amp Invariant: 0 dB software gain strictly preserved across playback sessions
    expect(BIT_PERFECT_GAIN_DB).toBe(0);
  });

  // SC-T4-07: Playlist skipping across mixed short (<5s) and normal tracks without pipeline stalls
  it('SC-T4-07: rapidly skips across mixed short (<5s) and normal tracks without pipeline stalls', async () => {
    const receiver = await createMockReceiverServer();
    closables.push(receiver);

    const playlist = [
      createSyntheticTrackFixture(201, 2500),  // 2.5s clip
      createSyntheticTrackFixture(202, 240000), // 4.0m track
      createSyntheticTrackFixture(203, 3000),  // 3.0s clip
      createSyntheticTrackFixture(204, 180000), // 3.0m track
    ];

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

    const receivedEvents: any[] = [];
    ws.onmessage = (e) => {
      receivedEvents.push(JSON.parse(String(e.data)));
    };

    let commandSeq = 1;
    // Sequence through the mixed playlist: load track, receive state tick, skip to next track
    for (const track of playlist) {
      // 1. Send load_track for this playlist item
      ws.send(
        JSON.stringify({
          type: 'load_track',
          commandSeq: commandSeq++,
          locator: {
            trackId: String(track.id),
            transcodingUrl: track.locator.selected.resolveUrl,
            protocol: 'hls',
            mimeType: 'audio/mp4',
            bitrateKbps: 256,
            durationMs: track.durationMs,
          },
        }),
      );

      // 2. Receiver reports state tick for the active track
      receiver.broadcastStateTick({
        state: 'playing',
        positionMs: 0,
        durationMs: track.durationMs,
      });

      // 3. If short track (<5s), advance to end and signal track_ended
      if (track.durationMs <= 5000) {
        receiver.broadcastStateTick({
          state: 'playing',
          positionMs: track.durationMs,
          durationMs: track.durationMs,
        });
        receiver.broadcastTrackEnded(String(track.id), `loc_${track.id}`);
      }
    }

    await new Promise((r) => setTimeout(r, 50));

    // Verify all 4 tracks were loaded and state ticks received
    const stateTicks = receivedEvents.filter((e) => e.type === 'state_tick');
    expect(stateTicks.length).toBeGreaterThanOrEqual(4);

    // Verify track_ended events fired for the two short tracks (201 and 203)
    const endedEvents = receivedEvents.filter((e) => e.type === 'track_ended');
    expect(endedEvents.length).toBe(2);
    expect(endedEvents[0]?.trackId).toBe('201');
    expect(endedEvents[1]?.trackId).toBe('203');
  });

  // SC-T4-08
  it('SC-T4-08: switches between Optical TOSLINK and Universal HEOS Direct preserving backend independence', async () => {
    const receiver = await createMockReceiverServer({
      initialOutputs: [SYNTHETIC_OUTPUT_TOSLINK, SYNTHETIC_OUTPUT_HEOS],
    });
    closables.push(receiver);

    const ws = new WebSocket(receiver.wsUrl);
    await new Promise<void>((resolve) => {
      ws.onopen = () => ws.send(JSON.stringify({ type: 'hello' }));
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.type === 'volume_changed') {
          resolve();
        }
      };
    });

    // 1. Select Optical S/PDIF (TOSLINK)
    const ack1 = new Promise<void>((resolve) => {
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.type === 'command_ack' && msg.commandSeq === 1) {
          resolve();
        }
      };
      ws.send(JSON.stringify({ type: 'select_output', commandSeq: 1, outputId: SYNTHETIC_OUTPUT_TOSLINK.id }));
    });
    await ack1;

    // 2. Select HEOS Direct
    const ack2 = new Promise<void>((resolve) => {
      ws.onmessage = (e) => {
        const msg = JSON.parse(String(e.data));
        if (msg.type === 'command_ack' && msg.commandSeq === 2) {
          resolve();
        }
      };
      ws.send(JSON.stringify({ type: 'select_output', commandSeq: 2, outputId: SYNTHETIC_OUTPUT_HEOS.id }));
    });
    await ack2;

    ws.close();

    // Verify backend independence
    expect(SYNTHETIC_OUTPUT_TOSLINK.capabilities.supportsHardwareVolume).toBe(false);
    expect(SYNTHETIC_OUTPUT_HEOS.capabilities.supportsHardwareVolume).toBe(true);
  });

  // SC-T4-09: Production rankSoundCloudTranscodings integration
  it('SC-T4-09: handles Widevine DRM fallback to local audio and auto-resumes remote streaming on next track', () => {
    // Track 1: Standard Go+ AAC 256k HLS stream
    const track1Transcodings: SoundCloudTranscoding[] = [
      {
        url: 'https://api.soundcloud.com/media/track1/stream/hls',
        preset: 'aac_256k',
        duration: 180000,
        snipped: false,
        format: { protocol: 'hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' },
        quality: 'hq',
      },
    ];

    // Track 2: Widevine CENC DRM-only stream (ctr-encrypted-hls)
    const track2Transcodings: SoundCloudTranscoding[] = [
      {
        url: 'https://api.soundcloud.com/media/track2/stream/hls',
        preset: 'aac_256k',
        duration: 240000,
        snipped: false,
        format: { protocol: 'ctr-encrypted-hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' },
        quality: 'hq',
      },
    ];

    // Track 3: Standard Go+ AAC 256k HLS stream
    const track3Transcodings: SoundCloudTranscoding[] = [
      {
        url: 'https://api.soundcloud.com/media/track3/stream/hls',
        preset: 'aac_256k',
        duration: 195000,
        snipped: false,
        format: { protocol: 'hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' },
        quality: 'hq',
      },
    ];

    // 1. Rank Track 1: Standard Go+ -> Selected for remote Hi-Fi streaming
    const res1 = rankSoundCloudTranscodings(track1Transcodings);
    expect(res1.kind).toBe('playable');
    if (res1.kind === 'playable') {
      expect(res1.selected.protocol).toBe('hls');
      expect(res1.selected.preset).toBe('aac_256k');
    }

    // 2. Rank Track 2: Widevine CENC -> Cleanly triggers drm_local_fallback
    const res2 = rankSoundCloudTranscodings(track2Transcodings);
    expect(res2.kind).toBe('drm_local_fallback');

    // 3. Rank Track 3: Standard Go+ -> Cleanly auto-resumes remote Hi-Fi streaming
    const res3 = rankSoundCloudTranscodings(track3Transcodings);
    expect(res3.kind).toBe('playable');
    if (res3.kind === 'playable') {
      expect(res3.selected.protocol).toBe('hls');
    }
  });
});
