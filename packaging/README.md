# SoundClud Packaging, Zero-Homebrew Installer & Headless Service Units

This directory contains OS-native service templates, standalone `mpv` SHA-256 checksum manifests, and idempotent installer/uninstaller scripts for the `soundclud-receiver` daemon across macOS 12 Monterey+ (`x86_64` & `arm64`) and Linux (`x86_64` & `aarch64`).

## Design Invariants

1. **Zero Homebrew / Zero Python Runtime Dependency**: Late 2014 Intel Mac Minis (`Macmini7,1`) cap out at **macOS 12 Monterey**, where Homebrew bottles are unsupported. Release binaries target `MACOSX_DEPLOYMENT_TARGET=11.0` across `x86_64-apple-darwin` and `aarch64-apple-darwin`, paired with SHA-256-verified standalone `mpv` archives (`LocalMpvBackend`) or zero external binaries in pure-Rust `--heos-only` mode (`HeosUpnpBackend`).
2. **True Headless Lifecycle**: Clean, idempotent user-space installation (`$HOME/.local` by default, zero `sudo` required) with cold-boot `coreaudiod` readiness gating on macOS (`launchd`) and `systemd --user` (`loginctl enable-linger`) on Linux.
3. **Cryptographic Integrity**: Every downloaded release tarball and standalone `mpv` archive is verified against pinned SHA-256 digests (`SHA256SUMS.txt` / `mpv-checksums.json`) via `shasum -a 256` or `sha256sum` prior to extraction.
4. **Strict Backend Independence & `0 dB` Bit-Perfect Output**: Both `LocalMpvBackend` (CoreAudio/TOSLINK/ALSA) and `HeosUpnpBackend` (Denon/Marantz HEOS Direct Network) deliver `44,100 Hz / 24-bit` `0 dB` PCM without mutating hardware or network volume.

## Directory Layout

```text
packaging/
├── README.md                              # Packaging architecture & operator runbook
├── launchd/
│   ├── io.soundclud.receiver.plist.tmpl   # macOS LaunchAgent / LaunchDaemon template
│   └── run-receiver.sh                    # Cold-boot coreaudiod readiness wrapper (<=15s)
├── systemd/
│   └── soundclud-receiver.service.tmpl    # Linux systemd --user unit template
├── mpv/
│   └── mpv-checksums.json                 # Standalone macOS 11+ mpv URLs & SHA-256 manifest
└── install/
    ├── install.sh                         # Idempotent Zero-Homebrew installer
    └── uninstall.sh                       # Clean service teardown & binary/state uninstaller
```

---

## Quick Start by Use Case

### Use Case 1 — Headless Mac Mini Optical TOSLINK (`Macmini7,1`, macOS 12 Monterey+) or Linux ALSA/PipeWire

Provisions `soundclud-receiver`, the `coreaudiod` readiness wrapper (`run-receiver.sh`), a SHA-256-verified standalone `mpv` binary (macOS 11+ `x86_64` or `arm64`), and registers `io.soundclud.receiver`:

```bash
# Online verified install into $HOME/.local (zero sudo, zero Homebrew):
./packaging/install/install.sh

# Install from an extracted release archive or local build with SHA-256 verification:
./packaging/install/install.sh \
  --bin-source ./target/release/soundclud-receiver \
  --checksum-file ./SHA256SUMS.txt
```

- **macOS Pre-Login Headless Boot (`LaunchDaemon`, optional)**: If your headless Mac Mini boots without auto-login enabled, run with `--system-daemon` as root to register `/Library/LaunchDaemons/io.soundclud.receiver.plist`:
  ```bash
  sudo ./packaging/install/install.sh --prefix /usr/local --state-dir /var/lib/soundclud --system-daemon
  ```
- **Linux Headless Boot Persistence (`systemd --user`)**: Enable user lingering once so `soundclud-receiver.service` starts automatically on boot without an interactive login session:
  ```bash
  ./packaging/install/install.sh
  loginctl enable-linger "$USER"
  systemctl --user status soundclud-receiver.service
  ```

### Use Case 2 — Direct Denon/Marantz HEOS Network Streaming (`--heos-only`, Laptop `127.0.0.1` or LAN Server)

`HeosUpnpBackend` discovers Denon/Marantz HEOS Built-in amplifiers on the LAN, wakes them from Network Standby (`ACT:1`), updates the front OLED (`DIDL-Lite`), and streams seekable `44,100 Hz / 24-bit` `0 dB` WAV in **pure safe Rust**—requiring **zero `mpv` binary** and **zero second computer**:

```bash
# Run locally on 127.0.0.1:9876 on your client laptop (or on a LAN host) without mpv:
./packaging/install/install.sh --heos-only

# Offline local binary install in pure-Rust HEOS mode:
./packaging/install/install.sh \
  --bin-source ./target/release/soundclud-receiver \
  --heos-only
```

---

## Offline Smoke Testing & CI Flags

`install.sh` supports hermetic offline verification without touching user services or network endpoints:

```bash
# Preview all resolved paths and actions without writing files:
./packaging/install/install.sh --heos-only --dry-run

# Hermetic offline install into custom directories without launchctl/systemctl calls:
./packaging/install/install.sh \
  --bin-source ./target/release/soundclud-receiver \
  --heos-only \
  --skip-service \
  --prefix "$TMPDIR/soundclud-prefix" \
  --state-dir "$TMPDIR/soundclud-state"
```

## Uninstalling

`uninstall.sh` is 100% idempotent—safe to run multiple times even if the service is already stopped or partially removed:

```bash
# Stop/unload service and remove installed binaries + rendered unit files (preserves state):
./packaging/install/uninstall.sh

# Full removal including private state directory and logs:
./packaging/install/uninstall.sh --purge-state
```
