/**
 * Chromium Manifest V3 Background Service Worker (`service-worker.js`).
 *
 * Registers all event listeners synchronously at top level, stores durable
 * user settings in `chrome.storage.local` and ephemeral SoundCloud auth +
 * receiver telemetry strictly in `chrome.storage.session`, and coordinates
 * parallel TOSLINK/HEOS discovery + TOFU WebSocket playback control.
 */

import type { PlaybackTelemetry } from '@soundclud/protocol';
import {
  isRecord,
  type ExtensionRuntimeRequest,
  type ExtensionRuntimeResponse,
  type ExtensionUiSnapshot,
  type IsolatedToMainMessage,
  type MainToIsolatedMessage,
  type ServiceWorkerBroadcastMessage,
} from '../shared/messages.js';
import { formatUiStatus } from '../shared/statusText.js';
import {
  deriveUiSnapshot,
  readDurableLocalConfig,
  readEphemeralSessionState,
  updateDurableLocalConfig,
  updateEphemeralSessionState,
  type ExtensionStorageAreas,
} from '../shared/storageSchema.js';
import {
  discoverReceivers,
  normalizeReceiverEndpointBaseUrl,
} from './discovery.js';
import { ReceiverWsController } from './wsController.js';

export const KEEPALIVE_ALARM_NAME = 'soundclud-ws-keepalive' as const;

export interface ServiceWorkerRuntimeDeps {
  readonly storage: ExtensionStorageAreas;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly onBroadcast?: ((msg: ServiceWorkerBroadcastMessage) => void) | undefined;
  readonly onSyncAlarm?: ((enabled: boolean) => Promise<void>) | undefined;
  readonly onUpdateBadge?: ((snapshot: ExtensionUiSnapshot) => Promise<void>) | undefined;
}

export class ExtensionBackgroundCoordinator {
  private readonly storage: ExtensionStorageAreas;
  private readonly fetchImpl: typeof fetch;
  private readonly wsController: ReceiverWsController;
  private readonly onBroadcast: ((msg: ServiceWorkerBroadcastMessage) => void) | undefined;
  private readonly onSyncAlarm: ((enabled: boolean) => Promise<void>) | undefined;
  private readonly onUpdateBadge:
    | ((snapshot: ExtensionUiSnapshot) => Promise<void>)
    | undefined;
  private discoveryInFlight: Promise<void> | null = null;

  public constructor(deps: ServiceWorkerRuntimeDeps) {
    this.storage = deps.storage;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.onBroadcast = deps.onBroadcast;
    this.onSyncAlarm = deps.onSyncAlarm;
    this.onUpdateBadge = deps.onUpdateBadge;

    this.wsController = new ReceiverWsController({
      storage: this.storage,
      fetchImpl: this.fetchImpl,
      onStateChanged: async () => {
        await this.broadcastCurrentSnapshot();
      },
      onForwardToMain: async (message: IsolatedToMainMessage) => {
        this.onBroadcast?.({ type: 'forward_to_main', message });
      },
    });
  }

  public getWsController(): ReceiverWsController {
    return this.wsController;
  }

  public async getSnapshot(): Promise<ExtensionUiSnapshot> {
    const [local, session] = await Promise.all([
      readDurableLocalConfig(this.storage.local),
      readEphemeralSessionState(this.storage.session),
    ]);
    return deriveUiSnapshot(local, session);
  }

