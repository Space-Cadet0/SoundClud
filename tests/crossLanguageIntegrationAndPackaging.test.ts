import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  API_V1_DISCOVER_PATH,
  API_V1_PAIR_PATH,
  API_V1_STATUS_PATH,
  BIT_PERFECT_BIT_DEPTH,
  BIT_PERFECT_GAIN_DB,
  BIT_PERFECT_SAMPLE_RATE_HZ,
  PROTOCOL_VERSION,
  parseApiErrorResponse,
  parseServerWsEvent,
  parseStatusResponse,
} from '@soundclud/protocol';
import {
  MaestroVirtualizerController,
  ReceiverWsController,
  SoundCloudSessionObserver,
  SoundCloudTrackCatalog,
  createDefaultDurableLocalConfig,
  createDefaultEphemeralSessionState,
  createInMemoryStorageArea,
  discoverReceivers,
  ensureTofuPairingToken,
  readDurableLocalConfig,
  readEphemeralSessionState,
  updateDurableLocalConfig,
  updateEphemeralSessionState,
  type IsolatedToMainMessage,
  type MinimalWebSocket,
} from '@soundclud/extension';
import { packageExtensionDirectory } from '../scripts/package-extension.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..');
const SYNTHETIC_EXTENSION_ORIGIN = 'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

type NodeUndiciWebSocketConstructor = new (
  url: string,
  init?: { readonly headers?: Readonly<Record<string, string>> },
) => MinimalWebSocket;

const NodeWebSocket = WebSocket as unknown as NodeUndiciWebSocketConstructor;

function resolveReceiverBinaryPath(): string {
  const exeName = process.platform === 'win32' ? 'soundclud-receiver.exe' : 'soundclud-receiver';
  return path.join(REPO_ROOT, 'target', 'debug', exeName);
}

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;]*m/g, '');
}

interface RunningReceiverHandle {
  readonly baseUrl: string;
  readonly port: number;
  readonly stateDir: string;
  readonly mpvFetchedSegmentLogPath: string;
  readonly tmpRoot: string;
  stop(): Promise<void>;
}

