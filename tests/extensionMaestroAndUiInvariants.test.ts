import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HEOS_SEEK_DEBOUNCE_MS,
  PROTOCOL_VERSION,
  TOSLINK_SEEK_DEBOUNCE_MS,
  type PlaybackTelemetry,
} from '@soundclud/protocol';
import {
  attachMainWorldNonceBridge,
  BRIDGE_BOOTSTRAP_ATTR,
  BRIDGE_BOOTSTRAP_EVENT,
  createInMemoryStorageArea,
  createIsolatedWorldNonceBridge,
  ExtensionBackgroundCoordinator,
  generateHexNonce128,
  generateInaudibleKeepaliveWavBytes,
  installMediaPrototypeHooks,
  KEEPALIVE_DURATION_SECONDS,
  KEEPALIVE_SAMPLE_RATE_HZ,
  MaestroVirtualizerController,
  parseOAuthTokenFromAuthorizationHeader,
  parseOAuthTokenFromCookieString,
  promoteSoundCloudLocalSettingsToHq,
  readEphemeralSessionState,
  SeekDebouncer,
  SOUNDCLOUD_LOCAL_SETTINGS_KEY,
  SoundCloudSessionObserver,
  SoundCloudTrackCatalog,
  updateDurableLocalConfig,
  updateEphemeralSessionState,
  type DomTrackHint,
  type IsolatedToMainMessage,
  type MainToIsolatedMessage,
  type MinimalKeyValueStorage,
  type NativeMediaBridge,
} from '@soundclud/extension';

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CURRENT_DIR, '..');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

class InMemoryKeyValueStorage implements MinimalKeyValueStorage {
  private readonly map = new Map<string, string>();

  public getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }

  public setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

class SyntheticRootElement {
  private readonly attrs = new Map<string, string>();

  public getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  public setAttribute(name: string, value: string): void {
    this.attrs.set(name, value);
  }

  public removeAttribute(name: string): void {
    this.attrs.delete(name);
  }

  public asElement(): Element {
    return this as unknown as Element;
  }
}

function makeTelemetry(
  overrides?: Partial<PlaybackTelemetry>,
): PlaybackTelemetry {
  return {
    protocolVersion: PROTOCOL_VERSION,
    serverSeq: 1,
    phase: 'playing',
    activeOutputId: 'coreaudio/spdf',
    activeBackend: 'coreaudio',
    volumeMode: 'bit_perfect',
    fixedGainDb: 0,
    sampleRateHz: 44100,
    bitDepth: 24,
    positionMs: 10_000,
    durationMs: 200_000,
    bufferedMs: 30_000,
    timestampMs: 1_700_000_000_000,
    ...overrides,
  };
}

function makePlayableTrackPayload(
  trackId: string,
  title: string,
  durationMs = 210_000,
): Record<string, unknown> {
  return {
    id: Number(trackId),
    title,
    permalink_url: `https://soundcloud.com/synthetic-artist/track-${trackId}`,
    full_duration: durationMs,
    duration: durationMs,
    artwork_url: `https://i1.sndcdn.com/artworks-synthetic-${trackId}-large.jpg`,
    waveform_url: `https://wis.sndcdn.com/synthetic-${trackId}_m.json`,
    track_authorization: `synthetic_test_track_auth_${trackId}`,
    user: { username: 'Synthetic Artist' },
    media: {
      transcodings: [
        {
          url: `https://api-v2.soundcloud.com/media/soundcloud:tracks:${trackId}/abr/stream/hls`,
          preset: 'abr_hq',
          duration: durationMs,
          quality: 'hq',
          format: { protocol: 'hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' },
        },
        {
          url: `https://api-v2.soundcloud.com/media/soundcloud:tracks:${trackId}/sq-mp3/stream/hls`,
          preset: 'mp3_1_0',
          duration: durationMs,
          quality: 'sq',
          format: { protocol: 'hls', mime_type: 'audio/mpeg' },
        },
        {
          url: `https://api-v2.soundcloud.com/media/soundcloud:tracks:${trackId}/hq-aac/stream/encrypted-hls`,
          preset: 'aac_256k',
          duration: durationMs,
          quality: 'hq',
          format: { protocol: 'encrypted-hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' },
        },
      ],
    },
  };
}

function makeCencOnlyTrackPayload(trackId: string, title: string): Record<string, unknown> {
  return {
    id: Number(trackId),
    title,
    permalink_url: `https://soundcloud.com/synthetic-label/cenc-${trackId}`,
    full_duration: 195_000,
    duration: 195_000,
    user: { username: 'Synthetic Major Label' },
    media: {
      transcodings: [
        {
          url: `https://api-v2.soundcloud.com/media/soundcloud:tracks:${trackId}/cenc-hq/stream/ctr-encrypted-hls`,
          preset: 'aac_256k',
          duration: 195_000,
          snipped: false,
          quality: 'hq',
          format: {
            protocol: 'ctr-encrypted-hls',
            mime_type: 'audio/mp4; codecs="mp4a.40.2"',
          },
        },
        {
          url: `https://api-v2.soundcloud.com/media/soundcloud:tracks:${trackId}/preview/stream/hls`,
          preset: 'mp3_1_0',
          duration: 30_000,
          snipped: true,
          quality: 'sq',
          format: { protocol: 'hls', mime_type: 'audio/mpeg' },
        },
      ],
    },
  };
}

let activeMediaGlobalsTeardown: (() => void) | null = null;

interface SyntheticBrowserMediaHarness {
  createAudioElement(): HTMLMediaElement & {
    nativePlayCalls: number;
    nativePauseCalls: number;
    nativeLoadCalls: number;
  };
  createMediaSource(): MediaSource;
  teardown(): void;
}

/**
 * Installs strict W3C `HTMLMediaElement`, `MediaSource`, `SourceBuffer`, and
 * `URL.createObjectURL` prototypes in Node where every unvirtualized C++ MSE
 * mutator throws `InvalidStateError` against an empty pipeline—matching real
 * Chromium `HLSMSEPlayer` / `hls.js` failure modes.
 */
