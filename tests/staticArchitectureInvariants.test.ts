import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isLoopbackHost, OfflineNetworkGuardError } from './setup/offlineNetworkGuard.js';

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(CURRENT_DIR, '..');

const EXCLUDED_DIR_NAMES = new Set<string>([
  '.git',
  'node_modules',
  'target',
  'dist',
  'build',
  'out',
  'coverage',
  '.vite',
  '.runtime',
]);

const IGNORED_FILE_NAMES = new Set<string>(['.DS_Store', 'Thumbs.db']);

const BINARY_EXTENSIONS = new Set<string>([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.icns',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf',
  '.mp3',
  '.aac',
  '.m4a',
  '.wav',
  '.ogg',
  '.flac',
  '.mp4',
  '.webm',
  '.wasm',
  '.zip',
  '.tar',
  '.gz',
  '.xz',
  '.bz2',
  '.7z',
  '.crx',
  '.dmg',
  '.pem',
  '.xpi',
  '.pdf',
  '.dylib',
  '.so',
  '.dll',
  '.exe',
  '.o',
  '.a',
  '.rlib',
  '.rmeta',
]);

const ALLOWED_NON_PERSONAL_USER_SEGMENTS = new Set<string>([
  'shared',
  'public',
  'default',
  'runner',
  'runneradmin',
  'example',
  'user',
  'username',
  'realuser',
  'youruser',
  'your-user',
  'your_user',
  'test',
  'testuser',
  'test-user',
  'alice',
  'bob',
]);

const PII_HASH_SALT = 'soundclud-zero-pii-v1:';

const BLOCKED_PERSONAL_DIGESTS = new Set<string>([
  '09e4e4138f5a83ca1a52ee794596540256e9e5207c792ea88f168770faa4e5c3',
  'dc5375721bffb934132dd506740ac0e172105b120119706485b50bbb439eaad8',
  '7cf64e80d6a269cde840eb9dbf0eeac15040e418cec61e0079a9811bb7eabd32',
]);

// Construct path patterns dynamically so hygiene grep tools never flag this test file itself.
const POSIX_HOME_PATH_PATTERN = new RegExp(
  ['', 'Users', '([A-Za-z0-9._-]+)(?:\\/|$|(?=["\'`\\s),;]))'].join('/'),
  'g',
);

const BACKSLASH_SEP = '(?:\\\\\\\\|\\\\)';
const WINDOWS_HOME_PATH_PATTERN = new RegExp(
  `[A-Za-z]:${BACKSLASH_SEP}Users${BACKSLASH_SEP}([A-Za-z0-9._-]+)(?:${BACKSLASH_SEP}|$|(?=["'\`\\s),;]))`,
  'gi',
);

const GITHUB_PAT_PATTERN = new RegExp(
  `\\b(?:${['ghp', 'gho', 'ghu', 'ghs', 'ghr'].join('|')})_[A-Za-z0-9]{36,255}\\b|\\bgithub_pat_[A-Za-z0-9_]{22,255}\\b`,
  'g',
);

const SOUNDCLOUD_OAUTH_V2_PATTERN = /\b2-\d{5,10}-\d{6,15}-([A-Za-z0-9_-]{12,64})\b/g;
const SOUNDCLOUD_OAUTH_ASSIGNMENT_PATTERN =
  /\boauth_token\s*[=:]\s*["']([A-Za-z0-9_-]{24,128})["']/gi;
const SYNTHETIC_SECRET_MARKER_PATTERN =
  /test|mock|fake|dummy|synthetic|example|placeholder|redacted|^0+$/i;

const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)';
const RFC1918_IPV4_PATTERN = new RegExp(
  `(?<![0-9.])((?:10\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET})|(?:172\\.(?:1[6-9]|2\\d|3[01])\\.${IPV4_OCTET}\\.${IPV4_OCTET})|(?:192\\.168\\.${IPV4_OCTET}\\.${IPV4_OCTET}))(?![0-9.])`,
  'g',
);

const CANONICAL_RFC1918_CIDR_DESCRIPTORS = new Set<string>([
  ['10', '0', '0', '0/8'].join('.'),
  ['172', '16', '0', '0/12'].join('.'),
  ['192', '168', '0', '0/16'].join('.'),
]);

