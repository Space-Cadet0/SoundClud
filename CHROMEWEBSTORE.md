# Chrome Web Store Listing & Security Review Dossier — SoundClud

> Last Updated: 2026-10-25

---

## Store Listing

**Extension Name** `[REQUIRED — matches manifest.json "name" verbatim (46/75 chars)]`

`SoundClud — Bit-Perfect TOSLINK & HEOS Handoff`

**Short Description** `[REQUIRED — matches manifest.json "description" verbatim (131/132 chars)]`

`Stream SoundCloud Go+ 256 kbps HQ audio bit-perfectly at 44.1 kHz / 0 dB to optical TOSLINK DACs and Denon/Marantz HEOS amplifiers.`

**Detailed Description** `[REQUIRED — plain-text store copy, user-benefit focused, 0 implementation jargon]`

```text
Stream music from soundcloud.com in 0 dB bit-perfect 44.1 kHz Hi-Fi quality to optical TOSLINK DACs and Denon or Marantz HEOS network amplifiers while keeping full control inside the native SoundCloud player.

FEATURES
• Dual 0 dB Bit-Perfect Outputs — Send bit-perfect 44,100 Hz / 24-bit digital audio either to a dedicated optical TOSLINK / USB DAC receiver or directly over Wi-Fi and Ethernet to any Denon or Marantz HEOS Built-in amplifier or speaker.
• Automatic SoundCloud Go+ 256 kbps HQ Quality — Automatically selects the highest available stream quality (including 256 kbps AAC High Quality for SoundCloud Go+ listeners) with no separate sign-in window required.
• Native SoundCloud Controls & Waveform Scrubbing — Play, pause, skip tracks, queue playlists, scrub multi-hour DJ mixes on the SoundCloud waveform, and use your keyboard media keys with instant response.
• Hands-Free Amplifier Auto-Wake & Front-Panel Display — Automatically wakes compatible Denon and Marantz HEOS amplifiers from network standby on Play and shows live track title, artist, and elapsed time on the amplifier display.
• Pure Amplifier Volume Integrity — Locks digital audio output at 0 dB unity gain so volume is controlled exclusively at your physical Hi-Fi amplifier knob or remote.
• Seamless Protected-Track Fallback — Plays DRM-restricted tracks locally in your browser automatically and resumes Hi-Fi receiver output on the next track in your queue.

HOW TO USE
1. Install and start the open-source SoundClud Receiver app on your local computer (127.0.0.1:9876) or a headless Mac / Linux Hi-Fi server on your home network (soundclud.local:9876).
2. Open https://soundcloud.com in Chrome, Brave, Arc, or Edge.
3. Click the SoundClud toolbar icon or the Hi-Fi output pill in the SoundCloud player bar and choose your Optical TOSLINK DAC or Denon/Marantz HEOS amplifier.
4. Press Play on any track, playlist, or mix and adjust listening volume on your amplifier.

PRIVACY & LOCAL-ONLY DESIGN
SoundClud runs entirely between your browser and your own local SoundClud Receiver on your computer or home network. SoundClud operates zero cloud servers, collects zero analytics or telemetry, never sells or shares data, and requires no separate account login.

DISCLAIMER
SoundClud is an independent open-source Hi-Fi audio companion project and is not affiliated with, endorsed by, or sponsored by SoundCloud, Denon, or Marantz.

SUPPORT
Documentation, receiver installers, and issue tracker: https://github.com/Space-Cadet0/SoundClud/issues

Version 0.1.0 — Initial Manifest V3 release with Optical TOSLINK and Denon/Marantz HEOS Direct 44.1 kHz / 24-bit 0 dB playback.
```

**Category** `[REQUIRED]`

`Fun` *(or `Productivity`)*

**Single Purpose** `[REQUIRED — Developer Dashboard Single-Purpose Statement]`

