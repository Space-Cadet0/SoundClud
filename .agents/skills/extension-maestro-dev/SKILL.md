---
name: extension-maestro-dev
description: >-
  Develop, audit, and package the SoundClud Chromium Manifest V3 browser extension
  (`packages/extension`), including zero-friction SoundCloud Go+ `aac_256k` HQ
  stream selection, Maestro MSE virtualization, unified TOSLINK + HEOS Direct
  output selection, Widevine local fallback, macOS hardware media-key keepalive,
  and Chrome Web Store metadata. Use whenever modifying `packages/extension/` or
  `CHROMEWEBSTORE.md`.
---

# SoundClud Chromium MV3 Extension, Go+ HQ & Multi-Output Runbook

## Mandatory Prerequisites
Before editing any file in `packages/extension/`, read:
1. `chrome-extensions` skill (`~/.gemini/config/plugins/modern-web-guidance-plugin/skills/chrome-extensions/SKILL.md`)
2. `modern-web-guidance` skill (`~/.gemini/config/plugins/modern-web-guidance-plugin/skills/modern-web-guidance/SKILL.md`)

## Critical Chromium MV3, Go+ HQ & Multi-Output Rules
1. **Chromium-Only Manifest V3 (`minimum_chrome_version: "116"`)**:
   - Target Chromium browsers exclusively (`Google Chrome`, `Brave`, `Arc`, `Edge`) — zero Firefox/Safari polyfill shims.
   - **Never** put `ws://*/*` or `wss://*/*` in `host_permissions` (use `"https://soundcloud.com/*"` + `"http://*/*"`), and **omit `"cookies"`** from `permissions`.
   - Every icon referenced in `manifest.json` must exist at exact pixel dimensions (`16x16`, `48x48`, `128x128`).
2. **Zero-Friction SoundCloud Go+ HQ Default (`MAIN` World)**:
   - Passively observe `window.__sc_hydration` (`apiClient.id`, `features`, `meUser`) + `api-v2` `Authorization: OAuth <token>` / `document.cookie` `oauth_token` (including JWT refreshes and mid-session logins) with **zero separate login UI**. Store auth strictly in `chrome.storage.session`.
   - Promote `V2::local::settings.streamingQuality` to `"hq"` when `"hq_audio"` is present and unset.
   - **Stream Ranking**: Reject `preset.startsWith("abr")` and CENC DRM (`ctr-encrypted-hls`, `cbc-encrypted-hls`). Accept `["hls", "encrypted-hls", "progressive"]` (`hls` > `encrypted-hls` > `progressive`), ranking `aac_256k` (`hq` 256k @ 44.1 kHz) > `aac_160k` (`sq`) > `mp3_*` (`128k`) > `aac_96k` (`lq`) > `opus_0_0` (`64k`). Only reuse an in-tab `.m3u8` if it matches our #1 ranked transcoding.
   - **Widevine Fallback (`drm_local_fallback`)**: Play CENC-only major-label tracks locally (`Widevine DRM • Playing Locally`) and auto-resume remote handoff on the next non-DRM track.
3. **Unified Multi-Output Picker (`CoreAudio/TOSLINK` + `HEOS Direct`)**:
   - Probe `http://127.0.0.1:9876/api/v1/discover`, `http://soundclud.local:9876/api/v1/discover`, and cached LAN unicast endpoints (`Promise.any`) so users running `soundclud-receiver` on either a headless Mac Mini or locally on their laptop see all **CoreAudio/TOSLINK** and **Denon/Marantz HEOS** outputs in a single 1-click selector.
   - Adapt waveform scrub debounce dynamically from output capabilities (`60 ms` for local `mpv` TOSLINK; `180 ms` for HEOS UPnP network streaming), display `Waking Amplifier...` during cold HEOS standby wake, and show `0 dB Bit-Perfect (Amp Volume)` on both TOSLINK and HEOS (never forwarding browser volume changes as remote amp mutations).
4. **Maestro Virtualization & Hardware Media Keys**:
   - Virtualize `HTMLAudioElement` + `SourceBuffer.buffered` cleanly after initial `sourceopen`, and loop an in-memory 10s 8 kHz `-100 dBFS` PCM WAV (`muted = false`, `volume = 0.01`, `__soundcludKeepalive = true`) so Chromium routes MacBook hardware Play/Pause/Next/Prev keys.
   - Keep `CHROMEWEBSTORE.md` synchronized whenever permissions or user-facing features change.
