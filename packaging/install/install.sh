#!/usr/bin/env bash
# SoundClud Zero-Homebrew Headless Receiver Installer
#
# Supports macOS 12 Monterey+ (x86_64 Late 2014 Mac Mini Macmini7,1 & arm64 Apple Silicon)
# and Linux (x86_64 & aarch64) with zero Homebrew (`brew`) and zero Python dependency.

set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
PACKAGING_DIR="$(CDPATH='' cd -- "${SCRIPT_DIR}/.." && pwd)"

DEFAULT_REPO="Space-Cadet0/SoundClud"

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Idempotent Zero-Homebrew installer for the SoundClud receiver daemon (`soundclud-receiver`).

Options:
  --prefix <dir>          Installation prefix (default: $HOME/.local; no sudo needed)
  --state-dir <dir>       Private state directory, created chmod 700
                          (macOS default: $HOME/Library/Application Support/SoundClud)
                          (Linux default: ${XDG_STATE_HOME:-$HOME/.local/state}/soundclud)
  --bin-source <path>     Install a local prebuilt `soundclud-receiver` binary or .tar.gz
                          archive directly (100% offline, < 1s)
  --checksum-file <path>  Verify `--bin-source` (and/or `--mpv-archive`) against a
                          SHA256SUMS.txt file before installing
  --mpv-bin <path>        Use/install an existing standalone `mpv` executable
  --mpv-archive <path>    Install standalone `mpv` from a local .tar.gz archive
  --mpv-sha256 <hex>      Expected SHA-256 hex digest when using `--mpv-archive`
  --heos-only             Configure pure-Rust Denon/Marantz HEOS Direct mode without `mpv`
  --keep-awake            Prevent macOS idle sleep on AC power via caffeinate (zero sudo)
  --skip-service          Render unit templates under <prefix>/share/soundclud without
                          invoking launchctl or systemctl (ideal for CI/offline checks)
  --service-dir <dir>     Override destination directory for active service unit file
  --system-daemon         macOS only: install into /Library/LaunchDaemons (requires root)
  --version <tag>         Release version tag for online download (default: latest)
  --repo <owner/name>     GitHub repository for online release download
  --target-os <os>        Override detected OS (darwin | linux) for template rendering
  --dry-run               Print planned actions without modifying files or services
  -h, --help              Show this help message and exit
EOF
}

log_info() {
  printf '[soundclud-install] %s\n' "$*"
}

log_warn() {
  printf '[soundclud-install] WARN: %s\n' "$*" >&2
}

die() {
  printf '[soundclud-install] ERROR: %s\n' "$*" >&2
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

detect_target_triple() {
  local os_kind="$1"
  local raw_arch
  raw_arch="$(uname -m)"
  case "${os_kind}:${raw_arch}" in
    darwin:x86_64) printf 'x86_64-apple-darwin' ;;
    darwin:arm64|darwin:aarch64) printf 'aarch64-apple-darwin' ;;
    linux:x86_64|linux:amd64) printf 'x86_64-unknown-linux-gnu' ;;
    linux:aarch64|linux:arm64) printf 'aarch64-unknown-linux-gnu' ;;
    *) die "Unsupported OS/architecture combination: ${os_kind}/${raw_arch}" ;;
  esac
}

compute_sha256() {
  local target_file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "${target_file}" | awk '{print tolower($1)}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${target_file}" | awk '{print tolower($1)}'
  elif command -v openssl >/dev/null 2>&1; then
    openssl dgst -sha256 "${target_file}" | awk '{print tolower($NF)}'
  else
    die "No SHA-256 utility available (expected shasum, sha256sum, or openssl)."
  fi
}

lookup_expected_sha256() {
  local target_name="$1"
  local checksum_file="$2"
  TARGET_BASENAME="${target_name}" awk '
    BEGIN {
      want = ENVIRON["TARGET_BASENAME"]
      found = ""
    }
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { next }
    {
      digest = tolower($1)
      if (digest !~ /^[0-9a-f]{64}$/) {
        next
      }
      line = $0
      sub(/^[[:space:]]*[0-9A-Fa-f]{64}[[:space:]]+\*?/, "", line)
      sub(/[[:space:]]+$/, "", line)
      n = split(line, parts, "/")
      base = parts[n]
      if (base == want || line == want) {
        found = digest
        exit
      }
    }
    END {
      if (found != "") {
        print found
      }
    }
  ' "${checksum_file}"
}