function installSyntheticBrowserMediaGlobals(): SyntheticBrowserMediaHarness {
  activeMediaGlobalsTeardown?.();

  const globalRecord = globalThis as unknown as Record<string, unknown>;
  const prevHTMLMediaElement = globalRecord['HTMLMediaElement'];
  const prevMediaSource = globalRecord['MediaSource'];
  const prevSourceBuffer = globalRecord['SourceBuffer'];

  const urlRecord = URL as unknown as Record<string, unknown>;
  const origCreateObjectURL = URL.createObjectURL.bind(URL);
  const origRevokeObjectURL = URL.revokeObjectURL.bind(URL);
  delete urlRecord['__soundcludMsePatchedV1'];

  const throwInvalidState = (op: string): never => {
    throw new DOMException(
      `Empty native C++ MSE pipeline rejected ${op}`,
      'InvalidStateError',
    );
  };

  class HostileNativeSourceBuffer extends EventTarget {
    public appendBuffer(_data: BufferSource): void {
      throwInvalidState('SourceBuffer.appendBuffer');
    }

    public remove(_start: number, _end: number): void {
      throwInvalidState('SourceBuffer.remove');
    }

    public abort(): void {
      throwInvalidState('SourceBuffer.abort');
    }

    public get buffered(): TimeRanges {
      return throwInvalidState('SourceBuffer.buffered');
    }

    public get updating(): boolean {
      return throwInvalidState('SourceBuffer.updating');
    }

    public get timestampOffset(): number {
      return throwInvalidState('SourceBuffer.timestampOffset get');
    }

    public set timestampOffset(_v: number) {
      throwInvalidState('SourceBuffer.timestampOffset set');
    }

    public get appendWindowStart(): number {
      return throwInvalidState('SourceBuffer.appendWindowStart get');
    }

    public set appendWindowStart(_v: number) {
      throwInvalidState('SourceBuffer.appendWindowStart set');
    }

    public get appendWindowEnd(): number {
      return throwInvalidState('SourceBuffer.appendWindowEnd get');
    }

    public set appendWindowEnd(_v: number) {
      throwInvalidState('SourceBuffer.appendWindowEnd set');
    }

    public get mode(): AppendMode {
      return throwInvalidState('SourceBuffer.mode get');
    }

    public set mode(_v: AppendMode) {
      throwInvalidState('SourceBuffer.mode set');
    }
  }

  class HostileNativeMediaSource extends EventTarget {
    public addSourceBuffer(_type: string): SourceBuffer {
      return new HostileNativeSourceBuffer() as unknown as SourceBuffer;
    }

    public removeSourceBuffer(_sb: SourceBuffer): void {
      throwInvalidState('MediaSource.removeSourceBuffer');
    }

    public endOfStream(_error?: EndOfStreamError): void {
      throwInvalidState('MediaSource.endOfStream');
    }

    public get duration(): number {
      return Number.NaN;
    }

    public set duration(_v: number) {
      throwInvalidState('MediaSource.duration set');
    }

    public get readyState(): ReadyState {
      return 'open';
    }
  }

  class SyntheticDomMediaElement extends EventTarget {
    public nativePlayCalls = 0;
    public nativePauseCalls = 0;
    public nativeLoadCalls = 0;

    private nativeSrc = '';
    private nativeCurrentTime = 0;
    private nativeDuration = Number.NaN;
    private nativePaused = true;
    private nativeSeeking = false;
    private nativeEnded = false;
    private nativeReadyState = 0;
    private nativeVolume = 1;
    private nativeMuted = false;

    public play(): Promise<void> {
      this.nativePlayCalls += 1;
      this.nativePaused = false;
      return Promise.resolve();
    }

    public pause(): void {
      this.nativePauseCalls += 1;
      this.nativePaused = true;
    }

    public load(): void {
      this.nativeLoadCalls += 1;
      this.nativeCurrentTime = 0;
    }

    public removeAttribute(qualifiedName: string): void {
      if (qualifiedName.toLowerCase() === 'src') {
        this.nativeSrc = '';
      }
    }

    public setAttribute(qualifiedName: string, value: string): void {
      if (qualifiedName.toLowerCase() === 'src') {
        this.nativeSrc = value;
      }
    }

    public get currentSrc(): string {
      return this.nativeSrc;
    }

    public get src(): string {
      return this.nativeSrc;
    }

    public set src(value: string) {
      this.nativeSrc = value;
    }

    public get currentTime(): number {
      return this.nativeCurrentTime;
    }

    public set currentTime(value: number) {
      this.nativeCurrentTime = value;
    }

    public get duration(): number {
      return this.nativeDuration;
    }

    public get paused(): boolean {
      return this.nativePaused;
    }

    public get seeking(): boolean {
      return this.nativeSeeking;
    }

    public get ended(): boolean {
      return this.nativeEnded;
    }

    public get readyState(): number {
      return this.nativeReadyState;
    }

    public get buffered(): TimeRanges {
      return {
        length: 0,
        start(): number {
          throw new DOMException('Empty native TimeRanges', 'IndexSizeError');
        },
        end(): number {
          throw new DOMException('Empty native TimeRanges', 'IndexSizeError');
        },
      };
    }

    public get volume(): number {
      return this.nativeVolume;
    }

    public set volume(value: number) {
      this.nativeVolume = value;
    }

    public get muted(): boolean {
      return this.nativeMuted;
    }

    public set muted(value: boolean) {
      this.nativeMuted = value;
    }
  }

  let objectUrlSeq = 0;
  const revokedUrls = new Set<string>();
  URL.createObjectURL = ((obj: Blob | MediaSource): string => {
    if (obj instanceof HostileNativeMediaSource) {
      objectUrlSeq += 1;
      return `blob:https://soundcloud.com/synthetic-mse-${String(objectUrlSeq)}`;
    }
    return origCreateObjectURL(obj as Blob);
  }) as typeof URL.createObjectURL;

  URL.revokeObjectURL = ((url: string): void => {
    revokedUrls.add(url);
    if (!url.startsWith('blob:https://soundcloud.com/synthetic-mse-')) {
      origRevokeObjectURL(url);
    }
  }) as typeof URL.revokeObjectURL;

  globalRecord['SourceBuffer'] = HostileNativeSourceBuffer;
  globalRecord['MediaSource'] = HostileNativeMediaSource;
  globalRecord['HTMLMediaElement'] = SyntheticDomMediaElement;

  const teardown = (): void => {
    delete urlRecord['__soundcludMsePatchedV1'];
    URL.createObjectURL = origCreateObjectURL;
    URL.revokeObjectURL = origRevokeObjectURL;
    if (prevSourceBuffer === undefined) delete globalRecord['SourceBuffer'];
    else globalRecord['SourceBuffer'] = prevSourceBuffer;
    if (prevMediaSource === undefined) delete globalRecord['MediaSource'];
    else globalRecord['MediaSource'] = prevMediaSource;
    if (prevHTMLMediaElement === undefined) delete globalRecord['HTMLMediaElement'];
    else globalRecord['HTMLMediaElement'] = prevHTMLMediaElement;
    if (activeMediaGlobalsTeardown === teardown) {
      activeMediaGlobalsTeardown = null;
    }
  };

  activeMediaGlobalsTeardown = teardown;

  return {
    createAudioElement: () =>
      new SyntheticDomMediaElement() as unknown as HTMLMediaElement & {
        nativePlayCalls: number;
        nativePauseCalls: number;
        nativeLoadCalls: number;
      },
    createMediaSource: () => new HostileNativeMediaSource() as unknown as MediaSource,
    teardown,
  };
}

afterEach(() => {
  activeMediaGlobalsTeardown?.();
  vi.useRealTimers();
});

describe('@soundclud/extension — SoundCloudSessionObserver & HQ LocalSettings Promotion', () => {
  it('extracts clientId, cookie/header OAuth tokens, mid-session JWT rotations, and accountTier transitions', () => {
    const storage = new InMemoryKeyValueStorage();
    storage.setItem(
      SOUNDCLOUD_LOCAL_SETTINGS_KEY,
      JSON.stringify({ volume: 0.75, streamingQuality: null, autoPlay: true }),
    );

    const observer = new SoundCloudSessionObserver(storage);
    const observedSnapshots: string[] = [];
    observer.subscribe((snap) => {
      observedSnapshots.push(`${snap.accountTier}:${snap.clientId}:${snap.oauthToken ?? 'none'}`);
    });

    // 1. Unauthenticated hydration -> anonymous
    observer.ingestHydration([{ hydratable: 'apiClient', data: { id: 'cid_initial_01' } }]);
    expect(observer.getSnapshot()).toEqual({
      clientId: 'cid_initial_01',
      oauthToken: undefined,
      accountTier: 'anonymous',
      hasHqAudioFeature: false,
      hasAuthenticatedUser: false,
    });

    // Rejects non-SoundCloud API CDN URLs
    expect(
      observer.observeApiRequest(
        'https://cf-hls-media.sndcdn.com/playlist.m3u8?client_id=evil_cid',
        { Authorization: 'OAuth synthetic_test_should_never_ingest' },
      ),
    ).toBe(false);
    expect(observer.getSnapshot().clientId).toBe('cid_initial_01');

    // 2. Cookie authentication -> free tier
    const cookieTok = 'synthetic_test_cookie_oauth_v1';
    expect(parseOAuthTokenFromCookieString(`foo=1; oauth_token="${cookieTok}"; bar=2`)).toBe(
      cookieTok,
    );
    observer.observeCookieString(`sc_anon=1; oauth_token=${cookieTok}`);
    expect(observer.getSnapshot().accountTier).toBe('free');
    expect(observer.getSnapshot().oauthToken).toBe(cookieTok);

    // 3. Authorization: OAuth header + mid-session JWT rotation (`TokenExpiryManager`)
    const jwtV1 = 'eyJhbGciOiJIUzI1NiJ9.synthetic_test_jwt_v1.sig';
    const jwtV2 = 'eyJhbGciOiJIUzI1NiJ9.synthetic_test_jwt_rotated_v2.sig';
    expect(parseOAuthTokenFromAuthorizationHeader(`OAuth ${jwtV1}`)).toBe(jwtV1);

    observer.observeApiRequest(
      'https://api-v2.soundcloud.com/me?client_id=cid_rotated_02',
      { Authorization: `OAuth ${jwtV1}` },
    );
    expect(observer.getSnapshot().clientId).toBe('cid_rotated_02');
    expect(observer.getSnapshot().oauthToken).toBe(jwtV1);

    observer.observeApiRequest('https://api-v2.soundcloud.com/tracks/100', [
      ['authorization', `OAuth ${jwtV2}`],
    ]);
    expect(observer.getSnapshot().oauthToken).toBe(jwtV2);

    // 4. Go+ `"hq_audio"` feature detection + automatic V2::local::settings promotion
    observer.ingestUserOrSessionPayload(
      { features: ['hq_audio', 'offline_sync'] },
      'https://api-v2.soundcloud.com/me',
    );
    expect(observer.getSnapshot().accountTier).toBe('go_plus');
    expect(observer.getSnapshot().hasHqAudioFeature).toBe(true);

    const promotedRaw = storage.getItem(SOUNDCLOUD_LOCAL_SETTINGS_KEY);
    expect(promotedRaw).not.toBeNull();
    const promotedSettings: unknown = JSON.parse(promotedRaw ?? '{}');
    expect(promotedSettings).toEqual({
      volume: 0.75,
      streamingQuality: 'hq',
      autoPlay: true,
    });
    expect(observedSnapshots.length).toBeGreaterThanOrEqual(4);
  });

  it('preserves explicit non-null user streamingQuality settings in promoteSoundCloudLocalSettingsToHq', () => {
    const explicitSqStorage = new InMemoryKeyValueStorage();
    explicitSqStorage.setItem(
      SOUNDCLOUD_LOCAL_SETTINGS_KEY,
      JSON.stringify({ streamingQuality: 'sq', repeat: 'one' }),
    );

    expect(promoteSoundCloudLocalSettingsToHq(explicitSqStorage, true)).toBe(false);
    expect(JSON.parse(explicitSqStorage.getItem(SOUNDCLOUD_LOCAL_SETTINGS_KEY) ?? '{}')).toEqual({
      streamingQuality: 'sq',
      repeat: 'one',
    });

    const emptyStorage = new InMemoryKeyValueStorage();
    expect(promoteSoundCloudLocalSettingsToHq(emptyStorage, false)).toBe(false);
    expect(emptyStorage.getItem(SOUNDCLOUD_LOCAL_SETTINGS_KEY)).toBeNull();

    expect(promoteSoundCloudLocalSettingsToHq(emptyStorage, true)).toBe(true);
    expect(JSON.parse(emptyStorage.getItem(SOUNDCLOUD_LOCAL_SETTINGS_KEY) ?? '{}')).toEqual({
      streamingQuality: 'hq',
    });
  });
});