async function startEphemeralReceiverDaemon(): Promise<RunningReceiverHandle> {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sc-e2e-'));
  const stateDir = path.join(tmpRoot, 'state');
  const mockMpvPath = path.join(tmpRoot, 'mock-mpv.mjs');
  const mpvFetchedSegmentLogPath = path.join(tmpRoot, 'mpv-segment-result.txt');

  await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });

  // Standalone zero-dependency Node mock-mpv speaking real mpv JSON-IPC over UNIX domain socket
  // so `soundclud-receiver` can spawn it, negotiate `--volume=100` / `--audio-samplerate=44100`,
  // and fetch `/hls/<session_id>/playlist.m3u8` + `/seg/0` over loopback!
  const mockMpvScript = [
    `#!${process.execPath}`,
    "import fs from 'node:fs';",
    "import net from 'node:net';",
    '',
    'const args = process.argv.slice(2);',
    "if (args.includes('--audio-device=help')) {",
    '  process.stdout.write("List of detected audio devices:\\n");',
    '  process.stdout.write("  \'auto\' (Autoselect device)\\n");',
    '  process.stdout.write("  \'coreaudio/spdf\' (Optical Digital S/PDIF Output)\\n");',
    '  process.stdout.write("  \'alsa/iec958:CARD=PCH,DEV=0\' (Digital S/PDIF Optical)\\n");',
    '  process.exit(0);',
    '}',
    '',
    "const ipcArg = args.find((a) => a.startsWith('--input-ipc-server='));",
    'if (!ipcArg) {',
    '  process.exit(0);',
    '}',
    "const sockPath = ipcArg.slice('--input-ipc-server='.length);",
    'try { fs.unlinkSync(sockPath); } catch {}',
    '',
    'const logPath = process.env.SC_MOCK_MPV_SEG_LOG;',
    'const server = net.createServer((conn) => {',
    "  let buf = '';",
    "  conn.on('data', (chunk) => {",
    "    buf += chunk.toString('utf8');",
    '    let nl;',
    "    while ((nl = buf.indexOf('\\n')) !== -1) {",
    '      const line = buf.slice(0, nl).trim();',
    '      buf = buf.slice(nl + 1);',
    '      if (!line) continue;',
    '      try {',
    '        const msg = JSON.parse(line);',
    '        if (typeof msg.request_id === "number") {',
    '          conn.write(JSON.stringify({ request_id: msg.request_id, error: "success", data: null }) + "\\n");',
    '        }',
    '        if (Array.isArray(msg.command) && msg.command[0] === "loadfile" && typeof msg.command[1] === "string") {',
    '          const url = msg.command[1];',
    '          if (url.startsWith("http://127.0.0.1:") && url.endsWith("/playlist.m3u8")) {',
    '            (async () => {',
    '              try {',
    '                const plRes = await fetch(url);',
    '                const plText = await plRes.text();',
    '                const segLine = plText.split(/\\r?\\n/).find((l) => l.includes("/seg/0"));',
    '                if (segLine) {',
    '                  const segUrl = segLine.startsWith("http") ? segLine : new URL(segLine, url).toString();',
    '                  const segRes = await fetch(segUrl);',
    '                  const segText = await segRes.text();',
    '                  if (logPath) {',
    '                    fs.writeFileSync(logPath, `${String(segRes.status)}:${segText}`, "utf8");',
    '                  }',
    '                }',
    '              } catch (e) {',
    '                if (logPath) {',
    '                  fs.writeFileSync(logPath, `ERR:${String(e)}`, "utf8");',
    '                }',
    '              }',
    '            })();',
    '          }',
    '        }',
    '        if (Array.isArray(msg.command) && msg.command[0] === "quit") {',
    '          server.close(() => process.exit(0));',
    '        }',
    '      } catch {}',
    '    }',
    '  });',
    '});',
    'server.listen(sockPath);',
    'process.on("SIGTERM", () => server.close(() => process.exit(0)));',
    'process.on("SIGINT", () => server.close(() => process.exit(0)));',
    '',
  ].join('\n');

  await fsp.writeFile(mockMpvPath, mockMpvScript, { encoding: 'utf8', mode: 0o755 });

  const binPath = resolveReceiverBinaryPath();
  const child: ChildProcess = spawn(
    binPath,
    [
      '--bind',
      '127.0.0.1:0',
      '--state-dir',
      stateDir,
      '--mpv-bin',
      mockMpvPath,
      '--name',
      'Lab Optical Receiver',
      '--no-lan-discovery',
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NO_COLOR: '1',
        RUST_LOG: 'info',
        SC_MOCK_MPV_SEG_LOG: mpvFetchedSegmentLogPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const cleanupProcessAndTmp = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      const exitedPromise = new Promise<void>((resolve) => {
        child.once('exit', () => {
          resolve();
        });
      });
      child.kill('SIGINT');
      const sigintWon = await Promise.race([
        exitedPromise.then(() => true),
        new Promise<boolean>((resolve) => {
          setTimeout(() => {
            resolve(false);
          }, 250);
        }),
      ]);
      if (!sigintWon && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await Promise.race([
          exitedPromise,
          new Promise<void>((resolve) => {
            setTimeout(resolve, 250);
          }),
        ]);
      }
    }
    await fsp.rm(tmpRoot, { recursive: true, force: true });
  };

  try {
    const boundAddr = await new Promise<string>((resolve, reject) => {
      let combinedOutput = '';
      const startupTimer = setTimeout(() => {
        reject(
          new Error(
            `Timed out waiting for soundclud-receiver startup. Output:\n${combinedOutput}`,
          ),
        );
      }, 3_500);

      const inspectChunk = (chunk: Buffer): void => {
        combinedOutput += stripAnsi(chunk.toString('utf8'));
        const match = /listen=(127\.0\.0\.1:\d+)/.exec(combinedOutput);
        if (match?.[1] !== undefined) {
          clearTimeout(startupTimer);
          resolve(match[1]);
        }
      };

      child.stdout?.on('data', inspectChunk);
      child.stderr?.on('data', inspectChunk);
      child.once('error', (err) => {
        clearTimeout(startupTimer);
        reject(err);
      });
      child.once('exit', (code, sig) => {
        clearTimeout(startupTimer);
        reject(
          new Error(
            `soundclud-receiver exited prematurely (code=${String(code)}, signal=${String(sig)}):\n${combinedOutput}`,
          ),
        );
      });
    });

    const portPart = boundAddr.split(':')[1];
    const port = Number(portPart);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`Invalid bound port parsed from "${boundAddr}"`);
    }

    return {
      baseUrl: `http://${boundAddr}`,
      port,
      stateDir,
      mpvFetchedSegmentLogPath,
      tmpRoot,
      stop: cleanupProcessAndTmp,
    };
  } catch (err) {
    await cleanupProcessAndTmp();
    throw err;
  }
}

interface RawHttpResult {
  readonly statusCode: number;
  readonly headers: http.IncomingHttpHeaders;
  readonly bodyText: string;
}

function sendRawLoopbackHttpRequest(options: {
  readonly port: number;
  readonly method: 'GET' | 'POST' | 'OPTIONS';
  readonly requestPath: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
}): Promise<RawHttpResult> {
  return new Promise<RawHttpResult>((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port: options.port,
        path: options.requestPath,
        method: options.method,
        headers: options.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            bodyText: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) {
      req.write(options.body);
    }
    req.end();
  });
}

function createExtensionOriginFetch(originHeader: string): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const mergedHeaders = new Headers(init?.headers);
    mergedHeaders.set('Origin', originHeader);
    return await fetch(input, {
      ...init,
      headers: mergedHeaders,
    });
  };
}

