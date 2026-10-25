#!/usr/bin/env bash
# SoundClud Universal 2 macOS App Bundle (`SoundClud.app`) & Disk Image (`.dmg`) Builder
#
# Targets macOS 11.0 Big Sur / macOS 12 Monterey+ (`MACOSX_DEPLOYMENT_TARGET=11.0`)
# across both Apple Silicon (`arm64`) and Intel (`x86_64`, e.g., Late 2014 Mac Mini Macmini7,1)
# with zero Homebrew, zero SwiftUI 13+ dependency, and verified Universal 2 Mach-O fat binaries.

set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(CDPATH='' cd -- "${SCRIPT_DIR}/.." && pwd)"

export PATH="${HOME:-}/.cargo/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin${PATH:+:${PATH}}"

usage() {
  cat <<'EOF'
Usage: build-macos-dmg.sh [options]

Builds Universal 2 (arm64 + x86_64, macOS 11.0+) `SoundClud.app` and
`SoundClud-v<version>-macOS-Universal.dmg`.

Options:
  --version <ver>        Release version (defaults to package.json version)
  --arm64-bin <path>     Prebuilt aarch64-apple-darwin `soundclud-receiver` binary (or .tar.gz)
  --x86_64-bin <path>    Prebuilt x86_64-apple-darwin `soundclud-receiver` binary (or .tar.gz)
  --extension-dir <dir>  Built MV3 extension directory (default: packages/extension/dist)
  --output-dir <dir>     Output directory for SoundClud.app / .dmg (default: dist)
  --app-only             Build and verify SoundClud.app without creating the .dmg image
  -h, --help             Show this help message and exit
EOF
}

log_info() {
  printf '[build-macos-dmg] %s\n' "$*"
}

die() {
  printf '[build-macos-dmg] ERROR: %s\n' "$*" >&2
  exit 1
}

if [ "$(uname -s)" != "Darwin" ]; then
  die "build-macos-dmg.sh must be executed on macOS (Darwin)."
fi

VERSION_ARG=""
ARM64_BIN_ARG=""
X86_64_BIN_ARG=""
EXTENSION_DIR_ARG=""
OUTPUT_DIR_ARG="${REPO_ROOT}/dist"
APP_ONLY="0"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --version)
      [ "$#" -ge 2 ] || die "--version requires an argument"
      VERSION_ARG="$2"
      shift 2
      ;;
    --version=*)
      VERSION_ARG="${1#*=}"
      shift
      ;;
    --arm64-bin)
      [ "$#" -ge 2 ] || die "--arm64-bin requires a file path"
      ARM64_BIN_ARG="$2"
      shift 2
      ;;
    --arm64-bin=*)
      ARM64_BIN_ARG="${1#*=}"
      shift
      ;;
    --x86_64-bin)
      [ "$#" -ge 2 ] || die "--x86_64-bin requires a file path"
      X86_64_BIN_ARG="$2"
      shift 2
      ;;
    --x86_64-bin=*)
      X86_64_BIN_ARG="${1#*=}"
      shift
      ;;
    --extension-dir)
      [ "$#" -ge 2 ] || die "--extension-dir requires a directory path"
      EXTENSION_DIR_ARG="$2"
      shift 2
      ;;
    --extension-dir=*)
      EXTENSION_DIR_ARG="${1#*=}"
      shift
      ;;
    --output-dir)
      [ "$#" -ge 2 ] || die "--output-dir requires a directory path"
      OUTPUT_DIR_ARG="$2"
      shift 2
      ;;
    --output-dir=*)
      OUTPUT_DIR_ARG="${1#*=}"
      shift
      ;;
    --app-only)
      APP_ONLY="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1 (pass --help for usage)"
      ;;
  esac
done

for required_cmd in swiftc lipo codesign plutil iconutil sips node; do
  command -v "${required_cmd}" >/dev/null 2>&1 || die "Required macOS build tool not found: ${required_cmd}"
done

if [ "${APP_ONLY}" != "1" ]; then
  command -v hdiutil >/dev/null 2>&1 || die "Required macOS disk image tool not found: hdiutil"
fi

if [ -z "${VERSION_ARG}" ]; then
  VERSION_ARG="$(node -e "const fs=require('node:fs');console.log(JSON.parse(fs.readFileSync(process.argv[1],'utf8')).version);" "${REPO_ROOT}/package.json")"
fi

CLEAN_VERSION="${VERSION_ARG#v}"
[ -n "${CLEAN_VERSION}" ] || die "Resolved version cannot be empty"

