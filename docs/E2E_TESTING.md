# SoundClud E2E Testing Infrastructure Specification

## 1. Executive Summary & Testing Philosophy

The SoundClud End-to-End (E2E) testing framework provides an exhaustive, deterministic, 100% offline verification suite for all 20 SoundClud features across four distinct architectural tiers.

### Core Architectural Laws & Invariants
1. **Law 1 — Universal Portability**: Zero hardcoded RFC1918 LAN IPs (`192.168.x.x`, `10.x.x.x`), `.local` mDNS hostnames, machine names, CoreAudio device indices, or HEOS player IDs/UDNs. All mock hardware instances bind dynamically to loopback (`127.0.0.1:0`) and negotiate capability advertising dynamically. Both audio backends deliver bit-perfect 44.1 kHz / 24-bit PCM at 0 dB gain with zero digital software attenuation.
2. **Law 2 — Zero-PII & Public Repository Hygiene**: Zero personal macOS/Windows user paths, personal email addresses, SoundCloud OAuth tokens, or credential secrets. All test data utilizes synthetic, deterministically generated identifiers.
3. **Law 3 — Non-Hacky, Protocol-First Implementation**: Tests strictly exercise public protocol boundaries (WebSocket `/api/v1/ws`, HTTP REST `/api/v1/*`, Extension runtime IPC messages, and encapsulated Shadow DOM elements). Tests never access private struct fields or mutate internal classes directly. All tests import real production validators (`@soundclud/protocol`) and UI components (`@soundclud/extension`). Absolutely zero inline dummy functions or tautological assertions.
4. **Law 4 — 100% Offline Deterministic Test Suite**: Outbound network requests are intercepted by `tests/setup/offlineNetworkGuard.ts`. Every mock server operates on loopback with ephemeral port allocation, completely isolated from real LAN devices or cloud services.

---

## 2. Dual-Mode Execution Architecture

