---
name: orchestrate-phase
description: >-
  Coordinate a multi-agent engineering phase in SoundClud from forensic discovery
  and shared protocol locking through parallel disjoint domain implementation and
  independent adversarial QA/Zero-PII verification. Use when implementing a spec
  phase, major feature, or architectural refactor.
---

# Orchestrate SoundClud Engineering Phase

Follow this 5-step multi-agent workflow to deliver any `SoundClud` phase cleanly with zero file collisions and zero portability regressions.

## Step 1 — Pre-Flight Checkpoint & Forensic Validation
1. Verify `git status` is clean or create a safety checkpoint tag/branch (`checkpoint-YYYY-MM-DD`) before wide-ranging edits.
2. If any external SoundCloud `api-v2`, Maestro MSE, or macOS/Linux CoreAudio behavior is unverified, invoke `forensic-protocol-auditor` (read-only) first to gather empirical proof before writing code.

## Step 2 — Lock Shared Wire Contracts (`packages/protocol/`)
1. Delegate wire-protocol additions or changes to `protocol-contracts-architect` (`packages/protocol/`) first.
2. Confirm TypeScript types and Rust serde struct shapes match 1:1 (`PROTOCOL_VERSION = "v1"`) before parallelizing consumer work.

## Step 3 — Parallel Disjoint Implementation
Invoke only the needed domain specialists concurrently, assigning **strict non-overlapping file ownership**:
- `receiver-daemon-architect` -> `crates/receiver/`
- `extension-maestro-engineer` -> `packages/extension/` (ensure `chrome-extensions` and `modern-web-guidance` skills are read first)
- `packaging-service-ci-engineer` -> `packaging/`, `scripts/`, `CHROMEWEBSTORE.md`, `.github/workflows/`

## Step 4 — Independent Adversarial Verification & Hygiene Gate
1. Invoke `adversarial-qa-hygiene-verifier` (`tests/`) to add deterministic offline unit/chaos tests covering happy paths and real-world edge cases (HLS `403` token refresh, WebSocket drop/reconnect, multi-tab handoff, rapid scrub debouncing).
2. Run the canonical workspace gate:
   ```bash
   npm run verify
   ```
3. Confirm macOS Intel Monterey compatibility (`MACOSX_DEPLOYMENT_TARGET=11.0 cargo check --workspace --target x86_64-apple-darwin`) when `crates/receiver` changes.

## Step 5 — Scoped Conventional Commit
Stage verified changes and commit using scoped Conventional Commits (`feat(receiver): ...`, `feat(extension): ...`, `fix(protocol): ...`, `test(chaos): ...`). `.githooks/pre-commit` will automatically run `scripts/check-hygiene.mjs`.
