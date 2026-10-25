/**
 * SoundCloud Go+ stream-locator, transcoding descriptor, and ephemeral session
 * authentication contracts (`v1`).
 */

export const ACCOUNT_TIERS = ['go_plus', 'free', 'anonymous'] as const;
export type AccountTier = (typeof ACCOUNT_TIERS)[number];

export const PLAYABLE_PROTOCOLS = ['hls', 'encrypted-hls', 'progressive'] as const;
export type PlayableProtocol = (typeof PLAYABLE_PROTOCOLS)[number];

export const DRM_PROTOCOLS = ['ctr-encrypted-hls', 'cbc-encrypted-hls'] as const;
export type DrmProtocol = (typeof DRM_PROTOCOLS)[number];

export const STREAM_QUALITY_TIERS = ['hq', 'sq'] as const;
export type StreamQualityTier = (typeof STREAM_QUALITY_TIERS)[number];

export const SOURCE_SAMPLE_RATES_HZ = [44100, 48000] as const;
export type SourceSampleRateHz = (typeof SOURCE_SAMPLE_RATES_HZ)[number];

export interface SoundCloudTranscodingFormat {
  readonly protocol: string;
  readonly mime_type: string;
}

/**
 * Raw item from SoundCloud `api-v2` `media.transcodings[]`.
 */
export interface SoundCloudTranscoding {
  readonly url: string;
  readonly preset: string;
  readonly duration: number;
  readonly snipped?: boolean;
  readonly format: SoundCloudTranscodingFormat;
  readonly quality?: string;
}

/**
 * Normalized, ranked playable transcoding forwarded to `soundclud-receiver`.
 */
export interface SelectedTranscodingDescriptor {
  readonly resolveUrl: string;
  readonly preset: string;
  readonly protocol: PlayableProtocol;
  readonly mimeType: string;
  readonly quality: StreamQualityTier;
  readonly bitrateKbps: number;
  readonly sampleRateHz: SourceSampleRateHz;
  readonly initialPlaylistUrl?: string;
}

/**
 * Ephemeral in-RAM session credentials piggybacked from the user's active
 * `soundcloud.com` tab. Never persisted to disk and strictly origin-scoped
 * to `SOUNDCLOUD_API_ORIGINS`.
 */
export interface EphemeralSoundCloudAuth {
  readonly clientId: string;
  readonly oauthToken?: string;
  readonly trackAuthorization?: string;
  readonly secretToken?: string;
  readonly accountTier: AccountTier;
}

export interface TrackMetadata {
  readonly trackId: string;
  readonly permalinkUrl: string;
  readonly title: string;
  readonly artist: string;
  readonly artworkUrl?: string;
  readonly durationMs: number;
  readonly waveformUrl?: string;
}

export interface StreamLocatorPayload {
  readonly locatorId: string;
  readonly track: TrackMetadata;
  readonly selected: SelectedTranscodingDescriptor;
  readonly fallbackTranscodings: readonly SelectedTranscodingDescriptor[];
  readonly auth: EphemeralSoundCloudAuth;
  readonly startPositionMs: number;
}

export function isPlayableProtocol(protocol: string): protocol is PlayableProtocol {
  return (
    protocol === 'hls' || protocol === 'encrypted-hls' || protocol === 'progressive'
  );
}

export function isDrmProtocol(protocol: string): protocol is DrmProtocol {
  return protocol === 'ctr-encrypted-hls' || protocol === 'cbc-encrypted-hls';
}
