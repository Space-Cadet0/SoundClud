/**
 * Runtime parser for WebSocket `/api/v1/ws` client-to-server commands (`v1`).
 */

import { PROTOCOL_VERSION } from './constants.js';
import { parseStreamLocatorPayloadObject } from './locatorValidators.js';
import type { StreamLocatorPayload } from './soundcloud.js';
import {
  err,
  isPlainObject,
  ok,
  readBoolean,
  readLiteral,
  readNonEmptyString,
  readNonNegativeInt,
  readNonNegativeNumber,
  readOptionalEnum,
  readOptionalNonEmptyString,
  readOptionalString,
  unwrapJsonObject,
  type Result,
} from './validationPrimitives.js';
import { STOP_REASONS, type ClientWsCommand } from './ws.js';

export function parseClientWsCommand(input: unknown): Result<ClientWsCommand> {
  const unwrapped = unwrapJsonObject(input, 'ClientWsCommand');
  if (!unwrapped.ok) return unwrapped;
  const obj = unwrapped.value;
  const typeRes = readNonEmptyString(obj, 'type', 'ClientWsCommand');
  if (!typeRes.ok) return typeRes;

  switch (typeRes.value) {
    case 'hello': {
      const ctx = 'ClientWsCommand(hello)';
      const pv = readLiteral(obj, 'protocolVersion', PROTOCOL_VERSION, ctx);
      if (!pv.ok) return pv;
      const pairingToken = readNonEmptyString(obj, 'pairingToken', ctx);
      if (!pairingToken.ok) return pairingToken;
      const controllerId = readNonEmptyString(obj, 'controllerId', ctx);
      if (!controllerId.ok) return controllerId;
      const clientLabel = readNonEmptyString(obj, 'clientLabel', ctx);
      if (!clientLabel.ok) return clientLabel;
      return ok({
        type: 'hello',
        protocolVersion: pv.value,
        pairingToken: pairingToken.value,
        controllerId: controllerId.value,
        clientLabel: clientLabel.value,
      });
    }

    case 'load_track': {
      const ctx = 'ClientWsCommand(load_track)';
      const commandSeq = readNonNegativeInt(obj, 'commandSeq', ctx);
      if (!commandSeq.ok) return commandSeq;
      const rawLocator = obj['locator'];
      if (!isPlainObject(rawLocator)) {
        return err(`${ctx}.locator: expected plain object`);
      }
      const locator = parseStreamLocatorPayloadObject(
        rawLocator,
        `${ctx}.locator`,
        true,
      );
      if (!locator.ok) return locator;
      const preferredOutputId = readOptionalNonEmptyString(
        obj,
        'preferredOutputId',
        ctx,
        true,
      );
      if (!preferredOutputId.ok) return preferredOutputId;
      return ok({
        type: 'load_track',
        commandSeq: commandSeq.value,
        locator: locator.value,
        ...(preferredOutputId.value !== undefined
          ? { preferredOutputId: preferredOutputId.value }
          : {}),
      });
    }

    case 'set_paused': {
      const ctx = 'ClientWsCommand(set_paused)';
      const commandSeq = readNonNegativeInt(obj, 'commandSeq', ctx);
      if (!commandSeq.ok) return commandSeq;
      const paused = readBoolean(obj, 'paused', ctx);
      if (!paused.ok) return paused;
      return ok({
        type: 'set_paused',
        commandSeq: commandSeq.value,
        paused: paused.value,
      });
    }

    case 'seek': {
      const ctx = 'ClientWsCommand(seek)';
      const commandSeq = readNonNegativeInt(obj, 'commandSeq', ctx);
      if (!commandSeq.ok) return commandSeq;
      const positionMs = readNonNegativeNumber(obj, 'positionMs', ctx);
      if (!positionMs.ok) return positionMs;
      return ok({
        type: 'seek',
        commandSeq: commandSeq.value,
        positionMs: positionMs.value,
      });
    }

    case 'preload_next': {
      const ctx = 'ClientWsCommand(preload_next)';
      const commandSeq = readNonNegativeInt(obj, 'commandSeq', ctx);
      if (!commandSeq.ok) return commandSeq;
      const rawLocator = obj['locator'];
      if (!isPlainObject(rawLocator)) {
        return err(`${ctx}.locator: expected plain object`);
      }
      const locator = parseStreamLocatorPayloadObject(
        rawLocator,
        `${ctx}.locator`,
        true,
      );
      if (!locator.ok) return locator;
      return ok({
        type: 'preload_next',
        commandSeq: commandSeq.value,
        locator: locator.value,
      });
    }

    case 'stop': {
      const ctx = 'ClientWsCommand(stop)';
      const commandSeq = readNonNegativeInt(obj, 'commandSeq', ctx);
      if (!commandSeq.ok) return commandSeq;
      const reason = readOptionalEnum(obj, 'reason', STOP_REASONS, ctx, true);
      if (!reason.ok) return reason;
      return ok({
        type: 'stop',
        commandSeq: commandSeq.value,
        ...(reason.value !== undefined ? { reason: reason.value } : {}),
      });
    }

    case 'select_output': {
      const ctx = 'ClientWsCommand(select_output)';
      const commandSeq = readNonNegativeInt(obj, 'commandSeq', ctx);
      if (!commandSeq.ok) return commandSeq;
      const outputId = readNonEmptyString(obj, 'outputId', ctx);
      if (!outputId.ok) return outputId;
      return ok({
        type: 'select_output',
        commandSeq: commandSeq.value,
        outputId: outputId.value,
      });
    }

    case 'refresh_locator_response': {
      const ctx = 'ClientWsCommand(refresh_locator_response)';
      const requestId = readNonEmptyString(obj, 'requestId', ctx);
      if (!requestId.ok) return requestId;

      let locator: StreamLocatorPayload | undefined;
      if (
        'locator' in obj &&
        obj['locator'] !== undefined &&
        obj['locator'] !== null
      ) {
        const rawLocator = obj['locator'];
        if (!isPlainObject(rawLocator)) {
          return err(`${ctx}.locator: expected optional plain object`);
        }
        const parsedLocator = parseStreamLocatorPayloadObject(
          rawLocator,
          `${ctx}.locator`,
          true,
        );
        if (!parsedLocator.ok) return parsedLocator;
        locator = parsedLocator.value;
      }

      const error = readOptionalString(obj, 'error', ctx, true);
      if (!error.ok) return error;

      return ok({
        type: 'refresh_locator_response',
        requestId: requestId.value,
        ...(locator !== undefined ? { locator } : {}),
        ...(error.value !== undefined ? { error: error.value } : {}),
      });
    }

    case 'ping': {
      const ctx = 'ClientWsCommand(ping)';
      const clientTimestampMs = readNonNegativeNumber(
        obj,
        'clientTimestampMs',
        ctx,
      );
      if (!clientTimestampMs.ok) return clientTimestampMs;
      return ok({
        type: 'ping',
        clientTimestampMs: clientTimestampMs.value,
      });
    }

    default:
      return err(`ClientWsCommand.type: unknown command "${typeRes.value}"`);
  }
}
