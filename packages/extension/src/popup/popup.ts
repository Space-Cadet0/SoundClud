/**
 * SoundClud Extension Popup Controller (`popup.js`).
 *
 * Drives the Unified Multi-Output Picker (`CoreAudio/TOSLINK` + `HEOS Direct`),
 * live `0 dB` signal-chain badge, and `<dialog closedby="any">` LAN receiver
 * configuration modal with Chrome 116–133 light-dismiss fallback.
 */

import {
  isRecord,
  type DiscoveredOutputEntry,
  type ExtensionRuntimeRequest,
  type ExtensionRuntimeResponse,
  type ExtensionUiSnapshot,
  type ServiceWorkerBroadcastMessage,
} from '../shared/messages.js';
import {
  formatOutputKindBadge,
  formatUiStatus,
} from '../shared/statusText.js';

/**
 * Mandatory fallback for Chromium 116–133 where `HTMLDialogElement.prototype.closedBy`
 * is not yet available (shipped in Chrome 134).
 */
export function installDialogLightDismissFallback(dialog: HTMLDialogElement): void {
  if (!('closedBy' in HTMLDialogElement.prototype)) {
    dialog.addEventListener('click', (event: MouseEvent) => {
      if (event.target !== dialog) {
        return;
      }
      const rect = dialog.getBoundingClientRect();
      const isDialogContent =
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;

      if (isDialogContent) {
        return;
      }
      dialog.close();
    });
  }
}

function isRuntimeResponse(value: unknown): value is ExtensionRuntimeResponse {
  return isRecord(value) && typeof value['ok'] === 'boolean';
}

function isBroadcastMessage(
  value: unknown,
): value is ServiceWorkerBroadcastMessage {
  return (
    isRecord(value) &&
    (value['type'] === 'ui_snapshot_updated' || value['type'] === 'forward_to_main')
  );
}

async function sendRequest(
  request: ExtensionRuntimeRequest,
): Promise<ExtensionRuntimeResponse> {
  const raw = await chrome.runtime.sendMessage(request);
  if (isRuntimeResponse(raw)) {
    return raw;
  }
  return { ok: false, error: 'No response from SoundClud background worker' };
}

