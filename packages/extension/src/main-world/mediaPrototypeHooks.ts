/**
 * Clean Web-Platform boundary interceptors (`HTMLMediaElement`, `SourceBuffer`,
 * `fetch`, `XMLHttpRequest`) for `MAIN`-world virtualization.
 *
 * Zero minified SoundCloud Webpack chunk scraping.
 */

import { isAllowedSoundCloudApiAuthUrl } from '@soundclud/protocol';
import { isKeepaliveAudioElement } from './mediaKeyKeepalive.js';
import {
  installMsePrototypeHooks,
  type MseVirtualizerRegistry,
} from './mseVirtualizer.js';
import type {
  MaestroVirtualizerController,
  NativeMediaBridge,
} from './playerVirtualizer.js';
import type {
  HeaderBagInput,
  SoundCloudSessionObserver,
} from './sessionObserver.js';
import type { SoundCloudTrackCatalog } from './trackCatalog.js';

const HOOKS_INSTALLED_FLAG = '__soundcludMainHooksInstalledV1' as const;
const MEDIA_PATCHED_FLAG = '__soundcludMediaProtoPatchedV1' as const;

interface InstalledMediaHooksSingleton {
  setController(controller: MaestroVirtualizerController): void;
  readonly nativeBridge: NativeMediaBridge;
}

let installedMediaSingleton: InstalledMediaHooksSingleton | null = null;
let activeNetworkSessionObserver: SoundCloudSessionObserver | null = null;
let activeNetworkCatalog: SoundCloudTrackCatalog | null = null;

function isLikelyHlsPlaylistUrl(rawUrl: string): boolean {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return false;
  }
  try {
    const parsed = new URL(rawUrl, 'https://soundcloud.com');
    return parsed.pathname.toLowerCase().endsWith('.m3u8');
  } catch {
    return false;
  }
}

