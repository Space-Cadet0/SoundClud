/**
 * Encapsulated Shadow DOM Cast Pill & quick 1-click Output Selector (`ISOLATED` world).
 *
 * Mounts inside SoundCloud's bottom `.playControls` bar (with clean fixed bottom-right
 * fallback before the player bar renders), batches DOM updates with `requestAnimationFrame`,
 * and isolates styles completely via Shadow DOM + `adoptedStyleSheets`.
 */

import type { DiscoveredOutputEntry, ExtensionUiSnapshot } from '../shared/messages.js';
import {
  formatOutputKindBadge,
  formatUiStatus,
} from '../shared/statusText.js';

export interface CastPillCallbacks {
  readonly onToggleHandoff: (nextEnabled: boolean) => void;
  readonly onSelectOutput: (entry: DiscoveredOutputEntry) => void;
  readonly onRefreshOutputs: () => void;
}

const CAST_PILL_STYLES = `
:host {
  --sc-bg-light: #ffffff;
  --sc-bg-dark: #16181d;
  --sc-text-light: #15171c;
  --sc-text-dark: #f3f4f6;
  --sc-muted-light: #596070;
  --sc-muted-dark: #9ca3af;
  --sc-border-light: rgba(17, 24, 39, 0.14);
  --sc-border-dark: rgba(255, 255, 255, 0.14);
  --sc-accent-light: #d94e0f;
  --sc-accent-dark: #ff6b2b;
  --sc-ok-light: #0d8a52;
  --sc-ok-dark: #34d399;
  --sc-warn-light: #b45309;
  --sc-warn-dark: #fbbf24;

  --sc-bg: var(--sc-bg-light);
  --sc-text: var(--sc-text-light);
  --sc-muted: var(--sc-muted-light);
  --sc-border: var(--sc-border-light);
  --sc-accent: var(--sc-accent-light);
  --sc-ok: var(--sc-ok-light);
  --sc-warn: var(--sc-warn-light);

  color-scheme: light dark;
  display: inline-flex;
  align-items: center;
  position: relative;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  font-size: 12px;
  line-height: 1.2;
  z-index: 9999;
  margin-inline: 8px;
}

@media (prefers-color-scheme: dark) {
  :host {
    --sc-bg: var(--sc-bg-dark);
    --sc-text: var(--sc-text-dark);
    --sc-muted: var(--sc-muted-dark);
    --sc-border: var(--sc-border-dark);
    --sc-accent: var(--sc-accent-dark);
    --sc-ok: var(--sc-ok-dark);
    --sc-warn: var(--sc-warn-dark);
  }
}

@supports (color: light-dark(white, black)) {
  :host {
    --sc-bg: light-dark(var(--sc-bg-light), var(--sc-bg-dark));
    --sc-text: light-dark(var(--sc-text-light), var(--sc-text-dark));
    --sc-muted: light-dark(var(--sc-muted-light), var(--sc-muted-dark));
    --sc-border: light-dark(var(--sc-border-light), var(--sc-border-dark));
    --sc-accent: light-dark(var(--sc-accent-light), var(--sc-accent-dark));
    --sc-ok: light-dark(var(--sc-ok-light), var(--sc-ok-dark));
    --sc-warn: light-dark(var(--sc-warn-light), var(--sc-warn-dark));
  }
}

:host([data-docked="floating"]) {
  position: fixed;
  right: 16px;
  bottom: 58px;
  margin-inline: 0;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.28);
  border-radius: 999px;
}

.pill-shell {
  display: inline-flex;
  align-items: center;
  background: var(--sc-bg);
  color: var(--sc-text);
  border: 1px solid var(--sc-border);
  border-radius: 999px;
  height: 28px;
  overflow: hidden;
}

button {
  appearance: none;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 100%;
  padding: 0 10px;
}

button:focus-visible {
  outline: 2px solid var(--sc-accent);
  outline-offset: -2px;
}

.pill-menu-btn {
  padding: 0 8px;
  border-left: 1px solid var(--sc-border);
}

.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--sc-muted);
  flex-shrink: 0;
}

.pill-shell[data-tone="active"] .dot {
  background: var(--sc-ok);
}

.pill-shell[data-tone="waking"] .dot,
.pill-shell[data-tone="drm"] .dot,
.pill-shell[data-tone="warning"] .dot {
  background: var(--sc-warn);
}

.pill-shell[data-tone="error"] .dot {
  background: var(--sc-accent);
}

.pill-label {
  max-width: 220px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.menu {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  width: 280px;
  background: var(--sc-bg);
  color: var(--sc-text);
  border: 1px solid var(--sc-border);
  border-radius: 12px;
  padding: 8px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.35);
}

.menu[hidden] {
  display: none;
}

.menu-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 6px 6px;
  font-size: 11px;
  color: var(--sc-muted);
  border-bottom: 1px solid var(--sc-border);
}

.menu-refresh {
  height: 22px;
  padding: 0 6px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--sc-accent);
}

.output-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  max-height: 200px;
  overflow-y: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--sc-muted) transparent;
}

.output-item-btn {
  width: 100%;
  height: auto;
  justify-content: space-between;
  text-align: left;
  padding: 7px 8px;
  border-radius: 8px;
}

.output-item-btn[aria-current="true"] {
  background: rgba(255, 107, 43, 0.14);
}

.output-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.output-title {
  font-weight: 600;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.output-sub {
  font-size: 10px;
  color: var(--sc-muted);
}

.empty-note {
  padding: 10px 6px;
  font-size: 11px;
  color: var(--sc-muted);
  text-align: center;
}
`;

