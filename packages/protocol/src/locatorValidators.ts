/**
 * Runtime validators and TypeScript type guards for `StreamLocatorPayload`
 * and `TrackMetadata` (`v1`).
 */

import {
  ACCOUNT_TIERS,
  PLAYABLE_PROTOCOLS,
  SOURCE_SAMPLE_RATES_HZ,
  STREAM_QUALITY_TIERS,
  type EphemeralSoundCloudAuth,
  type SelectedTranscodingDescriptor,
  type StreamLocatorPayload,
  type TrackMetadata,
} from './soundcloud.js';
import {
  err,
  isPlainObject,
  ok,
  readArray,
  readEnum,
  readHttpUrl,
  readNonEmptyString,
  readNonNegativeNumber,
  readOptionalHttpUrl,
  readOptionalNonEmptyString,
  readPositiveNumber,
  readString,
  unwrapJsonObject,
  type Result,
} from './validationPrimitives.js';

export function parseSelectedTranscodingDescriptorObject(
  obj: Record<string, unknown>,
  context: string,
  allowNull: boolean,
): Result<SelectedTranscodingDescriptor> {
  const resolveUrl = readHttpUrl(obj, 'resolveUrl', context);
  if (!resolveUrl.ok) return resolveUrl;
  const preset = readNonEmptyString(obj, 'preset', context);
  if (!preset.ok) return preset;
  const protocol = readEnum(obj, 'protocol', PLAYABLE_PROTOCOLS, context);
  if (!protocol.ok) return protocol;
  const mimeType = readNonEmptyString(obj, 'mimeType', context);
  if (!mimeType.ok) return mimeType;
  const quality = readEnum(obj, 'quality', STREAM_QUALITY_TIERS, context);
  if (!quality.ok) return quality;
  const bitrateKbps = readPositiveNumber(obj, 'bitrateKbps', context);
  if (!bitrateKbps.ok) return bitrateKbps;
  const sampleRateHz = readEnum(
    obj,
    'sampleRateHz',
    SOURCE_SAMPLE_RATES_HZ,
    context,
  );
  if (!sampleRateHz.ok) return sampleRateHz;
  const initialPlaylistUrl = readOptionalHttpUrl(
    obj,
    'initialPlaylistUrl',
    context,
    allowNull,
  );
  if (!initialPlaylistUrl.ok) return initialPlaylistUrl;

  return ok({
    resolveUrl: resolveUrl.value,
    preset: preset.value,
    protocol: protocol.value,
    mimeType: mimeType.value,
    quality: quality.value,
    bitrateKbps: bitrateKbps.value,
    sampleRateHz: sampleRateHz.value,
    ...(initialPlaylistUrl.value !== undefined
      ? { initialPlaylistUrl: initialPlaylistUrl.value }
      : {}),
  });
}

export function parseEphemeralSoundCloudAuthObject(
  obj: Record<string, unknown>,
  context: string,
  allowNull: boolean,
): Result<EphemeralSoundCloudAuth> {
  const clientId = readNonEmptyString(obj, 'clientId', context);
  if (!clientId.ok) return clientId;
  const oauthToken = readOptionalNonEmptyString(
    obj,
    'oauthToken',
    context,
    allowNull,
  );
  if (!oauthToken.ok) return oauthToken;
  const trackAuthorization = readOptionalNonEmptyString(
    obj,
    'trackAuthorization',
    context,
    allowNull,
  );
  if (!trackAuthorization.ok) return trackAuthorization;
  const secretToken = readOptionalNonEmptyString(
    obj,
    'secretToken',
    context,
    allowNull,
  );
  if (!secretToken.ok) return secretToken;
  const accountTier = readEnum(obj, 'accountTier', ACCOUNT_TIERS, context);
  if (!accountTier.ok) return accountTier;

  return ok({
    clientId: clientId.value,
    ...(oauthToken.value !== undefined ? { oauthToken: oauthToken.value } : {}),
    ...(trackAuthorization.value !== undefined
      ? { trackAuthorization: trackAuthorization.value }
      : {}),
    ...(secretToken.value !== undefined ? { secretToken: secretToken.value } : {}),
    accountTier: accountTier.value,
  });
}

