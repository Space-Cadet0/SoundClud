/**
 * Passive SoundCloud track catalog & Go+ `aac_256k` `StreamLocatorPayload` builder (`MAIN` world).
 *
 * Indexes track objects (`media.transcodings[]`, `track_authorization`, `secret_token`)
 * from `window.__sc_hydration` and `api-v2.soundcloud.com` responses, maps resolved
 * `.m3u8` URLs back to their transcoding resolve endpoints, and delegates codec
 * selection to `@soundclud/protocol`'s `rankSoundCloudTranscodings`.
 */

import {
  areMatchingTranscodingResolveUrls,
  rankSoundCloudTranscodings,
  type EphemeralSoundCloudAuth,
  type ObservedInTabPlaylist,
  type SoundCloudTranscoding,
  type StreamLocatorPayload,
  type TrackMetadata,
  type TranscodingSelectionResult,
} from '@soundclud/protocol';
import { isRecord } from '../shared/messages.js';
import type { SessionSnapshot } from './sessionObserver.js';

export interface CatalogTrackEntry {
  readonly trackId: string;
  readonly permalinkUrl: string;
  readonly title: string;
  readonly artist: string;
  readonly artworkUrl?: string | undefined;
  readonly durationMs: number;
  readonly waveformUrl?: string | undefined;
  readonly transcodings: readonly SoundCloudTranscoding[];
  readonly trackAuthorization?: string | undefined;
  readonly secretToken?: string | undefined;
  readonly updatedAtMs: number;
}

export type CatalogLocatorResolution =
  | {
      readonly kind: 'playable';
      readonly locator: StreamLocatorPayload;
      readonly track: CatalogTrackEntry;
      readonly selection: Extract<TranscodingSelectionResult, { kind: 'playable' }>;
    }
  | {
      readonly kind: 'drm_local_fallback';
      readonly track: CatalogTrackEntry;
      readonly protocolsSeen: readonly string[];
    }
  | {
      readonly kind: 'unplayable';
      readonly track?: CatalogTrackEntry | undefined;
      readonly reason: string;
    };

export type TrackResolveObserver = (
  track: CatalogTrackEntry,
  selection: TranscodingSelectionResult,
) => void;

const TRACK_URN_REGEX = /soundcloud:tracks:(\d+)/i;

function extractSecretTokenFromUrl(rawUrl: string | undefined): string | undefined {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return undefined;
  }
  try {
    const parsed = new URL(rawUrl, 'https://soundcloud.com');
    const querySecret = parsed.searchParams.get('secret_token')?.trim();
    if (querySecret !== undefined && querySecret.length > 0) {
      return querySecret;
    }
    const pathSegments = parsed.pathname.split('/').filter(Boolean);
    const lastSeg = pathSegments[pathSegments.length - 1];
    if (lastSeg !== undefined && /^s-[A-Za-z0-9_-]{3,}$/.test(lastSeg)) {
      return lastSeg;
    }
  } catch {
    // Ignore unparseable URL fragments.
  }
  return undefined;
}

function normalizePermalinkKey(rawUrlOrPath: string): string | undefined {
  try {
    const parsed = new URL(rawUrlOrPath, 'https://soundcloud.com');
    const cleaned = parsed.pathname.replace(/\/+$/, '').toLowerCase();
    return cleaned.length > 0 ? cleaned : undefined;
  } catch {
    return undefined;
  }
}