To reconcile the competing requirements of deep full-stack verification and ultra-fast test execution (< 15 seconds), the E2E infrastructure employs a **Two-Mode Execution Architecture**:

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                         SoundClud E2E Testing Architecture                       │
├─────────────────────────────────────────┬────────────────────────────────────────┤
│     Mode A: In-Process Opaque-Box       │     Mode B: Ephemeral Process-Level    │
│            (Ultra-Fast)                 │             (Full-Stack)               │
├─────────────────────────────────────────┼────────────────────────────────────────┤
│ • In-process TypeScript HTTP + WS       │ • Spawns compiled Rust daemon          │
│   mock receiver (`mockReceiverServer`)  │   (`soundclud-receiver`) on 127.0.0.1:0 │
│ • Tests Extension Service Worker,       │ • Mock Host-MCU Telnet :23             │
│   `wsController`, popup, & Cast Pill    │ • Mock HEOS CLI JSON-RPC :1255         │
│ • Real loopback TCP sockets             │ • Mock UPnP DMR SOAP trap server       │
│ • Execution time: 5–30 ms per test      │ • Execution time: 200–800 ms per flow  │
│ • Used for high-volume Tier 1, Tier 2,  │ • Used for Tier 4 real-world workloads │
│   and Tier 3 boundary permutations      │   and Tier 1 packaging/runtime gates   │
└─────────────────────────────────────────┴────────────────────────────────────────┘
```

### Mode A: In-Process Opaque-Box Harness (`mockReceiverServer.ts`)
- Implements the complete SoundClud protocol v1 over native Node 22 `http.createServer` and `WebSocket`.
- Serves REST endpoints (`/api/v1/discover`, `/api/v1/pair`, `/api/v1/status`, `/api/v1/config`, `/api/v1/audio/volume`).
- Supports configurable Bearer token authentication checks, state transitions, and WebSocket broadcast events (`volume_changed`, `outputs_updated`, `state_tick`).
- Zero child processes spawned; provides sub-millisecond setup and teardown for rapid permutation testing.

### Mode B: Ephemeral Rust Process Harness (`receiverProcessHarness.ts`)
- Spawns the compiled `target/debug/soundclud-receiver` binary with isolated arguments:
  - `--bind 127.0.0.1:0` (ephemeral port allocation)
  - `--state-dir <tempdir>` (isolated 0700 temporary directory in `os.tmpdir()`)
  - `--no-lan-discovery` (prevents external LAN broadcast)
  - `--mpv-bin <mock-mpv-script>` (standalone Node mock-mpv UNIX socket script)
- Parses allocated ephemeral port from stdout/stderr (`listen=127.0.0.1:<port>`).
- Implements fully compliant TOFU handshake via `pair(clientLabel, controllerId)` sending `{ protocolVersion: 'v1', clientLabel, controllerId }`.
- Implements authenticated WebSocket connection via `connectWs(pairingToken, controllerId)` sending `{ type: 'hello', protocolVersion: 'v1', pairingToken, controllerId, clientLabel }`.
- Provides REST and authenticated WebSocket client factories with deterministic cleanup via `SIGINT` -> `SIGKILL` and recursive tempdir removal.

---

## 3. Directory Layout & Harness Taxonomy

```
tests/e2e/
├── harness/
│   ├── index.ts                     # Unified barrel exports & cleanup utilities
│   ├── types.ts                     # Shared interfaces, options, and error definitions
│   ├── mockMcuServer.ts             # Marantz/Denon Host-MCU Telnet :23 mock server
│   ├── mockHeosCliServer.ts         # HEOS CLI :1255 CRLF JSON-RPC mock server
│   ├── mockUpnpServer.ts            # UPnP DMR SOAP server (ACT:1, AVT:1, RenderingControl trap)
│   ├── mockHlsServer.ts             # Loopback HLS segment server (WAV/FLAC, 403 refresh, short-track)
│   ├── mockReceiverServer.ts        # In-process TypeScript WebSocket/REST receiver server (Mode A)
│   ├── receiverProcessHarness.ts    # Ephemeral Rust soundclud-receiver daemon harness (Mode B)
│   ├── syntheticDomEnvironment.ts   # Lightweight Shadow DOM & Cast Pill fixture (no jsdom dependency)
│   └── fixtures.ts                  # Synthetic audio tracks, tokens, configs, and output descriptors
├── tier1-features/
│   ├── t1_hardware_volume.test.ts   # Features 1, 2, 3, 4, 5, 6, 7 (35 tests)
│   ├── t1_extension_ui.test.ts      # Features 8, 9, 10, 17, 18 (25 tests)
│   ├── t1_receiver_engine.test.ts   # Features 11, 12, 13, 14, 15, 16 (30 tests)
│   └── t1_packaging_gate.test.ts    # Features 19, 20 (10 tests)
├── tier2-boundaries/
│   ├── t2_volume_boundary.test.ts   # Boundary values (0, 100, -1, 101, NaN, rapid flaps) (15 tests)
│   ├── t2_protocol_anomaly.test.ts  # Firmware fail responses, disconnects, SOAP faults, 401s (13 tests)
│   └── t2_media_transcode_edge.test.ts # <1s tracks, 0 duration, segment gaps, DLNA 2GiB window (14 tests)
├── tier3-pairwise/
│   ├── t3_volume_seek_concurrency.test.ts   # Volume adjustment during rapid seek scrubbing (7 tests)
│   ├── t3_mcu_cli_interplay.test.ts         # Telnet :23 power toggle while CLI :1255 emits events (7 tests)
│   ├── t3_short_track_volume_handoff.test.ts# <5s track completion with in-flight volume commands (4 tests)
│   └── t3_failover_reconnect_sync.test.ts   # Network drop during slider drag with mDNS IP failover (7 tests)
└── tier4-workloads/
    ├── t4_full_playback_session.test.ts     # End-to-end multi-track session with volume & Cast Pill (4 tests)
    ├── t4_standby_wake_recovery.test.ts     # Cold start from PWSTANDBY -> wake -> play -> keepalive (4 tests)
    └── t4_multi_tab_takeover.test.ts        # Tab handoff with session_claimed and volume state sync (4 tests)