describe('@soundclud/extension — SoundCloudTrackCatalog', () => {
  it('indexes nested hydration + api-v2 payloads and constructs Go+ aac_256k StreamLocatorPayloads', () => {
    let hqSeenCallbacks = 0;
    const catalog = new SoundCloudTrackCatalog({
      onHqTranscodingSeen: () => {
        hqSeenCallbacks += 1;
      },
    });

    const hydrationPayload = [
      {
        hydratable: 'playlist',
        data: {
          id: 555,
          tracks: [makePlayableTrackPayload('101', 'Hydrated Track One')],
        },
      },
    ];
    expect(catalog.ingestPayload(hydrationPayload)).toBe(1);

    const apiCollectionPayload = {
      collection: [
        {
          track: {
            ...makePlayableTrackPayload('202', 'Private Secret Link Track'),
            permalink_url: 'https://soundcloud.com/synthetic-artist/private-track/s-secTok99',
          },
        },
      ],
    };
    expect(
      catalog.ingestPayload(
        apiCollectionPayload,
        'https://api-v2.soundcloud.com/stream?client_id=cid_synthetic_1',
      ),
    ).toBe(1);
    expect(catalog.size).toBe(2);
    expect(hqSeenCallbacks).toBe(2);

    // Record an SQ resolve in-tab on track 101 -> must NOT attach initialPlaylistUrl onto HQ!
    catalog.recordResolvedStreamUrl(
      'https://api-v2.soundcloud.com/media/soundcloud:tracks:101/sq-mp3/stream/hls?client_id=cid_1',
      'https://cf-hls-media.sndcdn.com/sq-101.m3u8',
    );

    const session = {
      clientId: 'cid_synthetic_1',
      oauthToken: 'synthetic_test_oauth_go_plus',
      accountTier: 'go_plus' as const,
      hasHqAudioFeature: true,
      hasAuthenticatedUser: true,
    };

    const res101 = catalog.buildLocatorForTrack('101', session, 4_200);
    expect(res101.kind).toBe('playable');
    if (res101.kind !== 'playable') {
      throw new Error('Expected playable locator for track 101');
    }
    expect(res101.locator.selected.preset).toBe('aac_256k');
    expect(res101.locator.selected.quality).toBe('hq');
    expect(res101.locator.selected.bitrateKbps).toBe(256);
    expect(res101.locator.selected.initialPlaylistUrl).toBeUndefined();
    expect(res101.locator.fallbackTranscodings.map((t) => t.preset)).toEqual(['mp3_1_0']);
    expect(res101.locator.startPositionMs).toBe(4_200);

    // Record an HQ resolve in-tab on track 202 -> MUST attach initialPlaylistUrl + secretToken!
    catalog.recordResolvedStreamUrl(
      'https://api-v2.soundcloud.com/media/soundcloud:tracks:202/hq-aac/stream/encrypted-hls?client_id=cid_1',
      'https://cf-hls-media.sndcdn.com/hq-202.m3u8',
    );
    const res202 = catalog.buildLocatorForTrack('202', session, 0);
    expect(res202.kind).toBe('playable');
    if (res202.kind !== 'playable') {
      throw new Error('Expected playable locator for track 202');
    }
    expect(res202.locator.selected.initialPlaylistUrl).toBe(
      'https://cf-hls-media.sndcdn.com/hq-202.m3u8',
    );
    expect(res202.locator.auth.secretToken).toBe('s-secTok99');
    expect(res202.locator.auth.trackAuthorization).toBe('synthetic_test_track_auth_202');
  });
});

