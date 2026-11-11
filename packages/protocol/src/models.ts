/**
 * Hardware master volume models and contracts (`v1`).
 *
 * Defines models for remote HEOS amplifier hardware master volume control,
 * preserving 0 dB Bit-Perfect audio streaming with zero digital gain attenuation.
 */

import type { PROTOCOL_VERSION } from './constants.js';
import type { OutputDevice } from './outputs.js';

export type DiscoveredOutput = OutputDevice;

// Module augmentation: seamlessly enrich OutputCapabilities with hardware volume metadata
declare module './outputs.js' {
  interface OutputCapabilities {
    readonly supportsHardwareVolume?: boolean | undefined;
    readonly volumeMinLevel?: number | undefined;
    readonly volumeMaxLevel?: number | undefined;
    readonly volumeStep?: number | undefined;
  }
}

export const API_V1_AUDIO_VOLUME_PATH = '/api/v1/audio/volume' as const;

export interface VolumeStatus {
  readonly volume: number;
  readonly muted: boolean;
  readonly supportsHardwareVolume: boolean;
  readonly outputId?: string | undefined;
}

export interface GetVolumeResponse {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly volume: number;
  readonly muted: boolean;
  readonly supportsHardwareVolume: boolean;
  readonly outputId?: string | undefined;
}

export interface SetVolumeRequest {
  readonly volume?: number | undefined;
  readonly muted?: boolean | undefined;
  readonly outputId?: string | undefined;
}

export interface SetVolumeResponse {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly volume: number;
  readonly muted: boolean;
  readonly supportsHardwareVolume: boolean;
}