export function parseTrackMetadataObject(
  obj: Record<string, unknown>,
  context: string,
  allowNull: boolean,
): Result<TrackMetadata> {
  const trackId = readNonEmptyString(obj, 'trackId', context);
  if (!trackId.ok) return trackId;
  const permalinkUrl = readHttpUrl(obj, 'permalinkUrl', context);
  if (!permalinkUrl.ok) return permalinkUrl;
  const title = readString(obj, 'title', context);
  if (!title.ok) return title;
  const artist = readString(obj, 'artist', context);
  if (!artist.ok) return artist;
  const artworkUrl = readOptionalHttpUrl(obj, 'artworkUrl', context, allowNull);
  if (!artworkUrl.ok) return artworkUrl;
  const durationMs = readNonNegativeNumber(obj, 'durationMs', context);
  if (!durationMs.ok) return durationMs;
  const waveformUrl = readOptionalHttpUrl(obj, 'waveformUrl', context, allowNull);
  if (!waveformUrl.ok) return waveformUrl;

  return ok({
    trackId: trackId.value,
    permalinkUrl: permalinkUrl.value,
    title: title.value,
    artist: artist.value,
    ...(artworkUrl.value !== undefined ? { artworkUrl: artworkUrl.value } : {}),
    durationMs: durationMs.value,
    ...(waveformUrl.value !== undefined ? { waveformUrl: waveformUrl.value } : {}),
  });
}

export function parseStreamLocatorPayloadObject(
  obj: Record<string, unknown>,
  context: string,
  allowNull: boolean,
): Result<StreamLocatorPayload> {
  const locatorId = readNonEmptyString(obj, 'locatorId', context);
  if (!locatorId.ok) return locatorId;

  const rawTrack = obj['track'];
  if (!isPlainObject(rawTrack)) {
    return err(`${context}.track: expected plain object`);
  }
  const track = parseTrackMetadataObject(rawTrack, `${context}.track`, allowNull);
  if (!track.ok) return track;

  const rawSelected = obj['selected'];
  if (!isPlainObject(rawSelected)) {
    return err(`${context}.selected: expected plain object`);
  }
  const selected = parseSelectedTranscodingDescriptorObject(
    rawSelected,
    `${context}.selected`,
    allowNull,
  );
  if (!selected.ok) return selected;

  const fallbackTranscodings = readArray(
    obj,
    'fallbackTranscodings',
    context,
    (item, itemCtx) => {
      if (!isPlainObject(item)) return err(`${itemCtx}: expected plain object`);
      return parseSelectedTranscodingDescriptorObject(item, itemCtx, allowNull);
    },
  );
  if (!fallbackTranscodings.ok) return fallbackTranscodings;

  const rawAuth = obj['auth'];
  if (!isPlainObject(rawAuth)) {
    return err(`${context}.auth: expected plain object`);
  }
  const auth = parseEphemeralSoundCloudAuthObject(
    rawAuth,
    `${context}.auth`,
    allowNull,
  );
  if (!auth.ok) return auth;

  const startPositionMs = readNonNegativeNumber(obj, 'startPositionMs', context);
  if (!startPositionMs.ok) return startPositionMs;

  return ok({
    locatorId: locatorId.value,
    track: track.value,
    selected: selected.value,
    fallbackTranscodings: fallbackTranscodings.value,
    auth: auth.value,
    startPositionMs: startPositionMs.value,
  });
}

export function parseStreamLocatorPayload(
  input: unknown,
): Result<StreamLocatorPayload> {
  const unwrapped = unwrapJsonObject(input, 'StreamLocatorPayload');
  if (!unwrapped.ok) return unwrapped;
  return parseStreamLocatorPayloadObject(
    unwrapped.value,
    'StreamLocatorPayload',
    true,
  );
}

export function isValidStreamLocatorPayload(
  value: unknown,
): value is StreamLocatorPayload {
  if (!isPlainObject(value)) return false;
  return parseStreamLocatorPayloadObject(value, 'StreamLocatorPayload', false).ok;
}
