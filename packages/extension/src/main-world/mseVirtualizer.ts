/**
 * Full in-memory W3C Media Source Extensions (`MediaSource` & `SourceBuffer`)
 * virtualizer (`MAIN` world).
 *
 * When remote handoff is active, SoundCloud's `HLSMSEPlayer` (and `hls.js`
 * fallback) creates a `MediaSource` + `SourceBuffer` and calls `appendBuffer`,
 * `remove`, `abort`, `timestampOffset`, `appendWindowStart`, `appendWindowEnd`,
 * `mode`, `MediaSource.duration`, and `MediaSource.endOfStream`.
 *
 * Delegating any mutating call to an empty native C++ `SourceBuffer`/`MediaSource`
 * throws `InvalidStateError` (`HLS_MSE_PLAYER.APPEND_ERROR`), triggering infinite
 * segment eviction/refetch loops and V8 OOM in `ErrorEventGenerator._reportEvent`.
 * This module virtualizes the entire MSE contract in pure JS per `WeakMap` state.
 */

export interface MseVirtualizerHost {
  shouldVirtualizeSourceBuffer(): boolean;
  getBufferedTimeRanges(): TimeRanges;
  getDurationSeconds(fallbackSeconds: number): number;
}

interface VirtualMediaSourceState {
  duration: number;
  ended: boolean;
}

interface VirtualSourceBufferState {
  updating: boolean;
  timestampOffset: number;
  appendWindowStart: number;
  appendWindowEnd: number;
  mode: AppendMode;
  opGeneration: number;
}

const PATCHED_MSE_FLAG = '__soundcludMsePatchedV1' as const;
const MAX_TRACKED_OBJECT_URLS = 64;

export interface MseVirtualizerRegistry {
  resolveMediaSourceForBlobUrl(blobUrl: string): MediaSource | undefined;
  bindElementMediaSource(element: EventTarget, blobUrl: string): MediaSource | undefined;
}

interface InstalledMseSingleton {
  setHost(host: MseVirtualizerHost): void;
  readonly registry: MseVirtualizerRegistry;
}

let installedMseSingleton: InstalledMseSingleton | null = null;
const sharedMediaSourceByBlobUrl = new Map<string, WeakRef<MediaSource>>();

function dispatchSafeEvent(target: EventTarget, eventName: string): void {
  if (typeof Event === 'undefined') {
    return;
  }
  try {
    target.dispatchEvent(new Event(eventName));
  } catch {
    // Ignore detached MSE EventTarget dispatch errors.
  }
}