verify_file_against_checksum_file() {
  local file_path="$1"
  local checksum_file="$2"
  [ -f "${checksum_file}" ] || die "Checksum file does not exist: ${checksum_file}"
  local base_name
  base_name="$(basename -- "${file_path}")"
  local expected
  expected="$(lookup_expected_sha256 "${base_name}" "${checksum_file}")"
  if [ -z "${expected}" ]; then
    die "No SHA-256 entry found for '${base_name}' in ${checksum_file}"
  fi
  local actual
  actual="$(compute_sha256 "${file_path}")"
  if [ "${actual}" != "${expected}" ]; then
    die "SHA-256 mismatch for '${base_name}': expected ${expected}, got ${actual}"
  fi
  log_info "Verified SHA-256 for ${base_name} (${actual})"
}

verify_file_against_digest() {
  local file_path="$1"
  local raw_expected="$2"
  local expected
  expected="$(printf '%s' "${raw_expected}" | tr '[:upper:]' '[:lower:]')"
  case "${expected}" in
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f]*)
      if [ "${#expected}" -ne 64 ]; then
        die "Invalid SHA-256 digest length (expected 64 hex chars): ${raw_expected}"
      fi
      ;;
    *)
      die "Invalid SHA-256 hex digest: ${raw_expected}"
      ;;
  esac
  local actual
  actual="$(compute_sha256 "${file_path}")"
  local base_name
  base_name="$(basename -- "${file_path}")"
  if [ "${actual}" != "${expected}" ]; then
    die "SHA-256 mismatch for '${base_name}': expected ${expected}, got ${actual}"
  fi
  log_info "Verified SHA-256 for ${base_name} (${actual})"
}