function bootstrapPopup(): void {
  const handoffBtn = document.getElementById(
    'handoff-toggle',
  ) as HTMLButtonElement | null;
  const handoffText = document.getElementById('handoff-toggle-text');
  const signalCard = document.getElementById('signal-card');
  const signalHeading = document.getElementById('signal-heading');
  const signalDetail = document.getElementById('signal-detail');
  const nowPlayingEl = document.getElementById('now-playing');
  const errorBanner = document.getElementById('error-banner');
  const outputsList = document.getElementById(
    'outputs-list',
  ) as HTMLUListElement | null;
  const refreshBtn = document.getElementById(
    'refresh-outputs-btn',
  ) as HTMLButtonElement | null;
  const openDialogBtn = document.getElementById(
    'open-endpoint-dialog-btn',
  ) as HTMLButtonElement | null;
  const endpointDialog = document.getElementById(
    'endpoint-dialog',
  ) as HTMLDialogElement | null;
  const endpointForm = document.getElementById(
    'endpoint-form',
  ) as HTMLFormElement | null;
  const endpointInput = document.getElementById(
    'endpoint-input',
  ) as HTMLInputElement | null;
  const dialogError = document.getElementById('dialog-error');

  let currentSnapshot: ExtensionUiSnapshot | null = null;

  if (endpointDialog !== null) {
    installDialogLightDismissFallback(endpointDialog);
  }

  const showError = (msg: string | null): void => {
    if (errorBanner === null) {
      return;
    }
    if (msg === null || msg.length === 0) {
      errorBanner.hidden = true;
      errorBanner.textContent = '';
    } else {
      errorBanner.hidden = false;
      errorBanner.textContent = msg;
    }
  };

  const renderOutputItem = (
    entry: DiscoveredOutputEntry,
    snapshot: ExtensionUiSnapshot,
  ): HTMLLIElement => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'output-btn';

    const isSelected =
      snapshot.handoffEnabled &&
      snapshot.activeOutputId === entry.output.id &&
      (snapshot.activeReceiverId === null ||
        snapshot.activeReceiverId === entry.receiverId);

    if (isSelected) {
      btn.setAttribute('aria-current', 'true');
    }

    const info = document.createElement('span');
    info.className = 'output-info';

    const name = document.createElement('span');
    name.className = 'output-name';
    name.textContent = entry.output.name;

    const sub = document.createElement('span');
    sub.className = 'output-sub';
    const hostBadge = entry.isLoopback ? 'Local 127.0.0.1' : entry.receiverName;
    const standbySuffix =
      entry.output.standbyState === 'off' ? ' • Standby (Auto-Wake)' : '';
    sub.textContent = `${formatOutputKindBadge(entry.output)} • ${hostBadge}${standbySuffix}`;

    info.append(name, sub);

    const pill = document.createElement('span');
    pill.className = 'output-pill';
    pill.textContent = isSelected ? '0 dB Active' : '0 dB Ready';

    btn.append(info, pill);
    btn.addEventListener('click', () => {
      void (async () => {
        showError(null);
        const res = await sendRequest({
          type: 'select_output',
          endpointBaseUrl: entry.endpointBaseUrl,
          receiverId: entry.receiverId,
          outputId: entry.output.id,
        });
        if (res.ok) {
          renderSnapshot(res.snapshot);
        } else {
          showError(res.error);
        }
      })();
    });

    li.append(btn);
    return li;
  };

  const renderSnapshot = (snapshot: ExtensionUiSnapshot): void => {
    currentSnapshot = snapshot;
    const status = formatUiStatus(snapshot);

    if (handoffBtn !== null) {
      handoffBtn.setAttribute('aria-checked', String(snapshot.handoffEnabled));
    }
    if (handoffText !== null) {
      handoffText.textContent = snapshot.handoffEnabled ? 'On' : 'Off';
    }
    if (signalCard !== null) {
      signalCard.setAttribute('data-tone', status.tone);
    }
    if (signalHeading !== null) {
      signalHeading.textContent = status.signalHeadline;
    }
    if (signalDetail !== null) {
      signalDetail.textContent = status.signalDetail;
    }

    if (nowPlayingEl !== null) {
      const track = snapshot.telemetry?.track;
      if (snapshot.handoffEnabled && track !== undefined) {
        nowPlayingEl.hidden = false;
        nowPlayingEl.textContent = `${track.artist} — ${track.title}`;
      } else {
        nowPlayingEl.hidden = true;
        nowPlayingEl.textContent = '';
      }
    }

    if (outputsList !== null) {
      outputsList.replaceChildren();
      if (snapshot.outputs.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'empty-state';
        empty.textContent =
          'No TOSLINK or HEOS outputs detected yet. Ensure soundclud-receiver is running locally or click "+ Add LAN Receiver".';
        outputsList.append(empty);
      } else {
        for (const entry of snapshot.outputs) {
          outputsList.append(renderOutputItem(entry, snapshot));
        }
      }
    }
  };

  handoffBtn?.addEventListener('click', () => {
    const nextEnabled = !(currentSnapshot?.handoffEnabled ?? false);
    void (async () => {
      showError(null);
      const res = await sendRequest({
        type: 'set_handoff_enabled',
        enabled: nextEnabled,
      });
      if (res.ok) {
        renderSnapshot(res.snapshot);
      } else {
        showError(res.error);
      }
    })();
  });

  refreshBtn?.addEventListener('click', () => {
    void (async () => {
      showError(null);
      const res = await sendRequest({ type: 'discover_outputs', force: true });
      if (res.ok) {
        renderSnapshot(res.snapshot);
      } else {
        showError(res.error);
      }
    })();
  });

  openDialogBtn?.addEventListener('click', () => {
    if (endpointDialog === null) {
      return;
    }
    if (dialogError !== null) {
      dialogError.hidden = true;
      dialogError.textContent = '';
    }
    if (endpointInput !== null) {
      endpointInput.value = '';
    }
    endpointDialog.showModal();
  });

  endpointForm?.addEventListener('submit', (event) => {
    const submitter = (event as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.value === 'cancel') {
      return;
    }
    event.preventDefault();
    const rawValue = endpointInput?.value.trim() ?? '';
    if (rawValue.length === 0) {
      if (dialogError !== null) {
        dialogError.hidden = false;
        dialogError.textContent = 'Enter a hostname such as soundclud.local:9876.';
      }
      return;
    }

    void (async () => {
      const res = await sendRequest({
        type: 'add_manual_endpoint',
        rawEndpoint: rawValue,
      });
      if (res.ok) {
        endpointDialog?.close('confirm');
        renderSnapshot(res.snapshot);
      } else if (dialogError !== null) {
        dialogError.hidden = false;
        dialogError.textContent = res.error;
      }
    })();
  });

  try {
    const port = chrome.runtime.connect({ name: 'soundclud-popup' });
    port.onMessage.addListener((rawMsg) => {
      if (isBroadcastMessage(rawMsg) && rawMsg.type === 'ui_snapshot_updated') {
        renderSnapshot(rawMsg.snapshot);
      }
    });
  } catch {
    // Fallback to sendMessage polling if port unavailable.
  }

  void (async () => {
    const initial = await sendRequest({ type: 'get_ui_snapshot' });
    if (initial.ok) {
      renderSnapshot(initial.snapshot);
    }
    const refreshed = await sendRequest({ type: 'discover_outputs' });
    if (refreshed.ok) {
      renderSnapshot(refreshed.snapshot);
    }
  })();
}

if (typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime !== undefined) {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrapPopup, { once: true });
  } else {
    bootstrapPopup();
  }
}