describe('@soundclud/extension — MaestroVirtualizerController, SeekDebouncer & Widevine Fallback', () => {
  it('suppresses local audio, mirrors telemetry, debounces scrubs (60ms vs 180ms), pins optimistic seeks, refreshes expired locators, and enforces 0 dB volume invariance', () => {
    vi.useFakeTimers();

    const catalog = new SoundCloudTrackCatalog();
    catalog.ingestPayload(makePlayableTrackPayload('301', 'Bit-Perfect Test Track'));

    const observer = new SoundCloudSessionObserver();
    observer.ingestHydration([{ hydratable: 'apiClient', data: { id: 'cid_maestro_test' } }]);
    observer.observeApiRequest('https://api-v2.soundcloud.com/me', {
      Authorization: 'OAuth synthetic_test_token_maestro_1',
    });

    const outboundMessages: MainToIsolatedMessage[] = [];
    let pausedNativeCount = 0;

    const controller = new MaestroVirtualizerController({
      catalog,
      sessionObserver: observer,
      sendToIsolated: (msg) => {
        outboundMessages.push(msg);
      },
      nativeBridge: {
        pauseElement: () => {
          pausedNativeCount += 1;
        },
        getNativeCurrentTimeSeconds: () => 0,
        getNativePaused: () => true,
      },
    });

    // Enable handoff via TOSLINK (60 ms seek debounce)
    controller.handleIsolatedMessage({
      type: 'sync_runtime_state',
      handoffEnabled: true,
      seekDebounceMs: TOSLINK_SEEK_DEBOUNCE_MS,
      connectionState: 'connected',
      lastAckedCommandSeq: 0,
    });
    expect(controller.getSeekDebounceMs()).toBe(60);

    const mediaEl = new EventTarget();
    const endedEvents: Event[] = [];
    mediaEl.addEventListener('ended', (ev) => endedEvents.push(ev));

    const playOutcome = controller.interceptPlay(mediaEl);
    expect(playOutcome.handledRemotely).toBe(true);
    expect(pausedNativeCount).toBe(1);
    expect(controller.getMode()).toBe('remote');
    expect(outboundMessages[0]?.type).toBe('request_load_track');

    // Mirror telemetry tick
    controller.handleIsolatedMessage({
      type: 'telemetry_tick',
      lastAckedCommandSeq: 1,
      telemetry: makeTelemetry({
        positionMs: 25_000,
        durationMs: 210_000,
        bufferedMs: 55_000,
        phase: 'playing',
      }),
    });
    expect(controller.getCurrentTimeSeconds()).toBe(25);
    expect(controller.getDurationSeconds(0)).toBe(210);
    expect(controller.getBufferedTimeRanges().end(0)).toBe(210);
    expect(controller.getPaused()).toBe(false);

    // Switch active output to HEOS Direct (180 ms seek debounce) & perform rapid waveform scrub
    controller.handleIsolatedMessage({
      type: 'sync_runtime_state',
      handoffEnabled: true,
      seekDebounceMs: HEOS_SEEK_DEBOUNCE_MS,
      connectionState: 'connected',
      lastAckedCommandSeq: 1,
    });
    expect(controller.getSeekDebounceMs()).toBe(180);

    outboundMessages.length = 0;
    controller.recordUserInteraction();
    controller.interceptSeekSeconds(mediaEl, 60);
    vi.advanceTimersByTime(100);
    controller.recordUserInteraction();
    controller.interceptSeekSeconds(mediaEl, 75);
    vi.advanceTimersByTime(100);
    controller.recordUserInteraction();
    controller.interceptSeekSeconds(mediaEl, 92.4);

    // Still inside 180 ms HEOS debounce window -> zero seek commands sent yet, optimistic pin active!
    expect(outboundMessages).toHaveLength(0);
    expect(controller.isSeekPendingAck()).toBe(true);
    expect(controller.getCurrentTimeSeconds()).toBe(92.4);

    vi.advanceTimersByTime(180);
    expect(outboundMessages).toHaveLength(1);
    const seekMsg = outboundMessages[0];
    expect(seekMsg).toEqual({
      type: 'request_seek',
      commandSeq: 2,
      positionMs: 92_400,
    });

    // Stale state_tick (lastAckedCommandSeq = 1 < 2) MUST NOT unpin optimistic 92.4s position!
    controller.handleIsolatedMessage({
      type: 'telemetry_tick',
      lastAckedCommandSeq: 1,
      telemetry: makeTelemetry({ positionMs: 26_000, durationMs: 210_000, bufferedMs: 56_000 }),
    });
    expect(controller.getCurrentTimeSeconds()).toBe(92.4);
    expect(controller.isSeekPendingAck()).toBe(true);
    expect(controller.getSeeking()).toBe(false);

    // Acked state_tick (lastAckedCommandSeq = 2 >= 2) settles seek pin cleanly!
    controller.handleIsolatedMessage({
      type: 'telemetry_tick',
      lastAckedCommandSeq: 2,
      telemetry: makeTelemetry({ positionMs: 92_600, durationMs: 210_000, bufferedMs: 110_000 }),
    });
    expect(controller.isSeekPendingAck()).toBe(false);
    expect(controller.getSeeking()).toBe(false);
    expect(controller.getCurrentTimeSeconds()).toBe(92.6);

    // Mid-mix HLS 403 refresh_locator_request -> refresh_locator_result with rotated token
    outboundMessages.length = 0;
    observer.observeApiRequest('https://api-v2.soundcloud.com/me', {
      Authorization: 'OAuth synthetic_test_token_maestro_rotated_2',
    });
    controller.handleIsolatedMessage({
      type: 'refresh_locator_request',
      requestId: 'rfr_403_midmix',
      trackId: '301',
      locatorId: 'loc-old',
      reason: 'upstream_403',
    });
    expect(outboundMessages).toHaveLength(1);
    const refreshMsg = outboundMessages[0];
    expect(refreshMsg?.type).toBe('refresh_locator_result');
    if (refreshMsg?.type === 'refresh_locator_result') {
      expect(refreshMsg.requestId).toBe('rfr_403_midmix');
      expect(refreshMsg.locator?.auth.oauthToken).toBe(
        'synthetic_test_token_maestro_rotated_2',
      );
      expect(refreshMsg.locator?.startPositionMs).toBe(92_600);
    }

    // 0 dB Amp-Volume Invariant: UI volume/mute mutations emit ZERO remote messages!
    outboundMessages.length = 0;
    controller.recordLocalUiVolumeMutation(0.25, true);
    expect(controller.getVirtualVolume()).toBe(0.25);
    expect(controller.getVirtualMuted()).toBe(true);
    expect(outboundMessages).toHaveLength(0);

    // Track ended event marks virtual element ended and paused
    controller.handleIsolatedMessage({
      type: 'track_ended',
      trackId: '301',
      locatorId: 'any',
    });
    // Verify matching trackId triggers ended
    expect(controller.getEnded()).toBe(true);
    expect(controller.getPaused()).toBe(true);
    expect(endedEvents).toHaveLength(1);

    // Direct unit check on SeekDebouncer clamping
    const standalone = new SeekDebouncer({
      initialDebounceMs: 5,
      allocateCommandSeq: () => 1,
      onCommitSeek: () => {},
    });
    expect(standalone.getDebounceMs()).toBe(15);
    standalone.reset();

    controller.dispose();
  });

  it('plays CENC-only Widevine tracks locally (drm_local_fallback) while handoffEnabled stays true, then auto-resumes remote handoff on the next playable track', () => {
    const catalog = new SoundCloudTrackCatalog();
    catalog.ingestPayload([
      makePlayableTrackPayload('401', 'Playable Track Before DRM'),
      makeCencOnlyTrackPayload('402', 'Widevine CENC Track'),
      makePlayableTrackPayload('403', 'Playable Track After DRM'),
    ]);

    const observer = new SoundCloudSessionObserver();
    observer.ingestHydration([{ hydratable: 'apiClient', data: { id: 'cid_mixed_queue' } }]);

    const outboundMessages: MainToIsolatedMessage[] = [];
    let currentHintTrackId = '401';
    let nativePauseCalls = 0;

    const controller = new MaestroVirtualizerController({
      catalog,
      sessionObserver: observer,
      sendToIsolated: (msg) => {
        outboundMessages.push(msg);
      },
      nativeBridge: {
        pauseElement: () => {
          nativePauseCalls += 1;
        },
        getNativeCurrentTimeSeconds: () => 0,
        getNativePaused: () => true,
      },
      resolveDomTrackHint: () => ({ trackId: currentHintTrackId }),
    });

    controller.setHandoffEnabled(true);
    const mediaEl = new EventTarget();

    // 1. Track 401 plays remotely
    catalog.observeResolveAttemptUrl(
      'https://api-v2.soundcloud.com/media/soundcloud:tracks:401/hq-aac/stream/encrypted-hls',
    );
    expect(controller.interceptPlay(mediaEl).handledRemotely).toBe(true);
    expect(controller.getMode()).toBe('remote');
    expect(controller.shouldVirtualizeSourceBuffer()).toBe(true);

    // 2. Queue advances to CENC-only Track 402 -> emits request_stop(drm_local_fallback) + plays locally!
    outboundMessages.length = 0;
    currentHintTrackId = '402';
    catalog.observeResolveAttemptUrl(
      'https://api-v2.soundcloud.com/media/soundcloud:tracks:402/cenc-hq/stream/ctr-encrypted-hls',
    );
    const drmPlay = controller.interceptPlay(mediaEl);
    expect(drmPlay.handledRemotely).toBe(false);
    expect(controller.isHandoffEnabled()).toBe(true);
    expect(controller.getMode()).toBe('drm_local_fallback');
    expect(controller.isElementVirtualized(mediaEl)).toBe(false);
    expect(controller.shouldVirtualizeSourceBuffer()).toBe(false);

    expect(
      outboundMessages.some(
        (m) => m.type === 'request_stop' && m.reason === 'drm_local_fallback',
      ),
    ).toBe(true);
    expect(
      outboundMessages.some(
        (m) => m.type === 'drm_local_fallback_active' && m.trackId === '402',
      ),
    ).toBe(true);

    // 3. Queue advances to playable Track 403 -> automatically resumes remote handoff!
    outboundMessages.length = 0;
    const pausesBeforeResume = nativePauseCalls;
    currentHintTrackId = '403';
    catalog.observeResolveAttemptUrl(
      'https://api-v2.soundcloud.com/media/soundcloud:tracks:403/hq-aac/stream/encrypted-hls',
    );
    const resumePlay = controller.interceptPlay(mediaEl);
    expect(resumePlay.handledRemotely).toBe(true);
    expect(controller.isHandoffEnabled()).toBe(true);
    expect(controller.getMode()).toBe('remote');
    expect(controller.shouldVirtualizeSourceBuffer()).toBe(true);
    expect(nativePauseCalls).toBeGreaterThan(pausesBeforeResume);
    expect(outboundMessages.some((m) => m.type === 'drm_local_fallback_cleared')).toBe(true);
    expect(
      outboundMessages.some(
        (m) => m.type === 'request_load_track' && m.locator.track.trackId === '403',
      ),
    ).toBe(true);

    controller.dispose();
  });

  it('Regression Test A — virtualizes the full W3C MSE surface (appendBuffer, remove, abort, timestampOffset, appendWindowStart/End, mode, endOfStream, duration) without InvalidStateError and reports full forward buffered coverage', async () => {
    const dom = installSyntheticBrowserMediaGlobals();

    const catalog = new SoundCloudTrackCatalog();
    catalog.ingestPayload(makePlayableTrackPayload('501', 'Full MSE Virtualization Track', 300_000));

    const observer = new SoundCloudSessionObserver();
    observer.ingestHydration([{ hydratable: 'apiClient', data: { id: 'cid_mse_full' } }]);

    let nativeBridgeRef: NativeMediaBridge | null = null;
    const controller = new MaestroVirtualizerController({
      catalog,
      sessionObserver: observer,
      sendToIsolated: () => {},
      nativeBridge: {
        pauseElement: (el) => nativeBridgeRef?.pauseElement(el),
        playElement: (el) => nativeBridgeRef?.playElement?.(el),
        getNativeCurrentTimeSeconds: (el) =>
          nativeBridgeRef?.getNativeCurrentTimeSeconds(el) ?? 0,
        setNativeCurrentTimeSeconds: (el, s) =>
          nativeBridgeRef?.setNativeCurrentTimeSeconds?.(el, s),
        getNativePaused: (el) => nativeBridgeRef?.getNativePaused(el) ?? true,
      },
    });
    nativeBridgeRef = installMediaPrototypeHooks(controller);
    controller.setHandoffEnabled(true);

    const el = dom.createAudioElement();
    const ms = dom.createMediaSource();
    const blobUrl = URL.createObjectURL(ms);
    el.src = blobUrl;

    await el.play();
    expect(el.nativePlayCalls).toBe(0);
    expect(el.readyState).toBe(4);

    // Feed HEOS-style telemetry where `bufferedMs` is only `pos + 2s` (`27_000 ms` on a `300_000 ms` track)
    controller.handleIsolatedMessage({
      type: 'telemetry_tick',
      lastAckedCommandSeq: 1,
      telemetry: makeTelemetry({
        positionMs: 25_000,
        durationMs: 300_000,
        bufferedMs: 27_000,
        phase: 'playing',
      }),
    });

    const sb = ms.addSourceBuffer('audio/mp4; codecs="mp4a.40.2"');
    const sbEvents: string[] = [];
    for (const evName of ['updatestart', 'update', 'updateend', 'abort'] as const) {
      sb.addEventListener(evName, () => sbEvents.push(evName));
    }

    // 1. Properties on empty virtualized SourceBuffer & MediaSource never throw InvalidStateError
    expect(sb.updating).toBe(false);
    expect(sb.mode).toBe('segments');
    sb.mode = 'sequence';
    expect(sb.mode).toBe('sequence');
    sb.mode = 'segments';
    expect(sb.mode).toBe('segments');

    expect(sb.timestampOffset).toBe(0);
    sb.timestampOffset = 14.25;
    expect(sb.timestampOffset).toBe(14.25);

    expect(sb.appendWindowStart).toBe(0);
    expect(sb.appendWindowEnd).toBe(Number.POSITIVE_INFINITY);
    sb.appendWindowStart = 2.5;
    sb.appendWindowEnd = 295;
    expect(sb.appendWindowStart).toBe(2.5);
    expect(sb.appendWindowEnd).toBe(295);

    ms.duration = 300;
    expect(ms.duration).toBe(300);

    // 2. appendBuffer lifecycle
    sb.appendBuffer(new Uint8Array([0x00, 0x01, 0x02, 0x03]));
    expect(sb.updating).toBe(true);
    expect(sbEvents).toEqual(['updatestart']);
    await Promise.resolve();
    expect(sb.updating).toBe(false);
    expect(sbEvents).toEqual(['updatestart', 'update', 'updateend']);

    // 3. remove(0, 10) eviction lifecycle (must never throw InvalidStateError on empty native buffer!)
    sbEvents.length = 0;
    sb.remove(0, 10);
    expect(sb.updating).toBe(true);
    expect(sbEvents).toEqual(['updatestart']);
    await Promise.resolve();
    expect(sb.updating).toBe(false);
    expect(sbEvents).toEqual(['updatestart', 'update', 'updateend']);

    // 4. abort() cancels in-flight update cleanly without duplicate microtask updateend
    sbEvents.length = 0;
    sb.appendBuffer(new Uint8Array([0xaa, 0xbb]));
    expect(sb.updating).toBe(true);
    sb.abort();
    expect(sb.updating).toBe(false);
    expect(sbEvents).toEqual(['updatestart', 'abort', 'updateend']);
    await Promise.resolve();
    expect(sbEvents).toEqual(['updatestart', 'abort', 'updateend']);

    // 5. MediaSource.endOfStream() + removeSourceBuffer()
    let sourceEndedCount = 0;
    ms.addEventListener('sourceended', () => {
      sourceEndedCount += 1;
    });
    ms.endOfStream();
    expect(ms.readyState).toBe('ended');
    await Promise.resolve();
    expect(sourceEndedCount).toBe(1);
    expect(() => ms.removeSourceBuffer(sb)).not.toThrow();

    // 6. Buffered TimeRanges MUST report full forward coverage [0, >= duration],
    //    NEVER [0, pos + 2s] (27s) and NEVER bufEnd === pos (25s)!
    for (const ranges of [sb.buffered, el.buffered]) {
      expect(ranges.length).toBe(1);
      expect(ranges.start(0)).toBe(0);
      expect(ranges.end(0)).toBeGreaterThanOrEqual(300);
      expect(ranges.end(0)).not.toBe(27);
      expect(ranges.end(0)).toBeGreaterThan(el.currentTime);
    }

    URL.revokeObjectURL(blobUrl);
    controller.dispose();
  });

  it('Regression Test B — interpolates el.currentTime monotonically between 1,000 ms HEOS ticks and rejects unprompted hls.js +0.1s stall nudges', async () => {
    vi.useFakeTimers();
    const dom = installSyntheticBrowserMediaGlobals();

    let perfNowMs = 10_000;
    const advanceClockMs = (deltaMs: number): void => {
      perfNowMs += deltaMs;
      vi.advanceTimersByTime(deltaMs);
    };

    const catalog = new SoundCloudTrackCatalog();
    catalog.ingestPayload(makePlayableTrackPayload('502', 'HEOS Monotonic Playhead Track', 240_000));

    const observer = new SoundCloudSessionObserver();
    observer.ingestHydration([{ hydratable: 'apiClient', data: { id: 'cid_monotonic' } }]);

    const outboundMessages: MainToIsolatedMessage[] = [];
    let nativeBridgeRef: NativeMediaBridge | null = null;
    const controller = new MaestroVirtualizerController({
      catalog,
      sessionObserver: observer,
      sendToIsolated: (msg) => outboundMessages.push(msg),
      nowPerfMs: () => perfNowMs,
      nativeBridge: {
        pauseElement: (el) => nativeBridgeRef?.pauseElement(el),
        getNativeCurrentTimeSeconds: (el) =>
          nativeBridgeRef?.getNativeCurrentTimeSeconds(el) ?? 0,
        getNativePaused: (el) => nativeBridgeRef?.getNativePaused(el) ?? true,
      },
    });
    nativeBridgeRef = installMediaPrototypeHooks(controller);

    controller.handleIsolatedMessage({
      type: 'sync_runtime_state',
      handoffEnabled: true,
      seekDebounceMs: HEOS_SEEK_DEBOUNCE_MS,
      connectionState: 'connected',
      lastAckedCommandSeq: 0,
    });

    const el = dom.createAudioElement();
    await el.play();
    expect(outboundMessages[0]?.type).toBe('request_load_track');

    // Initial HEOS wake/loading creep prevents SoundCloud's 2.0s `_determineIfPlaying()` timeout
    const tLoad0 = el.currentTime;
    advanceClockMs(500);
    const tLoad500 = el.currentTime;
    expect(tLoad500).toBeGreaterThan(tLoad0);

    // Feed 1,000 ms stepped HEOS telemetry ticks (including an integer-second truncation repeat at +900ms)
    const sampledPositions: number[] = [];

    for (const stepSec of [10, 11, 12] as const) {
      controller.handleIsolatedMessage({
        type: 'telemetry_tick',
        lastAckedCommandSeq: 1,
        telemetry: makeTelemetry({
          activeBackend: 'heos_upnp',
          positionMs: stepSec * 1_000,
          durationMs: 240_000,
          bufferedMs: (stepSec + 2) * 1_000,
          phase: 'playing',
        }),
      });
      sampledPositions.push(el.currentTime);

      for (let q = 0; q < 3; q += 1) {
        advanceClockMs(250);
        sampledPositions.push(el.currentTime);
      }
      advanceClockMs(250);
    }

    // Verify strictly advancing sub-second playhead across every 250ms sample (prevents hls.js bufferStalledError!)
    for (let i = 1; i < sampledPositions.length; i += 1) {
      const prev = sampledPositions[i - 1] ?? 0;
      const curr = sampledPositions[i] ?? 0;
      expect(curr).toBeGreaterThan(prev);
    }

    // Feed a jittered HEOS integer-second repeat (`12_000 ms` when interpolated playhead is ~`13.0s`):
    // playhead MUST clamp monotonically and never jump backward!
    const beforeJitterSec = el.currentTime;
    controller.handleIsolatedMessage({
      type: 'telemetry_tick',
      lastAckedCommandSeq: 1,
      telemetry: makeTelemetry({
        activeBackend: 'heos_upnp',
        positionMs: 12_000,
        durationMs: 240_000,
        bufferedMs: 14_000,
        phase: 'playing',
      }),
    });
    expect(el.currentTime).toBeGreaterThanOrEqual(beforeJitterSec);

    // Unprompted synthetic `el.currentTime = el.currentTime + 0.1` (`hls.js` GapController stall nudge)
    // with NO recent `recordUserInteraction()` MUST NOT emit an outbound `request_seek`!
    advanceClockMs(2_000);
    outboundMessages.length = 0;
    const preNudgeSec = el.currentTime;
    el.currentTime = preNudgeSec + 0.1;
    advanceClockMs(500);

    expect(outboundMessages.filter((m) => m.type === 'request_seek')).toHaveLength(0);
    expect(controller.isSeekPendingAck()).toBe(false);

    controller.dispose();
  });

  it('Regression Test C — scrubs to 2,700s (45:00) on a 3,600s (1:00:00) mix with accurate async seeked currentTime, >=3,600s forward buffer, and zero snap-back to 12s', async () => {
    vi.useFakeTimers();
    const dom = installSyntheticBrowserMediaGlobals();

    let perfNowMs = 50_000;
    const advanceClockMs = (deltaMs: number): void => {
      perfNowMs += deltaMs;
      vi.advanceTimersByTime(deltaMs);
    };

    const catalog = new SoundCloudTrackCatalog();
    catalog.ingestPayload(makePlayableTrackPayload('503', 'Hour-Long DJ Mix', 3_600_000));

    const observer = new SoundCloudSessionObserver();
    observer.ingestHydration([{ hydratable: 'apiClient', data: { id: 'cid_hour_mix' } }]);

    const outboundMessages: MainToIsolatedMessage[] = [];
    let nativeBridgeRef: NativeMediaBridge | null = null;
    const controller = new MaestroVirtualizerController({
      catalog,
      sessionObserver: observer,
      sendToIsolated: (msg) => outboundMessages.push(msg),
      nowPerfMs: () => perfNowMs,
      nativeBridge: {
        pauseElement: (el) => nativeBridgeRef?.pauseElement(el),
        getNativeCurrentTimeSeconds: (el) =>
          nativeBridgeRef?.getNativeCurrentTimeSeconds(el) ?? 0,
        getNativePaused: (el) => nativeBridgeRef?.getNativePaused(el) ?? true,
      },
    });
    nativeBridgeRef = installMediaPrototypeHooks(controller);

    controller.handleIsolatedMessage({
      type: 'sync_runtime_state',
      handoffEnabled: true,
      seekDebounceMs: HEOS_SEEK_DEBOUNCE_MS,
      connectionState: 'connected',
      lastAckedCommandSeq: 0,
    });

    const el = dom.createAudioElement();
    await el.play();

    // Playing at 12s (`12_000 ms`) of a 3,600s (`1:00:00`) mix
    controller.handleIsolatedMessage({
      type: 'telemetry_tick',
      lastAckedCommandSeq: 1,
      telemetry: makeTelemetry({
        activeBackend: 'heos_upnp',
        positionMs: 12_000,
        durationMs: 3_600_000,
        bufferedMs: 14_000,
        phase: 'playing',
      }),
    });
    expect(el.currentTime).toBe(12);

    const seekingSnapshots: Array<{ currentTime: number; seeking: boolean }> = [];
    const seekedSnapshots: Array<{
      currentTime: number;
      seeking: boolean;
      bufferedEnd: number;
    }> = [];
    const timeupdatePositionsAfterScrub: number[] = [];

    el.addEventListener('seeking', () => {
      seekingSnapshots.push({ currentTime: el.currentTime, seeking: el.seeking });
    });
    el.addEventListener('seeked', () => {
      seekedSnapshots.push({
        currentTime: el.currentTime,
        seeking: el.seeking,
        bufferedEnd: el.buffered.end(0),
      });
    });
    el.addEventListener('timeupdate', () => {
      timeupdatePositionsAfterScrub.push(el.currentTime);
    });

    outboundMessages.length = 0;
    controller.recordUserInteraction();
    el.currentTime = 2700;

    // 1. Immediate synchronous read MUST be 2,700s with >= 3,600s forward buffer
    expect(el.currentTime).toBe(2700);
    expect(el.buffered.end(0)).toBeGreaterThanOrEqual(3600);
    expect(controller.isSeekPendingAck()).toBe(true);

    // 2. Async `'seeking'` and `'seeked'` fire promptly with exact ~2,700s position
    advanceClockMs(1);
    expect(seekingSnapshots).toEqual([{ currentTime: 2700, seeking: true }]);
    expect(seekedSnapshots).toHaveLength(1);
    const seekedSnap = seekedSnapshots[0];
    expect(seekedSnap).toBeDefined();
    if (seekedSnap !== undefined) {
      expect(seekedSnap.seeking).toBe(false);
      expect(Math.abs(seekedSnap.currentTime * 1000 - 2_700_000)).toBeLessThanOrEqual(100);
      expect(seekedSnap.bufferedEnd).toBeGreaterThanOrEqual(3600);
    }

    // 3. Mid-debounce pre-seek tick (`12.25s`, seq 1) MUST NOT snap `el.currentTime` back!
    advanceClockMs(50);
    controller.handleIsolatedMessage({
      type: 'telemetry_tick',
      lastAckedCommandSeq: 1,
      telemetry: makeTelemetry({
        activeBackend: 'heos_upnp',
        positionMs: 12_250,
        durationMs: 3_600_000,
        bufferedMs: 14_250,
        phase: 'playing',
      }),
    });
    expect(el.currentTime).toBe(2700);

    // Commit 180ms HEOS debounce -> emits `request_seek(2_700_000)` with `commandSeq = 2`
    advanceClockMs(150);
    expect(outboundMessages).toEqual([
      {
        type: 'request_seek',
        commandSeq: 2,
        positionMs: 2_700_000,
      },
    ]);

    // 4a. Unacked pre-seek tick (`lastAckedCommandSeq: 1 < 2`, `positionMs: 12_500`) ignored
    controller.handleIsolatedMessage({
      type: 'telemetry_tick',
      lastAckedCommandSeq: 1,
      telemetry: makeTelemetry({
        activeBackend: 'heos_upnp',
        positionMs: 12_500,
        durationMs: 3_600_000,
        bufferedMs: 14_500,
        phase: 'playing',
      }),
    });
    expect(el.currentTime).toBe(2700);

    // 4b. Early-acked tick still carrying pre-jump `12.6s` position (`|12.6s - 2700s| > 3s` proximity) stays pinned!
    controller.handleIsolatedMessage({
      type: 'telemetry_tick',
      lastAckedCommandSeq: 2,
      telemetry: makeTelemetry({
        activeBackend: 'heos_upnp',
        positionMs: 12_600,
        durationMs: 3_600_000,
        bufferedMs: 14_600,
        phase: 'playing',
      }),
    });
    expect(el.currentTime).toBe(2700);
    expect(controller.isSeekPendingAck()).toBe(true);

    // 4c. Settled post-seek tick (`lastAckedCommandSeq: 2`, `positionMs: 2_700_060`) releases pin cleanly
    //     without ANY momentary snap-back to 12s inside `onSeekSettled` `'timeupdate'` listeners!
    controller.handleIsolatedMessage({
      type: 'telemetry_tick',
      lastAckedCommandSeq: 2,
      telemetry: makeTelemetry({
        activeBackend: 'heos_upnp',
        positionMs: 2_700_060,
        durationMs: 3_600_000,
        bufferedMs: 2_702_060,
        phase: 'playing',
      }),
    });
    expect(controller.isSeekPendingAck()).toBe(false);
    expect(el.currentTime).toBeCloseTo(2700.06, 2);
    expect(el.buffered.end(0)).toBeGreaterThanOrEqual(3600);
    expect(timeupdatePositionsAfterScrub.length).toBeGreaterThan(0);
    for (const observedSec of timeupdatePositionsAfterScrub) {
      expect(observedSec).toBeGreaterThanOrEqual(2700);
    }

    controller.dispose();
  });

  it('Regression Test D — fences shared <audio> pause/src/load/play reset before /stream/hls resolves and blocks stale Track 1 paused telemetry echoes across MAIN + SW', async () => {
    vi.useFakeTimers();
    const dom = installSyntheticBrowserMediaGlobals();

    const perfNowMs = 90_000;
    const catalog = new SoundCloudTrackCatalog();
    catalog.ingestPayload([
      makePlayableTrackPayload('1001', 'Track One', 240_000),
      makePlayableTrackPayload('1002', 'Track Two', 312_000),
    ]);

    const observer = new SoundCloudSessionObserver();
    observer.ingestHydration([{ hydratable: 'apiClient', data: { id: 'cid_track_switch' } }]);

    const outboundMessages: MainToIsolatedMessage[] = [];
    let domHint: DomTrackHint | undefined = {
      permalinkOrPath: '/synthetic-artist/track-1001',
      title: 'Track One',
      isPlayerBadge: true,
    };

    let nativeBridgeRef: NativeMediaBridge | null = null;
    const controller = new MaestroVirtualizerController({
      catalog,
      sessionObserver: observer,
      sendToIsolated: (msg) => outboundMessages.push(msg),
      nowPerfMs: () => perfNowMs,
      resolveDomTrackHint: () => domHint,
      nativeBridge: {
        pauseElement: (el) => nativeBridgeRef?.pauseElement(el),
        getNativeCurrentTimeSeconds: (el) =>
          nativeBridgeRef?.getNativeCurrentTimeSeconds(el) ?? 0,
        getNativePaused: (el) => nativeBridgeRef?.getNativePaused(el) ?? true,
      },
    });
    nativeBridgeRef = installMediaPrototypeHooks(controller);
    controller.setHandoffEnabled(true);

    const el = dom.createAudioElement();
    el.src = 'blob:https://soundcloud.com/track-1';
    catalog.recordResolvedStreamUrl(
      'https://api-v2.soundcloud.com/media/soundcloud:tracks:1001/hq-aac/stream/encrypted-hls',
      'https://cf-hls-media.sndcdn.com/hq-1001.m3u8',
    );
    await el.play();
    expect(outboundMessages[0]?.type).toBe('request_load_track');

    // Track 1 reaches 45s and user pauses Track 1 (or SoundCloud pauses during transition)
    controller.handleIsolatedMessage({
      type: 'telemetry_tick',
      lastAckedCommandSeq: 1,
      telemetry: makeTelemetry({
        positionMs: 45_000,
        durationMs: 240_000,
        bufferedMs: 65_000,
        phase: 'playing',
        track: {
          trackId: '1001',
          permalinkUrl: 'https://soundcloud.com/synthetic-artist/track-1001',
          title: 'Track One',
          artist: 'Synthetic Artist',
          durationMs: 240_000,
        },
      }),
    });
    el.pause();
    expect(outboundMessages[1]).toEqual({
      type: 'request_set_paused',
      commandSeq: 2,
      paused: true,
    });
    controller.handleIsolatedMessage({
      type: 'telemetry_tick',
      lastAckedCommandSeq: 2,
      telemetry: makeTelemetry({
        positionMs: 45_000,
        durationMs: 240_000,
        bufferedMs: 65_000,
        phase: 'paused',
        track: {
          trackId: '1001',
          permalinkUrl: 'https://soundcloud.com/synthetic-artist/track-1001',
          title: 'Track One',
          artist: 'Synthetic Artist',
          durationMs: 240_000,
        },
      }),
    });
    expect(el.paused).toBe(true);
    expect(el.currentTime).toBe(45);

    // 1. User clicks Track 2: shared `<audio>` resets `pause()`, `src = 'blob:.../track-2'`,
    //    `currentTime = 0`, `load()`, `play()` BEFORE Track 2's `/stream/hls` JSON resolves
    //    and while DOM player badge STILL shows Track 1!
    outboundMessages.length = 0;
    el.pause();
    el.src = 'blob:https://soundcloud.com/track-2';
    el.currentTime = 0;
    el.load();
    await el.play();
    vi.advanceTimersByTime(250);

    // Track 1 MUST NOT be falsely resumed (`set_paused(false)`) and NO stale `seek(0)` may hit Track 1!
    expect(
      outboundMessages.filter(
        (m) => m.type === 'request_set_paused' || m.type === 'request_seek',
      ),
    ).toHaveLength(0);
    expect(outboundMessages.filter((m) => m.type === 'request_load_track')).toHaveLength(0);
    expect(el.paused).toBe(false);
    expect(el.currentTime).toBeLessThan(0.5);

    // As soon as Track 2's `/stream/hls` JSON resolves in `catalog`, `request_load_track` fires for Track 2!
    domHint = {
      permalinkOrPath: '/synthetic-artist/track-1002',
      title: 'Track Two',
      isPlayerBadge: true,
    };
    catalog.ingestPayload(
      { url: 'https://cf-hls-media.sndcdn.com/hq-1002.m3u8' },
      'https://api-v2.soundcloud.com/media/soundcloud:tracks:1002/hq-aac/stream/encrypted-hls',
    );

    const loadTrack2Messages = outboundMessages.filter(
      (m): m is Extract<MainToIsolatedMessage, { type: 'request_load_track' }> =>
        m.type === 'request_load_track',
    );
    expect(loadTrack2Messages).toHaveLength(1);
    const loadTrack2 = loadTrack2Messages[0];
    if (loadTrack2 === undefined) {
      throw new Error('Expected request_load_track for Track 2');
    }
    const loadSeq = loadTrack2.commandSeq;
    expect(loadTrack2.locator.track.trackId).toBe('1002');
    expect(loadTrack2.locator.startPositionMs).toBe(0);
    expect(el.duration).toBe(312);

    // 2. Immediately inject stale `sync_runtime_state` carrying Track 1's `paused` telemetry (`lastAckedCommandSeq < loadSeq`):
    //    `el.paused` MUST stay `false`, `el.currentTime` near `0`, and `el.duration` MUST stay `312`!
    controller.handleIsolatedMessage({
      type: 'sync_runtime_state',
      handoffEnabled: true,
      seekDebounceMs: HEOS_SEEK_DEBOUNCE_MS,
      connectionState: 'connected',
      lastAckedCommandSeq: loadSeq - 1,
      telemetry: makeTelemetry({
        phase: 'paused',
        positionMs: 45_000,
        durationMs: 240_000,
        bufferedMs: 65_000,
        track: {
          trackId: '1001',
          permalinkUrl: 'https://soundcloud.com/synthetic-artist/track-1001',
          title: 'Track One',
          artist: 'Synthetic Artist',
          durationMs: 240_000,
        },
      }),
    });
    // Also inject an unacked tick without `track` metadata (`lastAckedCommandSeq < loadSeq`)
    controller.handleIsolatedMessage({
      type: 'sync_runtime_state',
      handoffEnabled: true,
      seekDebounceMs: HEOS_SEEK_DEBOUNCE_MS,
      connectionState: 'connected',
      lastAckedCommandSeq: loadSeq - 1,
      telemetry: makeTelemetry({
        phase: 'paused',
        positionMs: 45_000,
        durationMs: 240_000,
        bufferedMs: 65_000,
      }),
    });

    expect(el.paused).toBe(false);
    expect(el.currentTime).toBeLessThan(0.5);
    expect(el.duration).toBe(312);

    // 3. Verify Background SW coordinator also optimistically replaces Track 1's paused session
    //    telemetry with Track 2 (`phase: 'loading'`, `durationMs: 312_000`) upon `request_load_track`!
    const localArea = createInMemoryStorageArea();
    const sessionArea = createInMemoryStorageArea();
    await updateDurableLocalConfig(localArea, (prev) => ({
      ...prev,
      handoffEnabled: true,
    }));
    await updateEphemeralSessionState(sessionArea, (prev) => ({
      ...prev,
      connectionState: 'connected',
      lastAckedCommandSeq: loadSeq - 1,
      lastTelemetry: makeTelemetry({
        phase: 'paused',
        positionMs: 45_000,
        durationMs: 240_000,
        track: {
          trackId: '1001',
          permalinkUrl: 'https://soundcloud.com/synthetic-artist/track-1001',
          title: 'Track One',
          artist: 'Synthetic Artist',
          durationMs: 240_000,
        },
      }),
    }));

    const bgCoordinator = new ExtensionBackgroundCoordinator({
      storage: { local: localArea, session: sessionArea },
    });
    const swResp = await bgCoordinator.handleRequest(
      { type: 'forward_main_message', message: loadTrack2 },
      77,
    );
    expect(swResp.ok).toBe(true);
    const updatedSession = await readEphemeralSessionState(sessionArea);
    expect(updatedSession.nextCommandSeq).toBe(loadSeq);
    expect(updatedSession.lastTelemetry?.phase).toBe('loading');
    expect(updatedSession.lastTelemetry?.track?.trackId).toBe('1002');
    expect(updatedSession.lastTelemetry?.positionMs).toBe(0);
    expect(updatedSession.lastTelemetry?.durationMs).toBe(312_000);

    controller.dispose();
  });
});