Offloads first-party `soundcloud.com` audio playback to a user-operated `0 dB` Bit-Perfect Optical TOSLINK DAC receiver or Denon/Marantz HEOS Direct network amplifier on loopback (`127.0.0.1`) or the local home network.

**Primary Language** `[REQUIRED]`

`English`

**Minimum Browser Version**

Chromium `116+` (`manifest_version: 3`, `minimum_chrome_version: "116"` — Google Chrome, Brave, Arc, Microsoft Edge).

---

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Toolbar Icon (16px) | 16×16 PNG | ✅ Bundled in build | `icons/icon-16.png` |
| Extension Management Icon (48px) | 48×48 PNG | ✅ Bundled in build | `icons/icon-48.png` |
| Store Icon `[REQUIRED]` | 128×128 PNG | ✅ Bundled in build | `icons/icon-128.png` |
| Screenshot 1 `[REQUIRED]` | 1280×800 PNG | ⬜ Capture prior to CWS upload | `store-assets/screenshot-1-player-cast-pill.png` |
| Screenshot 2 `[RECOMMENDED]` | 1280×800 PNG | ⬜ Capture prior to CWS upload | `store-assets/screenshot-2-unified-output-picker.png` |
| Screenshot 3 `[RECOMMENDED]` | 1280×800 PNG | ⬜ Capture prior to CWS upload | `store-assets/screenshot-3-go-plus-hq-badge.png` |
| Small Promo Tile `[RECOMMENDED]` | 440×280 PNG | ⬜ Optional | `store-assets/promo-small-440x280.png` |

### Screenshot Capture Guide
1. **Screenshot 1 (`1280×800`)**: `soundcloud.com` bottom playback bar showing the active SoundClud Cast Pill (`0 dB Bit-Perfect • 44.1 kHz`) while scrubbing a track waveform.
2. **Screenshot 2 (`1280×800`)**: Extension popup Output Picker listing discovered Optical TOSLINK (`CoreAudio / S/PDIF 44.1 kHz 0 dB`) and Denon/Marantz HEOS Direct (`HEOS 44.1 kHz / 24-bit 0 dB`) targets.
3. **Screenshot 3 (`1280×800`)**: Mixed-queue status indicator showing Go+ `256 kbps` AAC HQ active telemetry and automatic local browser fallback notice on CENC-protected tracks.

---

## Permissions Justification

Every permission in `packages/extension/manifest.json` is strictly scoped to SoundClud's single purpose. Copy these exact plain-English justifications into the Chrome Web Store Developer Dashboard:

| Permission / Match Pattern | Manifest Key | Reviewer Justification |
|----------------------------|--------------|------------------------|
| `storage` | `permissions` | Stores the user's selected audio output device ID, local receiver endpoint (`127.0.0.1:9876` or `soundclud.local:9876`), and Trust-On-First-Use (TOFU) pairing token in `chrome.storage.local` across service worker restarts, while holding active playback/session state strictly in volatile `chrome.storage.session` RAM (automatically cleared when the browser closes). `chrome.storage.sync` is never used, so zero settings leave the device. |
| `alarms` | `permissions` | Schedules lightweight periodic Manifest V3 service worker health checks and WebSocket keepalive ticks while remote Hi-Fi playback is active, replacing non-persistent timers without keeping an idle background process running when playback is stopped. |
| `https://soundcloud.com/*` | `host_permissions` & `content_scripts` | Injects the SoundClud player virtualization bridge and Shadow DOM output selector pill exclusively on first-party `soundcloud.com` pages so play, pause, track transitions, hardware media keys, and waveform scrubbing stay synchronized with the selected Optical TOSLINK or HEOS amplifier output. |
| `https://*.soundcloud.com/*` | `host_permissions` | Observes first-party SoundCloud API v2 (`api-v2.soundcloud.com`) track transcoding descriptors (`media.transcodings[]`) during user-initiated playback on `soundcloud.com` to select the highest non-DRM stream tier (`aac_256k` Go+ HQ) and forward refreshing HLS stream locators to the user's local receiver. |
| `http://*/*` | `host_permissions` | Connects over local HTTP (`/api/v1/discover`, `/api/v1/status`, `/api/v1/config`) and upgraded local WebSocket (`/api/v1/ws` on default port `9876`) to the user's own `soundclud-receiver` daemon running on loopback (`http://127.0.0.1:9876`) or on an arbitrary DHCP-assigned private home-LAN host (`http://soundclud.local:9876` or user-paired LAN receiver IP). Note: Manifest V3 requires HTTP match patterns rather than `ws://` schemes in `host_permissions`, and private LAN receiver addresses cannot be enumerated statically at build time. |

