/**
 * Parallel multi-endpoint SoundClud receiver discovery (`MV3 Service Worker`).
 *
 * Probes `http://127.0.0.1:9876`, `http://soundclud.local:9876`, user-saved LAN
 * endpoints, and peer-advertised receivers concurrently, validating responses via
 * `@soundclud/protocol`'s `parseDiscoverResponse` and aggregating all `coreaudio` /
 * `alsa` (TOSLINK) and `heos_upnp` (Denon/Marantz HEOS Direct) outputs.
 */

import {
  API_V1_DISCOVER_PATH,
  DEFAULT_DISCOVERY_PORT,
  parseDiscoverResponse,
  type DiscoverResponse,
} from '@soundclud/protocol';
import type { DiscoveredReceiverRecord } from '../shared/messages.js';

export const LOOPBACK_CANDIDATE_ENDPOINT =
  `http://127.0.0.1:${String(DEFAULT_DISCOVERY_PORT)}` as const;
export const MDNS_CANDIDATE_ENDPOINT =
  `http://soundclud.local:${String(DEFAULT_DISCOVERY_PORT)}` as const;

export const DEFAULT_DISCOVERY_TIMEOUT_MS = 1200 as const;

export interface DiscoverReceiversOptions {
  readonly knownEndpoints?: readonly string[] | undefined;
  readonly activeEndpointBaseUrl?: string | null | undefined;
  readonly includeDefaultCandidates?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
  readonly fetchImpl?: typeof fetch | undefined;
  readonly onFirstReceiverFound?: ((record: DiscoveredReceiverRecord) => void) | undefined;
}

export function isLoopbackHostname(hostname: string): boolean {
  const clean = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return clean === '127.0.0.1' || clean === 'localhost' || clean === '::1';
}

/**
 * Normalizes user-supplied or discovered endpoint strings (e.g. `"soundclud.local:9876"`
 * or `"http://127.0.0.1:9876/"`) into canonical `"http://<host>:<port>"` base URLs.
 */
export function normalizeReceiverEndpointBaseUrl(rawInput: string): string | null {
  const trimmed = rawInput.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)
    ? trimmed
    : `http://${trimmed}`;

  try {
    const parsed = new URL(withScheme);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return null;
    }
    if (parsed.username !== '' || parsed.password !== '') {
      return null;
    }
    if (parsed.hostname.length === 0) {
      return null;
    }
    const effectivePort =
      parsed.port.length > 0 ? Number(parsed.port) : DEFAULT_DISCOVERY_PORT;
    if (
      !Number.isInteger(effectivePort) ||
      effectivePort < 1 ||
      effectivePort > 65535
    ) {
      return null;
    }
    const hostPart = parsed.hostname.includes(':')
      ? `[${parsed.hostname.replace(/^\[|\]$/g, '')}]`
      : parsed.hostname.toLowerCase();
    return `${parsed.protocol}//${hostPart}:${String(effectivePort)}`;
  } catch {
    return null;
  }
}

export function toWebSocketEndpointUrl(
  endpointBaseUrl: string,
  wsPath: string,
): string {
  const parsed = new URL(endpointBaseUrl);
  parsed.protocol = parsed.protocol === 'https:' ? 'wss:' : 'ws:';
  parsed.pathname = wsPath;
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString();
}

