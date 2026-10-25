/**
 * Runtime parsers for REST `/api/v1/*` JSON payloads (`v1`).
 */

import { PROTOCOL_VERSION } from './constants.js';
import { parseOutputDeviceObject } from './outputValidators.js';
import type { OutputDevice } from './outputs.js';
import {
  RECEIVER_ARCHES,
  RECEIVER_PLATFORMS,
  type ApiErrorResponse,
  type AudioDevicesResponse,
  type DiscoverResponse,
  type PairRequest,
  type PairResponse,
  type StatusResponse,
  type UpdateConfigRequest,
  type UpdateConfigResponse,
} from './rest.js';
import {
  parsePeerReceiverSummaryObject,
  parsePlaybackTelemetryObject,
  parseReceiverConfigObject,
} from './telemetryValidators.js';
import {
  err,
  isPlainObject,
  ok,
  readArray,
  readBoolean,
  readEnum,
  readLiteral,
  readNonEmptyString,
  readOptionalBoolean,
  readOptionalNonEmptyString,
  readString,
  unwrapJsonObject,
  type Result,
} from './validationPrimitives.js';

function readOutputDeviceArray(
  obj: Record<string, unknown>,
  context: string,
): Result<readonly OutputDevice[]> {
  return readArray(obj, 'outputs', context, (item, itemCtx) => {
    if (!isPlainObject(item)) {
      return err(`${itemCtx}: expected plain object`);
    }
    return parseOutputDeviceObject(item, itemCtx, true);
  });
}

export function parseDiscoverResponse(
  input: unknown,
): Result<DiscoverResponse> {
  const unwrapped = unwrapJsonObject(input, 'DiscoverResponse');
  if (!unwrapped.ok) return unwrapped;
  const obj = unwrapped.value;
  const ctx = 'DiscoverResponse';

  const protocolVersion = readLiteral(obj, 'protocolVersion', PROTOCOL_VERSION, ctx);
  if (!protocolVersion.ok) return protocolVersion;
  const receiverId = readNonEmptyString(obj, 'receiverId', ctx);
  if (!receiverId.ok) return receiverId;
  const receiverName = readNonEmptyString(obj, 'receiverName', ctx);
  if (!receiverName.ok) return receiverName;
  const platform = readEnum(obj, 'platform', RECEIVER_PLATFORMS, ctx);
  if (!platform.ok) return platform;
  const arch = readEnum(obj, 'arch', RECEIVER_ARCHES, ctx);
  if (!arch.ok) return arch;
  const requiresPairing = readBoolean(obj, 'requiresPairing', ctx);
  if (!requiresPairing.ok) return requiresPairing;
  const outputs = readOutputDeviceArray(obj, ctx);
  if (!outputs.ok) return outputs;
  const peers = readArray(obj, 'peers', ctx, (item, itemCtx) => {
    if (!isPlainObject(item)) return err(`${itemCtx}: expected plain object`);
    return parsePeerReceiverSummaryObject(item, itemCtx);
  });
  if (!peers.ok) return peers;

  const rawConfig = obj['config'];
  if (!isPlainObject(rawConfig)) {
    return err(`${ctx}.config: expected plain object`);
  }
  const config = parseReceiverConfigObject(rawConfig, `${ctx}.config`, true);
  if (!config.ok) return config;

  return ok({
    protocolVersion: protocolVersion.value,
    receiverId: receiverId.value,
    receiverName: receiverName.value,
    platform: platform.value,
    arch: arch.value,
    requiresPairing: requiresPairing.value,
    outputs: outputs.value,
    peers: peers.value,
    config: config.value,
  });
}

export function parsePairRequest(input: unknown): Result<PairRequest> {
  const unwrapped = unwrapJsonObject(input, 'PairRequest');
  if (!unwrapped.ok) return unwrapped;
  const obj = unwrapped.value;
  const ctx = 'PairRequest';

  const protocolVersion = readLiteral(obj, 'protocolVersion', PROTOCOL_VERSION, ctx);
  if (!protocolVersion.ok) return protocolVersion;
  const clientLabel = readNonEmptyString(obj, 'clientLabel', ctx);
  if (!clientLabel.ok) return clientLabel;
  const controllerId = readNonEmptyString(obj, 'controllerId', ctx);
  if (!controllerId.ok) return controllerId;

  return ok({
    protocolVersion: protocolVersion.value,
    clientLabel: clientLabel.value,
    controllerId: controllerId.value,
  });
}

export function parsePairResponse(input: unknown): Result<PairResponse> {
  const unwrapped = unwrapJsonObject(input, 'PairResponse');
  if (!unwrapped.ok) return unwrapped;
  const obj = unwrapped.value;
  const ctx = 'PairResponse';

  const protocolVersion = readLiteral(obj, 'protocolVersion', PROTOCOL_VERSION, ctx);
  if (!protocolVersion.ok) return protocolVersion;
  const receiverId = readNonEmptyString(obj, 'receiverId', ctx);
  if (!receiverId.ok) return receiverId;
  const pairingToken = readNonEmptyString(obj, 'pairingToken', ctx);
  if (!pairingToken.ok) return pairingToken;

  return ok({
    protocolVersion: protocolVersion.value,
    receiverId: receiverId.value,
    pairingToken: pairingToken.value,
  });
}