export function installMsePrototypeHooks(
  initialHost: MseVirtualizerHost,
): MseVirtualizerRegistry {
  if (
    installedMseSingleton !== null &&
    typeof SourceBuffer !== 'undefined' &&
    (SourceBuffer.prototype.appendBuffer as unknown as Record<string, unknown>)[
      PATCHED_MSE_FLAG
    ] === true
  ) {
    installedMseSingleton.setHost(initialHost);
    return installedMseSingleton.registry;
  }

  let currentHost: MseVirtualizerHost = initialHost;

  const mediaSourceByBlobUrl = sharedMediaSourceByBlobUrl;
  const elementMediaSources = new WeakMap<EventTarget, MediaSource>();
  const ownerMediaSourceByBuffer = new WeakMap<SourceBuffer, MediaSource>();
  const virtualMediaSources = new WeakMap<MediaSource, VirtualMediaSourceState>();
  const virtualSourceBuffers = new WeakMap<SourceBuffer, VirtualSourceBufferState>();

  const ensureVirtualMediaSource = (ms: MediaSource): VirtualMediaSourceState => {
    let state = virtualMediaSources.get(ms);
    if (state === undefined) {
      state = {
        duration: Number.NaN,
        ended: false,
      };
      virtualMediaSources.set(ms, state);
    }
    return state;
  };

  const ensureVirtualSourceBuffer = (sb: SourceBuffer): VirtualSourceBufferState => {
    let state = virtualSourceBuffers.get(sb);
    if (state === undefined) {
      state = {
        updating: false,
        timestampOffset: 0,
        appendWindowStart: 0,
        appendWindowEnd: Number.POSITIVE_INFINITY,
        mode: 'segments',
        opGeneration: 0,
      };
      virtualSourceBuffers.set(sb, state);
    }
    const ownerMs = ownerMediaSourceByBuffer.get(sb);
    if (ownerMs !== undefined) {
      ensureVirtualMediaSource(ownerMs);
    }
    return state;
  };

  const shouldVirtualizeMs = (ms: MediaSource): boolean => {
    if (virtualMediaSources.has(ms)) {
      return true;
    }
    if (currentHost.shouldVirtualizeSourceBuffer()) {
      ensureVirtualMediaSource(ms);
      return true;
    }
    return false;
  };

  const shouldVirtualizeSb = (sb: SourceBuffer): boolean => {
    if (virtualSourceBuffers.has(sb)) {
      return true;
    }
    const ownerMs = ownerMediaSourceByBuffer.get(sb);
    if (ownerMs !== undefined && virtualMediaSources.has(ownerMs)) {
      ensureVirtualSourceBuffer(sb);
      return true;
    }
    if (currentHost.shouldVirtualizeSourceBuffer()) {
      ensureVirtualSourceBuffer(sb);
      return true;
    }
    return false;
  };

  if (
    typeof URL !== 'undefined' &&
    typeof URL.createObjectURL === 'function' &&
    typeof MediaSource !== 'undefined'
  ) {
    const urlCtor = URL as unknown as Record<string, unknown>;
    if (urlCtor[PATCHED_MSE_FLAG] !== true) {
      const origCreateObjectURL = URL.createObjectURL.bind(URL);
      const origRevokeObjectURL =
        typeof URL.revokeObjectURL === 'function'
          ? URL.revokeObjectURL.bind(URL)
          : undefined;

      URL.createObjectURL = function patchedCreateObjectURL(
        obj: Blob | MediaSource,
      ): string {
        const blobUrl = origCreateObjectURL(obj);
        if (typeof MediaSource !== 'undefined' && obj instanceof MediaSource) {
          if (mediaSourceByBlobUrl.size >= MAX_TRACKED_OBJECT_URLS) {
            const oldestKey = mediaSourceByBlobUrl.keys().next().value;
            if (typeof oldestKey === 'string') {
              mediaSourceByBlobUrl.delete(oldestKey);
            }
          }
          mediaSourceByBlobUrl.set(blobUrl, new WeakRef(obj));
        }
        return blobUrl;
      };

      if (origRevokeObjectURL !== undefined) {
        URL.revokeObjectURL = function patchedRevokeObjectURL(url: string): void {
          mediaSourceByBlobUrl.delete(url);
          origRevokeObjectURL(url);
        };
      }

      Object.defineProperty(URL, PATCHED_MSE_FLAG, {
        value: true,
        configurable: true,
        enumerable: false,
        writable: false,
      });
    }
  }

  if (typeof MediaSource !== 'undefined') {
    const msProto = MediaSource.prototype;
    const origAddSourceBuffer = msProto.addSourceBuffer;
    const origRemoveSourceBuffer = msProto.removeSourceBuffer;
    const origEndOfStream = msProto.endOfStream;
    const msDurationDesc = Object.getOwnPropertyDescriptor(msProto, 'duration');
    const msReadyStateDesc = Object.getOwnPropertyDescriptor(msProto, 'readyState');

    msProto.addSourceBuffer = function patchedAddSourceBuffer(
      this: MediaSource,
      type: string,
    ): SourceBuffer {
      const sb = origAddSourceBuffer.call(this, type);
      ownerMediaSourceByBuffer.set(sb, this);
      if (virtualMediaSources.has(this)) {
        ensureVirtualSourceBuffer(sb);
      }
      return sb;
    };

    if (typeof origRemoveSourceBuffer === 'function') {
      msProto.removeSourceBuffer = function patchedRemoveSourceBuffer(
        this: MediaSource,
        sb: SourceBuffer,
      ): void {
        const isVirtual = virtualMediaSources.has(this) || virtualSourceBuffers.has(sb);
        try {
          origRemoveSourceBuffer.call(this, sb);
        } catch (err) {
          if (!isVirtual) {
            throw err;
          }
        }
      };
    }

    if (typeof origEndOfStream === 'function') {
      msProto.endOfStream = function patchedEndOfStream(
        this: MediaSource,
        error?: EndOfStreamError,
      ): void {
        if (!shouldVirtualizeMs(this)) {
          origEndOfStream.call(this, error);
          return;
        }
        const state = ensureVirtualMediaSource(this);
        state.ended = true;
        queueMicrotask(() => {
          dispatchSafeEvent(this, 'sourceended');
        });
      };
    }

    if (msDurationDesc?.get !== undefined) {
      Object.defineProperty(msProto, 'duration', {
        configurable: true,
        enumerable: true,
        get(this: MediaSource): number {
          const nativeDur = Number(msDurationDesc.get?.call(this));
          if (shouldVirtualizeMs(this)) {
            const state = ensureVirtualMediaSource(this);
            const fallback = Number.isFinite(state.duration) && state.duration >= 0
              ? state.duration
              : nativeDur;
            return currentHost.getDurationSeconds(fallback);
          }
          return nativeDur;
        },
        set(this: MediaSource, value: number): void {
          if (shouldVirtualizeMs(this)) {
            const state = ensureVirtualMediaSource(this);
            if (typeof value === 'number' && !Number.isNaN(value) && value >= 0) {
              state.duration = value;
            }
            return;
          }
          msDurationDesc.set?.call(this, value);
        },
      });
    }

    if (msReadyStateDesc?.get !== undefined) {
      Object.defineProperty(msProto, 'readyState', {
        configurable: true,
        enumerable: true,
        get(this: MediaSource): ReadyState {
          const state = virtualMediaSources.get(this);
          if (state?.ended === true) {
            return 'ended';
          }
          return msReadyStateDesc.get!.call(this) as ReadyState;
        },
      });
    }
  }

  if (typeof SourceBuffer !== 'undefined') {
    const sbProto = SourceBuffer.prototype;
    const origAppendBuffer = sbProto.appendBuffer;
    const origRemove = sbProto.remove;
    const origAbort = sbProto.abort;

    const sbBufferedDesc = Object.getOwnPropertyDescriptor(sbProto, 'buffered');
    const sbUpdatingDesc = Object.getOwnPropertyDescriptor(sbProto, 'updating');
    const sbTimestampOffsetDesc = Object.getOwnPropertyDescriptor(
      sbProto,
      'timestampOffset',
    );
    const sbAppendWindowStartDesc = Object.getOwnPropertyDescriptor(
      sbProto,
      'appendWindowStart',
    );
    const sbAppendWindowEndDesc = Object.getOwnPropertyDescriptor(
      sbProto,
      'appendWindowEnd',
    );
    const sbModeDesc = Object.getOwnPropertyDescriptor(sbProto, 'mode');

    const scheduleVirtualBufferUpdate = (sb: SourceBuffer): void => {
      const state = ensureVirtualSourceBuffer(sb);
      const gen = state.opGeneration + 1;
      state.opGeneration = gen;
      state.updating = true;
      dispatchSafeEvent(sb, 'updatestart');
      queueMicrotask(() => {
        if (state.opGeneration !== gen || !state.updating) {
          return;
        }
        state.updating = false;
        dispatchSafeEvent(sb, 'update');
        dispatchSafeEvent(sb, 'updateend');
      });
    };

    const patchedAppendBuffer = function patchedAppendBuffer(
      this: SourceBuffer,
      data: BufferSource,
    ): void {
      if (!shouldVirtualizeSb(this)) {
        origAppendBuffer.call(this, data);
        return;
      }
      scheduleVirtualBufferUpdate(this);
    };

    Object.defineProperty(patchedAppendBuffer, PATCHED_MSE_FLAG, {
      value: true,
      configurable: true,
      enumerable: false,
      writable: false,
    });
    sbProto.appendBuffer = patchedAppendBuffer;

    if (typeof origRemove === 'function') {
      sbProto.remove = function patchedRemove(
        this: SourceBuffer,
        start: number,
        end: number,
      ): void {
        if (!shouldVirtualizeSb(this)) {
          origRemove.call(this, start, end);
          return;
        }
        if (
          typeof start !== 'number' ||
          !Number.isFinite(start) ||
          start < 0 ||
          typeof end !== 'number' ||
          Number.isNaN(end) ||
          end <= start
        ) {
          return;
        }
        scheduleVirtualBufferUpdate(this);
      };
    }

    if (typeof origAbort === 'function') {
      sbProto.abort = function patchedAbort(this: SourceBuffer): void {
        if (!shouldVirtualizeSb(this)) {
          origAbort.call(this);
          return;
        }
        const state = ensureVirtualSourceBuffer(this);
        state.opGeneration += 1;
        if (state.updating) {
          state.updating = false;
          dispatchSafeEvent(this, 'abort');
          dispatchSafeEvent(this, 'updateend');
        }
      };
    }

    if (sbBufferedDesc?.get !== undefined) {
      Object.defineProperty(sbProto, 'buffered', {
        configurable: true,
        enumerable: true,
        get(this: SourceBuffer): TimeRanges {
          if (shouldVirtualizeSb(this)) {
            return currentHost.getBufferedTimeRanges();
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
          const virtualState = virtualSourceBuffers.get(this);
          if (virtualState !== undefined) {
            return virtualState.updating;
          }
          if (currentHost.shouldVirtualizeSourceBuffer()) {
            return false;
          }
          return Boolean(sbUpdatingDesc.get?.call(this));
        },
      });
    }

    if (sbTimestampOffsetDesc?.get !== undefined) {
      Object.defineProperty(sbProto, 'timestampOffset', {
        configurable: true,
        enumerable: true,
        get(this: SourceBuffer): number {
          if (shouldVirtualizeSb(this)) {
            return ensureVirtualSourceBuffer(this).timestampOffset;
          }
          return Number(sbTimestampOffsetDesc.get?.call(this)) || 0;
        },
        set(this: SourceBuffer, value: number): void {
          if (shouldVirtualizeSb(this)) {
            if (typeof value === 'number' && Number.isFinite(value)) {
              ensureVirtualSourceBuffer(this).timestampOffset = value;
            }
            return;
          }
          sbTimestampOffsetDesc.set?.call(this, value);
        },
      });
    }

    if (sbAppendWindowStartDesc?.get !== undefined) {
      Object.defineProperty(sbProto, 'appendWindowStart', {
        configurable: true,
        enumerable: true,
        get(this: SourceBuffer): number {
          if (shouldVirtualizeSb(this)) {
            return ensureVirtualSourceBuffer(this).appendWindowStart;
          }
          return Number(sbAppendWindowStartDesc.get?.call(this)) || 0;
        },
        set(this: SourceBuffer, value: number): void {
          if (shouldVirtualizeSb(this)) {
            const state = ensureVirtualSourceBuffer(this);
            if (
              typeof value === 'number' &&
              Number.isFinite(value) &&
              value >= 0 &&
              value < state.appendWindowEnd
            ) {
              state.appendWindowStart = value;
            }
            return;
          }
          sbAppendWindowStartDesc.set?.call(this, value);
        },
      });
    }

    if (sbAppendWindowEndDesc?.get !== undefined) {
      Object.defineProperty(sbProto, 'appendWindowEnd', {
        configurable: true,
        enumerable: true,
        get(this: SourceBuffer): number {
          if (shouldVirtualizeSb(this)) {
            return ensureVirtualSourceBuffer(this).appendWindowEnd;
          }
          return Number(sbAppendWindowEndDesc.get?.call(this));
        },
        set(this: SourceBuffer, value: number): void {
          if (shouldVirtualizeSb(this)) {
            const state = ensureVirtualSourceBuffer(this);
            if (
              typeof value === 'number' &&
              !Number.isNaN(value) &&
              value > state.appendWindowStart
            ) {
              state.appendWindowEnd = value;
            }
            return;
          }
          sbAppendWindowEndDesc.set?.call(this, value);
        },
      });
    }

    if (sbModeDesc?.get !== undefined) {
      Object.defineProperty(sbProto, 'mode', {
        configurable: true,
        enumerable: true,
        get(this: SourceBuffer): AppendMode {
          if (shouldVirtualizeSb(this)) {
            return ensureVirtualSourceBuffer(this).mode;
          }
          return (sbModeDesc.get?.call(this) as AppendMode | undefined) ?? 'segments';
        },
        set(this: SourceBuffer, value: AppendMode): void {
          if (shouldVirtualizeSb(this)) {
            if (value === 'segments' || value === 'sequence') {
              ensureVirtualSourceBuffer(this).mode = value;
            }
            return;
          }
          sbModeDesc.set?.call(this, value);
        },
      });
    }
  }

  const registry: MseVirtualizerRegistry = {
    resolveMediaSourceForBlobUrl(blobUrl: string): MediaSource | undefined {
      const ref = mediaSourceByBlobUrl.get(blobUrl);
      if (ref === undefined) {
        return undefined;
      }
      const ms = ref.deref();
      if (ms === undefined) {
        mediaSourceByBlobUrl.delete(blobUrl);
      }
      return ms;
    },
    bindElementMediaSource(
      element: EventTarget,
      blobUrl: string,
    ): MediaSource | undefined {
      const ms = this.resolveMediaSourceForBlobUrl(blobUrl);
      if (ms !== undefined) {
        elementMediaSources.set(element, ms);
      }
      return ms;
    },
  };

  installedMseSingleton = {
    setHost(nextHost: MseVirtualizerHost): void {
      currentHost = nextHost;
    },
    registry,
  };

  return registry;
}