function parseTranscodingItem(item: unknown): SoundCloudTranscoding | undefined {
  if (!isRecord(item) || !isRecord(item['format'])) {
    return undefined;
  }
  const url = typeof item['url'] === 'string' ? item['url'].trim() : '';
  const preset = typeof item['preset'] === 'string' ? item['preset'].trim() : '';
  const protocol =
    typeof item['format']['protocol'] === 'string'
      ? item['format']['protocol'].trim()
      : '';
  const mimeType =
    typeof item['format']['mime_type'] === 'string'
      ? item['format']['mime_type'].trim()
      : '';

  if (url.length === 0 || protocol.length === 0 || mimeType.length === 0) {
    return undefined;
  }

  const duration =
    typeof item['duration'] === 'number' && Number.isFinite(item['duration'])
      ? Math.max(0, Math.round(item['duration']))
      : 0;
  const snipped = typeof item['snipped'] === 'boolean' ? item['snipped'] : undefined;
  const quality = typeof item['quality'] === 'string' ? item['quality'] : undefined;

  return {
    url,
    preset,
    duration,
    ...(snipped !== undefined ? { snipped } : {}),
    format: {
      protocol,
      mime_type: mimeType,
    },
    ...(quality !== undefined ? { quality } : {}),
  };
}

function parseCandidateTrackObject(
  node: Record<string, unknown>,
  nowMs: number,
  sourceSecretToken?: string,
): CatalogTrackEntry | undefined {
  const idRaw = node['id'];
  if (typeof idRaw !== 'number' && typeof idRaw !== 'string') {
    return undefined;
  }
  const trackId = String(idRaw).trim();
  if (trackId.length === 0) {
    return undefined;
  }

  const media = node['media'];
  if (!isRecord(media) || !Array.isArray(media['transcodings'])) {
    return undefined;
  }

  const title = typeof node['title'] === 'string' ? node['title'].trim() : '';
  if (title.length === 0) {
    return undefined;
  }

  const transcodings: SoundCloudTranscoding[] = [];
  for (const rawTranscoding of media['transcodings']) {
    const parsed = parseTranscodingItem(rawTranscoding);
    if (parsed !== undefined) {
      transcodings.push(parsed);
    }
  }
  if (transcodings.length === 0) {
    return undefined;
  }

  const permalinkUrl =
    typeof node['permalink_url'] === 'string' && node['permalink_url'].trim().length > 0
      ? node['permalink_url'].trim()
      : `https://soundcloud.com/tracks/${trackId}`;

  const userRecord = isRecord(node['user']) ? node['user'] : undefined;
  const pubMeta = isRecord(node['publisher_metadata'])
    ? node['publisher_metadata']
    : undefined;
  const artist =
    (typeof userRecord?.['username'] === 'string' &&
    userRecord['username'].trim().length > 0
      ? userRecord['username'].trim()
      : undefined) ??
    (typeof pubMeta?.['artist'] === 'string' && pubMeta['artist'].trim().length > 0
      ? pubMeta['artist'].trim()
      : undefined) ??
    'Unknown Artist';

  const artworkUrl =
    (typeof node['artwork_url'] === 'string' && node['artwork_url'].trim().length > 0
      ? node['artwork_url'].trim()
      : undefined) ??
    (typeof userRecord?.['avatar_url'] === 'string' &&
    userRecord['avatar_url'].trim().length > 0
      ? userRecord['avatar_url'].trim()
      : undefined);

  const rawFullDuration = node['full_duration'];
  const rawDuration = node['duration'];
  const durationMs =
    typeof rawFullDuration === 'number' && rawFullDuration > 0
      ? Math.round(rawFullDuration)
      : typeof rawDuration === 'number' && rawDuration > 0
        ? Math.round(rawDuration)
        : transcodings[0]?.duration ?? 0;

  const waveformUrl =
    typeof node['waveform_url'] === 'string' && node['waveform_url'].trim().length > 0
      ? node['waveform_url'].trim()
      : undefined;

  const trackAuthorization =
    typeof node['track_authorization'] === 'string' &&
    node['track_authorization'].trim().length > 0
      ? node['track_authorization'].trim()
      : undefined;

  const secretToken =
    (typeof node['secret_token'] === 'string' && node['secret_token'].trim().length > 0
      ? node['secret_token'].trim()
      : undefined) ??
    extractSecretTokenFromUrl(permalinkUrl) ??
    sourceSecretToken;

  return {
    trackId,
    permalinkUrl,
    title,
    artist,
    ...(artworkUrl !== undefined ? { artworkUrl } : {}),
    durationMs,
    ...(waveformUrl !== undefined ? { waveformUrl } : {}),
    transcodings,
    ...(trackAuthorization !== undefined ? { trackAuthorization } : {}),
    ...(secretToken !== undefined ? { secretToken } : {}),
    updatedAtMs: nowMs,
  };
}

