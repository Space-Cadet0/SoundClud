import { describe, expect, it } from 'vitest';
import {
  areMatchingTranscodingResolveUrls,
  BIT_PERFECT_BIT_DEPTH,
  BIT_PERFECT_GAIN_DB,
  BIT_PERFECT_SAMPLE_RATE_HZ,
  getDefaultSeekDebounceMs,
  HEOS_SEEK_DEBOUNCE_MS,
  isAllowedSoundCloudApiAuthUrl,
  isValidOutputDevice,
  isValidStreamLocatorPayload,
  parseApiErrorResponse,
  parseAudioDevicesResponse,
  parseClientWsCommand,
  parseDiscoverResponse,
  parseOutputDevice,
  parsePairRequest,
  parsePairResponse,
  parsePlaybackTelemetry,
  parseReceiverConfig,
  parseServerWsEvent,
  parseStatusResponse,
  parseStreamLocatorPayload,
  parseUpdateConfigRequest,
  parseUpdateConfigResponse,
  PROTOCOL_VERSION,
  rankSoundCloudTranscodings,
  TOSLINK_SEEK_DEBOUNCE_MS,
  type OutputDevice,
  type SoundCloudTranscoding,
  type StreamLocatorPayload,
} from '@soundclud/protocol';

function makeTranscoding(
  preset: string,
  protocol: string,
  mimeType: string,
  options?: {
    readonly url?: string;
    readonly quality?: string;
    readonly snipped?: boolean;
    readonly duration?: number;
  },
): SoundCloudTranscoding {
  return {
    url:
      options?.url ??
      `https://api-v2.soundcloud.com/media/soundcloud:tracks:9001/${preset}/stream/${protocol}`,
    preset,
    duration: options?.duration ?? 240_000,
    ...(options?.snipped !== undefined ? { snipped: options.snipped } : {}),
    format: {
      protocol,
      mime_type: mimeType,
    },
    ...(options?.quality !== undefined ? { quality: options.quality } : {}),
  };
}

function makeValidOutputDeviceFixture(): OutputDevice {
  return {
    id: 'coreaudio/spdf',
    kind: 'coreaudio',
    name: 'Built-in Digital Optical S/PDIF',
    transport: 'optical_toslink',
    isRecommendedDefault: true,
    isAvailable: true,
    capabilities: {
      bitPerfect: true,
      fixedGainDb: BIT_PERFECT_GAIN_DB,
      targetSampleRateHz: BIT_PERFECT_SAMPLE_RATE_HZ,
      targetBitDepth: BIT_PERFECT_BIT_DEPTH,
      autoWakeFromStandby: false,
      displaysTrackMetadataOnDevice: false,
      seekDebounceMs: TOSLINK_SEEK_DEBOUNCE_MS,
    },
  };
}

function makeValidStreamLocatorFixture(): StreamLocatorPayload {
  return {
    locatorId: 'loc-9001-1',
    track: {
      trackId: '9001',
      permalinkUrl: 'https://soundcloud.com/artist-synthetic/track-synthetic',
      title: 'Synthetic Reference Track',
      artist: 'Synthetic Reference Artist',
      durationMs: 240_000,
    },
    selected: {
      resolveUrl:
        'https://api-v2.soundcloud.com/media/soundcloud:tracks:9001/aac_256k/stream/hls',
      preset: 'aac_256k',
      protocol: 'hls',
      mimeType: 'audio/mp4; codecs="mp4a.40.2"',
      quality: 'hq',
      bitrateKbps: 256,
      sampleRateHz: 44100,
    },
    fallbackTranscodings: [
      {
        resolveUrl:
          'https://api-v2.soundcloud.com/media/soundcloud:tracks:9001/mp3_1_0/stream/hls',
        preset: 'mp3_1_0',
        protocol: 'hls',
        mimeType: 'audio/mpeg',
        quality: 'sq',
        bitrateKbps: 128,
        sampleRateHz: 44100,
      },
    ],
    auth: {
      clientId: 'sc_synthetic_test_client_id',
      oauthToken: 'synthetic_test_oauth_token_v1',
      trackAuthorization: 'synthetic_test_track_auth_v1',
      accountTier: 'go_plus',
    },
    startPositionMs: 0,
  };
}

