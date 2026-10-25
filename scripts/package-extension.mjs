#!/usr/bin/env node

/**
 * SoundClud Chromium MV3 Extension Deterministic Packager & Verifier.
 *
 * Zero-dependency Node ESM utility that:
 * 1. Validates `packages/extension/dist/manifest.json` (MV3 compliance, zero `"cookies"`
 *    permission, zero `ws://` / `wss://` host_permissions, valid PNG icon dimensions,
 *    and existence of all referenced bundles/HTML/CSS/resources).
 * 2. Packages `packages/extension/dist` into a reproducible PKZIP archive
 *    (`dist/soundclud-extension-v<version>.zip`) without requiring external `zip` binaries.
 * 3. Computes and writes its SHA-256 digest (`dist/soundclud-extension-v<version>.zip.sha256`).
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const EXCLUDED_NAMES = new Set([
  '.DS_Store',
  'Thumbs.db',
  'Desktop.ini',
  '.git',
  'node_modules',
  'CHROMEWEBSTORE.md',
]);

const EXCLUDED_SUFFIXES = ['.map', '.tsbuildinfo', '.test.js', '.spec.js', '.test.ts', '.spec.ts'];

// Fixed DOS timestamp (2025-01-01 00:00:00) for bit-for-bit reproducible archives.
const DETERMINISTIC_DOS_TIME = 0x0000;
const DETERMINISTIC_DOS_DATE = ((2025 - 1980) << 9) | (1 << 5) | 1;

/** @type {Uint32Array | null} */
let crcTableCache = null;

/**
 * Computes IEEE 802.3 CRC-32 for a Buffer.
 * @param {Buffer} buffer
 * @returns {number}
 */