```

---

## 4. Modular Mock Hardware Specifications

### 4.1 Mock Host-MCU Telnet Server (`mockMcuServer.ts`)
- **Transport**: `net.createServer()` listening on `127.0.0.1:0`.
- **Protocol**: ASCII Carriage Return (`\r`) terminated strings.
- **Commands Handled**:
  - `PW?` -> Returns `PWON\r` or `PWSTANDBY\r`.
  - `PWON` -> Transitions power state to `ON`, returns `PWON\r`.
  - `PWSTANDBY` -> Transitions power state to `STANDBY`, returns `PWSTANDBY\r`.
  - `SI?` -> Returns `SINET\r`, `SITV\r`, or configured input.
  - `SINET` / `SICD` / `SITV` -> Selects input, returns corresponding acknowledgment.
  - `SLP?` / `SLPOFF` -> Tracks sleep commands and increments violation counter.
- **Invariants Enforced**:
  - `assertZeroSleepCommands()`: Verifies zero `SLP?` or `SLPOFF` commands received (PM7000N OLED fix).
  - `assertSerializedAccess()`: Verifies peak concurrent connections <= 1 (Feature 11 mutex serialization).

### 4.2 Mock HEOS CLI Server (`mockHeosCliServer.ts`)
- **Transport**: `net.createServer()` listening on `127.0.0.1:0`.
- **Protocol**: JSON-RPC over CRLF-delimited lines (`\r\n`).
- **Commands Handled**:
  - `player/get_players` -> Simulates asynchronous `command under process` followed by player list.
  - `player/get_volume?pid=N` -> Returns `{ "heos": { "command": "player/get_volume", "result": "success", "message": "pid=N&level=X" } }`.
  - `player/get_mute?pid=N` -> Returns `{ "heos": { "command": "player/get_mute", "result": "success", "message": "pid=N&state=off" } }`.
  - `player/set_volume?pid=N&level=X` -> Verifies parameters, commits volume, returns configured result (`success` or `fail`).
  - `player/set_mute?pid=N&state=on|off` -> Verifies parameters, commits mute state, returns configured result.
  - `system/register_for_change_events?enable=on` -> Subscribes client to push notifications.
- **Push Event Methods**:
  - `pushVolumeChangeEvent(volume, muted)`: Emits `event/player_volume_changed`.
  - `pushMuteOnlyChangeEvent(muted)`: Emits `event/player_mute_changed` without `level=` parameter (Feature 5 asymmetric event test).

### 4.3 Mock UPnP DMR Server (`mockUpnpServer.ts`)
- **Transport**: `http.createServer()` listening on `127.0.0.1:0`.
- **Endpoints**:
  - `GET /desc.xml`: UPnP root device description (`urn:schemas-denon-com:device:ACT-Denon:1`).
  - `POST /ACT`: SOAP service for `GetDevicePowerState` and `SetDevicePowerState`.
  - `POST /AVT`: SOAP service for `SetAVTransportURI`, `Play`, `Pause`, `Stop`, `Seek`, `GetPositionInfo`, `GetTransportInfo`.
  - `POST /RC`: Trap endpoint! (Law 1 invariant: `RenderingControl` must NEVER be invoked. Any request records a fatal assertion violation).
- **Invariants Enforced**:
  - `assertZeroRenderingControlHits()`: Asserts rendering control was never touched.
  - `assertValidDidlMetadata()`: Verifies non-empty DIDL-Lite metadata with title, artist, and 0 dB gain.

### 4.4 Mock Loopback HLS Server (`mockHlsServer.ts`)
- **Transport**: `http.createServer()` listening on `127.0.0.1:0`.
- **Capabilities**:
  - Serves valid HLS M3U8 playlists (`/playlist.m3u8`) with customizable duration and segment sizes.
  - Generates uncompressed 44.1 kHz / 16-bit or 24-bit PCM WAV chunks.
  - Supports error injection (HTTP 403 on segments to test mid-mix HLS token refresh).
  - Supports short-track generation (<5 seconds) to test dynamic near-end guard scaling.

### 4.5 Synthetic DOM & Cast Pill Test Environment (`syntheticDomEnvironment.ts`)
- Zero external DOM dependencies (no `jsdom` or `happy-dom` bloat).
- Built purely on Node 22 native `EventTarget` and minimal DOM element shims:
  - Custom `SyntheticHTMLElement`, `SyntheticButtonElement`, `SyntheticInputElement` (with `.value`, `input`, and `change` event dispatch).
  - Custom `SyntheticShadowRoot` supporting query selectors, HTML template content cloning, and adopted stylesheets.
  - Minimal `document.createElement`, `document.querySelector`, and `requestAnimationFrame` shim.
- Allows headless testing of production `ShadowDomCastPill`: slider dragging, step button clicking, mute button toggling, and bidirectional synchronization with `ExtensionUiSnapshot`.

---

## 5. Feature Inventory & Coverage Mapping Matrix

All 20 features from `PROJECT.md` are covered across all four tiers (179 test cases):

| # | Feature | T1: Feature Coverage | T2: Boundary & Corner | T3: Pairwise Interplay | T4: Workload Scenarios |
|---|---------|----------------------|-----------------------|------------------------|------------------------|
| 1 | Independent Volume & Mute Schemas | `t1_hardware_volume` | `t2_volume_boundary` | `t3_volume_seek_concurrency` | `t4_full_playback_session` |
| 2 | REST Bearer Token Authentication | `t1_hardware_volume` | `t2_protocol_anomaly` | `t3_failover_reconnect_sync` | `t4_full_playback_session` |
| 3 | Decoupled Volume/Mute Execution | `t1_hardware_volume` | `t2_volume_boundary` | `t3_volume_seek_concurrency` | `t4_full_playback_session` |
| 4 | Passive Initial Volume Query on Welcome | `t1_hardware_volume` | `t2_protocol_anomaly` | `t3_failover_reconnect_sync` | `t4_full_playback_session` |
| 5 | Asymmetric Event Handling & Initial Seeding | `t1_hardware_volume` | `t2_protocol_anomaly` | `t3_mcu_cli_interplay` | `t4_full_playback_session` |
| 6 | Verified CLI Command Responses | `t1_hardware_volume` | `t2_protocol_anomaly` | `t3_mcu_cli_interplay` | `t4_full_playback_session` |
| 7 | HEOS Listener Lifecycle & Task Management | `t1_hardware_volume` | `t2_protocol_anomaly` | `t3_mcu_cli_interplay` | `t4_standby_wake_recovery` |
| 8 | Service Worker Authenticated Volume Routing | `t1_extension_ui` | `t2_volume_boundary` | `t3_failover_reconnect_sync` | `t4_full_playback_session` |
| 9 | Popup UI Volume Refactor | `t1_extension_ui` | `t2_volume_boundary` | `t3_failover_reconnect_sync` | `t4_full_playback_session` |
| 10 | Cast Pill Responsive Volume UI | `t1_extension_ui` | `t2_volume_boundary` | `t3_volume_seek_concurrency` | `t4_full_playback_session` |
| 11 | Host-MCU TCP :23 Mutex Serialization | `t1_receiver_engine` | `t2_protocol_anomaly` | `t3_mcu_cli_interplay` | `t4_standby_wake_recovery` |
| 12 | Stream Planner Extraction & Vorbis Cleanup | `t1_receiver_engine` | `t2_media_transcode_edge` | `t3_volume_seek_concurrency` | `t4_full_playback_session` |
| 13 | Symphonia Transcode Probing Optimization | `t1_receiver_engine` | `t2_media_transcode_edge` | `t3_short_track_volume_handoff` | `t4_full_playback_session` |
| 14 | Coordinator State Tick Rate Relaxation | `t1_receiver_engine` | `t2_protocol_anomaly` | `t3_volume_seek_concurrency` | `t4_full_playback_session` |
| 15 | Short-Track Premature Termination Fix | `t1_receiver_engine` | `t2_media_transcode_edge` | `t3_short_track_volume_handoff` | `t4_full_playback_session` |
| 16 | Structured Domain Error Enums | `t1_receiver_engine` | `t2_protocol_anomaly` | `t3_mcu_cli_interplay` | `t4_standby_wake_recovery` |
| 17 | Extension IP Failover & Timer Guard | `t1_extension_ui` | `t2_protocol_anomaly` | `t3_failover_reconnect_sync` | `t4_full_playback_session` |
| 18 | Player-Bar DOM Lookup Caching | `t1_extension_ui` | `t2_volume_boundary` | `t3_volume_seek_concurrency` | `t4_full_playback_session` |
| 19 | macOS Rebuild & Deployment | `t1_packaging_gate` | `t2_protocol_anomaly` | `t3_failover_reconnect_sync` | `t4_full_playback_session` |
| 20 | Live Capability & Regression Gate | `t1_packaging_gate` | `t2_volume_boundary` | `t3_volume_seek_concurrency` | `t4_full_playback_session` |

---

## 6. Execution Commands & Verification Guide

### Running E2E Tests
To run all E2E tests (100% offline, ~1.0s duration):
```bash
npx vitest run tests/e2e
```

To run a specific tier:
```bash
npx vitest run tests/e2e/tier1-features
npx vitest run tests/e2e/tier2-boundaries
npx vitest run tests/e2e/tier3-pairwise
npx vitest run tests/e2e/tier4-workloads
```

### Full Verification Pipeline
```bash
# 1. Typecheck strictness (strict: true, no any, exact properties)
npm run typecheck

# 2. Zero-PII & Universal Portability scanner
npm run check:hygiene

# 3. Vitest full suite (including E2E)
npm test

# 4. Canonical workspace gate
npm run verify
```
