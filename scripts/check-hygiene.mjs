#!/usr/bin/env node

/**
 * SoundClud Zero-PII, Secret & Portability Hygiene Scanner.
 *
 * Zero-dependency Node ESM gate executed by `.githooks/pre-commit` and CI
 * (`npm run check:hygiene`). Fails with exit code 1 if any tracked or
 * non-ignored workspace file contains personal home paths, salted SHA-256
 * blocked personal identifiers, credential material, or hardcoded RFC1918 LAN
 * IPv4 literals inside runtime source directories (`crates/`, `packages/`).
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'target',
  'dist',
  '.runtime',
  'coverage',
  'build',
  'out',
  '.vite',
]);

const PII_SALT = 'soundclud-zero-pii-v1:';

const BLOCKED_IDENTIFIER_DIGESTS = new Set([
  '09e4e4138f5a83ca1a52ee794596540256e9e5207c792ea88f168770faa4e5c3',
  'dc5375721bffb934132dd506740ac0e172105b120119706485b50bbb439eaad8',
  '7cf64e80d6a269cde840eb9dbf0eeac15040e418cec61e0079a9811bb7eabd32',
]);

const MACOS_HOME_PATH_RE =
  /(?<![a-zA-Z0-9.:/])\/Users\/(?!Shared\b|(?:test|player|mock|fake|sample|synthetic|demo|portable)[a-zA-Z0-9._-]*\b|user\b|runner\b|admin\b|example\b|guest\b)[a-zA-Z0-9._-]{3,}\//i;

const MACOS_FILE_URI_HOME_PATH_RE =
  /file:\/\/\/Users\/(?!Shared\b|(?:test|player|mock|fake|sample|synthetic|demo|portable)[a-zA-Z0-9._-]*\b|user\b|runner\b|admin\b|example\b|guest\b)[a-zA-Z0-9._-]{3,}\//i;

const WINDOWS_HOME_PATH_RE =
  /C:\\+Users\\+(?!Public\b|Default\b|All Users\b|(?:test|player|mock|fake|sample|synthetic|demo|portable)[a-zA-Z0-9._-]*\b|user\b|runner\b|admin\b|example\b|WDAGUtilityAccount\b)[a-zA-Z0-9._-]{3,}\\+/i;

const EMAIL_TOKEN_RE = /[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+/g;
const IDENTIFIER_TOKEN_RE = /[a-zA-Z0-9._-]{4,}/g;
const SUBTOKEN_RE = /[a-zA-Z0-9]{4,}/g;

const SECRET_PATTERNS = [
  {
    id: 'github-classic-pat',
    description: 'GitHub classic personal access token (ghp_*)',
    regex: /\bghp_[A-Za-z0-9]{30,}\b/,
  },
  {
    id: 'github-fine-grained-pat',
    description: 'GitHub fine-grained personal access token (github_pat_*)',
    regex: /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  },
  {
    id: 'soundcloud-oauth-header',
    description: 'SoundCloud OAuth bearer credential',
    regex: /Authorization:\s*OAuth\s+2-[0-9]+-[0-9]+-[A-Za-z0-9]+/i,
  },
  {
    id: 'private-key-block',
    description: 'PEM private key header',
    regex: /BEGIN (?:RSA|OPENSSH|EC) PRIVATE KEY/,
  },
];

const IPV4_OCTET = '(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])';
const RFC1918_LAN_IP_RE = new RegExp(
  `(?<![0-9.vV])(?:192\\.168\\.${IPV4_OCTET}\\.${IPV4_OCTET}|10\\.${IPV4_OCTET}\\.${IPV4_OCTET}\\.${IPV4_OCTET}|172\\.(?:1[6-9]|2[0-9]|3[01])\\.${IPV4_OCTET}\\.${IPV4_OCTET})(?![0-9.])`,
);

/** @type {Map<string, boolean>} */
const tokenDigestCache = new Map();

/**
 * Checks whether a candidate token matches any salted SHA-256 blocked digest.
 * @param {string} rawToken
 * @returns {boolean}
 */
export function isBlockedIdentifierToken(rawToken) {
  const cached = tokenDigestCache.get(rawToken);
  if (cached !== undefined) {
    return cached;
  }

  const exactDigest = createHash('sha256')
    .update(PII_SALT + rawToken)
    .digest('hex');
  if (BLOCKED_IDENTIFIER_DIGESTS.has(exactDigest)) {
    tokenDigestCache.set(rawToken, true);
    return true;
  }

  const lower = rawToken.toLowerCase();
  if (lower !== rawToken) {
    const lowerDigest = createHash('sha256')
      .update(PII_SALT + lower)
      .digest('hex');
    if (BLOCKED_IDENTIFIER_DIGESTS.has(lowerDigest)) {
      tokenDigestCache.set(rawToken, true);
      return true;
    }
  }

  tokenDigestCache.set(rawToken, false);
  return false;
}

/**
 * Checks whether a normalized relative path has any excluded path segment.
 * @param {string} relPath
 * @returns {boolean}
 */
function hasExcludedSegment(relPath) {
  const parts = relPath.split('/');
  for (const part of parts) {
    if (EXCLUDED_DIRS.has(part)) {
      return true;
    }
  }
  return false;
}

/**
 * Recursively collects candidate files when `git ls-files` is unavailable.
 * @param {string} rootDir
 * @returns {string[]}
 */
function walkFilesFallback(rootDir) {
  /** @type {string[]} */
  const results = [];

  /** @param {string} currentDir */
  function visit(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry.name)) {
        continue;
      }
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isFile()) {
        const relPath = path.relative(rootDir, fullPath).split(path.sep).join('/');
        results.push(relPath);
      }
    }
  }

  visit(rootDir);
  return results.sort();
}

