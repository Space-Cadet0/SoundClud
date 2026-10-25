# SoundClud Packaging & Headless Service Layout

This directory houses OS-native service definitions, standalone dependency checksum manifests, and idempotent installer/uninstaller scripts for the headless `soundclud-receiver` daemon (implemented in **Phase 4**).

## Design Invariants

1. **Zero Homebrew / Python Runtime Dependency on macOS**: Late 2014 Intel Mac Minis (`Macmini7,1`) cap out at macOS 12 Monterey where Homebrew bottles are unsupported. Receiver release artifacts compile with `MACOSX_DEPLOYMENT_TARGET=11.0` across `x86_64-apple-darwin` and `aarch64-apple-darwin`, paired with SHA-256 checksum-verified standalone `mpv` binaries.
2. **True Headless Lifecycle**: Clean, idempotent installation and removal without requiring an interactive desktop session or hardcoded user/machine paths.
3. **Reproducible Integrity**: Every downloaded binary archive and release artifact is verified against pinned SHA-256 digests (`SHA256SUMS.txt`) before execution.

## Planned Directory Structure (Phase 4)

```text
packaging/
├── README.md                 # Layout overview and packaging invariants
├── launchd/                  # macOS LaunchAgent / LaunchDaemon templates
│   └── io.soundclud.receiver.plist.tmpl
│                             # Includes coreaudiod readiness gating on headless boot
├── systemd/                  # Linux systemd --user unit templates
│   └── soundclud-receiver.service.tmpl
│                             # Paired with `loginctl enable-linger` for headless persistence
├── mpv/                      # Standalone mpv provisioning manifests
│   └── mpv-checksums.json    # Pinned archive URLs + SHA-256 digests (macOS x86_64/arm64)
└── install/                  # Idempotent lifecycle installers & uninstallers
    ├── install.sh            # Monterey+ (x86_64/aarch64) & Linux (x86_64/aarch64) installer
    └── uninstall.sh          # Clean service teardown, binary removal & state cleanup
```
