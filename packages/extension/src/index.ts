/**
 * `@soundclud/extension` — Public barrel exporting pure/testable modules,
 * controllers, schemas, and helpers for the Chromium Manifest V3 extension.
 */

export const EXTENSION_SCHEMA_VERSION = 1 as const;

export * from './shared/messages.js';
export * from './shared/storageSchema.js';
export * from './shared/statusText.js';

export * from './main-world/sessionObserver.js';
export * from './main-world/trackCatalog.js';
export * from './main-world/seekDebouncer.js';
export * from './main-world/mediaKeyKeepalive.js';
export * from './main-world/mseVirtualizer.js';
export * from './main-world/playerVirtualizer.js';
export * from './main-world/mediaPrototypeHooks.js';

export * from './isolated-world/nonceBridge.js';
export * from './isolated-world/castPill.js';

export * from './background/discovery.js';
export * from './background/wsController.js';
export * from './background/serviceWorker.js';

export { installDialogLightDismissFallback } from './popup/popup.js';
