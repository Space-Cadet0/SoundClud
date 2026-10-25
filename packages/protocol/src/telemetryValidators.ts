/**
 * Runtime validators for `PlaybackTelemetry`, `ActiveStreamTelemetry`,
 * `ReceiverConfig`, and `PeerReceiverSummary` (`v1`).
 */

import {
  BIT_PERFECT_BIT_DEPTH,
  BIT_PERFECT_GAIN_DB,
  BIT_PERFECT_SAMPLE_RATE_HZ,
  PROTOCOL_VERSION,
} from './constants.js';
import { parseTrackMetadataObject } from './locatorValidators.js';
import { OUTPUT_DEVICE_KINDS, VOLUME_CONTROL_MODES } from './outputs.js';
import type { PeerReceiverSummary } from './rest.js';
import {
  ACCOUNT_TIERS,
  PLAYABLE_PROTOCOLS,
  STREAM_QUALITY_TIERS,
  type TrackMetadata,
} from './soundcloud.js';
import {
  PLAYBACK_PHASES,
  type ActiveStreamTelemetry,
  type PlaybackTelemetry,
  type ReceiverConfig,
} from './telemetry.js';
import {
  err,
  isPlainObject,
  ok,
  readBoolean,
  readEnum,
  readLiteral,
  readNonEmptyString,
  readNonNegativeInt,
  readNonNegativeNumber,
  readOptionalEnum,
  readOptionalNonEmptyString,
  readOptionalString,
  readPortNumber,
  readPositiveNumber,
  unwrapJsonObject,
  type Result,
} from './validationPrimitives.js';

export function parseActiveStreamTelemetryObject(
  obj: Record<string, unknown>,
  context: string,
): Result<ActiveStreamTelemetry> {
  const preset = readNonEmptyString(obj, 'preset', context);
  if (!preset.ok) return preset;
  const quality = readEnum(obj, 'quality', STREAM_QUALITY_TIERS, context);
  if (!quality.ok) return quality;
  const protocol = readEnum(obj, 'protocol', PLAYABLE_PROTOCOLS, context);
  if (!protocol.ok) return protocol;
  const bitrateKbps = readPositiveNumber(obj, 'bitrateKbps', context);
  if (!bitrateKbps.ok) return bitrateKbps;
  const accountTier = readEnum(obj, 'accountTier', ACCOUNT_TIERS, context);
  if (!accountTier.ok) return accountTier;
  const hlsRefreshCount = readNonNegativeInt(obj, 'hlsRefreshCount', context);
  if (!hlsRefreshCount.ok) return hlsRefreshCount;

  return ok({
    preset: preset.value,
    quality: quality.value,
    protocol: protocol.value,
    bitrateKbps: bitrateKbps.value,
    accountTier: accountTier.value,
    hlsRefreshCount: hlsRefreshCount.value,
  });
}

