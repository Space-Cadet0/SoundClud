/**
 * Playback state, active stream codec telemetry, and receiver configuration
 * contracts (`v1`).
 */

import {
  BIT_PERFECT_BIT_DEPTH,
  BIT_PERFECT_GAIN_DB,
  BIT_PERFECT_SAMPLE_RATE_HZ,
  PROTOCOL_VERSION,
} from './constants.js';
import type { OutputDeviceKind, VolumeControlMode } from './outputs.js';
import type {
  AccountTier,
  PlayableProtocol,
  StreamQualityTier,
  TrackMetadata,
} from './soundcloud.js';

export const PLAYBACK_PHASES = [
  'idle',
  'waking_device',
  'loading',
  'playing',
  'paused',
  'buffering',
  'drm_local_fallback',
  'error',
] as const;

export type PlaybackPhase = (typeof PLAYBACK_PHASES)[number];

export interface ActiveStreamTelemetry {
  readonly preset: string;
  readonly quality: StreamQualityTier;
  readonly protocol: PlayableProtocol;
  readonly bitrateKbps: number;
  readonly accountTier: AccountTier;
  readonly hlsRefreshCount: number;
}

export interface PlaybackTelemetry {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly serverSeq: number;
  readonly phase: PlaybackPhase;
  readonly activeOutputId?: string;
  readonly activeBackend?: OutputDeviceKind;
  readonly volumeMode: VolumeControlMode;
  readonly fixedGainDb: typeof BIT_PERFECT_GAIN_DB;
  readonly sampleRateHz: typeof BIT_PERFECT_SAMPLE_RATE_HZ;
  readonly bitDepth: typeof BIT_PERFECT_BIT_DEPTH;
  readonly positionMs: number;
  readonly durationMs: number;
  readonly bufferedMs: number;
  readonly track?: TrackMetadata;
  readonly streamInfo?: ActiveStreamTelemetry;
  readonly activeControllerId?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly timestampMs: number;
}

export interface ReceiverConfig {
  readonly activeOutputId?: string;
  readonly volumeMode: VolumeControlMode;
  readonly opticalIdleKeepalive: boolean;
  readonly opticalDitherSubaudible: boolean;
}
