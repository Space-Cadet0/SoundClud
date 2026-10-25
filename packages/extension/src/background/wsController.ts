/**
 * Zero-click TOFU pairing & full-duplex `/api/v1/ws` WebSocket controller (`MV3 Service Worker`).
 *
 * Persists durable config + TOFU tokens in `chrome.storage.local` and ephemeral
 * telemetry/connection state in `chrome.storage.session`, supporting Wi-Fi
 * exponential-backoff reconnects and `session_claimed` graceful multi-tab yield.
 */

import {
  API_V1_PAIR_PATH,
  API_V1_WS_PATH,
  PROTOCOL_VERSION,
  parsePairResponse,
  parseServerWsEvent,
  type ClientWsCommand,
  type PairRequest,
  type ServerWsEvent,
} from '@soundclud/protocol';
import type { IsolatedToMainMessage } from '../shared/messages.js';
import {
  readDurableLocalConfig,
  readEphemeralSessionState,
  updateDurableLocalConfig,
  updateEphemeralSessionState,
  type ExtensionStorageAreas,
} from '../shared/storageSchema.js';
import { toWebSocketEndpointUrl } from './discovery.js';

export interface MinimalWebSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: unknown) => void,
  ): void;
}

export interface ReceiverWsControllerOptions {
  readonly storage: ExtensionStorageAreas;
  readonly onStateChanged: () => void | Promise<void>;
  readonly onForwardToMain: (message: IsolatedToMainMessage) => void | Promise<void>;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly createWebSocket?: ((url: string) => MinimalWebSocket) | undefined;
}

const WS_OPEN_READY_STATE = 1;
const RECONNECT_BASE_DELAY_MS = 250;
const RECONNECT_MAX_DELAY_MS = 5000;

function extractMessageEventText(event: unknown): string | null {
  if (typeof event !== 'object' || event === null) {
    return null;
  }
  const data = (event as { readonly data?: unknown }).data;
  return typeof data === 'string' ? data : null;
}