describe('@soundclud/protocol — Go+ Transcoding Ranker (rankSoundCloudTranscodings)', () => {
  it('selects Go+ aac_256k (hq, 256 kbps, 44100 Hz) over all sq codecs even when sq streams appear first', () => {
    const transcodings: readonly SoundCloudTranscoding[] = [
      makeTranscoding('opus_0_0', 'hls', 'audio/ogg; codecs="opus"', { quality: 'sq' }),
      makeTranscoding('aac_96k', 'hls', 'audio/mp4; codecs="mp4a.40.2"', { quality: 'sq' }),
      makeTranscoding('mp3_1_0', 'hls', 'audio/mpeg', { quality: 'sq' }),
      makeTranscoding('aac_160k', 'hls', 'audio/mp4; codecs="mp4a.40.2"', { quality: 'sq' }),
      makeTranscoding('aac_256k', 'encrypted-hls', 'audio/mp4; codecs="mp4a.40.2"', {
        quality: 'hq',
      }),
    ];

    const result = rankSoundCloudTranscodings(transcodings);
    expect(result.kind).toBe('playable');
    if (result.kind !== 'playable') {
      throw new Error('Expected playable selection');
    }

    expect(result.selected).toEqual({
      resolveUrl:
        'https://api-v2.soundcloud.com/media/soundcloud:tracks:9001/aac_256k/stream/encrypted-hls',
      preset: 'aac_256k',
      protocol: 'encrypted-hls',
      mimeType: 'audio/mp4; codecs="mp4a.40.2"',
      quality: 'hq',
      bitrateKbps: 256,
      sampleRateHz: 44100,
    });

    expect(result.fallbacks.map((f) => f.preset)).toEqual([
      'aac_160k',
      'mp3_1_0',
      'aac_96k',
      'opus_0_0',
    ]);
    expect(result.fallbacks[3]?.sampleRateHz).toBe(48000);
  });

  it('demotes HE-AAC SBR/PS aac_160k (mp4a.40.5 / mp4a.40.29) behind mp3_1_0 while keeping Go+ aac_256k #1 and AAC-LC aac_160k ahead of mp3_1_0', () => {
    // 1. Free/SQ track where `aac_160k` is HE-AACv1 SBR (`mp4a.40.5`) or HE-AACv2 PS (`mp4a.40.29`):
    //    universally-decodable `mp3_1_0` (`audio/mpeg`) MUST win over HE-AAC!
    for (const heAacCodec of ['mp4a.40.5', 'mp4a.40.29'] as const) {
      const sqWithHeAac: readonly SoundCloudTranscoding[] = [
        makeTranscoding('opus_0_0', 'hls', 'audio/ogg; codecs="opus"', { quality: 'sq' }),
        makeTranscoding('aac_160k', 'hls', `audio/mp4; codecs="${heAacCodec}"`, {
          quality: 'sq',
        }),
        makeTranscoding('mp3_1_0', 'hls', 'audio/mpeg', { quality: 'sq' }),
      ];

      const sqResult = rankSoundCloudTranscodings(sqWithHeAac);
      expect(sqResult.kind).toBe('playable');
      if (sqResult.kind !== 'playable') {
        throw new Error('Expected playable selection');
      }
      expect(sqResult.selected.preset).toBe('mp3_1_0');
      expect(sqResult.fallbacks.map((f) => f.preset)).toEqual(['aac_160k', 'opus_0_0']);
    }

    // 2. Go+ track with `aac_256k` (`mp4a.40.2`), HE-AAC `aac_160k` (`mp4a.40.5`), and `mp3_1_0`:
    //    `aac_256k` stays #1 and `mp3_1_0` ranks ahead of HE-AAC `aac_160k` in fallbacks!
    const goPlusWithHeAac160: readonly SoundCloudTranscoding[] = [
      makeTranscoding('aac_160k', 'hls', 'audio/mp4; codecs="mp4a.40.5"', { quality: 'sq' }),
      makeTranscoding('mp3_1_0', 'hls', 'audio/mpeg', { quality: 'sq' }),
      makeTranscoding('aac_256k', 'encrypted-hls', 'audio/mp4; codecs="mp4a.40.2"', {
        quality: 'hq',
      }),
    ];
    const goPlusResult = rankSoundCloudTranscodings(goPlusWithHeAac160);
    expect(goPlusResult.kind).toBe('playable');
    if (goPlusResult.kind !== 'playable') {
      throw new Error('Expected playable Go+ selection');
    }
    expect(goPlusResult.selected.preset).toBe('aac_256k');
    expect(goPlusResult.fallbacks.map((f) => f.preset)).toEqual(['mp3_1_0', 'aac_160k']);

    // 3. Standard AAC-LC `aac_160k` (`mp4a.40.2`) MUST still rank ahead of `mp3_1_0`!
    const sqWithAacLc: readonly SoundCloudTranscoding[] = [
      makeTranscoding('mp3_1_0', 'hls', 'audio/mpeg', { quality: 'sq' }),
      makeTranscoding('aac_160k', 'hls', 'audio/mp4; codecs="mp4a.40.2"', { quality: 'sq' }),
    ];
    const aacLcResult = rankSoundCloudTranscodings(sqWithAacLc);
    expect(aacLcResult.kind).toBe('playable');
    if (aacLcResult.kind !== 'playable') {
      throw new Error('Expected playable AAC-LC selection');
    }
    expect(aacLcResult.selected.preset).toBe('aac_160k');
    expect(aacLcResult.fallbacks.map((f) => f.preset)).toEqual(['mp3_1_0']);
  });

  it('skips broken abr_sq and abr_hq 404 stubs unconditionally', () => {
    const transcodings: readonly SoundCloudTranscoding[] = [
      makeTranscoding('abr_hq', 'hls', 'audio/mp4; codecs="mp4a.40.2"', { quality: 'hq' }),
      makeTranscoding('ABR_SQ', 'hls', 'audio/mpeg', { quality: 'sq' }),
      makeTranscoding('mp3_1_0', 'hls', 'audio/mpeg', { quality: 'sq' }),
    ];

    const result = rankSoundCloudTranscodings(transcodings);
    expect(result.kind).toBe('playable');
    if (result.kind !== 'playable') {
      throw new Error('Expected playable selection');
    }
    expect(result.selected.preset).toBe('mp3_1_0');
    expect(result.fallbacks).toHaveLength(0);

    const onlyAbrStubs = rankSoundCloudTranscodings([
      makeTranscoding('abr_hq', 'hls', 'audio/mp4; codecs="mp4a.40.2"', { quality: 'hq' }),
      makeTranscoding('abr_sq', 'hls', 'audio/mpeg', { quality: 'sq' }),
    ]);
    expect(onlyAbrStubs).toEqual({
      kind: 'unplayable',
      reason: 'empty_or_unsupported',
    });
  });

  it('breaks ties deterministically by protocol (hls > encrypted-hls > progressive) then original index', () => {
    const transcodings: readonly SoundCloudTranscoding[] = [
      makeTranscoding('aac_256k', 'progressive', 'audio/mp4; codecs="mp4a.40.2"', {
        quality: 'hq',
        url: 'https://api-v2.soundcloud.com/media/soundcloud:tracks:9001/prog/stream/progressive',
      }),
      makeTranscoding('aac_256k', 'encrypted-hls', 'audio/mp4; codecs="mp4a.40.2"', {
        quality: 'hq',
        url: 'https://api-v2.soundcloud.com/media/soundcloud:tracks:9001/enc/stream/encrypted-hls',
      }),
      makeTranscoding('aac_256k', 'hls', 'audio/mp4; codecs="mp4a.40.2"', {
        quality: 'hq',
        url: 'https://api-v2.soundcloud.com/media/soundcloud:tracks:9001/plain-a/stream/hls',
      }),
      makeTranscoding('aac_256k', 'hls', 'audio/mp4; codecs="mp4a.40.2"', {
        quality: 'hq',
        url: 'https://api-v2.soundcloud.com/media/soundcloud:tracks:9001/plain-b/stream/hls',
      }),
    ];

    const result = rankSoundCloudTranscodings(transcodings);
    expect(result.kind).toBe('playable');
    if (result.kind !== 'playable') {
      throw new Error('Expected playable selection');
    }

    expect(result.selected.protocol).toBe('hls');
    expect(result.selected.resolveUrl).toContain('/plain-a/stream/hls');
    expect(result.fallbacks.map((f) => f.protocol)).toEqual([
      'hls',
      'encrypted-hls',
      'progressive',
    ]);
  });

  it('attaches initialPlaylistUrl ONLY when observedInTabPlaylist canonically matches top transcoding and NEVER cross-wires sq onto hq', () => {
    const sqUrl =
      'https://api-v2.soundcloud.com/media/soundcloud:tracks:9001/sq-uuid/stream/hls?track_authorization=tok_a';
    const hqUrl =
      'https://api-v2.soundcloud.com/media/soundcloud:tracks:9001/hq-uuid/stream/encrypted-hls?track_authorization=tok_a';

    const transcodings: readonly SoundCloudTranscoding[] = [
      makeTranscoding('mp3_1_0', 'hls', 'audio/mpeg', { quality: 'sq', url: sqUrl }),
      makeTranscoding('aac_256k', 'encrypted-hls', 'audio/mp4; codecs="mp4a.40.2"', {
        quality: 'hq',
        url: hqUrl,
      }),
    ];

    // Case 1: In-tab player resolved SQ `.m3u8` — MUST NOT attach onto HQ `aac_256k`!
    const mismatched = rankSoundCloudTranscodings(transcodings, {
      observedInTabPlaylist: {
        resolveUrl: `${sqUrl}&client_id=cid_123`,
        playlistUrl: 'https://cf-hls-media.sndcdn.com/playlist/sq-128.m3u8',
      },
    });
    expect(mismatched.kind).toBe('playable');
    if (mismatched.kind !== 'playable') {
      throw new Error('Expected playable selection');
    }
    expect(mismatched.selected.preset).toBe('aac_256k');
    expect(mismatched.selected.initialPlaylistUrl).toBeUndefined();

    // Case 2: In-tab player resolved HQ `.m3u8` with rotated ephemeral query params — MUST attach!
    const matched = rankSoundCloudTranscodings(transcodings, {
      observedInTabPlaylist: {
        resolveUrl:
          'https://api-v2.soundcloud.com/media/soundcloud:tracks:9001/hq-uuid/stream/encrypted-hls?client_id=cid_999&track_authorization=tok_rotated&app_version=1700000&_=12345',
        playlistUrl: 'https://cf-hls-media.sndcdn.com/playlist/hq-256.m3u8',
      },
    });
    expect(matched.kind).toBe('playable');
    if (matched.kind !== 'playable') {
      throw new Error('Expected playable selection');
    }
    expect(matched.selected.preset).toBe('aac_256k');
    expect(matched.selected.initialPlaylistUrl).toBe(
      'https://cf-hls-media.sndcdn.com/playlist/hq-256.m3u8',
    );
  });

  it('returns drm_local_fallback on CENC-only full-length tracks even when a 30s snipped hls preview is present, and only selects snipped when zero full-length streams exist', () => {
    const cencWithPreview: readonly SoundCloudTranscoding[] = [
      makeTranscoding('aac_256k', 'ctr-encrypted-hls', 'audio/mp4; codecs="mp4a.40.2"', {
        quality: 'hq',
        snipped: false,
      }),
      makeTranscoding('aac_160k', 'cbc-encrypted-hls', 'audio/mp4; codecs="mp4a.40.2"', {
        quality: 'sq',
        snipped: false,
      }),
      makeTranscoding('mp3_1_0', 'hls', 'audio/mpeg', {
        quality: 'sq',
        snipped: true,
        duration: 30_000,
      }),
    ];

    const drmResult = rankSoundCloudTranscodings(cencWithPreview);
    expect(drmResult).toEqual({
      kind: 'drm_local_fallback',
      reason: 'cenc_drm_only',
      protocolsSeen: ['ctr-encrypted-hls', 'cbc-encrypted-hls', 'hls'],
    });

    // When ONLY snipped previews exist (e.g. unauthenticated preview-only track), allow snipped playback.
    const snippetOnlyResult = rankSoundCloudTranscodings([
      makeTranscoding('opus_0_0', 'hls', 'audio/ogg; codecs="opus"', {
        quality: 'sq',
        snipped: true,
        duration: 30_000,
      }),
      makeTranscoding('mp3_1_0', 'hls', 'audio/mpeg', {
        quality: 'sq',
        snipped: true,
        duration: 30_000,
      }),
    ]);
    expect(snippetOnlyResult.kind).toBe('playable');
    if (snippetOnlyResult.kind !== 'playable') {
      throw new Error('Expected snipped playable fallback when zero full-length tracks exist');
    }
    expect(snippetOnlyResult.selected.preset).toBe('mp3_1_0');
  });
});

