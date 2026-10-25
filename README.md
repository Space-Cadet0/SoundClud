<div align="center">

# SoundClud

**Zero-compromise SoundCloud handoff playback from your native browser UI to a headless Hi-Fi receiver.**

[![CI](https://img.shields.io/github/actions/workflow/status/Space-Cadet0/SoundClud/ci.yml?branch=main&style=for-the-badge&label=CI)](https://github.com/Space-Cadet0/SoundClud/actions)
[![Receiver](https://img.shields.io/badge/Receiver-macOS%2012%2B%20%7C%20Linux-111827?style=for-the-badge)](./docs/ARCHITECTURE_SPEC.md)
[![Extension](https://img.shields.io/badge/Extension-Manifest%20V3-ff5500?style=for-the-badge)](./docs/ARCHITECTURE_SPEC.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e?style=for-the-badge)](./LICENSE)

</div>

---

## Overview

**SoundClud** lets you browse, queue, scrub waveforms, and use hardware media keys directly inside the native first-party `soundcloud.com` web interface on your client machine—while offloading 100% of audio stream fetching, decoding, and bit-accurate CoreAudio / TOSLINK S/PDIF / PipeWire / ALSA playback to a headless media receiver on your local network (without AirPlay resampling, Bluetooth compression, or local browser CPU decode).

Read the full first-principles specification in **[`docs/ARCHITECTURE_SPEC.md`](./docs/ARCHITECTURE_SPEC.md)**.

---

## Architectural Highlights

1. **Sub-200ms Browser Stream-Locator Handoff + Local HLS Refresh Proxy**:
   - Captures authenticated `api-v2` unencrypted HLS stream locators directly from your active SoundCloud session (supporting unauthenticated, Free, Go+ AAC, and private secret-link tracks with zero `yt-dlp` cold-start lag).
   - Routes playback through an embedded `127.0.0.1` HLS Refresh Proxy on the receiver that transparently refreshes short-lived CloudFront segment signatures—eliminating mid-set `HTTP 403` dropouts across 1–3 hour DJ mixes and long pauses.
2. **3-World Manifest V3 Extension & Maestro MSE Virtualization**:
   - Cleanly virtualizes SoundCloud's **Maestro** `HTMLAudioElement` + `MediaSource` buffer state so native waveform scrubbing, elapsed timers, and playlist/station auto-advance work seamlessly with zero local audio decode, while preserving MacBook hardware Play/Pause/Next/Prev media keys (`navigator.mediaSession`).
3. **Zero-Config Bonjour / mDNS Discovery**:
   - Automatic `.local` advertisement and LAN peer-gossip directory (`/api/v1/discover`)—auto-connecting on single-receiver networks and offering a 1-click picker when multiple receivers exist, with zero hardcoded static IPs.
4. **Hi-Fi Optical TOSLINK S/PDIF & macOS 12 Monterey+ Portability**:
   - Single static Rust daemon (`soundclud-receiver`) targeting `MACOSX_DEPLOYMENT_TARGET=11.0` (`x86_64` Intel including Late 2014 Mac Mini + `aarch64` Apple Silicon) and Linux (`x86_64` / `aarch64`) with checksum-verified standalone `mpv` provisioning (zero Homebrew or Python runtime requirement).
   - Binds persistent CoreAudio device UIDs at fixed `24-bit / 48 kHz` with continuous optical S/PDIF carrier keepalive to eliminate macOS TOSLINK sleep pops and DAC re-lock clipping.

---

## Repository Layout

```text
SoundClud/
├── AGENTS.md                        # Always-on workspace engineering & portability laws
├── .agents/                         # Specialist subagents, workflow skills & session hooks
├── docs/
│   └── ARCHITECTURE_SPEC.md         # Full technical specification & wire protocol (v1)
├── crates/
│   └── receiver/                    # Rust headless receiver daemon (`soundclud-receiver`)
├── packages/
│   ├── protocol/                    # Shared TypeScript / wire protocol v1 contracts
│   └── extension/                   # Manifest V3 browser extension (Chrome/Brave/Edge/Firefox)
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
