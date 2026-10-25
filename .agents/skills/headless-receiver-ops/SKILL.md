---
name: headless-receiver-ops
description: >-
  Build, inspect, deploy, and troubleshoot the SoundClud headless audio receiver
  daemon (`crates/receiver`), including macOS 12 Monterey Intel (`x86_64`) cross-builds,
  CoreAudio/TOSLINK S/PDIF (`'spdf'`) persistent UID selection, optical carrier
  keepalive, Bonjour/mDNS discovery, and `launchd`/`systemd` services. Use when
  working on receiver audio, optical output, discovery, or daemon packaging.
---

# Headless Receiver Operations & CoreAudio/TOSLINK Guide

## Critical Hardware & OS Invariants
1. **Late 2014 Intel Mac Mini (`Macmini7,1`)**:
   - Maximum official Apple OS is **macOS 12 Monterey**.
   - **Never invoke `brew`** in receiver install/setup scripts: Homebrew 4.4+ dropped Monterey bottles and triggers multi-hour source compilations.
   - Always compile `x86_64-apple-darwin` binaries with `MACOSX_DEPLOYMENT_TARGET=11.0` and provision standalone SHA-256-verified `mpv` binaries into `~/.local/share/soundclud/bin/`.
2. **CoreAudio TOSLINK S/PDIF Output**:
   - Bind audio devices by **persistent CoreAudio UID** (`--audio-device=coreaudio/<UID>`), never numeric device index.
   - On `AppleHDA`, Mini-TOSLINK insertion switches `BuiltInOutputDevice` data source FourCC to `'spdf'` ("Digital Out").
   - Lock output sample rate (`--audio-samplerate=48000`) so switching between 44.1 kHz AAC/MP3 and 48 kHz Opus tracks never causes external DAC PLL unlock dropouts.
3. **Eliminating macOS TOSLINK Optical Sleep Pops**:
   - Keep `mpv` open with `--ao=coreaudio --idle=yes --keep-open=yes --audio-stream-silence=yes --gapless-audio=yes`.
   - Seed idle carrier with `av://lavfi:anullsrc=r=48000:cl=stereo` (or `-120 dBFS` `anoisesrc` when `spdif_dither_keepalive` is enabled for amps with aggressive zero-PCM auto-mute relays).
   - Hold power assertion (`/usr/bin/caffeinate -s -w <pid>`) while active/keepalive is enabled.
4. **Bonjour / mDNS Registration on macOS**:
   - Register `_soundclud._tcp` and `soundclud.local` via Apple's native Bonjour (`dns-sd` / `DNSServiceRegister`) rather than binding a conflicting userspace socket directly to UDP `5353`.

## Useful Verification Commands
- Cross-check both macOS architectures locally:
  ```bash
  MACOSX_DEPLOYMENT_TARGET=11.0 cargo build --release -p soundclud-receiver --target aarch64-apple-darwin
  MACOSX_DEPLOYMENT_TARGET=11.0 cargo build --release -p soundclud-receiver --target x86_64-apple-darwin
  ```
- Inspect CoreAudio devices via `mpv` or `system_profiler`:
  ```bash
  system_profiler SPAudioDataType -json
  ```
