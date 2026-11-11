import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { MockHeosCliServer, MockHeosCliServerOptions } from './types.js';

export async function createMockHeosCliServer(
  options: MockHeosCliServerOptions = {},
): Promise<MockHeosCliServer> {
  let volume = options.initialVolume ?? 35;
  let muted = options.initialMuted ?? false;
  const pid = options.pid ?? 99;

  let nextResult: 'success' | 'fail' = 'success';
  let nextResultMessage: string | null = null;
  let underProcessDelayMs = 0;

  const receivedCommands: string[] = [];
  const activeSockets = new Set<net.Socket>();
  const subscribedSockets = new Set<net.Socket>();

  const server = net.createServer((sock) => {
    activeSockets.add(sock);

    sock.on('close', () => {
      activeSockets.delete(sock);
      subscribedSockets.delete(sock);
    });

    sock.on('error', () => {
      activeSockets.delete(sock);
      subscribedSockets.delete(sock);
    });

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
        receivedCommands.push(line);

        const handleCommand = (): void => {
          if (!activeSockets.has(sock)) {
            return;
          }

          if (line.includes('player/get_players')) {
            const underProc = JSON.stringify({
              heos: {
                command: 'player/get_players',
                result: 'success',
                message: 'command under process',
              },
            });
            const ready = JSON.stringify({
              heos: { command: 'player/get_players', result: 'success' },
              payload: [
                {
                  name: 'Synthetic Reference Amp',
                  pid,
                  model: 'Reference Network Amp',
                  ip: '127.0.0.1',
                },
              ],
            });
            sock.write(`${underProc}\r\n${ready}\r\n`);
            return;
          }

          if (line.includes('system/register_for_change_events')) {
            subscribedSockets.add(sock);
            sock.write(
              JSON.stringify({
                heos: {
                  command: 'system/register_for_change_events',
                  result: 'success',
                },
              }) + '\r\n',
            );
            return;
          }

          if (line.includes('player/get_volume')) {
            sock.write(
              JSON.stringify({
                heos: {
                  command: 'player/get_volume',
                  result: 'success',
                  message: `pid=${String(pid)}&level=${String(volume)}`,
                },
              }) + '\r\n',
            );
            return;
          }

          if (line.includes('player/get_mute')) {
            sock.write(
              JSON.stringify({
                heos: {
                  command: 'player/get_mute',
                  result: 'success',
                  message: `pid=${String(pid)}&state=${muted ? 'on' : 'off'}`,
                },
              }) + '\r\n',
            );
            return;
          }

          if (line.includes('player/set_volume')) {
            const result = nextResult;
            const customMessage = nextResultMessage;
            nextResult = 'success';
            nextResultMessage = null;

            if (result === 'success') {
              const match = /level=(\d+)/.exec(line);
              if (match?.[1] !== undefined) {
                volume = Number.parseInt(match[1], 10);
              }
              sock.write(
                JSON.stringify({
                  heos: {
                    command: 'player/set_volume',
                    result: 'success',
                    message: customMessage ?? `pid=${String(pid)}&level=${String(volume)}`,
                  },
                }) + '\r\n',
              );
            } else {
              sock.write(
                JSON.stringify({
                  heos: {
                    command: 'player/set_volume',
                    result: 'fail',
                    message: customMessage ?? 'eid=1&text=System error',
                  },
                }) + '\r\n',
              );
            }
            return;
          }

          if (line.includes('player/set_mute')) {
            const result = nextResult;
            const customMessage = nextResultMessage;
            nextResult = 'success';
            nextResultMessage = null;

            if (result === 'success') {
              const match = /state=(on|off)/.exec(line);
              if (match?.[1] !== undefined) {
                muted = match[1] === 'on';
              }
              sock.write(
                JSON.stringify({
                  heos: {
                    command: 'player/set_mute',
                    result: 'success',
                    message: customMessage ?? `pid=${String(pid)}&state=${muted ? 'on' : 'off'}`,
                  },
                }) + '\r\n',
              );
            } else {
              sock.write(
                JSON.stringify({
                  heos: {
                    command: 'player/set_mute',
                    result: 'fail',
                    message: customMessage ?? 'eid=1&text=System error',
                  },
                }) + '\r\n',
              );
            }
            return;
          }

          // Fallback generic success response
          sock.write(
            JSON.stringify({
              heos: {
                result: 'success',
              },
            }) + '\r\n',
          );
        };

        if (underProcessDelayMs > 0) {
          setTimeout(handleCommand, underProcessDelayMs);
        } else {
          handleCommand();
        }
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
    server.once('error', reject);
  });

  const addr = server.address() as AddressInfo;
  const port = addr.port;

  const broadcastEvent = (eventLine: string): void => {
    for (const sock of subscribedSockets) {
      if (sock.writable) {
        sock.write(eventLine);
      }
    }
  };

  return {
    port,
    pid,
    get currentVolume() {
      return volume;
    },
    get currentMuted() {
      return muted;
    },
    setVolume(newVol: number, newMuted?: boolean) {
      volume = newVol;
      if (newMuted !== undefined) {
        muted = newMuted;
      }
    },
    setNextResult(result: 'success' | 'fail', message?: string) {
      nextResult = result;
      nextResultMessage = message ?? null;
    },
    pushVolumeChangeEvent(newVol: number, newMuted?: boolean) {
      volume = newVol;
      if (newMuted !== undefined) {
        muted = newMuted;
      }
      const eventJson = JSON.stringify({
        heos: {
          command: 'event/player_volume_changed',
        },
        payload: [
          {
            pid,
            level: volume,
            mute: muted ? 'on' : 'off',
          },
        ],
      });
      broadcastEvent(`${eventJson}\r\n`);
    },
    pushMuteOnlyChangeEvent(newMuted: boolean) {
      muted = newMuted;
      // Note: Feature 5 specifically tests that level is NOT present in this payload
      const eventJson = JSON.stringify({
        heos: {
          command: 'event/player_mute_changed',
        },
        payload: [
          {
            pid,
            state: muted ? 'on' : 'off',
          },
        ],
      });
      broadcastEvent(`${eventJson}\r\n`);
    },
    getReceivedCommands() {
      return [...receivedCommands];
    },
    simulateCommandUnderProcessDelay(ms: number) {
      underProcessDelayMs = ms;
    },
    async stop() {
      for (const sock of activeSockets) {
        sock.destroy();
      }
      activeSockets.clear();
      subscribedSockets.clear();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
