/**
 * Origin-scoped SoundCloud credential URL guard and canonical transcoding
 * resolve-URL matcher (`v1`).
 */

import { SOUNDCLOUD_API_ORIGINS } from './constants.js';

const ALLOWED_AUTH_ORIGINS_SET: ReadonlySet<string> = new Set<string>(
  SOUNDCLOUD_API_ORIGINS,
);

const EPHEMERAL_RESOLVE_QUERY_PARAMS: ReadonlySet<string> = new Set<string>([
  'client_id',
  'track_authorization',
  'secret_token',
  'app_version',
  'app_locale',
  '_',
  't',
  'ts',
  'timestamp',
]);

function extractStableQueryParams(url: URL): Map<string, string> {
  const stable = new Map<string, string>();
  for (const [key, value] of url.searchParams.entries()) {
    if (!EPHEMERAL_RESOLVE_QUERY_PARAMS.has(key.toLowerCase())) {
      stable.set(key, value);
    }
  }
  return stable;
}

/**
 * Checks whether an in-tab intercepted resolve URL corresponds to the exact
 * same SoundCloud transcoding endpoint as `candidateResolveUrl`, ignoring
 * ephemeral auth/timestamp query parameters while rejecting distinct paths or
 * conflicting non-ephemeral query parameters.
 */
export function areMatchingTranscodingResolveUrls(
  candidateResolveUrl: string,
  observedResolveUrl: string,
): boolean {
  const trimmedCandidate = candidateResolveUrl.trim();
  const trimmedObserved = observedResolveUrl.trim();
  if (trimmedCandidate.length === 0 || trimmedObserved.length === 0) {
    return false;
  }
  if (trimmedCandidate === trimmedObserved) {
    return true;
  }

  try {
    const parsedCandidate = new URL(trimmedCandidate);
    const parsedObserved = new URL(trimmedObserved);
    if (
      parsedCandidate.origin !== parsedObserved.origin ||
      parsedCandidate.pathname !== parsedObserved.pathname
    ) {
      return false;
    }

    const stableCandidate = extractStableQueryParams(parsedCandidate);
    const stableObserved = extractStableQueryParams(parsedObserved);
    if (stableCandidate.size !== stableObserved.size) {
      return false;
    }
    for (const [key, value] of stableCandidate.entries()) {
      if (stableObserved.get(key) !== value) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Verifies that SoundCloud session credentials (`OAuth`, `client_id`,
 * `track_authorization`, `secret_token`) may ONLY be sent to official HTTPS
 * SoundCloud API origins (`https://api-v2.soundcloud.com` or
 * `https://api.soundcloud.com`) and NEVER to signed media CDNs or third-party hosts.
 */
export function isAllowedSoundCloudApiAuthUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    return false;
  }

  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'https:') {
      return false;
    }
    if (parsed.username !== '' || parsed.password !== '') {
      return false;
    }
    if (parsed.port !== '') {
      return false;
    }
    return (
      ALLOWED_AUTH_ORIGINS_SET.has(parsed.origin) &&
      (parsed.hostname === 'api-v2.soundcloud.com' ||
        parsed.hostname === 'api.soundcloud.com')
    );
  } catch {
    return false;
  }
}
