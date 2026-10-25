<div align="center">

# SoundClud

**Zero-compromise Bit-Perfect SoundCloud handoff playback from your native Chromium UI to a headless Hi-Fi receiver.**

[![CI](https://img.shields.io/github/actions/workflow/status/Space-Cadet0/SoundClud/ci.yml?branch=main&style=for-the-badge&label=CI)](https://github.com/Space-Cadet0/SoundClud/actions)
[![Receiver](https://img.shields.io/badge/Receiver-macOS%2012%2B%20%7C%20Linux-111827?style=for-the-badge)](./docs/ARCHITECTURE_SPEC.md)
[![Extension](https://img.shields.io/badge/Chromium-Manifest%20V3-ff5500?style=for-the-badge)](./docs/ARCHITECTURE_SPEC.md)
[![Audio](https://img.shields.io/badge/TOSLINK-44.1kHz%200dB%20Bit--Perfect-0ea5e9?style=for-the-badge)](./docs/ARCHITECTURE_SPEC.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e?style=for-the-badge)](./LICENSE)

</div>

---

## Overview

**SoundClud** lets you browse, queue, scrub waveforms, and use hardware media keys directly inside the native first-party `soundcloud.com` web interface in Chromium (`Chrome`, `Brave`, `Arc`, `Edge`)—while offloading 100% of audio stream fetching, decoding, and **Bit-Perfect `0 dB` (`44.1 kHz`) CoreAudio / TOSLINK S/PDIF / PipeWire / ALSA** playback to a headless media receiver over Wi-Fi or Ethernet (without AirPlay resampling, Bluetooth compression, or local browser CPU decode).

Read the full first-principles specification in **[`docs/ARCHITECTURE_SPEC.md`](./docs/ARCHITECTURE_SPEC.md)**.

---

## Architectural Highlights

1. **Always-Default SoundCloud Go+ High Quality (`256 kbps` AAC) With Zero Separate Login**:
   - Piggybacks seamlessly and ephemereally on your existing `soundcloud.com` login session (`chrome.storage.session` + `RedactedSecret` RAM-only on receiver; zero `"cookies"` permission, zero credentials written to disk).
   - Overrides SoundCloud Web's client-side `sq` default to automatically select **`aac_256k` (`quality: "hq"`, 256 kbps AAC-LC @ 44.1 kHz)** over `hls` and `encrypted-hls` (`AES-128`), with automatic local fallback (`drm_local_fallback`) for single Widevine-only tracks so mixed queues never stall.
2. **Embedded `127.0.0.1` Local HLS Refresh & AES-128 Proxy**:
   - Rewrites `#EXT-X-MAP` (`init.mp4`), `#EXT-X-KEY` (`AES-128`), and media segments to loopback endpoints, caching `init.mp4` and keys in RAM while transparently refreshing expiring CloudFront signatures—eliminating mid-set `HTTP 403` dropouts across 1–3 hour DJ mixes.
3. **3-World Chromium Manifest V3 & Maestro MSE Virtualization**:
   - Virtualizes SoundCloud's **Maestro** `HTMLAudioElement` + `MediaSource` buffer state so native waveform scrubbing, elapsed timers, and playlist/station auto-advance work seamlessly with zero local audio decode, while preserving MacBook hardware Play/Pause/Next/Prev media keys (`navigator.mediaSession`).
4. **Wi-Fi Resilient Zero-Config Discovery & True `44.1 kHz` `0 dB` TOSLINK**:
   - Native Bonjour/mDNS + peer directory (`/api/v1/discover`), unicast `.local` + cached IP racing, `32 MiB` receiver RAM buffering, and automatic Trust-On-First-Use (TOFU) bearer-token security over Wi-Fi.
   - Single static Rust daemon (`soundclud-receiver`) targeting `MACOSX_DEPLOYMENT_TARGET=11.0` (`x86_64` Late 2014 Mac Mini + `aarch64` Apple Silicon + Linux) with standalone SHA-256-verified `mpv` (zero Homebrew/Python dependency), physical `44,100 Hz` CoreAudio format locking (`--coreaudio-change-physical-format=yes`), `0 dB` Bit-Perfect output, and continuous optical S/PDIF carrier keepalive.

---

## Repository Layout

```text
SoundClud/
├── AGENTS.md                        # Always-on workspace engineering & portability laws
├── .agents/                         # Specialist subagents, workflow skills & session hooks
├── docs/
│   └── ARCHITECTURE_SPEC.md         # Full technical specification & wire protocol (v1.1)
├── crates/
│   └── receiver/                    # Rust headless receiver daemon (`soundclud-receiver`)
├── packages/
│   ├── protocol/                    # Shared TypeScript / wire protocol v1 contracts
│   └── extension/                   # Chromium Manifest V3 extension (Chrome/Brave/Arc/Edge)
├── packaging/                       # Zero-Homebrew installers & launchd/systemd units
├── scripts/                         # Zero-PII hygiene scanner & checkpoint utilities
└── tests/                           # 100% offline deterministic Vitest & static invariant gates
```

---

## Development & Verification

```bash
# Install workspace tooling & activate .githooks/pre-commit
npm install

# Run full Zero-PII hygiene, strict TypeScript, offline Vitest & Rust Clippy/test suite
npm run verify
```

---

## License

Released under the [MIT License](./LICENSE).
