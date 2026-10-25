---
name: verify-portability-and-hygiene
description: >-
  Run SoundClud's full Universal Portability, Zero-PII repository hygiene,
  offline test determinism, TypeScript strictness, and Rust/Monterey cross-target
  verification suite. Use before committing, opening PRs, cutting releases, or
  signing off on subagent deliverables.
---

# Verify Portability, Hygiene & Build Readiness

Execute every step below and fix any failure systemically before declaring work complete.

## 1. Zero-PII, Secret & Universal Portability Scan
```bash
npm run check:hygiene
```
Verifies across all tracked files:
- Zero personal macOS (`/Users/<realuser>/`) or Windows (`C:\Users\<realuser>\`) paths
- Zero salted SHA-256 blocked personal identifiers
- Zero leaked GitHub PATs, private keys, or SoundCloud `OAuth` tokens
- Zero hardcoded RFC1918 LAN IP defaults inside `crates/` or `packages/`

## 2. Strict TypeScript & Deterministic Offline Test Gate
```bash
npm run typecheck
npm test
```
Verifies:
- `0` TypeScript errors across `packages/protocol`, `packages/extension`, and `tests/`
- `100%` pass rate with `tests/setup/offlineNetworkGuard.ts` blocking all non-loopback network requests

## 3. Rust Workspace Formatting, Clippy & Monterey `x86_64` Cross-Check
```bash
npm run check:rust
MACOSX_DEPLOYMENT_TARGET=11.0 cargo check --workspace --target x86_64-apple-darwin
```
Verifies:
- `cargo fmt --all -- --check` clean
- `cargo clippy --workspace --all-targets -- -D warnings` clean (`unsafe_code = "forbid"`)
- `cargo test --workspace` passing offline
- Clean compilation for Late 2014 Intel Mac Mini (`x86_64-apple-darwin`, macOS 12 Monterey / deployment target `11.0`)

## 4. Dependency Security Audit
```bash
npm audit --audit-level=high
```
