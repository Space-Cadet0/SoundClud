/**
 * MV3 storage persistence schemas (`chrome.storage.local` + `chrome.storage.session`).
 *
 * Enforces strict separation:
 * - Durable user config & TOFU receiver tokens -> `chrome.storage.local`
 * - Ephemeral SoundCloud session auth & live playback telemetry -> `chrome.storage.session`
 * - Zero authoritative state held solely in ephemeral Service Worker globals.
 */

import {
  TOSLINK_SEEK_DEBOUNCE_MS,
  type OutputDevice,
  type PlaybackTelemetry,
} from '@soundclud/protocol';
import {
  isRecord,
  type DiscoveredOutputEntry,
  type DiscoveredReceiverRecord,
  type DrmFallbackNotice,
  type ExtensionUiSnapshot,
  type ReceiverConnectionState,
  type StoredSessionAuth,
} from './messages.js';

export const LOCAL_STORAGE_KEY = 'soundcludLocalConfigV1' as const;
export const SESSION_STORAGE_KEY = 'soundcludSessionStateV1' as const;

export interface DurableLocalConfig {
  readonly controllerId: string;
  readonly clientLabel: string;
  readonly handoffEnabled: boolean;
  readonly activeEndpointBaseUrl: string | null;
  readonly activeReceiverId: string | null;
  readonly activeReceiverName: string | null;
  readonly activeOutputId: string | null;
  readonly knownEndpoints: readonly string[];
  readonly pairingTokensByReceiverId: Readonly<Record<string, string>>;
}

export interface EphemeralSessionState {
  readonly scSessionAuth: StoredSessionAuth | null;
  readonly discoveredReceivers: readonly DiscoveredReceiverRecord[];
  readonly connectionState: ReceiverConnectionState;
  readonly lastTelemetry: PlaybackTelemetry | null;
  readonly lastAckedCommandSeq: number;
  readonly nextCommandSeq: number;
  readonly drmFallback: DrmFallbackNotice | null;
  readonly activeTabId: number | null;
  readonly lastError: string | null;
}

export interface StorageAreaLike {
  get(
    keys?: string | readonly string[] | Record<string, unknown> | null,
  ): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface ExtensionStorageAreas {
  readonly local: StorageAreaLike;
  readonly session: StorageAreaLike;
}

function generateControllerId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `sc-ext-${crypto.randomUUID()}`;
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `sc-ext-${hex}`;
}

export function createDefaultDurableLocalConfig(
  controllerId?: string,
): DurableLocalConfig {
  return {
    controllerId: controllerId ?? generateControllerId(),
    clientLabel: 'SoundClud Chromium Extension',
    handoffEnabled: false,
    activeEndpointBaseUrl: null,
    activeReceiverId: null,
    activeReceiverName: null,
    activeOutputId: null,
    knownEndpoints: [],
    pairingTokensByReceiverId: {},
  };
}

export function createDefaultEphemeralSessionState(): EphemeralSessionState {
  return {
    scSessionAuth: null,
    discoveredReceivers: [],
    connectionState: 'disconnected',
    lastTelemetry: null,
    lastAckedCommandSeq: 0,
    nextCommandSeq: 1,
    drmFallback: null,
    activeTabId: null,
    lastError: null,
  };
}