describe('@soundclud/extension — Media-Key Keepalive WAV & Cryptographic Nonce Bridge', () => {
  it('synthesizes a valid 44-byte RIFF/WAVE header (8,000 Hz, mono, 16-bit, 10s = 160,000 PCM bytes) with ±1 LSB samples', () => {
    const wav = generateInaudibleKeepaliveWavBytes();
    const expectedPcmBytes = KEEPALIVE_SAMPLE_RATE_HZ * KEEPALIVE_DURATION_SECONDS * 2;
    expect(expectedPcmBytes).toBe(160_000);
    expect(wav.byteLength).toBe(44 + expectedPcmBytes);

    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const ascii = (offset: number, len: number): string =>
      Buffer.from(wav.subarray(offset, offset + len)).toString('ascii');

    expect(ascii(0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
    expect(ascii(8, 4)).toBe('WAVE');
    expect(ascii(12, 4)).toBe('fmt ');
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1); // Linear PCM
    expect(view.getUint16(22, true)).toBe(1); // Mono
    expect(view.getUint32(24, true)).toBe(8000); // 8,000 Hz
    expect(view.getUint32(28, true)).toBe(16000); // ByteRate = 8000 * 1 * 2
    expect(view.getUint16(32, true)).toBe(2); // BlockAlign
    expect(view.getUint16(34, true)).toBe(16); // BitsPerSample
    expect(ascii(36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(160_000);

    // Verify alternating +1 / -1 LSB samples (-90.3 dBFS raw, -130.3 dBFS at volume=0.01)
    for (let frame = 0; frame < 64; frame += 1) {
      const sample = view.getInt16(44 + frame * 2, true);
      expect(sample).toBe(frame % 2 === 0 ? 1 : -1);
    }
    const lastSample = view.getInt16(44 + (80_000 - 1) * 2, true);
    expect(lastSample).toBe(-1);
  });

  it('completes 128-bit cryptographic nonce handshake, deletes data-soundclud-bridge-init immediately, and rejects spoofed CustomEvents', () => {
    const nonceSample = generateHexNonce128();
    expect(nonceSample).toMatch(/^[0-9a-f]{32}$/);

    const eventTarget = new EventTarget();
    const root = new SyntheticRootElement();
    const env = { eventTarget, rootElement: root.asElement() };

    const receivedInIsolated: MainToIsolatedMessage[] = [];
    const receivedInMain: IsolatedToMainMessage[] = [];

    // Spy on channel names dispatched on eventTarget to attempt spoofing attacks
    const seenEventTypes: string[] = [];
    const origDispatch = eventTarget.dispatchEvent.bind(eventTarget);
    eventTarget.dispatchEvent = (ev: Event): boolean => {
      seenEventTypes.push(ev.type);
      return origDispatch(ev);
    };

    const isolatedBridge = createIsolatedWorldNonceBridge((msg) => {
      receivedInIsolated.push(msg);
    }, env);

    // Before MAIN attaches, bootstrap attribute is staged and outbound messages queue safely
    expect(root.getAttribute(BRIDGE_BOOTSTRAP_ATTR)).not.toBeNull();
    expect(
      isolatedBridge.send({
        type: 'sync_runtime_state',
        handoffEnabled: true,
        seekDebounceMs: 60,
        connectionState: 'connected',
        lastAckedCommandSeq: 0,
      }),
    ).toBe(false);

    const mainBridge = attachMainWorldNonceBridge((msg) => {
      receivedInMain.push(msg);
    }, env);

    // Bootstrap attribute MUST be deleted immediately upon handshake!
    expect(root.getAttribute(BRIDGE_BOOTSTRAP_ATTR)).toBeNull();
    expect(isolatedBridge.isHandshakeComplete).toBe(true);
    expect(receivedInMain).toHaveLength(1);
    expect(receivedInMain[0]?.type).toBe('sync_runtime_state');

    // Attempt spoofed messages on both internal channel event names with missing/wrong nonces!
    const m2iChannel = seenEventTypes.find((t) => t.startsWith('__sc_m2i_'));
    const i2mChannel = seenEventTypes.find((t) => t.startsWith('__sc_i2m_'));
    expect(m2iChannel).toBeDefined();
    expect(i2mChannel).toBeDefined();

    if (m2iChannel !== undefined && i2mChannel !== undefined) {
      // Missing nonce
      eventTarget.dispatchEvent(
        new CustomEvent(m2iChannel, {
          detail: JSON.stringify({
            kind: 'msg',
            message: { type: 'drm_local_fallback_cleared' },
          }),
        }),
      );
      // Wrong 128-bit nonce
      eventTarget.dispatchEvent(
        new CustomEvent(m2iChannel, {
          detail: JSON.stringify({
            nonce: '0'.repeat(32),
            kind: 'msg',
            message: { type: 'drm_local_fallback_cleared' },
          }),
        }),
      );
      // Wrong nonce into MAIN world
      eventTarget.dispatchEvent(
        new CustomEvent(i2mChannel, {
          detail: JSON.stringify({
            nonce: 'f'.repeat(32),
            kind: 'msg',
            message: {
              type: 'session_claimed',
              newControllerId: 'spoof',
              newClientLabel: 'spoof',
            },
          }),
        }),
      );
      // Spoofed re-bootstrap attempt after handshake already locked
      eventTarget.dispatchEvent(
        new CustomEvent(BRIDGE_BOOTSTRAP_EVENT, {
          detail: JSON.stringify({
            nonce: 'a'.repeat(32),
            m2i: '__sc_m2i_evil',
            i2m: '__sc_i2m_evil',
          }),
        }),
      );
    }

    expect(receivedInIsolated).toHaveLength(0);
    expect(receivedInMain).toHaveLength(1);

    // Legitimate MAIN -> ISOLATED message succeeds
    expect(mainBridge.send({ type: 'drm_local_fallback_cleared' })).toBe(true);
    expect(receivedInIsolated).toEqual([{ type: 'drm_local_fallback_cleared' }]);

    mainBridge.dispose();
    isolatedBridge.dispose();
  });
});

describe('MV3 Manifest, PNG Icon IHDR & Zero-Volume-Mutation Rust Static Audit', () => {
  it('enforces Manifest V3 compliance, minimum_chrome_version "116", zero cookies permission, zero ws(s):// host_permissions, and exact PNG icon dimensions', () => {
    const manifestPath = path.join(REPO_ROOT, 'packages', 'extension', 'manifest.json');
    const rawManifest: unknown = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(typeof rawManifest === 'object' && rawManifest !== null).toBe(true);
    const manifest = rawManifest as Record<string, unknown>;

    expect(manifest['manifest_version']).toBe(3);
    expect(manifest['minimum_chrome_version']).toBe('116');

    const permissions = Array.isArray(manifest['permissions']) ? manifest['permissions'] : [];
    const optionalPermissions = Array.isArray(manifest['optional_permissions'])
      ? manifest['optional_permissions']
      : [];
    expect(permissions).not.toContain('cookies');
    expect(optionalPermissions).not.toContain('cookies');

    const hostPermissions = Array.isArray(manifest['host_permissions'])
      ? manifest['host_permissions']
      : [];
    const optionalHostPermissions = Array.isArray(manifest['optional_host_permissions'])
      ? manifest['optional_host_permissions']
      : [];
    for (const pattern of [...hostPermissions, ...optionalHostPermissions]) {
      expect(typeof pattern).toBe('string');
      expect(String(pattern)).not.toMatch(/^wss?:\/\//i);
    }

    for (const expectedSize of [16, 48, 128] as const) {
      const iconPath = path.join(
        REPO_ROOT,
        'packages',
        'extension',
        'icons',
        `icon-${String(expectedSize)}.png`,
      );
      const buf = fs.readFileSync(iconPath);
      expect(buf.length).toBeGreaterThanOrEqual(24);
      expect(buf.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      expect(buf.toString('ascii', 12, 16)).toBe('IHDR');
      const width = buf.readUInt32BE(16);
      const height = buf.readUInt32BE(20);
      expect({ expectedSize, width, height }).toEqual({
        expectedSize,
        width: expectedSize,
        height: expectedSize,
      });
    }
  });

  it('asserts ZERO set_volume (HEOS CLI) and ZERO SetVolume (UPnP RenderingControl) volume-mutation calls exist in crates/receiver/src/', () => {
    const receiverSrcRoot = path.join(REPO_ROOT, 'crates', 'receiver', 'src');
    const rustFiles: string[] = [];

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.rs')) {
          rustFiles.push(full);
        }
      }
    };
    walk(receiverSrcRoot);
    expect(rustFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];
    const forbiddenVolumePattern = /\b(?:set_volume|SetVolume)\b|heos:\/\/player\/set_volume|RenderingControl/;

    for (const filePath of rustFiles) {
      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i] ?? '';
        if (forbiddenVolumePattern.test(line)) {
          const rel = path.relative(REPO_ROOT, filePath).split(path.sep).join('/');
          violations.push(`${rel}:${String(i + 1)}`);
        }
      }
    }

    expect(violations).toEqual([]);
  });
});
