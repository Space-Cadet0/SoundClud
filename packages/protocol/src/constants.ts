/**
 * Canonical protocol version, discovery, transport, and bit-perfect audio constants
 * shared between `@soundclud/extension` and `crates/receiver`.
 */

export const PROTOCOL_VERSION = 'v1' as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

export const DEFAULT_DISCOVERY_PORT = 9876 as const;
export const MDNS_SERVICE_TYPE = '_soundclud._tcp.local.' as const;

export const HEOS_CLI_DEFAULT_PORT = 1255 as const;
export const HEOS_UPNP_DEFAULT_PORT = 60006 as const;

export const BIT_PERFECT_SAMPLE_RATE_HZ = 44100 as const;
export const BIT_PERFECT_BIT_DEPTH = 24 as const;
export const BIT_PERFECT_GAIN_DB = 0 as const;

export const TOSLINK_SEEK_DEBOUNCE_MS = 60 as const;
export const HEOS_SEEK_DEBOUNCE_MS = 180 as const;

export const SOUNDCLOUD_API_ORIGINS = [
  'https://api-v2.soundcloud.com',
  'https://api.soundcloud.com',
] as const;

export type SoundCloudApiOrigin = (typeof SOUNDCLOUD_API_ORIGINS)[number];

export const API_V1_DISCOVER_PATH = '/api/v1/discover' as const;
export const API_V1_PAIR_PATH = '/api/v1/pair' as const;
export const API_V1_AUDIO_DEVICES_PATH = '/api/v1/audio/devices' as const;
export const API_V1_CONFIG_PATH = '/api/v1/config' as const;
export const API_V1_STATUS_PATH = '/api/v1/status' as const;
export const API_V1_WS_PATH = '/api/v1/ws' as const;
