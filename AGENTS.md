# SoundClud — Workspace Engineering Rules & Agentic Operating Model

These rules apply unconditionally across the entire `SoundClud` repository. Every orchestrator, specialist subagent, and automated workflow must uphold these invariants without exception.

---

## 1. Non-Negotiable Architectural Laws

### Law 1 — Universal Portability (Zero Per-Track / Per-Device / Per-User / Per-Machine Patches)
- **Zero Per-User / Per-Machine / Per-Amplifier Hardcoding**: Never hardcode LAN IP addresses, `.local` machine/room hostnames, CoreAudio numeric device indices, HEOS player IDs (`pid`)/UDNs/model strings, user home paths, or SoundCloud account identifiers. Discovery, audio output binding, and authentication forwarding must work out-of-the-box for any user on a fresh install across macOS (Intel macOS 12 Monterey+ and Apple Silicon), Linux (`x86_64` / `aarch64`), and **any** Denon/Marantz HEOS network amplifier/speaker (`ACT-Denon:1` / `AiosDevice:1`).
- **Zero Per-Track / Per-Artist Patches**: Every streaming, codec-selection, HLS refresh, or player-virtualization fix must be systemic and protocol-driven—never special-cased to specific SoundCloud track IDs, artist URLs, or playlist slugs.
- **Account-Tier Agnosticism & Go+ HQ Default**: Solutions must work seamlessly for unauthenticated listeners, SoundCloud Free accounts, SoundCloud Go+ (`hq` `aac_256k` 256 kbps AAC @ 44.1 kHz) accounts, and private/secret-link tracks with **zero separate SoundClud login UI** (piggybacking ephemereally on the native `soundcloud.com` session). Always select `hq` `aac_256k` (`hls` or `encrypted-hls` AES-128) whenever available—even when SoundCloud's web UI defaulted to `sq`—skip broken `abr_*` stubs, and cleanly fall back to local browser playback (`drm_local_fallback`) on single tracks that offer *only* Widevine/FairPlay CENC (`ctr-encrypted-hls` / `cbc-encrypted-hls`), auto-resuming remote handoff on the next track.
- **Strict `0 dB` Bit-Perfect Amp-Volume Invariant & Backend Independence**:
  - Both output backends (`LocalMpvBackend` CoreAudio/TOSLINK and `HeosUpnpBackend` HEOS Direct Network) deliver **`0 dB` Bit-Perfect `44,100 Hz / 24-bit` PCM** with **zero remote volume mutation**—volume is controlled exclusively via the physical Hi-Fi amplifier knob/remote (`HeosUpnpBackend` must never call `set_volume` or `RenderingControl::SetVolume`).
  - `LocalMpvBackend` and `HeosUpnpBackend` are **strictly independent**: selecting TOSLINK never sends HEOS power/input commands, and selecting HEOS never touches CoreAudio/optical outputs.

