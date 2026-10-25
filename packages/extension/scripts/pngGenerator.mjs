/**
 * Zero-dependency RGBA PNG encoder & icon renderer using Node built-in `node:zlib`.
 *
 * Renders crisp anti-aliased `16x16`, `48x48`, and `128x128` SoundClud Hi-Fi
 * icons and verifies exact IHDR pixel dimensions.
 */

import { deflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

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

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

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
  ihdr[10] = 0; // Compression method 0
  ihdr[11] = 0; // Filter method 0
  ihdr[12] = 0; // Interlace method 0

  const rowStride = width * 4;
  const rawScanlines = Buffer.alloc(height * (1 + rowStride));
  for (let y = 0; y < height; y += 1) {
    const dstOffset = y * (1 + rowStride);
    rawScanlines[dstOffset] = 0; // Filter type 0 (None)
    const srcOffset = y * rowStride;
    rawScanlines.set(rgbaPixels.subarray(srcOffset, srcOffset + rowStride), dstOffset + 1);
  }

  const compressed = deflateSync(rawScanlines, { level: 9 });

  return Buffer.concat([
    PNG_SIGNATURE,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function roundedBoxSdf(px, py, cx, cy, halfW, halfH, radius) {
  const dx = Math.abs(px - cx) - (halfW - radius);
  const dy = Math.abs(py - cy) - (halfH - radius);
  const outX = Math.max(dx, 0);
  const outY = Math.max(dy, 0);
  return Math.hypot(outX, outY) + Math.min(Math.max(dx, dy), 0) - radius;
}

function capsuleVerticalSdf(px, py, barX, halfHeight, centerY, radius) {
  const dx = px - barX;
  const dy = Math.max(0, Math.abs(py - centerY) - halfHeight);
  return Math.hypot(dx, dy) - radius;
}

/**
 * Renders a crisp SoundClud Hi-Fi icon (dark obsidian rounded squircle with
 * five warm amber/orange waveform bars) at exact `size x size` pixel dimensions.
 * @param {number} size
 * @returns {Buffer}
 */
export function renderSoundCludIconPng(size) {
  const rgba = new Uint8Array(size * size * 4);
  const center = size / 2;
  const margin = size * 0.05;
  const halfBox = size / 2 - margin;
  const cornerRadius = size * 0.24;

  const bars = [
    { nx: 0.27, halfH: 0.12 },
    { nx: 0.385, halfH: 0.21 },
    { nx: 0.5, halfH: 0.29 },
    { nx: 0.615, halfH: 0.23 },
    { nx: 0.73, halfH: 0.14 },
  ];
  const barRadius = Math.max(0.65, size * 0.036);

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;

      const bgDist = roundedBoxSdf(
        px,
        py,
        center,
        center,
        halfBox,
        halfBox,
        cornerRadius,
      );
      const bgAlpha = clamp01(0.5 - bgDist);

      if (bgAlpha <= 0) {
        continue;
      }

      const gradT = clamp01(py / size);
      let r = Math.round(28 + (16 - 28) * gradT);
      let g = Math.round(31 + (18 - 31) * gradT);
      let b = Math.round(39 + (24 - 39) * gradT);

      // Subtle warm top rim
      const borderAlpha = clamp01(1.1 - Math.abs(bgDist + 0.6)) * 0.22;
      r = Math.round(r * (1 - borderAlpha) + 255 * borderAlpha);
      g = Math.round(g * (1 - borderAlpha) + 122 * borderAlpha);
      b = Math.round(b * (1 - borderAlpha) + 56 * borderAlpha);

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
        const barTopT = clamp01((py - size * 0.2) / (size * 0.6));
        const barR = 255;
        const barG = Math.round(138 + (85 - 138) * barTopT);
        const barB = Math.round(52 + (18 - 52) * barTopT);

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

/**
 * Verifies a PNG buffer's signature and IHDR width/height dimensions.
 * @param {Buffer} pngBuffer
 * @returns {{ valid: boolean; width: number; height: number }}
 */
export function readPngDimensions(pngBuffer) {
  if (
    pngBuffer.length < 24 ||
    !pngBuffer.subarray(0, 8).equals(PNG_SIGNATURE) ||
    pngBuffer.subarray(12, 16).toString('ascii') !== 'IHDR'
  ) {
    return { valid: false, width: 0, height: 0 };
  }
  return {
    valid: true,
    width: pngBuffer.readUInt32BE(16),
    height: pngBuffer.readUInt32BE(20),
  };
}
