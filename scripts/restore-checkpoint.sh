#!/usr/bin/env bash
# SoundClud — Safe Git Checkpoint Tag & Bundle Helper
#
# Non-destructively creates, lists, and restores git checkpoint tags or offline
# `.bundle` archives without force-resetting uncommitted working tree state.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

BUNDLE_DIR="${REPO_ROOT}/.runtime/checkpoints"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/restore-checkpoint.sh list
  ./scripts/restore-checkpoint.sh create [label]
  ./scripts/restore-checkpoint.sh restore <checkpoint-tag-or-bundle> [--branch <new-branch>]

Commands:
  list      List available `checkpoint/*` git tags and local `.runtime/checkpoints/*.bundle` archives.
  create    Verify Zero-PII hygiene, create an annotated `checkpoint/<utc>-<label>` tag, and write a git bundle.
  restore   Verify clean working tree and safely check out a new recovery branch from a tag or `.bundle` file.
EOF
}

ensure_clean_worktree() {
  if [ -n "$(git status --porcelain)" ]; then
    echo "[checkpoint] ERROR: Working tree has uncommitted changes." >&2
    echo "[checkpoint] Commit or stash your changes before restoring a checkpoint." >&2
    exit 1
  fi
}

sanitize_label() {
  printf '%s' "$1" | tr -cs 'A-Za-z0-9._-' '-' | sed 's/^-*//;s/-*$//'
}

cmd="${1:-help}"
shift || true

case "$cmd" in
  list)
    echo "=== Git Checkpoint Tags ==="
    tags="$(git tag -l 'checkpoint/*' --sort=-creatordate)"
    if [ -n "$tags" ]; then
      printf '%s\n' "$tags"
    else
      echo "(none)"
    fi
    echo ""
    echo "=== Local Checkpoint Bundles (.runtime/checkpoints) ==="
    if [ -d "$BUNDLE_DIR" ] && compgen -G "${BUNDLE_DIR}/*.bundle" >/dev/null; then
      ls -1t "${BUNDLE_DIR}"/*.bundle
    else
      echo "(none)"
    fi
    ;;

  create)
    raw_label="${1:-snapshot}"
    label="$(sanitize_label "$raw_label")"
    if [ -z "$label" ]; then
      label="snapshot"
    fi

    if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
      echo "[checkpoint] ERROR: Repository has no commits yet." >&2
      exit 1
    fi

    if command -v node >/dev/null 2>&1 && [ -f "./scripts/check-hygiene.mjs" ]; then
      node ./scripts/check-hygiene.mjs
    fi

    stamp="$(date -u +%Y%m%dT%H%M%SZ)"
    tag_name="checkpoint/${stamp}-${label}"
    mkdir -p "$BUNDLE_DIR"
    bundle_path="${BUNDLE_DIR}/${stamp}-${label}.bundle"

    git tag -a "$tag_name" -m "SoundClud checkpoint: ${label} (${stamp})"
    git bundle create "$bundle_path" HEAD "$tag_name"

    echo "[checkpoint] Created tag:    ${tag_name}"
    echo "[checkpoint] Created bundle: ${bundle_path}"
    ;;

  restore)
    if [ "$#" -lt 1 ]; then
      echo "[checkpoint] ERROR: Missing <checkpoint-tag-or-bundle> argument." >&2
      usage >&2
      exit 1
    fi

    target="$1"
    shift
    recovery_branch=""

    while [ "$#" -gt 0 ]; do
      case "$1" in
        --branch)
          recovery_branch="${2:-}"
          if [ -z "$recovery_branch" ]; then
            echo "[checkpoint] ERROR: --branch requires a branch name." >&2
            exit 1
          fi
          shift 2
          ;;
        *)
          echo "[checkpoint] ERROR: Unknown option '$1'." >&2
          usage >&2
          exit 1
          ;;
      esac
    done

    ensure_clean_worktree

    stamp="$(date -u +%Y%m%dT%H%M%SZ)"

    if [ -f "$target" ]; then
      echo "[checkpoint] Verifying git bundle: ${target}"
      git bundle verify "$target"
      base_name="$(sanitize_label "$(basename "$target" .bundle)")"
      if [ -z "$recovery_branch" ]; then
        recovery_branch="restore/${base_name}-${stamp}"
      fi
      git fetch "$target" "HEAD:refs/heads/${recovery_branch}"
      git switch "$recovery_branch"
      echo "[checkpoint] Restored bundle onto branch '${recovery_branch}'."
    else
      if ! git rev-parse --verify "${target}^{commit}" >/dev/null 2>&1; then
        echo "[checkpoint] ERROR: Unknown git ref or missing bundle file '${target}'." >&2
        exit 1
      fi
      ref_label="$(sanitize_label "$target")"
      if [ -z "$recovery_branch" ]; then
        recovery_branch="restore/${ref_label}-${stamp}"
      fi
      git switch -c "$recovery_branch" "$target"
      echo "[checkpoint] Restored '${target}' onto branch '${recovery_branch}'."
    fi
    ;;

  -h|--help|help)
    usage
    ;;

  *)
    echo "[checkpoint] ERROR: Unknown subcommand '${cmd}'." >&2
    usage >&2
    exit 1
    ;;
esac