describe('@soundclud/protocol — Origin-Scoped Credential Guard & URL Matcher', () => {
  it('enforces strict HTTPS SoundCloud API origin allowlisting in isAllowedSoundCloudApiAuthUrl', () => {
    expect(
      isAllowedSoundCloudApiAuthUrl(
        'https://api-v2.soundcloud.com/media/soundcloud:tracks:42/abc/stream/hls?client_id=test',
      ),
    ).toBe(true);
    expect(
      isAllowedSoundCloudApiAuthUrl('https://api.soundcloud.com/tracks/42/streams'),
    ).toBe(true);

    // Block plain HTTP, userinfo, custom ports, playback/media CDNs, and lookalike hosts
    expect(
      isAllowedSoundCloudApiAuthUrl('http://api-v2.soundcloud.com/tracks/42'),
    ).toBe(false);
    expect(
      isAllowedSoundCloudApiAuthUrl('https://user:secret@api-v2.soundcloud.com/tracks/42'),
    ).toBe(false);
    expect(
      isAllowedSoundCloudApiAuthUrl('https://oauth@api.soundcloud.com/tracks/42'),
    ).toBe(false);
    expect(
      isAllowedSoundCloudApiAuthUrl('https://api-v2.soundcloud.com:8443/tracks/42'),
    ).toBe(false);
    expect(
      isAllowedSoundCloudApiAuthUrl(
        'https://playback.media-streaming.soundcloud.cloud/playlist.m3u8',
      ),
    ).toBe(false);
    expect(
      isAllowedSoundCloudApiAuthUrl('https://cf-hls-media.sndcdn.com/media/0/32000/track.m4s'),
    ).toBe(false);
    expect(
      isAllowedSoundCloudApiAuthUrl('https://api-v2.soundcloud.com.attacker.example/tracks/42'),
    ).toBe(false);
    expect(isAllowedSoundCloudApiAuthUrl('')).toBe(false);
    expect(isAllowedSoundCloudApiAuthUrl('/relative/tracks/42')).toBe(false);
  });

  it('matches canonical resolve URLs while rejecting distinct paths or non-ephemeral query params', () => {
    expect(
      areMatchingTranscodingResolveUrls(
        'https://api-v2.soundcloud.com/media/soundcloud:tracks:7/ preset_a /stream/hls'.replace(
          /\s+/g,
          '',
        ),
        'https://api-v2.soundcloud.com/media/soundcloud:tracks:7/preset_a/stream/hls?client_id=x&secret_token=s-abc&timestamp=99',
      ),
    ).toBe(true);

    expect(
      areMatchingTranscodingResolveUrls(
        'https://api-v2.soundcloud.com/media/soundcloud:tracks:7/preset_a/stream/hls?variant=1',
        'https://api-v2.soundcloud.com/media/soundcloud:tracks:7/preset_a/stream/hls?variant=2',
      ),
    ).toBe(false);

    expect(getDefaultSeekDebounceMs('coreaudio')).toBe(TOSLINK_SEEK_DEBOUNCE_MS);
    expect(getDefaultSeekDebounceMs('alsa')).toBe(TOSLINK_SEEK_DEBOUNCE_MS);
    expect(getDefaultSeekDebounceMs('heos_upnp')).toBe(HEOS_SEEK_DEBOUNCE_MS);
  });
});