WORK_TMP="$(mktemp -d "${TMPDIR:-/tmp}/soundclud-macos-dmg.XXXXXX")"
cleanup_tmp() {
  if [ -n "${WORK_TMP:-}" ] && [ -d "${WORK_TMP}" ]; then
    rm -rf -- "${WORK_TMP}"
  fi
}
trap cleanup_tmp EXIT INT TERM

resolve_or_extract_receiver_bin() {
  local input_path="$1"
  local label="$2"
  [ -f "${input_path}" ] || die "${label} binary/archive does not exist: ${input_path}"
  case "${input_path}" in
    *.tar.gz|*.tgz)
      local unpack_dir="${WORK_TMP}/unpack-${label}"
      mkdir -p "${unpack_dir}"
      tar -xzf "${input_path}" -C "${unpack_dir}"
      local extracted
      extracted="$(find "${unpack_dir}" -type f -name 'soundclud-receiver' | head -n 1)"
      [ -n "${extracted}" ] || die "Archive did not contain soundclud-receiver: ${input_path}"
      printf '%s' "${extracted}"
      ;;
    *)
      printf '%s' "${input_path}"
      ;;
  esac
}

assert_has_arch() {
  local bin_path="$1"
  local expected_arch="$2"
  local archs
  archs="$(lipo -archs "${bin_path}")"
  case " ${archs} " in
    *" ${expected_arch} "*) ;;
    *) die "Expected Mach-O architecture '${expected_arch}' in ${bin_path}, found: '${archs}'" ;;
  esac
}

# 1. Resolve or compile arm64 + x86_64 `soundclud-receiver` binaries (MACOSX_DEPLOYMENT_TARGET=11.0)
if [ -n "${ARM64_BIN_ARG}" ]; then
  ARM64_RECEIVER_BIN="$(resolve_or_extract_receiver_bin "${ARM64_BIN_ARG}" "arm64")"
else
  command -v cargo >/dev/null 2>&1 || die "cargo is required when --arm64-bin is omitted"
  log_info "Building soundclud-receiver (aarch64-apple-darwin, MACOSX_DEPLOYMENT_TARGET=11.0)..."
  MACOSX_DEPLOYMENT_TARGET=11.0 cargo build \
    --manifest-path "${REPO_ROOT}/Cargo.toml" \
    --release \
    --package soundclud-receiver \
    --bin soundclud-receiver \
    --target aarch64-apple-darwin
  ARM64_RECEIVER_BIN="${REPO_ROOT}/target/aarch64-apple-darwin/release/soundclud-receiver"
fi
assert_has_arch "${ARM64_RECEIVER_BIN}" "arm64"

if [ -n "${X86_64_BIN_ARG}" ]; then
  X86_64_RECEIVER_BIN="$(resolve_or_extract_receiver_bin "${X86_64_BIN_ARG}" "x86_64")"
else
  command -v cargo >/dev/null 2>&1 || die "cargo is required when --x86_64-bin is omitted"
  log_info "Building soundclud-receiver (x86_64-apple-darwin, MACOSX_DEPLOYMENT_TARGET=11.0)..."
  MACOSX_DEPLOYMENT_TARGET=11.0 cargo build \
    --manifest-path "${REPO_ROOT}/Cargo.toml" \
    --release \
    --package soundclud-receiver \
    --bin soundclud-receiver \
    --target x86_64-apple-darwin
  X86_64_RECEIVER_BIN="${REPO_ROOT}/target/x86_64-apple-darwin/release/soundclud-receiver"
fi
assert_has_arch "${X86_64_RECEIVER_BIN}" "x86_64"

# 2. Resolve or build Chromium MV3 unpacked extension directory
if [ -n "${EXTENSION_DIR_ARG}" ]; then
  EXTENSION_SRC_DIR="${EXTENSION_DIR_ARG}"
else
  EXTENSION_SRC_DIR="${REPO_ROOT}/packages/extension/dist"
  if [ ! -f "${EXTENSION_SRC_DIR}/manifest.json" ]; then
    log_info "Building @soundclud/extension bundle..."
    npm --prefix "${REPO_ROOT}" run build:extension
  fi
fi
[ -f "${EXTENSION_SRC_DIR}/manifest.json" ] || die "Extension manifest.json missing in: ${EXTENSION_SRC_DIR}"

mkdir -p "${OUTPUT_DIR_ARG}"
OUTPUT_DIR_ABS="$(CDPATH='' cd -- "${OUTPUT_DIR_ARG}" && pwd)"