export function parseAudioDevicesResponse(
  input: unknown,
): Result<AudioDevicesResponse> {
  const unwrapped = unwrapJsonObject(input, 'AudioDevicesResponse');
  if (!unwrapped.ok) return unwrapped;
  const obj = unwrapped.value;
  const ctx = 'AudioDevicesResponse';

  const protocolVersion = readLiteral(obj, 'protocolVersion', PROTOCOL_VERSION, ctx);
  if (!protocolVersion.ok) return protocolVersion;
  const activeOutputId = readOptionalNonEmptyString(
    obj,
    'activeOutputId',
    ctx,
    true,
  );
  if (!activeOutputId.ok) return activeOutputId;
  const outputs = readOutputDeviceArray(obj, ctx);
  if (!outputs.ok) return outputs;

  return ok({
    protocolVersion: protocolVersion.value,
    ...(activeOutputId.value !== undefined
      ? { activeOutputId: activeOutputId.value }
      : {}),
    outputs: outputs.value,
  });
}

export function parseUpdateConfigRequest(
  input: unknown,
): Result<UpdateConfigRequest> {
  const unwrapped = unwrapJsonObject(input, 'UpdateConfigRequest');
  if (!unwrapped.ok) return unwrapped;
  const obj = unwrapped.value;
  const ctx = 'UpdateConfigRequest';

  const activeOutputId = readOptionalNonEmptyString(
    obj,
    'activeOutputId',
    ctx,
    true,
  );
  if (!activeOutputId.ok) return activeOutputId;
  const opticalIdleKeepalive = readOptionalBoolean(
    obj,
    'opticalIdleKeepalive',
    ctx,
    true,
  );
  if (!opticalIdleKeepalive.ok) return opticalIdleKeepalive;
  const opticalDitherSubaudible = readOptionalBoolean(
    obj,
    'opticalDitherSubaudible',
    ctx,
    true,
  );
  if (!opticalDitherSubaudible.ok) return opticalDitherSubaudible;

  return ok({
    ...(activeOutputId.value !== undefined
      ? { activeOutputId: activeOutputId.value }
      : {}),
    ...(opticalIdleKeepalive.value !== undefined
      ? { opticalIdleKeepalive: opticalIdleKeepalive.value }
      : {}),
    ...(opticalDitherSubaudible.value !== undefined
      ? { opticalDitherSubaudible: opticalDitherSubaudible.value }
      : {}),
  });
}

export function parseUpdateConfigResponse(
  input: unknown,
): Result<UpdateConfigResponse> {
  const unwrapped = unwrapJsonObject(input, 'UpdateConfigResponse');
  if (!unwrapped.ok) return unwrapped;
  const obj = unwrapped.value;
  const ctx = 'UpdateConfigResponse';

  const protocolVersion = readLiteral(obj, 'protocolVersion', PROTOCOL_VERSION, ctx);
  if (!protocolVersion.ok) return protocolVersion;
  const rawConfig = obj['config'];
  if (!isPlainObject(rawConfig)) {
    return err(`${ctx}.config: expected plain object`);
  }
  const config = parseReceiverConfigObject(rawConfig, `${ctx}.config`, true);
  if (!config.ok) return config;
  const outputs = readOutputDeviceArray(obj, ctx);
  if (!outputs.ok) return outputs;

  return ok({
    protocolVersion: protocolVersion.value,
    config: config.value,
    outputs: outputs.value,
  });
}

export function parseStatusResponse(input: unknown): Result<StatusResponse> {
  const unwrapped = unwrapJsonObject(input, 'StatusResponse');
  if (!unwrapped.ok) return unwrapped;
  const obj = unwrapped.value;
  const ctx = 'StatusResponse';

  const protocolVersion = readLiteral(obj, 'protocolVersion', PROTOCOL_VERSION, ctx);
  if (!protocolVersion.ok) return protocolVersion;
  const receiverId = readNonEmptyString(obj, 'receiverId', ctx);
  if (!receiverId.ok) return receiverId;
  const receiverName = readNonEmptyString(obj, 'receiverName', ctx);
  if (!receiverName.ok) return receiverName;

  const rawConfig = obj['config'];
  if (!isPlainObject(rawConfig)) {
    return err(`${ctx}.config: expected plain object`);
  }
  const config = parseReceiverConfigObject(rawConfig, `${ctx}.config`, true);
  if (!config.ok) return config;

  const rawTelemetry = obj['telemetry'];
  if (!isPlainObject(rawTelemetry)) {
    return err(`${ctx}.telemetry: expected plain object`);
  }
  const telemetry = parsePlaybackTelemetryObject(
    rawTelemetry,
    `${ctx}.telemetry`,
    true,
  );
  if (!telemetry.ok) return telemetry;

  const outputs = readOutputDeviceArray(obj, ctx);
  if (!outputs.ok) return outputs;

  return ok({
    protocolVersion: protocolVersion.value,
    receiverId: receiverId.value,
    receiverName: receiverName.value,
    config: config.value,
    telemetry: telemetry.value,
    outputs: outputs.value,
  });
}

export function parseApiErrorResponse(
  input: unknown,
): Result<ApiErrorResponse> {
  const unwrapped = unwrapJsonObject(input, 'ApiErrorResponse');
  if (!unwrapped.ok) return unwrapped;
  const rawError = unwrapped.value['error'];
  if (!isPlainObject(rawError)) {
    return err('ApiErrorResponse.error: expected plain object');
  }
  const code = readNonEmptyString(rawError, 'code', 'ApiErrorResponse.error');
  if (!code.ok) return code;
  const message = readString(rawError, 'message', 'ApiErrorResponse.error');
  if (!message.ok) return message;

  return ok({
    error: {
      code: code.value,
      message: message.value,
    },
  });
}
