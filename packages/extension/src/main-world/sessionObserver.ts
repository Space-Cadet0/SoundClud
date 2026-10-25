/**
 * Passive SoundCloud session observer & Go+ `"hq"` local-settings promoter (`MAIN` world).
 *
 * Piggybacks ephemerally on `window.__sc_hydration`, `api-v2.soundcloud.com`
 * `Authorization: OAuth <token>` headers (including `TokenExpiryManager` JWT
 * refreshes), and `document.cookie`'s `oauth_token` with zero separate login UI
 * and zero `"cookies"` manifest permission.
 */

import {
  isAllowedSoundCloudApiAuthUrl,
  type AccountTier,
} from '@soundclud/protocol';
import { isRecord } from '../shared/messages.js';

export const SOUNDCLOUD_LOCAL_SETTINGS_KEY = 'V2::local::settings' as const;

export interface MinimalKeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SessionSnapshot {
  readonly clientId: string;
  readonly oauthToken?: string | undefined;
  readonly accountTier: AccountTier;
  readonly hasHqAudioFeature: boolean;
  readonly hasAuthenticatedUser: boolean;
}

export type SessionChangeListener = (snapshot: SessionSnapshot) => void;

export function parseOAuthTokenFromAuthorizationHeader(
  rawHeader: string | null | undefined,
): string | undefined {
  if (typeof rawHeader !== 'string') {
    return undefined;
  }
  const trimmed = rawHeader.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const oauthMatch = /^OAuth\s+(.+)$/i.exec(trimmed);
  if (oauthMatch?.[1] !== undefined) {
    const token = oauthMatch[1].trim();
    return token.length > 0 ? token : undefined;
  }
  return undefined;
}

export function parseOAuthTokenFromCookieString(
  cookieHeader: string | null | undefined,
): string | undefined {
  if (typeof cookieHeader !== 'string' || cookieHeader.trim().length === 0) {
    return undefined;
  }
  const segments = cookieHeader.split(';');
  for (const segment of segments) {
    const eqIndex = segment.indexOf('=');
    if (eqIndex <= 0) {
      continue;
    }
    const name = segment.slice(0, eqIndex).trim();
    if (name !== 'oauth_token') {
      continue;
    }
    let rawValue = segment.slice(eqIndex + 1).trim();
    if (
      rawValue.length >= 2 &&
      rawValue.startsWith('"') &&
      rawValue.endsWith('"')
    ) {
      rawValue = rawValue.slice(1, -1).trim();
    }
    try {
      rawValue = decodeURIComponent(rawValue).trim();
    } catch {
      // Keep raw cookie value if percent-decoding fails.
    }
    if (/^OAuth\s+/i.test(rawValue)) {
      rawValue = rawValue.replace(/^OAuth\s+/i, '').trim();
    }
    return rawValue.length > 0 ? rawValue : undefined;
  }
  return undefined;
}

/**
 * Promotes `localStorage["V2::local::settings"].streamingQuality` to `"hq"` when
 * the user's session has `"hq_audio"` enabled and `streamingQuality` is `null`
 * or `undefined` (leaving explicit `"sq"` overrides untouched).
 */