export async function ensureTofuPairingToken(
  endpointBaseUrl: string,
  receiverId: string,
  storage: ExtensionStorageAreas,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const local = await readDurableLocalConfig(storage.local);
  const existing = local.pairingTokensByReceiverId[receiverId];
  if (typeof existing === 'string' && existing.length > 0) {
    return existing;
  }

  const pairBody: PairRequest = {
    protocolVersion: PROTOCOL_VERSION,
    clientLabel: local.clientLabel,
    controllerId: local.controllerId,
  };

  const response = await fetchImpl(`${endpointBaseUrl}${API_V1_PAIR_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(pairBody),
  });

  if (!response.ok) {
    throw new Error(`TOFU pairing failed with HTTP ${String(response.status)}`);
  }

  const rawJson: unknown = await response.json();
  const parsed = parsePairResponse(rawJson);
  if (!parsed.ok) {
    throw new Error(`Invalid /api/v1/pair payload: ${parsed.error}`);
  }

  const token = parsed.value.pairingToken;
  await updateDurableLocalConfig(storage.local, (prev) => ({
    ...prev,
    pairingTokensByReceiverId: {
      ...prev.pairingTokensByReceiverId,
      [parsed.value.receiverId]: token,
      [receiverId]: token,
    },
  }));
  return token;
}

export class ReceiverWsController {
  private readonly storage: ExtensionStorageAreas;
  private readonly onStateChanged: () => void | Promise<void>;
  private readonly onForwardToMain: (
    message: IsolatedToMainMessage,
  ) => void | Promise<void>;
  private readonly fetchImpl: typeof fetch;
  private readonly createWebSocket: (url: string) => MinimalWebSocket;

  private activeSocket: MinimalWebSocket | null = null;
  private connectedEndpointBaseUrl: string | null = null;
  private connectedReceiverId: string | null = null;
  private isWelcomed = false;
  private connectInFlight: Promise<boolean> | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private readonly pendingCommands: ClientWsCommand[] = [];

  public constructor(options: ReceiverWsControllerOptions) {
    this.storage = options.storage;
    this.onStateChanged = options.onStateChanged;
    this.onForwardToMain = options.onForwardToMain;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.createWebSocket =
      options.createWebSocket ??
      ((url: string): MinimalWebSocket => new WebSocket(url) as unknown as MinimalWebSocket);
  }

  public isConnectedTo(endpointBaseUrl: string): boolean {
    return (
      this.activeSocket !== null &&
      this.activeSocket.readyState === WS_OPEN_READY_STATE &&
      this.connectedEndpointBaseUrl === endpointBaseUrl &&
      this.isWelcomed
    );
  }

  public async ensureConnected(): Promise<boolean> {
    const local = await readDurableLocalConfig(this.storage.local);
    const session = await readEphemeralSessionState(this.storage.session);

    if (!local.handoffEnabled) {
      return false;
    }

    const targetReceiver =
      session.discoveredReceivers.find(
        (r) =>
          (local.activeReceiverId !== null && r.receiverId === local.activeReceiverId) ||
          (local.activeEndpointBaseUrl !== null &&
            r.endpointBaseUrl === local.activeEndpointBaseUrl),
      ) ?? session.discoveredReceivers[0];

    const endpointBaseUrl =
      local.activeEndpointBaseUrl ?? targetReceiver?.endpointBaseUrl ?? null;
    const receiverId =
      local.activeReceiverId ?? targetReceiver?.receiverId ?? 'default-receiver';

    if (endpointBaseUrl === null) {
      return false;
    }

    if (this.isConnectedTo(endpointBaseUrl)) {
      return true;
    }

    if (
      this.connectInFlight !== null &&
      this.connectedEndpointBaseUrl === endpointBaseUrl
    ) {
      return await this.connectInFlight;
    }

    this.connectInFlight = this.openSessionInternal(
      endpointBaseUrl,
      receiverId,
      targetReceiver?.requiresPairing ?? true,
    );
    try {
      return await this.connectInFlight;
    } finally {
      this.connectInFlight = null;
    }
  }

  public async sendCommand(command: ClientWsCommand): Promise<boolean> {
    if (
      this.activeSocket !== null &&
      this.activeSocket.readyState === WS_OPEN_READY_STATE &&
      this.isWelcomed
    ) {
      this.activeSocket.send(JSON.stringify(command));
      return true;
    }

    if (this.pendingCommands.length < 32) {
      this.pendingCommands.push(command);
    }
    const ok = await this.ensureConnected();
    return ok;
  }

  public async sendPingIfConnected(): Promise<void> {
    if (
      this.activeSocket !== null &&
      this.activeSocket.readyState === WS_OPEN_READY_STATE &&
      this.isWelcomed
    ) {
      const pingCmd: ClientWsCommand = {
        type: 'ping',
        clientTimestampMs: Date.now(),
      };
      this.activeSocket.send(JSON.stringify(pingCmd));
    } else {
      const local = await readDurableLocalConfig(this.storage.local);
      const session = await readEphemeralSessionState(this.storage.session);
      if (local.handoffEnabled && session.connectionState !== 'session_claimed') {
        await this.ensureConnected();
      }
    }
  }

  public async disconnect(clearState = true): Promise<void> {
    this.intentionalClose = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.pendingCommands.length = 0;
    this.isWelcomed = false;
    const sock = this.activeSocket;
    this.activeSocket = null;
    this.connectedEndpointBaseUrl = null;
    this.connectedReceiverId = null;
    if (sock !== null) {
      try {
        sock.close(1000, 'client_disconnect');
      } catch {
        // Ignore already-closed socket errors.
      }
    }
    if (clearState) {
      await updateEphemeralSessionState(this.storage.session, (prev) => ({
        ...prev,
        connectionState: 'disconnected',
      }));
      await this.onStateChanged();
    }
  }

  private async openSessionInternal(
    endpointBaseUrl: string,
    receiverId: string,
    requiresPairing: boolean,
    allowStaleTokenRetry = true,
  ): Promise<boolean> {
    await this.disconnect(false);
    this.intentionalClose = false;
    this.connectedEndpointBaseUrl = endpointBaseUrl;
    this.connectedReceiverId = receiverId;

    await updateEphemeralSessionState(this.storage.session, (prev) => ({
      ...prev,
      connectionState: this.reconnectAttempts > 0 ? 'reconnecting' : 'connecting',
      lastError: null,
    }));
    await this.onStateChanged();

    let pairingToken = 'open-no-pairing';
    try {
      if (requiresPairing) {
        pairingToken = await ensureTofuPairingToken(
          endpointBaseUrl,
          receiverId,
          this.storage,
          this.fetchImpl,
        );
      } else {
        const local = await readDurableLocalConfig(this.storage.local);
        pairingToken =
          local.pairingTokensByReceiverId[receiverId] ?? 'open-no-pairing';
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Receiver pairing failed';
      await updateEphemeralSessionState(this.storage.session, (prev) => ({
        ...prev,
        connectionState: 'error',
        lastError: msg,
      }));
      await this.onStateChanged();
      this.scheduleReconnect();
      return false;
    }

    const local = await readDurableLocalConfig(this.storage.local);
    const wsUrl = toWebSocketEndpointUrl(endpointBaseUrl, API_V1_WS_PATH);

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      let staleAuthCleared = false;
      let inboundChain: Promise<void> = Promise.resolve();

      const finish = (result: boolean): void => {
        if (!settled) {
          settled = true;
          resolve(result);
        }
      };

      let socket: MinimalWebSocket;
      try {
        socket = this.createWebSocket(wsUrl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'WebSocket open failed';
        void (async () => {
          await updateEphemeralSessionState(this.storage.session, (prev) => ({
            ...prev,
            connectionState: 'error',
            lastError: msg,
          }));
          await this.onStateChanged();
          this.scheduleReconnect();
          finish(false);
        })();
        return;
      }

      this.activeSocket = socket;

      const handshakeTimeout = setTimeout(() => {
        if (!this.isWelcomed) {
          try {
            socket.close(4000, 'hello_timeout');
          } catch {
            // Ignore close errors.
          }
          finish(false);
        }
      }, 4000);

      socket.addEventListener('open', () => {
        const hello: ClientWsCommand = {
          type: 'hello',
          protocolVersion: PROTOCOL_VERSION,
          pairingToken,
          controllerId: local.controllerId,
          clientLabel: local.clientLabel,
        };
        try {
          socket.send(JSON.stringify(hello));
        } catch {
          finish(false);
        }
      });

      socket.addEventListener('message', (rawEvent) => {
        const text = extractMessageEventText(rawEvent);
        if (text === null) {
          return;
        }
        inboundChain = inboundChain.then(async () => {
          let rawObj: unknown;
          try {
            rawObj = JSON.parse(text);
          } catch {
            return;
          }
          const parsed = parseServerWsEvent(rawObj);
          if (!parsed.ok) {
            return;
          }
          if (parsed.value.type === 'error' && !this.isWelcomed) {
            const lowerCode = parsed.value.code.toLowerCase();
            if (lowerCode.includes('auth') || lowerCode.includes('token')) {
              staleAuthCleared = true;
            }
          }
          await this.handleServerEvent(
            parsed.value,
            endpointBaseUrl,
            socket,
            () => {
              clearTimeout(handshakeTimeout);
              finish(true);
            },
          );
        });
      });

      socket.addEventListener('error', () => {
        clearTimeout(handshakeTimeout);
      });

      socket.addEventListener('close', () => {
        clearTimeout(handshakeTimeout);
        void inboundChain.finally(async () => {
          if (this.activeSocket === socket) {
            this.activeSocket = null;
            this.isWelcomed = false;
          }
          if (
            !settled &&
            staleAuthCleared &&
            allowStaleTokenRetry &&
            requiresPairing &&
            !this.intentionalClose
          ) {
            const recovered = await this.openSessionInternal(
              endpointBaseUrl,
              receiverId,
              requiresPairing,
              false,
            );
            finish(recovered);
            return;
          }
          finish(false);
          if (!this.intentionalClose) {
            await this.handleUnexpectedClose();
          }
        });
      });
    });
  }

  private async handleServerEvent(
    event: ServerWsEvent,
    endpointBaseUrl: string,
    socket: MinimalWebSocket,
    onWelcomeReady: () => void,
  ): Promise<void> {
    switch (event.type) {
      case 'welcome': {
        this.isWelcomed = true;
        this.reconnectAttempts = 0;

        const local = await updateDurableLocalConfig(this.storage.local, (prev) => {
          const prevOutputExistsOnReceiver =
            prev.activeOutputId !== null &&
            event.outputs.some((o) => o.id === prev.activeOutputId);
          const resolvedOutputId = prevOutputExistsOnReceiver
            ? prev.activeOutputId
            : (event.config.activeOutputId ?? event.outputs[0]?.id ?? null);
          return {
            ...prev,
            activeEndpointBaseUrl: endpointBaseUrl,
            activeReceiverId: event.receiverId,
            activeReceiverName: event.receiverName,
            activeOutputId: resolvedOutputId,
          };
        });

        await updateEphemeralSessionState(this.storage.session, (prev) => {
          const updatedReceivers = prev.discoveredReceivers.some(
            (r) => r.receiverId === event.receiverId,
          )
            ? prev.discoveredReceivers.map((r) =>
                r.receiverId === event.receiverId
                  ? {
                      ...r,
                      outputs: event.outputs,
                      activeOutputId: event.config.activeOutputId,
                    }
                  : r,
              )
            : [
                ...prev.discoveredReceivers,
                {
                  endpointBaseUrl,
                  host: new URL(endpointBaseUrl).hostname,
                  port: Number(new URL(endpointBaseUrl).port) || 9876,
                  isLoopback: new URL(endpointBaseUrl).hostname === '127.0.0.1',
                  receiverId: event.receiverId,
                  receiverName: event.receiverName,
                  requiresPairing: true,
                  activeOutputId: event.config.activeOutputId,
                  outputs: event.outputs,
                  discoveredAtMs: Date.now(),
                },
              ];
          return {
            ...prev,
            connectionState: 'connected',
            discoveredReceivers: updatedReceivers,
            lastTelemetry: event.telemetry,
            lastError: null,
          };
        });

        // Sync user's preferred output if distinct from receiver's current output
        if (
          local.activeOutputId !== null &&
          local.activeOutputId !== event.config.activeOutputId
        ) {
          const selectCmd: ClientWsCommand = {
            type: 'select_output',
            commandSeq: Date.now() % 1_000_000,
            outputId: local.activeOutputId,
          };
          socket.send(JSON.stringify(selectCmd));
        }

        while (this.pendingCommands.length > 0) {
          const cmd = this.pendingCommands.shift();
          if (cmd !== undefined && socket.readyState === WS_OPEN_READY_STATE) {
            socket.send(JSON.stringify(cmd));
          }
        }

        onWelcomeReady();
        await this.onStateChanged();
        break;
      }

      case 'state_tick': {
        if (this.intentionalClose || !this.isWelcomed) {
          break;
        }
        await updateEphemeralSessionState(this.storage.session, (prev) => ({
          ...prev,
          connectionState: 'connected',
          lastTelemetry: event.telemetry,
          lastAckedCommandSeq: event.lastAckedCommandSeq,
        }));
        await this.onForwardToMain({
          type: 'telemetry_tick',
          telemetry: event.telemetry,
          lastAckedCommandSeq: event.lastAckedCommandSeq,
        });
        await this.onStateChanged();
        break;
      }

      case 'outputs_updated': {
        if (event.activeOutputId !== undefined) {
          await updateDurableLocalConfig(this.storage.local, (prev) => ({
            ...prev,
            activeOutputId: event.activeOutputId ?? prev.activeOutputId,
          }));
        }
        await updateEphemeralSessionState(this.storage.session, (prev) => ({
          ...prev,
          discoveredReceivers: prev.discoveredReceivers.map((r) =>
            r.receiverId === this.connectedReceiverId
              ? {
                  ...r,
                  outputs: event.outputs,
                  activeOutputId: event.activeOutputId,
                }
              : r,
          ),
        }));
        await this.onStateChanged();
        break;
      }

      case 'track_ended': {
        await this.onForwardToMain({
          type: 'track_ended',
          trackId: event.trackId,
          locatorId: event.locatorId,
        });
        break;
      }

      case 'refresh_locator_request': {
        await this.onForwardToMain({
          type: 'refresh_locator_request',
          requestId: event.requestId,
          trackId: event.trackId,
          locatorId: event.locatorId,
          reason: event.reason,
        });
        break;
      }

      case 'session_claimed': {
        this.intentionalClose = true;
        if (this.activeSocket === socket) {
          this.activeSocket = null;
          this.isWelcomed = false;
        }
        try {
          socket.close(1000, 'session_claimed');
        } catch {
          // Ignore close errors on displaced socket.
        }
        await updateEphemeralSessionState(this.storage.session, (prev) => ({
          ...prev,
          connectionState: 'session_claimed',
        }));
        await this.onForwardToMain({
          type: 'session_claimed',
          newControllerId: event.newControllerId,
          newClientLabel: event.newClientLabel,
        });
        await this.onStateChanged();
        break;
      }

      case 'error': {
        const lowerCode = event.code.toLowerCase();
        if (
          (lowerCode.includes('auth') || lowerCode.includes('token')) &&
          this.connectedReceiverId !== null
        ) {
          const staleId = this.connectedReceiverId;
          await updateDurableLocalConfig(this.storage.local, (prev) => {
            const copy = { ...prev.pairingTokensByReceiverId };
            delete copy[staleId];
            return { ...prev, pairingTokensByReceiverId: copy };
          });
        }
        await updateEphemeralSessionState(this.storage.session, (prev) => ({
          ...prev,
          lastError: `${event.code}: ${event.message}`,
        }));
        await this.onStateChanged();
        break;
      }

      case 'pong':
        break;
    }
  }

  private async handleUnexpectedClose(): Promise<void> {
    const local = await readDurableLocalConfig(this.storage.local);
    const session = await readEphemeralSessionState(this.storage.session);
    if (!local.handoffEnabled || session.connectionState === 'session_claimed') {
      return;
    }
    await updateEphemeralSessionState(this.storage.session, (prev) => ({
      ...prev,
      connectionState: 'reconnecting',
    }));
    await this.onStateChanged();
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null || this.intentionalClose) {
      return;
    }
    const expDelay = Math.min(
      RECONNECT_MAX_DELAY_MS,
      RECONNECT_BASE_DELAY_MS * 2 ** Math.min(this.reconnectAttempts, 5),
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.ensureConnected();
    }, expDelay);
  }
}