export async function readDurableLocalConfig(
  storage: StorageAreaLike,
): Promise<DurableLocalConfig> {
  const rawMap = await storage.get(LOCAL_STORAGE_KEY);
  const raw = rawMap[LOCAL_STORAGE_KEY];
  if (!isRecord(raw)) {
    const initialized = createDefaultDurableLocalConfig();
    await storage.set({ [LOCAL_STORAGE_KEY]: initialized });
    return initialized;
  }

  const controllerId =
    typeof raw['controllerId'] === 'string' && raw['controllerId'].length > 0
      ? raw['controllerId']
      : generateControllerId();

  const knownEndpoints = Array.isArray(raw['knownEndpoints'])
    ? raw['knownEndpoints'].filter((v): v is string => typeof v === 'string' && v.length > 0)
    : [];

  const tokensRaw = raw['pairingTokensByReceiverId'];
  const pairingTokensByReceiverId: Record<string, string> = {};
  if (isRecord(tokensRaw)) {
    for (const [k, v] of Object.entries(tokensRaw)) {
      if (typeof v === 'string' && v.length > 0) {
        pairingTokensByReceiverId[k] = v;
      }
    }
  }

  // Never allow `oauthToken` in durable local storage even if corrupted externally.
  const config: DurableLocalConfig = {
    controllerId,
    clientLabel:
      typeof raw['clientLabel'] === 'string' && raw['clientLabel'].length > 0
        ? raw['clientLabel']
        : 'SoundClud Chromium Extension',
    handoffEnabled: raw['handoffEnabled'] === true,
    activeEndpointBaseUrl:
      typeof raw['activeEndpointBaseUrl'] === 'string' ? raw['activeEndpointBaseUrl'] : null,
    activeReceiverId:
      typeof raw['activeReceiverId'] === 'string' ? raw['activeReceiverId'] : null,
    activeReceiverName:
      typeof raw['activeReceiverName'] === 'string' ? raw['activeReceiverName'] : null,
    activeOutputId:
      typeof raw['activeOutputId'] === 'string' ? raw['activeOutputId'] : null,
    knownEndpoints,
    pairingTokensByReceiverId,
  };

  if (raw['controllerId'] !== controllerId) {
    await storage.set({ [LOCAL_STORAGE_KEY]: config });
  }
  return config;
}

export async function writeDurableLocalConfig(
  storage: StorageAreaLike,
  config: DurableLocalConfig,
): Promise<void> {
  await storage.set({ [LOCAL_STORAGE_KEY]: config });
}

export async function updateDurableLocalConfig(
  storage: StorageAreaLike,
  updater: (prev: DurableLocalConfig) => DurableLocalConfig,
): Promise<DurableLocalConfig> {
  const prev = await readDurableLocalConfig(storage);
  const next = updater(prev);
  await writeDurableLocalConfig(storage, next);
  return next;
}

export async function readEphemeralSessionState(
  sessionStorage: StorageAreaLike,
): Promise<EphemeralSessionState> {
  const rawMap = await sessionStorage.get(SESSION_STORAGE_KEY);
  const raw = rawMap[SESSION_STORAGE_KEY];
  if (!isRecord(raw)) {
    return createDefaultEphemeralSessionState();
  }
  const defaults = createDefaultEphemeralSessionState();
  return {
    scSessionAuth: isRecord(raw['scSessionAuth'])
      ? (raw['scSessionAuth'] as unknown as StoredSessionAuth)
      : defaults.scSessionAuth,
    discoveredReceivers: Array.isArray(raw['discoveredReceivers'])
      ? (raw['discoveredReceivers'] as readonly DiscoveredReceiverRecord[])
      : defaults.discoveredReceivers,
    connectionState:
      typeof raw['connectionState'] === 'string'
        ? (raw['connectionState'] as ReceiverConnectionState)
        : defaults.connectionState,
    lastTelemetry: isRecord(raw['lastTelemetry'])
      ? (raw['lastTelemetry'] as unknown as PlaybackTelemetry)
      : defaults.lastTelemetry,
    lastAckedCommandSeq:
      typeof raw['lastAckedCommandSeq'] === 'number'
        ? raw['lastAckedCommandSeq']
        : defaults.lastAckedCommandSeq,
    nextCommandSeq:
      typeof raw['nextCommandSeq'] === 'number'
        ? raw['nextCommandSeq']
        : defaults.nextCommandSeq,
    drmFallback: isRecord(raw['drmFallback'])
      ? (raw['drmFallback'] as unknown as DrmFallbackNotice)
      : defaults.drmFallback,
    activeTabId:
      typeof raw['activeTabId'] === 'number' ? raw['activeTabId'] : defaults.activeTabId,
    lastError:
      typeof raw['lastError'] === 'string' ? raw['lastError'] : defaults.lastError,
  };
}

