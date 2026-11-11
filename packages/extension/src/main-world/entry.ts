/**
 * `MAIN` world content script entrypoint (`run_at: "document_start"` on `https://soundcloud.com/*`).
 *
 * Bootstraps passive Go+ HQ session observation, track catalog indexing,
 * Maestro `HTMLAudioElement`/`SourceBuffer` virtualization, `-100 dBFS` hardware
 * media-key keepalive, and the 128-bit nonce-verified bridge to `ISOLATED` world.
 */

import { attachMainWorldNonceBridge } from '../isolated-world/nonceBridge.js';
import type { MainToIsolatedMessage } from '../shared/messages.js';
import { MediaKeyKeepaliveController } from './mediaKeyKeepalive.js';
import {
  installMediaPrototypeHooks,
  installNetworkPassiveObservers,
} from './mediaPrototypeHooks.js';
import {
  MaestroVirtualizerController,
  type DomTrackHint,
} from './playerVirtualizer.js';
import { SoundCloudSessionObserver } from './sessionObserver.js';
import { SoundCloudTrackCatalog } from './trackCatalog.js';

function getSafeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * `ConnectedDomCache` — High-performance cached DOM lookup registry.
 * Validates `.isConnected` on each access to provide O(1) lookups during steady-state
 * playback while automatically invalidating and querying fresh elements if the host
 * SPA unmounts, re-renders, or replaces elements in the DOM tree.
 */
export class ConnectedDomCache {
  private readonly elements = new Map<string, Element>();
  private readonly doc: Pick<Document, 'querySelector' | 'querySelectorAll'> | undefined;

  public constructor(doc?: Pick<Document, 'querySelector' | 'querySelectorAll'>) {
    this.doc = doc;
  }

  private getDocument(): Pick<Document, 'querySelector' | 'querySelectorAll'> | undefined {
    return this.doc ?? (typeof document !== 'undefined' ? document : undefined);
  }

  public query<T extends Element>(selector: string): T | null {
    const doc = this.getDocument();
    if (doc === undefined) {
      return null;
    }
    const cached = this.elements.get(selector);
    if (cached !== undefined && cached.isConnected) {
      return cached as T;
    }
    const found = doc.querySelector<T>(selector);
    if (found !== null) {
      this.elements.set(selector, found);
    } else {
      this.elements.delete(selector);
    }
    return found;
  }

  public getOrResolve<T extends Element>(key: string, resolver: () => T | null): T | null {
    const cached = this.elements.get(key);
    if (cached !== undefined && cached.isConnected) {
      return cached as T;
    }
    const resolved = resolver();
    if (resolved !== null) {
      this.elements.set(key, resolved);
    } else {
      this.elements.delete(key);
    }
    return resolved;
  }

  public clear(): void {
    this.elements.clear();
  }

  public size(): number {
    return this.elements.size;
  }
}

export const defaultDomCache = new ConnectedDomCache();

export function querySoundCloudPlayerTitleHint(
  domCache: ConnectedDomCache = defaultDomCache,
): DomTrackHint | undefined {
  const primaryTitleAnchor = domCache.query<HTMLAnchorElement>(
    '.playbackSoundBadge__titleLink',
  );
  let candidateAnchor: HTMLAnchorElement | null = primaryTitleAnchor;
  if (candidateAnchor === null) {
    candidateAnchor = domCache.getOrResolve<HTMLAnchorElement>(
      'fallbackBadgeAnchor',
      () => {
        if (typeof document === 'undefined') {
          return null;
        }
        const anchors = Array.from(
          document.querySelectorAll<HTMLAnchorElement>('.playbackSoundBadge a[href]'),
        );
        return (
          anchors.find((anchor) => {
            const rawHref = anchor.getAttribute('href')?.trim() ?? '';
            if (rawHref.length === 0) {
              return false;
            }
            try {
              const parsed = new URL(rawHref, 'https://soundcloud.com');
              return (
                parsed.pathname.split('/').filter((s) => s.length > 0).length >= 2
              );
            } catch {
              return false;
            }
          }) ?? null
        );
      },
    );
  }

  const href = candidateAnchor?.getAttribute('href')?.trim();
  const titleAttr = candidateAnchor?.getAttribute('title')?.trim();
  const textTitle = candidateAnchor?.textContent?.trim();
  const resolvedTitle =
    titleAttr !== undefined && titleAttr.length > 0
      ? titleAttr
      : textTitle !== undefined && textTitle.length > 0
        ? textTitle
        : undefined;

  if (href !== undefined && href.length > 0) {
    return {
      permalinkOrPath: href,
      ...(resolvedTitle !== undefined ? { title: resolvedTitle } : {}),
      isPlayerBadge: true,
    };
  }
  return {
    permalinkOrPath:
      typeof window !== 'undefined' ? window.location.pathname : '',
    isPlayerBadge: false,
  };
}

export function clickSoundCloudTransportButton(
  direction: 'next' | 'previous',
  domCache: ConnectedDomCache = defaultDomCache,
): void {
  const selector =
    direction === 'next'
      ? '.playControls__next, button.skipControl__next'
      : '.playControls__prev, button.skipControl__previous';
  const btn = domCache.query<HTMLButtonElement>(selector);
  btn?.click();
}

