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
  createIsolatedWorldNonceBridge,
  generateHexNonce128,
  generateInaudibleKeepaliveWavBytes,
  KEEPALIVE_DURATION_SECONDS,
  KEEPALIVE_SAMPLE_RATE_HZ,
  MaestroVirtualizerController,
  parseOAuthTokenFromAuthorizationHeader,
  parseOAuthTokenFromCookieString,
  promoteSoundCloudLocalSettingsToHq,
  SeekDebouncer,
  SOUNDCLOUD_LOCAL_SETTINGS_KEY,
  SoundCloudSessionObserver,
  SoundCloudTrackCatalog,
  type IsolatedToMainMessage,
  type MainToIsolatedMessage,
  type MinimalKeyValueStorage,
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

function makePlayableTrackPayload(trackId: string, title: string): Record<string, unknown> {
  return {
    id: Number(trackId),
    title,
    permalink_url: `https://soundcloud.com/synthetic-artist/track-${trackId}`,
    full_duration: 210_000,
    duration: 210_000,
    artwork_url: `https://i1.sndcdn.com/artworks-synthetic-${trackId}-large.jpg`,
    waveform_url: `https://wis.sndcdn.com/synthetic-${trackId}_m.json`,
    track_authorization: `synthetic_test_track_auth_${trackId}`,
    user: { username: 'Synthetic Artist' },
    media: {
      transcodings: [
        {
          url: `https://api-v2.soundcloud.com/media/soundcloud:tracks:${trackId}/abr/stream/hls`,
          preset: 'abr_hq',
          duration: 210_000,
          quality: 'hq',
          format: { protocol: 'hls', mime_type: 'audio/mp4; codecs="mp4a.40.2"' },
        },
        {
          url: `https://api-v2.soundcloud.com/media/soundcloud:tracks:${trackId}/sq-mp3/stream/hls`,
          preset: 'mp3_1_0',
          duration: 210_000,
          quality: 'sq',
          format: { protocol: 'hls', mime_type: 'audio/mpeg' },
        },
        {
          url: `https://api-v2.soundcloud.com/media/soundcloud:tracks:${trackId}/hq-aac/stream/encrypted-hls`,
          preset: 'aac_256k',
          duration: 210_000,
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

afterEach(() => {
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
    expect(controller.getBufferedTimeRanges().end(0)).toBe(55);
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
    controller.interceptSeekSeconds(mediaEl, 60);
    vi.advanceTimersByTime(100);
    controller.interceptSeekSeconds(mediaEl, 75);
    vi.advanceTimersByTime(100);
    controller.interceptSeekSeconds(mediaEl, 92.4);

    // Still inside 180 ms HEOS debounce window -> zero seek commands sent yet, optimistic pin active!
    expect(outboundMessages).toHaveLength(0);
    expect(controller.getSeeking()).toBe(true);
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
    expect(controller.getSeeking()).toBe(true);

    // Acked state_tick (lastAckedCommandSeq = 2 >= 2) settles seek pin cleanly!
    controller.handleIsolatedMessage({
      type: 'telemetry_tick',
      lastAckedCommandSeq: 2,
      telemetry: makeTelemetry({ positionMs: 92_600, durationMs: 210_000, bufferedMs: 110_000 }),
    });
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