read_mpv_manifest_field() {
  local manifest_file="$1"
  local target_triple="$2"
  local field_name="$3"
  [ -f "${manifest_file}" ] || die "mpv checksum manifest missing: ${manifest_file}"
  MPV_TARGET="${target_triple}" MPV_FIELD="${field_name}" awk '
    BEGIN {
      target = "\"" ENVIRON["MPV_TARGET"] "\""
      field = "\"" ENVIRON["MPV_FIELD"] "\""
      in_target = 0
    }
    index($0, target) > 0 && index($0, "{") > 0 {
      in_target = 1
      next
    }
    in_target == 1 && /^[[:space:]]*\}/ {
      in_target = 0
    }
    in_target == 1 && index($0, field) > 0 {
      line = $0
      sub(/^[^:]*:[[:space:]]*"/, "", line)
      sub(/",[[:space:]]*$/, "", line)
      sub(/"[[:space:]]*$/, "", line)
      print line
      exit
    }
  ' "${manifest_file}"
}

xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

render_template() {
  local template_path="$1"
  local output_path="$2"
  local escape_mode="$3"
  [ -f "${template_path}" ] || die "Service template missing: ${template_path}"

  local v_bin="${BIN_DIR}"
  local v_state="${STATE_DIR}"
  local v_log="${LOG_DIR}"
  local v_mpv="${RESOLVED_MPV_BIN}"
  local v_heos="${HEOS_ONLY}"
  local v_keep_awake="${KEEP_AWAKE}"

  if [ "${escape_mode}" = "xml" ]; then
    v_bin="$(xml_escape "${v_bin}")"
    v_state="$(xml_escape "${v_state}")"
    v_log="$(xml_escape "${v_log}")"
    v_mpv="$(xml_escape "${v_mpv}")"
    v_heos="$(xml_escape "${v_heos}")"
    v_keep_awake="$(xml_escape "${v_keep_awake}")"
  fi

  T_BIN_DIR="${v_bin}" \
  T_STATE_DIR="${v_state}" \
  T_LOG_DIR="${v_log}" \
  T_MPV_BIN="${v_mpv}" \
  T_HEOS_ONLY="${v_heos}" \
  T_KEEP_AWAKE="${v_keep_awake}" \
  awk '
    function replace_all(text, token, val,    out, pos, tlen) {
      out = ""
      tlen = length(token)
      while ((pos = index(text, token)) > 0) {
        out = out substr(text, 1, pos - 1) val
        text = substr(text, pos + tlen)
      }
      return out text
    }
    {
      line = $0
      line = replace_all(line, "{{BIN_DIR}}", ENVIRON["T_BIN_DIR"])
      line = replace_all(line, "{{STATE_DIR}}", ENVIRON["T_STATE_DIR"])
      line = replace_all(line, "{{LOG_DIR}}", ENVIRON["T_LOG_DIR"])
      line = replace_all(line, "{{MPV_BIN}}", ENVIRON["T_MPV_BIN"])
      line = replace_all(line, "{{HEOS_ONLY}}", ENVIRON["T_HEOS_ONLY"])
      line = replace_all(line, "{{KEEP_AWAKE}}", ENVIRON["T_KEEP_AWAKE"])
      print line
    }
  ' "${template_path}" > "${output_path}"
}

PREFIX="${HOME:-}/.local"
STATE_DIR=""
BIN_SOURCE=""
CHECKSUM_FILE=""
MPV_BIN_ARG=""
MPV_ARCHIVE_ARG=""
MPV_SHA256_ARG=""
HEOS_ONLY="0"
KEEP_AWAKE="0"
SKIP_SERVICE="0"
SERVICE_DIR_OVERRIDE=""
SYSTEM_DAEMON="0"
RELEASE_VERSION="latest"
GITHUB_REPO="${DEFAULT_REPO}"
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
    --bin-source)
      [ "$#" -ge 2 ] || die "--bin-source requires a file path"
      BIN_SOURCE="$2"
      shift 2
      ;;
    --bin-source=*)
      BIN_SOURCE="${1#*=}"
      shift
      ;;
    --checksum-file)
      [ "$#" -ge 2 ] || die "--checksum-file requires a file path"
      CHECKSUM_FILE="$2"
      shift 2
      ;;
    --checksum-file=*)
      CHECKSUM_FILE="${1#*=}"
      shift
      ;;
    --mpv-bin)
      [ "$#" -ge 2 ] || die "--mpv-bin requires a file path"
      MPV_BIN_ARG="$2"
      shift 2
      ;;
    --mpv-bin=*)
      MPV_BIN_ARG="${1#*=}"
      shift
      ;;
    --mpv-archive)
      [ "$#" -ge 2 ] || die "--mpv-archive requires a .tar.gz path"
      MPV_ARCHIVE_ARG="$2"
      shift 2
      ;;
    --mpv-archive=*)
      MPV_ARCHIVE_ARG="${1#*=}"
      shift
      ;;
    --mpv-sha256)
      [ "$#" -ge 2 ] || die "--mpv-sha256 requires a 64-character hex digest"
      MPV_SHA256_ARG="$2"
      shift 2
      ;;
    --mpv-sha256=*)
      MPV_SHA256_ARG="${1#*=}"
      shift
      ;;
    --heos-only)
      HEOS_ONLY="1"
      shift
      ;;
    --keep-awake)
      KEEP_AWAKE="1"
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
    --version)
      [ "$#" -ge 2 ] || die "--version requires a release tag"
      RELEASE_VERSION="$2"
      shift 2
      ;;
    --version=*)
      RELEASE_VERSION="${1#*=}"
      shift
      ;;
    --repo)
      [ "$#" -ge 2 ] || die "--repo requires owner/name"
      GITHUB_REPO="$2"
      shift 2
      ;;
    --repo=*)
      GITHUB_REPO="${1#*=}"
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

if [ -z "${PREFIX}" ]; then
  die "--prefix cannot be empty"
fi

if [ "${HEOS_ONLY}" = "1" ] && { [ -n "${MPV_BIN_ARG}" ] || [ -n "${MPV_ARCHIVE_ARG}" ]; }; then
  die "--heos-only cannot be combined with --mpv-bin or --mpv-archive"
fi

if [ -n "${MPV_BIN_ARG}" ] && [ -n "${MPV_ARCHIVE_ARG}" ]; then
  die "Specify at most one of --mpv-bin or --mpv-archive"
fi

OS_KIND="$(normalize_os "${TARGET_OS_OVERRIDE:-$(uname -s)}")"
TARGET_TRIPLE="$(detect_target_triple "${OS_KIND}")"

if [ -z "${STATE_DIR}" ]; then
  if [ "${OS_KIND}" = "darwin" ]; then
    [ -n "${HOME:-}" ] || die "\$HOME is unset; pass --state-dir explicitly"
    STATE_DIR="${HOME}/Library/Application Support/SoundClud"
  else
    [ -n "${HOME:-}" ] || [ -n "${XDG_STATE_HOME:-}" ] || die "\$HOME is unset; pass --state-dir explicitly"
    STATE_DIR="${XDG_STATE_HOME:-${HOME}/.local/state}/soundclud"
  fi
fi

if [ "${SYSTEM_DAEMON}" = "1" ] && [ "${OS_KIND}" != "darwin" ]; then
  die "--system-daemon is only supported on macOS (launchd)"
