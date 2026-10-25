#!/usr/bin/env bash
# SoundClud macOS launchd Readiness Wrapper
#
# Installed alongside `soundclud-receiver` inside `{{BIN_DIR}}`.
# On cold headless boot (e.g., Late 2014 Intel Mac Mini `Macmini7,1` running
# macOS 12 Monterey), `launchd` may start agents/daemons before `coreaudiod`
# finishes initializing optical S/PDIF (`'spdf'`) CoreAudio devices.
# This wrapper waits cleanly (up to 15s by default) for `coreaudiod` before
# replacing its own process image (`exec`) with `soundclud-receiver`.

set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
export PATH="${SCRIPT_DIR}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin${PATH:+:${PATH}}"

RECEIVER_BIN="${SOUNDCLUD_RECEIVER_BIN:-${SCRIPT_DIR}/soundclud-receiver}"

if [ -z "${SOUNDCLUD_MPV_BIN:-}" ] && [ -x "${SCRIPT_DIR}/mpv" ]; then
  export SOUNDCLUD_MPV_BIN="${SCRIPT_DIR}/mpv"
fi

is_coreaudiod_running() {
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -x coreaudiod >/dev/null 2>&1
    return $?
  fi
  ps -ax -o comm= 2>/dev/null | grep -E '(^|/)coreaudiod$' >/dev/null 2>&1
}

wait_for_coreaudiod() {
  local max_wait="${SOUNDCLUD_COREAUDIO_WAIT_SECS:-15}"
  case "${max_wait}" in
    ''|*[!0-9]*) max_wait=15 ;;
  esac

  if [ "${max_wait}" -le 0 ]; then
    return 0
  fi

  if is_coreaudiod_running; then
    return 0
  fi

  printf '[soundclud-launchd] Waiting up to %ss for coreaudiod readiness...\n' "${max_wait}" >&2
  local deadline=$((SECONDS + max_wait))
  while [ "${SECONDS}" -lt "${deadline}" ]; do
    if is_coreaudiod_running; then
      printf '[soundclud-launchd] coreaudiod is ready.\n' >&2
      return 0
    fi
    sleep 0.5 2>/dev/null || sleep 1
  done

  if is_coreaudiod_running; then
    printf '[soundclud-launchd] coreaudiod is ready.\n' >&2
    return 0
  fi

  printf '[soundclud-launchd] WARNING: coreaudiod not detected after %ss; continuing startup.\n' "${max_wait}" >&2
  return 0
}

if [ "$(uname -s)" = "Darwin" ] && [ "${SOUNDCLUD_HEOS_ONLY:-0}" != "1" ]; then
  wait_for_coreaudiod
fi

if [ ! -x "${RECEIVER_BIN}" ]; then
  printf '[soundclud-launchd] ERROR: receiver binary is missing or not executable: %s\n' "${RECEIVER_BIN}" >&2
  exit 127
fi

exec "${RECEIVER_BIN}" "$@"
