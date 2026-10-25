---
name: extension-maestro-dev
description: >-
  Develop, audit, and package the SoundClud Chromium Manifest V3 browser extension
  (`packages/extension`), including zero-friction SoundCloud Go+ `aac_256k` HQ
  stream selection, Maestro MSE virtualization, Widevine local fallback, macOS
  hardware media-key keepalive, MV3 service worker Wi-Fi WebSocket lifecycle, and
  Chrome Web Store metadata. Use whenever modifying `packages/extension/` or
  `CHROMEWEBSTORE.md`.
---

# SoundClud Chromium MV3 Extension & Go+ Maestro Virtualization Runbook

## Mandatory Prerequisites
Before editing any file in `packages/extension/`, read:
1. `chrome-extensions` skill (`~/.gemini/config/plugins/modern-web-guidance-plugin/skills/chrome-extensions/SKILL.md`)
2. `modern-web-guidance` skill (`~/.gemini/config/plugins/modern-web-guidance-plugin/skills/modern-web-guidance/SKILL.md`)

## Critical Chromium MV3 & SoundCloud Go+ Rules
1. **Chromium-Only Manifest V3 (`minimum_chrome_version: "116"`)**:
   - Target Chromium browsers exclusively (`Google Chrome`, `Brave`, `Arc`, `Edge`) — zero Firefox/Safari polyfill shims.
   - **Never** put `ws://*/*` or `wss://*/*` in `host_permissions` (use `"https://soundcloud.com/*"` + `"http://*/*"`), and **omit `"cookies"`** from `permissions` (unneeded because `oauth_token` and `api-v2` headers are accessible in `MAIN` world).
   - Every icon referenced in `manifest.json` must exist at exact pixel dimensions (`16x16`, `48x48`, `128x128`).
2. **Zero-Friction SoundCloud Go+ HQ Default (`MAIN` World)**:
   - SoundCloud Web defaults `localStorage["V2::local::settings"].streamingQuality` to `null` (`"sq"`), discarding `hq` client-side even though `api-v2.soundcloud.com` **always** returns `quality: "hq"` (`aac_256k`) in `media.transcodings[]` when authenticated with Go+.
   - Passively observe `window.__sc_hydration` (`apiClient.id`, `features`, `meUser`) + `api-v2` `Authorization: OAuth <token>` / `document.cookie` `oauth_token` (including dynamic JWT refreshes and mid-session logins) with **zero separate SoundClud login screen**. Keep auth strictly in `chrome.storage.session`.
   - When `features` includes `"hq_audio"` and `V2::local::settings` `streamingQuality` is unset/`null`, promote it to `"hq"` so even local playback defaults to Go+ HQ.
   - **Stream Ranking**: Reject broken `abr_*` stubs (`preset.startsWith("abr")`) and CENC DRM (`ctr-encrypted-hls`, `cbc-encrypted-hls`). Accept `format.protocol` in `["hls", "encrypted-hls", "progressive"]` (`hls` > `encrypted-hls` > `progressive`), ranking:
     `aac_256k` (`hq` 256k @ 44.1 kHz) > `aac_160k` (`sq` 160k @ 44.1 kHz) > `mp3_*` (`128k`) > `aac_96k` (`lq` 96k) > `opus_0_0` (`64k`).
   - Only reuse an in-tab `.m3u8` in `load_track` when its transcoding URL matches our top-ranked transcoding (never feed Maestro's `sq` `.m3u8` when `hq` is available!).
   - **Mixed-Queue Widevine Fallback (`drm_local_fallback`)**: Never play a 30s `snipped` preview when a major-label track offers *only* `ctr-`/`cbc-encrypted-hls` full streams; let Maestro play that single track locally (`Widevine DRM • Playing Locally`) and automatically resume Receiver handoff on the next non-DRM track.
3. **3-World Isolation, Wi-Fi Resilience & Hardware Media Keys**:
   - All LAN `http://` and `ws://` calls live strictly in the MV3 Service Worker (`chrome.storage.local` for receiver config + TOFU bearer token, `Promise.any` race between `hostname.local` and cached unicast LAN IP so Wi-Fi mDNS multicast packet loss never delays reconnects, 20s WS pings).
   - Virtualize `HTMLAudioElement` + `SourceBuffer.buffered` cleanly after initial `sourceopen`, and loop an in-memory 10s 8 kHz `-100 dBFS` PCM WAV (`muted = false`, `volume = 0.01`, `__soundcludKeepalive = true`) so Chromium routes MacBook Air hardware Play/Pause/Next/Prev keys.
   - Keep `CHROMEWEBSTORE.md` synchronized whenever permissions or user-facing features change.