fi

if [ "${SYSTEM_DAEMON}" = "1" ] && [ "${SKIP_SERVICE}" = "0" ] && [ "${DRY_RUN}" = "0" ] && [ "$(id -u)" -ne 0 ]; then
  die "--system-daemon requires root privileges to write /Library/LaunchDaemons"
fi

if [ -n "${BIN_SOURCE}" ] && [ ! -f "${BIN_SOURCE}" ]; then
  die "--bin-source file does not exist: ${BIN_SOURCE}"
fi

if [ -n "${CHECKSUM_FILE}" ] && [ ! -f "${CHECKSUM_FILE}" ]; then
  die "--checksum-file does not exist: ${CHECKSUM_FILE}"
fi

if [ -n "${MPV_BIN_ARG}" ] && [ ! -f "${MPV_BIN_ARG}" ]; then
  die "--mpv-bin file does not exist: ${MPV_BIN_ARG}"
fi

if [ -n "${MPV_ARCHIVE_ARG}" ] && [ ! -f "${MPV_ARCHIVE_ARG}" ]; then
  die "--mpv-archive file does not exist: ${MPV_ARCHIVE_ARG}"
fi

# Verify local source checksums up-front (even in --dry-run mode)
if [ -n "${BIN_SOURCE}" ] && [ -n "${CHECKSUM_FILE}" ]; then
  verify_file_against_checksum_file "${BIN_SOURCE}" "${CHECKSUM_FILE}"
fi

BIN_DIR="${PREFIX}/bin"
SHARE_DIR="${PREFIX}/share/soundclud"
LOG_DIR="${STATE_DIR}/logs"

if [ "${OS_KIND}" = "darwin" ]; then
  RENDERED_UNIT_NAME="io.soundclud.receiver.plist"
  TEMPLATE_FILE="${PACKAGING_DIR}/launchd/io.soundclud.receiver.plist.tmpl"
  TEMPLATE_ESCAPE="xml"
  if [ -n "${SERVICE_DIR_OVERRIDE}" ]; then
    ACTIVE_SERVICE_DIR="${SERVICE_DIR_OVERRIDE}"
  elif [ "${SYSTEM_DAEMON}" = "1" ]; then
    ACTIVE_SERVICE_DIR="/Library/LaunchDaemons"
  else
    ACTIVE_SERVICE_DIR="${HOME}/Library/LaunchAgents"
  fi
else
  RENDERED_UNIT_NAME="soundclud-receiver.service"
  TEMPLATE_FILE="${PACKAGING_DIR}/systemd/soundclud-receiver.service.tmpl"
  TEMPLATE_ESCAPE="plain"
  if [ -n "${SERVICE_DIR_OVERRIDE}" ]; then
    ACTIVE_SERVICE_DIR="${SERVICE_DIR_OVERRIDE}"
  else
    ACTIVE_SERVICE_DIR="${XDG_CONFIG_HOME:-${HOME}/.config}/systemd/user"
  fi
fi

STAGED_UNIT_PATH="${SHARE_DIR}/${RENDERED_UNIT_NAME}"
ACTIVE_UNIT_PATH="${ACTIVE_SERVICE_DIR}/${RENDERED_UNIT_NAME}"

if [ "${DRY_RUN}" = "1" ]; then
  log_info "[DRY-RUN] Target: ${TARGET_TRIPLE} (OS=${OS_KIND})"
  log_info "[DRY-RUN] Prefix: ${PREFIX}"
  log_info "[DRY-RUN] Bin directory: ${BIN_DIR}"
  log_info "[DRY-RUN] Share directory: ${SHARE_DIR}"
  log_info "[DRY-RUN] State directory (0700): ${STATE_DIR}"
  log_info "[DRY-RUN] Log directory (0700): ${LOG_DIR}"
  if [ -n "${BIN_SOURCE}" ]; then
    log_info "[DRY-RUN] Receiver source: local file ${BIN_SOURCE}"
  else
    log_info "[DRY-RUN] Receiver source: GitHub release (${GITHUB_REPO} @ ${RELEASE_VERSION})"
  fi
  if [ "${HEOS_ONLY}" = "1" ]; then
    log_info "[DRY-RUN] Audio mode: pure-Rust HEOS Direct (--heos-only, zero mpv dependency)"
  elif [ -n "${MPV_BIN_ARG}" ]; then
    log_info "[DRY-RUN] mpv source: local executable ${MPV_BIN_ARG}"
  elif [ -n "${MPV_ARCHIVE_ARG}" ]; then
    log_info "[DRY-RUN] mpv source: local archive ${MPV_ARCHIVE_ARG}"
  else
    log_info "[DRY-RUN] mpv source: PATH or standalone SHA-256 verified archive"
  fi
  log_info "[DRY-RUN] Keep awake (caffeinate): ${KEEP_AWAKE}"
  log_info "[DRY-RUN] Rendered unit (staged): ${STAGED_UNIT_PATH}"
  if [ "${SKIP_SERVICE}" = "1" ]; then
    log_info "[DRY-RUN] Service activation: skipped (--skip-service)"
  else
    log_info "[DRY-RUN] Active service unit: ${ACTIVE_UNIT_PATH}"
  fi
  exit 0
