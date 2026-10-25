/**
 * `ISOLATED` world content script entrypoint (`run_at: "document_start"` on `https://soundcloud.com/*`).
 *
 * Bridges the nonce-verified `MAIN` world channel to the MV3 Service Worker over a
 * resilient `chrome.runtime.Port` + `sendMessage` fallback and mounts `ShadowDomCastPill`.
 */

import {
  isRecord,
  type ExtensionRuntimeRequest,
  type ExtensionRuntimeResponse,
  type ExtensionUiSnapshot,
  type ServiceWorkerBroadcastMessage,
} from '../shared/messages.js';
import { ShadowDomCastPill } from './castPill.js';
import { createIsolatedWorldNonceBridge } from './nonceBridge.js';

function isExtensionRuntimeResponse(
  value: unknown,
): value is ExtensionRuntimeResponse {
  return isRecord(value) && typeof value['ok'] === 'boolean';
}

function isServiceWorkerBroadcast(
  value: unknown,
): value is ServiceWorkerBroadcastMessage {
  return (
    isRecord(value) &&
    (value['type'] === 'ui_snapshot_updated' || value['type'] === 'forward_to_main')
  );
}

function bootstrapIsolatedWorld(): void {
  let activePort: chrome.runtime.Port | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const sendRuntimeRequest = async (
    request: ExtensionRuntimeRequest,
  ): Promise<ExtensionRuntimeResponse | undefined> => {
    try {
      const raw = await chrome.runtime.sendMessage(request);
      return isExtensionRuntimeResponse(raw) ? raw : undefined;
    } catch {
      return undefined;
    }
  };

  let castPill: ShadowDomCastPill | null = null;

  const applySnapshot = (snapshot: ExtensionUiSnapshot): void => {
    castPill?.update(snapshot);
    mainBridge.send({
      type: 'sync_runtime_state',
      handoffEnabled: snapshot.handoffEnabled,
      seekDebounceMs: snapshot.seekDebounceMs,
      connectionState: snapshot.connectionState,
      activeOutput: snapshot.activeOutput ?? undefined,
      telemetry: snapshot.telemetry ?? undefined,
      lastAckedCommandSeq: snapshot.lastAckedCommandSeq,
    });
  };

  const mainBridge = createIsolatedWorldNonceBridge((mainMsg) => {
    void (async () => {
      if (activePort !== null) {
        try {
          activePort.postMessage({
            type: 'forward_main_message',
            message: mainMsg,
          } satisfies ExtensionRuntimeRequest);
          return;
        } catch {
          activePort = null;
        }
      }
      const res = await sendRuntimeRequest({
        type: 'forward_main_message',
        message: mainMsg,
      });
      if (res?.ok === true) {
        applySnapshot(res.snapshot);
      }
    })();
  });

  const handleBroadcast = (msg: ServiceWorkerBroadcastMessage): void => {
    if (msg.type === 'ui_snapshot_updated') {
      applySnapshot(msg.snapshot);
    } else if (msg.type === 'forward_to_main') {
      mainBridge.send(msg.message);
    }
  };

  const connectPort = (): void => {
    if (activePort !== null) {
      return;
    }
    try {
      const port = chrome.runtime.connect({ name: 'soundclud-tab' });
      activePort = port;
      port.onMessage.addListener((rawMsg) => {
        if (isServiceWorkerBroadcast(rawMsg)) {
          handleBroadcast(rawMsg);
        }
      });
      port.onDisconnect.addListener(() => {
        activePort = null;
        if (reconnectTimer === null) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connectPort();
          }, 1500);
        }
      });
    } catch {
      activePort = null;
    }
  };

  chrome.runtime.onMessage.addListener((rawMsg) => {
    if (isServiceWorkerBroadcast(rawMsg)) {
      handleBroadcast(rawMsg);
    }
  });

  castPill = new ShadowDomCastPill({
    onToggleHandoff: (nextEnabled) => {
      void (async () => {
        const res = await sendRuntimeRequest({
          type: 'set_handoff_enabled',
          enabled: nextEnabled,
        });
        if (res?.ok === true) {
          applySnapshot(res.snapshot);
        }
      })();
    },
    onSelectOutput: (entry) => {
      void (async () => {
        const res = await sendRuntimeRequest({
          type: 'select_output',
          endpointBaseUrl: entry.endpointBaseUrl,
          receiverId: entry.receiverId,
          outputId: entry.output.id,
        });
        if (res?.ok === true) {
          applySnapshot(res.snapshot);
        }
      })();
    },
    onRefreshOutputs: () => {
      void (async () => {
        const res = await sendRuntimeRequest({
          type: 'discover_outputs',
          force: true,
        });
        if (res?.ok === true) {
          applySnapshot(res.snapshot);
        }
      })();
    },
  });

  const mountPillWhenReady = (): void => {
    if (document.body !== null) {
      castPill?.mount();
    } else {
      window.addEventListener(
        'DOMContentLoaded',
        () => {
          castPill?.mount();
        },
        { once: true },
      );
    }
  };

  connectPort();
  mountPillWhenReady();

  void (async () => {
    const initial = await sendRuntimeRequest({ type: 'get_ui_snapshot' });
    if (initial?.ok === true) {
      applySnapshot(initial.snapshot);
    }
    const discovered = await sendRuntimeRequest({ type: 'discover_outputs' });
    if (discovered?.ok === true) {
      applySnapshot(discovered.snapshot);
    }
  })();
}

if (typeof window !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime !== undefined) {
  bootstrapIsolatedWorld();
}
