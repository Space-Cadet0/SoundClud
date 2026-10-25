/**
 * Deterministic SoundCloud Go+ transcoding ranker (`v1`).
 *
 * Guarantees Go+ `aac_256k` (`hq`) selection whenever available, skips broken
 * `abr_*` 404 stubs, detects CENC hardware DRM (`drm_local_fallback`) without
 * downgrading full-length Go+ tracks to 30s snippets, and prevents attaching
 * mismatched `sq` in-tab `.m3u8` URLs onto `hq` transcodings.
 */

import {
  isDrmProtocol,
  isPlayableProtocol,
  type PlayableProtocol,
  type SelectedTranscodingDescriptor,
  type SoundCloudTranscoding,
  type SourceSampleRateHz,
  type StreamQualityTier,
} from './soundcloud.js';
import {
  areMatchingTranscodingResolveUrls,
  isAllowedSoundCloudApiAuthUrl,
} from './urlGuards.js';

export { areMatchingTranscodingResolveUrls, isAllowedSoundCloudApiAuthUrl };

export interface ObservedInTabPlaylist {
  readonly resolveUrl: string;
  readonly playlistUrl: string;
}

export interface RankTranscodingsOptions {
  readonly observedInTabPlaylist?: ObservedInTabPlaylist | undefined;
}

export type TranscodingSelectionResult =
  | {
      readonly kind: 'playable';
      readonly selected: SelectedTranscodingDescriptor;
      readonly fallbacks: readonly SelectedTranscodingDescriptor[];
    }
  | {
      readonly kind: 'drm_local_fallback';
      readonly reason: 'cenc_drm_only';
      readonly protocolsSeen: readonly string[];
    }
  | {
      readonly kind: 'unplayable';
      readonly reason: 'empty_or_unsupported';
    };

interface RankedCandidate {
  readonly descriptor: SelectedTranscodingDescriptor;
  readonly tier: number;
  readonly protocolRank: number;
  readonly originalIndex: number;
}

interface CodecClassification {
  readonly tier: 1 | 2 | 3 | 4 | 5 | 6;
  readonly quality: StreamQualityTier;
  readonly bitrateKbps: number;
  readonly sampleRateHz: SourceSampleRateHz;
}

function getProtocolRank(protocol: PlayableProtocol): 1 | 2 | 3 {
  switch (protocol) {
    case 'hls':
      return 1;
    case 'encrypted-hls':
      return 2;
    case 'progressive':
      return 3;
  }
}

function classifyCodecTier(
  preset: string,
  mimeType: string,
  rawQuality?: string,
): CodecClassification {
  const presetLower = preset.trim().toLowerCase();
  const mimeLower = mimeType.trim().toLowerCase();
  const qualityLower = rawQuality?.trim().toLowerCase();

  const isAac =
    presetLower.includes('aac') ||
    mimeLower.includes('mp4a') ||
    mimeLower.includes('aac') ||
    mimeLower.startsWith('audio/mp4');

  if (
    presetLower === 'aac_256k' ||
    presetLower.startsWith('aac_256') ||
    (qualityLower === 'hq' && isAac)
  ) {
    return { tier: 1, quality: 'hq', bitrateKbps: 256, sampleRateHz: 44100 };
  }

  if (presetLower === 'aac_160k' || presetLower.startsWith('aac_160')) {
    return { tier: 2, quality: 'sq', bitrateKbps: 160, sampleRateHz: 44100 };
  }

  if (presetLower === 'mp3_1_0' || presetLower.startsWith('mp3')) {
    return { tier: 3, quality: 'sq', bitrateKbps: 128, sampleRateHz: 44100 };
  }

  if (presetLower === 'aac_96k' || presetLower.startsWith('aac_96')) {
    return { tier: 4, quality: 'sq', bitrateKbps: 96, sampleRateHz: 44100 };
  }

  if (
    presetLower === 'opus_0_0' ||
    presetLower.startsWith('opus') ||
    mimeLower.includes('opus')
  ) {
    return { tier: 5, quality: 'sq', bitrateKbps: 64, sampleRateHz: 48000 };
  }

  return {
    tier: 6,
    quality: qualityLower === 'hq' ? 'hq' : 'sq',
    bitrateKbps: 128,
    sampleRateHz: 44100,
  };
}