fi

WORK_TMP="$(mktemp -d "${TMPDIR:-/tmp}/soundclud-install.XXXXXX")"
cleanup_tmp() {
  if [ -n "${WORK_TMP:-}" ] && [ -d "${WORK_TMP}" ]; then
    rm -rf -- "${WORK_TMP}"
  fi
}
trap cleanup_tmp EXIT INT TERM

mkdir -p "${BIN_DIR}" "${SHARE_DIR}" "${STATE_DIR}" "${LOG_DIR}"
chmod 700 "${STATE_DIR}" "${LOG_DIR}"

# Canonicalize directory paths now that they exist
PREFIX="$(CDPATH='' cd -- "${PREFIX}" && pwd)"
BIN_DIR="$(CDPATH='' cd -- "${BIN_DIR}" && pwd)"
SHARE_DIR="$(CDPATH='' cd -- "${SHARE_DIR}" && pwd)"
STATE_DIR="$(CDPATH='' cd -- "${STATE_DIR}" && pwd)"
LOG_DIR="$(CDPATH='' cd -- "${LOG_DIR}" && pwd)"
STAGED_UNIT_PATH="${SHARE_DIR}/${RENDERED_UNIT_NAME}"

extract_binary_from_archive() {
  local archive_path="$1"
  local dest_bin="$2"
  local unpack_dir="${WORK_TMP}/receiver-unpack"
  rm -rf -- "${unpack_dir}"
  mkdir -p "${unpack_dir}"
  tar -xzf "${archive_path}" -C "${unpack_dir}"
  local found_bin
  found_bin="$(find "${unpack_dir}" -type f -name 'soundclud-receiver' | head -n 1)"
  [ -n "${found_bin}" ] || die "Archive did not contain a 'soundclud-receiver' binary: ${archive_path}"
  cp -f "${found_bin}" "${dest_bin}"
  chmod 0755 "${dest_bin}"
}

install_receiver_binary() {
  local target_bin="${BIN_DIR}/soundclud-receiver"
  if [ -n "${BIN_SOURCE}" ]; then
    case "${BIN_SOURCE}" in
      *.tar.gz|*.tgz)
        extract_binary_from_archive "${BIN_SOURCE}" "${target_bin}"
        ;;
      *)
        cp -f "${BIN_SOURCE}" "${target_bin}"
        chmod 0755 "${target_bin}"
        ;;
    esac
    log_info "Installed soundclud-receiver from ${BIN_SOURCE} -> ${target_bin}"
  else
    command -v curl >/dev/null 2>&1 || die "curl is required for online download (or pass --bin-source <path>)"
    local base_url
    local asset_name
    if [ "${RELEASE_VERSION}" = "latest" ]; then
      # Resolve latest release tag via GitHub redirect header without jq/python
      local effective_url
      effective_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/${GITHUB_REPO}/releases/latest")"
      local resolved_tag="${effective_url##*/}"
      case "${resolved_tag}" in
        v*) ;;
        *) die "Unable to resolve latest release tag from https://github.com/${GITHUB_REPO}/releases/latest (pass --version vX.Y.Z or --bin-source)" ;;
      esac
      asset_name="soundclud-receiver-${resolved_tag}-${TARGET_TRIPLE}.tar.gz"
      base_url="https://github.com/${GITHUB_REPO}/releases/download/${resolved_tag}"
    else
      local tag_norm="${RELEASE_VERSION}"
      case "${tag_norm}" in
        v*) ;;
        *) tag_norm="v${tag_norm}" ;;
      esac
      asset_name="soundclud-receiver-${tag_norm}-${TARGET_TRIPLE}.tar.gz"
      base_url="https://github.com/${GITHUB_REPO}/releases/download/${tag_norm}"
    fi

    local dl_archive="${WORK_TMP}/${asset_name}"
    local dl_sums="${CHECKSUM_FILE}"
    log_info "Downloading ${base_url}/${asset_name}..."
    curl -fsSL "${base_url}/${asset_name}" -o "${dl_archive}"

    if [ -z "${dl_sums}" ]; then
      dl_sums="${WORK_TMP}/SHA256SUMS.txt"
      log_info "Downloading ${base_url}/SHA256SUMS.txt..."
      curl -fsSL "${base_url}/SHA256SUMS.txt" -o "${dl_sums}"
    fi

    verify_file_against_checksum_file "${dl_archive}" "${dl_sums}"
    extract_binary_from_archive "${dl_archive}" "${target_bin}"
    log_info "Installed verified soundclud-receiver -> ${target_bin}"
  fi

  if [ "${OS_KIND}" = "darwin" ] && command -v xattr >/dev/null 2>&1; then
    xattr -d com.apple.quarantine "${target_bin}" 2>/dev/null || true
  fi
  if [ "${OS_KIND}" = "darwin" ] && command -v codesign >/dev/null 2>&1; then
    codesign --force --sign - --identifier io.soundclud.receiver "${target_bin}" >/dev/null 2>&1 || true
  fi

  local wrapper_src="${PACKAGING_DIR}/launchd/run-receiver.sh"
  if [ -f "${wrapper_src}" ]; then
    cp -f "${wrapper_src}" "${BIN_DIR}/run-receiver.sh"
    chmod 0755 "${BIN_DIR}/run-receiver.sh"
    if [ "${OS_KIND}" = "darwin" ] && command -v xattr >/dev/null 2>&1; then
      xattr -d com.apple.quarantine "${BIN_DIR}/run-receiver.sh" 2>/dev/null || true
    fi
  fi
}

