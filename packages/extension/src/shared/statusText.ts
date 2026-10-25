/**
 * Pure UI status & signal-chain badge formatters shared across the Shadow DOM
 * Cast Pill (`ISOLATED` world) and the Extension Popup (`popup.ts`).
 */

import type { OutputDevice } from '@soundclud/protocol';
import type { ExtensionUiSnapshot } from './messages.js';

export interface FormattedUiStatus {
  readonly pillLabel: string;
  readonly signalHeadline: string;
  readonly signalDetail: string;
  readonly tone: 'idle' | 'active' | 'waking' | 'drm' | 'warning' | 'error';
  readonly badgeText: string;
}

export function formatOutputTransportShortLabel(output: OutputDevice): string {
  if (output.kind === 'heos_upnp' || output.transport === 'heos_lan_wav') {
    return `${output.name} • HEOS 44.1kHz 0dB`;
  }
  if (output.transport === 'optical_toslink') {
    return 'Optical • 44.1kHz 0dB';
  }
  return `${output.name} • 44.1kHz 0dB`;
}

export function formatOutputKindBadge(output: OutputDevice): string {
  if (output.kind === 'heos_upnp') {
    return 'HEOS Direct • 44.1k/24b WAV';
  }
  if (output.transport === 'optical_toslink') {
    return 'TOSLINK S/PDIF • 44.1k/24b';
  }
  if (output.kind === 'alsa') {
    return 'ALSA HW • 44.1k/24b';
  }
  return 'CoreAudio • 44.1k/24b';
}

export function formatUiStatus(snapshot: ExtensionUiSnapshot): FormattedUiStatus {
  if (!snapshot.handoffEnabled) {
    return {
      pillLabel:
        snapshot.outputs.length > 0 ? 'Hi-Fi Cast • Off' : 'SoundClud • Local',
      signalHeadline: 'Browser Local Audio',
      signalDetail:
        snapshot.outputs.length > 0
          ? `${String(snapshot.outputs.length)} Hi-Fi output${snapshot.outputs.length === 1 ? '' : 's'} ready for 0 dB handoff`
          : 'Enable handoff or discover a local / LAN SoundClud receiver',
      tone: 'idle',
      badgeText: '',
    };
  }

  if (snapshot.drmFallback !== null || snapshot.telemetry?.phase === 'drm_local_fallback') {
    const titleSuffix = snapshot.drmFallback
      ? ` (${snapshot.drmFallback.title})`
      : '';
    return {
      pillLabel: 'Widevine DRM • Local',
      signalHeadline: 'Widevine DRM • Playing Locally',
      signalDetail: `Hardware CENC track${titleSuffix} — remote 0 dB handoff auto-resumes next track`,
      tone: 'drm',
      badgeText: 'DRM',
    };
  }

  if (snapshot.connectionState === 'session_claimed') {
    return {
      pillLabel: 'Claimed Elsewhere',
      signalHeadline: 'Receiver Claimed by Another Tab',
      signalDetail: 'Press Play in this tab to reclaim remote Hi-Fi output',
      tone: 'warning',
      badgeText: 'IDLE',
    };
  }

  if (
    snapshot.telemetry?.phase === 'waking_device'
  ) {
    return {
      pillLabel: 'Waking Amplifier...',
      signalHeadline: 'Waking Amplifier...',
      signalDetail:
        'Powering HEOS network stage from standby • 0 dB Bit-Perfect (Amp Volume)',
      tone: 'waking',
      badgeText: 'WAKE',
    };
  }

  if (snapshot.connectionState === 'reconnecting') {
    return {
      pillLabel: 'Reconnecting...',
      signalHeadline: 'Reconnecting to Receiver...',
      signalDetail: 'Wi-Fi WebSocket link recovering automatically',
      tone: 'warning',
      badgeText: 'SYNC',
    };
  }

  if (snapshot.connectionState === 'error') {
    return {
      pillLabel: 'Receiver Offline',
      signalHeadline: 'Receiver Unreachable',
      signalDetail:
        snapshot.lastError ?? 'Verify soundclud-receiver is running on 127.0.0.1 or LAN',
      tone: 'error',
      badgeText: 'ERR',
    };
  }

  const stream = snapshot.telemetry?.streamInfo;
  const codecTag = stream
    ? stream.quality === 'hq'
      ? `Go+ ${String(stream.bitrateKbps)}k`
      : `${String(stream.bitrateKbps)}k SQ`
    : snapshot.accountTier === 'go_plus'
      ? 'Go+ 256k'
      : '44.1kHz';

  const outputLabel = snapshot.activeOutput
    ? formatOutputTransportShortLabel(snapshot.activeOutput)
    : 'Hi-Fi • 44.1kHz 0dB';

  const pillLabel =
    stream?.quality === 'hq' && snapshot.activeOutput
      ? `${outputLabel} • Go+ 256k`
      : outputLabel;

  const streamDetail = stream
    ? `${stream.quality === 'hq' ? 'Go+ HQ' : 'Standard'} ${String(stream.bitrateKbps)}k (${stream.preset}) • 44.1 kHz / 24-bit • 0 dB Bit-Perfect (Amp Volume)`
    : `${codecTag} • 44.1 kHz / 24-bit • 0 dB Bit-Perfect (Amp Volume)`;

  return {
    pillLabel,
    signalHeadline: outputLabel,
    signalDetail: streamDetail,
    tone: 'active',
    badgeText: stream?.quality === 'hq' ? 'HQ' : '0dB',
  };
}
