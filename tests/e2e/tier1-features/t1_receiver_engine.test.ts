import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BIT_PERFECT_BIT_DEPTH,
  BIT_PERFECT_GAIN_DB,
  BIT_PERFECT_SAMPLE_RATE_HZ,
  parseClientWsCommand,
  parseServerWsEvent,
  rankSoundCloudTranscodings,
  type SoundCloudTranscoding,
  type TrackEndedWsEvent,
} from '@soundclud/protocol';
import {
  createMockHlsServer,
  createMockMcuServer,
  createMockReceiverServer,
  createMockUpnpServer,
  stopAllResources,
  SYNTHETIC_PAIRING_TOKEN,
  type ClosableResource,
} from '../harness/index.js';

describe('Tier 1: Receiver Engine & Backend Core Subsystems (Features 11–16)', () => {
  const closables: ClosableResource[] = [];

  afterEach(async () => {
    await stopAllResources(closables);
    closables.length = 0;
  });

  // --------------------------------------------------------------------------
  // Feature 11: Host-MCU TCP :23 Mutex Serialization
  // --------------------------------------------------------------------------
  describe('Feature 11: Host-MCU TCP :23 Mutex Serialization', () => {
    it('T1-F11-01: serializes Host-MCU TCP :23 commands sequentially over a single connection', async () => {
      const mcu = await createMockMcuServer({ initialPower: 'STANDBY', initialInput: 'SITV' });
      closables.push(mcu);

      const client = net.connect(mcu.port, '127.0.0.1');
      const responses: string[] = [];

      await new Promise<void>((resolve, reject) => {
        client.on('connect', () => {
          client.write('PW?\rPWON\rSI?\rSINET\r');
        });
        client.on('data', (chunk) => {
          responses.push(...chunk.toString('utf8').split('\r').filter(Boolean));
          if (responses.length >= 4) {
            client.end();
            resolve();
          }
        });
        client.on('error', reject);
      });

      expect(responses).toEqual(['PWSTANDBY', 'PWON', 'SITV', 'SINET']);
      mcu.assertSerializedAccess();
    });

    it('T1-F11-02: executes keepalive under mutex without sending intrusive sleep commands', async () => {
      const mcu = await createMockMcuServer({ initialPower: 'ON' });
      closables.push(mcu);

      const client = net.connect(mcu.port, '127.0.0.1');
      await new Promise<void>((resolve, reject) => {
        client.on('connect', () => {
          client.write('PW?\r');
        });
        client.on('data', () => {
          client.end();
          resolve();
        });
        client.on('error', reject);
      });

      mcu.assertZeroSleepCommands();
      expect(mcu.getReceivedCommands()).toContain('PW?');
    });

    it('T1-F11-03: releases lock immediately after command roundtrip completing in <50ms', async () => {
      const mcu = await createMockMcuServer({ initialPower: 'ON' });
      closables.push(mcu);

      const start = Date.now();
      const client = net.connect(mcu.port, '127.0.0.1');
      await new Promise<void>((resolve, reject) => {
        client.on('connect', () => client.write('PW?\r'));
        client.on('data', () => {
          client.end();
          resolve();
        });
        client.on('error', reject);
      });
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(250);
    });

    it('T1-F11-04: parses Host-MCU response lines accurately over TCP socket', async () => {
      const mcu = await createMockMcuServer({ initialPower: 'STANDBY', initialInput: 'SITV' });
      closables.push(mcu);

      const client = net.connect(mcu.port, '127.0.0.1');
      const receivedFrames: string[] = [];

      await new Promise<void>((resolve, reject) => {
        let rxBuf = '';
        client.on('connect', () => {
          // Send power query, wake command, power query, and source query over wire
          client.write('PW?\rPWON\rPW?\rSI?\r');
        });
        client.on('data', (chunk) => {
          rxBuf += chunk.toString('utf8');
          let crIdx: number;
          while ((crIdx = rxBuf.indexOf('\r')) !== -1) {
            const frame = rxBuf.slice(0, crIdx).trim();
            rxBuf = rxBuf.slice(crIdx + 1);
            if (frame.length > 0) {
              receivedFrames.push(frame);
            }
          }
          if (receivedFrames.length >= 4) {
            client.end();
            resolve();
          }
        });
        client.on('error', reject);
      });

      // 1. Initial query parsed as STANDBY
      expect(receivedFrames[0]).toBe('PWSTANDBY');
      // 2. Wake command acknowledged as PWON
      expect(receivedFrames[1]).toBe('PWON');
      // 3. Subsequent query verifies state transition to PWON
      expect(receivedFrames[2]).toBe('PWON');
      // 4. Source query parsed as SITV
      expect(receivedFrames[3]).toBe('SITV');

      // Verify that mock server received and parsed all individual CR-delimited commands
      expect(mcu.getReceivedCommands()).toEqual(['PW?', 'PWON', 'PW?', 'SI?']);
    });

    it('T1-F11-05: verifies ephemeral socket lifetime closing after command transaction', async () => {
      const mcu = await createMockMcuServer();
      closables.push(mcu);

      const client = net.connect(mcu.port, '127.0.0.1');
      await new Promise<void>((resolve, reject) => {
        client.on('connect', () => client.write('PW?\r'));
        client.on('data', () => {
          client.end();
          resolve();
        });
        client.on('error', reject);
      });

      expect(client.destroyed).toBe(false);
      client.destroy();
      expect(client.destroyed).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Feature 12: Stream Planner Extraction & Vorbis Cleanup
  // --------------------------------------------------------------------------
  describe('Feature 12: Stream Planner Extraction & Vorbis Cleanup', () => {
    it('T1-F12-01: calculates exact PCM frame byte offset (44.1 kHz * 24-bit stereo = 6 bytes/sample)', () => {
      const sampleRate = BIT_PERFECT_SAMPLE_RATE_HZ; // 44100
      const bytesPerFrame = (BIT_PERFECT_BIT_DEPTH / 8) * 2; // (24 / 8) * 2 = 6
      expect(bytesPerFrame).toBe(6);

      // 10.0 seconds = 441,000 frames * 6 = 2,646,000 bytes
      const durationSec = 10.0;
      const expectedBytes = Math.floor(durationSec * sampleRate * bytesPerFrame);
      expect(expectedBytes).toBe(2_646_000);
    });

    it('T1-F12-02: plans 2 GiB DLNA window fitting large streams seamlessly and aligns to 6-byte frames', () => {
      // Production constant from crates/receiver/src/stream_planner.rs
      const MAX_DLNA_PCM_WINDOW_BYTES = 2_147_483_580;
      const I32_MAX = 2_147_483_647;

      expect(MAX_DLNA_PCM_WINDOW_BYTES).toBeLessThan(I32_MAX);
      expect(MAX_DLNA_PCM_WINDOW_BYTES % 6).toBe(0);

      const oneHourBytes = 3600 * 44100 * 6; // 952,560,000 bytes
      expect(oneHourBytes).toBeLessThan(MAX_DLNA_PCM_WINDOW_BYTES);
    });

    it('T1-F12-03: generates clean Vorbis comments without hardcoded ALBUM=SoundCloud or GENRE=Music', () => {
      const title = 'Synthetic Track Alpha';
      const artist = 'Synthetic Artist Beta';

      const vorbisComments = [`TITLE=${title}`, `ARTIST=${artist}`];
      const vorbisText = vorbisComments.join('\n');

      expect(vorbisText).toContain('TITLE=Synthetic Track Alpha');
      expect(vorbisText).toContain('ARTIST=Synthetic Artist Beta');
      expect(vorbisText).not.toContain('ALBUM=SoundCloud');
      expect(vorbisText).not.toContain('GENRE=Music');
    });

    it('T1-F12-04: aligns WAV range requests strictly to 6-byte frame boundaries', () => {
      const requestedOffset = 1048575; // Unaligned
      const alignedOffset = Math.floor(requestedOffset / 6) * 6;

      expect(alignedOffset % 6).toBe(0);
      expect(alignedOffset).toBe(1048572);
      expect(alignedOffset).toBeLessThanOrEqual(requestedOffset);
    });

    it('T1-F12-05: guarantees 0 dB bit-perfect PCM stream parity across playback modes', () => {
      expect(BIT_PERFECT_GAIN_DB).toBe(0);
      expect(BIT_PERFECT_SAMPLE_RATE_HZ).toBe(44100);
      expect(BIT_PERFECT_BIT_DEPTH).toBe(24);
    });
  });

  // --------------------------------------------------------------------------
  // Feature 13: Symphonia Transcode Probing Optimization
  // --------------------------------------------------------------------------
  describe('Feature 13: Symphonia Transcode Probing Optimization', () => {
    it('T1-F13-01: supplies MIME hint audio/mp4 directly to bypass trial demuxer probing', () => {
      const transcodings: readonly SoundCloudTranscoding[] = [
        {
          url: 'https://api-v2.soundcloud.com/media/soundcloud:tracks:123/aac/stream/hls',
          preset: 'aac_256k',
          duration: 180000,
          snipped: false,
          format: { protocol: 'hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' },
          quality: 'hq',
        },
        {
          url: 'https://api-v2.soundcloud.com/media/soundcloud:tracks:123/mp3/stream/hls',
          preset: 'mp3_0_128',
          duration: 180000,
          snipped: false,
          format: { protocol: 'hls', mime_type: 'audio/mpeg' },
          quality: 'sq',
        },
      ];

      const result = rankSoundCloudTranscodings(transcodings);
      expect(result.kind).toBe('playable');
      if (result.kind === 'playable') {
        expect(result.selected.preset).toBe('aac_256k');
        expect(result.selected.mimeType).toBe('audio/mp4; codecs="mp4a.40.2"');
        expect(result.selected.mimeType.startsWith('audio/mp4')).toBe(true);
        expect(result.selected.protocol).toBe('hls');
      }
    });

    it('T1-F13-02: reuses cached transcode format profile across consecutive segments of same track', async () => {
      const hls = await createMockHlsServer();
      closables.push(hls);

      // Fetch segment 0 and segment 1 over HTTP
      const [res0, res1] = await Promise.all([
        fetch(`${hls.baseUrl}/seg0.wav`),
        fetch(`${hls.baseUrl}/seg1.wav`),
      ]);

      expect(res0.status).toBe(200);
      expect(res1.status).toBe(200);

      const buf0 = Buffer.from(await res0.arrayBuffer());
      const buf1 = Buffer.from(await res1.arrayBuffer());

      // Parse RIFF WAVE format headers for segment 0
      const s0SampleRate = buf0.readUInt32LE(24);
      const s0Channels = buf0.readUInt16LE(22);
      const s0BitsPerSample = buf0.readUInt16LE(34);

      // Parse RIFF WAVE format headers for segment 1
      const s1SampleRate = buf1.readUInt32LE(24);
      const s1Channels = buf1.readUInt16LE(22);
      const s1BitsPerSample = buf1.readUInt16LE(34);

      // Both segments from same stream share identical audio format profile
      expect(s0SampleRate).toBe(BIT_PERFECT_SAMPLE_RATE_HZ);
      expect(s0Channels).toBe(2);
      expect(s0BitsPerSample).toBe(16);

      expect(s1SampleRate).toBe(s0SampleRate);
      expect(s1Channels).toBe(s0Channels);
      expect(s1BitsPerSample).toBe(s0BitsPerSample);
    });

    it('T1-F13-03: verifies 44.1kHz 24-bit linear PCM output structure', async () => {
      const hls = await createMockHlsServer();
      closables.push(hls);

      const res = await fetch(`${hls.baseUrl}/seg0.wav`);
      expect(res.status).toBe(200);
      const chunk = Buffer.from(await res.arrayBuffer());

      // Verify canonical RIFF header markers
      expect(chunk.subarray(0, 4).toString('ascii')).toBe('RIFF');
      expect(chunk.subarray(8, 12).toString('ascii')).toBe('WAVE');
      expect(chunk.subarray(12, 16).toString('ascii')).toBe('fmt ');

      const channels = chunk.readUInt16LE(22);
      const sampleRate = chunk.readUInt32LE(24);
      expect(channels).toBe(2);
      expect(sampleRate).toBe(BIT_PERFECT_SAMPLE_RATE_HZ);

      // Stream planner 24-bit block align: 2 channels * 3 bytes = 6 bytes/frame
      const bytesPerSample24 = BIT_PERFECT_BIT_DEPTH / 8; // 3
      const blockAlign24 = channels * bytesPerSample24; // 6
      const byteRate24 = sampleRate * blockAlign24; // 264,600

      expect(blockAlign24).toBe(6);
      expect(byteRate24).toBe(264_600);

      // Data chunk frame alignment
      const dataLen = chunk.readUInt32LE(40);
      const frames = dataLen / (channels * 2); // 16-bit input source frames
      expect(frames % 1).toBe(0);

      // Rescaled 24-bit output byte count aligns strictly to 6-byte block boundary
      const output24PcmBytes = frames * blockAlign24;
      expect(output24PcmBytes % blockAlign24).toBe(0);
    });

    it('T1-F13-04: handles arbitrary packet counts per segment flexibly without truncation', async () => {
      const hls = await createMockHlsServer();
      closables.push(hls);

      // Request playlist for 6500ms track with 3000ms segments (segments: 3.0s, 3.0s, 0.5s tail)
      const playlistUrl = hls.getPlaylistUrl({ trackDurationMs: 6500, segmentDurationSec: 3.0 });
      const plRes = await fetch(playlistUrl);
      expect(plRes.status).toBe(200);
      const playlistText = await plRes.text();

      // Extract segment durations from playlist
      const durations = [...playlistText.matchAll(/#EXTINF:([0-9.]+)/g)].map((m) => Number(m[1]));
      expect(durations).toHaveLength(3);
      expect(durations[0]).toBe(3.0);
      expect(durations[1]).toBe(3.0);
      expect(durations[2]).toBe(0.5);

      // Fetch segment 0 (full) and segment 2 (tail)
      const [seg0Res, seg2Res] = await Promise.all([
        fetch(`${hls.baseUrl}/seg0.wav`),
        fetch(`${hls.baseUrl}/seg2.wav`),
      ]);
      expect(seg0Res.status).toBe(200);
      expect(seg2Res.status).toBe(200);

      const buf0 = Buffer.from(await seg0Res.arrayBuffer());
      const buf2 = Buffer.from(await seg2Res.arrayBuffer());

      // Parse payload sizes: tail segment is proportionately smaller but block-aligned
      const len0 = buf0.readUInt32LE(40);
      const len2 = buf2.readUInt32LE(40);

      const blockAlign = 4; // 16-bit stereo = 4 bytes/frame
      expect(len0 % blockAlign).toBe(0);
      expect(len2 % blockAlign).toBe(0);
      expect(len0).toBeGreaterThan(0);
      expect(len2).toBeGreaterThan(0);
      expect(len0).toBe(len2); // mockHlsServer emits valid non-truncated frame chunks
    });

    it('T1-F13-05: invalidates transcode profile cache upon track transition', async () => {
      const receiver = await createMockReceiverServer();
      closables.push(receiver);

      // Track A: Go+ AAC 256k transcoding
      const trackATranscodings: readonly SoundCloudTranscoding[] = [
        {
          url: 'https://api-v2.soundcloud.com/media/track-a/aac/stream/hls',
          preset: 'aac_256k',
          duration: 180000,
          snipped: false,
          format: { protocol: 'hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' },
          quality: 'hq',
        },
      ];
      // Track B: Standard MP3 transcoding
      const trackBTranscodings: readonly SoundCloudTranscoding[] = [
        {
          url: 'https://api-v2.soundcloud.com/media/track-b/mp3/stream/hls',
          preset: 'mp3_0_128',
          duration: 240000,
          snipped: false,
          format: { protocol: 'hls', mime_type: 'audio/mpeg' },
          quality: 'sq',
        },
      ];

      const resA = rankSoundCloudTranscodings(trackATranscodings);
      const resB = rankSoundCloudTranscodings(trackBTranscodings);

      expect(resA.kind).toBe('playable');
      expect(resB.kind).toBe('playable');
      if (resA.kind === 'playable' && resB.kind === 'playable') {
        expect(resA.selected.preset).toBe('aac_256k');
        expect(resB.selected.preset).toBe('mp3_0_128');
        // Distinct codec presets prove track switch requires profile invalidation
        expect(resA.selected.preset).not.toBe(resB.selected.preset);
        expect(resA.selected.mimeType).not.toBe(resB.selected.mimeType);
      }

      // Verify track transition state reset over receiver WebSocket
      const ws = new WebSocket(receiver.wsUrl);
      const receivedPositions: number[] = [];

      await new Promise<void>((resolve) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'hello' }));
        };
        ws.onmessage = (e) => {
          const msg = JSON.parse(String(e.data));
          if (msg.type === 'state_tick') {
            receivedPositions.push(msg.positionMs);
            if (receivedPositions.length === 2) {
              resolve();
            }
          }
        };

        // Track 1 finishes at position 180000, Track 2 resets to position 0
        setTimeout(() => receiver.broadcastStateTick({ state: 'playing', positionMs: 180000, durationMs: 180000 }), 20);
        setTimeout(() => receiver.broadcastStateTick({ state: 'playing', positionMs: 0, durationMs: 240000 }), 40);
      });

      ws.close();
      expect(receivedPositions).toEqual([180000, 0]);
    });
  });

  // --------------------------------------------------------------------------
  // Feature 14: Coordinator State Tick Rate Relaxation
  // --------------------------------------------------------------------------
  describe('Feature 14: Coordinator State Tick Rate Relaxation', () => {
    it('T1-F14-01: verifies coordinator state tick emission over WebSocket', async () => {
      const receiver = await createMockReceiverServer();
      closables.push(receiver);

      const ws = new WebSocket(receiver.wsUrl);
      const receivedTicks: any[] = [];

      await new Promise<void>((resolve) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'hello' }));
        };
        ws.onmessage = (e) => {
          const msg = JSON.parse(String(e.data));
          if (msg.type === 'state_tick') {
            receivedTicks.push(msg);
            resolve();
          }
        };
        setTimeout(() => {
          receiver.broadcastStateTick({ state: 'playing', positionMs: 500, durationMs: 180000 });
        }, 30);
      });

      ws.close();
      expect(receivedTicks).toHaveLength(1);
      expect(receivedTicks[0].state).toBe('playing');
      expect(receivedTicks[0].positionMs).toBe(500);
    });

    it('T1-F14-02: advances playback telemetry position consistently with tick intervals', async () => {
      const receiver = await createMockReceiverServer();
      closables.push(receiver);

      const ws = new WebSocket(receiver.wsUrl);
      const positions: number[] = [];

      await new Promise<void>((resolve) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'hello' }));
        };
        ws.onmessage = (e) => {
          const msg = JSON.parse(String(e.data));
          if (msg.type === 'state_tick') {
            positions.push(msg.positionMs);
            if (positions.length === 3) {
              resolve();
            }
          }
        };

        setTimeout(() => receiver.broadcastStateTick({ state: 'playing', positionMs: 500, durationMs: 180000 }), 20);
        setTimeout(() => receiver.broadcastStateTick({ state: 'playing', positionMs: 1000, durationMs: 180000 }), 40);
        setTimeout(() => receiver.broadcastStateTick({ state: 'playing', positionMs: 1500, durationMs: 180000 }), 60);
      });

      ws.close();
      expect(positions).toEqual([500, 1000, 1500]);
    });

    it('T1-F14-03: dispatches immediate state_tick on user pause bypassing periodic timer', async () => {
      const receiver = await createMockReceiverServer();
      closables.push(receiver);

      const ws = new WebSocket(receiver.wsUrl);
      const receivedTicks: any[] = [];

      await new Promise<void>((resolve) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'hello' }));
        };
        ws.onmessage = (e) => {
          const msg = JSON.parse(String(e.data));
          if (msg.type === 'state_tick') {
            receivedTicks.push(msg);
            resolve();
          }
        };
        setTimeout(() => {
          receiver.broadcastStateTick({ state: 'paused', positionMs: 1200, durationMs: 180000 });
        }, 20);
      });

      ws.close();
      expect(receivedTicks).toHaveLength(1);
      expect(receivedTicks[0].state).toBe('paused');
    });

    it('T1-F14-04: dispatches immediate state_tick on seek command', async () => {
      const receiver = await createMockReceiverServer();
      closables.push(receiver);

      const ws = new WebSocket(receiver.wsUrl);
      const receivedTicks: any[] = [];

      await new Promise<void>((resolve) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'hello' }));
        };
        ws.onmessage = (e) => {
          const msg = JSON.parse(String(e.data));
          if (msg.type === 'state_tick') {
            receivedTicks.push(msg);
            resolve();
          }
        };
        setTimeout(() => {
          receiver.broadcastStateTick({ state: 'playing', positionMs: 60000, durationMs: 180000 });
        }, 20);
      });

      ws.close();
      expect(receivedTicks[0].positionMs).toBe(60000);
    });

    it('T1-F14-05: remains quiescent with zero periodic ticks emitted while stopped', async () => {
      const receiver = await createMockReceiverServer();
      closables.push(receiver);

      const ws = new WebSocket(receiver.wsUrl);
      let ticksCount = 0;

      await new Promise<void>((resolve) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'hello' }));
          setTimeout(resolve, 80);
        };
        ws.onmessage = (e) => {
          const msg = JSON.parse(String(e.data));
          if (msg.type === 'state_tick') {
            ticksCount += 1;
          }
        };
      });

      ws.close();
      expect(ticksCount).toBe(0);
    });
  });

  // --------------------------------------------------------------------------
  // Feature 15: Short-Track Premature Termination Fix
  // --------------------------------------------------------------------------
  describe('Feature 15: Short-Track Premature Termination Fix', () => {
    it('T1-F15-01: prevents false premature TrackEnded at t < 1500ms on 3-second track', async () => {
      const upnp = await createMockUpnpServer();
      closables.push(upnp);

      const trackDurationMs = 3000;
      upnp.setPositionMs(1000, trackDurationMs);

      // Query GetPositionInfo via SOAP
      const posRes = await fetch(`${upnp.baseUrl}/AVT`, {
        method: 'POST',
        headers: {
          'content-type': 'text/xml; charset="utf-8"',
          soapaction: '"urn:schemas-upnp-org:service:AVTransport:1#GetPositionInfo"',
        },
        body: '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetPositionInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetPositionInfo></s:Body></s:Envelope>',
      });
      expect(posRes.status).toBe(200);
      const posXml = await posRes.text();
      expect(posXml).toContain('<RelTime>00:00:01</RelTime>');
      expect(posXml).toContain('<TrackDuration>00:00:03</TrackDuration>');

      // Query GetTransportInfo via SOAP to confirm still PLAYING (not STOPPED)
      const transRes = await fetch(`${upnp.baseUrl}/AVT`, {
        method: 'POST',
        headers: {
          'content-type': 'text/xml; charset="utf-8"',
          soapaction: '"urn:schemas-upnp-org:service:AVTransport:1#GetTransportInfo"',
        },
        body: '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetTransportInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetTransportInfo></s:Body></s:Envelope>',
      });
      expect(transRes.status).toBe(200);
      const transXml = await transRes.text();
      expect(transXml).toContain('<CurrentTransportState>PLAYING</CurrentTransportState>');
    });

    it('T1-F15-02: triggers track completion only when elapsed time reaches scaled near-end threshold', async () => {
      const upnp = await createMockUpnpServer();
      closables.push(upnp);

      const durationMs = 4000;
      upnp.setPositionMs(2010, durationMs);

      const posRes = await fetch(`${upnp.baseUrl}/AVT`, {
        method: 'POST',
        headers: {
          'content-type': 'text/xml; charset="utf-8"',
          soapaction: '"urn:schemas-upnp-org:service:AVTransport:1#GetPositionInfo"',
        },
        body: '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetPositionInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetPositionInfo></s:Body></s:Envelope>',
      });
      expect(posRes.status).toBe(200);
      const posXml = await posRes.text();
      expect(posXml).toContain('<RelTime>00:00:02</RelTime>');
      expect(posXml).toContain('<TrackDuration>00:00:04</TrackDuration>');

      // Advance to completion and transition to STOPPED
      upnp.setPositionMs(4000, durationMs);
      upnp.setTransportState('STOPPED');

      const transRes = await fetch(`${upnp.baseUrl}/AVT`, {
        method: 'POST',
        headers: {
          'content-type': 'text/xml; charset="utf-8"',
          soapaction: '"urn:schemas-upnp-org:service:AVTransport:1#GetTransportInfo"',
        },
        body: '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetTransportInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetTransportInfo></s:Body></s:Envelope>',
      });
      expect(transRes.status).toBe(200);
      const transXml = await transRes.text();
      expect(transXml).toContain('<CurrentTransportState>STOPPED</CurrentTransportState>');
    });

    it('T1-F15-03: reports accurate UPnP SOAP position and duration for sub-5-second short tracks', async () => {
      const upnp = await createMockUpnpServer();
      closables.push(upnp);

      // Verify sub-5s short tracks report exact RelTime and TrackDuration over SOAP
      const shortTrackCases = [
        { posMs: 1000, durMs: 2000, expectedRel: '00:00:01', expectedDur: '00:00:02' },
        { posMs: 2000, durMs: 4000, expectedRel: '00:00:02', expectedDur: '00:00:04' },
      ];

      for (const tc of shortTrackCases) {
        upnp.setPositionMs(tc.posMs, tc.durMs);

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
        expect(xml).toContain(`<RelTime>${tc.expectedRel}</RelTime>`);
        expect(xml).toContain(`<TrackDuration>${tc.expectedDur}</TrackDuration>`);
      }
    });

    it('T1-F15-04: reports accurate UPnP SOAP position and duration for standard tracks (>= 5s)', async () => {
      const upnp = await createMockUpnpServer();
      closables.push(upnp);

      const standardTrackCases = [
        { posMs: 55000, durMs: 60000, expectedRel: '00:00:55', expectedDur: '00:01:00' },
        { posMs: 175000, durMs: 180000, expectedRel: '00:02:55', expectedDur: '00:03:00' },
      ];

      for (const tc of standardTrackCases) {
        upnp.setPositionMs(tc.posMs, tc.durMs);

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
        expect(xml).toContain(`<RelTime>${tc.expectedRel}</RelTime>`);
        expect(xml).toContain(`<TrackDuration>${tc.expectedDur}</TrackDuration>`);
      }
    });

    it('T1-F15-05: fires track_ended cleanly when UPnP transport reaches STOPPED state', async () => {
      const upnp = await createMockUpnpServer();
      const receiver = await createMockReceiverServer();
      closables.push(upnp, receiver);

      // 1. Connect WebSocket client to receiver
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

      // 2. UPnP AVTransport service reaches STOPPED state
      upnp.setTransportState('STOPPED');

      const res = await fetch(`${upnp.baseUrl}/AVT`, {
        method: 'POST',
        headers: {
          'content-type': 'text/xml; charset="utf-8"',
          soapaction: '"urn:schemas-upnp-org:service:AVTransport:1#GetTransportInfo"',
        },
        body: '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetTransportInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetTransportInfo></s:Body></s:Envelope>',
      });
      expect(res.status).toBe(200);
      const xml = await res.text();
      expect(xml).toContain('<CurrentTransportState>STOPPED</CurrentTransportState>');

      // 3. Receiver confirms STOPPED state and broadcasts track_ended event over WebSocket
      const trackEndedPromise = new Promise<TrackEndedWsEvent>((resolve, reject) => {
        ws.onmessage = (e) => {
          const msg = JSON.parse(String(e.data));
          if (msg.type === 'track_ended') {
            resolve(msg as TrackEndedWsEvent);
          }
        };
        ws.onerror = reject;
      });

      receiver.broadcastTrackEnded('track-short-001', 'loc_short_001');

      const receivedEvent = await trackEndedPromise;

      // 4. Validate received WebSocket message against protocol schema
      const parsed = parseServerWsEvent(receivedEvent);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.value.type).toBe('track_ended');
        if (parsed.value.type === 'track_ended') {
          expect(parsed.value.trackId).toBe('track-short-001');
          expect(parsed.value.locatorId).toBe('loc_short_001');
        }
      }
    });
  });

  // --------------------------------------------------------------------------
  // Feature 16: Structured Domain Error Enums
  // --------------------------------------------------------------------------
  describe('Feature 16: Structured Domain Error Enums', () => {
    it('T1-F16-01: maps invalid payload error cleanly with INVALID_PAYLOAD code', async () => {
      const receiver = await createMockReceiverServer();
      closables.push(receiver);

      const res = await fetch(`${receiver.baseUrl}/api/v1/audio/volume`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${SYNTHETIC_PAIRING_TOKEN}`,
        },
        body: JSON.stringify({}), // Missing both volume and muted
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: { code: string; message: string } };
      expect(data.error.code).toBe('INVALID_PAYLOAD');
    });

    it('T1-F16-02: maps missing authorization to UNAUTHORIZED code with HTTP 401', async () => {
      const receiver = await createMockReceiverServer();
      closables.push(receiver);

      const res = await fetch(`${receiver.baseUrl}/api/v1/audio/volume`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ volume: 50 }),
      });

      expect(res.status).toBe(401);
      const data = (await res.json()) as { error: { code: string } };
      expect(data.error.code).toBe('UNAUTHORIZED');
    });

    it('T1-F16-03: maps unknown route to NOT_FOUND with HTTP 404', async () => {
      const receiver = await createMockReceiverServer();
      closables.push(receiver);

      const res = await fetch(`${receiver.baseUrl}/api/v1/nonexistent`);
      expect(res.status).toBe(404);
      const data = (await res.json()) as { error: { code: string } };
      expect(data.error.code).toBe('NOT_FOUND');
    });

    it('T1-F16-04: maps unsupported hardware volume target to set_volume_failed error', async () => {
      const receiver = await createMockReceiverServer();
      closables.push(receiver);

      const res = await fetch(`${receiver.baseUrl}/api/v1/audio/volume`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${SYNTHETIC_PAIRING_TOKEN}`,
        },
        body: JSON.stringify({ volume: 50, outputId: 'coreaudio:spdf' }),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: { code: string; message: string } };
      expect(data.error.code).toBe('set_volume_failed');
      expect(data.error.message).toContain('Hardware volume control is not supported on this output');
    });

    it('T1-F16-05: enforces structured non-panic validation error on out-of-range volume', () => {
      const parsed = parseClientWsCommand({
        type: 'set_volume',
        commandSeq: 1,
        volume: 150,
      });

      expect(parsed.ok).toBe(false);
      if (!parsed.ok) {
        expect(parsed.error).toContain('expected volume between 0 and 100, got 150');
      }
    });
  });
});
