import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
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

  it('validates XML 1.0 plist comments, Info.plist Monterey/ATS/Bonjour keys, and install.sh --keep-awake receipt, plist, and run-receiver.sh caffeinate behavior', async () => {
    const findIllegalXmlComments = (xmlText: string): string[] => {
      const badComments: string[] = [];
      for (const match of xmlText.matchAll(/<!--([\s\S]*?)-->/g)) {
        const body = match[1] ?? '';
        if (body.includes('--') || body.endsWith('-')) {
          badComments.push(body);
        }
      }
      return badComments;
    };

    expect(findIllegalXmlComments('<!-- illegal -- sequence -->')).toHaveLength(1);
    expect(findIllegalXmlComments('<!-- illegal trailing hyphen --->')).toHaveLength(1);

    const launchdPlistTmplPath = path.join(
      REPO_ROOT,
      'packaging',
      'launchd',
      'io.soundclud.receiver.plist.tmpl',
    );
    const macAppInfoPlistTmplPath = path.join(
      REPO_ROOT,
      'packaging',
      'macos-app',
      'Info.plist.tmpl',
    );

    const launchdPlistTmpl = await fsp.readFile(launchdPlistTmplPath, 'utf8');
    const macAppInfoPlistTmpl = await fsp.readFile(macAppInfoPlistTmplPath, 'utf8');

    expect(findIllegalXmlComments(launchdPlistTmpl)).toEqual([]);
    expect(findIllegalXmlComments(macAppInfoPlistTmpl)).toEqual([]);

    expect(macAppInfoPlistTmpl).toMatch(
      /<key>LSMinimumSystemVersion<\/key>\s*<string>11\.0<\/string>/,
    );
    expect(macAppInfoPlistTmpl).toMatch(
      /<key>NSLocalNetworkUsageDescription<\/key>\s*<string>[^<]+<\/string>/,
    );
    expect(macAppInfoPlistTmpl).toMatch(
      /<key>NSBonjourServices<\/key>\s*<array>[\s\S]*?<string>_heos-audio\._tcp<\/string>[\s\S]*?<string>_soundclud\._tcp<\/string>[\s\S]*?<\/array>/,
    );
    expect(macAppInfoPlistTmpl).toMatch(
      /<key>NSAppTransportSecurity<\/key>[\s\S]*?<key>NSAllowsLocalNetworking<\/key>\s*<true\s*\/>/,
    );

    if (process.arch !== 'x64' && process.arch !== 'arm64') {
      return;
    }

    const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sc-keepawake-'));
    try {
      const binPath = resolveReceiverBinaryPath();
      const installScript = path.join(REPO_ROOT, 'packaging', 'install', 'install.sh');

      // 1. Default install (without --keep-awake): KEEP_AWAKE defaults to 0
      const defaultPrefix = path.join(tmpRoot, 'default-prefix');
      const defaultState = path.join(tmpRoot, 'default-state');
      execFileSync(
        'bash',
        [
          installScript,
          '--bin-source',
          binPath,
          '--heos-only',
          '--skip-service',
          '--target-os',
          'darwin',
          '--prefix',
          defaultPrefix,
          '--state-dir',
          defaultState,
        ],
        { cwd: REPO_ROOT, stdio: 'pipe' },
      );

      const defaultReceipt = await fsp.readFile(
        path.join(defaultPrefix, 'share', 'soundclud', 'install-receipt.env'),
        'utf8',
      );
      expect(defaultReceipt).toMatch(/^HEOS_ONLY=1$/m);
      expect(defaultReceipt).toMatch(/^KEEP_AWAKE=0$/m);

      const defaultPlistPath = path.join(
        defaultPrefix,
        'share',
        'soundclud',
        'io.soundclud.receiver.plist',
      );
      const defaultPlistText = await fsp.readFile(defaultPlistPath, 'utf8');
      expect(defaultPlistText).toMatch(
        /<key>SOUNDCLUD_KEEP_AWAKE<\/key>\s*<string>0<\/string>/,
      );
      if (process.platform === 'darwin') {
        execFileSync('plutil', ['-lint', '-s', defaultPlistPath], { stdio: 'pipe' });
      }

      // 2. --keep-awake install: renders SOUNDCLUD_KEEP_AWAKE=1 and records KEEP_AWAKE=1
      const awakePrefix = path.join(tmpRoot, 'awake-prefix');
      const awakeState = path.join(tmpRoot, 'awake-state');
      execFileSync(
        'bash',
        [
          installScript,
          '--bin-source',
          binPath,
          '--keep-awake',
          '--heos-only',
          '--skip-service',
          '--target-os',
          'darwin',
          '--prefix',
          awakePrefix,
          '--state-dir',
          awakeState,
        ],
        { cwd: REPO_ROOT, stdio: 'pipe' },
      );

      const awakeReceipt = await fsp.readFile(
        path.join(awakePrefix, 'share', 'soundclud', 'install-receipt.env'),
        'utf8',
      );
      expect(awakeReceipt).toMatch(/^HEOS_ONLY=1$/m);
      expect(awakeReceipt).toMatch(/^KEEP_AWAKE=1$/m);

      const awakePlistPath = path.join(
        awakePrefix,
        'share',
        'soundclud',
        'io.soundclud.receiver.plist',
      );
      const awakePlistText = await fsp.readFile(awakePlistPath, 'utf8');
      expect(awakePlistText).toMatch(
        /<key>SOUNDCLUD_KEEP_AWAKE<\/key>\s*<string>1<\/string>/,
      );
      expect(awakePlistText).toMatch(
        /<key>SOUNDCLUD_HEOS_ONLY<\/key>\s*<string>1<\/string>/,
      );
      if (process.platform === 'darwin') {
        execFileSync('plutil', ['-lint', '-s', awakePlistPath], { stdio: 'pipe' });

        // 3. Verify run-receiver.sh spawns `caffeinate -i -s -w <exec_pid>` only when SOUNDCLUD_KEEP_AWAKE=1
        const mockBinDir = path.join(tmpRoot, 'mock-bin');
        await fsp.mkdir(mockBinDir, { recursive: true });
        const wrapperCopy = path.join(mockBinDir, 'run-receiver.sh');
        await fsp.copyFile(
          path.join(REPO_ROOT, 'packaging', 'launchd', 'run-receiver.sh'),
          wrapperCopy,
        );
        await fsp.chmod(wrapperCopy, 0o755);

        const caffLogPath = path.join(tmpRoot, 'caffeinate-args.txt');
        const receiverPidPath = path.join(tmpRoot, 'receiver-pid.txt');

        await fsp.writeFile(
          path.join(mockBinDir, 'caffeinate'),
          `#!/bin/bash\nprintf '%s' "$*" > "${caffLogPath}"\n`,
          { encoding: 'utf8', mode: 0o755 },
        );
        await fsp.chmod(path.join(mockBinDir, 'caffeinate'), 0o755);
        await fsp.writeFile(
          path.join(mockBinDir, 'soundclud-receiver'),
          [
            '#!/bin/bash',
            `printf '%s' "$$" > "${receiverPidPath}"`,
            'if [ "${SC_WAIT_FOR_CAFF:-0}" = "1" ]; then',
            '  for _ in $(seq 1 100); do',
            `    [ -s "${caffLogPath}" ] && break`,
            '    sleep 0.02',
            '  done',
            'else',
            '  sleep 0.05',
            'fi',
            '',
          ].join('\n'),
          { encoding: 'utf8', mode: 0o755 },
        );
        await fsp.chmod(path.join(mockBinDir, 'soundclud-receiver'), 0o755);

        execFileSync('bash', [wrapperCopy], {
          env: {
            ...process.env,
            SOUNDCLUD_HEOS_ONLY: '1',
            SOUNDCLUD_KEEP_AWAKE: '0',
            SC_WAIT_FOR_CAFF: '0',
          },
          stdio: 'pipe',
        });
        expect(fs.existsSync(caffLogPath)).toBe(false);

        execFileSync('bash', [wrapperCopy], {
          env: {
            ...process.env,
            SOUNDCLUD_HEOS_ONLY: '1',
            SOUNDCLUD_KEEP_AWAKE: '1',
            SC_WAIT_FOR_CAFF: '1',
          },
          stdio: 'pipe',
        });
        const recordedPid = (await fsp.readFile(receiverPidPath, 'utf8')).trim();
        const recordedCaffArgs = (await fsp.readFile(caffLogPath, 'utf8')).trim();
        expect(recordedPid).toMatch(/^\d+$/);
        expect(recordedCaffArgs).toBe(`-i -s -w ${recordedPid}`);
      }
    } finally {
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it(
    'builds and verifies Universal 2 SoundClud.app offline via scripts/build-macos-dmg.sh --app-only',
    async () => {
      if (process.platform !== 'darwin') {
        return;
      }

      const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sc-macos-app-'));
      try {
        const stubSourcePath = path.join(tmpRoot, 'receiver-stub.c');
        const arm64StubPath = path.join(tmpRoot, 'soundclud-receiver-arm64');
        const x86StubPath = path.join(tmpRoot, 'soundclud-receiver-x86_64');
        const appOutputDir = path.join(tmpRoot, 'app-out');

        await fsp.writeFile(stubSourcePath, 'int main(void) { return 0; }\n', 'utf8');

        const clangT0 = performance.now();
        execFileSync(
          'clang',
          ['-xc', '-target', 'arm64-apple-macos11.0', stubSourcePath, '-o', arm64StubPath],
          { stdio: 'pipe' },
        );
        execFileSync(
          'clang',
          ['-xc', '-target', 'x86_64-apple-macos11.0', stubSourcePath, '-o', x86StubPath],
          { stdio: 'pipe' },
        );
        const clangElapsedMs = performance.now() - clangT0;
        expect(clangElapsedMs).toBeLessThan(2_000);

        const buildScriptPath = path.join(REPO_ROOT, 'scripts', 'build-macos-dmg.sh');
        const extDistDir = path.join(REPO_ROOT, 'packages', 'extension', 'dist');

        const buildT0 = performance.now();
        execFileSync(
          'bash',
          [
            buildScriptPath,
            '--app-only',
            '--version',
            '0.1.0',
            '--arm64-bin',
            arm64StubPath,
            '--x86_64-bin',
            x86StubPath,
            '--extension-dir',
            extDistDir,
            '--output-dir',
            appOutputDir,
          ],
          { cwd: REPO_ROOT, stdio: 'pipe' },
        );
        const buildElapsedMs = performance.now() - buildT0;
        expect(buildElapsedMs).toBeLessThan(20_000);

        const appBundlePath = path.join(appOutputDir, 'SoundClud.app');
        const guiExecutablePath = path.join(appBundlePath, 'Contents', 'MacOS', 'SoundClud');
        const receiverExecutablePath = path.join(
          appBundlePath,
          'Contents',
          'MacOS',
          'soundclud-receiver',
        );
        const icnsPath = path.join(appBundlePath, 'Contents', 'Resources', 'AppIcon.icns');
        const bundledManifestPath = path.join(
          appBundlePath,
          'Contents',
          'Resources',
          'chrome-extension',
          'manifest.json',
        );
        const bundledInstallScriptPath = path.join(
          appBundlePath,
          'Contents',
          'Resources',
          'packaging',
          'install',
          'install.sh',
        );
        const infoPlistPath = path.join(appBundlePath, 'Contents', 'Info.plist');

        expect(fs.existsSync(appBundlePath)).toBe(true);

        const guiArchs = execFileSync('lipo', ['-archs', guiExecutablePath], {
          encoding: 'utf8',
        })
          .trim()
          .split(/\s+/);
        expect(guiArchs).toContain('x86_64');
        expect(guiArchs).toContain('arm64');

        const receiverArchs = execFileSync('lipo', ['-archs', receiverExecutablePath], {
          encoding: 'utf8',
        })
          .trim()
          .split(/\s+/);
        expect(receiverArchs).toContain('x86_64');
        expect(receiverArchs).toContain('arm64');

        const icnsBuffer = await fsp.readFile(icnsPath);
        expect(icnsBuffer.byteLength).toBeGreaterThan(1024);
        expect(icnsBuffer.subarray(0, 4).toString('ascii')).toBe('icns');

        expect(fs.existsSync(bundledManifestPath)).toBe(true);
        fs.accessSync(bundledInstallScriptPath, fs.constants.X_OK);

        execFileSync('plutil', ['-lint', '-s', infoPlistPath], { stdio: 'pipe' });
        execFileSync('codesign', ['--verify', '--deep', '--strict', appBundlePath], {
          stdio: 'pipe',
        });
      } finally {
        await fsp.rm(tmpRoot, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    'decodes live Rust /api/v1/discover wire JSON via macOS AppKit Models.swift without typeMismatch',
    async () => {
      if (process.platform !== 'darwin') {
        return;
      }

      const daemon = await startEphemeralReceiverDaemon();
      const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sc-swift-discover-'));
      try {
        // Native macOS URLSession omits Origin header on 127.0.0.1:9876/api/v1/discover
        const discoverRes = await sendRawLoopbackHttpRequest({
          port: daemon.port,
          method: 'GET',
          requestPath: API_V1_DISCOVER_PATH,
          headers: {
            Host: `127.0.0.1:${String(daemon.port)}`,
            Accept: 'application/json',
          },
        });
        expect(discoverRes.statusCode).toBe(200);

        const discoverJsonPath = path.join(tmpRoot, 'discover.json');
        const swiftHarnessPath = path.join(tmpRoot, 'main.swift');
        const compiledHarnessPath = path.join(tmpRoot, 'verify-models-bin');
        await fsp.writeFile(discoverJsonPath, discoverRes.bodyText, 'utf8');

        const swiftHarnessSource = [
          'import Foundation',
          'let jsonPath = CommandLine.arguments[1]',
          'let rawData = try Data(contentsOf: URL(fileURLWithPath: jsonPath))',
          'let decoded = try JSONDecoder().decode(DiscoverResponse.self, from: rawData)',
          'print("\\(decoded.receiverName)|\\(decoded.outputs.count)")',
          '',
        ].join('\n');
        await fsp.writeFile(swiftHarnessPath, swiftHarnessSource, 'utf8');

        const swiftArch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
        const modelsSwiftPath = path.join(
          REPO_ROOT,
          'packaging',
          'macos-app',
          'Sources',
          'Models.swift',
        );
        execFileSync(
          'swiftc',
          [
            '-target',
            `${swiftArch}-apple-macosx11.0`,
            modelsSwiftPath,
            swiftHarnessPath,
            '-o',
            compiledHarnessPath,
          ],
          { stdio: 'pipe' },
        );

        const decodedSummary = execFileSync(compiledHarnessPath, [discoverJsonPath], {
          encoding: 'utf8',
          stdio: 'pipe',
        }).trim();
        const [decodedName, decodedCountStr] = decodedSummary.split('|');
        expect(decodedName).toBe('Lab Optical Receiver');
        expect(Number(decodedCountStr)).toBeGreaterThanOrEqual(1);
      } finally {
        await daemon.stop();
        await fsp.rm(tmpRoot, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    'verifies SetupWindowController.swift AppKit Auto Layout geometry, non-overlapping card intervals, and zero ambiguous layouts headlessly',
    async () => {
      if (process.platform !== 'darwin') {
        return;
      }

      interface LayoutRectTelemetry {
        readonly minX: number;
        readonly maxX: number;
        readonly minY: number;
        readonly maxY: number;
        readonly width: number;
        readonly height: number;
      }

      interface SetupWindowLayoutTelemetry {
        readonly contentWidth: number;
        readonly contentHeight: number;
        readonly minWindowWidth: number;
        readonly minWindowHeight: number;
        readonly isDocumentFlipped: boolean;
        readonly statusIconMinX: number;
        readonly sections: readonly LayoutRectTelemetry[];
        readonly outputRows: readonly LayoutRectTelemetry[];
        readonly visitedViewCount: number;
        readonly sawDocumentView: boolean;
        readonly ambiguousViews: readonly string[];
        readonly horizontalOverflows: readonly string[];
      }

      const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sc-swift-layout-'));
      try {
        const isolatedHomeDir = path.join(tmpRoot, 'isolated-home');
        await fsp.mkdir(isolatedHomeDir, { recursive: true, mode: 0o700 });

        const swiftHarnessPath = path.join(tmpRoot, 'main.swift');
        const compiledHarnessPath = path.join(tmpRoot, 'verify-setup-window-layout');

        const swiftHarnessSource = [
          'import AppKit',
          'import Foundation',
          '',
          'let app = NSApplication.shared',
          'app.setActivationPolicy(.accessory)',
          '',
          'let manager = ReceiverServiceManager()',
          'let controller = SetupWindowController(serviceManager: manager) { _ in }',
          '',
          'guard let win = controller.window, let contentView = win.contentView else {',
          '    fputs("Missing window or contentView\\n", stderr)',
          '    exit(1)',
          '}',
          '',
          'let syntheticDiscoverPayload: [String: Any] = [',
          '    "protocolVersion": "1.0",',
          '    "receiverId": "rec-synthetic-layout-01",',
          '    "receiverName": "Synthetic Hi-Fi Receiver",',
          '    "platform": "macos",',
          '    "arch": "arm64",',
          '    "requiresPairing": true,',
          '    "outputs": [',
          '        [',
          '            "id": "heos_synthetic_amp",',
          '            "kind": "heos_upnp",',
          '            "name": "Synthetic Reference Amp",',
          '            "model": "Reference Network Amp",',
          '            "transport": "heos_lan_wav",',
          '            "isRecommendedDefault": true,',
          '            "isAvailable": true,',
          '            "standbyState": "off",',
          '            "capabilities": [',
          '                "bitPerfect": true,',
          '                "fixedGainDb": 0.0,',
          '                "targetSampleRateHz": 44100,',
          '                "targetBitDepth": 24,',
          '                "autoWakeFromStandby": true,',
          '                "displaysTrackMetadataOnDevice": true,',
          '                "seekDebounceMs": 150,',
          '            ],',
          '        ],',
          '        [',
          '            "id": "coreaudio_spdf",',
          '            "kind": "local_mpv",',
          '            "name": "Optical Digital-out (S/PDIF)",',
          '            "model": "Built-in Digital Output",',
          '            "transport": "optical_toslink",',
          '            "isRecommendedDefault": false,',
          '            "isAvailable": true,',
          '            "capabilities": [',
          '                "bitPerfect": true,',
          '                "fixedGainDb": 0.0,',
          '                "targetSampleRateHz": 44100,',
          '                "targetBitDepth": 24,',
          '                "autoWakeFromStandby": false,',
          '                "displaysTrackMetadataOnDevice": false,',
          '                "seekDebounceMs": 60,',
          '            ],',
          '        ],',
          '    ],',
          ']',
          '',
          'let discoverData = try JSONSerialization.data(withJSONObject: syntheticDiscoverPayload)',
          'let discover = try JSONDecoder().decode(DiscoverResponse.self, from: discoverData)',
          'let snapshot = ServiceSnapshot(',
          '    receipt: InstallReceiptState(isInstalled: true, hasReceipt: true, heosOnly: false, keepAwake: true),',
          '    isRunning: true,',
          '    discover: discover,',
          '    lastCheckedAt: Date()',
          ')',
          '',
          'controller.applySnapshot(snapshot, forceSyncControls: true)',
          'win.contentView?.layoutSubtreeIfNeeded()',
          '',
          'guard let scrollView = contentView.subviews.compactMap({ $0 as? NSScrollView }).first,',
          '      let docView = scrollView.documentView,',
          '      let rootStack = docView.subviews.compactMap({ $0 as? NSStackView }).first else {',
          '    fputs("Missing NSScrollView, documentView, or rootStack\\n", stderr)',
          '    exit(1)',
          '}',
          '',
          'func encodeRect(view: NSView, in referenceView: NSView) -> [String: Double] {',
          '    let rect = referenceView.convert(view.bounds, from: view)',
          '    return [',
          '        "minX": Double(rect.minX),',
          '        "maxX": Double(rect.maxX),',
          '        "minY": Double(rect.minY),',
          '        "maxY": Double(rect.maxY),',
          '        "width": Double(view.frame.width),',
          '        "height": Double(view.frame.height),',
          '    ]',
          '}',
          '',
          'let sections = rootStack.arrangedSubviews.map { encodeRect(view: $0, in: docView) }',
          '',
          'var statusIconMinX: Double = -1.0',
          'if rootStack.arrangedSubviews.count > 1 {',
          '    let statusCard = rootStack.arrangedSubviews[1]',
          '    if let cardStack = statusCard.subviews.compactMap({ $0 as? NSStackView }).first,',
          '       let badgeRow = cardStack.arrangedSubviews.compactMap({ $0 as? NSStackView }).first,',
          '       let statusIcon = badgeRow.arrangedSubviews.compactMap({ $0 as? NSImageView }).first {',
          '        statusIconMinX = Double(docView.convert(statusIcon.bounds, from: statusIcon).minX)',
          '    }',
          '}',
          '',
          'var outputRows: [[String: Double]] = []',
          'if rootStack.arrangedSubviews.count > 3 {',
          '    let outputsCard = rootStack.arrangedSubviews[3]',
          '    if let cardStack = outputsCard.subviews.compactMap({ $0 as? NSStackView }).first,',
          '       let innerOutputsStack = cardStack.arrangedSubviews.compactMap({ $0 as? NSStackView }).first {',
          '        outputRows = innerOutputsStack.arrangedSubviews.map { encodeRect(view: $0, in: docView) }',
          '    }',
          '}',
          '',
          'var visitedViewCount = 0',
          'var sawDocumentView = false',
          'var ambiguousViews: [String] = []',
          'var horizontalOverflows: [String] = []',
          '',
          'func walkHierarchy(_ view: NSView, path: String, insideDocument: Bool) {',
          '    visitedViewCount += 1',
          '    let nowInsideDoc = insideDocument || (view === docView)',
          '    if view === docView {',
          '        sawDocumentView = true',
          '    }',
          '    if view.hasAmbiguousLayout {',
          '        ambiguousViews.append("\\(path) frame=\\(view.frame)")',
          '    }',
          '    if nowInsideDoc && !view.isHidden {',
          '        let rectInDoc = docView.convert(view.bounds, from: view)',
          '        if rectInDoc.minX < -4.0 || rectInDoc.maxX > docView.bounds.width + 4.0 {',
          '            horizontalOverflows.append("\\(path) rectInDoc=\\(rectInDoc) docWidth=\\(docView.bounds.width)")',
          '        }',
          '    }',
          '    for (idx, subview) in view.subviews.enumerated() {',
          '        walkHierarchy(subview, path: "\\(path)/\\(type(of: subview))[\\(idx)]", insideDocument: nowInsideDoc)',
          '    }',
          '}',
          '',
          'walkHierarchy(contentView, path: "\\(type(of: contentView))", insideDocument: false)',
          '',
          'let report: [String: Any] = [',
          '    "contentWidth": Double(contentView.frame.size.width),',
          '    "contentHeight": Double(contentView.frame.size.height),',
          '    "minWindowWidth": Double(win.minSize.width),',
          '    "minWindowHeight": Double(win.minSize.height),',
          '    "isDocumentFlipped": docView.isFlipped,',
          '    "statusIconMinX": statusIconMinX,',
          '    "sections": sections,',
          '    "outputRows": outputRows,',
          '    "visitedViewCount": visitedViewCount,',
          '    "sawDocumentView": sawDocumentView,',
          '    "ambiguousViews": ambiguousViews,',
          '    "horizontalOverflows": horizontalOverflows,',
          ']',
          'let reportData = try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys])',
          'print(String(data: reportData, encoding: .utf8)!)',
          '',
        ].join('\n');
        await fsp.writeFile(swiftHarnessPath, swiftHarnessSource, 'utf8');

        const swiftArch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
        const macSourcesDir = path.join(REPO_ROOT, 'packaging', 'macos-app', 'Sources');
        const swiftSourceFiles = [
          'Models.swift',
          'ReceiverServiceManager.swift',
          'RelocationHelper.swift',
          'SetupWindowController.swift',
        ].map((fileName) => path.join(macSourcesDir, fileName));

        execFileSync(
          'swiftc',
          [
            '-target',
            `${swiftArch}-apple-macosx11.0`,
            ...swiftSourceFiles,
            swiftHarnessPath,
            '-o',
            compiledHarnessPath,
          ],
          { stdio: 'pipe' },
        );

        const rawTelemetry = execFileSync(compiledHarnessPath, [], {
          encoding: 'utf8',
          env: {
            ...process.env,
            HOME: isolatedHomeDir,
          },
          stdio: 'pipe',
        }).trim();

        const report = JSON.parse(rawTelemetry) as SetupWindowLayoutTelemetry;

        // 1. Window contentView frame size equals (720, 760) (>= 660 × 560, never collapsed)
        expect(report.contentWidth).toBe(720);
        expect(report.contentHeight).toBe(760);
        expect(report.contentWidth).toBeGreaterThanOrEqual(660);
        expect(report.contentHeight).toBeGreaterThanOrEqual(560);
        expect(report.minWindowWidth).toBeGreaterThanOrEqual(660);
        expect(report.minWindowHeight).toBeGreaterThanOrEqual(560);
        expect(report.isDocumentFlipped).toBe(true);
        expect(report.statusIconMinX).toBe(38);

        // 2. All 5 rootStack.arrangedSubviews have height >= 40, width >= 600, and monotonic non-overlapping [minY, maxY]
        expect(report.sections).toHaveLength(5);
        for (let idx = 0; idx < report.sections.length; idx += 1) {
          const section = report.sections[idx];
          expect(section).toBeDefined();
          if (section === undefined) {
            continue;
          }
          expect(section.height).toBeGreaterThanOrEqual(40);
          expect(section.width).toBeGreaterThanOrEqual(600);
          expect(section.maxY).toBeGreaterThan(section.minY);

          if (idx > 0) {
            const prev = report.sections[idx - 1];
            expect(prev).toBeDefined();
            if (prev !== undefined) {
              expect(prev.maxY).toBeLessThan(section.minY);
            }
          }
        }

        // Verify both synthetic outputs (HEOS + Optical) rendered non-overlapping rows inside Detected Hi-Fi Outputs
        expect(report.outputRows).toHaveLength(2);
        const firstOutputRow = report.outputRows[0];
        const secondOutputRow = report.outputRows[1];
        expect(firstOutputRow).toBeDefined();
        expect(secondOutputRow).toBeDefined();
        if (firstOutputRow !== undefined && secondOutputRow !== undefined) {
          expect(firstOutputRow.height).toBeGreaterThanOrEqual(28);
          expect(secondOutputRow.height).toBeGreaterThanOrEqual(28);
          expect(firstOutputRow.width).toBeGreaterThanOrEqual(560);
          expect(secondOutputRow.width).toBeGreaterThanOrEqual(560);
          expect(firstOutputRow.maxY).toBeLessThan(secondOutputRow.minY);
        }

        // 3. Recursive walk of every NSView in window.contentView asserts hasAmbiguousLayout == false
        expect(report.sawDocumentView).toBe(true);
        expect(report.visitedViewCount).toBeGreaterThanOrEqual(80);
        expect(report.ambiguousViews).toEqual([]);
        expect(report.horizontalOverflows).toEqual([]);
      } finally {
        await fsp.rm(tmpRoot, { recursive: true, force: true });
      }
    },
    20_000,
  );

  it(
    'adversarially verifies live /heos/{token}/stream.flac RFC 9639 SUBFRAME_VERBATIM 24-bit framing, CRC-8/CRC-16, SEEKTABLE, VORBIS_COMMENT, HTTP 206 byte ranges, macOS CoreAudio afinfo/afconvert, and Host-MCU anti-standby invariants',
    async () => {
      const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sc-heos-flac-qa-'));
      const openTcpSockets = new Set<net.Socket>();
      const trackSockets = (srv: net.Server): void => {
        srv.on('connection', (sock) => {
          openTcpSockets.add(sock);
          sock.once('close', () => {
            openTcpSockets.delete(sock);
          });
        });
      };

      // 1. Mock Host-MCU (:23 CR-framed) starting in PWSTANDBY + SITV + SLPOFF
      const mcuCommands: string[] = [];
      let mcuPoweredOn = false;
      let mcuNetSelected = false;
      let forceRemoteStandby = false;

      const mcuServer = net.createServer((sock) => {
        let rxBuf = '';
        sock.on('data', (chunk: Buffer) => {
          rxBuf += chunk.toString('utf8');
          let crIdx: number;
          while ((crIdx = rxBuf.indexOf('\r')) !== -1) {
            const cmd = rxBuf.slice(0, crIdx).trim();
            rxBuf = rxBuf.slice(crIdx + 1);
            if (cmd.length === 0) {
              continue;
            }
            mcuCommands.push(cmd);
            if (cmd === 'PW?') {
              sock.write(forceRemoteStandby || !mcuPoweredOn ? 'PWSTANDBY\r' : 'PWON\r');
            } else if (cmd === 'PWON') {
              mcuPoweredOn = true;
              sock.write('PWON\r');
            } else if (cmd === 'SI?') {
              sock.write(mcuNetSelected ? 'SINET\r' : 'SITV\r');
            } else if (cmd === 'SINET') {
              mcuNetSelected = true;
              sock.write('SINET\r');
            } else if (cmd === 'SLP?' || cmd === 'SLPOFF') {
              sock.write('SLPOFF\r');
            }
          }
        });
      });
      trackSockets(mcuServer);

      // 2. Mock HEOS CLI (:1255 CRLF JSON) simulating async "command under process" + pid 99
      const cliCommands: string[] = [];
      const cliServer = net.createServer((sock) => {
        let rxBuf = '';
        sock.on('data', (chunk: Buffer) => {
          rxBuf += chunk.toString('utf8');
          let nlIdx: number;
          while ((nlIdx = rxBuf.indexOf('\n')) !== -1) {
            const line = rxBuf.slice(0, nlIdx).trim();
            rxBuf = rxBuf.slice(nlIdx + 1);
            if (line.length === 0) {
              continue;
            }
            cliCommands.push(line);
            if (line.includes('get_players')) {
              const underProc = JSON.stringify({
                heos: {
                  command: 'player/get_players',
                  result: 'success',
                  message: 'command under process',
                },
              });
              const ready = JSON.stringify({
                heos: { command: 'player/get_players', result: 'success' },
                payload: mcuPoweredOn
                  ? [
                      {
                        name: 'Synthetic Reference Amp',
                        pid: 99,
                        model: 'Reference Network Amp',
                        ip: '127.0.0.1',
                      },
                    ]
                  : [],
              });
              sock.write(`${underProc}\r\n${ready}\r\n`);
            } else {
              sock.write('{"heos":{"result":"success"}}\r\n');
            }
          }
        });
      });
      trackSockets(cliServer);

      // 3. Mock HEOS UPnP ACT:1 + AVTransport:1 + RenderingControl:1 trap server
      let actPowerOn = false;
      let setPowerStateOnCalls = 0;
      let renderingControlHits = 0;
      let emptyMetadataViolations = 0;
      const soapActions: string[] = [];
      let capturedStreamUri = '';
      let capturedDidlXml = '';

      const xmlUnescape = (raw: string): string =>
        raw
          .replaceAll('&lt;', '<')
          .replaceAll('&gt;', '>')
          .replaceAll('&quot;', '"')
          .replaceAll('&apos;', "'")
          .replaceAll('&amp;', '&');

      const extractXmlTag = (xml: string, tag: string): string | null => {
        const re = new RegExp(`<(?:[a-zA-Z0-9]+:)?${tag}[^>]*>([\\s\\S]*?)<\\/(?:[a-zA-Z0-9]+:)?${tag}>`);
        const match = re.exec(xml);
        return match?.[1] !== undefined ? xmlUnescape(match[1].trim()) : null;
      };

      const upnpServer = http.createServer((req, res) => {
        const addr = upnpServer.address() as AddressInfo;
        const base = `http://127.0.0.1:${String(addr.port)}`;
        if (req.method === 'GET' && req.url === '/desc.xml') {
          res.writeHead(200, { 'content-type': 'text/xml; charset="utf-8"' });
          res.end(
            `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device>` +
              `<deviceType>urn:schemas-denon-com:device:ACT-Denon:1</deviceType>` +
              `<friendlyName>Synthetic Reference Amp</friendlyName>` +
              `<modelName>Reference Network Amp</modelName>` +
              `<UDN>uuid:synthetic-adversarial-heos-qa</UDN>` +
              `<serviceList>` +
              `<service><serviceType>urn:schemas-denon-com:service:ACT:1</serviceType><controlURL>${base}/ACT</controlURL></service>` +
              `<service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>${base}/AVT</controlURL></service>` +
              `<service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>${base}/RC</controlURL></service>` +
              `</serviceList></device></root>`,
          );
          return;
        }

        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          const soapAction = String(req.headers['soapaction'] ?? '');
          soapActions.push(soapAction);

          if (req.url === '/RC') {
            renderingControlHits += 1;
            res.writeHead(500).end();
            return;
          }
          if (req.url === '/ACT') {
            if (soapAction.includes('SetDevicePowerState') && body.includes('<devicePower>ON</devicePower>')) {
              setPowerStateOnCalls += 1;
              actPowerOn = true;
              res.writeHead(200, { 'content-type': 'text/xml' });
              res.end('<s:Envelope><s:Body><u:SetDevicePowerStateResponse/></s:Body></s:Envelope>');
              return;
            }
            const pwr = actPowerOn ? 'ON' : 'OFF';
            res.writeHead(200, { 'content-type': 'text/xml' });
            res.end(`<s:Envelope><s:Body><devicePower>${pwr}</devicePower></s:Body></s:Envelope>`);
            return;
          }
          if (req.url === '/AVT') {
            if (soapAction.includes('#SetAVTransportURI')) {
              const uri = extractXmlTag(body, 'CurrentURI') ?? '';
              const didl = extractXmlTag(body, 'CurrentURIMetaData') ?? '';
              if (didl.trim().length === 0) {
                emptyMetadataViolations += 1;
              }
              capturedStreamUri = uri;
              capturedDidlXml = didl;
            } else if (soapAction.includes('#GetPositionInfo')) {
              res.writeHead(200, { 'content-type': 'text/xml' });
              res.end(
                `<s:Envelope><s:Body><TrackURI>${capturedStreamUri}</TrackURI><RelTime>00:00:02</RelTime><TrackDuration>00:00:13</TrackDuration></s:Body></s:Envelope>`,
              );
              return;
            } else if (soapAction.includes('#GetTransportInfo')) {
              res.writeHead(200, { 'content-type': 'text/xml' });
              res.end(
                '<s:Envelope><s:Body><CurrentTransportState>PLAYING</CurrentTransportState></s:Body></s:Envelope>',
              );
              return;
            }
            res.writeHead(200, { 'content-type': 'text/xml' });
            res.end('<s:Envelope><s:Body><u:Ok/></s:Body></s:Envelope>');
            return;
          }
          res.writeHead(404).end();
        });
      });
      trackSockets(upnpServer);

      // 4. Synthetic HLS server serving 13.0s (2 x 6.5s = 573,300 frames -> 140 FLAC blocks > 128 UTF-8 boundary!)
      //    Asymmetric Left (+16384 -> +0x400000 in I24) and Right (-8192 -> -0x200000 in I24) to catch any channel/endian swap.
      const buildStereoWav16 = (sampleRate: number, frames: number, left16: number, right16: number): Buffer => {
        const dataLen = frames * 4;
        const buf = Buffer.allocUnsafe(44 + dataLen);
        buf.write('RIFF', 0, 'ascii');
        buf.writeUInt32LE(36 + dataLen, 4);
        buf.write('WAVEfmt ', 8, 'ascii');
        buf.writeUInt32LE(16, 16);
        buf.writeUInt16LE(1, 20);
        buf.writeUInt16LE(2, 22);
        buf.writeUInt32LE(sampleRate, 24);
        buf.writeUInt32LE(sampleRate * 4, 28);
        buf.writeUInt16LE(4, 32);
        buf.writeUInt16LE(16, 34);
        buf.write('data', 36, 'ascii');
        buf.writeUInt32LE(dataLen, 40);
        for (let i = 0; i < frames; i += 1) {
          const off = 44 + i * 4;
          buf.writeInt16LE(left16, off);
          buf.writeInt16LE(right16, off + 2);
        }
        return buf;
      };

      const segFrames = 286_650; // 6.5s * 44,100 Hz
      const wavSegBuf = buildStereoWav16(44_100, segFrames, 16_384, -8_192);

      const hlsServer = http.createServer((req, res) => {
        const addr = hlsServer.address() as AddressInfo;
        const origin = `http://127.0.0.1:${String(addr.port)}`;
        if (req.url === '/playlist.m3u8') {
          res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
          res.end(
            `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:7\n` +
              `#EXTINF:6.500000,\n${origin}/seg0.wav\n` +
              `#EXTINF:6.500000,\n${origin}/seg1.wav\n` +
              `#EXT-X-ENDLIST\n`,
          );
          return;
        }
        if (req.url === '/seg0.wav' || req.url === '/seg1.wav') {
          res.writeHead(200, { 'content-type': 'audio/wav' });
          res.end(wavSegBuf);
          return;
        }
        res.writeHead(404).end();
      });
      trackSockets(hlsServer);

      await Promise.all([
        new Promise<void>((r) => mcuServer.listen(0, '127.0.0.1', () => r())),
        new Promise<void>((r) => cliServer.listen(0, '127.0.0.1', () => r())),
        new Promise<void>((r) => upnpServer.listen(0, '127.0.0.1', () => r())),
        new Promise<void>((r) => hlsServer.listen(0, '127.0.0.1', () => r())),
      ]);

      const mcuPort = (mcuServer.address() as AddressInfo).port;
      const cliPort = (cliServer.address() as AddressInfo).port;
      const upnpPort = (upnpServer.address() as AddressInfo).port;
      const hlsPort = (hlsServer.address() as AddressInfo).port;

      // 5. Compile & spawn ephemeral Rust harness linking libsoundclud_receiver with loopback HeosDiscoverySeed
      const homeDir = os.homedir();
      const cargoBin = path.join(homeDir, '.cargo', 'bin');
      const rustEnv = {
        ...process.env,
        PATH: `${cargoBin}${path.delimiter}${process.env['PATH'] ?? ''}`,
      };
      const cargoJson = execFileSync(
        'cargo',
        ['build', '--offline', '--message-format=json', '-p', 'soundclud-receiver', '--lib'],
        { cwd: REPO_ROOT, env: rustEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      );

      let receiverRlib = '';
      let tokioRlib = '';
      for (const line of cargoJson.trim().split(/\r?\n/)) {
        if (!line.startsWith('{')) {
          continue;
        }
        const msg = JSON.parse(line) as {
          readonly reason?: string;
          readonly target?: { readonly name?: string };
          readonly filenames?: readonly string[];
        };
        if (msg.reason === 'compiler-artifact' && Array.isArray(msg.filenames)) {
          const rlib = msg.filenames.find((f) => f.endsWith('.rlib'));
          if (rlib !== undefined && msg.target?.name === 'soundclud_receiver') {
            receiverRlib = rlib;
          } else if (rlib !== undefined && msg.target?.name === 'tokio') {
            tokioRlib = rlib;
          }
        }
      }
      expect(receiverRlib.length).toBeGreaterThan(0);
      expect(tokioRlib.length).toBeGreaterThan(0);

      const harnessRsPath = path.join(tmpRoot, 'heos_qa_daemon.rs');
      const harnessBinPath = path.join(tmpRoot, 'heos_qa_daemon');
      const stateDir = path.join(tmpRoot, 'state');
      await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });

      const harnessSource = [
        'use soundclud_receiver::backends::heos_discovery::HeosDiscoverySeed;',
        'use soundclud_receiver::{ReceiverDaemonConfig, ReceiverServer};',
        'use std::io::Read;',
        'use std::net::{IpAddr, Ipv4Addr, SocketAddr};',
        'use std::path::PathBuf;',
        'use std::time::Duration;',
        'fn main() {',
        '  let args: Vec<String> = std::env::args().collect();',
        '  let state_dir = PathBuf::from(&args[1]);',
        '  let desc_url = args[2].clone();',
        '  let cli_port: u16 = args[3].parse().unwrap();',
        '  let mcu_port: u16 = args[4].parse().unwrap();',
        '  let rt = tokio::runtime::Builder::new_multi_thread().enable_all().build().unwrap();',
        '  rt.block_on(async move {',
        '    let mut cfg = ReceiverDaemonConfig {',
        '      bind_addr: SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),',
        '      state_dir,',
        '      receiver_name: Some("HEOS QA Receiver".to_string()),',
        '      enable_lan_discovery: false,',
        '      ..Default::default()',
        '    };',
        '    cfg.local_mpv.spawn_mpv_process = false;',
        '    cfg.local_mpv.injected_outputs = Some(Vec::new());',
        '    cfg.heos.enable_lan_multicast = false;',
        '    cfg.heos.poll_interval = Duration::from_millis(40);',
        '    cfg.heos.keepalive_interval = Duration::from_millis(140);',
        '    cfg.heos.mcu_port_override = Some(mcu_port);',
        '    cfg.heos.discovery_seeds = vec![HeosDiscoverySeed { description_url: desc_url, cli_port }];',
        '    let srv = ReceiverServer::start(cfg).await.unwrap();',
        '    println!("listen={}", srv.local_addr());',
        '    let _ = tokio::task::spawn_blocking(|| {',
        '      let mut b = [0u8; 1];',
        '      let _ = std::io::stdin().read(&mut b);',
        '    }).await;',
        '    srv.shutdown().await;',
        '  });',
        '}',
        '',
      ].join('\n');
      await fsp.writeFile(harnessRsPath, harnessSource, 'utf8');

      execFileSync(
        'rustc',
        [
          '--edition=2021',
          '-L',
          `dependency=${path.join(REPO_ROOT, 'target', 'debug', 'deps')}`,
          '--extern',
          `soundclud_receiver=${receiverRlib}`,
          '--extern',
          `tokio=${tokioRlib}`,
          harnessRsPath,
          '-o',
          harnessBinPath,
        ],
        { cwd: REPO_ROOT, env: rustEnv, stdio: 'pipe' },
      );

      const receiverChild = spawn(
        harnessBinPath,
        [stateDir, `http://127.0.0.1:${String(upnpPort)}/desc.xml`, String(cliPort), String(mcuPort)],
        { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'] },
      );

      const extFetch = createExtensionOriginFetch(SYNTHETIC_EXTENSION_ORIGIN);
      const wsFactory = createObservedExtensionWebSocketFactory(SYNTHETIC_EXTENSION_ORIGIN);
      const storage = {
        local: createInMemoryStorageArea(),
        session: createInMemoryStorageArea(),
      };
      const controller = new ReceiverWsController({
        storage,
        fetchImpl: extFetch,
        createWebSocket: wsFactory.createWebSocket,
        onStateChanged: () => undefined,
        onForwardToMain: () => undefined,
      });

      try {
        const listenAddr = await new Promise<string>((resolve, reject) => {
          let out = '';
          const timer = setTimeout(() => reject(new Error(`Timeout starting harness:\n${out}`)), 4_000);
          const onData = (c: Buffer): void => {
            out += c.toString('utf8');
            const m = /listen=(127\.0\.0\.1:\d+)/.exec(out);
            if (m?.[1] !== undefined) {
              clearTimeout(timer);
              resolve(m[1]);
            }
          };
          receiverChild.stdout?.on('data', onData);
          receiverChild.stderr?.on('data', onData);
          receiverChild.once('exit', (code) => {
            clearTimeout(timer);
            reject(new Error(`Harness exited early (${String(code)}):\n${out}`));
          });
        });

        const baseUrl = `http://${listenAddr}`;
        const discovered = await discoverReceivers({
          includeDefaultCandidates: false,
          knownEndpoints: [baseUrl],
          fetchImpl: extFetch,
        });
        expect(discovered).toHaveLength(1);
        const rec = discovered[0];
        if (rec === undefined) {
          throw new Error('Expected discovered HEOS receiver');
        }
        const heosOutput = rec.outputs.find((o) => o.kind === 'heos_upnp');
        expect(heosOutput).toBeDefined();
        if (heosOutput === undefined) {
          throw new Error('Expected discovered heos_upnp output');
        }
        expect(heosOutput.id.startsWith('heos_')).toBe(true);

        const pairToken = await ensureTofuPairingToken(baseUrl, rec.receiverId, storage, extFetch);
        await updateDurableLocalConfig(storage.local, (prev) => ({
          ...prev,
          handoffEnabled: true,
          activeEndpointBaseUrl: baseUrl,
          activeReceiverId: rec.receiverId,
          activeReceiverName: rec.receiverName,
        }));
        await updateEphemeralSessionState(storage.session, (prev) => ({
          ...prev,
          discoveredReceivers: discovered,
        }));
        expect(await controller.ensureConnected()).toBe(true);

        // Send load_track with literal `""` title & artist to verify sanitization in both DIDL-Lite and VORBIS_COMMENT
        await controller.sendCommand({
          type: 'load_track',
          commandSeq: 1,
          preferredOutputId: heosOutput.id,
          locator: {
            locatorId: 'loc-flac-qa-140',
            track: {
              trackId: '9090',
              permalinkUrl: 'https://soundcloud.com/synthetic/flac-qa',
              title: '  ""  ',
              artist: '""',
              durationMs: 13_000,
            },
            selected: {
              resolveUrl: `http://127.0.0.1:${String(hlsPort)}/unused`,
              preset: 'aac_256k',
              protocol: 'hls',
              mimeType: 'audio/wav',
              quality: 'hq',
              bitrateKbps: 256,
              sampleRateHz: 44100,
              initialPlaylistUrl: `http://127.0.0.1:${String(hlsPort)}/playlist.m3u8`,
            },
            fallbackTranscodings: [],
            auth: {
              clientId: 'cid_flac_qa',
              accountTier: 'go_plus',
            },
            startPositionMs: 0,
          },
        });

        const loadDeadline = Date.now() + 3_000;
        while (Date.now() < loadDeadline && capturedStreamUri.length === 0) {
          await new Promise<void>((r) => setTimeout(r, 20));
        }
        expect(capturedStreamUri).toContain('/heos/');
        expect(capturedStreamUri).toContain('/stream.flac?start_ms=0');
        expect(emptyMetadataViolations).toBe(0);
        expect(capturedDidlXml).toContain('<dc:title>SoundCloud Track</dc:title>');
        expect(capturedDidlXml).toContain('<dc:creator>SoundCloud</dc:creator>');
        expect(capturedDidlXml).toContain('<upnp:artist>SoundCloud</upnp:artist>');
        expect(capturedDidlXml).toContain('http-get:*:audio/flac:DLNA.ORG_OP=01;');

        // Verify Host-MCU woke FIRST (`PW? -> PWON -> SI? -> SINET -> SLP? -> SLPOFF`), ACT woke once, and CLI bound pid=99
        expect(mcuCommands.slice(0, 6)).toEqual(['PW?', 'PWON', 'SI?', 'SINET', 'SLP?', 'SLPOFF']);
        expect(setPowerStateOnCalls).toBe(1);
        const playAssertDeadline = Date.now() + 1_000;
        while (
          Date.now() < playAssertDeadline &&
          !cliCommands.includes('heos://player/set_play_state?pid=99&state=play')
        ) {
          await new Promise<void>((r) => setTimeout(r, 20));
        }
        expect(cliCommands).toContain('heos://player/set_play_state?pid=99&state=play');

        // Forged capability token must be rejected with HTTP 403
        const forgedRes = await fetch(`${baseUrl}/heos/forged_capability_token/stream.flac`);
        expect(forgedRes.status).toBe(403);

        // HEAD probe on live /heos/{token}/stream.flac
        const headRes = await fetch(capturedStreamUri, { method: 'HEAD' });
        expect(headRes.status).toBe(200);
        expect(headRes.headers.get('content-type')).toBe('audio/flac');
        expect(headRes.headers.get('accept-ranges')).toBe('bytes');
        expect(headRes.headers.get('transfermode.dlna.org')).toBe('Streaming');
        expect(headRes.headers.get('contentfeatures.dlna.org')).toContain('DLNA.ORG_OP=01');
        const expectedTotalBytes = Number(headRes.headers.get('content-length') ?? '0');
        expect(expectedTotalBytes).toBeGreaterThan(3_400_000);
        expect((await headRes.arrayBuffer()).byteLength).toBe(0);

        // Full GET 200 FLAC stream + independent pure-TypeScript RFC 9639 bit/CRC/frame audit
        const fullRes = await fetch(capturedStreamUri);
        expect(fullRes.status).toBe(200);
        const fullFlac = Buffer.from(await fullRes.arrayBuffer());
        expect(fullFlac.length).toBe(expectedTotalBytes);
        expect(fullFlac.subarray(0, 4).toString('ascii')).toBe('fLaC');

        // Parse Metadata Blocks (RFC 9639 §8)
        let cursor = 4;
        let sawStreamInfo = false;
        let sawSeekTable = false;
        let sawVorbisComment = false;
        let totalSamplesFromStreamInfo = 0;
        const seekPoints: { readonly sampleNumber: bigint; readonly streamOffset: number; readonly frameSamples: number }[] = [];
        const vorbisComments: string[] = [];

        while (cursor < fullFlac.length) {
          const hdrByte = fullFlac.readUInt8(cursor);
          const isLast = (hdrByte & 0x80) !== 0;
          const blockType = hdrByte & 0x7f;
          const blockLenBE =
            (fullFlac.readUInt8(cursor + 1) << 16) |
            (fullFlac.readUInt8(cursor + 2) << 8) |
            fullFlac.readUInt8(cursor + 3);
          cursor += 4;
          const blockEnd = cursor + blockLenBE;

          if (blockType === 0) {
            // STREAMINFO (34 bytes)
            expect(blockLenBE).toBe(34);
            const minBlock = fullFlac.readUInt16BE(cursor);
            const maxBlock = fullFlac.readUInt16BE(cursor + 2);
            const minFrameSz =
              (fullFlac.readUInt8(cursor + 4) << 16) |
              (fullFlac.readUInt8(cursor + 5) << 8) |
              fullFlac.readUInt8(cursor + 6);
            const maxFrameSz =
              (fullFlac.readUInt8(cursor + 7) << 16) |
              (fullFlac.readUInt8(cursor + 8) << 8) |
              fullFlac.readUInt8(cursor + 9);
            const packed64 = fullFlac.readBigUInt64BE(cursor + 10);
            const sampleRate = Number((packed64 >> 44n) & 0xfffffn);
            const channelsMinus1 = Number((packed64 >> 41n) & 0x7n);
            const bpsMinus1 = Number((packed64 >> 36n) & 0x1fn);
            const totalSamples = Number(packed64 & 0xfffffffffn);

            expect(minBlock).toBe(4096);
            expect(maxBlock).toBe(4096);
            expect(minFrameSz).toBe(24_586); // Block 0..127 (1-byte UTF-8)
            expect(maxFrameSz).toBe(24_587); // Block 128..139 (2-byte UTF-8)
            expect(sampleRate).toBe(44_100);
            expect(channelsMinus1 + 1).toBe(2);
            expect(bpsMinus1 + 1).toBe(24);
            expect(totalSamples).toBe(140 * 4096);
            totalSamplesFromStreamInfo = totalSamples;
            sawStreamInfo = true;
          } else if (blockType === 3) {
            // SEEKTABLE (n * 18 bytes, BE)
            expect(blockLenBE % 18).toBe(0);
            for (let p = cursor; p < blockEnd; p += 18) {
              const sampleNumber = fullFlac.readBigUInt64BE(p);
              const streamOffset = Number(fullFlac.readBigUInt64BE(p + 8));
              const frameSamples = fullFlac.readUInt16BE(p + 16);
              seekPoints.push({ sampleNumber, streamOffset, frameSamples });
            }
            sawSeekTable = true;
          } else if (blockType === 4) {
            // VORBIS_COMMENT (24-bit BE block header length, 32-bit LE internal lengths!)
            let vcPos = cursor;
            const vendorLenLE = fullFlac.readUInt32LE(vcPos);
            vcPos += 4;
            const vendor = fullFlac.subarray(vcPos, vcPos + vendorLenLE).toString('utf8');
            expect(vendor).toBe('SoundClud');
            vcPos += vendorLenLE;
            const countLE = fullFlac.readUInt32LE(vcPos);
            vcPos += 4;
            for (let i = 0; i < countLE; i += 1) {
              const cLenLE = fullFlac.readUInt32LE(vcPos);
              vcPos += 4;
              vorbisComments.push(fullFlac.subarray(vcPos, vcPos + cLenLE).toString('utf8'));
              vcPos += cLenLE;
            }
            expect(vcPos).toBe(blockEnd);
            sawVorbisComment = true;
          }

          cursor = blockEnd;
          if (isLast) {
            break;
          }
        }

        const firstFrameOffset = cursor;
        expect(sawStreamInfo).toBe(true);
        expect(sawSeekTable).toBe(true);
        expect(sawVorbisComment).toBe(true);
        expect(vorbisComments).toContain('TITLE=SoundCloud Track');
        expect(vorbisComments).toContain('ARTIST=SoundCloud');
        expect(vorbisComments).toContain('ALBUM=SoundCloud');
        expect(vorbisComments).toContain('GENRE=Music');

        // Independent CRC-8 (poly 0x07) & CRC-16 (poly 0x8005) tables
        const crc8Table = new Uint8Array(256);
        for (let i = 0; i < 256; i += 1) {
          let c = i;
          for (let b = 0; b < 8; b += 1) {
            c = (c & 0x80) !== 0 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff;
          }
          crc8Table[i] = c;
        }
        const crc16Table = new Uint16Array(256);
        for (let i = 0; i < 256; i += 1) {
          let c = i << 8;
          for (let b = 0; b < 8; b += 1) {
            c = (c & 0x8000) !== 0 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff;
          }
          crc16Table[i] = c;
        }

        const calcCrc8 = (buf: Buffer, start: number, endExcl: number): number => {
          let crc = 0;
          for (let i = start; i < endExcl; i += 1) {
            crc = crc8Table[(crc ^ buf.readUInt8(i)) & 0xff] ?? 0;
          }
          return crc;
        };
        const calcCrc16 = (buf: Buffer, start: number, endExcl: number): number => {
          let crc = 0;
          for (let i = start; i < endExcl; i += 1) {
            const idx = ((crc >> 8) ^ buf.readUInt8(i)) & 0xff;
            crc = (((crc << 8) & 0xffff) ^ (crc16Table[idx] ?? 0)) & 0xffff;
          }
          return crc;
        };
        const decodeCanonicalUtf8BlockNum = (
          buf: Buffer,
          off: number,
        ): { readonly blockNum: number; readonly len: number } => {
          const b0 = buf.readUInt8(off);
          if (b0 < 0x80) {
            return { blockNum: b0, len: 1 };
          }
          if ((b0 & 0xe0) === 0xc0) {
            const b1 = buf.readUInt8(off + 1);
            expect(b1 & 0xc0).toBe(0x80);
            const val = ((b0 & 0x1f) << 6) | (b1 & 0x3f);
            expect(val).toBeGreaterThanOrEqual(0x80); // Reject overlong UTF-8
            return { blockNum: val, len: 2 };
          }
          const b1 = buf.readUInt8(off + 1);
          const b2 = buf.readUInt8(off + 2);
          expect(b1 & 0xc0).toBe(0x80);
          expect(b2 & 0xc0).toBe(0x80);
          const val = ((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
          expect(val).toBeGreaterThanOrEqual(0x800);
          return { blockNum: val, len: 3 };
        };
        const readSigned24BE = (buf: Buffer, off: number): number => {
          const u24 =
            (buf.readUInt8(off) << 16) | (buf.readUInt8(off + 1) << 8) | buf.readUInt8(off + 2);
          return (u24 & 0x800000) !== 0 ? u24 | ~0xffffff : u24;
        };

        // Verify SEEKTABLE ascending uniqueness + exact frame sync at firstFrameOffset + streamOffset
        expect(seekPoints.length).toBe(100);
        for (let i = 0; i < seekPoints.length; i += 1) {
          const sp = seekPoints[i];
          if (sp === undefined) {
            continue;
          }
          if (i > 0) {
            const prev = seekPoints[i - 1];
            if (prev !== undefined) {
              expect(sp.sampleNumber > prev.sampleNumber).toBe(true);
              expect(sp.streamOffset).toBeGreaterThan(prev.streamOffset);
            }
          }
          expect(sp.frameSamples).toBe(4096);
          const targetPos = firstFrameOffset + sp.streamOffset;
          expect(fullFlac.subarray(targetPos, targetPos + 4)).toEqual(
            Buffer.from([0xff, 0xf8, 0xc9, 0x1c]),
          );
          const decodedNum = decodeCanonicalUtf8BlockNum(fullFlac, targetPos + 4);
          expect(BigInt(decodedNum.blockNum) * 4096n).toBe(sp.sampleNumber);
        }

        // Verify all 140 audio frames (CRC-8, CRC-16, UTF-8 block index 0..139, BE 24-bit samples)
        let framePos = firstFrameOffset;
        let frameOffsets: number[] = [];
        let decodedFramesCount = 0;
        while (framePos < fullFlac.length) {
          frameOffsets.push(framePos);
          expect(fullFlac.subarray(framePos, framePos + 4)).toEqual(
            Buffer.from([0xff, 0xf8, 0xc9, 0x1c]),
          );
          const { blockNum, len: utf8Len } = decodeCanonicalUtf8BlockNum(fullFlac, framePos + 4);
          expect(blockNum).toBe(decodedFramesCount);
          expect(utf8Len).toBe(blockNum < 128 ? 1 : 2);

          const hdrCrcOffset = framePos + 4 + utf8Len;
          expect(fullFlac.readUInt8(hdrCrcOffset)).toBe(calcCrc8(fullFlac, framePos, hdrCrcOffset));

          const sub0Pos = hdrCrcOffset + 1;
          expect(fullFlac.readUInt8(sub0Pos)).toBe(0x02); // SUBFRAME_VERBATIM (0 wasted bits)
          const sub1Pos = sub0Pos + 1 + 4096 * 3;
          expect(fullFlac.readUInt8(sub1Pos)).toBe(0x02); // SUBFRAME_VERBATIM (0 wasted bits)

          // Spot-check asymmetric 24-bit BE samples in block 0, block 127, block 128, and tail zero-pad in block 139
          if (blockNum === 0 || blockNum === 127 || blockNum === 128) {
            const leftS24 = readSigned24BE(fullFlac, sub0Pos + 1);
            const rightS24 = readSigned24BE(fullFlac, sub1Pos + 1);
            expect(Math.abs(leftS24 - 0x400000)).toBeLessThanOrEqual(256);
            expect(Math.abs(rightS24 - -0x200000)).toBeLessThanOrEqual(256);
          } else if (blockNum === 139) {
            // 573,300 total source frames -> block 139 has 4096 - 140 = 3956 audio samples + 140 zero-padded samples
            const firstInLastL = readSigned24BE(fullFlac, sub0Pos + 1);
            const paddedTailL = readSigned24BE(fullFlac, sub0Pos + 1 + 4095 * 3);
            const paddedTailR = readSigned24BE(fullFlac, sub1Pos + 1 + 4095 * 3);
            expect(Math.abs(firstInLastL - 0x400000)).toBeLessThanOrEqual(256);
            expect(paddedTailL).toBe(0);
            expect(paddedTailR).toBe(0);
          }

          const footerCrcPos = sub1Pos + 1 + 4096 * 3;
          expect(fullFlac.readUInt16BE(footerCrcPos)).toBe(
            calcCrc16(fullFlac, framePos, footerCrcPos),
          );

          framePos = footerCrcPos + 2;
          decodedFramesCount += 1;
        }
        expect(decodedFramesCount).toBe(140);
        expect(decodedFramesCount * 4096).toBe(totalSamplesFromStreamInfo);

        // Verify HTTP 206 byte-range slicing across mid-header, cross-header, and across block 127->128 UTF-8 transition!
        const frame127Start = frameOffsets[127] ?? 0;
        const frame129Start = frameOffsets[129] ?? 0;
        const mid127 = frame127Start + 9_999;
        const mid129 = frame129Start + 5_432;

        const rangeCases: readonly {
          readonly header: string;
          readonly expectedSlice: Buffer;
        }[] = [
          { header: 'bytes=0-41', expectedSlice: fullFlac.subarray(0, 42) },
          { header: 'bytes=19-26000', expectedSlice: fullFlac.subarray(19, 26_001) },
          {
            header: `bytes=${String(mid127)}-${String(mid129)}`,
            expectedSlice: fullFlac.subarray(mid127, mid129 + 1),
          },
          { header: 'bytes=-512', expectedSlice: fullFlac.subarray(fullFlac.length - 512) },
        ];

        for (const rc of rangeCases) {
          const rRes = await fetch(capturedStreamUri, { headers: { Range: rc.header } });
          expect(rRes.status).toBe(206);
          const rBuf = Buffer.from(await rRes.arrayBuffer());
          expect(Buffer.compare(rBuf, rc.expectedSlice)).toBe(0);
        }

        const invalidRangeRes = await fetch(capturedStreamUri, {
          headers: { Range: `bytes=${String(fullFlac.length + 100)}-` },
        });
        expect(invalidRangeRes.status).toBe(416);

        // Native macOS CoreAudio / AudioToolbox FLAC compatibility (`afinfo` + `afconvert`)
        if (process.platform === 'darwin') {
          const tmpFlacPath = path.join(tmpRoot, 'live_stream.flac');
          const tmpWavPath = path.join(tmpRoot, 'coreaudio_decoded.wav');
          await fsp.writeFile(tmpFlacPath, fullFlac);

          const afinfoOut = execFileSync('/usr/bin/afinfo', [tmpFlacPath], {
            encoding: 'utf8',
            stdio: 'pipe',
          });
          expect(afinfoOut).toContain('File type ID:   flac');
          expect(afinfoOut).toContain('2 ch,  44100 Hz');
          expect(afinfoOut).toContain('from 24-bit source, 4096 frames/packet');
          expect(afinfoOut).toContain('audio packets: 140');
          expect(afinfoOut).toContain('source bit depth: I24');

          execFileSync('/usr/bin/afconvert', ['-f', 'WAVE', '-d', 'LEI24', tmpFlacPath, tmpWavPath], {
            stdio: 'pipe',
          });
          const decodedWav = await fsp.readFile(tmpWavPath);
          const dataChunkIdx = decodedWav.indexOf(Buffer.from('data', 'ascii'));
          expect(dataChunkIdx).toBeGreaterThanOrEqual(36);
          const pcmOff = dataChunkIdx + 8;
          const caLeft =
            ((decodedWav.readUInt8(pcmOff) |
              (decodedWav.readUInt8(pcmOff + 1) << 8) |
              (decodedWav.readUInt8(pcmOff + 2) << 16)) <<
              8) >>
            8;
          const caRight =
            ((decodedWav.readUInt8(pcmOff + 3) |
              (decodedWav.readUInt8(pcmOff + 4) << 8) |
              (decodedWav.readUInt8(pcmOff + 5) << 16)) <<
              8) >>
            8;
          expect(Math.abs(caLeft - 0x400000)).toBeLessThanOrEqual(256);
          expect(Math.abs(caRight - -0x200000)).toBeLessThanOrEqual(256);
        }

        // Verify keepalive cannot be starved by repeated seeks (< 140ms keepalive_interval)
        const slpoffBefore = mcuCommands.filter((c) => c === 'SLPOFF').length;
        const heartbeatsBefore = cliCommands.filter((c) => c.includes('heart_beat')).length;
        for (let step = 0; step < 3; step += 1) {
          await new Promise<void>((r) => setTimeout(r, 55));
          await controller.sendCommand({
            type: 'seek',
            commandSeq: 10 + step,
            positionMs: 2_000 + step * 1_000,
          });
        }
        await new Promise<void>((r) => setTimeout(r, 90));
        expect(mcuCommands.filter((c) => c === 'SLPOFF').length).toBeGreaterThan(slpoffBefore);
        expect(cliCommands.filter((c) => c.includes('heart_beat')).length).toBeGreaterThan(
          heartbeatsBefore,
        );
        expect(setPowerStateOnCalls).toBe(1); // Poller NEVER calls SetDevicePowerState!

        // Remote PWSTANDBY on Host-MCU (:23) must stop cleanly to Idle WITHOUT re-waking!
        const pwonBeforeStandby = mcuCommands.filter((c) => c === 'PWON').length;
        forceRemoteStandby = true;
        const idleDeadline = Date.now() + 1_500;
        let sawIdle = false;
        while (Date.now() < idleDeadline) {
          const stRes = await extFetch(`${baseUrl}${API_V1_STATUS_PATH}`, {
            headers: { Authorization: `Bearer ${pairToken}`, Accept: 'application/json' },
          });
          const parsedSt = parseStatusResponse(await stRes.json());
          if (parsedSt.ok && parsedSt.value.telemetry.phase === 'idle') {
            sawIdle = true;
            break;
          }
          await new Promise<void>((r) => setTimeout(r, 40));
        }
        expect(sawIdle).toBe(true);
        expect(mcuCommands.filter((c) => c === 'PWON').length).toBe(pwonBeforeStandby);
        expect(setPowerStateOnCalls).toBe(1);

        // Zero volume/mute mutations across UPnP, Host-MCU, and HEOS CLI
        expect(renderingControlHits).toBe(0);
        expect(mcuCommands.some((c) => c.startsWith('MV') || c.startsWith('MU'))).toBe(false);
        expect(
          cliCommands.some((c) => c.toLowerCase().includes('volume') || c.toLowerCase().includes('mute')),
        ).toBe(false);
        expect(
          soapActions.some((a) => a.toLowerCase().includes('volume') || a.toLowerCase().includes('mute')),
        ).toBe(false);
      } finally {
        await controller.disconnect();
        receiverChild.stdin?.end();
        if (receiverChild.exitCode === null && receiverChild.signalCode === null) {
          await new Promise<void>((resolve) => {
            const t = setTimeout(() => {
              receiverChild.kill('SIGKILL');
              resolve();
            }, 500);
            receiverChild.once('exit', () => {
              clearTimeout(t);
              resolve();
            });
          });
        }
        for (const s of openTcpSockets) {
          s.destroy();
        }
        await Promise.all([
          new Promise<void>((r) => mcuServer.close(() => r())),
          new Promise<void>((r) => cliServer.close(() => r())),
          new Promise<void>((r) => upnpServer.close(() => r())),
          new Promise<void>((r) => hlsServer.close(() => r())),
        ]);
        await fsp.rm(tmpRoot, { recursive: true, force: true });
      }
    },
    20_000,
  );
});
