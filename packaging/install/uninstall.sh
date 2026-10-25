#!/usr/bin/env bash
# SoundClud Headless Receiver Uninstaller
#
# Idempotently stops/unloads launchd or systemd --user services, removes installed
# binaries and rendered unit files under `--prefix`, and optionally deletes `--state-dir`
# when `--purge-state` is passed.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: uninstall.sh [options]

Idempotent uninstaller for the SoundClud receiver daemon (`soundclud-receiver`).

Options:
  --prefix <dir>          Installation prefix (default: $HOME/.local)
  --state-dir <dir>       State directory path
                          (macOS default: $HOME/Library/Application Support/SoundClud)
                          (Linux default: ${XDG_STATE_HOME:-$HOME/.local/state}/soundclud)
  --purge-state           Delete `--state-dir` and all receiver state/logs
  --skip-service          Do not invoke launchctl or systemctl during removal
  --service-dir <dir>     Override active service unit directory
  --system-daemon         macOS only: unload /Library/LaunchDaemons/io.soundclud.receiver.plist
  --target-os <os>        Override detected OS (darwin | linux)
  --dry-run               Print planned actions without deleting files or unloading services
  -h, --help              Show this help message and exit
EOF
}

log_info() {
  printf '[soundclud-uninstall] %s\n' "$*"
}

die() {
  printf '[soundclud-uninstall] ERROR: %s\n' "$*" >&2
  exit 1
}

normalize_os() {
  local raw="$1"
  local lower
  lower="$(printf '%s' "${raw}" | tr '[:upper:]' '[:lower:]')"
  case "${lower}" in
    darwin|macos|osx) printf 'darwin' ;;
    linux) printf 'linux' ;;
    *) die "Unsupported operating system: ${raw} (expected Darwin or Linux)" ;;
  esac
}

PREFIX="${HOME:-}/.local"
STATE_DIR=""
PURGE_STATE="0"
SKIP_SERVICE="0"
SERVICE_DIR_OVERRIDE=""
SYSTEM_DAEMON="0"
TARGET_OS_OVERRIDE=""
DRY_RUN="0"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix)
      [ "$#" -ge 2 ] || die "--prefix requires a directory argument"
      PREFIX="$2"
      shift 2
      ;;
    --prefix=*)
      PREFIX="${1#*=}"
      shift
      ;;
    --state-dir)
      [ "$#" -ge 2 ] || die "--state-dir requires a directory argument"
      STATE_DIR="$2"
      shift 2
      ;;
    --state-dir=*)
      STATE_DIR="${1#*=}"
      shift
      ;;
    --purge-state)
      PURGE_STATE="1"
      shift
      ;;
    --skip-service)
      SKIP_SERVICE="1"
      shift
      ;;
    --service-dir)
      [ "$#" -ge 2 ] || die "--service-dir requires a directory path"
      SERVICE_DIR_OVERRIDE="$2"
      shift 2
      ;;
    --service-dir=*)
      SERVICE_DIR_OVERRIDE="${1#*=}"
      shift
      ;;
    --system-daemon)
      SYSTEM_DAEMON="1"
      shift
      ;;
    --target-os)
      [ "$#" -ge 2 ] || die "--target-os requires darwin or linux"
      TARGET_OS_OVERRIDE="$2"
      shift 2
      ;;
    --target-os=*)
      TARGET_OS_OVERRIDE="${1#*=}"
      shift
      ;;
    --dry-run)
      DRY_RUN="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown option: $1 (pass --help for usage)"
      ;;
  esac
done

[ -n "${PREFIX}" ] || die "--prefix cannot be empty"

OS_KIND="$(normalize_os "${TARGET_OS_OVERRIDE:-$(uname -s)}")"

if [ -z "${STATE_DIR}" ]; then
  if [ "${OS_KIND}" = "darwin" ]; then
    [ -n "${HOME:-}" ] || die "\$HOME is unset; pass --state-dir explicitly"
    STATE_DIR="${HOME}/Library/Application Support/SoundClud"
  else
    [ -n "${HOME:-}" ] || [ -n "${XDG_STATE_HOME:-}" ] || die "\$HOME is unset; pass --state-dir explicitly"
    STATE_DIR="${XDG_STATE_HOME:-${HOME}/.local/state}/soundclud"
  fi
fi

BIN_DIR="${PREFIX}/bin"
SHARE_DIR="${PREFIX}/share/soundclud"
RECEIPT_PATH="${SHARE_DIR}/install-receipt.env"

if [ "${OS_KIND}" = "darwin" ]; then
  UNIT_NAME="io.soundclud.receiver.plist"
  if [ -n "${SERVICE_DIR_OVERRIDE}" ]; then
    ACTIVE_SERVICE_DIR="${SERVICE_DIR_OVERRIDE}"
  elif [ "${SYSTEM_DAEMON}" = "1" ]; then
    ACTIVE_SERVICE_DIR="/Library/LaunchDaemons"
  else
    ACTIVE_SERVICE_DIR="${HOME}/Library/LaunchAgents"
  fi
