/**
 * WebSocket `/api/v1/ws` full-duplex discriminated union contracts (`v1`).
 *
 * Tagged on `type` in `snake_case` with `camelCase` inner fields, matching
 * Rust `#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]`.
 */

import { PROTOCOL_VERSION } from './constants.js';
import type { OutputDevice } from './outputs.js';
import type { StreamLocatorPayload } from './soundcloud.js';
import type { PlaybackTelemetry, ReceiverConfig } from './telemetry.js';

export const STOP_REASONS = [
  'user_stop',
  'handoff_disabled',
  'drm_local_fallback',
  'tab_closed',
] as const;
export type StopReason = (typeof STOP_REASONS)[number];

export const REFRESH_LOCATOR_REASONS = [
  'cloudfront_expired',
  'upstream_403',
  'key_expired',
] as const;
export type RefreshLocatorReason = (typeof REFRESH_LOCATOR_REASONS)[number];

export interface HelloWsCommand {
  readonly type: 'hello';
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly pairingToken: string;
  readonly controllerId: string;
  readonly clientLabel: string;
}

export interface LoadTrackWsCommand {
  readonly type: 'load_track';
  readonly commandSeq: number;
  readonly locator: StreamLocatorPayload;
  readonly preferredOutputId?: string;
}

export interface SetPausedWsCommand {
  readonly type: 'set_paused';
  readonly commandSeq: number;
  readonly paused: boolean;
}

export interface SeekWsCommand {
  readonly type: 'seek';
  readonly commandSeq: number;
  readonly positionMs: number;
}

export interface PreloadNextWsCommand {
  readonly type: 'preload_next';
  readonly commandSeq: number;
  readonly locator: StreamLocatorPayload;
}

export interface StopWsCommand {
  readonly type: 'stop';
  readonly commandSeq: number;
  readonly reason?: StopReason;
}

export interface SelectOutputWsCommand {
  readonly type: 'select_output';
  readonly commandSeq: number;
  readonly outputId: string;
}

export interface RefreshLocatorResponseWsCommand {
  readonly type: 'refresh_locator_response';
  readonly requestId: string;
  readonly locator?: StreamLocatorPayload;
  readonly error?: string;
}

export interface PingWsCommand {
  readonly type: 'ping';
  readonly clientTimestampMs: number;
}

export type ClientWsCommand =
  | HelloWsCommand
  | LoadTrackWsCommand
  | SetPausedWsCommand
  | SeekWsCommand
  | PreloadNextWsCommand
  | StopWsCommand
  | SelectOutputWsCommand
  | RefreshLocatorResponseWsCommand
  | PingWsCommand;

export type ClientWsCommandType = ClientWsCommand['type'];

export interface WelcomeWsEvent {
  readonly type: 'welcome';
  readonly protocolVersion: typeof PROTOCOL_VERSION;
  readonly receiverId: string;
  readonly receiverName: string;
  readonly controllerId: string;
  readonly config: ReceiverConfig;
  readonly telemetry: PlaybackTelemetry;
  readonly outputs: readonly OutputDevice[];
}

export interface StateTickWsEvent {
  readonly type: 'state_tick';
  readonly lastAckedCommandSeq: number;
  readonly telemetry: PlaybackTelemetry;
}

export interface OutputsUpdatedWsEvent {
  readonly type: 'outputs_updated';
  readonly activeOutputId?: string;
  readonly outputs: readonly OutputDevice[];
}

export interface TrackEndedWsEvent {
  readonly type: 'track_ended';
  readonly trackId: string;
  readonly locatorId: string;
}

export interface RefreshLocatorRequestWsEvent {
  readonly type: 'refresh_locator_request';
  readonly requestId: string;
  readonly trackId: string;
  readonly locatorId: string;
  readonly reason: RefreshLocatorReason;
}

export interface SessionClaimedWsEvent {
  readonly type: 'session_claimed';
  readonly newControllerId: string;
  readonly newClientLabel: string;
}

export interface ErrorWsEvent {
  readonly type: 'error';
  readonly code: string;
  readonly message: string;
  readonly commandSeq?: number;
}

export interface PongWsEvent {
  readonly type: 'pong';
  readonly clientTimestampMs: number;
  readonly serverTimestampMs: number;
}

export type ServerWsEvent =
  | WelcomeWsEvent
  | StateTickWsEvent
  | OutputsUpdatedWsEvent
  | TrackEndedWsEvent
  | RefreshLocatorRequestWsEvent
  | SessionClaimedWsEvent
  | ErrorWsEvent
  | PongWsEvent;

export type ServerWsEventType = ServerWsEvent['type'];
