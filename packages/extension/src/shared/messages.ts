/**
 * Typed IPC contracts across the 3 Chromium Manifest V3 execution worlds:
 * `MAIN` <-> `ISOLATED` (nonce-verified `CustomEvent`) <-> `Service Worker` & `Popup`.
 */

import type {
  AccountTier,
  OutputDevice,
  PlaybackTelemetry,
  RefreshLocatorReason,
  StopReason,
  StreamLocatorPayload,
} from '@soundclud/protocol';

export type ReceiverConnectionState =
  | 'disconnected'
  | 'discovering'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'session_claimed'
  | 'error';

export interface DiscoveredReceiverRecord {
  readonly endpointBaseUrl: string;
  readonly host: string;
  readonly port: number;
  readonly isLoopback: boolean;
  readonly receiverId: string;
  readonly receiverName: string;
  readonly requiresPairing: boolean;
  readonly activeOutputId?: string | undefined;
  readonly outputs: readonly OutputDevice[];
  readonly discoveredAtMs: number;
}

export interface DiscoveredOutputEntry {
  readonly compositeKey: string;
  readonly endpointBaseUrl: string;
  readonly receiverId: string;
  readonly receiverName: string;
  readonly isLoopback: boolean;
  readonly output: OutputDevice;
}

export interface StoredSessionAuth {
  readonly clientId: string;
  readonly oauthToken?: string | undefined;
  readonly accountTier: AccountTier;
  readonly updatedAtMs: number;
}

export interface DrmFallbackNotice {
  readonly trackId: string;
  readonly title: string;
  readonly artist: string;
}

export interface ExtensionUiSnapshot {
  readonly handoffEnabled: boolean;
  readonly connectionState: ReceiverConnectionState;
  readonly activeEndpointBaseUrl: string | null;
  readonly activeReceiverId: string | null;
  readonly activeReceiverName: string | null;
  readonly activeOutputId: string | null;
  readonly activeOutput: OutputDevice | null;
  readonly seekDebounceMs: number;
  readonly outputs: readonly DiscoveredOutputEntry[];
  readonly knownEndpoints: readonly string[];
  readonly telemetry: PlaybackTelemetry | null;
  readonly lastAckedCommandSeq: number;
  readonly accountTier: AccountTier;
  readonly drmFallback: DrmFallbackNotice | null;
  readonly lastError: string | null;
}

export type MainToIsolatedMessage =
  | {
      readonly type: 'session_auth_observed';
      readonly clientId: string;
      readonly oauthToken?: string | undefined;
      readonly accountTier: AccountTier;
    }
  | {
      readonly type: 'request_load_track';
      readonly commandSeq: number;
      readonly locator: StreamLocatorPayload;
    }
  | {
      readonly type: 'request_set_paused';
      readonly commandSeq: number;
      readonly paused: boolean;
    }
  | {
      readonly type: 'request_seek';
      readonly commandSeq: number;
      readonly positionMs: number;
    }
  | {
      readonly type: 'request_preload_next';
      readonly commandSeq: number;
      readonly locator: StreamLocatorPayload;
    }
  | {
      readonly type: 'request_stop';
      readonly commandSeq: number;
      readonly reason: StopReason;
    }
  | {
      readonly type: 'drm_local_fallback_active';
      readonly trackId: string;
      readonly title: string;
      readonly artist: string;
    }
  | {
      readonly type: 'drm_local_fallback_cleared';
    }
  | {
      readonly type: 'refresh_locator_result';
      readonly requestId: string;
      readonly locator?: StreamLocatorPayload | undefined;
      readonly error?: string | undefined;
    };

export type IsolatedToMainMessage =
  | {
      readonly type: 'sync_runtime_state';
      readonly handoffEnabled: boolean;
      readonly seekDebounceMs: number;
      readonly connectionState: ReceiverConnectionState;
      readonly activeOutput?: OutputDevice | undefined;
      readonly telemetry?: PlaybackTelemetry | undefined;
      readonly lastAckedCommandSeq: number;
    }
  | {
      readonly type: 'telemetry_tick';
      readonly telemetry: PlaybackTelemetry;
      readonly lastAckedCommandSeq: number;
    }
  | {
      readonly type: 'track_ended';
      readonly trackId: string;
      readonly locatorId: string;
    }
  | {
      readonly type: 'refresh_locator_request';
      readonly requestId: string;
      readonly trackId: string;
      readonly locatorId: string;
      readonly reason: RefreshLocatorReason;
    }
  | {
      readonly type: 'session_claimed';
      readonly newControllerId: string;
      readonly newClientLabel: string;
    };

export type ExtensionRuntimeRequest =
  | { readonly type: 'get_ui_snapshot' }
  | { readonly type: 'discover_outputs'; readonly force?: boolean | undefined }
  | { readonly type: 'set_handoff_enabled'; readonly enabled: boolean }
  | {
      readonly type: 'select_output';
      readonly endpointBaseUrl: string;
      readonly receiverId: string;
      readonly outputId: string;
    }
  | { readonly type: 'add_manual_endpoint'; readonly rawEndpoint: string }
  | { readonly type: 'remove_manual_endpoint'; readonly endpointBaseUrl: string }
  | {
      readonly type: 'forward_main_message';
      readonly message: MainToIsolatedMessage;
    };

export type ExtensionRuntimeResponse =
  | { readonly ok: true; readonly snapshot: ExtensionUiSnapshot }
  | { readonly ok: false; readonly error: string; readonly snapshot?: ExtensionUiSnapshot | undefined };

export type ServiceWorkerBroadcastMessage =
  | { readonly type: 'ui_snapshot_updated'; readonly snapshot: ExtensionUiSnapshot }
  | { readonly type: 'forward_to_main'; readonly message: IsolatedToMainMessage };

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