describe('@soundclud/protocol — Runtime Wire Validators & Bit-Perfect Invariant Enforcement', () => {
  it('normalizes Rust null optional fields cleanly across REST and WebSocket validators', () => {
    const discoverRaw = JSON.stringify({
      protocolVersion: PROTOCOL_VERSION,
      receiverId: 'rcv_synthetic_01',
      receiverName: 'Living Room Hi-Fi',
      platform: 'macos',
      arch: 'x86_64',
      requiresPairing: true,
      outputs: [
        {
          ...makeValidOutputDeviceFixture(),
          model: null,
          standbyState: null,
        },
      ],
      peers: [
        {
          receiverId: 'rcv_peer_02',
          receiverName: 'Study DAC',
          host: 'soundclud-study.local',
          port: 9876,
          protocolVersion: PROTOCOL_VERSION,
        },
      ],
      config: {
        activeOutputId: null,
        volumeMode: 'bit_perfect',
        opticalIdleKeepalive: true,
        opticalDitherSubaudible: false,
      },
    });

    const parsedDiscover = parseDiscoverResponse(discoverRaw);
    expect(parsedDiscover.ok).toBe(true);
    if (!parsedDiscover.ok) {
      throw new Error(parsedDiscover.error);
    }
    expect('activeOutputId' in parsedDiscover.value.config).toBe(false);
    const firstOut = parsedDiscover.value.outputs[0];
    expect(firstOut).toBeDefined();
    if (firstOut !== undefined) {
      expect('model' in firstOut).toBe(false);
      expect('standbyState' in firstOut).toBe(false);
      expect(isValidOutputDevice(firstOut)).toBe(true);
    }

    const parsedPairReq = parsePairRequest({
      protocolVersion: PROTOCOL_VERSION,
      clientLabel: 'SoundClud Test Tab',
      controllerId: 'ctrl_synthetic_1',
    });
    expect(parsedPairReq.ok).toBe(true);

    const parsedPair = parsePairResponse({
      protocolVersion: PROTOCOL_VERSION,
      receiverId: 'rcv_synthetic_01',
      pairingToken: 'a'.repeat(64),
    });
    expect(parsedPair.ok).toBe(true);

    const statusWithNulls = {
      protocolVersion: PROTOCOL_VERSION,
      receiverId: 'rcv_synthetic_01',
      receiverName: 'Living Room Hi-Fi',
      config: {
        activeOutputId: null,
        volumeMode: 'bit_perfect',
        opticalIdleKeepalive: true,
        opticalDitherSubaudible: false,
      },
      telemetry: {
        protocolVersion: PROTOCOL_VERSION,
        serverSeq: 7,
        phase: 'idle',
        activeOutputId: null,
        activeBackend: null,
        volumeMode: 'bit_perfect',
        fixedGainDb: 0,
        sampleRateHz: 44100,
        bitDepth: 24,
        positionMs: 0,
        durationMs: 0,
        bufferedMs: 0,
        track: {
          trackId: '9001',
          permalinkUrl: 'https://soundcloud.com/artist/track',
          title: 'Title',
          artist: 'Artist',
          artworkUrl: null,
          durationMs: 180_000,
          waveformUrl: null,
        },
        streamInfo: null,
        activeControllerId: null,
        errorCode: null,
        errorMessage: null,
        timestampMs: 1_700_000_000_000,
      },
      outputs: [makeValidOutputDeviceFixture()],
    };

    const parsedStatus = parseStatusResponse(statusWithNulls);
    expect(parsedStatus.ok).toBe(true);
    if (!parsedStatus.ok) {
      throw new Error(parsedStatus.error);
    }
    expect('activeOutputId' in parsedStatus.value.telemetry).toBe(false);
    expect('activeBackend' in parsedStatus.value.telemetry).toBe(false);
    expect('streamInfo' in parsedStatus.value.telemetry).toBe(false);
    expect('activeControllerId' in parsedStatus.value.telemetry).toBe(false);
    expect('errorCode' in parsedStatus.value.telemetry).toBe(false);
    expect('errorMessage' in parsedStatus.value.telemetry).toBe(false);
    expect(parsedStatus.value.telemetry.track).toBeDefined();
    if (parsedStatus.value.telemetry.track !== undefined) {
      expect('artworkUrl' in parsedStatus.value.telemetry.track).toBe(false);
      expect('waveformUrl' in parsedStatus.value.telemetry.track).toBe(false);
    }

    expect(
      parseAudioDevicesResponse({
        protocolVersion: PROTOCOL_VERSION,
        activeOutputId: null,
        outputs: [makeValidOutputDeviceFixture()],
      }).ok,
    ).toBe(true);

    expect(
      parseUpdateConfigRequest({
        activeOutputId: null,
        opticalIdleKeepalive: true,
        opticalDitherSubaudible: null,
      }).ok,
    ).toBe(true);

    expect(
      parseUpdateConfigResponse({
        protocolVersion: PROTOCOL_VERSION,
        config: statusWithNulls.config,
        outputs: [makeValidOutputDeviceFixture()],
      }).ok,
    ).toBe(true);

    expect(
      parseApiErrorResponse({
        error: { code: 'forbidden_host', message: 'Host rejected' },
      }).ok,
    ).toBe(true);
  });

  it('validates all ClientWsCommand and ServerWsEvent discriminated variants and normalizes nulls', () => {
    const baseLocator = makeValidStreamLocatorFixture();
    expect(isValidStreamLocatorPayload(baseLocator)).toBe(true);
    expect(parseStreamLocatorPayload(JSON.stringify(baseLocator)).ok).toBe(true);

    const loadCmd = parseClientWsCommand({
      type: 'load_track',
      commandSeq: 1,
      preferredOutputId: null,
      locator: {
        ...baseLocator,
        selected: { ...baseLocator.selected, initialPlaylistUrl: null },
        auth: {
          clientId: 'sc_synthetic_test_client_id',
          oauthToken: null,
          trackAuthorization: null,
          secretToken: null,
          accountTier: 'anonymous',
        },
      },
    });
    expect(loadCmd.ok).toBe(true);
    if (!loadCmd.ok || loadCmd.value.type !== 'load_track') {
      throw new Error('Expected valid load_track command');
    }
    expect('preferredOutputId' in loadCmd.value).toBe(false);
    expect('oauthToken' in loadCmd.value.locator.auth).toBe(false);

    expect(
      parseClientWsCommand({
        type: 'hello',
        protocolVersion: PROTOCOL_VERSION,
        pairingToken: 'tok_synthetic_01',
        controllerId: 'ctrl_1',
        clientLabel: 'Tab 1',
      }).ok,
    ).toBe(true);
    expect(parseClientWsCommand({ type: 'set_paused', commandSeq: 2, paused: true }).ok).toBe(
      true,
    );
    expect(parseClientWsCommand({ type: 'seek', commandSeq: 3, positionMs: 12_500 }).ok).toBe(
      true,
    );
    expect(
      parseClientWsCommand({ type: 'preload_next', commandSeq: 4, locator: baseLocator }).ok,
    ).toBe(true);
    expect(parseClientWsCommand({ type: 'stop', commandSeq: 5, reason: null }).ok).toBe(true);
    expect(
      parseClientWsCommand({ type: 'select_output', commandSeq: 6, outputId: 'coreaudio/spdf' })
        .ok,
    ).toBe(true);
    expect(
      parseClientWsCommand({
        type: 'refresh_locator_response',
        requestId: 'rfr_1',
        locator: null,
        error: 'upstream_expired',
      }).ok,
    ).toBe(true);
    expect(parseClientWsCommand({ type: 'ping', clientTimestampMs: 123_456 }).ok).toBe(true);
    expect(parseClientWsCommand({ type: 'set_volume', volume: 50 }).ok).toBe(false);

    const baseTelemetry = {
      protocolVersion: PROTOCOL_VERSION,
      serverSeq: 10,
      phase: 'playing' as const,
      activeOutputId: 'coreaudio/spdf',
      activeBackend: 'coreaudio' as const,
      volumeMode: 'bit_perfect' as const,
      fixedGainDb: 0 as const,
      sampleRateHz: 44100 as const,
      bitDepth: 24 as const,
      positionMs: 42_000,
      durationMs: 240_000,
      bufferedMs: 60_000,
      streamInfo: {
        preset: 'aac_256k',
        quality: 'hq' as const,
        protocol: 'hls' as const,
        bitrateKbps: 256,
        accountTier: 'go_plus' as const,
        hlsRefreshCount: 1,
      },
      timestampMs: 1_700_000_001_000,
    };

    expect(
      parseServerWsEvent({
        type: 'welcome',
        protocolVersion: PROTOCOL_VERSION,
        receiverId: 'rcv_1',
        receiverName: 'Receiver',
        controllerId: 'ctrl_1',
        config: {
          volumeMode: 'bit_perfect',
          opticalIdleKeepalive: true,
          opticalDitherSubaudible: false,
        },
        telemetry: baseTelemetry,
        outputs: [makeValidOutputDeviceFixture()],
      }).ok,
    ).toBe(true);

    expect(
      parseServerWsEvent({
        type: 'state_tick',
        lastAckedCommandSeq: 3,
        telemetry: baseTelemetry,
      }).ok,
    ).toBe(true);

    const outputsUpdated = parseServerWsEvent({
      type: 'outputs_updated',
      activeOutputId: null,
      outputs: [makeValidOutputDeviceFixture()],
    });
    expect(outputsUpdated.ok).toBe(true);
    if (outputsUpdated.ok && outputsUpdated.value.type === 'outputs_updated') {
      expect('activeOutputId' in outputsUpdated.value).toBe(false);
    }

    expect(
      parseServerWsEvent({
        type: 'track_ended',
        trackId: '9001',
        locatorId: 'loc-9001-1',
      }).ok,
    ).toBe(true);

    expect(
      parseServerWsEvent({
        type: 'refresh_locator_request',
        requestId: 'rfr_99',
        trackId: '9001',
        locatorId: 'loc-9001-1',
        reason: 'upstream_403',
      }).ok,
    ).toBe(true);

    expect(
      parseServerWsEvent({
        type: 'session_claimed',
        newControllerId: 'ctrl_2',
        newClientLabel: 'Tab B',
      }).ok,
    ).toBe(true);

    const errEv = parseServerWsEvent({
      type: 'error',
      code: 'unauthorized',
      message: 'stale token',
      commandSeq: null,
    });
    expect(errEv.ok).toBe(true);
    if (errEv.ok && errEv.value.type === 'error') {
      expect('commandSeq' in errEv.value).toBe(false);
    }

    expect(
      parseServerWsEvent({
        type: 'pong',
        clientTimestampMs: 1000,
        serverTimestampMs: 1002,
      }).ok,
    ).toBe(true);
  });

  it('strictly rejects wrong protocolVersion, non-bit_perfect volumeMode, non-0 fixedGainDb, and non-44100/24 audio parameters', () => {
    const validOut = makeValidOutputDeviceFixture();

    expect(
      parsePairResponse({
        protocolVersion: 'v2',
        receiverId: 'rcv_1',
        pairingToken: 'tok_1',
      }).ok,
    ).toBe(false);

    expect(
      parseClientWsCommand({
        type: 'hello',
        protocolVersion: 'v0',
        pairingToken: 'tok_1',
        controllerId: 'ctrl_1',
        clientLabel: 'Tab',
      }).ok,
    ).toBe(false);

    expect(
      parseReceiverConfig({
        volumeMode: 'software_attenuated',
        opticalIdleKeepalive: true,
        opticalDitherSubaudible: false,
      }).ok,
    ).toBe(false);

    expect(
      parseOutputDevice({
        ...validOut,
        capabilities: { ...validOut.capabilities, fixedGainDb: -3 },
      }).ok,
    ).toBe(false);

    expect(
      parseOutputDevice({
        ...validOut,
        capabilities: { ...validOut.capabilities, targetSampleRateHz: 48000 },
      }).ok,
    ).toBe(false);

    expect(
      parseOutputDevice({
        ...validOut,
        capabilities: { ...validOut.capabilities, targetBitDepth: 16 },
      }).ok,
    ).toBe(false);

    expect(
      parseOutputDevice({
        ...validOut,
        capabilities: { ...validOut.capabilities, bitPerfect: false },
      }).ok,
    ).toBe(false);

    const validTel = {
      protocolVersion: PROTOCOL_VERSION,
      serverSeq: 1,
      phase: 'playing',
      volumeMode: 'bit_perfect',
      fixedGainDb: 0,
      sampleRateHz: 44100,
      bitDepth: 24,
      positionMs: 100,
      durationMs: 1000,
      bufferedMs: 500,
      timestampMs: 1_700_000_000_000,
    };
    expect(parsePlaybackTelemetry(validTel).ok).toBe(true);
    expect(parsePlaybackTelemetry({ ...validTel, protocolVersion: 'v99' }).ok).toBe(false);
    expect(parsePlaybackTelemetry({ ...validTel, volumeMode: 'variable' }).ok).toBe(false);
    expect(parsePlaybackTelemetry({ ...validTel, fixedGainDb: -6 }).ok).toBe(false);
    expect(parsePlaybackTelemetry({ ...validTel, sampleRateHz: 48000 }).ok).toBe(false);
    expect(parsePlaybackTelemetry({ ...validTel, bitDepth: 16 }).ok).toBe(false);
  });
});