install_mpv_from_archive() {
  local archive_path="$1"
  local unpack_dir="${WORK_TMP}/mpv-unpack"
  rm -rf -- "${unpack_dir}"
  mkdir -p "${unpack_dir}"
  tar -xzf "${archive_path}" -C "${unpack_dir}"

  local app_bundle
  app_bundle="$(find "${unpack_dir}" -type d -name 'mpv.app' | head -n 1)"
  if [ -n "${app_bundle}" ] && [ -f "${app_bundle}/Contents/MacOS/mpv" ]; then
    rm -rf -- "${SHARE_DIR}/mpv.app"
    cp -R "${app_bundle}" "${SHARE_DIR}/mpv.app"
    chmod 0755 "${SHARE_DIR}/mpv.app/Contents/MacOS/mpv"
    if [ "${OS_KIND}" = "darwin" ] && command -v xattr >/dev/null 2>&1; then
      xattr -dr com.apple.quarantine "${SHARE_DIR}/mpv.app" 2>/dev/null || true
    fi
    ln -sf "${SHARE_DIR}/mpv.app/Contents/MacOS/mpv" "${BIN_DIR}/mpv"
    return 0
  fi

  local plain_mpv
  plain_mpv="$(find "${unpack_dir}" -type f -name 'mpv' | head -n 1)"
  [ -n "${plain_mpv}" ] || die "mpv archive did not contain mpv.app or mpv binary: ${archive_path}"
  cp -f "${plain_mpv}" "${BIN_DIR}/mpv"
  chmod 0755 "${BIN_DIR}/mpv"
  if [ "${OS_KIND}" = "darwin" ] && command -v xattr >/dev/null 2>&1; then
    xattr -d com.apple.quarantine "${BIN_DIR}/mpv" 2>/dev/null || true
  fi
}

RESOLVED_MPV_BIN=""
MPV_MANAGED="0"