const WINDOWS_DRIVE_ENTRY_NAME_PATTERN = /^[A-Za-z]:\\/;

const POSIX_TEST_WIN_DIR_CREATION_PATTERN = new RegExp(
  `\\b(?:mkdir|mkdirSync|mkdtemp|mkdtempSync|writeFile|writeFileSync|create_dir|create_dir_all)\\s*\\([^)]*[A-Za-z]:${BACKSLASH_SEP}Users${BACKSLASH_SEP}`,
  'i',
);

interface WorkspaceTextFile {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly content: string;
}

interface ScanViolation {
  readonly rule: string;
  readonly relativePath: string;
  readonly line: number;
  readonly detail: string;
}

function toPosixRelativePath(rootDir: string, targetPath: string): string {
  return path.relative(rootDir, targetPath).split(path.sep).join('/');
}

function collectWorkspaceFiles(
  rootDir: string,
): { readonly textFiles: readonly WorkspaceTextFile[]; readonly entryNames: readonly string[] } {
  const textFiles: WorkspaceTextFile[] = [];
  const entryNames: string[] = [];

  function walk(currentDir: string): void {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      if (IGNORED_FILE_NAMES.has(entry.name)) {
        continue;
      }

      const fullPath = path.join(currentDir, entry.name);
      const relPath = toPosixRelativePath(rootDir, fullPath);
      entryNames.push(`${relPath} (basename=${entry.name})`);

      if (entry.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry.name)) {
          continue;
        }
        walk(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) {
        continue;
      }

      const buffer = fs.readFileSync(fullPath);
      if (buffer.includes(0)) {
        continue;
      }

      textFiles.push({
        absolutePath: fullPath,
        relativePath: relPath,
        content: buffer.toString('utf8'),
      });
    }
  }

  walk(rootDir);
  return { textFiles, entryNames };
}