async function fetchWithTimeout(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);
  try {
    return await fetchImpl(url, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

interface ProbedEndpointResult {
  readonly record: DiscoveredReceiverRecord;
  readonly rawDiscover: DiscoverResponse;
}

async function probeSingleEndpoint(
  baseUrl: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<ProbedEndpointResult | null> {
  try {
    const response = await fetchWithTimeout(
      `${baseUrl}${API_V1_DISCOVER_PATH}`,
      timeoutMs,
      fetchImpl,
    );
    if (!response.ok) {
      return null;
    }
    const payload: unknown = await response.json();
    const parsed = parseDiscoverResponse(payload);
    if (!parsed.ok) {
      return null;
    }

    const parsedUrl = new URL(baseUrl);
    const port =
      parsedUrl.port.length > 0 ? Number(parsedUrl.port) : DEFAULT_DISCOVERY_PORT;
    const discover = parsed.value;

    const record: DiscoveredReceiverRecord = {
      endpointBaseUrl: baseUrl,
      host: parsedUrl.hostname,
      port,
      isLoopback: isLoopbackHostname(parsedUrl.hostname),
      receiverId: discover.receiverId,
      receiverName: discover.receiverName,
      requiresPairing: discover.requiresPairing,
      activeOutputId: discover.config.activeOutputId,
      outputs: discover.outputs,
      discoveredAtMs: Date.now(),
    };

    return { record, rawDiscover: discover };
  } catch {
    return null;
  }
}

export async function discoverReceivers(
  options?: DiscoverReceiversOptions,
): Promise<readonly DiscoveredReceiverRecord[]> {
  const fetchImpl = options?.fetchImpl ?? fetch;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS;
  const includeDefaults = options?.includeDefaultCandidates ?? true;

  const candidateSet = new Set<string>();
  if (includeDefaults) {
    candidateSet.add(LOOPBACK_CANDIDATE_ENDPOINT);
    candidateSet.add(MDNS_CANDIDATE_ENDPOINT);
  }
  if (
    typeof options?.activeEndpointBaseUrl === 'string' &&
    options.activeEndpointBaseUrl.length > 0
  ) {
    const norm = normalizeReceiverEndpointBaseUrl(options.activeEndpointBaseUrl);
    if (norm !== null) {
      candidateSet.add(norm);
    }
  }
  if (options?.knownEndpoints !== undefined) {
    for (const raw of options.knownEndpoints) {
      const norm = normalizeReceiverEndpointBaseUrl(raw);
      if (norm !== null) {
        candidateSet.add(norm);
      }
    }
  }

  const probedUrls = new Set<string>(candidateSet);
  const byReceiverId = new Map<string, DiscoveredReceiverRecord>();
  let notifiedFirst = false;

  const upsertRecord = (record: DiscoveredReceiverRecord): void => {
    const existing = byReceiverId.get(record.receiverId);
    // Prefer loopback over mDNS when the exact same local daemon answers on both.
    if (existing !== undefined && existing.isLoopback && !record.isLoopback) {
      return;
    }
    byReceiverId.set(record.receiverId, record);
    if (!notifiedFirst) {
      notifiedFirst = true;
      options?.onFirstReceiverFound?.(record);
    }
  };

  const firstWavePromises = Array.from(candidateSet, async (baseUrl) => {
    const res = await probeSingleEndpoint(baseUrl, timeoutMs, fetchImpl);
    if (res !== null) {
      upsertRecord(res.record);
    }
    return res;
  });

  // Race for fast first-responder notification (`Promise.any` semantics) while awaiting all outputs
  const settledFirst = await Promise.allSettled(firstWavePromises);

  const peerUrlsToProbe: string[] = [];
  for (const outcome of settledFirst) {
    if (outcome.status !== 'fulfilled' || outcome.value === null) {
      continue;
    }
    for (const peer of outcome.value.rawDiscover.peers) {
      if (byReceiverId.has(peer.receiverId)) {
        continue;
      }
      const peerUrl = normalizeReceiverEndpointBaseUrl(
        `http://${peer.host}:${String(peer.port)}`,
      );
      if (peerUrl !== null && !probedUrls.has(peerUrl)) {
        probedUrls.add(peerUrl);
        peerUrlsToProbe.push(peerUrl);
      }
    }
  }

  if (peerUrlsToProbe.length > 0) {
    const settledPeers = await Promise.allSettled(
      peerUrlsToProbe.map(async (peerUrl) => {
        const res = await probeSingleEndpoint(peerUrl, timeoutMs, fetchImpl);
        if (res !== null) {
          upsertRecord(res.record);
        }
        return res;
      }),
    );
    void settledPeers;
  }

  return Array.from(byReceiverId.values()).sort((a, b) => {
    if (a.isLoopback !== b.isLoopback) {
      return a.isLoopback ? 1 : -1;
    }
    return a.receiverName.localeCompare(b.receiverName);
  });
}