function generateLocatorId(trackId: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `loc-${trackId}-${crypto.randomUUID()}`;
  }
  return `loc-${trackId}-${String(Date.now())}`;
}

export class SoundCloudTrackCatalog {
  private readonly tracksById = new Map<string, CatalogTrackEntry>();
  private readonly trackIdByPermalinkPath = new Map<string, string>();
  private readonly observedPlaylistsByTrackId = new Map<string, ObservedInTabPlaylist>();
  private readonly trackIdByMediaUrl = new Map<string, string>();
  private mostRecentlyResolvedTrackId: string | undefined;
  private locatorCounter = 0;
  private readonly resolveObservers = new Set<TrackResolveObserver>();
  private readonly onHqTranscodingSeen: (() => void) | undefined;

  public constructor(options?: {
    readonly onHqTranscodingSeen?: (() => void) | undefined;
  }) {
    this.onHqTranscodingSeen = options?.onHqTranscodingSeen;
  }

  public get size(): number {
    return this.tracksById.size;
  }

  public onTrackStreamResolved(observer: TrackResolveObserver): () => void {
    this.resolveObservers.add(observer);
    return () => {
      this.resolveObservers.delete(observer);
    };
  }

  public ingestPayload(payload: unknown, sourceUrl?: string): number {
    const nowMs = Date.now();
    const sourceSecret = extractSecretTokenFromUrl(sourceUrl);
    const visited = new WeakSet<object>();
    const indexedCount = this.walkNode(payload, 0, nowMs, sourceSecret, visited);

    if (
      sourceUrl !== undefined &&
      isRecord(payload) &&
      typeof payload['url'] === 'string' &&
      payload['url'].trim().length > 0
    ) {
      this.recordResolvedStreamUrl(sourceUrl, payload['url'].trim());
    }
    return indexedCount;
  }

  public recordResolvedStreamUrl(
    resolveRequestUrl: string,
    playlistOrMediaUrl: string,
  ): CatalogTrackEntry | undefined {
    const trimmedResolve = resolveRequestUrl.trim();
    const trimmedMedia = playlistOrMediaUrl.trim();
    if (trimmedResolve.length === 0 || trimmedMedia.length === 0) {
      return undefined;
    }

    const matchedEntry = this.findTrackByResolveUrlInternal(trimmedResolve);
    if (matchedEntry === undefined) {
      return undefined;
    }

    let updatedEntry = matchedEntry;
    try {
      const parsedReq = new URL(trimmedResolve);
      const reqTrackAuth = parsedReq.searchParams.get('track_authorization')?.trim();
      const reqSecret = parsedReq.searchParams.get('secret_token')?.trim();
      if (
        (reqTrackAuth !== undefined &&
          reqTrackAuth.length > 0 &&
          updatedEntry.trackAuthorization === undefined) ||
        (reqSecret !== undefined &&
          reqSecret.length > 0 &&
          updatedEntry.secretToken === undefined)
      ) {
        updatedEntry = {
          ...updatedEntry,
          ...(reqTrackAuth !== undefined && reqTrackAuth.length > 0
            ? { trackAuthorization: reqTrackAuth }
            : {}),
          ...(reqSecret !== undefined && reqSecret.length > 0
            ? { secretToken: reqSecret }
            : {}),
        };
        this.tracksById.set(updatedEntry.trackId, updatedEntry);
      }
    } catch {
      // Ignore relative/malformed URLs.
    }

    const observed: ObservedInTabPlaylist = {
      resolveUrl: trimmedResolve,
      playlistUrl: trimmedMedia,
    };
    this.observedPlaylistsByTrackId.set(updatedEntry.trackId, observed);
    this.trackIdByMediaUrl.set(trimmedMedia, updatedEntry.trackId);
    this.mostRecentlyResolvedTrackId = updatedEntry.trackId;

    const previewSelection = rankSoundCloudTranscodings(updatedEntry.transcodings, {
      observedInTabPlaylist: observed,
    });
    for (const observer of this.resolveObservers) {
      observer(updatedEntry, previewSelection);
    }
    return updatedEntry;
  }