  public async handleRequest(
    request: ExtensionRuntimeRequest,
    senderTabId?: number,
  ): Promise<ExtensionRuntimeResponse> {
    try {
      switch (request.type) {
        case 'get_ui_snapshot': {
          const snapshot = await this.getSnapshot();
          return { ok: true, snapshot };
        }

        case 'discover_outputs': {
          await this.runDiscovery();
          const snapshot = await this.getSnapshot();
          return { ok: true, snapshot };
        }

        case 'set_handoff_enabled': {
          await updateDurableLocalConfig(this.storage.local, (prev) => ({
            ...prev,
            handoffEnabled: request.enabled,
          }));
          if (!request.enabled) {
            await updateEphemeralSessionState(this.storage.session, (prev) => ({
              ...prev,
              drmFallback: null,
              lastError: null,
            }));
            await this.wsController.sendCommand({
              type: 'stop',
              commandSeq: Date.now() % 1_000_000,
              reason: 'handoff_disabled',
            });
            await this.wsController.disconnect(true);
            await this.onSyncAlarm?.(false);
          } else {
            await this.onSyncAlarm?.(true);
            const session = await readEphemeralSessionState(this.storage.session);
            if (session.discoveredReceivers.length === 0) {
              await this.runDiscovery();
            }
            await this.wsController.ensureConnected();
          }
          const snapshot = await this.broadcastCurrentSnapshot();
          return { ok: true, snapshot };
        }

        case 'select_output': {
          const local = await updateDurableLocalConfig(this.storage.local, (prev) => ({
            ...prev,
            handoffEnabled: true,
            activeEndpointBaseUrl: request.endpointBaseUrl,
            activeReceiverId: request.receiverId,
            activeOutputId: request.outputId,
          }));
          await this.onSyncAlarm?.(true);

          if (!this.wsController.isConnectedTo(request.endpointBaseUrl)) {
            await this.wsController.ensureConnected();
          } else if (local.activeOutputId !== null) {
            await this.wsController.sendCommand({
              type: 'select_output',
              commandSeq: Date.now() % 1_000_000,
              outputId: local.activeOutputId,
            });
          }

          const snapshot = await this.broadcastCurrentSnapshot();
          return { ok: true, snapshot };
        }

        case 'add_manual_endpoint': {
          const normalized = normalizeReceiverEndpointBaseUrl(request.rawEndpoint);
          if (normalized === null) {
            return {
              ok: false,
              error:
                'Enter a valid receiver address such as soundclud.local:9876 or 127.0.0.1:9876.',
            };
          }
          await updateDurableLocalConfig(this.storage.local, (prev) => ({
            ...prev,
            knownEndpoints: prev.knownEndpoints.includes(normalized)
              ? prev.knownEndpoints
              : [...prev.knownEndpoints, normalized],
            activeEndpointBaseUrl: prev.activeEndpointBaseUrl ?? normalized,
          }));
          await this.runDiscovery();
          const snapshot = await this.broadcastCurrentSnapshot();
          return { ok: true, snapshot };
        }

        case 'remove_manual_endpoint': {
          await updateDurableLocalConfig(this.storage.local, (prev) => ({
            ...prev,
            knownEndpoints: prev.knownEndpoints.filter(
              (u) => u !== request.endpointBaseUrl,
            ),
          }));
          await this.runDiscovery();
          const snapshot = await this.broadcastCurrentSnapshot();
          return { ok: true, snapshot };
        }

        case 'forward_main_message': {
          await this.handleMainWorldMessage(request.message, senderTabId);
          const snapshot = await this.broadcastCurrentSnapshot();
          return { ok: true, snapshot };
        }
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : 'Unexpected extension background error';
      const snapshot = await this.getSnapshot();
      return { ok: false, error: errorMessage, snapshot };
    }
  }

  public async handleTabClosed(tabId: number): Promise<void> {
    const session = await readEphemeralSessionState(this.storage.session);
    if (session.activeTabId === tabId) {
      await updateEphemeralSessionState(this.storage.session, (prev) => ({
        ...prev,
        activeTabId: null,
        drmFallback: null,
      }));
      await this.wsController.sendCommand({
        type: 'stop',
        commandSeq: Date.now() % 1_000_000,
        reason: 'tab_closed',
      });
    }
  }

  public async runDiscovery(): Promise<void> {
    if (this.discoveryInFlight !== null) {
      await this.discoveryInFlight;
      return;
    }

    this.discoveryInFlight = (async () => {
      const local = await readDurableLocalConfig(this.storage.local);
      const receivers = await discoverReceivers({
        knownEndpoints: local.knownEndpoints,
        activeEndpointBaseUrl: local.activeEndpointBaseUrl,
        fetchImpl: this.fetchImpl,
      });

      const firstReceiver = receivers[0];
      if (firstReceiver !== undefined && local.activeOutputId === null) {
        const defaultOutput =
          firstReceiver.outputs.find((o) => o.isRecommendedDefault && o.isAvailable) ??
          firstReceiver.outputs.find((o) => o.isAvailable) ??
          firstReceiver.outputs[0];

        await updateDurableLocalConfig(this.storage.local, (prev) => ({
          ...prev,
          activeEndpointBaseUrl:
            prev.activeEndpointBaseUrl ?? firstReceiver.endpointBaseUrl,
          activeReceiverId: prev.activeReceiverId ?? firstReceiver.receiverId,
          activeReceiverName: prev.activeReceiverName ?? firstReceiver.receiverName,
          activeOutputId: prev.activeOutputId ?? defaultOutput?.id ?? null,
        }));
      }

      await updateEphemeralSessionState(this.storage.session, (prev) => ({
        ...prev,
        discoveredReceivers: receivers,
      }));
    })();

    try {
      await this.discoveryInFlight;
    } finally {
      this.discoveryInFlight = null;
    }
  }

  private async handleMainWorldMessage(
    msg: MainToIsolatedMessage,
    senderTabId?: number,
  ): Promise<void> {
    switch (msg.type) {
      case 'session_auth_observed': {
        // Strictly persisted in `chrome.storage.session` (RAM-only, cleared on browser exit).
        await updateEphemeralSessionState(this.storage.session, (prev) => ({
          ...prev,
          scSessionAuth: {
            clientId: msg.clientId,
            oauthToken: msg.oauthToken,
            accountTier: msg.accountTier,
            updatedAtMs: Date.now(),
          },
        }));
        break;
      }

      case 'request_load_track': {
        await updateEphemeralSessionState(this.storage.session, (prev) => {
          const prevTelemetry = prev.lastTelemetry;
          const optimisticTelemetry: PlaybackTelemetry | null =
            prevTelemetry !== null
              ? {
                  protocolVersion: prevTelemetry.protocolVersion,
                  serverSeq: prevTelemetry.serverSeq,
                  phase: 'loading',
                  ...(prevTelemetry.activeOutputId !== undefined
                    ? { activeOutputId: prevTelemetry.activeOutputId }
                    : {}),
                  ...(prevTelemetry.activeBackend !== undefined
                    ? { activeBackend: prevTelemetry.activeBackend }
                    : {}),
                  volumeMode: prevTelemetry.volumeMode,
                  fixedGainDb: prevTelemetry.fixedGainDb,
                  sampleRateHz: prevTelemetry.sampleRateHz,
                  bitDepth: prevTelemetry.bitDepth,
                  positionMs: msg.locator.startPositionMs,
                  durationMs: msg.locator.track.durationMs,
                  bufferedMs: msg.locator.startPositionMs,
                  track: msg.locator.track,
                  streamInfo: {
                    preset: msg.locator.selected.preset,
                    quality: msg.locator.selected.quality,
                    protocol: msg.locator.selected.protocol,
                    bitrateKbps: msg.locator.selected.bitrateKbps,
                    accountTier: msg.locator.auth.accountTier,
                    hlsRefreshCount: 0,
                  },
                  ...(prevTelemetry.activeControllerId !== undefined
                    ? { activeControllerId: prevTelemetry.activeControllerId }
                    : {}),
                  timestampMs: Date.now(),
                }
              : null;

          return {
            ...prev,
            drmFallback: null,
            activeTabId: senderTabId ?? prev.activeTabId,
            lastTelemetry: optimisticTelemetry,
            nextCommandSeq: Math.max(prev.nextCommandSeq, msg.commandSeq),
            connectionState:
              prev.connectionState === 'session_claimed'
                ? 'connecting'
                : prev.connectionState,
          };
        });
        const local = await readDurableLocalConfig(this.storage.local);
        await this.wsController.sendCommand({
          type: 'load_track',
          commandSeq: msg.commandSeq,
          locator: msg.locator,
          ...(local.activeOutputId !== null
            ? { preferredOutputId: local.activeOutputId }
            : {}),
        });
        break;
      }

      case 'request_set_paused': {
        await this.wsController.sendCommand({
          type: 'set_paused',
          commandSeq: msg.commandSeq,
          paused: msg.paused,
        });
        break;
      }

      case 'request_seek': {
        await this.wsController.sendCommand({
          type: 'seek',
          commandSeq: msg.commandSeq,
          positionMs: msg.positionMs,
        });
        break;
      }

      case 'request_preload_next': {
        await this.wsController.sendCommand({
          type: 'preload_next',
          commandSeq: msg.commandSeq,
          locator: msg.locator,
        });
        break;
      }

      case 'request_stop': {
        await this.wsController.sendCommand({
          type: 'stop',
          commandSeq: msg.commandSeq,
          reason: msg.reason,
        });
        break;
      }

      case 'drm_local_fallback_active': {
        await updateEphemeralSessionState(this.storage.session, (prev) => ({
          ...prev,
          drmFallback: {
            trackId: msg.trackId,
            title: msg.title,
            artist: msg.artist,
          },
        }));
        break;
      }

      case 'drm_local_fallback_cleared': {
        await updateEphemeralSessionState(this.storage.session, (prev) => ({
          ...prev,
          drmFallback: null,
        }));
        break;
      }

      case 'refresh_locator_result': {
        await this.wsController.sendCommand({
          type: 'refresh_locator_response',
          requestId: msg.requestId,
          ...(msg.locator !== undefined ? { locator: msg.locator } : {}),
          ...(msg.error !== undefined ? { error: msg.error } : {}),
        });
        break;
      }
    }
  }

  private async broadcastCurrentSnapshot(): Promise<ExtensionUiSnapshot> {
    const snapshot = await this.getSnapshot();
    await this.onUpdateBadge?.(snapshot);
    this.onBroadcast?.({ type: 'ui_snapshot_updated', snapshot });
    return snapshot;
  }
}

function isRuntimeRequest(value: unknown): value is ExtensionRuntimeRequest {
  return isRecord(value) && typeof value['type'] === 'string';
}

function installChromeServiceWorkerEntrypoint(): void {
  const connectedPorts = new Set<chrome.runtime.Port>();

  const broadcastToPorts = (msg: ServiceWorkerBroadcastMessage): void => {
    for (const port of connectedPorts) {
      try {
        port.postMessage(msg);
      } catch {
        connectedPorts.delete(port);
      }
    }
  };

  const syncAlarm = async (enabled: boolean): Promise<void> => {
    if (enabled) {
      await chrome.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: 0.5 });
    } else {
      await chrome.alarms.clear(KEEPALIVE_ALARM_NAME);
    }
  };

  const updateBadge = async (snapshot: ExtensionUiSnapshot): Promise<void> => {
    const formatted = formatUiStatus(snapshot);
    await chrome.action.setBadgeText({ text: formatted.badgeText });
    if (formatted.badgeText.length > 0) {
      const color =
        formatted.tone === 'error'
          ? '#D94E0F'
          : formatted.tone === 'waking' || formatted.tone === 'drm'
            ? '#B45309'
            : '#0D8A52';
      await chrome.action.setBadgeBackgroundColor({ color });
    }
  };

  const coordinator = new ExtensionBackgroundCoordinator({
    storage: {
      local: chrome.storage.local,
      session: chrome.storage.session,
    },
    onBroadcast: broadcastToPorts,
    onSyncAlarm: syncAlarm,
    onUpdateBadge: updateBadge,
  });

  // Top-level synchronous MV3 event registrations (survives SW idle restarts)
  chrome.runtime.onInstalled.addListener(async () => {
    const local = await readDurableLocalConfig(chrome.storage.local);
    await coordinator.runDiscovery();
    if (local.handoffEnabled) {
      await syncAlarm(true);
      await coordinator.getWsController().ensureConnected();
    }
  });

  chrome.runtime.onStartup.addListener(async () => {
    const local = await readDurableLocalConfig(chrome.storage.local);
    await coordinator.runDiscovery();
    if (local.handoffEnabled) {
      await syncAlarm(true);
      await coordinator.getWsController().ensureConnected();
    }
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'soundclud-tab' && port.name !== 'soundclud-popup') {
      return;
    }
    connectedPorts.add(port);
    port.onDisconnect.addListener(() => {
      connectedPorts.delete(port);
    });
    port.onMessage.addListener((rawMsg, senderPort) => {
      if (!isRuntimeRequest(rawMsg)) {
        return;
      }
      const tabId = senderPort.sender?.tab?.id;
      void (async () => {
        await coordinator.handleRequest(rawMsg, tabId);
      })();
    });
  });

  chrome.runtime.onMessage.addListener((rawMessage, sender, sendResponse) => {
    if (!isRuntimeRequest(rawMessage)) {
      return undefined;
    }
    const tabId = sender.tab?.id;
    void (async () => {
      const response = await coordinator.handleRequest(rawMessage, tabId);
      sendResponse(response);
    })();
    return true;
  });

  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === KEEPALIVE_ALARM_NAME) {
      await coordinator.getWsController().sendPingIfConnected();
    }
  });

  chrome.tabs.onRemoved.addListener(async (tabId) => {
    await coordinator.handleTabClosed(tabId);
  });
}

if (
  typeof chrome !== 'undefined' &&
  chrome.runtime !== undefined &&
  chrome.storage !== undefined &&
  typeof document === 'undefined'
) {
  installChromeServiceWorkerEntrypoint();
}