STAGED_APP_DIR="${WORK_TMP}/SoundClud.app"
mkdir -p \
  "${STAGED_APP_DIR}/Contents/MacOS" \
  "${STAGED_APP_DIR}/Contents/Resources/packaging"

# 3. Create Universal 2 `soundclud-receiver` Mach-O fat binary
UNIVERSAL_RECEIVER_BIN="${STAGED_APP_DIR}/Contents/MacOS/soundclud-receiver"
if [ "${ARM64_RECEIVER_BIN}" = "${X86_64_RECEIVER_BIN}" ]; then
  cp -f "${ARM64_RECEIVER_BIN}" "${UNIVERSAL_RECEIVER_BIN}"
else
  lipo -create "${ARM64_RECEIVER_BIN}" "${X86_64_RECEIVER_BIN}" -output "${UNIVERSAL_RECEIVER_BIN}"
fi
chmod 0755 "${UNIVERSAL_RECEIVER_BIN}"
assert_has_arch "${UNIVERSAL_RECEIVER_BIN}" "arm64"
assert_has_arch "${UNIVERSAL_RECEIVER_BIN}" "x86_64"
log_info "Verified Universal 2 soundclud-receiver archs: $(lipo -archs "${UNIVERSAL_RECEIVER_BIN}")"

# 4. Compile Swift AppKit GUI for arm64-apple-macosx11.0 & x86_64-apple-macosx11.0 and lipo
SWIFT_SOURCES=("${REPO_ROOT}"/packaging/macos-app/Sources/*.swift)
[ -f "${SWIFT_SOURCES[0]}" ] || die "No Swift sources found under packaging/macos-app/Sources/"

log_info "Compiling SoundClud AppKit GUI (arm64-apple-macosx11.0 + x86_64-apple-macosx11.0)..."
MACOSX_DEPLOYMENT_TARGET=11.0 swiftc \
  -parse-as-library \
  -O \
  -target arm64-apple-macosx11.0 \
  "${SWIFT_SOURCES[@]}" \
  -o "${WORK_TMP}/SoundClud-arm64" &
PID_SWIFT_ARM64=$!

MACOSX_DEPLOYMENT_TARGET=11.0 swiftc \
  -parse-as-library \
  -O \
  -target x86_64-apple-macosx11.0 \
  "${SWIFT_SOURCES[@]}" \
  -o "${WORK_TMP}/SoundClud-x86_64" &
PID_SWIFT_X86_64=$!

wait "${PID_SWIFT_ARM64}"
wait "${PID_SWIFT_X86_64}"

UNIVERSAL_GUI_BIN="${STAGED_APP_DIR}/Contents/MacOS/SoundClud"
lipo -create \
  "${WORK_TMP}/SoundClud-arm64" \
  "${WORK_TMP}/SoundClud-x86_64" \
  -output "${UNIVERSAL_GUI_BIN}"
chmod 0755 "${UNIVERSAL_GUI_BIN}"
assert_has_arch "${UNIVERSAL_GUI_BIN}" "arm64"
assert_has_arch "${UNIVERSAL_GUI_BIN}" "x86_64"
log_info "Verified Universal 2 SoundClud GUI archs: $(lipo -archs "${UNIVERSAL_GUI_BIN}")"

# 5. Generate AppIcon.icns, copy extension & packaging scripts, and render Info.plist
log_info "Generating Retina AppIcon.icns..."
node "${REPO_ROOT}/packaging/macos-app/generate-icns.mjs" \
  --output "${STAGED_APP_DIR}/Contents/Resources/AppIcon.icns"

cp -R "${EXTENSION_SRC_DIR}" "${STAGED_APP_DIR}/Contents/Resources/chrome-extension"
find "${STAGED_APP_DIR}/Contents/Resources/chrome-extension" -name '.DS_Store' -delete 2>/dev/null || true

cp -R "${REPO_ROOT}/packaging/install" "${STAGED_APP_DIR}/Contents/Resources/packaging/install"
cp -R "${REPO_ROOT}/packaging/launchd" "${STAGED_APP_DIR}/Contents/Resources/packaging/launchd"
cp -R "${REPO_ROOT}/packaging/mpv" "${STAGED_APP_DIR}/Contents/Resources/packaging/mpv"
chmod 0755 \
  "${STAGED_APP_DIR}/Contents/Resources/packaging/install/install.sh" \
  "${STAGED_APP_DIR}/Contents/Resources/packaging/install/uninstall.sh" \
  "${STAGED_APP_DIR}/Contents/Resources/packaging/launchd/run-receiver.sh"

INFO_PLIST_TEMPLATE="${REPO_ROOT}/packaging/macos-app/Info.plist.tmpl"
INFO_PLIST_DEST="${STAGED_APP_DIR}/Contents/Info.plist"
[ -f "${INFO_PLIST_TEMPLATE}" ] || die "Missing Info.plist template: ${INFO_PLIST_TEMPLATE}"

ESCAPED_VERSION="$(printf '%s' "${CLEAN_VERSION}" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g')"
T_VERSION="${ESCAPED_VERSION}" awk '
  {
    line = $0
    while ((pos = index(line, "{{VERSION}}")) > 0) {
      line = substr(line, 1, pos - 1) ENVIRON["T_VERSION"] substr(line, pos + 11)
    }
    print line
  }
' "${INFO_PLIST_TEMPLATE}" > "${INFO_PLIST_DEST}"
printf 'APPL????' > "${STAGED_APP_DIR}/Contents/PkgInfo"

plutil -lint -s "${INFO_PLIST_DEST}" || die "Rendered Info.plist failed plutil validation"

# Strip stray Finder extended attributes prior to strict ad-hoc signing
find "${STAGED_APP_DIR}" -name '.DS_Store' -delete 2>/dev/null || true
if command -v xattr >/dev/null 2>&1; then
  xattr -cr "${STAGED_APP_DIR}" 2>/dev/null || true
fi

# 6. Ad-hoc sign nested executables and outer bundle, then verify strictly
log_info "Ad-hoc signing SoundClud.app..."
codesign --force --sign - --identifier io.soundclud.receiver "${UNIVERSAL_RECEIVER_BIN}"
codesign --force --sign - --identifier io.soundclud.app "${UNIVERSAL_GUI_BIN}"
codesign --force --sign - --identifier io.soundclud.app "${STAGED_APP_DIR}"
codesign --verify --deep --strict "${STAGED_APP_DIR}"
log_info "Verified codesign --verify --deep --strict on SoundClud.app"

if [ "${APP_ONLY}" = "1" ]; then
  FINAL_APP_PATH="${OUTPUT_DIR_ABS}/SoundClud.app"
  rm -rf -- "${FINAL_APP_PATH}"
  ditto "${STAGED_APP_DIR}" "${FINAL_APP_PATH}"
  codesign --verify --deep --strict "${FINAL_APP_PATH}"
  log_info "Built Universal 2 app bundle (--app-only): ${FINAL_APP_PATH}"
  exit 0
fi

# 7. Stage DMG root (`SoundClud.app`, `/Applications` symlink, and `SoundClud Chrome Extension`)
DMG_STAGE_DIR="${WORK_TMP}/dmg-stage"
mkdir -p "${DMG_STAGE_DIR}"
ditto "${STAGED_APP_DIR}" "${DMG_STAGE_DIR}/SoundClud.app"
ln -s /Applications "${DMG_STAGE_DIR}/Applications"
cp -R "${EXTENSION_SRC_DIR}" "${DMG_STAGE_DIR}/SoundClud Chrome Extension"
find "${DMG_STAGE_DIR}" -name '.DS_Store' -delete 2>/dev/null || true

DMG_FILENAME="SoundClud-v${CLEAN_VERSION}-macOS-Universal.dmg"
DMG_OUTPUT_PATH="${OUTPUT_DIR_ABS}/${DMG_FILENAME}"
rm -f -- "${DMG_OUTPUT_PATH}"

log_info "Creating compressed UDZO disk image -> ${DMG_OUTPUT_PATH}..."
HDIUTIL_ATTEMPT=1
until hdiutil create \
  -volname "SoundClud v${CLEAN_VERSION}" \
  -srcfolder "${DMG_STAGE_DIR}" \
  -ov \
  -format UDZO \
  -imagekey zlib-level=9 \
  "${DMG_OUTPUT_PATH}"; do
  if [ "${HDIUTIL_ATTEMPT}" -ge 3 ]; then
    die "hdiutil create failed after ${HDIUTIL_ATTEMPT} attempts"
  fi
  log_info "Retrying hdiutil create (attempt $((HDIUTIL_ATTEMPT + 1))/3)..."
  HDIUTIL_ATTEMPT=$((HDIUTIL_ATTEMPT + 1))
  sleep 2
done

[ -s "${DMG_OUTPUT_PATH}" ] || die "Expected non-empty DMG at ${DMG_OUTPUT_PATH}"
log_info "Successfully built Universal 2 DMG: ${DMG_OUTPUT_PATH}"