let sharedSheet: CSSStyleSheet | null = null;
function getConstructedSheet(): CSSStyleSheet | null {
  if (sharedSheet !== null) {
    return sharedSheet;
  }
  if (
    typeof CSSStyleSheet !== 'undefined' &&
    typeof CSSStyleSheet.prototype.replaceSync === 'function'
  ) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CAST_PILL_STYLES);
    sharedSheet = sheet;
    return sheet;
  }
  return null;
}

let pillTemplate: HTMLTemplateElement | null = null;
function getPillTemplate(): HTMLTemplateElement {
  if (pillTemplate !== null) {
    return pillTemplate;
  }
  const tpl = document.createElement('template');
  tpl.innerHTML = `
    <div class="pill-shell" data-tone="idle">
      <button type="button" class="pill-toggle" aria-pressed="false" aria-label="Toggle SoundClud bit-perfect Hi-Fi handoff">
        <span class="dot" aria-hidden="true"></span>
        <span class="pill-label">SoundClud • Local</span>
      </button>
      <button type="button" class="pill-menu-btn" aria-expanded="false" aria-label="Select Hi-Fi output target">
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>
    <div class="menu" hidden role="region" aria-label="SoundClud Hi-Fi Outputs">
      <div class="menu-header">
        <span>0 dB Bit-Perfect Outputs</span>
        <button type="button" class="menu-refresh">Refresh</button>
      </div>
      <ul class="output-list"></ul>
    </div>
  `;
  pillTemplate = tpl;
  return tpl;
}

export class ShadowDomCastPill {
  private readonly callbacks: CastPillCallbacks;
  private hostEl: HTMLElement | null = null;
  private shadow: ShadowRoot | null = null;
  private latestSnapshot: ExtensionUiSnapshot | null = null;
  private menuOpen = false;
  private rafScheduled = false;
  private mutationObserver: MutationObserver | null = null;

  public constructor(callbacks: CastPillCallbacks) {
    this.callbacks = callbacks;
  }

  public mount(): void {
    if (this.hostEl !== null) {
      return;
    }

    const host = document.createElement('div');
    host.setAttribute('data-soundclud-cast-pill', 'true');
    const shadow = host.attachShadow({ mode: 'open', delegatesFocus: true });

    const sheet = getConstructedSheet();
    if (sheet !== null && 'adoptedStyleSheets' in shadow) {
      shadow.adoptedStyleSheets = [sheet];
    } else {
      const styleEl = document.createElement('style');
      styleEl.textContent = CAST_PILL_STYLES;
      shadow.append(styleEl);
    }

    shadow.append(getPillTemplate().content.cloneNode(true));
    this.hostEl = host;
    this.shadow = shadow;

    const toggleBtn = shadow.querySelector<HTMLButtonElement>('.pill-toggle');
    const menuBtn = shadow.querySelector<HTMLButtonElement>('.pill-menu-btn');
    const refreshBtn = shadow.querySelector<HTMLButtonElement>('.menu-refresh');

    toggleBtn?.addEventListener('click', () => {
      const current = this.latestSnapshot?.handoffEnabled ?? false;
      this.callbacks.onToggleHandoff(!current);
    });

    menuBtn?.addEventListener('click', (event) => {
      event.stopPropagation();
      this.menuOpen = !this.menuOpen;
      if (this.menuOpen) {
        this.callbacks.onRefreshOutputs();
      }
      this.scheduleRender();
    });

    refreshBtn?.addEventListener('click', () => {
      this.callbacks.onRefreshOutputs();
    });

    document.addEventListener('click', (event) => {
      if (this.menuOpen && this.hostEl !== null && !event.composedPath().includes(this.hostEl)) {
        this.menuOpen = false;
        this.scheduleRender();
      }
    });

    this.attachToBestContainer();
    if (typeof MutationObserver !== 'undefined') {
      this.mutationObserver = new MutationObserver(() => {
        if (
          this.hostEl !== null &&
          (!this.hostEl.isConnected ||
            this.hostEl.getAttribute('data-docked') === 'floating')
        ) {
          this.attachToBestContainer();
        }
      });
      if (document.documentElement !== null) {
        this.mutationObserver.observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
      }
    }
  }