else
  UNIT_NAME="soundclud-receiver.service"
  if [ -n "${SERVICE_DIR_OVERRIDE}" ]; then
    ACTIVE_SERVICE_DIR="${SERVICE_DIR_OVERRIDE}"
  else
    ACTIVE_SERVICE_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
  fi
fi

ACTIVE_UNIT_PATH="${ACTIVE_SERVICE_DIR}/${UNIT_NAME}"

MPV_MANAGED="0"
if [ -f "${RECEIPT_PATH}" ]; then
  if grep -q '^MPV_MANAGED=1$' "${RECEIPT_PATH}" 2>/dev/null; then
    MPV_MANAGED="1"
  fi
fi

if [ "${DRY_RUN}" = "1" ]; then
  log_info "[DRY-RUN] OS: ${OS_KIND}"
  log_info "[DRY-RUN] Prefix: ${PREFIX}"
  if [ "${SKIP_SERVICE}" = "1" ]; then
    log_info "[DRY-RUN] Service teardown: skipped (--skip-service)"
  else
    log_info "[DRY-RUN] Unload and remove service unit: ${ACTIVE_UNIT_PATH}"
  fi
  log_info "[DRY-RUN] Remove ${BIN_DIR}/soundclud-receiver, ${BIN_DIR}/run-receiver.sh, and ${SHARE_DIR}"
  if [ "${MPV_MANAGED}" = "1" ]; then
    log_info "[DRY-RUN] Remove managed mpv binary: ${BIN_DIR}/mpv"
  fi
  if [ "${PURGE_STATE}" = "1" ]; then
    log_info "[DRY-RUN] Purge state directory: ${STATE_DIR}"
  else
    log_info "[DRY-RUN] Preserve state directory: ${STATE_DIR} (pass --purge-state to delete)"
  fi
  exit 0
fi

# 1. Stop and unload service idempotently
if [ "${SKIP_SERVICE}" = "0" ]; then
  if [ "${OS_KIND}" = "darwin" ]; then
    if command -v launchctl >/dev/null 2>&1; then
      if [ "${SYSTEM_DAEMON}" = "1" ]; then
        launchctl bootout system/io.soundclud.receiver 2>/dev/null || launchctl unload "${ACTIVE_UNIT_PATH}" 2>/dev/null || true
      else
        uid_num="$(id -u)"
        launchctl bootout "gui/${uid_num}/io.soundclud.receiver" 2>/dev/null || launchctl unload "${ACTIVE_UNIT_PATH}" 2>/dev/null || true
      fi
    fi
    rm -f -- "${ACTIVE_UNIT_PATH}"
    log_info "Unloaded and cleaned launchd unit (${ACTIVE_UNIT_PATH})."
  else
    if command -v systemctl >/dev/null 2>&1; then
      systemctl --user disable --now soundclud-receiver.service 2>/dev/null || true
    fi
    rm -f -- "${ACTIVE_UNIT_PATH}"
    if command -v systemctl >/dev/null 2>&1; then
      systemctl --user daemon-reload 2>/dev/null || true
      systemctl --user reset-failed soundclud-receiver.service 2>/dev/null || true
    fi
    log_info "Disabled and cleaned systemd user unit (${ACTIVE_UNIT_PATH})."
  fi
elif [ -n "${SERVICE_DIR_OVERRIDE}" ]; then
  rm -f -- "${ACTIVE_UNIT_PATH}"
fi

# 2. Remove installed binaries and staged templates under --prefix
rm -f -- "${BIN_DIR}/soundclud-receiver" "${BIN_DIR}/run-receiver.sh"

if [ "${MPV_MANAGED}" = "1" ]; then
  rm -f -- "${BIN_DIR}/mpv"
elif [ -L "${BIN_DIR}/mpv" ]; then
  mpv_link_target="$(readlink "${BIN_DIR}/mpv" 2>/dev/null || true)"
  case "${mpv_link_target}" in
    *"/share/soundclud/mpv.app/"*)
      rm -f -- "${BIN_DIR}/mpv"
      ;;
  esac
fi

if [ -d "${SHARE_DIR}" ]; then
  rm -rf -- "${SHARE_DIR}"
fi

# Remove empty parent subdirectories inside --prefix if nothing else remains
rmdir "${BIN_DIR}" 2>/dev/null || true
rmdir "${PREFIX}/share" 2>/dev/null || true

log_info "Removed SoundClud binaries and unit templates under ${PREFIX}."

# 3. Optionally purge state directory
if [ "${PURGE_STATE}" = "1" ]; then
  case "${STATE_DIR}" in
    ""|"/"|"${HOME:-/nonexistent}")
      die "Refusing to purge unsafe --state-dir path: '${STATE_DIR}'"
      ;;
  esac
  if [ -d "${STATE_DIR}" ]; then
    rm -rf -- "${STATE_DIR}"
    log_info "Purged state directory: ${STATE_DIR}"
  else
    log_info "State directory already absent: ${STATE_DIR}"
  fi
else
  log_info "Preserved state directory: ${STATE_DIR} (pass --purge-state to remove)."
fi