export async function updateEphemeralSessionState(
  sessionStorage: StorageAreaLike,
  updater: (prev: EphemeralSessionState) => EphemeralSessionState,
): Promise<EphemeralSessionState> {
  const prev = await readEphemeralSessionState(sessionStorage);
  const next = updater(prev);
  await sessionStorage.set({ [SESSION_STORAGE_KEY]: next });
  return next;
}

export function flattenDiscoveredOutputs(
  receivers: readonly DiscoveredReceiverRecord[],
): readonly DiscoveredOutputEntry[] {
  const entries: DiscoveredOutputEntry[] = [];
  for (const receiver of receivers) {
    for (const output of receiver.outputs) {
      entries.push({
        compositeKey: `${receiver.receiverId}::${output.id}`,
        endpointBaseUrl: receiver.endpointBaseUrl,
        receiverId: receiver.receiverId,
        receiverName: receiver.receiverName,
        isLoopback: receiver.isLoopback,
        output,
      });
    }
  }
  entries.sort((a, b) => {
    if (a.output.isAvailable !== b.output.isAvailable) {
      return a.output.isAvailable ? -1 : 1;
    }
    if (a.output.isRecommendedDefault !== b.output.isRecommendedDefault) {
      return a.output.isRecommendedDefault ? -1 : 1;
    }
    if (a.isLoopback !== b.isLoopback) {
      return a.isLoopback ? 1 : -1;
    }
    return a.output.name.localeCompare(b.output.name);
  });
  return entries;
}

export function deriveUiSnapshot(
  local: DurableLocalConfig,
  session: EphemeralSessionState,
): ExtensionUiSnapshot {
  const outputs = flattenDiscoveredOutputs(session.discoveredReceivers);
  const matchedEntry =
    outputs.find(
      (entry) =>
        (local.activeReceiverId === null || entry.receiverId === local.activeReceiverId) &&
        entry.output.id === local.activeOutputId,
    ) ??
    outputs.find(
      (entry) =>
        local.activeEndpointBaseUrl !== null &&
        entry.endpointBaseUrl === local.activeEndpointBaseUrl &&
        entry.output.isRecommendedDefault,
    ) ??
    outputs[0];

  const activeOutput: OutputDevice | null = matchedEntry ? matchedEntry.output : null;
  const seekDebounceMs =
    activeOutput?.capabilities.seekDebounceMs ?? TOSLINK_SEEK_DEBOUNCE_MS;

  return {
    handoffEnabled: local.handoffEnabled,
    connectionState: session.connectionState,
    activeEndpointBaseUrl:
      local.activeEndpointBaseUrl ?? matchedEntry?.endpointBaseUrl ?? null,
    activeReceiverId: local.activeReceiverId ?? matchedEntry?.receiverId ?? null,
    activeReceiverName: local.activeReceiverName ?? matchedEntry?.receiverName ?? null,
    activeOutputId: local.activeOutputId ?? activeOutput?.id ?? null,
    activeOutput,
    seekDebounceMs,
    outputs,
    knownEndpoints: local.knownEndpoints,
    telemetry: session.lastTelemetry,
    lastAckedCommandSeq: session.lastAckedCommandSeq,
    accountTier: session.scSessionAuth?.accountTier ?? 'anonymous',
    drmFallback: session.drmFallback,
    lastError: session.lastError,
  };
}

export function createInMemoryStorageArea(
  initial?: Record<string, unknown>,
): StorageAreaLike {
  const store = new Map<string, unknown>(Object.entries(initial ?? {}));
  return {
    async get(keys) {
      if (keys === null || keys === undefined) {
        return Object.fromEntries(store.entries());
      }
      if (typeof keys === 'string') {
        return store.has(keys) ? { [keys]: store.get(keys) } : {};
      }
      if (Array.isArray(keys)) {
        const result: Record<string, unknown> = {};
        for (const key of keys) {
          if (store.has(key)) {
            result[key] = store.get(key);
          }
        }
        return result;
      }
      const result: Record<string, unknown> = {};
      for (const [key, fallback] of Object.entries(keys)) {
        result[key] = store.has(key) ? store.get(key) : fallback;
      }
      return result;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) {
        store.set(key, structuredClone(value));
      }
    },
  };
}