function bootstrapMainWorld(): void {
  const sessionObserver = new SoundCloudSessionObserver(getSafeLocalStorage());
  const catalog = new SoundCloudTrackCatalog({
    onHqTranscodingSeen: () => {
      sessionObserver.markHqTranscodingObserved();
    },
  });

  const outboundQueue: MainToIsolatedMessage[] = [];
  let postToIsolated: ((msg: MainToIsolatedMessage) => boolean) | null = null;

  const sendToIsolated = (msg: MainToIsolatedMessage): void => {
    if (postToIsolated !== null && postToIsolated(msg)) {
      return;
    }
    if (outboundQueue.length < 64) {
      outboundQueue.push(msg);
    }
  };

  let virtualizerRef: MaestroVirtualizerController | null = null;

  const keepalive = new MediaKeyKeepaliveController({
    onPlay: () => {
      const playBtn = defaultDomCache.query<HTMLButtonElement>(
        '.playControls__play, button.playControl',
      );
      if (playBtn !== null && !playBtn.classList.contains('playing')) {
        playBtn.click();
      }
    },
    onPause: () => {
      const playBtn = defaultDomCache.query<HTMLButtonElement>(
        '.playControls__play, button.playControl',
      );
      if (playBtn !== null && playBtn.classList.contains('playing')) {
        playBtn.click();
      } else {
        virtualizerRef?.pauseFromMediaSession();
      }
    },
    onPreviousTrack: () => {
      clickSoundCloudTransportButton('previous', defaultDomCache);
    },
    onNextTrack: () => {
      clickSoundCloudTransportButton('next', defaultDomCache);
    },
    onSeekTo: (seconds) => {
      virtualizerRef?.seekFromMediaSession(seconds);
    },
  });

  // Temporary holder wired to real nativeBridge immediately below
  let nativeBridgeProxy: ReturnType<typeof installMediaPrototypeHooks> | null = null;

  const virtualizer = new MaestroVirtualizerController({
    catalog,
    sessionObserver,
    sendToIsolated,
    keepalive,
    nativeBridge: {
      pauseElement(el) {
        nativeBridgeProxy?.pauseElement(el);
      },
      playElement(el) {
        nativeBridgeProxy?.playElement?.(el);
      },
      getNativeCurrentTimeSeconds(el) {
        return nativeBridgeProxy?.getNativeCurrentTimeSeconds(el) ?? 0;
      },
      setNativeCurrentTimeSeconds(el, seconds) {
        nativeBridgeProxy?.setNativeCurrentTimeSeconds?.(el, seconds);
      },
      getNativePaused(el) {
        return nativeBridgeProxy?.getNativePaused(el) ?? true;
      },
    },
    resolveDomTrackHint: () => querySoundCloudPlayerTitleHint(defaultDomCache),
  });
  virtualizerRef = virtualizer;

  nativeBridgeProxy = installMediaPrototypeHooks(virtualizer);
  installNetworkPassiveObservers(sessionObserver, catalog);

  const onUserInteraction = (): void => {
    virtualizer.recordUserInteraction();
  };
  for (const eventName of [
    'pointerdown',
    'mousedown',
    'touchstart',
    'keydown',
    'click',
  ] as const) {
    window.addEventListener(eventName, onUserInteraction, {
      capture: true,
      passive: true,
    });
  }
  window.addEventListener(
    'pointermove',
    (ev: PointerEvent) => {
      if (ev.buttons !== 0) {
        virtualizer.recordUserInteraction();
      }
    },
    { capture: true, passive: true },
  );

  sessionObserver.subscribe((snap) => {
    if (snap.clientId.length > 0 || snap.oauthToken !== undefined) {
      sendToIsolated({
        type: 'session_auth_observed',
        clientId: snap.clientId,
        oauthToken: snap.oauthToken,
        accountTier: snap.accountTier,
      });
    }
  });

  const scanHydrationAndCookies = (): void => {
    try {
      sessionObserver.observeCookieString(document.cookie);
      const win = window as unknown as Record<string, unknown>;
      const hydration = win['__sc_hydration'];
      if (hydration !== undefined) {
        sessionObserver.ingestHydration(hydration);
        catalog.ingestPayload(hydration, window.location.href);
      }
    } catch {
      // Ignore transient hydration scan errors.
    }
  };

  scanHydrationAndCookies();
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', scanHydrationAndCookies, {
      once: true,
    });
  }
  window.addEventListener('load', scanHydrationAndCookies, { once: true });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      sessionObserver.observeCookieString(document.cookie);
    }
  });

  const bridge = attachMainWorldNonceBridge((message) => {
    virtualizer.handleIsolatedMessage(message);
  });

  postToIsolated = (msg): boolean => bridge.send(msg);

  bridge.onReady(() => {
    while (outboundQueue.length > 0) {
      const queued = outboundQueue.shift();
      if (queued !== undefined) {
        bridge.send(queued);
      }
    }
    const snap = sessionObserver.getSnapshot();
    if (snap.clientId.length > 0 || snap.oauthToken !== undefined) {
      bridge.send({
        type: 'session_auth_observed',
        clientId: snap.clientId,
        oauthToken: snap.oauthToken,
        accountTier: snap.accountTier,
      });
    }
  });
}

if (
  typeof window !== 'undefined' &&
  typeof document !== 'undefined' &&
  (typeof process === 'undefined' || process.env?.NODE_ENV !== 'test')
) {
  bootstrapMainWorld();
}
