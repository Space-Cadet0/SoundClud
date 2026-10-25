#!/usr/bin/env node

/**
 * SoundClud macOS AppIcon (.icns) Generator.
 *
 * Pure Node ESM utility (zero npm dependencies) using `node:zlib` RGBA PNG encoding
 * plus macOS built-in `sips` and `iconutil` to produce a crisp Retina-ready
 * rounded-squircle dark-charcoal (`#14161B`) + warm-orange (`#FF6B2B`) 5-bar
 * waveform `AppIcon.icns` (`icon_16x16.png` .. `icon_512x512@2x.png`).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ICNS_MAGIC = Buffer.from('icns', 'ascii');

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * @param {Buffer} buf
 * @returns {number}
 */
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    const byte = buf[i] ?? 0;
    c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * @param {string} typeAscii
 * @param {Buffer} dataBuffer
 * @returns {Buffer}
 */
function makePngChunk(typeAscii, dataBuffer) {
  const typeBuf = Buffer.from(typeAscii, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(dataBuffer.length, 0);

  const crcInput = Buffer.concat([typeBuf, dataBuffer]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);

  return Buffer.concat([lenBuf, typeBuf, dataBuffer, crcBuf]);
}

/**
 * Encodes an RGBA8 pixel buffer (`width * height * 4` bytes) into a valid PNG `Buffer`.
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgbaPixels
 * @returns {Buffer}
 */
export function encodeRgbaPng(width, height, rgbaPixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit per channel
  ihdr[9] = 6; // Color type 6 = RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowStride = width * 4;
  const rawScanlines = Buffer.alloc(height * (1 + rowStride));
  for (let y = 0; y < height; y += 1) {
    const dstOffset = y * (1 + rowStride);
    rawScanlines[dstOffset] = 0; // Filter type 0
    const srcOffset = y * rowStride;
    rawScanlines.set(rgbaPixels.subarray(srcOffset, srcOffset + rowStride), dstOffset + 1);
  }

  const compressed = deflateSync(rawScanlines, { level: 6 });

  return Buffer.concat([
    PNG_SIGNATURE,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * @param {number} v
 * @returns {number}
 */
function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Signed distance to a rounded box centered at `(cx, cy)`.
 * @param {number} px
 * @param {number} py
 * @param {number} cx
 * @param {number} cy
 * @param {number} halfW
 * @param {number} halfH
 * @param {number} radius
 * @returns {number}
 */
function roundedBoxSdf(px, py, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(px - cx) - (halfW - radius);
  const dy = Math.abs(py - cy) - (halfH - radius);
  const outX = Math.max(dx, 0);
  const outY = Math.max(dy, 0);
  return Math.hypot(outX, outY) + Math.min(Math.max(dx, dy), 0) - radius;
}

/**
 * Signed distance to a vertical capsule centered at `(barX, centerY)`.
 * @param {number} px
 * @param {number} py
 * @param {number} barX
 * @param {number} halfHeight
 * @param {number} centerY
 * @param {number} radius
 * @returns {number}
 */
function capsuleVerticalSdf(px, py, barX, halfHeight, centerY, radius) {
  const dx = px - barX;
  const dy = Math.max(0, Math.abs(py - centerY) - halfHeight);
  return Math.hypot(dx, dy) - radius;
}

/**
 * Renders the SoundClud macOS squircle icon at `size x size` pixels:
 * - Dark-charcoal (`#14161B` = rgb(20, 22, 27)) rounded squircle body
 * - Warm-orange (`#FF6B2B` = rgb(255, 107, 43)) 5-bar Hi-Fi waveform
 * @param {number} size
 * @returns {Buffer}
 */
export function renderMacAppIconPng(size) {
  const rgba = new Uint8Array(size * size * 4);
  const center = size / 2;
  // Standard macOS Big Sur / Monterey+ squircle inset (~9.5% canvas margin)
  const margin = size * 0.095;
  const halfBox = size / 2 - margin;
  const bodySize = halfBox * 2;
  const cornerRadius = bodySize * 0.225;

  const bars = [
    { nx: 0.295, halfH: 0.105 },
    { nx: 0.3975, halfH: 0.185 },
    { nx: 0.5, halfH: 0.255 },
    { nx: 0.6025, halfH: 0.205 },
    { nx: 0.705, halfH: 0.125 },
  ];
  const barRadius = Math.max(0.75, size * 0.033);

  // Base charcoal #14161B (20, 22, 27) with subtle top-to-bottom depth
  // Base warm-orange #FF6B2B (255, 107, 43) with subtle luminous highlight
  for (let y = 0; y < size; y += 1) {
    const py = y + 0.5;
    const gradT = clamp01((py - margin) / bodySize);
    const bgBaseR = Math.round(24 + (16 - 24) * gradT); // centered at 20 (#14)
    const bgBaseG = Math.round(26 + (18 - 26) * gradT); // centered at 22 (#16)
    const bgBaseB = Math.round(32 + (22 - 32) * gradT); // centered at 27 (#1B)

    const barTopT = clamp01((py - size * 0.22) / (size * 0.56));
    const barR = 255; // #FF
    const barG = Math.round(122 + (92 - 122) * barTopT); // centered at 107 (#6B)
    const barB = Math.round(54 + (32 - 54) * barTopT); // centered at 43 (#2B)

    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;

      const bgDist = roundedBoxSdf(px, py, center, center, halfBox, halfBox, cornerRadius);
      const bgAlpha = clamp01(0.5 - bgDist);
      if (bgAlpha <= 0) {
        continue;
      }

      let r = bgBaseR;
      let g = bgBaseG;
      let b = bgBaseB;

      // Crisp inner rim highlight along squircle border
      const rimAlpha = clamp01(1.15 - Math.abs(bgDist + 0.75)) * 0.24;
      if (rimAlpha > 0) {
        r = Math.round(r * (1 - rimAlpha) + 255 * rimAlpha);
        g = Math.round(g * (1 - rimAlpha) + 107 * rimAlpha);
        b = Math.round(b * (1 - rimAlpha) + 43 * rimAlpha);
      }

      let minBarDist = Infinity;
      for (const bar of bars) {
        const d = capsuleVerticalSdf(
          px,
          py,
          bar.nx * size,
          bar.halfH * size,
          center,
          barRadius,
        );
        if (d < minBarDist) {
          minBarDist = d;
        }
      }

      const barAlpha = clamp01(0.55 - minBarDist);
      if (barAlpha > 0) {
        r = Math.round(r * (1 - barAlpha) + barR * barAlpha);
        g = Math.round(g * (1 - barAlpha) + barG * barAlpha);
        b = Math.round(b * (1 - barAlpha) + barB * barAlpha);
      }

      const idx = (y * size + x) * 4;
      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = Math.round(bgAlpha * 255);
    }
  }

  return encodeRgbaPng(size, size, rgba);
}

const ICONSET_SPECS = [
  { filename: 'icon_16x16.png', pixels: 16 },
  { filename: 'icon_16x16@2x.png', pixels: 32 },
  { filename: 'icon_32x32.png', pixels: 32 },
  { filename: 'icon_32x32@2x.png', pixels: 64 },
  { filename: 'icon_128x128.png', pixels: 128 },
  { filename: 'icon_128x128@2x.png', pixels: 256 },
  { filename: 'icon_256x256.png', pixels: 256 },
  { filename: 'icon_256x256@2x.png', pixels: 512 },
  { filename: 'icon_512x512.png', pixels: 512 },
  { filename: 'icon_512x512@2x.png', pixels: 1024 },
];

/**
 * Generates a complete Apple `.icns` bundle icon using `sips` and `iconutil`.
 * @param {string} outputIcnsPath
 */
export function generateAppIcns(outputIcnsPath) {
  if (process.platform !== 'darwin') {
    throw new Error('AppIcon.icns generation requires macOS (`sips` and `iconutil`).');
  }

  const resolvedOut = path.resolve(outputIcnsPath);
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'soundclud-icns-'));
  const iconsetDir = path.join(tmpRoot, 'AppIcon.iconset');
  fs.mkdirSync(iconsetDir, { recursive: true });

  try {
    // Render crisp SDF PNGs directly for small pixel grids (16, 32, 64) and master 1024x1024,
    // and use `sips -z` Lanczos resampling from the 1024x1024 master for intermediate Retina sizes.
    const master1024Path = path.join(iconsetDir, 'icon_512x512@2x.png');
    fs.writeFileSync(master1024Path, renderMacAppIconPng(1024));

    /** @type {Map<number, Buffer>} */
    const directRenderedCache = new Map();
    for (const smallDim of [16, 32, 64]) {
      directRenderedCache.set(smallDim, renderMacAppIconPng(smallDim));
    }

    for (const spec of ICONSET_SPECS) {
      if (spec.filename === 'icon_512x512@2x.png') {
        continue;
      }
      const targetPng = path.join(iconsetDir, spec.filename);
      const cachedSmall = directRenderedCache.get(spec.pixels);
      if (cachedSmall !== undefined) {
        fs.writeFileSync(targetPng, cachedSmall);
      } else {
        execFileSync(
          '/usr/bin/sips',
          ['-z', String(spec.pixels), String(spec.pixels), master1024Path, '--out', targetPng],
          { stdio: 'pipe' },
        );
      }
    }

    fs.mkdirSync(path.dirname(resolvedOut), { recursive: true });
    execFileSync('/usr/bin/iconutil', ['-c', 'icns', iconsetDir, '-o', resolvedOut], {
      stdio: 'pipe',
    });

    const icnsBuf = fs.readFileSync(resolvedOut);
    if (icnsBuf.length < 64 || !icnsBuf.subarray(0, 4).equals(ICNS_MAGIC)) {
      throw new Error(`Generated file is not a valid Apple .icns archive: ${resolvedOut}`);
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  /** @type {{ output: string; help: boolean }} */
  const parsed = { output: path.resolve('AppIcon.icns'), help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      parsed.help = true;
    } else if (arg === '--output' && argv[i + 1]) {
      parsed.output = path.resolve(argv[i + 1] ?? 'AppIcon.icns');
      i += 1;
    } else if (arg?.startsWith('--output=')) {
      parsed.output = path.resolve(arg.slice('--output='.length));
    } else {
      throw new Error(`Unknown CLI argument: ${String(arg)}`);
    }
  }
  return parsed;
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
    const cli = parseArgs(process.argv.slice(2));
    if (cli.help) {
      console.log('Usage: node packaging/macos-app/generate-icns.mjs [--output <AppIcon.icns>]');
      process.exit(0);
    }
    generateAppIcns(cli.output);
    console.log(`[generate-icns] Generated ${cli.output}`);
  } catch (err) {
    console.error(
      `[generate-icns] ERROR: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}