### Law 2 — Zero-PII & Public Repository Hygiene
- `SoundClud` is hosted on GitHub (`Space-Cadet0/SoundClud`). Zero personal home directory paths (`/Users/<realuser>/`, `C:\Users\<realuser>\`), personal emails, SoundCloud `oauth_token` cookies, `client_id` secrets, HEOS `serial` / `UDN` / `service_username` identifiers, HAR captures, or raw `.m3u8` signed URLs may ever be committed to source, tests, fixtures, or documentation.
- Pre-commit (`.githooks/pre-commit`), CI (`npm run check:hygiene`), and static invariant tests (`tests/staticArchitectureInvariants.test.ts`) enforce this gate automatically on every change.

### Law 3 — Non-Hacky, First-Principles Implementation
- **Protocol-First Boundaries**: All REST (`/api/v1/*`) and WebSocket (`ws://<host>:<port>/api/v1/ws`) messages are strictly versioned and validated against shared contracts in `packages/protocol/` and `crates/receiver/`.
- **Clean Browser Virtualization Over Minified Scraping**: Never hook brittle minified Webpack chunk numbers or obfuscated CSS class hashes on `soundcloud.com`. Hook stable Web Platform boundaries (`fetch`, `XMLHttpRequest`, `HTMLAudioElement`, `MediaSource`/`SourceBuffer`, `navigator.mediaSession`) in a Chromium Manifest V3 3-world architecture (`MAIN` <-> nonce-verified `ISOLATED` <-> `Service Worker`).
- **MV3 Chromium Compliance**: Target Chromium Manifest V3 (`minimum_chrome_version: "116"` — Chrome, Brave, Arc, Edge) with zero cross-browser polyfill bloat and zero `"cookies"` permission in `manifest.json`. Never store authoritative state in ephemeral Service Worker global variables (persist config in `chrome.storage.local` and ephemeral auth/session state strictly in `chrome.storage.session`), and never put `ws://` or `wss://` schemes in `manifest.json` `host_permissions` (use `http://*/*` / scoped HTTP match patterns).
- **Zero Homebrew / Python Runtime Dependency on Receiver**: Late 2014 Intel Mac Minis (`Macmini7,1`) cap out at macOS 12 Monterey where Homebrew bottles are unsupported. Receiver binaries (`crates/receiver`) must compile as self-contained native executables (`MACOSX_DEPLOYMENT_TARGET=11.0` on macOS), with `HeosUpnpBackend` running in pure safe Rust and `LocalMpvBackend` paired with checksum-verified standalone `mpv` binaries.
- **Strict Type & Memory Safety**:
  - TypeScript: `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, zero `any` casts.
  - Rust: `#![forbid(unsafe_code)]`, `cargo clippy --workspace --all-targets -- -D warnings`.

### Law 4 — 100% Offline Deterministic Default Test Suite
- Default `npm test` and `cargo test` runs must complete fast and 100% offline. `tests/setup/offlineNetworkGuard.ts` blocks all outbound non-loopback network requests (`127.0.0.1` / `::1` ephemeral test servers only, including mocked `127.0.0.1` HEOS CLI TCP & UPnP SOAP servers).
- Live LAN, live HEOS hardware, or live `soundcloud.com` smoke tests belong strictly in opt-in live verification lanes, never in default unit/CI suites.
- All temporary test files must use `os.tmpdir()` (Node) or `tempfile::tempdir()` (Rust) and clean up deterministically in `finally` / `Drop`.

---

## 2. Multi-Agent Operating Model & File Ownership

Complex work in `SoundClud` is executed through a **5-tier multi-agent topology** to prevent context pollution, confirmation bias, and merge collisions:

1. **Lead Orchestrator**: Owns architecture alignment (`docs/ARCHITECTURE_SPEC.md`), cross-package integration, subagent lifecycle management, and final verification sign-off.
2. **Read-Only Forensic Auditor (`forensic-protocol-auditor`)**: Investigates protocol edge cases, Crashpad minidumps, CoreAudio/HEOS state, or regressions empirically before code is written, keeping `git status` 100% clean.
3. **Disjoint Domain Specialists** (parallelizable with zero file overlap):
   - **`protocol-contracts-architect`** -> `packages/protocol/`
   - **`receiver-daemon-architect`** -> `crates/receiver/` (`LocalMpvBackend` + `HeosUpnpBackend` + HEOS Host-MCU Control + Local HLS/WAV Proxy)
   - **`extension-maestro-engineer`** -> `packages/extension/` (must consult `chrome-extensions` and `modern-web-guidance` skills first)
   - **`packaging-service-ci-engineer`** -> `packaging/`, `scripts/`, `CHROMEWEBSTORE.md`, `.github/workflows/`
4. **Independent Adversarial Gatekeeper (`adversarial-qa-hygiene-verifier`)** -> `tests/`: Independently verifies runtime behavior, chaos resilience (HLS `403` mid-mix refresh, HEOS standby wake/scrub, WS drops, multi-tab handoff, MSE surface virtualization), latency targets, and Zero-PII invariants via `npm run verify`.
5. **Opt-In Live Hardware & Browser UAT Validator (`live-uat-hardware-browser-validator`)**: Executes opt-in live Chromium (`soundcloud.com`) + physical HEOS/CoreAudio hardware verification (`0 dB` amp-knob-only invariant, V8 heap/Crashpad stability, multi-hour mix scrubs, track-switch soak) strictly outside default offline CI (`Law 4`), leaving zero PII or temp artifacts in the repository.

---

## 3. Workspace Skills & Verification Commands

- Use workspace skills under `.agents/skills/` for repeatable engineering workflows:
  - `orchestrate-phase` — Multi-agent phased implementation & adversarial gate workflow
  - `verify-portability-and-hygiene` — Full Zero-PII, TypeScript, Vitest, and Cargo verification runbook
  - `headless-receiver-ops` — CoreAudio/TOSLINK (`'spdf'`), Universal HEOS (`ACT-Denon:1` / UPnP), Monterey `x86_64` cross-build, and `launchd`/`systemd` operations
  - `extension-maestro-dev` — Chromium MV3 3-world SoundCloud virtualization, Go+ HQ ranker, multi-output picker & Chrome Web Store readiness runbook
- Canonical full-workspace gate before every commit/push:
  ```bash
  npm run verify
  ```