---

## Explicit Security & Privacy Guarantees

1. **Zero `"cookies"` Permission**: SoundClud deliberately omits `"cookies"` from `manifest.json`. It never reads browser cookie jars across sites and requires zero separate SoundCloud login form.
2. **RAM-Only Ephemeral Session Handling (`chrome.storage.session`)**: Ephemeral `soundcloud.com` playback authorization context observed on an active SoundCloud tab is held strictly in volatile memory (`chrome.storage.session` in Chromium RAM and `RedactedSecret` session RAM on the user's local receiver), zeroed on `stop`/disconnect, and **never** written to disk, `localStorage`, `chrome.storage.local`, `chrome.storage.sync`, or logs.
3. **Zero Remote Code Execution**: 100% of executable JavaScript, HTML, and CSS is statically bundled inside the extension package (`dist/soundclud-extension-v*.zip`). Zero external scripts, CDNs, `eval()`, or `new Function()` calls exist anywhere in the codebase.
4. **Zero External Analytics, Telemetry, or Developer Servers**: SoundClud operates **no** backend cloud infrastructure, crash reporters, analytics SDKs, or tracking beacons. Network communication occurs exclusively with `soundcloud.com` / `*.soundcloud.com` (first-party playback page) and the user's own local TOFU-authenticated `soundclud-receiver` instance on loopback (`127.0.0.1`) or local LAN.
5. **Zero-PII Repository & Runtime Policy**: Enforced on every commit and CI run via `npm run check:hygiene`. Device identifiers for Denon/Marantz HEOS players use one-way salted SHA-256 opaque digests (`heos_<16-hex>`); raw hardware serial numbers, MAC addresses, and account identifiers are never persisted or exposed.

---

## Privacy & Data Use (Chrome Web Store Disclosure Form Mapping)

### Data Collection

**Does the extension collect or transmit user data to external developer or third-party servers?** **No**

| Data Type | Collected Off-Device? | Transmitted to Developer / Third Parties? | Local On-Device / Local-LAN Handling | Shared with Third Parties? |
|-----------|-----------------------|-------------------------------------------|--------------------------------------|---------------------------|
| Personally identifiable info | No | No | Never collected or stored. | No |
| Health info | No | No | Not applicable. | No |
| Financial info | No | No | Not applicable. | No |
| Authentication info | No (ephemeral local handoff only) | No | Active SoundCloud playback authorization header/session context is held exclusively in volatile RAM (`chrome.storage.session`) during active remote playback and forwarded solely to the user's own local TOFU-paired `soundclud-receiver` on `127.0.0.1` or private home LAN so the receiver can fetch authorized Go+ HLS segments directly from `api-v2.soundcloud.com`. Cleared immediately on stop or browser exit. | No |
| Personal communications | No | No | Not applicable. | No |
| Location | No | No | Not applicable. | No |
| Web history | No | No | Never accessed; content scripts run solely on `https://soundcloud.com/*`. | No |
| User activity | No | No | Play/pause/scrub commands on `soundcloud.com` are sent only to the user's local audio receiver. | No |
| Website content | No | No | Currently playing SoundCloud track title, artist, artwork URL, and HLS stream locator are sent only to the user's local audio receiver (and local HEOS amplifier OLED over LAN UPnP). | No |

### Data Use Certification
- [x] Data is NOT sold to third parties, outside of approved use cases
- [x] Data is NOT used or transferred for purposes unrelated to the item's single purpose
- [x] Data is NOT used or transferred to determine creditworthiness or for lending purposes

---

## Privacy Policy

**Recommended Hosted Privacy Policy URL** `[REQUIRED FOR SUBMISSION]`

`https://github.com/Space-Cadet0/SoundClud/blob/main/CHROMEWEBSTORE.md#published-privacy-policy-text`
*(Or publish the exact section below via GitHub Pages prior to submitting in the Chrome Developer Dashboard.)*

### Published Privacy Policy Text

> **Privacy Policy for SoundClud — Bit-Perfect TOSLINK & HEOS Handoff**
>
> **Effective Date:** 2026-10-25
>
> **1. Overview & Zero Data Collection**
> SoundClud ("the Extension") is an open-source browser extension that routes audio playback from `https://soundcloud.com` to a user-operated `soundclud-receiver` Hi-Fi daemon running on the user's own computer (`127.0.0.1`) or private local area network (LAN). The developers of SoundClud operate zero servers, collect zero personal information, and embed zero analytics, telemetry, crash reporting, or advertising trackers.
>
> **2. How Data Is Handled Locally**
> - **Device Preferences (`chrome.storage.local`):** Your chosen local audio output identifier, local receiver URL (`127.0.0.1:9876` or LAN receiver host), and local Trust-On-First-Use (TOFU) pairing token are stored strictly on your own device in `chrome.storage.local`. `chrome.storage.sync` is not used.
> - **Ephemeral Playback Session (`chrome.storage.session`):** When you actively cast a track on `https://soundcloud.com`, the Extension holds the current track's stream locator, metadata (title, artist, artwork URL), and ephemeral SoundCloud API playback session token in volatile browser memory (`chrome.storage.session`) and transmits it over your local loopback or private home network exclusively to your own TOFU-paired `soundclud-receiver` daemon so the receiver can fetch authorized audio segments directly from SoundCloud (`api-v2.soundcloud.com`). Session credentials are never written to disk and are erased automatically when playback stops or the browser closes.
>
> **3. Third-Party Sharing**
> Zero user data is sold, rented, or transmitted to the Extension authors or any third party. Network requests occur solely between your browser, first-party SoundCloud endpoints (`soundcloud.com` / `*.soundcloud.com`), and your own local `soundclud-receiver` hardware.
>
> **4. Data Retention & Deletion**
> Uninstalling the Extension or clearing extension storage in Chrome immediately deletes all locally saved output preferences and pairing tokens. Closing the browser clears all `chrome.storage.session` memory.
>
> **5. Open-Source Verification & Contact**
> The full source code is publicly auditable at `https://github.com/Space-Cadet0/SoundClud`. For privacy questions or support, open an issue at `https://github.com/Space-Cadet0/SoundClud/issues`.

---

## Distribution & Developer Info

- **Visibility:** Public
- **Regions:** All regions
- **Publisher Name:** SoundClud Open-Source Project (`Space-Cadet0`)
- **Homepage URL:** `https://github.com/Space-Cadet0/SoundClud`
- **Support URL:** `https://github.com/Space-Cadet0/SoundClud/issues`
- **Packaging Command:** `npm --workspace @soundclud/extension run build && node ./scripts/package-extension.mjs`

---

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| `0.1.0` | 2026-10-25 | Initial Chromium MV3 release: zero-friction SoundCloud Go+ `aac_256k` HQ stream selection, `0 dB` Bit-Perfect `44.1 kHz / 24-bit` Optical TOSLINK (`LocalMpvBackend`) & Denon/Marantz HEOS Direct (`HeosUpnpBackend`) output picker, standby auto-wake, `DIDL-Lite` OLED metadata, dynamic waveform scrub debounce, hardware media-key keepalive, and automatic Widevine local playback fallback. | Ready for Packaging |