export function installMediaPrototypeHooks(
  controller: MaestroVirtualizerController,
): NativeMediaBridge {
  let activeController = controller;

  const mseRegistry: MseVirtualizerRegistry = installMsePrototypeHooks({
    shouldVirtualizeSourceBuffer: () => activeController.shouldVirtualizeSourceBuffer(),
    getBufferedTimeRanges: () => activeController.getBufferedTimeRanges(),
    getDurationSeconds: (fallback) => activeController.getDurationSeconds(fallback),
  });

  if (
    installedMediaSingleton !== null &&
    typeof HTMLMediaElement !== 'undefined' &&
    (HTMLMediaElement.prototype.play as unknown as Record<string, unknown>)[
      MEDIA_PATCHED_FLAG
    ] === true
  ) {
    installedMediaSingleton.setController(controller);
    return installedMediaSingleton.nativeBridge;
  }

  const mediaProto = HTMLMediaElement.prototype;
  const origPlay = mediaProto.play;
  const origPause = mediaProto.pause;
  const origLoad = mediaProto.load;
  const origRemoveAttribute = mediaProto.removeAttribute;
  const origSetAttribute = mediaProto.setAttribute;

  const srcDesc = Object.getOwnPropertyDescriptor(mediaProto, 'src');
  const currentTimeDesc = Object.getOwnPropertyDescriptor(mediaProto, 'currentTime');
  const durationDesc = Object.getOwnPropertyDescriptor(mediaProto, 'duration');
  const pausedDesc = Object.getOwnPropertyDescriptor(mediaProto, 'paused');
  const seekingDesc = Object.getOwnPropertyDescriptor(mediaProto, 'seeking');
  const endedDesc = Object.getOwnPropertyDescriptor(mediaProto, 'ended');
  const readyStateDesc = Object.getOwnPropertyDescriptor(mediaProto, 'readyState');
  const bufferedDesc = Object.getOwnPropertyDescriptor(mediaProto, 'buffered');
  const volumeDesc = Object.getOwnPropertyDescriptor(mediaProto, 'volume');
  const mutedDesc = Object.getOwnPropertyDescriptor(mediaProto, 'muted');

  const nativeBridge: NativeMediaBridge = {
    pauseElement(element: EventTarget): void {
      if (element instanceof HTMLMediaElement) {
        origPause.call(element);
      }
    },
    playElement(element: EventTarget): void {
      if (element instanceof HTMLMediaElement) {
        void origPlay.call(element).catch(() => {
          // Ignore autoplay rejections when resuming local fallback.
        });
      }
    },
    getNativeCurrentTimeSeconds(element: EventTarget): number {
      if (element instanceof HTMLMediaElement && currentTimeDesc?.get !== undefined) {
        return Number(currentTimeDesc.get.call(element)) || 0;
      }
      return 0;
    },
    setNativeCurrentTimeSeconds(element: EventTarget, seconds: number): void {
      if (element instanceof HTMLMediaElement && currentTimeDesc?.set !== undefined) {
        currentTimeDesc.set.call(element, seconds);
      }
    },
    getNativePaused(element: EventTarget): boolean {
      if (element instanceof HTMLMediaElement && pausedDesc?.get !== undefined) {
        return Boolean(pausedDesc.get.call(element));
      }
      return true;
    },
  };

  const patchedPlay = function patchedPlay(this: HTMLMediaElement): Promise<void> {
    if (isKeepaliveAudioElement(this)) {
      return origPlay.call(this);
    }
    const mediaSrc = this.currentSrc || this.src || undefined;
    if (typeof mediaSrc === 'string' && mediaSrc.startsWith('blob:')) {
      mseRegistry.bindElementMediaSource(this, mediaSrc);
    }
    const outcome = activeController.interceptPlay(this, mediaSrc);
    if (outcome.handledRemotely) {
      origPause.call(this);
      return Promise.resolve();
    }
    return origPlay.call(this);
  };
  Object.defineProperty(patchedPlay, MEDIA_PATCHED_FLAG, {
    value: true,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  mediaProto.play = patchedPlay;

  mediaProto.pause = function patchedPause(this: HTMLMediaElement): void {
    if (isKeepaliveAudioElement(this)) {
      origPause.call(this);
      return;
    }
    if (activeController.interceptPause(this)) {
      origPause.call(this);
      return;
    }
    origPause.call(this);
  };

  if (typeof origLoad === 'function') {
    mediaProto.load = function patchedLoad(this: HTMLMediaElement): void {
      if (isKeepaliveAudioElement(this)) {
        origLoad.call(this);
        return;
      }
      activeController.interceptMediaElementLoad(this);
      origLoad.call(this);
    };
  }

  if (srcDesc?.get !== undefined && srcDesc.set !== undefined) {
    Object.defineProperty(mediaProto, 'src', {
      configurable: true,
      enumerable: true,
      get(this: HTMLMediaElement): string {
        return String(srcDesc.get?.call(this) ?? '');
      },
      set(this: HTMLMediaElement, value: string): void {
        if (isKeepaliveAudioElement(this)) {
          srcDesc.set?.call(this, value);
          return;
        }
        const strVal = String(value ?? '');
        if (strVal.startsWith('blob:')) {
          mseRegistry.bindElementMediaSource(this, strVal);
        }
        activeController.interceptMediaSourceReset(this, strVal);
        srcDesc.set?.call(this, strVal);
      },
    });
  }

  if (typeof origRemoveAttribute === 'function') {
    mediaProto.removeAttribute = function patchedRemoveAttribute(
      this: HTMLMediaElement,
      qualifiedName: string,
    ): void {
      if (
        !isKeepaliveAudioElement(this) &&
        typeof qualifiedName === 'string' &&
        qualifiedName.toLowerCase() === 'src'
      ) {
        activeController.interceptMediaSourceReset(this, '');
      }
      origRemoveAttribute.call(this, qualifiedName);
    };
  }

  if (typeof origSetAttribute === 'function') {
    mediaProto.setAttribute = function patchedSetAttribute(
      this: HTMLMediaElement,
      qualifiedName: string,
      value: string,
    ): void {
      if (
        !isKeepaliveAudioElement(this) &&
        typeof qualifiedName === 'string' &&
        qualifiedName.toLowerCase() === 'src'
      ) {
        const strVal = String(value ?? '');
        if (strVal.startsWith('blob:')) {
          mseRegistry.bindElementMediaSource(this, strVal);
        }
        activeController.interceptMediaSourceReset(this, strVal);
      }
      origSetAttribute.call(this, qualifiedName, value);
    };
  }

  if (currentTimeDesc?.get !== undefined && currentTimeDesc.set !== undefined) {
    Object.defineProperty(mediaProto, 'currentTime', {
      configurable: true,
      enumerable: true,
      get(this: HTMLMediaElement): number {
        if (activeController.isElementVirtualized(this)) {
          return activeController.getCurrentTimeSeconds();
        }
        return Number(currentTimeDesc.get?.call(this)) || 0;
      },
      set(this: HTMLMediaElement, value: number): void {
        if (activeController.interceptSeekSeconds(this, value)) {
          return;
        }
        currentTimeDesc.set?.call(this, value);
      },
    });
  }

  if (durationDesc?.get !== undefined) {
    Object.defineProperty(mediaProto, 'duration', {
      configurable: true,
      enumerable: true,
      get(this: HTMLMediaElement): number {
        const nativeVal = Number(durationDesc.get?.call(this));
        if (activeController.isElementVirtualized(this)) {
          return activeController.getDurationSeconds(nativeVal);
        }
        return nativeVal;
      },
    });
  }

  if (pausedDesc?.get !== undefined) {
    Object.defineProperty(mediaProto, 'paused', {
      configurable: true,
      enumerable: true,
      get(this: HTMLMediaElement): boolean {
        if (activeController.isElementVirtualized(this)) {
          return activeController.getPaused();
        }
        return Boolean(pausedDesc.get?.call(this));
      },
    });
  }

  if (seekingDesc?.get !== undefined) {
    Object.defineProperty(mediaProto, 'seeking', {
      configurable: true,
      enumerable: true,
      get(this: HTMLMediaElement): boolean {
        if (activeController.isElementVirtualized(this)) {
          return activeController.getSeeking();
        }
        return Boolean(seekingDesc.get?.call(this));
      },
    });
  }

  if (endedDesc?.get !== undefined) {
    Object.defineProperty(mediaProto, 'ended', {
      configurable: true,
      enumerable: true,
      get(this: HTMLMediaElement): boolean {
        if (activeController.isElementVirtualized(this)) {
          return activeController.getEnded();
        }
        return Boolean(endedDesc.get?.call(this));
      },
    });
  }

  if (readyStateDesc?.get !== undefined) {
    Object.defineProperty(mediaProto, 'readyState', {
      configurable: true,
      enumerable: true,
      get(this: HTMLMediaElement): number {
        if (activeController.isElementVirtualized(this)) {
          return 4; // HTMLMediaElement.HAVE_ENOUGH_DATA
        }
        return Number(readyStateDesc.get?.call(this));
      },
    });
  }

  if (bufferedDesc?.get !== undefined) {
    Object.defineProperty(mediaProto, 'buffered', {
      configurable: true,
      enumerable: true,
      get(this: HTMLMediaElement): TimeRanges {
        if (activeController.isElementVirtualized(this)) {
          return activeController.getBufferedTimeRanges();
        }
        return bufferedDesc.get!.call(this) as TimeRanges;
      },
    });
  }

  if (volumeDesc?.get !== undefined && volumeDesc.set !== undefined) {
    Object.defineProperty(mediaProto, 'volume', {
      configurable: true,
      enumerable: true,
      get(this: HTMLMediaElement): number {
        if (activeController.isElementVirtualized(this)) {
          return activeController.getVirtualVolume();
        }
        return Number(volumeDesc.get?.call(this));
      },
      set(this: HTMLMediaElement, val: number): void {
        if (isKeepaliveAudioElement(this)) {
          volumeDesc.set?.call(this, val);
          return;
        }
        activeController.recordLocalUiVolumeMutation(val, undefined);
        if (!activeController.isElementVirtualized(this)) {
          volumeDesc.set?.call(this, val);
        }
      },
    });
  }

  if (mutedDesc?.get !== undefined && mutedDesc.set !== undefined) {
    Object.defineProperty(mediaProto, 'muted', {
      configurable: true,
      enumerable: true,
      get(this: HTMLMediaElement): boolean {
        if (activeController.isElementVirtualized(this)) {
          return activeController.getVirtualMuted();
        }
        return Boolean(mutedDesc.get?.call(this));
      },
      set(this: HTMLMediaElement, val: boolean): void {
        if (isKeepaliveAudioElement(this)) {
          mutedDesc.set?.call(this, val);
          return;
        }
        activeController.recordLocalUiVolumeMutation(undefined, val);
        if (!activeController.isElementVirtualized(this)) {
          mutedDesc.set?.call(this, val);
        }
      },
    });
  }

  installedMediaSingleton = {
    setController(nextController: MaestroVirtualizerController): void {
      activeController = nextController;
    },
    nativeBridge,
  };

  return nativeBridge;
}

export function installNetworkPassiveObservers(
  sessionObserver: SoundCloudSessionObserver,
  catalog: SoundCloudTrackCatalog,
): void {
  activeNetworkSessionObserver = sessionObserver;
  activeNetworkCatalog = catalog;

  const winRecord = window as unknown as Record<string, unknown>;
  if (winRecord[HOOKS_INSTALLED_FLAG] === true) {
    return;
  }
  winRecord[HOOKS_INSTALLED_FLAG] = true;

  const origFetch = window.fetch.bind(window);
  window.fetch = async function patchedFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> {
    const obs = activeNetworkSessionObserver ?? sessionObserver;
    const cat = activeNetworkCatalog ?? catalog;

    const rawUrl =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;

    const headers: HeaderBagInput =
      (init?.headers as HeaderBagInput) ??
      (typeof Request !== 'undefined' && input instanceof Request
        ? input.headers
        : undefined);

    try {
      obs.observeCookieString(document.cookie);
      if (isAllowedSoundCloudApiAuthUrl(rawUrl)) {
        obs.observeApiRequest(rawUrl, headers);
        if (rawUrl.includes('/stream/')) {
          cat.observeResolveAttemptUrl(rawUrl);
        }
      } else if (isLikelyHlsPlaylistUrl(rawUrl)) {
        cat.observeFetchedPlaylistUrl(rawUrl);
      }
    } catch {
      // Never disrupt page fetch on observer edge cases.
    }

    const response = await origFetch(input, init);
    if (isAllowedSoundCloudApiAuthUrl(rawUrl)) {
      const contentType = response.headers.get('content-type') ?? '';
      if (contentType.includes('json')) {
        void (async () => {
          try {
            const cloned = response.clone();
            const json: unknown = await cloned.json();
            obs.ingestUserOrSessionPayload(json, rawUrl);
            cat.ingestPayload(json, rawUrl);
          } catch {
            // Ignore aborted or non-JSON responses.
          }
        })();
      }
    }
    return response;
  };

  const xhrProto = XMLHttpRequest.prototype;
  const origOpen = xhrProto.open;
  const origSetRequestHeader = xhrProto.setRequestHeader;
  const origSend = xhrProto.send;

  interface XhrTrackingMeta {
    url: string;
    headers: Record<string, string>;
  }
  const xhrMeta = new WeakMap<XMLHttpRequest, XhrTrackingMeta>();

  xhrProto.open = function patchedXhrOpen(
    this: XMLHttpRequest,
    method: string,
    url: string | URL,
    asyncFlag: boolean = true,
    username?: string | null,
    password?: string | null,
  ): void {
    const urlStr = typeof url === 'string' ? url : url.href;
    xhrMeta.set(this, { url: urlStr, headers: {} });
    origOpen.call(this, method, url, asyncFlag, username ?? null, password ?? null);
  };

  xhrProto.setRequestHeader = function patchedSetRequestHeader(
    this: XMLHttpRequest,
    name: string,
    value: string,
  ): void {
    const meta = xhrMeta.get(this);
    if (meta !== undefined) {
      meta.headers[name] = value;
    }
    origSetRequestHeader.call(this, name, value);
  };

  xhrProto.send = function patchedXhrSend(
    this: XMLHttpRequest,
    body?: Document | XMLHttpRequestBodyInit | null,
  ): void {
    const obs = activeNetworkSessionObserver ?? sessionObserver;
    const cat = activeNetworkCatalog ?? catalog;
    const meta = xhrMeta.get(this);
    if (meta !== undefined) {
      if (isAllowedSoundCloudApiAuthUrl(meta.url)) {
        obs.observeCookieString(document.cookie);
        obs.observeApiRequest(meta.url, meta.headers);
        if (meta.url.includes('/stream/')) {
          cat.observeResolveAttemptUrl(meta.url);
        }
        this.addEventListener(
          'load',
          () => {
            try {
              if (
                this.responseType === '' ||
                this.responseType === 'text'
              ) {
                const text = this.responseText;
                if (text.startsWith('{') || text.startsWith('[')) {
                  const parsed: unknown = JSON.parse(text);
                  obs.ingestUserOrSessionPayload(parsed, meta.url);
                  cat.ingestPayload(parsed, meta.url);
                }
              } else if (
                this.responseType === 'json' &&
                this.response !== null &&
                this.response !== undefined
              ) {
                obs.ingestUserOrSessionPayload(this.response, meta.url);
                cat.ingestPayload(this.response, meta.url);
              }
            } catch {
              // Ignore malformed XHR payloads.
            }
          },
          { once: true },
        );
      } else if (isLikelyHlsPlaylistUrl(meta.url)) {
        cat.observeFetchedPlaylistUrl(meta.url);
      }
    }
    origSend.call(this, body ?? null);
  };
}