export function promoteSoundCloudLocalSettingsToHq(
  storage: MinimalKeyValueStorage | null | undefined,
  hasHqAudio: boolean,
): boolean {
  if (!hasHqAudio || storage === null || storage === undefined) {
    return false;
  }
  try {
    const raw = storage.getItem(SOUNDCLOUD_LOCAL_SETTINGS_KEY);
    if (raw === null || raw.trim().length === 0) {
      storage.setItem(
        SOUNDCLOUD_LOCAL_SETTINGS_KEY,
        JSON.stringify({ streamingQuality: 'hq' }),
      );
      return true;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return false;
    }
    const currentQuality = parsed['streamingQuality'];
    if (currentQuality === null || currentQuality === undefined) {
      const updated = { ...parsed, streamingQuality: 'hq' };
      storage.setItem(SOUNDCLOUD_LOCAL_SETTINGS_KEY, JSON.stringify(updated));
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export type HeaderBagInput =
  | Headers
  | Readonly<Record<string, string>>
  | readonly (readonly [string, string])[]
  | undefined;

function extractAuthorizationHeader(headers: HeaderBagInput): string | undefined {
  if (headers === undefined) {
    return undefined;
  }
  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    return headers.get('authorization') ?? headers.get('Authorization') ?? undefined;
  }
  if (Array.isArray(headers)) {
    for (const pair of headers) {
      const key = pair[0];
      const val = pair[1];
      if (typeof key === 'string' && key.toLowerCase() === 'authorization') {
        return val;
      }
    }
    return undefined;
  }
  const record = headers as Readonly<Record<string, string>>;
  for (const [key, val] of Object.entries(record)) {
    if (key.toLowerCase() === 'authorization' && typeof val === 'string') {
      return val;
    }
  }
  return undefined;
}

function inspectGoPlusSubscriptionFlag(node: Record<string, unknown>): boolean {
  const checkPlanText = (val: unknown): boolean => {
    if (typeof val !== 'string') return false;
    const lower = val.toLowerCase();
    return (
      lower === 'hq_audio' ||
      lower.includes('high_tier') ||
      lower.includes('consumer-high-tier') ||
      lower.includes('go-plus') ||
      lower.includes('go_plus') ||
      lower === 'go+'
    );
  };

  if (checkPlanText(node['plan']) || checkPlanText(node['id'])) {
    return true;
  }
  const product = node['product'];
  if (isRecord(product) && (checkPlanText(product['id']) || checkPlanText(product['name']))) {
    return true;
  }
  const sub = node['consumer_subscription'];
  if (isRecord(sub) && inspectGoPlusSubscriptionFlag(sub)) {
    return true;
  }
  const subs = node['consumer_subscriptions'];
  if (Array.isArray(subs)) {
    for (const item of subs) {
      if (isRecord(item) && inspectGoPlusSubscriptionFlag(item)) {
        return true;
      }
    }
  }
  return false;
}

export class SoundCloudSessionObserver {
  private clientId = '';
  private oauthToken: string | undefined;
  private lastCookieToken: string | undefined;
  private hasHqAudioFeature = false;
  private hasAuthenticatedUser = false;
  private localStorageRef: MinimalKeyValueStorage | null;
  private readonly listeners = new Set<SessionChangeListener>();

  public constructor(localStorageRef?: MinimalKeyValueStorage | null) {
    this.localStorageRef = localStorageRef ?? null;
  }

  public setLocalStorage(localStorageRef: MinimalKeyValueStorage | null): void {
    this.localStorageRef = localStorageRef;
    if (this.hasHqAudioFeature) {
      promoteSoundCloudLocalSettingsToHq(this.localStorageRef, true);
    }
  }

  public getSnapshot(): SessionSnapshot {
    const isAuthenticated =
      this.hasAuthenticatedUser ||
      (this.oauthToken !== undefined && this.oauthToken.length > 0);
    const accountTier: AccountTier = this.hasHqAudioFeature
      ? 'go_plus'
      : isAuthenticated
        ? 'free'
        : 'anonymous';

    return {
      clientId: this.clientId,
      oauthToken: this.oauthToken,
      accountTier,
      hasHqAudioFeature: this.hasHqAudioFeature,
      hasAuthenticatedUser: isAuthenticated,
    };
  }

  public subscribe(listener: SessionChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public ingestHydration(hydration: unknown): boolean {
    const prev = this.serializeState();
    this.walkHydrationNode(hydration, 0);
    return this.finalizeMutation(prev);
  }

  public observeCookieString(cookieHeader: string | null | undefined): boolean {
    const prev = this.serializeState();
    const parsed = parseOAuthTokenFromCookieString(cookieHeader);
    if (parsed !== undefined) {
      if (this.lastCookieToken !== parsed) {
        this.lastCookieToken = parsed;
        this.oauthToken = parsed;
        this.hasAuthenticatedUser = true;
      } else if (this.oauthToken === undefined) {
        this.oauthToken = parsed;
      }
    } else if (this.lastCookieToken !== undefined) {
      if (this.oauthToken === this.lastCookieToken) {
        this.oauthToken = undefined;
      }
      this.lastCookieToken = undefined;
    }
    return this.finalizeMutation(prev);
  }

  public observeApiRequest(rawUrl: string, headers?: HeaderBagInput): boolean {
    if (!isAllowedSoundCloudApiAuthUrl(rawUrl)) {
      return false;
    }
    const prev = this.serializeState();
    try {
      const parsedUrl = new URL(rawUrl);
      const queryClientId = parsedUrl.searchParams.get('client_id')?.trim();
      if (queryClientId !== undefined && queryClientId.length > 0) {
        this.clientId = queryClientId;
      }
    } catch {
      // Validated by `isAllowedSoundCloudApiAuthUrl`, ignore unexpected parse error.
    }

    const authHeader = extractAuthorizationHeader(headers);
    const headerToken = parseOAuthTokenFromAuthorizationHeader(authHeader);
    if (headerToken !== undefined) {
      this.oauthToken = headerToken;
      this.hasAuthenticatedUser = true;
    }
    return this.finalizeMutation(prev);
  }

  public ingestUserOrSessionPayload(payload: unknown, sourceUrl?: string): boolean {
    if (sourceUrl !== undefined && !isAllowedSoundCloudApiAuthUrl(sourceUrl)) {
      return false;
    }
    if (!isRecord(payload)) {
      return false;
    }
    const prev = this.serializeState();
    if (inspectGoPlusSubscriptionFlag(payload)) {
      this.hasHqAudioFeature = true;
      this.hasAuthenticatedUser = true;
    }
    const features = payload['features'];
    this.inspectFeaturesValue(features);
    return this.finalizeMutation(prev);
  }

  public markHqTranscodingObserved(): boolean {
    if (this.oauthToken === undefined && !this.hasAuthenticatedUser) {
      return false;
    }
    const prev = this.serializeState();
    this.hasHqAudioFeature = true;
    return this.finalizeMutation(prev);
  }

  private walkHydrationNode(node: unknown, depth: number): void {
    if (depth > 6 || node === null || node === undefined) {
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) {
        this.walkHydrationNode(item, depth + 1);
      }
      return;
    }
    if (!isRecord(node)) {
      return;
    }

    const hydratable =
      typeof node['hydratable'] === 'string' ? node['hydratable'] : undefined;
    const data = node['data'];

    if (hydratable === 'apiClient' && isRecord(data)) {
      if (typeof data['id'] === 'string' && data['id'].trim().length > 0) {
        this.clientId = data['id'].trim();
      }
    } else if (hydratable === 'features') {
      this.inspectFeaturesValue(data);
    } else if (
      (hydratable === 'meUser' ||
        hydratable === 'user' ||
        hydratable === 'currentUser' ||
        hydratable === 'me') &&
      isRecord(data)
    ) {
      if (typeof data['id'] === 'number' || typeof data['id'] === 'string') {
        if (hydratable === 'meUser' || hydratable === 'currentUser' || hydratable === 'me') {
          this.hasAuthenticatedUser = true;
        }
      }
      if (inspectGoPlusSubscriptionFlag(data)) {
        this.hasHqAudioFeature = true;
        this.hasAuthenticatedUser = true;
      }
    }

    if (isRecord(node['apiClient']) && typeof node['apiClient']['id'] === 'string') {
      const cid = node['apiClient']['id'].trim();
      if (cid.length > 0) {
        this.clientId = cid;
      }
    }
    if (node['features'] !== undefined) {
      this.inspectFeaturesValue(node['features']);
    }
    if (isRecord(node['meUser'])) {
      const me = node['meUser'];
      if (typeof me['id'] === 'number' || typeof me['id'] === 'string') {
        this.hasAuthenticatedUser = true;
      }
      if (inspectGoPlusSubscriptionFlag(me)) {
        this.hasHqAudioFeature = true;
        this.hasAuthenticatedUser = true;
      }
    }
  }

  private inspectFeaturesValue(features: unknown): void {
    if (Array.isArray(features)) {
      for (const entry of features) {
        if (typeof entry === 'string' && entry.trim().toLowerCase() === 'hq_audio') {
          this.hasHqAudioFeature = true;
        }
      }
      return;
    }
    if (isRecord(features)) {
      if (features['hq_audio'] === true) {
        this.hasHqAudioFeature = true;
      }
      if (Array.isArray(features['features'])) {
        this.inspectFeaturesValue(features['features']);
      }
    }
  }

  private serializeState(): string {
    const snap = this.getSnapshot();
    return `${snap.clientId}|${snap.oauthToken ?? ''}|${snap.accountTier}|${String(snap.hasHqAudioFeature)}`;
  }

  private finalizeMutation(previousSerialized: string): boolean {
    if (this.hasHqAudioFeature) {
      promoteSoundCloudLocalSettingsToHq(this.localStorageRef, true);
    }
    const nextSerialized = this.serializeState();
    if (nextSerialized === previousSerialized) {
      return false;
    }
    const snapshot = this.getSnapshot();
    for (const listener of this.listeners) {
      listener(snapshot);
    }
    return true;
  }
}