  public observeResolveAttemptUrl(resolveRequestUrl: string): CatalogTrackEntry | undefined {
    const matched = this.findTrackByResolveUrlInternal(resolveRequestUrl.trim());
    if (matched !== undefined) {
      this.mostRecentlyResolvedTrackId = matched.trackId;
      const observed = this.observedPlaylistsByTrackId.get(matched.trackId);
      const previewSelection = rankSoundCloudTranscodings(matched.transcodings, {
        observedInTabPlaylist: observed,
      });
      for (const observer of this.resolveObservers) {
        observer(matched, previewSelection);
      }
    }
    return matched;
  }

  public findTrackById(trackId: string): CatalogTrackEntry | undefined {
    return this.tracksById.get(trackId.trim());
  }

  public findTrackByPermalink(urlOrPath: string): CatalogTrackEntry | undefined {
    const key = normalizePermalinkKey(urlOrPath);
    if (key === undefined) {
      return undefined;
    }
    const id = this.trackIdByPermalinkPath.get(key);
    return id !== undefined ? this.tracksById.get(id) : undefined;
  }

  public findTrackByMediaOrResolveUrl(url: string): CatalogTrackEntry | undefined {
    const trimmed = url.trim();
    if (trimmed.length === 0) {
      return undefined;
    }
    const directId = this.trackIdByMediaUrl.get(trimmed);
    if (directId !== undefined) {
      return this.tracksById.get(directId);
    }
    return this.findTrackByResolveUrlInternal(trimmed);
  }

  public getMostRecentlyResolvedTrack(): CatalogTrackEntry | undefined {
    if (this.mostRecentlyResolvedTrackId !== undefined) {
      return this.tracksById.get(this.mostRecentlyResolvedTrackId);
    }
    let newest: CatalogTrackEntry | undefined;
    for (const entry of this.tracksById.values()) {
      if (newest === undefined || entry.updatedAtMs >= newest.updatedAtMs) {
        newest = entry;
      }
    }
    return newest;
  }

  public buildLocatorForTrack(
    trackId: string,
    session: SessionSnapshot,
    startPositionMs = 0,
  ): CatalogLocatorResolution {
    const entry = this.tracksById.get(trackId.trim());
    if (entry === undefined) {
      return { kind: 'unplayable', reason: 'track_not_indexed' };
    }

    const observedInTabPlaylist = this.observedPlaylistsByTrackId.get(entry.trackId);
    const selection = rankSoundCloudTranscodings(entry.transcodings, {
      observedInTabPlaylist,
    });

    if (selection.kind === 'drm_local_fallback') {
      return {
        kind: 'drm_local_fallback',
        track: entry,
        protocolsSeen: selection.protocolsSeen,
      };
    }

    if (selection.kind === 'unplayable') {
      return {
        kind: 'unplayable',
        track: entry,
        reason: selection.reason,
      };
    }

    if (session.clientId.trim().length === 0) {
      return {
        kind: 'unplayable',
        track: entry,
        reason: 'missing_soundcloud_client_id',
      };
    }

    const trackMeta: TrackMetadata = {
      trackId: entry.trackId,
      permalinkUrl: entry.permalinkUrl,
      title: entry.title,
      artist: entry.artist,
      ...(entry.artworkUrl !== undefined ? { artworkUrl: entry.artworkUrl } : {}),
      durationMs: entry.durationMs,
      ...(entry.waveformUrl !== undefined ? { waveformUrl: entry.waveformUrl } : {}),
    };

    const effectiveTier =
      selection.selected.quality === 'hq' ? 'go_plus' : session.accountTier;

    const auth: EphemeralSoundCloudAuth = {
      clientId: session.clientId.trim(),
      ...(session.oauthToken !== undefined && session.oauthToken.length > 0
        ? { oauthToken: session.oauthToken }
        : {}),
      ...(entry.trackAuthorization !== undefined
        ? { trackAuthorization: entry.trackAuthorization }
        : {}),
      ...(entry.secretToken !== undefined ? { secretToken: entry.secretToken } : {}),
      accountTier: effectiveTier,
    };

    this.locatorCounter += 1;
    const locator: StreamLocatorPayload = {
      locatorId: `${generateLocatorId(entry.trackId)}-${String(this.locatorCounter)}`,
      track: trackMeta,
      selected: selection.selected,
      fallbackTranscodings: selection.fallbacks,
      auth,
      startPositionMs: Math.max(0, Math.round(startPositionMs)),
    };

    return {
      kind: 'playable',
      locator,
      track: entry,
      selection,
    };
  }

