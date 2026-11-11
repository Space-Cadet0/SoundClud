import {
  BIT_PERFECT_BIT_DEPTH,
  BIT_PERFECT_GAIN_DB,
  BIT_PERFECT_SAMPLE_RATE_HZ,
  HEOS_SEEK_DEBOUNCE_MS,
  TOSLINK_SEEK_DEBOUNCE_MS,
  type OutputDevice,
  type StreamLocatorPayload,
} from '@soundclud/protocol';

export const SYNTHETIC_PAIRING_TOKEN = 'synth-pairing-token-abc123xyz789';
export const SYNTHETIC_RECEIVER_ID = 'synth-receiver-01';
export const SYNTHETIC_RECEIVER_NAME = 'Synthetic Reference Receiver';

export const SYNTHETIC_OUTPUT_HEOS: OutputDevice = {
  id: 'heos_upnp:PM7000N',
  kind: 'heos_upnp',
  name: 'Marantz PM7000N',
  model: 'PM7000N',
  transport: 'heos_lan_wav',
  isRecommendedDefault: true,
  isAvailable: true,
  standbyState: 'off',
  capabilities: {
    bitPerfect: true,
    fixedGainDb: BIT_PERFECT_GAIN_DB,
    targetSampleRateHz: BIT_PERFECT_SAMPLE_RATE_HZ,
    targetBitDepth: BIT_PERFECT_BIT_DEPTH,
    autoWakeFromStandby: true,
    displaysTrackMetadataOnDevice: true,
    seekDebounceMs: HEOS_SEEK_DEBOUNCE_MS,
    supportsHardwareVolume: true,
    volumeMinLevel: 0,
    volumeMaxLevel: 100,
    volumeStep: 1,
  },
};

export const SYNTHETIC_OUTPUT_TOSLINK: OutputDevice = {
  id: 'coreaudio:spdf',
  kind: 'coreaudio',
  name: 'Optical S/PDIF (TOSLINK)',
  model: 'Built-in Output',
  transport: 'optical_toslink',
  isRecommendedDefault: false,
  isAvailable: true,
  standbyState: 'unknown',
  capabilities: {
    bitPerfect: true,
    fixedGainDb: BIT_PERFECT_GAIN_DB,
    targetSampleRateHz: BIT_PERFECT_SAMPLE_RATE_HZ,
    targetBitDepth: BIT_PERFECT_BIT_DEPTH,
    autoWakeFromStandby: false,
    displaysTrackMetadataOnDevice: false,
    seekDebounceMs: TOSLINK_SEEK_DEBOUNCE_MS,
    supportsHardwareVolume: false,
  },
};

export const SYNTHETIC_DISCOVERED_OUTPUTS: readonly OutputDevice[] = [
  SYNTHETIC_OUTPUT_HEOS,
  SYNTHETIC_OUTPUT_TOSLINK,
];

export interface SyntheticTrackFixture {
  readonly id: number;
  readonly title: string;
  readonly artist: string;
  readonly durationMs: number;
  readonly locator: StreamLocatorPayload;
}

export function createSyntheticTrackFixture(
  id = 1001,
  durationMs = 180000,
  streamUrl = 'http://127.0.0.1:0/playlist.m3u8',
): SyntheticTrackFixture {
  const trackIdStr = String(id);
  const title = `Synthetic Title ${trackIdStr}`;
  const artist = `Synthetic Artist ${trackIdStr}`;

  return {
    id,
    title,
    artist,
    durationMs,
    locator: {
      locatorId: `loc-${trackIdStr}`,
      track: {
        trackId: trackIdStr,
        permalinkUrl: `https://soundcloud.com/synthetic-artist/track-${trackIdStr}`,
        title,
        artist,
        durationMs,
      },
      selected: {
        resolveUrl: `https://api.soundcloud.com/media/transcodings/hls-${trackIdStr}`,
        preset: 'aac_256k',
        protocol: 'hls',
        mimeType: 'audio/mp4; codecs="mp4a.40.2"',
        quality: 'hq',
        bitrateKbps: 256,
        sampleRateHz: 44100,
        initialPlaylistUrl: streamUrl,
      },
      fallbackTranscodings: [],
      auth: {
        clientId: 'synthetic-client-id-xyz',
        accountTier: 'go_plus',
      },
      startPositionMs: 0,
    },
  };
}