export function parsePlaybackTelemetryObject(
  obj: Record<string, unknown>,
  context: string,
  allowNull: boolean,
): Result<PlaybackTelemetry> {
  const protocolVersion = readLiteral(
    obj,
    'protocolVersion',
    PROTOCOL_VERSION,
    context,
  );
  if (!protocolVersion.ok) return protocolVersion;
  const serverSeq = readNonNegativeInt(obj, 'serverSeq', context);
  if (!serverSeq.ok) return serverSeq;
  const phase = readEnum(obj, 'phase', PLAYBACK_PHASES, context);
  if (!phase.ok) return phase;
  const activeOutputId = readOptionalNonEmptyString(
    obj,
    'activeOutputId',
    context,
    allowNull,
  );
  if (!activeOutputId.ok) return activeOutputId;
  const activeBackend = readOptionalEnum(
    obj,
    'activeBackend',
    OUTPUT_DEVICE_KINDS,
    context,
    allowNull,
  );
  if (!activeBackend.ok) return activeBackend;
  const volumeMode = readEnum(obj, 'volumeMode', VOLUME_CONTROL_MODES, context);
  if (!volumeMode.ok) return volumeMode;
  const fixedGainDb = readLiteral(obj, 'fixedGainDb', BIT_PERFECT_GAIN_DB, context);
  if (!fixedGainDb.ok) return fixedGainDb;
  const sampleRateHz = readLiteral(
    obj,
    'sampleRateHz',
    BIT_PERFECT_SAMPLE_RATE_HZ,
    context,
  );
  if (!sampleRateHz.ok) return sampleRateHz;
  const bitDepth = readLiteral(obj, 'bitDepth', BIT_PERFECT_BIT_DEPTH, context);
  if (!bitDepth.ok) return bitDepth;
  const positionMs = readNonNegativeNumber(obj, 'positionMs', context);
  if (!positionMs.ok) return positionMs;
  const durationMs = readNonNegativeNumber(obj, 'durationMs', context);
  if (!durationMs.ok) return durationMs;
  const bufferedMs = readNonNegativeNumber(obj, 'bufferedMs', context);
  if (!bufferedMs.ok) return bufferedMs;

  let track: TrackMetadata | undefined;
  if (
    'track' in obj &&
    obj['track'] !== undefined &&
    !(allowNull && obj['track'] === null)
  ) {
    const rawTrack = obj['track'];
    if (!isPlainObject(rawTrack)) {
      return err(`${context}.track: expected optional plain object`);
    }
    const parsedTrack = parseTrackMetadataObject(
      rawTrack,
      `${context}.track`,
      allowNull,
    );
    if (!parsedTrack.ok) return parsedTrack;
    track = parsedTrack.value;
  }

  let streamInfo: ActiveStreamTelemetry | undefined;
  if (
    'streamInfo' in obj &&
    obj['streamInfo'] !== undefined &&
    !(allowNull && obj['streamInfo'] === null)
  ) {
    const rawInfo = obj['streamInfo'];
    if (!isPlainObject(rawInfo)) {
      return err(`${context}.streamInfo: expected optional plain object`);
    }
    const parsedInfo = parseActiveStreamTelemetryObject(
      rawInfo,
      `${context}.streamInfo`,
    );
    if (!parsedInfo.ok) return parsedInfo;
    streamInfo = parsedInfo.value;
  }

  const activeControllerId = readOptionalNonEmptyString(
    obj,
    'activeControllerId',
    context,
    allowNull,
  );
  if (!activeControllerId.ok) return activeControllerId;
  const errorCode = readOptionalNonEmptyString(
    obj,
    'errorCode',
    context,
    allowNull,
  );
  if (!errorCode.ok) return errorCode;
  const errorMessage = readOptionalString(obj, 'errorMessage', context, allowNull);
  if (!errorMessage.ok) return errorMessage;
  const timestampMs = readNonNegativeNumber(obj, 'timestampMs', context);
  if (!timestampMs.ok) return timestampMs;

  return ok({
    protocolVersion: protocolVersion.value,
    serverSeq: serverSeq.value,
    phase: phase.value,
    ...(activeOutputId.value !== undefined
      ? { activeOutputId: activeOutputId.value }
      : {}),
    ...(activeBackend.value !== undefined
      ? { activeBackend: activeBackend.value }
      : {}),
    volumeMode: volumeMode.value,
    fixedGainDb: fixedGainDb.value,
    sampleRateHz: sampleRateHz.value,
    bitDepth: bitDepth.value,
    positionMs: positionMs.value,
    durationMs: durationMs.value,
    bufferedMs: bufferedMs.value,
    ...(track !== undefined ? { track } : {}),
    ...(streamInfo !== undefined ? { streamInfo } : {}),
    ...(activeControllerId.value !== undefined
      ? { activeControllerId: activeControllerId.value }
      : {}),
    ...(errorCode.value !== undefined ? { errorCode: errorCode.value } : {}),
    ...(errorMessage.value !== undefined
      ? { errorMessage: errorMessage.value }
      : {}),
    timestampMs: timestampMs.value,
  });
}

export function parsePlaybackTelemetry(input: unknown): Result<PlaybackTelemetry> {
  const unwrapped = unwrapJsonObject(input, 'PlaybackTelemetry');
  if (!unwrapped.ok) return unwrapped;
  return parsePlaybackTelemetryObject(unwrapped.value, 'PlaybackTelemetry', true);
}

export function parseReceiverConfigObject(
  obj: Record<string, unknown>,
  context: string,
  allowNull: boolean,
): Result<ReceiverConfig> {
  const activeOutputId = readOptionalNonEmptyString(
    obj,
    'activeOutputId',
    context,
    allowNull,
  );
  if (!activeOutputId.ok) return activeOutputId;
  const volumeMode = readEnum(obj, 'volumeMode', VOLUME_CONTROL_MODES, context);
  if (!volumeMode.ok) return volumeMode;
  const opticalIdleKeepalive = readBoolean(obj, 'opticalIdleKeepalive', context);
  if (!opticalIdleKeepalive.ok) return opticalIdleKeepalive;
  const opticalDitherSubaudible = readBoolean(
    obj,
    'opticalDitherSubaudible',
    context,
  );
  if (!opticalDitherSubaudible.ok) return opticalDitherSubaudible;

  return ok({
    ...(activeOutputId.value !== undefined
      ? { activeOutputId: activeOutputId.value }
      : {}),
    volumeMode: volumeMode.value,
    opticalIdleKeepalive: opticalIdleKeepalive.value,
    opticalDitherSubaudible: opticalDitherSubaudible.value,
  });
}

export function parseReceiverConfig(input: unknown): Result<ReceiverConfig> {
  const unwrapped = unwrapJsonObject(input, 'ReceiverConfig');
  if (!unwrapped.ok) return unwrapped;
  return parseReceiverConfigObject(unwrapped.value, 'ReceiverConfig', true);
}

export function parsePeerReceiverSummaryObject(
  obj: Record<string, unknown>,
  context: string,
): Result<PeerReceiverSummary> {
  const receiverId = readNonEmptyString(obj, 'receiverId', context);
  if (!receiverId.ok) return receiverId;
  const receiverName = readNonEmptyString(obj, 'receiverName', context);
  if (!receiverName.ok) return receiverName;
  const host = readNonEmptyString(obj, 'host', context);
  if (!host.ok) return host;
  const port = readPortNumber(obj, 'port', context);
  if (!port.ok) return port;
  const protocolVersion = readLiteral(
    obj,
    'protocolVersion',
    PROTOCOL_VERSION,
    context,
  );
  if (!protocolVersion.ok) return protocolVersion;

  return ok({
    receiverId: receiverId.value,
    receiverName: receiverName.value,
    host: host.value,
    port: port.value,
    protocolVersion: protocolVersion.value,
  });
}