interface TelemetryObservedSocketFactory {
  readonly createWebSocket: (url: string) => MinimalWebSocket;
  readonly getOpenCount: () => number;
  readonly getLastHelloToWelcomeMs: () => number | null;
  readonly waitForNextPongLatencyMs: () => Promise<number>;
  readonly dropActiveWireSocket: () => void;
}

function createObservedExtensionWebSocketFactory(
  originHeader: string,
): TelemetryObservedSocketFactory {
  let openCount = 0;
  let lastRawSocket: MinimalWebSocket | null = null;
  let lastHelloSentAtMs: number | null = null;
  let lastHelloToWelcomeMs: number | null = null;
  let lastPingSentAtMs: number | null = null;
  let pongWaiter: ((latencyMs: number) => void) | null = null;

  const createWebSocket = (url: string): MinimalWebSocket => {
    openCount += 1;
    const rawWs = new NodeWebSocket(url, {
      headers: { Origin: originHeader },
    });
    lastRawSocket = rawWs;

    rawWs.addEventListener('message', (event) => {
      if (typeof event !== 'object' || event === null) {
        return;
      }
      const data = (event as { readonly data?: unknown }).data;
      if (typeof data !== 'string') {
        return;
      }
      try {
        const parsed = parseServerWsEvent(JSON.parse(data));
        if (!parsed.ok) {
          return;
        }
        const now = performance.now();
        if (parsed.value.type === 'welcome' && lastHelloSentAtMs !== null) {
          lastHelloToWelcomeMs = now - lastHelloSentAtMs;
        } else if (parsed.value.type === 'pong' && lastPingSentAtMs !== null) {
          const rtt = now - lastPingSentAtMs;
          if (pongWaiter !== null) {
            const resolve = pongWaiter;
            pongWaiter = null;
            resolve(rtt);
          }
        }
      } catch {
        // Ignore non-JSON frames in observer wrapper.
      }
    });

    return {
      get readyState(): number {
        return rawWs.readyState;
      },
      send(payload: string): void {
        try {
          const parsedObj = JSON.parse(payload) as { readonly type?: unknown };
          if (parsedObj.type === 'hello') {
            lastHelloSentAtMs = performance.now();
          } else if (parsedObj.type === 'ping') {
            lastPingSentAtMs = performance.now();
          }
        } catch {
          // Ignore malformed outbound test frame.
        }
        rawWs.send(payload);
      },
      close(code?: number, reason?: string): void {
        rawWs.close(code, reason);
      },
      addEventListener(type, listener): void {
        rawWs.addEventListener(type, listener);
      },
    };
  };

  return {
    createWebSocket,
    getOpenCount: () => openCount,
    getLastHelloToWelcomeMs: () => lastHelloToWelcomeMs,
    waitForNextPongLatencyMs: () =>
      new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => {
          pongWaiter = null;
          reject(new Error('Timed out waiting for WebSocket pong frame'));
        }, 1_500);
        pongWaiter = (rttMs) => {
          clearTimeout(timer);
          resolve(rttMs);
        };
      }),
    dropActiveWireSocket: () => {
      lastRawSocket?.close(1000, 'simulated_wifi_drop');
    },
  };
}

