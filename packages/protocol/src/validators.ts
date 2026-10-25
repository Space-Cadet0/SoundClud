/**
 * Public runtime validators, parsers, and TypeScript type guards (`v1`).
 */

export {
  err,
  ok,
  type ParseResult,
  type Result,
} from './validationPrimitives.js';

export {
  isValidOutputDevice,
  parseOutputDevice,
} from './outputValidators.js';

export {
  isValidStreamLocatorPayload,
  parseStreamLocatorPayload,
} from './locatorValidators.js';

export {
  parsePlaybackTelemetry,
  parseReceiverConfig,
} from './telemetryValidators.js';

export {
  parseApiErrorResponse,
  parseAudioDevicesResponse,
  parseDiscoverResponse,
  parsePairRequest,
  parsePairResponse,
  parseStatusResponse,
  parseUpdateConfigRequest,
  parseUpdateConfigResponse,
} from './restValidators.js';

export { parseClientWsCommand } from './wsCommandValidators.js';
export { parseServerWsEvent } from './wsEventValidators.js';