  public update(snapshot: ExtensionUiSnapshot): void {
    this.latestSnapshot = snapshot;
    this.scheduleRender();
  }

  public dispose(): void {
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.hostEl?.remove();
    this.hostEl = null;
    this.shadow = null;
  }

  private attachToBestContainer(): void {
    if (this.hostEl === null) {
      return;
    }
    const playerElements = document.querySelector<HTMLElement>(
      '.playControls__elements, .playControls__inner, .playControls',
    );
    if (playerElements !== null) {
      if (this.hostEl.parentElement !== playerElements) {
        this.hostEl.setAttribute('data-docked', 'playerbar');
        playerElements.append(this.hostEl);
      }
      return;
    }
    if (document.body !== null && !this.hostEl.isConnected) {
      this.hostEl.setAttribute('data-docked', 'floating');
      document.body.append(this.hostEl);
    }
  }

  private scheduleRender(): void {
    if (this.rafScheduled) {
      return;
    }
    this.rafScheduled = true;
    const run = (): void => {
      this.rafScheduled = false;
      this.renderNow();
    };
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(run);
    } else {
      run();
    }
  }

  private renderNow(): void {
    if (this.shadow === null || this.latestSnapshot === null) {
      return;
    }
    const snapshot = this.latestSnapshot;
    const status = formatUiStatus(snapshot);

    const shell = this.shadow.querySelector<HTMLElement>('.pill-shell');
    const toggleBtn = this.shadow.querySelector<HTMLButtonElement>('.pill-toggle');
    const labelEl = this.shadow.querySelector<HTMLElement>('.pill-label');
    const menuBtn = this.shadow.querySelector<HTMLButtonElement>('.pill-menu-btn');
    const menuEl = this.shadow.querySelector<HTMLElement>('.menu');
    const listEl = this.shadow.querySelector<HTMLUListElement>('.output-list');

    if (shell !== null) {
      shell.setAttribute('data-tone', status.tone);
    }
    if (toggleBtn !== null) {
      toggleBtn.setAttribute('aria-pressed', String(snapshot.handoffEnabled));
    }
    if (labelEl !== null) {
      labelEl.textContent = status.pillLabel;
    }
    if (menuBtn !== null) {
      menuBtn.setAttribute('aria-expanded', String(this.menuOpen));
    }
    if (menuEl !== null) {
      menuEl.hidden = !this.menuOpen;
    }

    if (listEl !== null && this.menuOpen) {
      listEl.replaceChildren();
      if (snapshot.outputs.length === 0) {
        const emptyLi = document.createElement('li');
        emptyLi.className = 'empty-note';
        emptyLi.textContent =
          'No receivers detected yet. Start soundclud-receiver or open the extension popup to add a LAN host.';
        listEl.append(emptyLi);
        return;
      }

      for (const entry of snapshot.outputs) {
        const li = document.createElement('li');
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'output-item-btn';
        const isCurrent =
          snapshot.handoffEnabled &&
          snapshot.activeOutputId === entry.output.id &&
          (snapshot.activeReceiverId === null ||
            snapshot.activeReceiverId === entry.receiverId);
        if (isCurrent) {
          btn.setAttribute('aria-current', 'true');
        }

        const meta = document.createElement('span');
        meta.className = 'output-meta';

        const title = document.createElement('span');
        title.className = 'output-title';
        title.textContent = entry.output.name;

        const sub = document.createElement('span');
        sub.className = 'output-sub';
        const standbyNote =
          entry.output.standbyState === 'off' ? ' • Standby (Auto-Wake)' : '';
        sub.textContent = `${formatOutputKindBadge(entry.output)} • ${entry.receiverName}${standbyNote}`;

        meta.append(title, sub);
        btn.append(meta);
        btn.addEventListener('click', () => {
          this.menuOpen = false;
          this.callbacks.onSelectOutput(entry);
          this.scheduleRender();
        });
        li.append(btn);
        listEl.append(li);
      }
    }
  }
}
