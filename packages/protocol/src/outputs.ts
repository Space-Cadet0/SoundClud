/**
 * Unified output device and hardware capability contracts (`v1`).
 *
 * Covers both `LocalMpvBackend` (CoreAudio / TOSLINK S/PDIF / ALSA) and
 * `HeosUpnpBackend` (Denon/Marantz HEOS Direct Network UPnP WAV), strictly
 * locked to `0 dB` bit-perfect `44,100 Hz / 24-bit` PCM output.
 */

import {
  BIT_PERFECT_BIT_DEPTH,
  BIT_PERFECT_GAIN_DB,
  BIT_PERFECT_SAMPLE_RATE_HZ,
  HEOS_SEEK_DEBOUNCE_MS,
  TOSLINK_SEEK_DEBOUNCE_MS,
} from './constants.js';

export const OUTPUT_DEVICE_KINDS = ['coreaudio', 'alsa', 'heos_upnp'] as const;
export type OutputDeviceKind = (typeof OUTPUT_DEVICE_KINDS)[number];

export const OUTPUT_TRANSPORTS = [
  'optical_toslink',
  'local_dac',
  'alsa_hw',
  'heos_lan_wav',
] as const;
export type OutputTransport = (typeof OUTPUT_TRANSPORTS)[number];

export const VOLUME_CONTROL_MODES = ['bit_perfect'] as const;
export type VolumeControlMode = (typeof VOLUME_CONTROL_MODES)[number];

export const STANDBY_STATES = ['on', 'off', 'unknown'] as const;
export type StandbyState = (typeof STANDBY_STATES)[number];

export interface OutputCapabilities {
  readonly bitPerfect: true;
  readonly fixedGainDb: typeof BIT_PERFECT_GAIN_DB;
  readonly targetSampleRateHz: typeof BIT_PERFECT_SAMPLE_RATE_HZ;
  readonly targetBitDepth: typeof BIT_PERFECT_BIT_DEPTH;
  readonly autoWakeFromStandby: boolean;
  readonly displaysTrackMetadataOnDevice: boolean;
  readonly seekDebounceMs: number;
}

export interface OutputDevice {
  readonly id: string;
  readonly kind: OutputDeviceKind;
  readonly name: string;
  readonly model?: string;
  readonly transport: OutputTransport;
  readonly isRecommendedDefault: boolean;
  readonly isAvailable: boolean;
  readonly standbyState?: StandbyState;
  readonly capabilities: OutputCapabilities;
}

/**
 * Returns the canonical scrub debounce window in milliseconds for an output backend kind.
 */
export function getDefaultSeekDebounceMs(kind: OutputDeviceKind): number {
  switch (kind) {
    case 'heos_upnp':
      return HEOS_SEEK_DEBOUNCE_MS;
    case 'coreaudio':
    case 'alsa':
      return TOSLINK_SEEK_DEBOUNCE_MS;
  }
}
