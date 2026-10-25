---
name: headless-receiver-ops
description: >-
  Build, inspect, deploy, and troubleshoot the SoundClud headless audio receiver
  daemon (`crates/receiver`), including macOS 12 Monterey Intel (`x86_64`) cross-builds,
  44.1 kHz Bit-Perfect `0 dB` CoreAudio/TOSLINK S/PDIF (`'spdf'`) persistent UID selection,
  optical carrier keepalive, Local HLS AES-128/fMP4 proxy, Wi-Fi resilience, and
  `launchd`/`systemd` services. Use when working on receiver audio, optical output,
  discovery, or daemon packaging.
---

# Headless Receiver Operations & Bit-Perfect CoreAudio/TOSLINK Guide

## Critical Hardware, Clocking & OS Invariants
1. **Late 2014 Intel Mac Mini (`Macmini7,1`)**:
   - Maximum official Apple OS is **macOS 12 Monterey**.
   - **Never invoke `brew`** in receiver install/setup scripts: Homebrew 4.4+ dropped Monterey bottles and triggers multi-hour source compilations.
   - Always compile `x86_64-apple-darwin` binaries with `MACOSX_DEPLOYMENT_TARGET=11.0` and provision standalone SHA-256-verified `mpv` binaries into `~/.local/share/soundclud/bin/`.
2. **True Bit-Perfect `0 dB` Default & `44,100 Hz` Physical TOSLINK Clock**:
   - Bind audio devices by **persistent CoreAudio UID** (`--audio-device=coreaudio/<UID>`), never numeric device index. On `AppleHDA`, Mini-TOSLINK insertion switches `BuiltInOutputDevice` data source FourCC to `'spdf'` ("Digital Out").
   - **Default Volume Mode = `bit_perfect` (`0 dB` Unity Gain)**: Lock `mpv` `volume=100` and `ao-volume=100` with zero DSP or active-playback dither so attenuation happens exclusively in the Hi-Fi amplifier (`software_24bit` remains an optional fallback toggle).
   - **Default Physical Sample Rate = `44,100 Hz` + `--coreaudio-change-physical-format=yes`**:
     - `99.99%` of SoundCloud tracks (`aac_256k` Go+ HQ, `aac_160k` SQ, `aac_96k`, `mp3_1_0`) are native **`44,100 Hz`**.
     - Passing `--audio-samplerate=44100 --coreaudio-change-physical-format=yes` switches `kAudioStreamPropertyPhysicalFormat` on the physical `'spdf'` optical substream to `44,100 Hz` (otherwise macOS `coreaudiod` silently resamples `44.1 -> 48 kHz`), restoring `original_asbd` cleanly on exit.
3. **Eliminating macOS TOSLINK Optical Sleep Pops & Wi-Fi Buffering**:
   - Keep `mpv` open with `--ao=coreaudio --idle=yes --keep-open=yes --audio-stream-silence=yes --gapless-audio=yes --cache=yes --demuxer-max-bytes=32MiB --cache-pause-initial=no`.
   - Seed idle carrier with `av://lavfi:anullsrc=r=44100:cl=stereo` (or idle-only `-120 dBFS` `anoisesrc=r=44100` when `spdif_dither_keepalive` is enabled—never mixed into active Bit-Perfect tracks) and hold `/usr/bin/caffeinate -s -w <pid>`.
4. **Local HLS Proxy (`127.0.0.1`) & Wi-Fi Security**:
   - Rewrite `#EXT-X-MAP`, `#EXT-X-KEY` (`METHOD=AES-128`), and segment URLs to loopback endpoints, caching `init.mp4` and 16-byte AES keys in session RAM.
   - Attach `client_id` / `track_authorization` / `secret_token` / `Authorization: OAuth <token>` **strictly** to `api-v2.soundcloud.com` (never to `*.soundcloud.cloud` or `*.sndcdn.com` signed CDN URLs).
   - Hold `oauthToken` in a RAM-only `RedactedSecret` (zeroed on disconnect; never logged or persisted to disk), and enforce `Host`/`Origin` + automatic TOFU client bearer token checks over Wi-Fi.

## Useful Verification Commands
```bash
MACOSX_DEPLOYMENT_TARGET=11.0 cargo build --release -p soundclud-receiver --target aarch64-apple-darwin
MACOSX_DEPLOYMENT_TARGET=11.0 cargo build --release -p soundclud-receiver --target x86_64-apple-darwin
system_profiler SPAudioDataType -json
```
