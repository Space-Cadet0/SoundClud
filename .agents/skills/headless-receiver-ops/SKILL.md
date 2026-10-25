---
name: headless-receiver-ops
description: >-
  Build, inspect, deploy, and troubleshoot the SoundClud receiver daemon
  (`crates/receiver`), including Use Case 1 (44.1 kHz Bit-Perfect `0 dB`
  CoreAudio/TOSLINK S/PDIF `'spdf'`) and Use Case 2 (Universal Denon/Marantz HEOS
  Direct Network `ACT-Denon:1` / UPnP `44.1 kHz / 24-bit` WAV streaming), macOS 12
  Monterey Intel (`x86_64`) cross-builds, Local HLS AES-128/fMP4 proxy, and
  `launchd`/`systemd` services. Use when working on receiver audio, TOSLINK, HEOS,
  discovery, or daemon packaging.
---

# Receiver Operations — CoreAudio/TOSLINK & Universal HEOS Direct Guide

## Critical Hardware, Backend Independence & OS Invariants
1. **Strict Backend Independence & `0 dB` Amp-Volume Law**:
   - `LocalMpvBackend` (Use Case 1: CoreAudio/TOSLINK/ALSA) and `HeosUpnpBackend` (Use Case 2: Denon/Marantz HEOS Direct Network) are **100% decoupled**: selecting TOSLINK never sends HEOS power/input commands, and selecting HEOS never opens CoreAudio devices.
   - **Both** backends operate strictly at **`0 dB` Bit-Perfect Unity Gain** (`44,100 Hz / 24-bit` PCM)—volume is adjusted exclusively via the physical Hi-Fi amplifier knob or remote (`HeosUpnpBackend` never calls `set_volume` or `RenderingControl::SetVolume`).
2. **Use Case 1 — `LocalMpvBackend` (2014 Mac Mini TOSLINK & Linux ALSA/PipeWire)**:
   - Late 2014 Intel Mac Minis (`Macmini7,1`) cap out at **macOS 12 Monterey** (never invoke `brew`; compile `x86_64-apple-darwin` with `MACOSX_DEPLOYMENT_TARGET=11.0` + standalone SHA-256-verified `mpv`).
   - Bind persistent CoreAudio UID (`--audio-device=coreaudio/<UID>`) with `--ao=coreaudio --audio-samplerate=44100 --coreaudio-change-physical-format=yes --volume=100 --idle=yes --keep-open=yes --audio-stream-silence=yes --gapless-audio=yes --cache=yes --demuxer-max-bytes=32MiB --cache-pause-initial=no`.
   - Seed idle carrier with `av://lavfi:anullsrc=r=44100:cl=stereo` + `caffeinate -s` to prevent macOS optical sleep pops.
3. **Use Case 2 — `HeosUpnpBackend` (Universal Denon/Marantz HEOS Direct Network)**:
   - Auto-discover any HEOS Built-in device on the LAN via SSDP (`urn:schemas-denon-com:device:ACT-Denon:1` / `AiosDevice:1`), mDNS (`_heos-audio._tcp`), and HEOS CLI (`TCP 1255` `heos://player/get_players`). Works whether `soundclud-receiver` runs on a LAN Mac Mini or locally on `127.0.0.1` on the user's laptop (zero `mpv` required in pure-Rust HEOS mode!).
   - Wake Host-MCU (`:23` `PWON\r` + `SINET\r`) before `ACT:1#SetDevicePowerState("ON")` (`:60006/ACT/control`) and wait for `heos://player/get_players` `pid` binding so AIOS bridges metadata and play state to the front OLED & MCU. Stream seekable **`0 dB` Uncompressed `SUBFRAME_VERBATIM` `44,100 Hz / 24-bit` Stereo FLAC (`audio/flac`)** (`/heos/{token}/stream.flac`) with `STREAMINFO.total_samples`, `SEEKTABLE`, and `VORBIS_COMMENT` (`TITLE`/`ARTIST`/`ALBUM`) + `DIDL-Lite` (`DLNA.ORG_OP=01`) so `GStreamer flacparse` reports exact finite `TrackDuration` (no `∞`) and in-band Title/Artist tags (no `""`), while maintaining `60s` `SLPOFF\r` + `heos://player/set_play_state=play` keepalives against 15-minute EU ErP Auto-Standby (never re-waking if `PW? == PWSTANDBY`).
   - Derive opaque `heos_<digest>` IDs from UDN/serial; never log or expose raw serials, MACs, or HEOS `service_username`s.
4. **Local HLS Proxy & Wi-Fi Security**:
   - Cache `#EXT-X-MAP` (`init.mp4`) and `#EXT-X-KEY` (`METHOD=AES-128`) in session RAM, refresh expiring CloudFront URLs transparently, attach `OAuth` strictly to `api-v2.soundcloud.com` (never `*.soundcloud.cloud`/`*.sndcdn.com`), hold `oauthToken` in RAM-only `RedactedSecret`, and enforce `Host`/`Origin` + TOFU bearer tokens.
