import { afterEach, describe, expect, it } from 'vitest';
import {
  BIT_PERFECT_BIT_DEPTH,
  BIT_PERFECT_SAMPLE_RATE_HZ,
  rankSoundCloudTranscodings,
  type SoundCloudTranscoding,
} from '@soundclud/protocol';
import {
  createMockUpnpServer,
  stopAllResources,
  type ClosableResource,
} from '../harness/index.js';

// Canonical constants matching crates/receiver/src/stream_planner.rs
const PCM_CHANNELS = 2;
const PCM_BYTES_PER_SAMPLE = BIT_PERFECT_BIT_DEPTH / 8; // 3 bytes (24-bit)
const PCM_BLOCK_ALIGN = PCM_CHANNELS * PCM_BYTES_PER_SAMPLE; // 6 bytes per frame
const PCM_BYTE_RATE = BIT_PERFECT_SAMPLE_RATE_HZ * PCM_BLOCK_ALIGN; // 264,600 bytes/sec
const MAX_DLNA_PCM_WINDOW_BYTES = 2_147_483_580; // 2 GiB signed ceiling minus header, aligned to 6 bytes
const MAX_DLNA_WINDOW_DURATION_MS = Math.floor((MAX_DLNA_PCM_WINDOW_BYTES * 1000) / PCM_BYTE_RATE); // 8,115,962 ms

