import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EphemeralReceiverOptions, RunningReceiverDaemon } from './types.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..', '..');

function resolveReceiverBinaryPath(): string {
  const exeName = process.platform === 'win32' ? 'soundclud-receiver.exe' : 'soundclud-receiver';
  const debugBin = path.join(REPO_ROOT, 'target', 'debug', exeName);
  if (fs.existsSync(debugBin)) {
    return debugBin;
  }
  const releaseBin = path.join(REPO_ROOT, 'target', 'release', exeName);
  if (fs.existsSync(releaseBin)) {
    return releaseBin;
  }
  const cargoBin = path.join(os.homedir(), '.cargo', 'bin');
  const envPath = `${cargoBin}${path.delimiter}${process.env['PATH'] ?? ''}`;
  execFileSync('cargo', ['build', '--bin', 'soundclud-receiver'], {
    cwd: REPO_ROOT,
    env: { ...process.env, PATH: envPath },
    stdio: 'inherit',
  });
  if (fs.existsSync(debugBin)) {
    return debugBin;
  }
  throw new Error(
    `soundclud-receiver binary not found at ${debugBin} or ${releaseBin} after 'cargo build'.`,
  );
}

function stripAnsi(input: string): string {
  return input.replace(/\u001b\[[0-9;]*m/g, '');
}

export async function spawnEphemeralReceiverDaemon(
  options: EphemeralReceiverOptions = {},
): Promise<RunningReceiverDaemon> {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'sc-e2e-daemon-'));
  const stateDir = path.join(tmpRoot, 'state');
  const mockMpvPath = path.join(tmpRoot, 'mock-mpv.mjs');
  const mpvFetchedSegmentLogPath = path.join(tmpRoot, 'mpv-segment-result.txt');

  await fsp.mkdir(stateDir, { recursive: true, mode: 0o700 });

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
  ].join('\n');

  await fsp.writeFile(mockMpvPath, mockMpvScript, { encoding: 'utf8', mode: 0o755 });

  const binPath = resolveReceiverBinaryPath();
  const defaultArgs = [
    '--bind',
    '127.0.0.1:0',
    '--state-dir',
    stateDir,
    '--mpv-bin',
    mockMpvPath,
    '--name',
    'Synthetic E2E Receiver',
    '--no-lan-discovery',
  ];

  const child: ChildProcess = spawn(
    binPath,
    options.customArgs ? [...options.customArgs] : defaultArgs,
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        NO_COLOR: '1',
        RUST_LOG: 'info',
        SC_MOCK_MPV_SEG_LOG: mpvFetchedSegmentLogPath,
        ...(options.env ?? {}),
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
          }, 350);
        }),
      ]);
      if (!sigintWon && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exitedPromise;
      }
    }
    try {
      await fsp.rm(tmpRoot, { recursive: true, force: true });
    } catch {
      // Best-effort tmpdir cleanup
    }
  };

  const boundPort = await new Promise<number>((resolve, reject) => {
    let combinedLog = '';
    const timeout = setTimeout(() => {
      cleanupProcessAndTmp().finally(() => {
        reject(
          new Error(
            `Timed out waiting for soundclud-receiver to log 'listen=127.0.0.1:<port>'. Captured output:\n${combinedLog}`,
          ),
        );
      });
    }, 7000);

    const onData = (chunk: Buffer): void => {
      const clean = stripAnsi(chunk.toString('utf8'));
      combinedLog += clean;
      const match = /listen=127\.0\.0\.1:(\d+)/.exec(clean);
      if (match?.[1] !== undefined) {
        clearTimeout(timeout);
        child.stdout?.off('data', onData);
        child.stderr?.off('data', onData);
        resolve(Number.parseInt(match[1], 10));
      }
    };

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `soundclud-receiver exited prematurely with code=${String(code)} signal=${String(
            signal,
          )}. Captured logs:\n${combinedLog}`,
        ),
      );
    });
  });

  const baseUrl = `http://127.0.0.1:${String(boundPort)}`;
  const wsUrl = `ws://127.0.0.1:${String(boundPort)}/api/v1/ws`;

  return {
    port: boundPort,
    baseUrl,
    wsUrl,
    stateDir,
    mpvFetchedSegmentLogPath,
    async fetchRest(subpath: string, init?: RequestInit): Promise<Response> {
      const targetUrl = `${baseUrl}${subpath.startsWith('/') ? '' : '/'}${subpath}`;
      return fetch(targetUrl, init);
    },
    async pair(clientLabel = 'Synthetic E2E Test Client', controllerId = 'ctrl_e2e_1'): Promise<string> {
      const res = await fetch(`${baseUrl}/api/v1/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          protocolVersion: 'v1',
          controllerId,
          clientLabel,
        }),
      });
      if (!res.ok) {
        throw new Error(`Pairing failed with HTTP status ${String(res.status)}: ${await res.text()}`);
      }
      const data = (await res.json()) as { pairingToken?: string };
      if (!data.pairingToken) {
        throw new Error('Pairing response did not contain pairingToken');
      }
      return data.pairingToken;
    },
    async connectWs(pairingToken?: string, controllerId = 'ctrl_e2e_ws'): Promise<WebSocket> {
      const ws = new WebSocket(wsUrl);
      return new Promise<WebSocket>((resolve, reject) => {
        const timeout = setTimeout(() => {
          ws.close();
          reject(new Error('Timed out waiting for WebSocket Welcome event'));
        }, 5000);

        ws.onopen = () => {
          const helloCmd: Record<string, unknown> = {
            type: 'hello',
            protocolVersion: 'v1',
            pairingToken: pairingToken ?? '',
            controllerId,
            clientLabel: 'Synthetic E2E Test Client',
          };
          ws.send(JSON.stringify(helloCmd));
        };

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(String(event.data));
            if (data.type === 'welcome') {
              clearTimeout(timeout);
              resolve(ws);
            }
          } catch {
            // Ignore non-json frames during handshake
          }
        };

        ws.onerror = (err) => {
          clearTimeout(timeout);
          reject(err);
        };
      });
    },
    stop: cleanupProcessAndTmp,
  };
}
