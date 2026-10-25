/**
 * Runtime parser for WebSocket `/api/v1/ws` server-to-client events (`v1`).
 */

import { PROTOCOL_VERSION } from './constants.js';
import { parseOutputDeviceObject } from './outputValidators.js';
import {
  parsePlaybackTelemetryObject,
  parseReceiverConfigObject,
} from './telemetryValidators.js';
import {
  err,
  isPlainObject,
  ok,
  readArray,
  readEnum,
  readLiteral,
  readNonEmptyString,
  readNonNegativeInt,
  readNonNegativeNumber,
  readOptionalNonEmptyString,
  readOptionalNonNegativeInt,
  readString,
  unwrapJsonObject,
  type Result,
} from './validationPrimitives.js';
import { REFRESH_LOCATOR_REASONS, type ServerWsEvent } from './ws.js';

export function parseServerWsEvent(input: unknown): Result<ServerWsEvent> {
  const unwrapped = unwrapJsonObject(input, 'ServerWsEvent');
  if (!unwrapped.ok) return unwrapped;
  const obj = unwrapped.value;
  const typeRes = readNonEmptyString(obj, 'type', 'ServerWsEvent');
  if (!typeRes.ok) return typeRes;

  switch (typeRes.value) {
    case 'welcome': {
      const ctx = 'ServerWsEvent(welcome)';
      const pv = readLiteral(obj, 'protocolVersion', PROTOCOL_VERSION, ctx);
      if (!pv.ok) return pv;
      const receiverId = readNonEmptyString(obj, 'receiverId', ctx);
      if (!receiverId.ok) return receiverId;
      const receiverName = readNonEmptyString(obj, 'receiverName', ctx);
      if (!receiverName.ok) return receiverName;
      const controllerId = readNonEmptyString(obj, 'controllerId', ctx);
      if (!controllerId.ok) return controllerId;

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

      const outputs = readArray(obj, 'outputs', ctx, (item, itemCtx) => {
        if (!isPlainObject(item)) return err(`${itemCtx}: expected plain object`);
        return parseOutputDeviceObject(item, itemCtx, true);
      });
      if (!outputs.ok) return outputs;

      return ok({
        type: 'welcome',
        protocolVersion: pv.value,
        receiverId: receiverId.value,
        receiverName: receiverName.value,
        controllerId: controllerId.value,
        config: config.value,
        telemetry: telemetry.value,
        outputs: outputs.value,
      });
    }

    case 'state_tick': {
      const ctx = 'ServerWsEvent(state_tick)';
      const lastAckedCommandSeq = readNonNegativeInt(
        obj,
        'lastAckedCommandSeq',
        ctx,
      );
      if (!lastAckedCommandSeq.ok) return lastAckedCommandSeq;
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
      return ok({
        type: 'state_tick',
        lastAckedCommandSeq: lastAckedCommandSeq.value,
        telemetry: telemetry.value,
      });
    }

    case 'outputs_updated': {
      const ctx = 'ServerWsEvent(outputs_updated)';
      const activeOutputId = readOptionalNonEmptyString(
        obj,
        'activeOutputId',
        ctx,
        true,
      );
      if (!activeOutputId.ok) return activeOutputId;
      const outputs = readArray(obj, 'outputs', ctx, (item, itemCtx) => {
        if (!isPlainObject(item)) return err(`${itemCtx}: expected plain object`);
        return parseOutputDeviceObject(item, itemCtx, true);
      });
      if (!outputs.ok) return outputs;
      return ok({
        type: 'outputs_updated',
        ...(activeOutputId.value !== undefined
          ? { activeOutputId: activeOutputId.value }
          : {}),
        outputs: outputs.value,
      });
    }

    case 'track_ended': {
      const ctx = 'ServerWsEvent(track_ended)';
      const trackId = readNonEmptyString(obj, 'trackId', ctx);
      if (!trackId.ok) return trackId;
      const locatorId = readNonEmptyString(obj, 'locatorId', ctx);
      if (!locatorId.ok) return locatorId;
      return ok({
        type: 'track_ended',
        trackId: trackId.value,
        locatorId: locatorId.value,
      });
    }

    case 'refresh_locator_request': {
      const ctx = 'ServerWsEvent(refresh_locator_request)';
      const requestId = readNonEmptyString(obj, 'requestId', ctx);
      if (!requestId.ok) return requestId;
      const trackId = readNonEmptyString(obj, 'trackId', ctx);
      if (!trackId.ok) return trackId;
      const locatorId = readNonEmptyString(obj, 'locatorId', ctx);
      if (!locatorId.ok) return locatorId;
      const reason = readEnum(obj, 'reason', REFRESH_LOCATOR_REASONS, ctx);
      if (!reason.ok) return reason;
      return ok({
        type: 'refresh_locator_request',
        requestId: requestId.value,
        trackId: trackId.value,
        locatorId: locatorId.value,
        reason: reason.value,
      });
    }

    case 'session_claimed': {
      const ctx = 'ServerWsEvent(session_claimed)';
      const newControllerId = readNonEmptyString(obj, 'newControllerId', ctx);
      if (!newControllerId.ok) return newControllerId;
      const newClientLabel = readNonEmptyString(obj, 'newClientLabel', ctx);
      if (!newClientLabel.ok) return newClientLabel;
      return ok({
        type: 'session_claimed',
        newControllerId: newControllerId.value,
        newClientLabel: newClientLabel.value,
      });
    }

    case 'error': {
      const ctx = 'ServerWsEvent(error)';
      const code = readNonEmptyString(obj, 'code', ctx);
      if (!code.ok) return code;
      const message = readString(obj, 'message', ctx);
      if (!message.ok) return message;
      const commandSeq = readOptionalNonNegativeInt(
        obj,
        'commandSeq',
        ctx,
        true,
      );
      if (!commandSeq.ok) return commandSeq;
      return ok({
        type: 'error',
        code: code.value,
        message: message.value,
        ...(commandSeq.value !== undefined
          ? { commandSeq: commandSeq.value }
          : {}),
      });
    }

    case 'pong': {
      const ctx = 'ServerWsEvent(pong)';
      const clientTimestampMs = readNonNegativeNumber(
        obj,
        'clientTimestampMs',
        ctx,
      );
      if (!clientTimestampMs.ok) return clientTimestampMs;
      const serverTimestampMs = readNonNegativeNumber(
        obj,
        'serverTimestampMs',
        ctx,
      );
      if (!serverTimestampMs.ok) return serverTimestampMs;
      return ok({
        type: 'pong',
        clientTimestampMs: clientTimestampMs.value,
        serverTimestampMs: serverTimestampMs.value,
      });
    }

    default:
      return err(`ServerWsEvent.type: unknown event "${typeRes.value}"`);
  }
}
