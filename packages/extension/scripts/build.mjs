#!/usr/bin/env node

/**
 * Deterministic Chromium MV3 Extension Build Pipeline (`@soundclud/extension`).
 *
 * Bundles Service Worker, MAIN world, ISOLATED world, and Popup scripts via
 * `esbuild` targeting `chrome116`, ensures valid `16x16`, `48x48`, and `128x128`
 * PNG icons exist in both `icons/` and `dist/icons/`, and copies `manifest.json`
 * + popup static assets into `dist/`.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { readPngDimensions, renderSoundCludIconPng } from './pngGenerator.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = path.resolve(SCRIPT_DIR, '..');
const SRC_DIR = path.join(PKG_ROOT, 'src');
const ICONS_DIR = path.join(PKG_ROOT, 'icons');
const DIST_DIR = path.join(PKG_ROOT, 'dist');
const DIST_ICONS_DIR = path.join(DIST_DIR, 'icons');

const ICON_SIZES = [16, 48, 128];

async function ensureValidSourceIcons() {
  await fs.mkdir(ICONS_DIR, { recursive: true });
  for (const size of ICON_SIZES) {
    const iconPath = path.join(ICONS_DIR, `icon-${String(size)}.png`);
    let needsWrite = true;
    try {
      const existing = await fs.readFile(iconPath);
      const dims = readPngDimensions(existing);
      if (dims.valid && dims.width === size && dims.height === size) {
        needsWrite = false;
      }
    } catch {
      needsWrite = true;
    }
    if (needsWrite) {
      const pngBytes = renderSoundCludIconPng(size);
      await fs.writeFile(iconPath, pngBytes);
    }
  }
}

async function buildExtension() {
  const startedAt = performance.now();

  await ensureValidSourceIcons();
  await fs.rm(DIST_DIR, { recursive: true, force: true });
  await fs.mkdir(DIST_ICONS_DIR, { recursive: true });

  const commonEsbuildOptions = {
    bundle: true,
    target: 'chrome116',
    platform: 'browser',
    legalComments: 'none',
    logLevel: 'silent',
  };

  await Promise.all([
    esbuild.build({
      ...commonEsbuildOptions,
      entryPoints: [path.join(SRC_DIR, 'background', 'serviceWorker.ts')],
      outfile: path.join(DIST_DIR, 'service-worker.js'),
      format: 'esm',
    }),
    esbuild.build({
      ...commonEsbuildOptions,
      entryPoints: [path.join(SRC_DIR, 'main-world', 'entry.ts')],
      outfile: path.join(DIST_DIR, 'content-main.js'),
      format: 'iife',
    }),
    esbuild.build({
      ...commonEsbuildOptions,
      entryPoints: [path.join(SRC_DIR, 'isolated-world', 'entry.ts')],
      outfile: path.join(DIST_DIR, 'content-isolated.js'),
      format: 'iife',
    }),
    esbuild.build({
      ...commonEsbuildOptions,
      entryPoints: [path.join(SRC_DIR, 'popup', 'popup.ts')],
      outfile: path.join(DIST_DIR, 'popup.js'),
      format: 'esm',
    }),
    fs.copyFile(
      path.join(PKG_ROOT, 'manifest.json'),
      path.join(DIST_DIR, 'manifest.json'),
    ),
    fs.copyFile(
      path.join(SRC_DIR, 'popup', 'popup.html'),
      path.join(DIST_DIR, 'popup.html'),
    ),
    fs.copyFile(
      path.join(SRC_DIR, 'popup', 'popup.css'),
      path.join(DIST_DIR, 'popup.css'),
    ),
    ...ICON_SIZES.map((size) =>
      fs.copyFile(
        path.join(ICONS_DIR, `icon-${String(size)}.png`),
        path.join(DIST_ICONS_DIR, `icon-${String(size)}.png`),
      ),
    ),
  ]);

  const elapsedMs = (performance.now() - startedAt).toFixed(1);
  console.log(
    `[@soundclud/extension] Built MV3 bundle into dist/ in ${elapsedMs} ms.`,
  );
}

await buildExtension();