function rankCandidates(
  candidates: readonly RankedCandidate[],
  observedInTabPlaylist?: ObservedInTabPlaylist,
): TranscodingSelectionResult {
  const sorted = [...candidates].sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier;
    if (a.protocolRank !== b.protocolRank) return a.protocolRank - b.protocolRank;
    return a.originalIndex - b.originalIndex;
  });

  const [top, ...rest] = sorted;
  if (top === undefined) {
    return { kind: 'unplayable', reason: 'empty_or_unsupported' };
  }

  const trimmedPlaylistUrl = observedInTabPlaylist?.playlistUrl.trim() ?? '';
  const shouldAttachObservedPlaylist =
    observedInTabPlaylist !== undefined &&
    trimmedPlaylistUrl.length > 0 &&
    top.descriptor.protocol !== 'progressive' &&
    areMatchingTranscodingResolveUrls(
      top.descriptor.resolveUrl,
      observedInTabPlaylist.resolveUrl,
    );

  const selected: SelectedTranscodingDescriptor = shouldAttachObservedPlaylist
    ? { ...top.descriptor, initialPlaylistUrl: trimmedPlaylistUrl }
    : top.descriptor;

  return {
    kind: 'playable',
    selected,
    fallbacks: rest.map((entry) => entry.descriptor),
  };
}

/**
 * Deterministically selects the highest-fidelity playable transcoding from
 * SoundCloud `api-v2` `media.transcodings[]`.
 */
export function rankSoundCloudTranscodings(
  transcodings: readonly SoundCloudTranscoding[],
  options?: RankTranscodingsOptions,
): TranscodingSelectionResult {
  if (transcodings.length === 0) {
    return { kind: 'unplayable', reason: 'empty_or_unsupported' };
  }

  const fullLengthPlayable: RankedCandidate[] = [];
  const snippedPlayable: RankedCandidate[] = [];
  const protocolsSeenSet = new Set<string>();
  let fullLengthDrmCount = 0;
  let snippedDrmCount = 0;
  let otherFullLengthCount = 0;

  for (let index = 0; index < transcodings.length; index += 1) {
    const item = transcodings[index];
    if (item === undefined) continue;

    const resolveUrl = item.url.trim();
    const preset = item.preset.trim();
    const protocol = item.format.protocol.trim().toLowerCase();
    const mimeType = item.format.mime_type.trim();

    if (resolveUrl.length === 0 || protocol.length === 0) continue;

    // Rule 1: Reject `abr_sq` / `abr_hq` 404 stubs.
    if (preset.toLowerCase().startsWith('abr')) continue;

    protocolsSeenSet.add(protocol);
    const isSnipped = item.snipped === true;

    // Rule 2: Reject CENC hardware DRM from remote playable candidates.
    if (isDrmProtocol(protocol)) {
      if (isSnipped) snippedDrmCount += 1;
      else fullLengthDrmCount += 1;
      continue;
    }

    if (!isPlayableProtocol(protocol)) {
      if (!isSnipped) otherFullLengthCount += 1;
      continue;
    }

    const codec = classifyCodecTier(preset, mimeType, item.quality);
    const candidate: RankedCandidate = {
      descriptor: {
        resolveUrl,
        preset,
        protocol,
        mimeType,
        quality: codec.quality,
        bitrateKbps: codec.bitrateKbps,
        sampleRateHz: codec.sampleRateHz,
      },
      tier: codec.tier,
      protocolRank: getProtocolRank(protocol),
      originalIndex: index,
    };

    if (isSnipped) snippedPlayable.push(candidate);
    else fullLengthPlayable.push(candidate);
  }

  if (fullLengthPlayable.length > 0) {
    return rankCandidates(fullLengthPlayable, options?.observedInTabPlaylist);
  }

  if (fullLengthDrmCount > 0) {
    return {
      kind: 'drm_local_fallback',
      reason: 'cenc_drm_only',
      protocolsSeen: Array.from(protocolsSeenSet),
    };
  }

  if (otherFullLengthCount === 0 && snippedPlayable.length > 0) {
    return rankCandidates(snippedPlayable, options?.observedInTabPlaylist);
  }

  if (snippedDrmCount > 0) {
    return {
      kind: 'drm_local_fallback',
      reason: 'cenc_drm_only',
      protocolsSeen: Array.from(protocolsSeenSet),
    };
  }

  return { kind: 'unplayable', reason: 'empty_or_unsupported' };
}