  private findTrackByResolveUrlInternal(url: string): CatalogTrackEntry | undefined {
    const urnMatch = TRACK_URN_REGEX.exec(url);
    if (urnMatch?.[1] !== undefined) {
      const byUrn = this.tracksById.get(urnMatch[1]);
      if (byUrn !== undefined) {
        return byUrn;
      }
    }

    for (const entry of this.tracksById.values()) {
      for (const transcoding of entry.transcodings) {
        if (areMatchingTranscodingResolveUrls(transcoding.url, url)) {
          return entry;
        }
      }
    }
    return undefined;
  }

  private walkNode(
    node: unknown,
    depth: number,
    nowMs: number,
    sourceSecretToken: string | undefined,
    visited: WeakSet<object>,
  ): number {
    if (depth > 14 || node === null || node === undefined || typeof node !== 'object') {
      return 0;
    }
    if (visited.has(node)) {
      return 0;
    }
    visited.add(node);

    let count = 0;
    if (Array.isArray(node)) {
      for (const item of node) {
        count += this.walkNode(item, depth + 1, nowMs, sourceSecretToken, visited);
      }
      return count;
    }

    const record = node as Record<string, unknown>;
    const candidate = parseCandidateTrackObject(record, nowMs, sourceSecretToken);
    if (candidate !== undefined) {
      this.upsertTrack(candidate);
      count += 1;
    }

    for (const childValue of Object.values(record)) {
      if (typeof childValue === 'object' && childValue !== null) {
        count += this.walkNode(
          childValue,
          depth + 1,
          nowMs,
          sourceSecretToken,
          visited,
        );
      }
    }
    return count;
  }

  private upsertTrack(candidate: CatalogTrackEntry): void {
    const existing = this.tracksById.get(candidate.trackId);
    const merged: CatalogTrackEntry =
      existing === undefined
        ? candidate
        : {
            ...candidate,
            ...(candidate.trackAuthorization === undefined &&
            existing.trackAuthorization !== undefined
              ? { trackAuthorization: existing.trackAuthorization }
              : {}),
            ...(candidate.secretToken === undefined &&
            existing.secretToken !== undefined
              ? { secretToken: existing.secretToken }
              : {}),
          };

    this.tracksById.set(merged.trackId, merged);
    const permalinkKey = normalizePermalinkKey(merged.permalinkUrl);
    if (permalinkKey !== undefined) {
      this.trackIdByPermalinkPath.set(permalinkKey, merged.trackId);
    }

    const hasFullLengthHq = merged.transcodings.some(
      (t) =>
        t.snipped !== true &&
        (t.quality?.toLowerCase() === 'hq' ||
          t.preset.toLowerCase().startsWith('aac_256')),
    );
    if (hasFullLengthHq && this.onHqTranscodingSeen !== undefined) {
      this.onHqTranscodingSeen();
    }
  }
}