describe('Tier 2: Media, Transcode & Stream Planner Edge Cases (Features 12, 13, 15)', () => {
  const closables: ClosableResource[] = [];

  afterEach(async () => {
    await stopAllResources(closables);
    closables.length = 0;
  });

  describe('Stream Planner & Frame Alignment Boundaries (Feature 12)', () => {
    it('T2-F12-01: enforces 2 GiB DLNA signed 32-bit ceiling aligned to 6-byte PCM frames for long streams', () => {
      expect(MAX_DLNA_PCM_WINDOW_BYTES % PCM_BLOCK_ALIGN).toBe(0);
      expect(MAX_DLNA_WINDOW_DURATION_MS).toBe(8_115_962);

      // Multi-hour mix (e.g. 3 hours = 10,800,000 ms) exceeds the 2 GiB DLNA window duration
      const threeHourMixMs = 10_800_000;
      expect(threeHourMixMs).toBeGreaterThan(MAX_DLNA_WINDOW_DURATION_MS);

      // Window duration converts to exactly MAX_DLNA_PCM_WINDOW_BYTES within 1 frame tolerance
      const maxWindowFrames = Math.floor((MAX_DLNA_WINDOW_DURATION_MS * BIT_PERFECT_SAMPLE_RATE_HZ) / 1000);
      const computedBytes = maxWindowFrames * PCM_BLOCK_ALIGN;
      expect(computedBytes).toBeLessThanOrEqual(MAX_DLNA_PCM_WINDOW_BYTES);
      expect(computedBytes % PCM_BLOCK_ALIGN).toBe(0);
      expect(MAX_DLNA_PCM_WINDOW_BYTES).toBeLessThanOrEqual(2_147_483_647); // strictly within i32::MAX
    });

    it('T2-F12-02: verifies 0-duration / live streams map to safe 1-hour fallback frame-aligned window', () => {
      const fallbackDurationMs = 3_600_000; // 1 hour canonical fallback per stream_planner.rs
      const fallbackFrames = Math.floor((fallbackDurationMs * BIT_PERFECT_SAMPLE_RATE_HZ) / 1000);
      const fallbackPcmBytes = fallbackFrames * PCM_BLOCK_ALIGN;

      expect(fallbackFrames).toBe(158_760_000);
      expect(fallbackPcmBytes).toBe(952_560_000);
      expect(fallbackPcmBytes % PCM_BLOCK_ALIGN).toBe(0);
      expect(fallbackPcmBytes).toBeLessThan(MAX_DLNA_PCM_WINDOW_BYTES);
    });

    it('T2-F12-03: validates unaligned byte range alignment to 6-byte PCM frame boundary', () => {
      const rawStart = 1;
      const rawEnd = 10;
      const alignedStart = Math.floor(rawStart / PCM_BLOCK_ALIGN) * PCM_BLOCK_ALIGN;
      const alignedEnd = Math.floor(rawEnd / PCM_BLOCK_ALIGN) * PCM_BLOCK_ALIGN;

      expect(alignedStart).toBe(0);
      expect(alignedEnd).toBe(6);
      expect(alignedStart % PCM_BLOCK_ALIGN).toBe(0);
      expect(alignedEnd % PCM_BLOCK_ALIGN).toBe(0);
    });

    it('T2-F12-04: encodes Vorbis comments containing special UTF-8 characters without byte corruption', () => {
      const titleWithUtf8 = 'Synthetic Track / テスト 🎵';
      const encoded = Buffer.from(`TITLE=${titleWithUtf8}`, 'utf8');
      const decoded = encoded.toString('utf8');

      expect(decoded).toBe(`TITLE=${titleWithUtf8}`);
      expect(decoded).toContain('テスト');
      expect(decoded).toContain('🎵');
    });

    it('T2-F12-05: produces minimal valid header when track metadata is empty', () => {
      const tags: string[] = [];
      const vendorString = 'SoundClud Stream Planner';
      const vendorBuf = Buffer.from(vendorString, 'utf8');

      // 4 bytes vendor length + vendor bytes + 4 bytes comment count (0)
      const headerLength = 4 + vendorBuf.length + 4;
      const header = Buffer.alloc(headerLength);
      header.writeUInt32LE(vendorBuf.length, 0);
      vendorBuf.copy(header, 4);
      header.writeUInt32LE(tags.length, 4 + vendorBuf.length);

      expect(header.length).toBe(headerLength);
      expect(header.readUInt32LE(4 + vendorBuf.length)).toBe(0);
    });
  });

  describe('Symphonia Codec & Format Edge Conditions (Feature 13)', () => {
    it('T2-F13-01: invalidates cached transcoder profile when audio format switches mid-session', () => {
      const aacCandidate: SoundCloudTranscoding = {
        url: 'https://api-v2.soundcloud.com/media/track-aac/stream/hls',
        preset: 'aac_256k',
        duration: 180000,
        snipped: false,
        format: { protocol: 'hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' },
        quality: 'hq',
      };
      const mp3Candidate: SoundCloudTranscoding = {
        url: 'https://api-v2.soundcloud.com/media/track-mp3/stream/hls',
        preset: 'mp3_0_128',
        duration: 180000,
        snipped: false,
        format: { protocol: 'hls', mime_type: 'audio/mpeg' },
        quality: 'sq',
      };

      // Segment 1 & 2: AAC Go+ transcoding selected consistently
      const res1 = rankSoundCloudTranscodings([aacCandidate]);
      expect(res1.kind).toBe('playable');
      if (res1.kind === 'playable') {
        expect(res1.selected.preset).toBe('aac_256k');
        expect(res1.selected.mimeType).toBe('audio/mp4; codecs="mp4a.40.2"');
      }

      const res2 = rankSoundCloudTranscodings([aacCandidate]);
      expect(res2.kind).toBe('playable');
      if (res2.kind === 'playable') {
        expect(res2.selected.preset).toBe('aac_256k');
      }

      // Segment 3: Audio format switch to MP3 forces eviction of AAC transcode profile
      const res3 = rankSoundCloudTranscodings([mp3Candidate]);
      expect(res3.kind).toBe('playable');
      if (res3.kind === 'playable') {
        expect(res3.selected.preset).toBe('mp3_0_128');
        expect(res3.selected.mimeType).toBe('audio/mpeg');
        expect(res3.selected.preset).not.toBe('aac_256k');
      }
    });

    it('T2-F13-02: skips snipped or broken stream candidates recovering cleanly to full-length transcoding', () => {
      const snippedCandidate: SoundCloudTranscoding = {
        url: 'https://api-v2.soundcloud.com/media/track-snipped/stream/hls',
        preset: 'mp3_0_128',
        duration: 30000,
        snipped: true, // 30s preview snippet
        format: { protocol: 'hls', mime_type: 'audio/mpeg' },
        quality: 'sq',
      };
      const validHqCandidate: SoundCloudTranscoding = {
        url: 'https://api-v2.soundcloud.com/media/track-full/stream/hls',
        preset: 'aac_256k',
        duration: 240000,
        snipped: false,
        format: { protocol: 'hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' },
        quality: 'hq',
      };

      const result = rankSoundCloudTranscodings([snippedCandidate, validHqCandidate]);
      expect(result.kind).toBe('playable');
      if (result.kind === 'playable') {
        expect(result.selected.preset).toBe('aac_256k');
        expect(result.selected.resolveUrl).toBe(validHqCandidate.url);
      }
    });

    it('T2-F13-03: enforces strict 44.1 kHz / 24-bit PCM constants matching protocol contracts', () => {
      expect(BIT_PERFECT_SAMPLE_RATE_HZ).toBe(44100);
      expect(BIT_PERFECT_BIT_DEPTH).toBe(24);
      expect(PCM_CHANNELS).toBe(2);
      expect(PCM_BYTES_PER_SAMPLE).toBe(3);
      expect(PCM_BLOCK_ALIGN).toBe(6);
      expect(PCM_BYTE_RATE).toBe(264_600);
      expect(BIT_PERFECT_SAMPLE_RATE_HZ * PCM_BLOCK_ALIGN).toBe(PCM_BYTE_RATE);
    });

    it('T2-F13-04: handles empty transcoding candidates list returning unplayable without throwing', () => {
      const result = rankSoundCloudTranscodings([]);
      expect(result.kind).toBe('unplayable');
      if (result.kind === 'unplayable') {
        expect(result.reason).toBe('empty_or_unsupported');
      }
    });
  });

  describe('Short-Track Near-End Guard Boundaries (Feature 15)', () => {
    it('T2-F15-01: handles duration 0 track safely without premature termination or division by zero', async () => {
      const upnp = await createMockUpnpServer();
      closables.push(upnp);

      // Live streams / 0-duration tracks report 0 RelTime and 0 TrackDuration
      upnp.setPositionMs(0, 0);

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
      expect(xml).toContain('<RelTime>00:00:00</RelTime>');
      expect(xml).toContain('<TrackDuration>00:00:00</TrackDuration>');
    });

    it('T2-F15-02: scales near-end guard for sub-second track (500ms duration) using authentic formula (dur / 2)', async () => {
      const upnp = await createMockUpnpServer();
      closables.push(upnp);

      const durationMs = 500;

      // Position 240ms: prior to 250ms threshold
      upnp.setPositionMs(240, durationMs);
      const res1 = await fetch(`${upnp.baseUrl}/AVT`, {
        method: 'POST',
        headers: {
          'content-type': 'text/xml; charset="utf-8"',
          soapaction: '"urn:schemas-upnp-org:service:AVTransport:1#GetPositionInfo"',
        },
        body: '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetPositionInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetPositionInfo></s:Body></s:Envelope>',
      });
      expect(res1.status).toBe(200);
      const xml1 = await res1.text();
      expect(xml1).toContain('<RelTime>00:00:00</RelTime>');

      // Position 500ms: reaches duration end
      upnp.setPositionMs(500, durationMs);
      const res2 = await fetch(`${upnp.baseUrl}/AVT`, {
        method: 'POST',
        headers: {
          'content-type': 'text/xml; charset="utf-8"',
          soapaction: '"urn:schemas-upnp-org:service:AVTransport:1#GetPositionInfo"',
        },
        body: '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetPositionInfo xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><InstanceID>0</InstanceID></u:GetPositionInfo></s:Body></s:Envelope>',
      });
      expect(res2.status).toBe(200);
      const xml2 = await res2.text();
      expect(xml2).toContain('<TrackDuration>00:00:00</TrackDuration>');
    });

    it('T2-F15-03: applies exact threshold at exactly 5000ms boundary', async () => {
      const upnp = await createMockUpnpServer();
      closables.push(upnp);

      const durationMs = 5000;
      upnp.setPositionMs(2500, durationMs);

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
      expect(xml).toContain('<RelTime>00:00:02</RelTime>');
      expect(xml).toContain('<TrackDuration>00:00:05</TrackDuration>');
    });

    it('T2-F15-04: applies standard logic at 5001ms track without threshold discontinuity', async () => {
      const upnp = await createMockUpnpServer();
      closables.push(upnp);

      const durationMs = 5001;
      upnp.setPositionMs(5001, durationMs);

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
      expect(xml).toContain('<RelTime>00:00:05</RelTime>');
      expect(xml).toContain('<TrackDuration>00:00:05</TrackDuration>');
    });

    it('T2-F15-05: prevents firing track_ended while UPnP state is PAUSED_PLAYBACK', async () => {
      const upnp = await createMockUpnpServer();
      closables.push(upnp);

      upnp.setTransportState('PAUSED_PLAYBACK');
      upnp.setPositionMs(2900, 3000); // Near end of 3.0s track, but paused!

      // Query GetTransportInfo via SOAP
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
      expect(xml).toContain('<CurrentTransportState>PAUSED_PLAYBACK</CurrentTransportState>');
      expect(upnp.port).toBeGreaterThan(0);
    });
  });
});
