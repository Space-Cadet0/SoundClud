<div align="center">

# SoundClud

**Zero-compromise `0 dB` Bit-Perfect SoundCloud handoff from your native Chromium UI to TOSLINK Hi-Fi receivers and Denon/Marantz HEOS amplifiers.**

[![CI](https://img.shields.io/github/actions/workflow/status/Space-Cadet0/SoundClud/ci.yml?branch=main&style=for-the-badge&label=CI)](https://github.com/Space-Cadet0/SoundClud/actions)
[![Receiver](https://img.shields.io/badge/Receiver-macOS%2012%2B%20%7C%20Linux-111827?style=for-the-badge)](./docs/ARCHITECTURE_SPEC.md)
[![HEOS](https://img.shields.io/badge/HEOS%20Direct-Denon%20%7C%20Marantz-b45309?style=for-the-badge)](./docs/ARCHITECTURE_SPEC.md)
[![Extension](https://img.shields.io/badge/Chromium-Manifest%20V3-ff5500?style=for-the-badge)](./docs/ARCHITECTURE_SPEC.md)
[![Audio](https://img.shields.io/badge/PCM-44.1kHz%200dB%20Bit--Perfect-0ea5e9?style=for-the-badge)](./docs/ARCHITECTURE_SPEC.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-22c55e?style=for-the-badge)](./LICENSE)

</div>

---

## Overview

**SoundClud** lets you browse, queue, scrub waveforms, and press hardware media keys directly inside the native first-party `soundcloud.com` web interface in Chromium (`Chrome`, `Brave`, `Arc`, `Edge`)—while offloading 100% of stream fetching, decoding, and **`0 dB` Bit-Perfect (`44.1 kHz / 24-bit`)** audio output to either:
1. **Headless Optical TOSLINK / CoreAudio / ALSA** (`LocalMpvBackend`, e.g., a Mac Mini wired via Mini-TOSLINK S/PDIF), or
2. **Denon / Marantz HEOS Built-In Amplifiers & Speakers Directly Over LAN** (`HeosUpnpBackend`, e.g., Marantz PM7000N — auto-waking from Network Standby, displaying live Track/Artist titles on the front OLED, and streaming asynchronous `44.1 kHz / 24-bit` `0 dB` PCM with **zero** remote volume mutations).

Read the full first-principles specification in **[`docs/ARCHITECTURE_SPEC.md`](./docs/ARCHITECTURE_SPEC.md)**.

---

## Architectural Highlights

1. **Always-Default SoundCloud Go+ High Quality (`256 kbps` AAC) With Zero Separate Login**:
   - Piggybacks seamlessly and ephemereally on your existing `soundcloud.com` login session (`chrome.storage.session` + `RedactedSecret` RAM-only on receiver; zero `"cookies"` permission, zero credentials written to disk).
   - Overrides SoundCloud Web's client-side `sq` default to automatically select **`aac_256k` (`quality: "hq"`, 256 kbps AAC-LC @ 44.1 kHz)** over `hls` and `encrypted-hls` (`AES-128`), with automatic local fallback (`drm_local_fallback`) for single Widevine-only tracks so mixed queues never stall.
2. **Dual Strictly Independent `0 dB` Bit-Perfect Output Backends**:
   - **Use Case 1 (`LocalMpvBackend`)**: Physical `44,100 Hz` CoreAudio format locking (`--coreaudio-change-physical-format=yes`), `0 dB` unity gain, and continuous idle optical S/PDIF carrier keepalive (`anullsrc`).
   - **Use Case 2 (`HeosUpnpBackend`)**: Zero-config SSDP/mDNS/HEOS CLI discovery (`ACT-Denon:1` / `TCP 1255`), hands-free Network Standby auto-wake (`ACT:1#SetDevicePowerState`), `DIDL-Lite` front-OLED metadata, and pure-Rust `44,100 Hz / 24-bit` `0 dB` WAV HTTP streaming (`~350–650 ms` warm start & byte-range scrub)—working on a LAN Mac Mini or locally on `127.0.0.1` on your laptop with **amp-knob/remote-only volume** across both modes.
3. **Long-Mix HLS Refresh & AES-128 Session Cache**:
   - Caches `#EXT-X-MAP` (`init.mp4`) and `#EXT-X-KEY` (`AES-128`) in RAM while transparently refreshing expiring CloudFront signatures—eliminating mid-set `HTTP 403` dropouts across 1–3 hour DJ mixes.
4. **3-World Chromium Manifest V3 & Maestro MSE Virtualization**:
   - Virtualizes SoundCloud's **Maestro** `HTMLAudioElement` + `MediaSource` buffer state so native waveform scrubbing, elapsed timers, and playlist/station auto-advance work seamlessly with zero local audio decode, while preserving MacBook hardware Play/Pause/Next/Prev media keys (`navigator.mediaSession`).

---

## Repository Layout

```text
SoundClud/
├── AGENTS.md                        # Always-on workspace engineering & portability laws
├── .agents/                         # Specialist subagents, workflow skills & session hooks
├── docs/
│   └── ARCHITECTURE_SPEC.md         # Full technical specification & wire protocol (v1.2)
├── crates/
│   └── receiver/                    # Rust receiver gateway (`LocalMpvBackend` + `HeosUpnpBackend`)
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
