---
name: extension-maestro-dev
description: >-
  Develop, audit, and package the SoundClud Manifest V3 browser extension
  (`packages/extension`), including SoundCloud Maestro MSE virtualization,
  stream-locator capture, macOS hardware media-key keepalive, MV3 service worker
  LAN WebSocket lifecycle, and Chrome Web Store metadata. Use whenever modifying
  `packages/extension/` or `CHROMEWEBSTORE.md`.
---

# SoundClud MV3 Extension & Maestro Virtualization Runbook

## Mandatory Prerequisites
Before editing any file in `packages/extension/`, read:
1. `chrome-extensions` skill (`~/.gemini/config/plugins/modern-web-guidance-plugin/skills/chrome-extensions/SKILL.md`)
2. `modern-web-guidance` skill (`~/.gemini/config/plugins/modern-web-guidance-plugin/skills/modern-web-guidance/SKILL.md`)

## Critical MV3 & SoundCloud Maestro Rules
1. **`manifest.json` Match Schemes**:
   - **Never** put `ws://*/*` or `wss://*/*` in `host_permissions` (Chrome rejects `ws` schemes at extension load). Use `"https://soundcloud.com/*"` + `"http://*/*"` (or scoped HTTP patterns), which covers both `fetch('http://...')` and `new WebSocket('ws://...')` in the Service Worker.
   - Every icon referenced in `manifest.json` must exist at exact pixel dimensions (`16x16`, `48x48`, `128x128`).
2. **3-World Security & Isolation**:
   - **All LAN `http://` and `ws://` calls live strictly in the MV3 Service Worker** (never in `MAIN` or `ISOLATED` content scripts, where Mixed Content, Chrome Local Network Access, and Brave Shields block them).
   - `MAIN` <-> `ISOLATED` world events must validate a per-page cryptographic nonce generated at `document_start`.
   - Service Worker state must persist in `chrome.storage.local` / `chrome.storage.session` (never rely solely on ephemeral SW globals), with 20-second WebSocket heartbeat pings while connected.
3. **Clean Maestro Virtualization (`MAIN` World)**:
   - Filter `media.transcodings[]` to `format.protocol === "hls"` (or `"progressive"`), explicitly skipping Widevine/EME encrypted `"cbc-encrypted-hls"` and `"ctr-encrypted-hls"`. Rank quality: `hq` (`aac_256k`) > `aac_160k` > `mp3_1_0` > `aac_96k` > `opus_0_0`.
   - Never feed corrupt/empty bytes into `SourceBuffer` (triggers `MEDIA_ERR_DECODE`). Keep `nativeAudio` paused in C++ after initial `sourceopen`, virtualize `paused`/`currentTime`/`seeking`/`buffered` from Receiver WS state ticks, and fire native `ended` on receiver `eof` so SoundCloud's queue auto-advances seamlessly.
4. **Hardware Media Keys (`navigator.mediaSession`)**:
   - Drive an in-memory 10-second 8 kHz `-100 dBFS` PCM WAV loop (`muted = false`, `volume = 0.01`, `__soundcludKeepalive = true`) in lockstep with remote play/pause so Chromium routes MacBook Air hardware Play/Pause/Next/Prev keys and macOS Control Center Now Playing to SoundCloud's native handlers.
5. **Store Readiness**:
   - Keep `CHROMEWEBSTORE.md` synchronized whenever `manifest.json` permissions or user-facing features change.