export function computeCrc32(buffer) {
  if (typeof zlib.crc32 === 'function') {
    return zlib.crc32(buffer) >>> 0;
  }
  if (crcTableCache === null) {
    crcTableCache = new Uint32Array(256);
    for (let i = 0; i < 256; i += 1) {
      let c = i;
      for (let k = 0; k < 8; k += 1) {
        c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTableCache[i] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    const byte = buffer[i] ?? 0;
    crc = (crcTableCache[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Reads width and height from a PNG IHDR header.
 * @param {Buffer} pngBuffer
 * @param {string} relPath
 * @returns {{ width: number; height: number }}
 */
function readPngDimensions(pngBuffer, relPath) {
  if (
    pngBuffer.length < 24 ||
    !pngBuffer.subarray(0, 8).equals(PNG_SIGNATURE) ||
    pngBuffer.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    throw new Error(`Invalid PNG header in icon "${relPath}"`);
  }
  const width = pngBuffer.readUInt32BE(16);
  const height = pngBuffer.readUInt32BE(20);
  return { width, height };
}

/**
 * Ensures a manifest-referenced relative asset exists inside `sourceDir` without path traversal.
 * @param {string} sourceDir
 * @param {string} relAssetPath
 * @param {string} fieldLabel
 * @returns {string}
 */
function assertAssetExists(sourceDir, relAssetPath, fieldLabel) {
  if (typeof relAssetPath !== 'string' || relAssetPath.trim().length === 0) {
    throw new Error(`Invalid empty asset path in manifest field "${fieldLabel}"`);
  }
  if (path.isAbsolute(relAssetPath) || relAssetPath.includes('\\')) {
    throw new Error(
      `Manifest field "${fieldLabel}" must use POSIX relative paths, got "${relAssetPath}"`,
    );
  }
  const resolvedSourceRoot = path.resolve(sourceDir);
  const resolvedAsset = path.resolve(resolvedSourceRoot, relAssetPath);
  const relBack = path.relative(resolvedSourceRoot, resolvedAsset);
  if (relBack.startsWith('..') || path.isAbsolute(relBack)) {
    throw new Error(`Manifest field "${fieldLabel}" escapes extension root: "${relAssetPath}"`);
  }
  let stat;
  try {
    stat = fs.statSync(resolvedAsset);
  } catch {
    throw new Error(
      `Missing extension bundle/asset referenced by "${fieldLabel}": ${relAssetPath}`,
    );
  }
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(
      `Extension asset referenced by "${fieldLabel}" is empty or not a regular file: ${relAssetPath}`,
    );
  }
  return resolvedAsset;
}

/**
 * Validates an icon map (`{ "16": "...", "48": "...", "128": "..." }`) and PNG pixel dimensions.
 * @param {string} sourceDir
 * @param {Record<string, unknown>} iconMap
 * @param {string} fieldPrefix
 */
function validateIconMap(sourceDir, iconMap, fieldPrefix) {
  const entries = Object.entries(iconMap);
  if (entries.length === 0) {
    throw new Error(`Manifest "${fieldPrefix}" object cannot be empty`);
  }
  for (const [sizeKey, iconRelPath] of entries) {
    if (typeof iconRelPath !== 'string') {
      throw new Error(`Manifest "${fieldPrefix}.${sizeKey}" must be a string path`);
    }
    const absIcon = assertAssetExists(sourceDir, iconRelPath, `${fieldPrefix}.${sizeKey}`);
    const expectedDim = Number(sizeKey);
    if (Number.isInteger(expectedDim) && expectedDim > 0 && iconRelPath.toLowerCase().endsWith('.png')) {
      const buf = fs.readFileSync(absIcon);
      const { width, height } = readPngDimensions(buf, iconRelPath);
      if (width !== expectedDim || height !== expectedDim) {
        throw new Error(
          `Icon "${iconRelPath}" (${fieldPrefix}.${sizeKey}) has dimensions ${width}x${height}; expected ${expectedDim}x${expectedDim}`,
        );
      }
    }
  }
}

/**
 * Validates `manifest.json` and all referenced icons, scripts, stylesheets, and HTML pages.
 * @param {string} sourceDir
 * @returns {{ name: string; version: string; manifest: Record<string, unknown> }}
 */
export function validateExtensionDist(sourceDir) {
  const manifestPath = path.join(sourceDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manifest.json not found in "${sourceDir}". Build @soundclud/extension first.`);
  }

  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(
      `Failed to parse ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('manifest.json root must be a JSON object');
  }

  const manifest = /** @type {Record<string, unknown>} */ (parsed);

  if (manifest.manifest_version !== 3) {
    throw new Error(
      `Expected manifest_version 3, received ${JSON.stringify(manifest.manifest_version)}`,
    );
  }

  if (typeof manifest.name !== 'string' || manifest.name.trim().length === 0) {
    throw new Error('manifest.json "name" must be a non-empty string');
  }

  if (
    typeof manifest.version !== 'string' ||
    !/^\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/.test(manifest.version)
  ) {
    throw new Error(
      `manifest.json "version" must be a valid version string, got ${JSON.stringify(manifest.version)}`,
    );
  }

  // Enforce SoundClud MV3 security & portability invariants
  for (const permKey of ['permissions', 'optional_permissions']) {
    const perms = manifest[permKey];
    if (Array.isArray(perms) && perms.includes('cookies')) {
      throw new Error(`Forbidden "cookies" permission detected in manifest.${permKey}`);
    }
  }

  for (const hostKey of ['host_permissions', 'optional_host_permissions']) {
    const hosts = manifest[hostKey];
    if (Array.isArray(hosts)) {
      for (const pattern of hosts) {
        if (typeof pattern === 'string' && /^wss?:\/\//i.test(pattern)) {
          throw new Error(
            `Invalid WebSocket match pattern "${pattern}" in manifest.${hostKey}; use HTTP(S) match patterns only`,
          );
        }
      }
    }
  }

  if (manifest.icons !== undefined) {
    if (manifest.icons === null || typeof manifest.icons !== 'object' || Array.isArray(manifest.icons)) {
      throw new Error('manifest.icons must be an object map of pixel sizes to file paths');
    }
    const iconsObj = /** @type {Record<string, unknown>} */ (manifest.icons);
    for (const requiredSize of ['16', '48', '128']) {
      if (!(requiredSize in iconsObj)) {
        throw new Error(`manifest.icons is missing required "${requiredSize}"px icon entry`);
      }
    }
    validateIconMap(sourceDir, iconsObj, 'icons');
  }

  if (manifest.background !== undefined) {
    if (
      manifest.background === null ||
      typeof manifest.background !== 'object' ||
      Array.isArray(manifest.background)
    ) {
      throw new Error('manifest.background must be an object');
    }
    const bg = /** @type {Record<string, unknown>} */ (manifest.background);
    if ('scripts' in bg) {
      throw new Error('Manifest V2 background.scripts is forbidden in MV3');
    }
    if (typeof bg.service_worker === 'string') {
      assertAssetExists(sourceDir, bg.service_worker, 'background.service_worker');
    }
  }

  if (manifest.action !== undefined) {
    if (
      manifest.action === null ||
      typeof manifest.action !== 'object' ||
      Array.isArray(manifest.action)
    ) {
      throw new Error('manifest.action must be an object');
    }
    const action = /** @type {Record<string, unknown>} */ (manifest.action);
    if (typeof action.default_popup === 'string') {
      assertAssetExists(sourceDir, action.default_popup, 'action.default_popup');
    }
    if (typeof action.default_icon === 'string') {
      assertAssetExists(sourceDir, action.default_icon, 'action.default_icon');
    } else if (
      action.default_icon !== undefined &&
      action.default_icon !== null &&
      typeof action.default_icon === 'object' &&
      !Array.isArray(action.default_icon)
    ) {
      validateIconMap(
        sourceDir,
        /** @type {Record<string, unknown>} */ (action.default_icon),
        'action.default_icon',
      );
    }
  }

  if (typeof manifest.options_page === 'string') {
    assertAssetExists(sourceDir, manifest.options_page, 'options_page');
  }

  if (
    manifest.options_ui !== undefined &&
    manifest.options_ui !== null &&
    typeof manifest.options_ui === 'object' &&
    !Array.isArray(manifest.options_ui)
  ) {
    const optsUi = /** @type {Record<string, unknown>} */ (manifest.options_ui);
    if (typeof optsUi.page === 'string') {
      assertAssetExists(sourceDir, optsUi.page, 'options_ui.page');
    }
  }

  if (
    manifest.side_panel !== undefined &&
    manifest.side_panel !== null &&
    typeof manifest.side_panel === 'object' &&
    !Array.isArray(manifest.side_panel)
  ) {
    const sidePanel = /** @type {Record<string, unknown>} */ (manifest.side_panel);
    if (typeof sidePanel.default_path === 'string') {
      assertAssetExists(sourceDir, sidePanel.default_path, 'side_panel.default_path');
    }
  }

  if (Array.isArray(manifest.content_scripts)) {
    manifest.content_scripts.forEach((entry, idx) => {
      if (entry === null || typeof entry !== 'object') {
        return;
      }
      const cs = /** @type {Record<string, unknown>} */ (entry);
      if (Array.isArray(cs.js)) {
        cs.js.forEach((jsFile, jIdx) => {
          if (typeof jsFile === 'string') {
            assertAssetExists(sourceDir, jsFile, `content_scripts[${idx}].js[${jIdx}]`);
          }
        });
      }
      if (Array.isArray(cs.css)) {
        cs.css.forEach((cssFile, cIdx) => {
          if (typeof cssFile === 'string') {
            assertAssetExists(sourceDir, cssFile, `content_scripts[${idx}].css[${cIdx}]`);
          }
        });
      }
    });
  }

  if (Array.isArray(manifest.web_accessible_resources)) {
    manifest.web_accessible_resources.forEach((entry, idx) => {
      if (entry === null || typeof entry !== 'object') {
        return;
      }
      const war = /** @type {Record<string, unknown>} */ (entry);
      if (Array.isArray(war.resources)) {
        war.resources.forEach((resPath, rIdx) => {
          if (typeof resPath === 'string' && !resPath.includes('*') && !resPath.includes('?')) {
            assertAssetExists(
              sourceDir,
              resPath,
              `web_accessible_resources[${idx}].resources[${rIdx}]`,
            );
          }
        });
      }
    });
  }

  return {
    name: manifest.name,
    version: manifest.version,
    manifest,
  };
}

/**
 * Determines whether a relative path should be excluded from the store ZIP.
 * @param {string} name
 * @returns {boolean}
 */
function isExcludedEntry(name) {
  if (EXCLUDED_NAMES.has(name) || name.startsWith('.env')) {
    return true;
  }
  const lower = name.toLowerCase();
  return EXCLUDED_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

/**
 * Collects all distributable extension files sorted deterministically (`manifest.json` first).
 * @param {string} sourceDir
 * @returns {Array<{ relativePath: string; data: Buffer }>}
 */
export function collectExtensionFiles(sourceDir) {
  /** @type {string[]} */
  const relPaths = [];

  /** @param {string} currentDir */
  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (isExcludedEntry(entry.name)) {
        continue;
      }
      const absPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        walk(absPath);
      } else if (entry.isFile()) {
        const relPosix = path.relative(sourceDir, absPath).split(path.sep).join('/');
        relPaths.push(relPosix);
      }
    }
  }

  walk(sourceDir);

  relPaths.sort((a, b) => {
    if (a === 'manifest.json') return -1;
    if (b === 'manifest.json') return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  return relPaths.map((relativePath) => ({
    relativePath,
    data: fs.readFileSync(path.join(sourceDir, relativePath)),
  }));
}

/**
 * Builds a deterministic PKZIP v2.0 archive Buffer in pure Node.js (`node:zlib`).
 * @param {ReadonlyArray<{ relativePath: string; data: Buffer }>} entries
 * @returns {Buffer}
 */
export function buildDeterministicZip(entries) {
  if (entries.length > 0xffff) {
    throw new Error(`ZIP entry count (${entries.length}) exceeds standard 65535 limit`);
  }

  /** @type {Buffer[]} */
  const localParts = [];
  /** @type {Buffer[]} */
  const centralParts = [];
  let localOffset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.relativePath, 'utf8');
    const rawData = entry.data;
    const crc = computeCrc32(rawData);
    const deflated = zlib.deflateRawSync(rawData, { level: 9 });
    const useDeflate = deflated.length < rawData.length;
    const method = useDeflate ? 8 : 0;
    const compressedData = useDeflate ? deflated : rawData;

    const localHeader = Buffer.alloc(30 + nameBytes.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // Local file header signature
    localHeader.writeUInt16LE(20, 4); // Version needed to extract (2.0)
    localHeader.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(DETERMINISTIC_DOS_TIME, 10);
    localHeader.writeUInt16LE(DETERMINISTIC_DOS_DATE, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(compressedData.length, 18);
    localHeader.writeUInt32LE(rawData.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28); // Extra field length
    nameBytes.copy(localHeader, 30);

    const centralHeader = Buffer.alloc(46 + nameBytes.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // Central directory signature
    centralHeader.writeUInt16LE(0x0314, 4); // Made by UNIX (3), PKZIP 2.0 (20)
    centralHeader.writeUInt16LE(20, 6); // Version needed (2.0)
    centralHeader.writeUInt16LE(0x0800, 8); // UTF-8 filename flag
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(DETERMINISTIC_DOS_TIME, 12);
    centralHeader.writeUInt16LE(DETERMINISTIC_DOS_DATE, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressedData.length, 20);
    centralHeader.writeUInt32LE(rawData.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30); // Extra field length
    centralHeader.writeUInt16LE(0, 32); // File comment length
    centralHeader.writeUInt16LE(0, 34); // Disk number start
    centralHeader.writeUInt16LE(0, 36); // Internal file attributes
    centralHeader.writeUInt32LE((0o100644 << 16) >>> 0, 38); // POSIX 0644
    centralHeader.writeUInt32LE(localOffset, 42);
    nameBytes.copy(centralHeader, 46);

    localParts.push(localHeader, compressedData);
    centralParts.push(centralHeader);
    localOffset += localHeader.length + compressedData.length;
  }

  const centralDirBuffer = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // End of central directory signature
  eocd.writeUInt16LE(0, 4); // Number of this disk
  eocd.writeUInt16LE(0, 6); // Disk where central directory starts
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirBuffer.length, 12);
  eocd.writeUInt32LE(localOffset, 16);
  eocd.writeUInt16LE(0, 20); // Comment length

  return Buffer.concat([...localParts, centralDirBuffer, eocd]);
}

/**
 * Validates and packages an extension `dist` directory into a deterministic `.zip` + `.sha256`.
 * @param {{ sourceDir?: string; outDir?: string; outputFile?: string }} [options]
 * @returns {{ zipPath: string; sha256Path: string; sha256: string; version: string; fileCount: number; byteLength: number }}
 */
export function packageExtensionDirectory(options = {}) {
  const sourceDir = path.resolve(
    options.sourceDir ?? path.join(REPO_ROOT, 'packages', 'extension', 'dist'),
  );
  const { version } = validateExtensionDist(sourceDir);
  const files = collectExtensionFiles(sourceDir);

  if (files.length === 0) {
    throw new Error(`No extension files found in "${sourceDir}"`);
  }

  const zipBuffer = buildDeterministicZip(files);
  const sha256 = createHash('sha256').update(zipBuffer).digest('hex');

  const outDir = path.resolve(options.outDir ?? path.join(REPO_ROOT, 'dist'));
  const zipPath =
    options.outputFile !== undefined
      ? path.resolve(options.outputFile)
      : path.join(outDir, `soundclud-extension-v${version}.zip`);
  const sha256Path = `${zipPath}.sha256`;

  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.writeFileSync(zipPath, zipBuffer);
  fs.writeFileSync(sha256Path, `${sha256}  ${path.basename(zipPath)}\n`, 'utf8');

  return {
    zipPath,
    sha256Path,
    sha256,
    version,
    fileCount: files.length,
    byteLength: zipBuffer.length,
  };
}

/**
 * Parses CLI flags for `scripts/package-extension.mjs`.
 * @param {string[]} argv
 */
function parseCliArgs(argv) {
  /** @type {{ sourceDir?: string; outDir?: string; outputFile?: string; help: boolean }} */
  const parsed = { help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      parsed.help = true;
    } else if (arg === '--source-dir' && argv[i + 1]) {
      parsed.sourceDir = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith('--source-dir=')) {
      parsed.sourceDir = arg.slice('--source-dir='.length);
    } else if (arg === '--out-dir' && argv[i + 1]) {
      parsed.outDir = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith('--out-dir=')) {
      parsed.outDir = arg.slice('--out-dir='.length);
    } else if (arg === '--output' && argv[i + 1]) {
      parsed.outputFile = argv[i + 1];
      i += 1;
    } else if (arg?.startsWith('--output=')) {
      parsed.outputFile = arg.slice('--output='.length);
    } else {
      throw new Error(`Unknown CLI argument: ${String(arg)}`);
    }
  }
  return parsed;
}

function printHelp() {
  console.log(`Usage: node ./scripts/package-extension.mjs [options]

Options:
  --source-dir <dir>  Built extension directory (default: packages/extension/dist)
  --out-dir <dir>     Output directory for ZIP & SHA-256 (default: dist)
  --output <file>     Explicit output .zip path override
  -h, --help          Show this help message
`);
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  }
}

if (isMainModule()) {
  try {
    const cli = parseCliArgs(process.argv.slice(2));
    if (cli.help) {
      printHelp();
      process.exit(0);
    }
    const result = packageExtensionDirectory(cli);
    const displayPath = path.relative(REPO_ROOT, result.zipPath) || result.zipPath;
    console.log(
      `[package-extension] Packaged ${result.fileCount} file(s) -> ${displayPath} (${result.byteLength} bytes)`,
    );
    console.log(`[package-extension] SHA-256: ${result.sha256}`);
  } catch (err) {
    console.error(
      `[package-extension] FAILED — ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}
