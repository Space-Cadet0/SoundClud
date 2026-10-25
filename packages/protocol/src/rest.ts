/**
 * HTTP REST `/api/v1/*` request and response contracts (`v1`).
 *
 * Uses camelCase JSON keys matching Rust `#[serde(rename_all = "camelCase")]`.
 */

import { PROTOCOL_VERSION } from './constants.js';
import type { OutputDevice } from './outputs.js';
import type { PlaybackTelemetry, ReceiverConfig } from './telemetry.js';

export const RECEIVER_PLATFORMS = ['macos', 'linux', 'other'] as const;
export type ReceiverPlatform = (typeof RECEIVER_PLATFORMS)[number];

export const RECEIVER_ARCHES = ['x86_64', 'aarch64', 'other'] as const;
export type ReceiverArch = (typeof RECEIVER_ARCHES)[number];

export interface PeerReceiverSummary {
  readonly receiverId: string;
  readonly receiverName: string;
  readonly host: string;
  readonly port: number;
  readonly protocolVersion: typeof PROTOCOL_VERSION;
}

export interface DiscoverResponse {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly receiverId: string;
  readonly receiverName: string;
  readonly platform: ReceiverPlatform;
  readonly arch: ReceiverArch;
  readonly requiresPairing: boolean;
  readonly outputs: readonly OutputDevice[];
  readonly peers: readonly PeerReceiverSummary[];
  readonly config: ReceiverConfig;
}

export interface PairRequest {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly clientLabel: string;
  readonly controllerId: string;
}

export interface PairResponse {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly receiverId: string;
  readonly pairingToken: string;
}

export interface AudioDevicesResponse {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly activeOutputId?: string;
  readonly outputs: readonly OutputDevice[];
}

export interface UpdateConfigRequest {
  readonly activeOutputId?: string;
  readonly opticalIdleKeepalive?: boolean;
  readonly opticalDitherSubaudible?: boolean;
}

export interface UpdateConfigResponse {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly config: ReceiverConfig;
  readonly outputs: readonly OutputDevice[];
}

export interface StatusResponse {
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly receiverId: string;
  readonly receiverName: string;
  readonly config: ReceiverConfig;
  readonly telemetry: PlaybackTelemetry;
  readonly outputs: readonly OutputDevice[];
}

export interface ApiErrorDetail {
  readonly code: string;
  readonly message: string;
}

export interface ApiErrorResponse {
  readonly error: ApiErrorDetail;
}
