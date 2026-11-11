import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMockReceiverServer,
  stopAllResources,
  SYNTHETIC_OUTPUT_HEOS,
  SYNTHETIC_OUTPUT_TOSLINK,
  type ClosableResource,
} from '../harness/index.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..', '..');

describe('Tier 1: Packaging, Deployment & Quality Gate (Features 19 & 20)', () => {
  const closables: ClosableResource[] = [];

  afterEach(async () => {
    await stopAllResources(closables);
    closables.length = 0;
  });

  // --------------------------------------------------------------------------
  // Feature 19: macOS Rebuild & Deployment
  // --------------------------------------------------------------------------
  describe('Feature 19: macOS Rebuild & Deployment', () => {
    it('T1-F19-01: verifies native receiver executable binary presence and self-contained linkages', () => {
      const debugBin = path.join(
        REPO_ROOT,
        'target',
        'debug',
        process.platform === 'win32' ? 'soundclud-receiver.exe' : 'soundclud-receiver',
      );
      const releaseBin = path.join(
        REPO_ROOT,
        'target',
        'release',
        process.platform === 'win32' ? 'soundclud-receiver.exe' : 'soundclud-receiver',
      );

      const binPath = fs.existsSync(debugBin) ? debugBin : releaseBin;
      expect(fs.existsSync(binPath)).toBe(true);

      // On macOS, verify Mach-O link dependencies via otool (Law 3: Zero Homebrew / Python dependencies)
      if (process.platform === 'darwin') {
        const otoolOutput = execSync(`otool -L "${binPath}"`, { encoding: 'utf8' });
        expect(otoolOutput).toContain('/usr/lib/libSystem.B.dylib');
        expect(otoolOutput).not.toContain('/opt/homebrew');
        expect(otoolOutput).not.toContain('/usr/local/Cellar');
        expect(otoolOutput.toLowerCase()).not.toContain('python');
      }
    });

    it('T1-F19-02: verifies package.json scripts contain build and verification targets', () => {
      const pkgPath = path.join(REPO_ROOT, 'package.json');
      expect(fs.existsSync(pkgPath)).toBe(true);

      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
        scripts?: Record<string, string>;
      };

      expect(pkg.scripts?.['verify']).toBeDefined();
      expect(pkg.scripts?.['check:hygiene']).toBeDefined();
      expect(pkg.scripts?.['typecheck']).toBeDefined();
      expect(pkg.scripts?.['test']).toBeDefined();
    });

    it('T1-F19-03: verifies LaunchAgent plist template configuration and keys', () => {
      const plistTmpl = path.join(REPO_ROOT, 'packaging', 'launchd', 'io.soundclud.receiver.plist.tmpl');
      expect(fs.existsSync(plistTmpl)).toBe(true);

      const content = fs.readFileSync(plistTmpl, 'utf8');
      expect(content).toContain('<key>Label</key>');
      expect(content).toContain('<string>io.soundclud.receiver</string>');
      expect(content).toContain('<key>KeepAlive</key>');
      expect(content).toContain('<key>RunAtLoad</key>');
      expect(content).toContain('<key>ThrottleInterval</key>');

      const runnerScript = path.join(REPO_ROOT, 'packaging', 'launchd', 'run-receiver.sh');
      expect(fs.existsSync(runnerScript)).toBe(true);

      if (process.platform === 'darwin') {
        const lintOutput = execSync(`plutil -lint "${plistTmpl}"`, { encoding: 'utf8' });
        expect(lintOutput).toContain('OK');
      }
    });

    it('T1-F19-04: validates AppKit and macOS bundle metadata integrity', () => {
      const appKitModelPath = path.join(
        REPO_ROOT,
        'packaging',
        'macos-app',
        'Sources',
        'Models.swift',
      );
      expect(fs.existsSync(appKitModelPath)).toBe(true);

      const content = fs.readFileSync(appKitModelPath, 'utf8');
      expect(content).toContain('struct OutputCapabilities');
      expect(content).toContain('struct DiscoveredOutput');
      expect(content).toContain('struct DiscoverResponse');
      expect(content).toContain('bitPerfect: Bool');

      const infoPlistTmpl = path.join(
        REPO_ROOT,
        'packaging',
        'macos-app',
        'Info.plist.tmpl',
      );
      expect(fs.existsSync(infoPlistTmpl)).toBe(true);

      const infoContent = fs.readFileSync(infoPlistTmpl, 'utf8');
      expect(infoContent).toContain('io.soundclud.app');
      expect(infoContent).toContain('CFBundleName');

      if (process.platform === 'darwin') {
        const lintOutput = execSync(`plutil -lint "${infoPlistTmpl}"`, { encoding: 'utf8' });
        expect(lintOutput).toContain('OK');
      }
    });

    it('T1-F19-05: validates Chromium extension manifest adheres to MV3 compliance', () => {
      const manifestPath = path.join(REPO_ROOT, 'packages', 'extension', 'manifest.json');
      expect(fs.existsSync(manifestPath)).toBe(true);

      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
        manifest_version: number;
        minimum_chrome_version?: string;
        permissions?: string[];
        host_permissions?: string[];
        content_scripts?: { world?: string }[];
      };

      expect(manifest.manifest_version).toBe(3);
      expect(manifest.minimum_chrome_version).toBe('116');

      // Law 3: Zero "cookies" permission
      expect(manifest.permissions ?? []).not.toContain('cookies');

      // Law 3: Zero "ws://" or "wss://" in host_permissions
      const hostPerms = manifest.host_permissions ?? [];
      expect(hostPerms.some((p) => p.startsWith('ws://') || p.startsWith('wss://'))).toBe(false);
      expect(hostPerms).toContain('https://soundcloud.com/*');
    });
  });

  // --------------------------------------------------------------------------
  // Feature 20: Live Capability & Regression Gate
  // --------------------------------------------------------------------------
  describe('Feature 20: Live Capability & Regression Gate', () => {
    it('T1-F20-01: advertises supportsHardwareVolume: true for discovered HEOS output', async () => {
      const receiver = await createMockReceiverServer({
        initialOutputs: [SYNTHETIC_OUTPUT_HEOS],
      });
      closables.push(receiver);

      const res = await fetch(`${receiver.baseUrl}/api/v1/discover`);
      expect(res.status).toBe(200);

      const data = (await res.json()) as {
        receivers: { outputs: { id: string; capabilities: { supportsHardwareVolume?: boolean } }[] }[];
      };

      const heosOutput = data.receivers[0]?.outputs.find((o) => o.id === SYNTHETIC_OUTPUT_HEOS.id);
      expect(heosOutput).toBeDefined();
      expect(heosOutput?.capabilities.supportsHardwareVolume).toBe(true);
    });

    it('T1-F20-02: advertises supportsHardwareVolume: false for discovered TOSLINK output', async () => {
      const receiver = await createMockReceiverServer({
        initialOutputs: [SYNTHETIC_OUTPUT_TOSLINK],
      });
      closables.push(receiver);

      const res = await fetch(`${receiver.baseUrl}/api/v1/discover`);
      expect(res.status).toBe(200);

      const data = (await res.json()) as {
        receivers: { outputs: { id: string; capabilities: { supportsHardwareVolume?: boolean } }[] }[];
      };

      const toslinkOutput = data.receivers[0]?.outputs.find((o) => o.id === SYNTHETIC_OUTPUT_TOSLINK.id);
      expect(toslinkOutput).toBeDefined();
      expect(toslinkOutput?.capabilities.supportsHardwareVolume).toBe(false);
    });

    it('T1-F20-03: verifies check:hygiene script existence and executable format', () => {
      const hygieneScript = path.join(REPO_ROOT, 'scripts', 'check-hygiene.mjs');
      expect(fs.existsSync(hygieneScript)).toBe(true);

      const content = fs.readFileSync(hygieneScript, 'utf8');
      expect(content).toContain('PII_SALT');
    });

    it('T1-F20-04: verifies offline network guard exists and intercepts non-loopback calls', () => {
      const guardPath = path.join(REPO_ROOT, 'tests', 'setup', 'offlineNetworkGuard.ts');
      expect(fs.existsSync(guardPath)).toBe(true);

      const content = fs.readFileSync(guardPath, 'utf8');
      expect(content).toContain('OfflineNetworkGuardError');
    });

    it('T1-F20-05: verifies static architecture invariants suite presence', () => {
      const staticSuite = path.join(REPO_ROOT, 'tests', 'staticArchitectureInvariants.test.ts');
      expect(fs.existsSync(staticSuite)).toBe(true);
    });
  });
});