function scanContentForHygieneAndPortability(
  relativePath: string,
  content: string,
  digestCache: Map<string, string>,
): ScanViolation[] {
  const violations: ScanViolation[] = [];
  const lines = content.split(/\r?\n/);
  const isRuntimeSourcePackage =
    relativePath.startsWith('crates/') ||
    relativePath.startsWith('packages/') ||
    relativePath.startsWith('packaging/macos-app/') ||
    relativePath === 'scripts/build-macos-dmg.sh';

  const computeSaltedDigest = (normalizedToken: string): string => {
    const cached = digestCache.get(normalizedToken);
    if (cached !== undefined) {
      return cached;
    }
    const digest = crypto
      .createHash('sha256')
      .update(`${PII_HASH_SALT}${normalizedToken}`)
      .digest('hex');
    digestCache.set(normalizedToken, digest);
    return digest;
  };

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    if (line === undefined || line.length === 0) {
      continue;
    }
    const lineNumber = idx + 1;

    // 1. Personal POSIX home paths
    for (const match of line.matchAll(POSIX_HOME_PATH_PATTERN)) {
      const userSegment = match[1];
      if (
        userSegment !== undefined &&
        !ALLOWED_NON_PERSONAL_USER_SEGMENTS.has(userSegment.toLowerCase())
      ) {
        violations.push({
          rule: 'personal-posix-home-path',
          relativePath,
          line: lineNumber,
          detail: 'Disallowed POSIX personal home directory path detected',
        });
      }
    }

    // 2. Personal Windows home paths
    for (const match of line.matchAll(WINDOWS_HOME_PATH_PATTERN)) {
      const userSegment = match[1];
      if (
        userSegment !== undefined &&
        !ALLOWED_NON_PERSONAL_USER_SEGMENTS.has(userSegment.toLowerCase())
      ) {
        violations.push({
          rule: 'personal-windows-home-path',
          relativePath,
          line: lineNumber,
          detail: 'Disallowed Windows personal home directory path detected',
        });
      }
    }

    // 3. Salted SHA-256 blocked personal digests (never echo cleartext token in failure output)
    const compoundTokens = line.match(/[A-Za-z0-9]+(?:[._@-][A-Za-z0-9]+)*/g);
    if (compoundTokens !== null) {
      const candidateSet = new Set<string>();
      for (const rawToken of compoundTokens) {
        candidateSet.add(rawToken.toLowerCase());
        for (const dotPart of rawToken.split('.')) {
          if (dotPart.length > 0) {
            candidateSet.add(dotPart.toLowerCase());
          }
        }
        for (const subPart of rawToken.split(/[._@-]/)) {
          if (subPart.length > 0) {
            candidateSet.add(subPart.toLowerCase());
          }
        }
      }

      for (const candidate of candidateSet) {
        const digest = computeSaltedDigest(candidate);
        if (BLOCKED_PERSONAL_DIGESTS.has(digest)) {
          violations.push({
            rule: 'blocked-personal-pii-digest',
            relativePath,
            line: lineNumber,
            detail: `Matched blocked salted SHA-256 personal digest (${digest.slice(0, 12)}...)`,
          });
        }
      }
    }

    // 4. Leaked GitHub PATs & SoundCloud OAuth credentials
    if (GITHUB_PAT_PATTERN.test(line)) {
      GITHUB_PAT_PATTERN.lastIndex = 0;
      violations.push({
        rule: 'leaked-github-token',
        relativePath,
        line: lineNumber,
        detail: 'Potential GitHub Personal Access Token or OAuth secret detected',
      });
    }
    GITHUB_PAT_PATTERN.lastIndex = 0;

    for (const match of line.matchAll(SOUNDCLOUD_OAUTH_V2_PATTERN)) {
      const secretSuffix = match[1];
      if (secretSuffix !== undefined && !SYNTHETIC_SECRET_MARKER_PATTERN.test(secretSuffix)) {
        violations.push({
          rule: 'leaked-soundcloud-oauth-token',
          relativePath,
          line: lineNumber,
          detail: 'Potential SoundCloud OAuth v2 token literal detected',
        });
      }
    }

    for (const match of line.matchAll(SOUNDCLOUD_OAUTH_ASSIGNMENT_PATTERN)) {
      const secretValue = match[1];
      if (secretValue !== undefined && !SYNTHETIC_SECRET_MARKER_PATTERN.test(secretValue)) {
        violations.push({
          rule: 'leaked-soundcloud-oauth-cookie',
          relativePath,
          line: lineNumber,
          detail: 'Potential hardcoded oauth_token secret value detected',
        });
      }
    }

    // 5. Hardcoded RFC1918 LAN IPs inside crates/ or packages/
    if (isRuntimeSourcePackage) {
      for (const match of line.matchAll(RFC1918_IPV4_PATTERN)) {
        const ipLiteral = match[1];
        const matchIndex = match.index;
        if (ipLiteral === undefined || matchIndex === undefined) {
          continue;
        }
        const prefixOffset = match[0].length - ipLiteral.length;
        const cidrCandidate = line.slice(matchIndex + prefixOffset, matchIndex + prefixOffset + 16);
        const isCanonicalCidrDoc = Array.from(CANONICAL_RFC1918_CIDR_DESCRIPTORS).some((cidr) =>
          cidrCandidate.startsWith(cidr),
        );
        if (!isCanonicalCidrDoc) {
          violations.push({
            rule: 'hardcoded-rfc1918-lan-ip',
            relativePath,
            line: lineNumber,
            detail: `Hardcoded RFC1918 private LAN IP "${ipLiteral}" forbidden in crates/ and packages/`,
          });
        }
      }
    }
  }

  return violations;
}

function isTestSourceFile(relativePath: string): boolean {
  return (
    relativePath.startsWith('tests/') ||
    relativePath.endsWith('.test.ts') ||
    relativePath.endsWith('.spec.ts') ||
    /^crates\/[^/]+\/tests\/.+\.rs$/.test(relativePath)
  );
}

function scanTestFileForPosixWindowsDirBug(
  relativePath: string,
  content: string,
): ScanViolation[] {
  const violations: ScanViolation[] = [];
  const lines = content.split(/\r?\n/);

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx];
    if (line === undefined || line.length === 0) {
      continue;
    }
    if (POSIX_TEST_WIN_DIR_CREATION_PATTERN.test(line)) {
      violations.push({
        rule: 'posix-literal-windows-dir-creation',
        relativePath,
        line: idx + 1,
        detail:
          'Test constructs a literal Windows drive-letter Users directory on POSIX; use os.tmpdir() or pure string helpers',
      });
    }
  }

  return violations;
}

