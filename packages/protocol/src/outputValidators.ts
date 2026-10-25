/**
 * Runtime validators and TypeScript type guards for `OutputDevice` and
 * `OutputCapabilities` (`v1`).
 */

import {
  BIT_PERFECT_BIT_DEPTH,
  BIT_PERFECT_GAIN_DB,
  BIT_PERFECT_SAMPLE_RATE_HZ,
} from './constants.js';
import {
  OUTPUT_DEVICE_KINDS,
  OUTPUT_TRANSPORTS,
  STANDBY_STATES,
  type OutputCapabilities,
  type OutputDevice,
} from './outputs.js';
import {
  err,
  isPlainObject,
  ok,
  readBoolean,
  readEnum,
  readLiteral,
  readNonEmptyString,
  readNonNegativeNumber,
  readOptionalEnum,
  readOptionalString,
  unwrapJsonObject,
  type Result,
} from './validationPrimitives.js';

export function parseOutputCapabilitiesObject(
  obj: Record<string, unknown>,
  context: string,
): Result<OutputCapabilities> {
  const bitPerfect = readLiteral(obj, 'bitPerfect', true, context);
  if (!bitPerfect.ok) return bitPerfect;
  const fixedGainDb = readLiteral(obj, 'fixedGainDb', BIT_PERFECT_GAIN_DB, context);
  if (!fixedGainDb.ok) return fixedGainDb;
  const targetSampleRateHz = readLiteral(
    obj,
    'targetSampleRateHz',
    BIT_PERFECT_SAMPLE_RATE_HZ,
    context,
  );
  if (!targetSampleRateHz.ok) return targetSampleRateHz;
  const targetBitDepth = readLiteral(
    obj,
    'targetBitDepth',
    BIT_PERFECT_BIT_DEPTH,
    context,
  );
  if (!targetBitDepth.ok) return targetBitDepth;
  const autoWake = readBoolean(obj, 'autoWakeFromStandby', context);
  if (!autoWake.ok) return autoWake;
  const displaysMeta = readBoolean(obj, 'displaysTrackMetadataOnDevice', context);
  if (!displaysMeta.ok) return displaysMeta;
  const seekDebounceMs = readNonNegativeNumber(obj, 'seekDebounceMs', context);
  if (!seekDebounceMs.ok) return seekDebounceMs;

  return ok({
    bitPerfect: bitPerfect.value,
    fixedGainDb: fixedGainDb.value,
    targetSampleRateHz: targetSampleRateHz.value,
    targetBitDepth: targetBitDepth.value,
    autoWakeFromStandby: autoWake.value,
    displaysTrackMetadataOnDevice: displaysMeta.value,
    seekDebounceMs: seekDebounceMs.value,
  });
}

export function parseOutputDeviceObject(
  obj: Record<string, unknown>,
  context: string,
  allowNull: boolean,
): Result<OutputDevice> {
  const id = readNonEmptyString(obj, 'id', context);
  if (!id.ok) return id;
  const kind = readEnum(obj, 'kind', OUTPUT_DEVICE_KINDS, context);
  if (!kind.ok) return kind;
  const name = readNonEmptyString(obj, 'name', context);
  if (!name.ok) return name;
  const model = readOptionalString(obj, 'model', context, allowNull);
  if (!model.ok) return model;
  const transport = readEnum(obj, 'transport', OUTPUT_TRANSPORTS, context);
  if (!transport.ok) return transport;
  const isRecommendedDefault = readBoolean(obj, 'isRecommendedDefault', context);
  if (!isRecommendedDefault.ok) return isRecommendedDefault;
  const isAvailable = readBoolean(obj, 'isAvailable', context);
  if (!isAvailable.ok) return isAvailable;
  const standbyState = readOptionalEnum(
    obj,
    'standbyState',
    STANDBY_STATES,
    context,
    allowNull,
  );
  if (!standbyState.ok) return standbyState;

  const rawCaps = obj['capabilities'];
  if (!isPlainObject(rawCaps)) {
    return err(`${context}.capabilities: expected plain object`);
  }
  const capabilities = parseOutputCapabilitiesObject(
    rawCaps,
    `${context}.capabilities`,
  );
  if (!capabilities.ok) return capabilities;

  return ok({
    id: id.value,
    kind: kind.value,
    name: name.value,
    ...(model.value !== undefined ? { model: model.value } : {}),
    transport: transport.value,
    isRecommendedDefault: isRecommendedDefault.value,
    isAvailable: isAvailable.value,
    ...(standbyState.value !== undefined
      ? { standbyState: standbyState.value }
      : {}),
    capabilities: capabilities.value,
  });
}

export function parseOutputDevice(input: unknown): Result<OutputDevice> {
  const unwrapped = unwrapJsonObject(input, 'OutputDevice');
  if (!unwrapped.ok) return unwrapped;
  return parseOutputDeviceObject(unwrapped.value, 'OutputDevice', true);
}

export function isValidOutputDevice(value: unknown): value is OutputDevice {
  if (!isPlainObject(value)) return false;
  return parseOutputDeviceObject(value, 'OutputDevice', false).ok;
}