/**
 * Lists workspace files via `git ls-files` (tracked + non-ignored untracked),
 * falling back to recursive directory walk when outside a git worktree.
 * @param {string} rootDir
 * @returns {string[]}
 */
export function collectCandidateFiles(rootDir) {
  try {
    const stdout = execFileSync(
      'git',
      ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
      {
        cwd: rootDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 16 * 1024 * 1024,
      },
    );

    const files = Array.from(
      new Set(
        stdout
          .split('\0')
          .filter(Boolean)
          .map((f) => f.split(path.sep).join('/'))
          .filter((relPath) => {
            if (hasExcludedSegment(relPath)) {
              return false;
            }
            const absPath = path.join(rootDir, relPath);
            try {
              return fs.statSync(absPath).isFile();
            } catch {
              return false;
            }
          }),
      ),
    ).sort();

    if (files.length > 0) {
      return files;
    }
  } catch {
    // Fall back to filesystem walk when git is unavailable or not initialized.
  }

  return walkFilesFallback(rootDir);
}

/**
 * Scans UTF-8 file text for Zero-PII, secret, and LAN-IP portability violations.
 * Values are redacted in violation messages so CI logs never echo PII/secrets.
 *
 * @param {string} relativePath
 * @param {string} content
 * @returns {Array<{ file: string; line: number; rule: string; message: string }>}
 */
export function scanText(relativePath, content) {
  const relPath = relativePath.split(path.sep).join('/');
  const checkRfc1918LanIp =
    (relPath.startsWith('crates/') || relPath.startsWith('packages/')) &&
    !relPath.includes('.test.');

  /** @type {Array<{ file: string; line: number; rule: string; message: string }>} */
  const violations = [];
  const lines = content.split(/\r?\n/);

  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx] ?? '';
    const lineNumber = idx + 1;

    if (MACOS_HOME_PATH_RE.test(line) || MACOS_FILE_URI_HOME_PATH_RE.test(line)) {
      violations.push({
        file: relPath,
        line: lineNumber,
        rule: 'personal-macos-home-path',
        message: 'Personal macOS /Users/<user>/ path detected [REDACTED]',
      });
    }

    if (WINDOWS_HOME_PATH_RE.test(line)) {
      violations.push({
        file: relPath,
        line: lineNumber,
        rule: 'personal-windows-home-path',
        message: 'Personal Windows C:\\Users\\<user>\\ path detected [REDACTED]',
      });
    }

    let foundBlockedDigestOnLine = false;
    const candidateTokens = new Set([
      ...(line.match(EMAIL_TOKEN_RE) ?? []),
      ...(line.match(IDENTIFIER_TOKEN_RE) ?? []),
      ...(line.match(SUBTOKEN_RE) ?? []),
    ]);
    for (const token of candidateTokens) {
      if (isBlockedIdentifierToken(token)) {
        foundBlockedDigestOnLine = true;
        break;
      }
    }
    if (foundBlockedDigestOnLine) {
      violations.push({
        file: relPath,
        line: lineNumber,
        rule: 'blocked-personal-identifier',
        message: 'Salted SHA-256 blocked personal identifier/email detected [REDACTED]',
      });
    }

    for (const secretRule of SECRET_PATTERNS) {
      if (secretRule.regex.test(line)) {
        violations.push({
          file: relPath,
          line: lineNumber,
          rule: secretRule.id,
          message: `${secretRule.description} detected [REDACTED]`,
        });
      }
    }

    if (checkRfc1918LanIp && RFC1918_LAN_IP_RE.test(line)) {
      violations.push({
        file: relPath,
        line: lineNumber,
        rule: 'hardcoded-rfc1918-lan-ip',
        message:
          'Hardcoded RFC1918 LAN IPv4 literal in runtime source (use discovery or loopback in tests)',
      });
    }
  }

  return violations;
}

/**
 * Scans an entire workspace root directory.
 * @param {string} rootDir
 * @returns {{ scannedFiles: number; violations: Array<{ file: string; line: number; rule: string; message: string }> }}
 */
export function scanWorkspace(rootDir) {
  const files = collectCandidateFiles(rootDir);
  /** @type {Array<{ file: string; line: number; rule: string; message: string }>} */
  const allViolations = [];
  let scannedFiles = 0;

  for (const relPath of files) {
    const absPath = path.join(rootDir, relPath);
    let buffer;
    try {
      buffer = fs.readFileSync(absPath);
    } catch {
      continue;
    }

    // Skip binary files containing NUL bytes in header chunk.
    if (buffer.subarray(0, 8192).includes(0)) {
      continue;
    }

    scannedFiles += 1;
    const text = buffer.toString('utf8');
    const fileViolations = scanText(relPath, text);
    allViolations.push(...fileViolations);
  }

  return { scannedFiles, violations: allViolations };
}

function parseRootArg(argv) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--root' && argv[i + 1]) {
      return path.resolve(argv[i + 1]);
    }
  }
  return process.cwd();
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return (
      fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return path.resolve(entry) === fileURLToPath(import.meta.url);
  }
}

if (isMainModule()) {
  const rootDir = parseRootArg(process.argv.slice(2));
  const { scannedFiles, violations } = scanWorkspace(rootDir);

  if (violations.length > 0) {
    console.error(
      `[hygiene] FAILED — ${violations.length} violation(s) found across ${scannedFiles} scanned file(s):`,
    );
    for (const v of violations) {
      console.error(`  - ${v.file}:${v.line} [${v.rule}] ${v.message}`);
    }
    process.exit(1);
  }

  console.log(
    `[hygiene] OK — scanned ${scannedFiles} file(s) with zero PII, secret, or portability violations.`,
  );
}