describe('Phase-0 Deterministic Offline Network Guard', () => {
  it('classifies loopback vs external/LAN hosts deterministically', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('127.0.0.1:9876')).toBe(true);
    expect(isLoopbackHost('[::1]:9876')).toBe(true);

    expect(isLoopbackHost('')).toBe(false);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('soundcloud.com')).toBe(false);
    expect(isLoopbackHost('api-v2.soundcloud.com')).toBe(false);
    expect(isLoopbackHost('cf-hls-media.sndcdn.com')).toBe(false);
    expect(isLoopbackHost(['192', '168', '1', '50'].join('.'))).toBe(false);
    expect(isLoopbackHost(['10', '0', '0', '12'].join('.'))).toBe(false);
    expect(isLoopbackHost(['172', '16', '0', '8'].join('.'))).toBe(false);
    expect(isLoopbackHost('127.0.0.1.evil.example')).toBe(false);
  });

  it('blocks outbound SoundCloud, CDN, and LAN requests via fetch, http, and https', async () => {
    await expect(
      (async () => fetch('https://api-v2.soundcloud.com/tracks/1'))(),
    ).rejects.toThrow(OfflineNetworkGuardError);

    const syntheticLanUrl = `http://${['192', '168', '1', '25'].join('.')}:9876/api/v1/status`;
    await expect((async () => fetch(syntheticLanUrl))()).rejects.toThrow(OfflineNetworkGuardError);

    expect(() => http.get('http://soundcloud.com/discover')).toThrow(OfflineNetworkGuardError);
    expect(() => https.get('https://cf-hls-media.sndcdn.com/playlist.m3u8')).toThrow(
      OfflineNetworkGuardError,
    );
  });

  it('allows ephemeral 127.0.0.1:0 loopback HTTP test servers and closes cleanly in finally', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', loopback: true }));
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });

    try {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        throw new Error('Expected TCP AddressInfo for ephemeral 127.0.0.1 server');
      }

      const response = await fetch(`http://127.0.0.1:${String(address.port)}/api/v1/status`);
      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(body).toEqual({ status: 'ok', loopback: true });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err !== undefined && err !== null) {
            reject(err);
            return;
          }
          resolve();
        });
      });
    }
  });
});

