/**
 * Clean Web-Platform boundary interceptors (`HTMLMediaElement`, `SourceBuffer`,
 * `fetch`, `XMLHttpRequest`) for `MAIN`-world virtualization.
 *
 * Zero minified SoundCloud Webpack chunk scraping.
 */

import { isAllowedSoundCloudApiAuthUrl } from '@soundclud/protocol';
import { isKeepaliveAudioElement } from './mediaKeyKeepalive.js';
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

export function installMediaPrototypeHooks(
  controller: MaestroVirtualizerController,
): NativeMediaBridge {
  const mediaProto = HTMLMediaElement.prototype;
  const origPlay = mediaProto.play;
  const origPause = mediaProto.pause;

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
    getNativeCurrentTimeSeconds(element: EventTarget): number {
      if (element instanceof HTMLMediaElement && currentTimeDesc?.get !== undefined) {
        return Number(currentTimeDesc.get.call(element)) || 0;
      }
      return 0;
    },
    getNativePaused(element: EventTarget): boolean {
      if (element instanceof HTMLMediaElement && pausedDesc?.get !== undefined) {
        return Boolean(pausedDesc.get.call(element));
      }
      return true;
    },
  };

  mediaProto.play = function patchedPlay(this: HTMLMediaElement): Promise<void> {
    if (isKeepaliveAudioElement(this)) {
      return origPlay.call(this);
    }
    const mediaSrc = this.currentSrc || this.src || undefined;
    const outcome = controller.interceptPlay(this, mediaSrc);
    if (outcome.handledRemotely) {
      origPause.call(this);
      return Promise.resolve();
    }
    return origPlay.call(this);
  };

  mediaProto.pause = function patchedPause(this: HTMLMediaElement): void {
    if (isKeepaliveAudioElement(this)) {
      origPause.call(this);
      return;
    }
    if (controller.interceptPause(this)) {
      origPause.call(this);
      return;
    }
    origPause.call(this);
  };

  if (currentTimeDesc?.get !== undefined && currentTimeDesc.set !== undefined) {
    Object.defineProperty(mediaProto, 'currentTime', {
      configurable: true,
      enumerable: true,
      get(this: HTMLMediaElement): number {
        if (controller.isElementVirtualized(this)) {
          return controller.getCurrentTimeSeconds();
        }
        return Number(currentTimeDesc.get?.call(this)) || 0;
      },
      set(this: HTMLMediaElement, value: number): void {
        if (controller.interceptSeekSeconds(this, value)) {
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
        if (controller.isElementVirtualized(this)) {
          return controller.getDurationSeconds(nativeVal);
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
        if (controller.isElementVirtualized(this)) {
          return controller.getPaused();
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
        if (controller.isElementVirtualized(this)) {
          return controller.getSeeking();
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
        if (controller.isElementVirtualized(this)) {
          return controller.getEnded();
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
        if (controller.isElementVirtualized(this)) {
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
        if (controller.isElementVirtualized(this)) {
          return controller.getBufferedTimeRanges();
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
        if (controller.isElementVirtualized(this)) {
          return controller.getVirtualVolume();
        }
        return Number(volumeDesc.get?.call(this));
      },
      set(this: HTMLMediaElement, val: number): void {
        if (isKeepaliveAudioElement(this)) {
          volumeDesc.set?.call(this, val);
          return;
        }
        controller.recordLocalUiVolumeMutation(val, undefined);
        if (!controller.isElementVirtualized(this)) {
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
        if (controller.isElementVirtualized(this)) {
          return controller.getVirtualMuted();
        }
        return Boolean(mutedDesc.get?.call(this));
      },
      set(this: HTMLMediaElement, val: boolean): void {
        if (isKeepaliveAudioElement(this)) {
          mutedDesc.set?.call(this, val);
          return;
        }
        controller.recordLocalUiVolumeMutation(undefined, val);
        if (!controller.isElementVirtualized(this)) {
          mutedDesc.set?.call(this, val);
        }
      },
    });
  }

  if (typeof SourceBuffer !== 'undefined') {
    const sbProto = SourceBuffer.prototype;
    const origAppendBuffer = sbProto.appendBuffer;
    const sbBufferedDesc = Object.getOwnPropertyDescriptor(sbProto, 'buffered');
    const sbUpdatingDesc = Object.getOwnPropertyDescriptor(sbProto, 'updating');
    const virtualUpdatingSet = new WeakSet<SourceBuffer>();

    sbProto.appendBuffer = function patchedAppendBuffer(
      this: SourceBuffer,
      data: BufferSource,
    ): void {
      if (!controller.shouldVirtualizeSourceBuffer()) {
        origAppendBuffer.call(this, data);
        return;
      }

      // Suppress local audio segment decode during remote handoff (`0%` local decode CPU).
      virtualUpdatingSet.add(this);
      try {
        this.dispatchEvent(new Event('updatestart'));
      } catch {
        // Ignore non-fatal dispatch errors.
      }
      queueMicrotask(() => {
        virtualUpdatingSet.delete(this);
        try {
          this.dispatchEvent(new Event('update'));
          this.dispatchEvent(new Event('updateend'));
        } catch {
          // Ignore detached SourceBuffer errors.
        }
      });
    };

    if (sbBufferedDesc?.get !== undefined) {
      Object.defineProperty(sbProto, 'buffered', {
        configurable: true,
        enumerable: true,
        get(this: SourceBuffer): TimeRanges {
          if (controller.shouldVirtualizeSourceBuffer()) {
            return controller.getBufferedTimeRanges();
          }
          return sbBufferedDesc.get!.call(this) as TimeRanges;
        },
      });
    }

    if (sbUpdatingDesc?.get !== undefined) {
      Object.defineProperty(sbProto, 'updating', {
        configurable: true,
        enumerable: true,
        get(this: SourceBuffer): boolean {
          if (virtualUpdatingSet.has(this)) {
            return true;
          }
          return Boolean(sbUpdatingDesc.get?.call(this));
        },
      });
    }
  }

  return nativeBridge;
}

export function installNetworkPassiveObservers(
  sessionObserver: SoundCloudSessionObserver,
  catalog: SoundCloudTrackCatalog,
): void {
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
      sessionObserver.observeCookieString(document.cookie);
      if (isAllowedSoundCloudApiAuthUrl(rawUrl)) {
        sessionObserver.observeApiRequest(rawUrl, headers);
        if (rawUrl.includes('/stream/')) {
          catalog.observeResolveAttemptUrl(rawUrl);
        }
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
            sessionObserver.ingestUserOrSessionPayload(json, rawUrl);
            catalog.ingestPayload(json, rawUrl);
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
    const meta = xhrMeta.get(this);
    if (meta !== undefined && isAllowedSoundCloudApiAuthUrl(meta.url)) {
      sessionObserver.observeCookieString(document.cookie);
      sessionObserver.observeApiRequest(meta.url, meta.headers);
      if (meta.url.includes('/stream/')) {
        catalog.observeResolveAttemptUrl(meta.url);
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
                sessionObserver.ingestUserOrSessionPayload(parsed, meta.url);
                catalog.ingestPayload(parsed, meta.url);
              }
            } else if (
              this.responseType === 'json' &&
              this.response !== null &&
              this.response !== undefined
            ) {
              sessionObserver.ingestUserOrSessionPayload(this.response, meta.url);
              catalog.ingestPayload(this.response, meta.url);
            }
          } catch {
            // Ignore malformed XHR payloads.
          }
        },
        { once: true },
      );
    }
    origSend.call(this, body ?? null);
  };
}