describe('Cross-Language Extension <-> Rust Receiver E2E & Offline Packaging Verification', () => {
  beforeAll(() => {
    const binPath = resolveReceiverBinaryPath();
    if (!fs.existsSync(binPath)) {
      const homeDir = os.homedir();
      const cargoBin = path.join(homeDir, '.cargo', 'bin');
      const envPath = `${cargoBin}${path.delimiter}${process.env['PATH'] ?? ''}`;
      execFileSync('cargo', ['build', '--bin', 'soundclud-receiver'], {
        cwd: REPO_ROOT,
        env: { ...process.env, PATH: envPath },
        stdio: 'inherit',
      });
    }
  }, 60_000);

  it('enforces anti-DNS-rebinding Host checks, rejects web Origins, and serves PNA CORS preflight to chrome-extension:// origins', async () => {
    const daemon = await startEphemeralReceiverDaemon();
    try {
      // 1. Forged Host header (DNS rebinding simulation) -> HTTP 403 forbidden_host
      const rebindRes = await sendRawLoopbackHttpRequest({
        port: daemon.port,
        method: 'GET',
        requestPath: API_V1_DISCOVER_PATH,
        headers: {
          Host: 'evil.example:9876',
          Accept: 'application/json',
        },
      });
      expect(rebindRes.statusCode).toBe(403);
      const rebindErr = parseApiErrorResponse(JSON.parse(rebindRes.bodyText));
      expect(rebindErr.ok).toBe(true);
      if (rebindErr.ok) {
        expect(rebindErr.value.error.code).toBe('forbidden_host');
      }

      // 2. Web page Origins (even https://soundcloud.com or https://evil.example) -> HTTP 403 web_origin_forbidden
      for (const forbiddenOrigin of ['https://soundcloud.com', 'https://evil.example']) {
        const webOriginRes = await sendRawLoopbackHttpRequest({
          port: daemon.port,
          method: 'GET',
          requestPath: API_V1_DISCOVER_PATH,
          headers: {
            Host: `127.0.0.1:${String(daemon.port)}`,
            Origin: forbiddenOrigin,
            Accept: 'application/json',
          },
        });
        expect(webOriginRes.statusCode).toBe(403);
        const parsedErr = parseApiErrorResponse(JSON.parse(webOriginRes.bodyText));
        expect(parsedErr.ok).toBe(true);
        if (parsedErr.ok) {
          expect(parsedErr.value.error.code).toBe('web_origin_forbidden');
        }
      }

      // 3. Chromium MV3 Private Network Access (PNA) OPTIONS preflight -> HTTP 204
      const pnaRes = await sendRawLoopbackHttpRequest({
        port: daemon.port,
        method: 'OPTIONS',
        requestPath: API_V1_PAIR_PATH,
        headers: {
          Host: `127.0.0.1:${String(daemon.port)}`,
          Origin: SYNTHETIC_EXTENSION_ORIGIN,
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'Content-Type, Authorization',
          'Access-Control-Request-Private-Network': 'true',
        },
      });
      expect(pnaRes.statusCode).toBe(204);
      expect(pnaRes.headers['access-control-allow-origin']).toBe(SYNTHETIC_EXTENSION_ORIGIN);
      expect(pnaRes.headers['access-control-allow-private-network']).toBe('true');
    } finally {
      await daemon.stop();
    }
  });

  it('executes full TypeScript Extension <-> Rust Receiver discovery, stale-token TOFU recovery, <50ms WS handshake/ping, multi-tab session_claimed handoff, WS drop reconnect, and mid-mix HLS 403 refresh', async () => {
    const daemon = await startEphemeralReceiverDaemon();
    const extFetch = createExtensionOriginFetch(SYNTHETIC_EXTENSION_ORIGIN);

    // Local 127.0.0.1 synthetic HLS/resolve upstream server for mid-mix HTTP 403 chaos verification
    let staleSegment403Hits = 0;
    let resolveStale403Hits = 0;
    let freshSegment200Hits = 0;
    let cdnAuthHeaderLeaked = false;

    const syntheticUpstreamServer = http.createServer((req, res) => {
      if (req.headers['authorization'] !== undefined) {
        cdnAuthHeaderLeaked = true;
      }
      const reqUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      const addr = syntheticUpstreamServer.address() as AddressInfo;
      const origin = `http://127.0.0.1:${String(addr.port)}`;

      if (reqUrl.pathname === '/resolve-stale') {
        resolveStale403Hits += 1;
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'expired_resolve_token' }));
        return;
      }
      if (reqUrl.pathname === '/resolve-fresh') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ url: `${origin}/playlist-fresh.m3u8` }));
        return;
      }
      if (reqUrl.pathname === '/playlist-stale.m3u8') {
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        res.end(`#EXTM3U\n#EXTINF:4.0,\n${origin}/seg-stale.m4s\n#EXT-X-ENDLIST\n`);
        return;
      }
      if (reqUrl.pathname === '/seg-stale.m4s') {
        staleSegment403Hits += 1;
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('CloudFront Signed URL Expired');
        return;
      }
      if (reqUrl.pathname === '/playlist-fresh.m3u8') {
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
        res.end(`#EXTM3U\n#EXTINF:4.0,\n${origin}/seg-fresh.m4s\n#EXT-X-ENDLIST\n`);
        return;
      }
      if (reqUrl.pathname === '/seg-fresh.m4s') {
        freshSegment200Hits += 1;
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end('FRESH_GO_PLUS_AAC_256K_SEGMENT_OK');
        return;
      }
      res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => {
      syntheticUpstreamServer.listen(0, '127.0.0.1', () => {
        resolve();
      });
    });
    const upstreamPort = (syntheticUpstreamServer.address() as AddressInfo).port;
    const upstreamBaseUrl = `http://127.0.0.1:${String(upstreamPort)}`;

    const tabAFactory = createObservedExtensionWebSocketFactory(SYNTHETIC_EXTENSION_ORIGIN);
    const tabBFactory = createObservedExtensionWebSocketFactory(SYNTHETIC_EXTENSION_ORIGIN);

    const tabAStorage = {
      local: createInMemoryStorageArea(),
      session: createInMemoryStorageArea(),
    };
    const tabBStorage = {
      local: createInMemoryStorageArea(),
      session: createInMemoryStorageArea(),
    };

    const tabAForwarded: IsolatedToMainMessage[] = [];
    const tabBForwarded: IsolatedToMainMessage[] = [];

    // Wire a real MaestroVirtualizerController onto Tab B so `refresh_locator_request` from Rust
    // traverses `ReceiverWsController -> MaestroVirtualizerController -> ReceiverWsController -> Rust`!
    const tabBCatalog = new SoundCloudTrackCatalog();
    const tabBSessionObserver = new SoundCloudSessionObserver();
    tabBSessionObserver.ingestHydration([{ hydratable: 'apiClient', data: { id: 'cid_e2e_tab_b' } }]);

    let tabBCtrlRef: ReceiverWsController | null = null;
    const tabBMaestro = new MaestroVirtualizerController({
      catalog: tabBCatalog,
      sessionObserver: tabBSessionObserver,
      sendToIsolated: (msg) => {
        if (msg.type === 'refresh_locator_result' && tabBCtrlRef !== null) {
          void tabBCtrlRef.sendCommand({
            type: 'refresh_locator_response',
            requestId: msg.requestId,
            ...(msg.locator !== undefined ? { locator: msg.locator } : {}),
            ...(msg.error !== undefined ? { error: msg.error } : {}),
          });
        }
      },
      nativeBridge: {
        pauseElement: () => undefined,
        getNativeCurrentTimeSeconds: () => 0,
        getNativePaused: () => true,
      },
    });

    const tabAController = new ReceiverWsController({
      storage: tabAStorage,
      fetchImpl: extFetch,
      createWebSocket: tabAFactory.createWebSocket,
      onStateChanged: () => undefined,
      onForwardToMain: (msg) => {
        tabAForwarded.push(msg);
      },
    });

    const tabBController = new ReceiverWsController({
      storage: tabBStorage,
      fetchImpl: extFetch,
      createWebSocket: tabBFactory.createWebSocket,
      onStateChanged: () => undefined,
      onForwardToMain: (msg) => {
        tabBForwarded.push(msg);
        if (msg.type === 'refresh_locator_request') {
          // Simulate SoundCloud SPA hydrating/refreshing fresh resolve URL for track 777
          tabBCatalog.ingestPayload({
            id: 777,
            title: 'Long DJ Mix (Mid-Stream 403 Refresh)',
            permalink_url: 'https://soundcloud.com/synthetic-dj/long-mix-777',
            full_duration: 3_600_000,
            duration: 3_600_000,
            user: { username: 'Synthetic DJ' },
            media: {
              transcodings: [
                {
                  url: `${upstreamBaseUrl}/resolve-fresh`,
                  preset: 'aac_256k',
                  duration: 3_600_000,
                  quality: 'hq',
                  format: {
                    protocol: 'hls',
                    mime_type: 'audio/mp4; codecs="mp4a.40.2"',
                  },
                },
              ],
            },
          });
          tabBMaestro.handleIsolatedMessage(msg);
        }
      },
    });
    tabBCtrlRef = tabBController;

    try {
      // 1. Discover real Rust receiver via `@soundclud/extension` `discoverReceivers`
      const discovered = await discoverReceivers({
        includeDefaultCandidates: false,
        knownEndpoints: [daemon.baseUrl],
        fetchImpl: extFetch,
      });
      expect(discovered.length).toBe(1);
      const receiverRecord = discovered[0];
      expect(receiverRecord).toBeDefined();
      if (receiverRecord === undefined) {
        throw new Error('Expected discovered receiver record');
      }
      expect(receiverRecord.receiverName).toBe('Lab Optical Receiver');
      expect(receiverRecord.isLoopback).toBe(true);
      expect(receiverRecord.requiresPairing).toBe(true);
      expect(receiverRecord.outputs.length).toBeGreaterThanOrEqual(1);
      for (const out of receiverRecord.outputs) {
        expect(out.capabilities.bitPerfect).toBe(true);
        expect(out.capabilities.fixedGainDb).toBe(BIT_PERFECT_GAIN_DB);
        expect(out.capabilities.targetSampleRateHz).toBe(BIT_PERFECT_SAMPLE_RATE_HZ);
        expect(out.capabilities.targetBitDepth).toBe(BIT_PERFECT_BIT_DEPTH);
      }

      // 2. Seed Tab A with a STALE pairing token -> real Rust `unauthorized` WS frame purges & re-pairs
      await updateDurableLocalConfig(tabAStorage.local, () => ({
        ...createDefaultDurableLocalConfig('sc-ext-tab-a-synthetic'),
        clientLabel: 'Tab A Chromium',
        handoffEnabled: true,
        activeEndpointBaseUrl: daemon.baseUrl,
        activeReceiverId: receiverRecord.receiverId,
        activeReceiverName: receiverRecord.receiverName,
        pairingTokensByReceiverId: {
          [receiverRecord.receiverId]: 'stale_token_synthetic_must_be_purged_0001',
        },
      }));
      await updateEphemeralSessionState(tabAStorage.session, () => ({
        ...createDefaultEphemeralSessionState(),
        discoveredReceivers: discovered,
      }));

      const connectedA = await tabAController.ensureConnected();
      expect(connectedA).toBe(true);
      expect(tabAFactory.getOpenCount()).toBe(2);

      const updatedLocalA = await readDurableLocalConfig(tabAStorage.local);
      const freshTokenA = updatedLocalA.pairingTokensByReceiverId[receiverRecord.receiverId];
      expect(freshTokenA).toBeDefined();
      expect(freshTokenA).not.toBe('stale_token_synthetic_must_be_purged_0001');
      expect(freshTokenA).toMatch(/^[0-9a-f]{64}$/);

      // Verify `receiver-state.json` on disk has mode 0600 and stores ONLY SHA-256 hash
      const stateFilePath = path.join(daemon.stateDir, 'receiver-state.json');
      const stateStat = await fsp.stat(stateFilePath);
      if (process.platform !== 'win32') {
        expect(stateStat.mode & 0o777).toBe(0o600);
      }
      const stateRawJson = await fsp.readFile(stateFilePath, 'utf8');
      expect(stateRawJson).not.toContain(freshTokenA ?? '');
      expect(stateRawJson).toContain('tokenSha256');

      // 3. Verify warm `hello` -> `welcome` latency (< 50 ms) and `ping` -> `pong` RTT (< 50 ms)
      const helloToWelcomeMs = tabAFactory.getLastHelloToWelcomeMs();
      expect(helloToWelcomeMs).not.toBeNull();
      expect(helloToWelcomeMs ?? 999).toBeLessThan(50);

      const pongPromise = tabAFactory.waitForNextPongLatencyMs();
      await tabAController.sendPingIfConnected();
      const pingPongRttMs = await pongPromise;
      expect(pingPongRttMs).toBeLessThan(50);

      // 4. Multi-tab `session_claimed` handoff: Tab B pairs via `ensureTofuPairingToken` and connects
      await updateDurableLocalConfig(tabBStorage.local, () => ({
        ...createDefaultDurableLocalConfig('sc-ext-tab-b-synthetic'),
        clientLabel: 'Tab B Chromium',
        handoffEnabled: true,
        activeEndpointBaseUrl: daemon.baseUrl,
        activeReceiverId: receiverRecord.receiverId,
        activeReceiverName: receiverRecord.receiverName,
      }));
      await updateEphemeralSessionState(tabBStorage.session, () => ({
        ...createDefaultEphemeralSessionState(),
        discoveredReceivers: discovered,
      }));

      const tokenB = await ensureTofuPairingToken(
        daemon.baseUrl,
        receiverRecord.receiverId,
        tabBStorage,
        extFetch,
      );
      expect(tokenB).toMatch(/^[0-9a-f]{64}$/);
      expect(tokenB).not.toBe(freshTokenA);

      const connectedB = await tabBController.ensureConnected();
      expect(connectedB).toBe(true);

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 60);
      });

      const tabASessionAfterClaim = await readEphemeralSessionState(tabAStorage.session);
      expect(tabASessionAfterClaim.connectionState).toBe('session_claimed');
      expect(
        tabAForwarded.some(
          (m) =>
            m.type === 'session_claimed' &&
            m.newControllerId === 'sc-ext-tab-b-synthetic' &&
            m.newClientLabel === 'Tab B Chromium',
        ),
      ).toBe(true);

      const openCountAfterClaim = tabAFactory.getOpenCount();

      const defaultOutputId = receiverRecord.outputs[0]?.id;
      if (defaultOutputId !== undefined) {
        await tabBController.sendCommand({
          type: 'select_output',
          commandSeq: 1,
          outputId: defaultOutputId,
        });
      }

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 300);
      });

      const tabASessionFinal = await readEphemeralSessionState(tabAStorage.session);
      expect(tabASessionFinal.connectionState).toBe('session_claimed');
      expect(tabAFactory.getOpenCount()).toBe(openCountAfterClaim);
      expect(tabBForwarded.some((m) => m.type === 'telemetry_tick')).toBe(true);

      // 5. Chaos: Unexpected WebSocket drop on Tab B -> exponential backoff auto-reconnect resync
      const tabBOpenBeforeDrop = tabBFactory.getOpenCount();
      tabBFactory.dropActiveWireSocket();

      const reconnectDeadline = Date.now() + 1_200;
      while (Date.now() < reconnectDeadline) {
        const s = await readEphemeralSessionState(tabBStorage.session);
        if (tabBFactory.getOpenCount() > tabBOpenBeforeDrop && s.connectionState === 'connected') {
          break;
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
      }
      expect(tabBFactory.getOpenCount()).toBeGreaterThan(tabBOpenBeforeDrop);
      expect((await readEphemeralSessionState(tabBStorage.session)).connectionState).toBe(
        'connected',
      );

      // 6. Chaos: End-to-End Mid-Mix HLS HTTP 403 Refresh (`load_track` -> `mock-mpv` `/seg/0` -> 403
      //    -> WS `refresh_locator_request` -> `MaestroVirtualizerController` -> WS `refresh_locator_response`
      //    -> fresh `.m3u8` + `200 OK` segment delivery + `hlsRefreshCount === 1`)!
      await tabBController.sendCommand({
        type: 'load_track',
        commandSeq: 2,
        ...(defaultOutputId !== undefined ? { preferredOutputId: defaultOutputId } : {}),
        locator: {
          locatorId: 'loc-777-stale',
          track: {
            trackId: '777',
            permalinkUrl: 'https://soundcloud.com/synthetic-dj/long-mix-777',
            title: 'Long DJ Mix (Mid-Stream 403 Refresh)',
            artist: 'Synthetic DJ',
            durationMs: 3_600_000,
          },
          selected: {
            resolveUrl: `${upstreamBaseUrl}/resolve-stale`,
            preset: 'aac_256k',
            protocol: 'hls',
            mimeType: 'audio/mp4; codecs="mp4a.40.2"',
            quality: 'hq',
            bitrateKbps: 256,
            sampleRateHz: 44100,
            initialPlaylistUrl: `${upstreamBaseUrl}/playlist-stale.m3u8`,
          },
          fallbackTranscodings: [],
          auth: {
            clientId: 'cid_e2e_tab_b',
            oauthToken: 'synthetic_test_oauth_never_leak_to_cdn',
            accountTier: 'go_plus',
          },
          startPositionMs: 0,
        },
      });

      const refreshDeadline = Date.now() + 2_000;
      let mpvSegmentLog = '';
      while (Date.now() < refreshDeadline) {
        if (fs.existsSync(daemon.mpvFetchedSegmentLogPath)) {
          mpvSegmentLog = await fsp.readFile(daemon.mpvFetchedSegmentLogPath, 'utf8');
          if (mpvSegmentLog.length > 0) {
            break;
          }
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
      }

      expect(staleSegment403Hits).toBe(1);
      expect(resolveStale403Hits).toBe(1);
      expect(freshSegment200Hits).toBe(1);
      expect(cdnAuthHeaderLeaked).toBe(false);
      expect(mpvSegmentLog).toBe('200:FRESH_GO_PLUS_AAC_256K_SEGMENT_OK');

      // Verify `/api/v1/status` reports `hlsRefreshCount === 1` and `0 dB` `bit_perfect` telemetry!
      const statusRes = await extFetch(`${daemon.baseUrl}${API_V1_STATUS_PATH}`, {
        headers: {
          Authorization: `Bearer ${tokenB}`,
          Accept: 'application/json',
        },
      });
      expect(statusRes.status).toBe(200);
      const parsedStatus = parseStatusResponse(await statusRes.json());
      expect(parsedStatus.ok).toBe(true);
      if (parsedStatus.ok) {
        expect(parsedStatus.value.telemetry.volumeMode).toBe('bit_perfect');
        expect(parsedStatus.value.telemetry.fixedGainDb).toBe(0);
        expect(parsedStatus.value.telemetry.streamInfo?.preset).toBe('aac_256k');
        expect(parsedStatus.value.telemetry.streamInfo?.quality).toBe('hq');
        expect(parsedStatus.value.telemetry.streamInfo?.hlsRefreshCount).toBe(1);
      }
    } finally {
      tabBMaestro.dispose();
      await tabAController.disconnect();
      await tabBController.disconnect();
      await daemon.stop();
      syntheticUpstreamServer.closeAllConnections();
      await new Promise<void>((resolve) => {
        syntheticUpstreamServer.close(() => {
          resolve();
        });
      });
    }
  });

  it('validates offline zero-Homebrew installer checksum enforcement, 0700 state dir, unit rendering, clean uninstall, and bit-for-bit deterministic MV3 ZIP packaging', async () => {
    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sc-pkg-'));
    try {
      const binPath = resolveReceiverBinaryPath();
      const binBytes = await fsp.readFile(binPath);
      const actualBinSha256 = createHash('sha256').update(binBytes).digest('hex');
      const binBasename = path.basename(binPath);

      const installScript = path.join(REPO_ROOT, 'packaging', 'install', 'install.sh');
      const uninstallScript = path.join(REPO_ROOT, 'packaging', 'install', 'uninstall.sh');

      // 1. Tampered SHA256SUMS.txt MUST be rejected with non-zero exit before installing anything
      const tamperedSumsPath = path.join(tmpRoot, 'SHA256SUMS.tampered.txt');
      const tamperedHash = '0'.repeat(64);
      await fsp.writeFile(tamperedSumsPath, `${tamperedHash}  ${binBasename}\n`, 'utf8');

      const rejectedPrefix = path.join(tmpRoot, 'rejected-prefix');
      const rejectedState = path.join(tmpRoot, 'rejected-state');

      let tamperedFailed = false;
      try {
        execFileSync(
          'bash',
          [
            installScript,
            '--bin-source',
            binPath,
            '--checksum-file',
            tamperedSumsPath,
            '--heos-only',
            '--skip-service',
            '--prefix',
            rejectedPrefix,
            '--state-dir',
            rejectedState,
          ],
          { cwd: REPO_ROOT, stdio: 'pipe' },
        );
      } catch {
        tamperedFailed = true;
      }
      expect(tamperedFailed).toBe(true);
      expect(fs.existsSync(path.join(rejectedPrefix, 'bin', 'soundclud-receiver'))).toBe(false);

      // 2. Valid offline `--bin-source` install completes in < 2000 ms with 0700 state dir & valid plist
      const validSumsPath = path.join(tmpRoot, 'SHA256SUMS.valid.txt');
      await fsp.writeFile(validSumsPath, `${actualBinSha256}  ${binBasename}\n`, 'utf8');

      const prefixDir = path.join(tmpRoot, 'prefix');
      const stateDir = path.join(tmpRoot, 'state');

      const installT0 = performance.now();
      execFileSync(
        'bash',
        [
          installScript,
          '--bin-source',
          binPath,
          '--checksum-file',
          validSumsPath,
          '--heos-only',
          '--skip-service',
          '--prefix',
          prefixDir,
          '--state-dir',
          stateDir,
        ],
        { cwd: REPO_ROOT, stdio: 'pipe' },
      );
      const installElapsedMs = performance.now() - installT0;
      expect(installElapsedMs).toBeLessThan(2_000);

      const installedBin = path.join(prefixDir, 'bin', 'soundclud-receiver');
      expect(fs.existsSync(installedBin)).toBe(true);

      const stateStat = await fsp.stat(stateDir);
      if (process.platform !== 'win32') {
        expect(stateStat.mode & 0o777).toBe(0o700);
      }

      if (process.platform === 'darwin') {
        const renderedPlist = path.join(
          prefixDir,
          'share',
          'soundclud',
          'io.soundclud.receiver.plist',
        );
        expect(fs.existsSync(renderedPlist)).toBe(true);
        execFileSync('plutil', ['-lint', '-s', renderedPlist], { stdio: 'pipe' });
      }

      // Also verify Linux systemd template rendering via `--target-os linux`
      const linuxPrefixDir = path.join(tmpRoot, 'linux-prefix');
      const linuxStateDir = path.join(tmpRoot, 'linux-state');
      if (process.arch === 'x64' || process.arch === 'arm64') {
        execFileSync(
          'bash',
          [
            installScript,
            '--bin-source',
            binPath,
            '--checksum-file',
            validSumsPath,
            '--heos-only',
            '--skip-service',
            '--target-os',
            'linux',
            '--prefix',
            linuxPrefixDir,
            '--state-dir',
            linuxStateDir,
          ],
          { cwd: REPO_ROOT, stdio: 'pipe' },
        );
        const systemdUnitPath = path.join(
          linuxPrefixDir,
          'share',
          'soundclud',
          'soundclud-receiver.service',
        );
        const systemdUnitText = await fsp.readFile(systemdUnitPath, 'utf8');
        expect(systemdUnitText).toContain('[Unit]');
        expect(systemdUnitText).toContain('[Service]');
        expect(systemdUnitText).toContain('ExecStart=');
      }

      // 3. Clean offline `uninstall.sh --purge-state --skip-service` removes binaries, templates & stateDir
      execFileSync(
        'bash',
        [
          uninstallScript,
          '--prefix',
          prefixDir,
          '--state-dir',
          stateDir,
          '--skip-service',
          '--purge-state',
        ],
        { cwd: REPO_ROOT, stdio: 'pipe' },
      );
      expect(fs.existsSync(installedBin)).toBe(false);
      expect(fs.existsSync(path.join(prefixDir, 'share', 'soundclud'))).toBe(false);
      expect(fs.existsSync(stateDir)).toBe(false);

      // 4. Bit-for-bit deterministic MV3 extension packaging (`packageExtensionDirectory`)
      const extSourceDir = path.join(REPO_ROOT, 'packages', 'extension', 'dist');
      const outDirA = path.join(tmpRoot, 'ext-out-a');
      const outDirB = path.join(tmpRoot, 'ext-out-b');

      const pkgA = packageExtensionDirectory({ sourceDir: extSourceDir, outDir: outDirA });
      const pkgB = packageExtensionDirectory({ sourceDir: extSourceDir, outDir: outDirB });

      expect(pkgA.fileCount).toBeGreaterThanOrEqual(8);
      expect(pkgA.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(pkgA.sha256).toBe(pkgB.sha256);
      expect(pkgA.byteLength).toBe(pkgB.byteLength);

      const zipBufA = await fsp.readFile(pkgA.zipPath);
      const zipBufB = await fsp.readFile(pkgB.zipPath);
      expect(zipBufA.equals(zipBufB)).toBe(true);
    } finally {
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