describe('Zero-PII & Universal Portability Repository Gate', () => {
  const workspaceSnapshot = collectWorkspaceFiles(REPO_ROOT);

  it('positively detects synthetic PII, secret, and RFC1918 violations in-memory', () => {
    const digestCache = new Map<string, string>();
    const syntheticPosixPath = ['', 'Users', 'jdoe', 'Documents', 'secret.txt'].join('/');
    const syntheticWinPath = ['C:', 'Users', 'jdoe', 'AppData', 'Local'].join('\\');
    const syntheticGithubPat = `${'ghp'}_${'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'}`;
    const syntheticScToken = ['2', '298421', '123456789', 'xYz987AbC654DeF321'].join('-');
    const syntheticLanIp = ['192', '168', '1', '77'].join('.');

    const findings = scanContentForHygieneAndPortability(
      'packages/extension/src/syntheticFixture.ts',
      [
        `const a = "${syntheticPosixPath}";`,
        `const b = "${syntheticWinPath}";`,
        `const c = "${syntheticGithubPat}";`,
        `const d = "OAuth ${syntheticScToken}";`,
        `const e = "http://${syntheticLanIp}:9876";`,
      ].join('\n'),
      digestCache,
    );

    const rulesTriggered = new Set(findings.map((v) => v.rule));
    expect(rulesTriggered.has('personal-posix-home-path')).toBe(true);
    expect(rulesTriggered.has('personal-windows-home-path')).toBe(true);
    expect(rulesTriggered.has('leaked-github-token')).toBe(true);
    expect(rulesTriggered.has('leaked-soundcloud-oauth-token')).toBe(true);
    expect(rulesTriggered.has('hardcoded-rfc1918-lan-ip')).toBe(true);
  });

  it('enforces zero personal paths, zero blocked PII digests, zero leaked tokens, and zero hardcoded LAN IPs across workspace files', () => {
    expect(workspaceSnapshot.textFiles.length).toBeGreaterThan(0);

    const digestCache = new Map<string, string>();
    const allViolations: ScanViolation[] = [];

    for (const file of workspaceSnapshot.textFiles) {
      const fileViolations = scanContentForHygieneAndPortability(
        file.relativePath,
        file.content,
        digestCache,
      );
      allViolations.push(...fileViolations);
    }

    expect(allViolations).toEqual([]);
  });

  it('verifies .dmg binary classification and enforces macOS 12 Monterey AppKit portability across packaging/macos-app and build-macos-dmg.sh', () => {
    expect(BINARY_EXTENSIONS.has('.dmg')).toBe(true);

    const byRelPath = new Map(
      workspaceSnapshot.textFiles.map((file) => [file.relativePath, file] as const),
    );

    const expectedMacAppTextFiles = [
      'packaging/macos-app/Info.plist.tmpl',
      'packaging/macos-app/generate-icns.mjs',
      'packaging/macos-app/Sources/Models.swift',
      'packaging/macos-app/Sources/ReceiverServiceManager.swift',
      'packaging/macos-app/Sources/RelocationHelper.swift',
      'packaging/macos-app/Sources/SetupWindowController.swift',
      'packaging/macos-app/Sources/SoundCludApp.swift',
      'scripts/build-macos-dmg.sh',
    ];

    const digestCache = new Map<string, string>();
    for (const relPath of expectedMacAppTextFiles) {
      const entry = byRelPath.get(relPath);
      expect(entry, `Expected workspace text file ${relPath} to exist`).toBeDefined();
      if (entry !== undefined) {
        expect(
          scanContentForHygieneAndPortability(entry.relativePath, entry.content, digestCache),
        ).toEqual([]);
      }
    }

    const swiftFiles = workspaceSnapshot.textFiles.filter(
      (file) => file.relativePath.startsWith('packaging/macos-app/') && file.relativePath.endsWith('.swift'),
    );
    expect(swiftFiles.length).toBeGreaterThanOrEqual(5);

    for (const swiftFile of swiftFiles) {
      // Late 2014 Intel Mac Mini (Macmini7,1) caps out at macOS 12 Monterey:
      // forbid SwiftUI MenuBarExtra / SMAppService (macOS 13+ Ventura-only APIs).
      expect(
        /\bimport\s+SwiftUI\b/.test(swiftFile.content),
        `${swiftFile.relativePath} must use AppKit/Foundation without SwiftUI`,
      ).toBe(false);
      expect(
        /\bMenuBarExtra\b/.test(swiftFile.content),
        `${swiftFile.relativePath} must not use macOS 13+ MenuBarExtra`,
      ).toBe(false);
      expect(
        /\bSMAppService\b/.test(swiftFile.content),
        `${swiftFile.relativePath} must not use macOS 13+ SMAppService`,
      ).toBe(false);
    }
  });
});

describe('Cross-OS Temp Directory Discipline', () => {
  const workspaceSnapshot = collectWorkspaceFiles(REPO_ROOT);

  it('ensures zero literal Windows drive-letter directories exist in the POSIX workspace and no test constructs them', async () => {
    const badEntries = workspaceSnapshot.entryNames.filter((entryInfo) => {
      const marker = '(basename=';
      const idx = entryInfo.lastIndexOf(marker);
      const basename = idx >= 0 ? entryInfo.slice(idx + marker.length, -1) : entryInfo;
      return WINDOWS_DRIVE_ENTRY_NAME_PATTERN.test(basename);
    });
    expect(badEntries).toEqual([]);

    const syntheticBadTest = `fs.mkdirSync("${['C:', 'Users', 'someone', 'tmp'].join('\\\\')}");`;
    expect(scanTestFileForPosixWindowsDirBug('tests/syntheticBad.test.ts', syntheticBadTest)).toHaveLength(1);

    const testViolations: ScanViolation[] = [];
    for (const file of workspaceSnapshot.textFiles) {
      if (!isTestSourceFile(file.relativePath)) {
        continue;
      }
      testViolations.push(...scanTestFileForPosixWindowsDirBug(file.relativePath, file.content));
    }
    expect(testViolations).toEqual([]);

    const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'soundclud-test-'));
    try {
      const stat = await fs.promises.stat(tempDir);
      expect(stat.isDirectory()).toBe(true);
    } finally {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
  });
});