provision_mpv_if_needed() {
  if [ "${HEOS_ONLY}" = "1" ]; then
    RESOLVED_MPV_BIN=""
    MPV_MANAGED="0"
    log_info "Configured pure-Rust HEOS Direct mode (--heos-only); skipping mpv installation."
    return 0
  fi

  if [ -n "${MPV_BIN_ARG}" ]; then
    local mpv_src_abs
    mpv_src_abs="$(CDPATH='' cd -- "$(dirname -- "${MPV_BIN_ARG}")" && pwd)/$(basename -- "${MPV_BIN_ARG}")"
    case "${mpv_src_abs}" in
      *.app/Contents/MacOS/*)
        ln -sf "${mpv_src_abs}" "${BIN_DIR}/mpv"
        ;;
      *)
        if [ "${mpv_src_abs}" != "${BIN_DIR}/mpv" ]; then
          cp -f "${mpv_src_abs}" "${BIN_DIR}/mpv"
        fi
        chmod 0755 "${BIN_DIR}/mpv"
        ;;
    esac
    if [ "${OS_KIND}" = "darwin" ] && command -v xattr >/dev/null 2>&1; then
      xattr -d com.apple.quarantine "${BIN_DIR}/mpv" 2>/dev/null || true
    fi
    RESOLVED_MPV_BIN="${BIN_DIR}/mpv"
    MPV_MANAGED="1"
    log_info "Provisioned standalone mpv -> ${RESOLVED_MPV_BIN}"
    return 0
  fi

  local manifest_path="${PACKAGING_DIR}/mpv/mpv-checksums.json"

  if [ -n "${MPV_ARCHIVE_ARG}" ]; then
    if [ -n "${MPV_SHA256_ARG}" ]; then
      verify_file_against_digest "${MPV_ARCHIVE_ARG}" "${MPV_SHA256_ARG}"
    elif [ -n "${CHECKSUM_FILE}" ] && [ -n "$(lookup_expected_sha256 "$(basename -- "${MPV_ARCHIVE_ARG}")" "${CHECKSUM_FILE}")" ]; then
      verify_file_against_checksum_file "${MPV_ARCHIVE_ARG}" "${CHECKSUM_FILE}"
    else
      local expected_manifest_sha
      expected_manifest_sha="$(read_mpv_manifest_field "${manifest_path}" "${TARGET_TRIPLE}" "sha256")"
      [ -n "${expected_manifest_sha}" ] || die "No mpv SHA-256 entry for ${TARGET_TRIPLE} in ${manifest_path} (pass --mpv-sha256)"
      verify_file_against_digest "${MPV_ARCHIVE_ARG}" "${expected_manifest_sha}"
    fi
    install_mpv_from_archive "${MPV_ARCHIVE_ARG}"
    RESOLVED_MPV_BIN="${BIN_DIR}/mpv"
    MPV_MANAGED="1"
    log_info "Provisioned verified mpv archive -> ${RESOLVED_MPV_BIN}"
    return 0
  fi

  if [ -x "${BIN_DIR}/mpv" ]; then
    RESOLVED_MPV_BIN="${BIN_DIR}/mpv"
    log_info "Using existing mpv at ${RESOLVED_MPV_BIN}"
    return 0
  fi

  if command -v mpv >/dev/null 2>&1; then
    RESOLVED_MPV_BIN="$(command -v mpv)"
    MPV_MANAGED="0"
    log_info "Detected existing mpv on PATH: ${RESOLVED_MPV_BIN}"
    return 0
  fi

  if [ "${OS_KIND}" = "darwin" ]; then
    command -v curl >/dev/null 2>&1 || die "curl is required to download standalone mpv (or pass --mpv-bin, --mpv-archive, or --heos-only)"
    local mpv_url
    local mpv_sha256
    local mpv_archive_name
    mpv_url="$(read_mpv_manifest_field "${manifest_path}" "${TARGET_TRIPLE}" "url")"
    mpv_sha256="$(read_mpv_manifest_field "${manifest_path}" "${TARGET_TRIPLE}" "sha256")"
    mpv_archive_name="$(read_mpv_manifest_field "${manifest_path}" "${TARGET_TRIPLE}" "archive")"
    [ -n "${mpv_url}" ] && [ -n "${mpv_sha256}" ] || die "Missing standalone mpv metadata for ${TARGET_TRIPLE} in ${manifest_path}"

    local dl_mpv="${WORK_TMP}/${mpv_archive_name:-mpv.tar.gz}"
    log_info "Downloading standalone macOS 11+ mpv (${TARGET_TRIPLE}) from ${mpv_url}..."
    curl -fsSL "${mpv_url}" -o "${dl_mpv}"
    verify_file_against_digest "${dl_mpv}" "${mpv_sha256}"
    install_mpv_from_archive "${dl_mpv}"
    RESOLVED_MPV_BIN="${BIN_DIR}/mpv"
    MPV_MANAGED="1"
    log_info "Installed standalone SHA-256 verified mpv -> ${RESOLVED_MPV_BIN}"
    return 0
  fi

  die "mpv was not found on PATH. Install mpv via your OS package manager (e.g., apt/dnf/pacman), supply --mpv-bin <path>, or pass --heos-only for pure-Rust HEOS Direct streaming."
}

activate_service() {
  render_template "${TEMPLATE_FILE}" "${STAGED_UNIT_PATH}" "${TEMPLATE_ESCAPE}"
  chmod 0644 "${STAGED_UNIT_PATH}"

  if [ "${OS_KIND}" = "darwin" ] && [ "$(uname -s)" = "Darwin" ] && command -v plutil >/dev/null 2>&1; then
    plutil -lint -s "${STAGED_UNIT_PATH}" || die "Rendered plist failed plutil validation: ${STAGED_UNIT_PATH}"
  fi

  log_info "Rendered service definition -> ${STAGED_UNIT_PATH}"

  if [ -n "${SERVICE_DIR_OVERRIDE}" ]; then
    mkdir -p "${ACTIVE_SERVICE_DIR}"
    cp -f "${STAGED_UNIT_PATH}" "${ACTIVE_UNIT_PATH}"
    chmod 0644 "${ACTIVE_UNIT_PATH}"
  fi

  if [ "${SKIP_SERVICE}" = "1" ]; then
    log_info "Skipping service manager registration (--skip-service)."
    return 0
  fi

  mkdir -p "${ACTIVE_SERVICE_DIR}"
  cp -f "${STAGED_UNIT_PATH}" "${ACTIVE_UNIT_PATH}"
  chmod 0644 "${ACTIVE_UNIT_PATH}"

  if [ "${OS_KIND}" = "darwin" ]; then
    if [ "${SYSTEM_DAEMON}" = "1" ]; then
      chown root:wheel "${ACTIVE_UNIT_PATH}" 2>/dev/null || true
      launchctl bootout system/io.soundclud.receiver 2>/dev/null || launchctl unload "${ACTIVE_UNIT_PATH}" 2>/dev/null || true
      launchctl bootstrap system "${ACTIVE_UNIT_PATH}" 2>/dev/null || launchctl load -w "${ACTIVE_UNIT_PATH}"
      launchctl kickstart -k system/io.soundclud.receiver 2>/dev/null || true
      log_info "Loaded system LaunchDaemon: ${ACTIVE_UNIT_PATH}"
    else
      local uid_num
      uid_num="$(id -u)"
      launchctl bootout "gui/${uid_num}/io.soundclud.receiver" 2>/dev/null || launchctl unload "${ACTIVE_UNIT_PATH}" 2>/dev/null || true
      if ! launchctl bootstrap "gui/${uid_num}" "${ACTIVE_UNIT_PATH}" 2>/dev/null; then
        launchctl load -w "${ACTIVE_UNIT_PATH}"
        launchctl kickstart -k "gui/${uid_num}/io.soundclud.receiver" 2>/dev/null || true
      fi
      log_info "Loaded user LaunchAgent: ${ACTIVE_UNIT_PATH}"
    fi
  else
    if command -v systemctl >/dev/null 2>&1; then
      systemctl --user daemon-reload
      systemctl --user enable --now soundclud-receiver.service
      log_info "Enabled and started systemd user unit: ${ACTIVE_UNIT_PATH}"
    else
      log_warn "systemctl not found; copied unit file to ${ACTIVE_UNIT_PATH} without starting."
    fi

    if command -v loginctl >/dev/null 2>&1; then
      local current_user
      current_user="$(id -un)"
      local linger_state
      linger_state="$(loginctl show-user "${current_user}" -p Linger --value 2>/dev/null || true)"
      if [ "${linger_state}" != "yes" ]; then
        log_info "Tip: enable headless boot persistence on Linux with: loginctl enable-linger \"${current_user}\""
      fi
    fi
  fi
}

write_install_receipt() {
  local receipt_path="${SHARE_DIR}/install-receipt.env"
  local service_mode="user"
  if [ "${SKIP_SERVICE}" = "1" ]; then
    service_mode="skipped"
  elif [ "${SYSTEM_DAEMON}" = "1" ]; then
    service_mode="system"
  fi

  cat > "${receipt_path}" <<EOF
OS_KIND=${OS_KIND}
TARGET_TRIPLE=${TARGET_TRIPLE}
MPV_MANAGED=${MPV_MANAGED}
HEOS_ONLY=${HEOS_ONLY}
KEEP_AWAKE=${KEEP_AWAKE}
SERVICE_MODE=${service_mode}
RENDERED_UNIT_NAME=${RENDERED_UNIT_NAME}
EOF
  chmod 0644 "${receipt_path}"
}

install_receiver_binary
provision_mpv_if_needed
activate_service
write_install_receipt

log_info "Installation complete (prefix=${PREFIX}, state=${STATE_DIR})."
