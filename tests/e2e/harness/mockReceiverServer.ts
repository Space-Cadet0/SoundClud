import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo, Socket } from 'node:net';
import type { OutputDevice } from '@soundclud/protocol';
import { SYNTHETIC_OUTPUT_HEOS, SYNTHETIC_OUTPUT_TOSLINK, SYNTHETIC_PAIRING_TOKEN } from './fixtures.js';
import type { MockReceiverServer, MockReceiverServerOptions } from './types.js';

const WS_MAGIC_STRING = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function createAcceptKey(key: string): string {
  return crypto.createHash('sha1').update(key + WS_MAGIC_STRING).digest('base64');
}

function encodeWsTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header: Buffer;

  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x81; // FIN + text
    header[1] = len;
  } else if (len <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }

  return Buffer.concat([header, payload]);
}

function sendTcpLine(port: number, command: string, terminator: string = '\n'): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1');
    let response = '';
    const timer = setTimeout(() => {
      sock.destroy();
      resolve(response.trim());
    }, 1500);

    sock.on('connect', () => {
      sock.write(command);
    });

    sock.on('data', (chunk) => {
      response += chunk.toString('utf8');
      if (response.includes(terminator) || response.includes('\n')) {
        clearTimeout(timer);
        sock.end();
      }
    });

    sock.on('close', () => {
      clearTimeout(timer);
      resolve(response.trim());
    });

    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

export async function createMockReceiverServer(
  options: MockReceiverServerOptions = {},
): Promise<MockReceiverServer> {
  const pairingToken = options.pairingToken ?? SYNTHETIC_PAIRING_TOKEN;
  let volume = options.initialVolume ?? 35;
  let muted = options.initialMuted ?? false;
  let requireAuthOnVolume = options.requireAuthOnVolume ?? true;
  let lastSetVolumePayload: { volume?: number | undefined; muted?: boolean | undefined } | null = null;

  const defaultOutputs: OutputDevice[] = [
    SYNTHETIC_OUTPUT_HEOS,
    SYNTHETIC_OUTPUT_TOSLINK,
  ];

  let currentOutputs = options.initialOutputs ? [...options.initialOutputs] : defaultOutputs;
  let activeOutputId = currentOutputs[0]?.id ?? 'heos_upnp:PM7000N';

  const wsSockets = new Set<Socket>();

  const broadcastWsJson = (obj: unknown): void => {
    const frame = encodeWsTextFrame(JSON.stringify(obj));
    for (const sock of wsSockets) {
      if (sock.writable) {
        sock.write(frame);
      }
    }
  };

  // Active CLI event listener socket management (Features 7 & 17)
  let activeCliListenerSocket: net.Socket | null = null;
  let activeCliListenerPort: number | null = null;

  const attachCliListener = (targetPort: number, targetOutputId: string): void => {
    if (activeCliListenerSocket && activeCliListenerPort === targetPort) {
      return;
    }
    if (activeCliListenerSocket) {
      activeCliListenerSocket.removeAllListeners();
      activeCliListenerSocket.destroy();
      activeCliListenerSocket = null;
      activeCliListenerPort = null;
    }

    const sock = net.connect(targetPort, '127.0.0.1');
    activeCliListenerSocket = sock;
    activeCliListenerPort = targetPort;

    sock.on('connect', () => {
      sock.write('heos://system/register_for_change_events?enable=on\r\n');
    });

    let buf = '';
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let nlIdx: number;
      while ((nlIdx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nlIdx).trim();
        buf = buf.slice(nlIdx + 1);
        if (!line) continue;

        if (line.includes('event/player_volume_changed')) {
          try {
            const parsed = JSON.parse(line);
            const lvl = parsed.payload?.[0]?.level;
            const mut = parsed.payload?.[0]?.mute === 'on';
            if (typeof lvl === 'number') {
              volume = lvl;
            }
            if (typeof mut === 'boolean') {
              muted = mut;
            }
            broadcastWsJson({
              type: 'volume_changed',
              volume,
              muted,
              outputId: targetOutputId,
            });
          } catch {
            const match = /"level":\s*(\d+)/.exec(line);
            if (match?.[1]) {
              volume = Number.parseInt(match[1], 10);
              broadcastWsJson({
                type: 'volume_changed',
                volume,
                muted,
                outputId: targetOutputId,
              });
            }
          }
        } else if (line.includes('event/player_mute_changed')) {
          try {
            const parsed = JSON.parse(line);
            const mut = parsed.payload?.[0]?.mute === 'on';
            if (typeof mut === 'boolean') {
              muted = mut;
            }
            broadcastWsJson({
              type: 'volume_changed',
              volume,
              muted,
              outputId: targetOutputId,
            });
          } catch {}
        }
      }
    });

    sock.on('error', () => {});
    sock.on('close', () => {
      if (activeCliListenerSocket === sock) {
        activeCliListenerSocket = null;
        activeCliListenerPort = null;
      }
    });
  };

  // Pre-attach listener if initial output has an endpoint configured
  const initialEndpoint = options.outputEndpoints?.[activeOutputId] ?? (
    options.heosCliPort ? { cliPort: options.heosCliPort, mcuPort: options.mcuPort } : undefined
  );
  if (initialEndpoint?.cliPort) {
    attachCliListener(initialEndpoint.cliPort, activeOutputId);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    const pathname = url.pathname;

    const readJsonBody = async (): Promise<unknown> => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer));
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      return raw.trim().length > 0 ? JSON.parse(raw) : {};
    };

    if (req.method === 'GET' && pathname === '/api/v1/discover') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          protocolVersion: 'v1',
          receivers: [
            {
              receiverId: 'synth-receiver-01',
              name: 'Synthetic Lab Receiver',
              version: '0.1.0',
              supportsHardwareVolume: true,
              outputs: currentOutputs,
            },
          ],
        }),
      );
      return;
    }

    if (req.method === 'POST' && pathname === '/api/v1/pair') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          protocolVersion: 'v1',
          receiverId: 'synth-receiver-01',
          name: 'Synthetic Lab Receiver',
          pairingToken,
        }),
      );
      return;
    }

    if (req.method === 'GET' && pathname === '/api/v1/status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          protocolVersion: 'v1',
          state: 'idle',
          activeOutputId,
          volume,
          muted,
          supportsHardwareVolume: true,
        }),
      );
      return;
    }

    if (req.method === 'GET' && pathname === '/api/v1/audio/volume') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          protocolVersion: 'v1',
          volume,
          muted,
          supportsHardwareVolume: true,
        }),
      );
      return;
    }

    if (req.method === 'POST' && pathname === '/api/v1/audio/volume') {
      if (requireAuthOnVolume) {
        const authHeader = req.headers.authorization ?? '';
        const match = /^bearer\s+(\S+)$/i.exec(authHeader);
        if (!match || match[1] !== pairingToken) {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                code: 'UNAUTHORIZED',
                message: 'Missing or invalid authorization header',
              },
            }),
          );
          return;
        }
      }

      readJsonBody()
        .then((body: any) => {
          if (body.volume === undefined && body.muted === undefined) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                error: {
                  code: 'INVALID_PAYLOAD',
                  message: 'At least one of volume or muted must be provided',
                },
              }),
            );
            return;
          }

          const targetOutId = typeof body.outputId === 'string' ? body.outputId : activeOutputId;
          const targetOut = currentOutputs.find((o) => o.id === targetOutId);
          if (targetOut && targetOut.capabilities.supportsHardwareVolume === false) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({
                error: {
                  code: 'set_volume_failed',
                  message: 'Hardware volume control is not supported on this output (use physical amplifier knob)',
                },
              }),
            );
            return;
          }

          lastSetVolumePayload = { volume: body.volume, muted: body.muted };

          // Decoupled order: volume updated first, then mute
          if (typeof body.volume === 'number') {
            if (body.volume < 0 || body.volume > 100) {
              res.writeHead(400, { 'content-type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: {
                    code: 'INVALID_VOLUME',
                    message: 'Volume must be between 0 and 100',
                  },
                }),
              );
              return;
            }
            volume = body.volume;
          }

          if (typeof body.muted === 'boolean') {
            muted = body.muted;
          }

          // Broadcast volume changed event
          broadcastWsJson({
            type: 'volume_changed',
            volume,
            muted,
            outputId: activeOutputId,
          });

          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              protocolVersion: 'v1',
              volume,
              muted,
              supportsHardwareVolume: true,
            }),
          );
        })
        .catch(() => {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                code: 'BAD_REQUEST',
                message: 'Invalid JSON request body',
              },
            }),
          );
        });
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Not Found' } }));
  });

  server.on('upgrade', (req, socket: Socket, head) => {
    const key = req.headers['sec-websocket-key'];
    if (!key || typeof key !== 'string') {
      socket.destroy();
      return;
    }

    const acceptKey = createAcceptKey(key);
    const responseHeaders = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey}`,
      '\r\n',
    ];
    socket.write(responseHeaders.join('\r\n'));
    wsSockets.add(socket);

    socket.on('close', () => {
      wsSockets.delete(socket);
    });

    socket.on('error', () => {
      wsSockets.delete(socket);
    });

    let buffer = Buffer.alloc(0);
    if (head && head.length > 0) {
      buffer = Buffer.concat([buffer, head]);
    }

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      while (buffer.length >= 2) {
        const byte0 = buffer[0]!;
        const byte1 = buffer[1]!;
        const opcode = byte0 & 0x0f;
        const isMasked = (byte1 & 0x80) !== 0;
        let payloadLen = byte1 & 0x7f;
        let offset = 2;

        if (payloadLen === 126) {
          if (buffer.length < offset + 2) break;
          payloadLen = buffer.readUInt16BE(offset);
          offset += 2;
        } else if (payloadLen === 127) {
          if (buffer.length < offset + 8) break;
          payloadLen = Number(buffer.readBigUInt64BE(offset));
          offset += 8;
        }

        let mask: Buffer | null = null;
        if (isMasked) {
          if (buffer.length < offset + 4) break;
          mask = buffer.subarray(offset, offset + 4);
          offset += 4;
        }

        if (buffer.length < offset + payloadLen) break;

        const rawPayload = buffer.subarray(offset, offset + payloadLen);
        const unmaskedPayload = Buffer.allocUnsafe(payloadLen);
        if (mask !== null) {
          for (let i = 0; i < payloadLen; i += 1) {
            unmaskedPayload[i] = rawPayload[i]! ^ mask[i % 4]!;
          }
        } else {
          rawPayload.copy(unmaskedPayload);
        }

        buffer = buffer.subarray(offset + payloadLen);

        if (opcode === 0x08) {
          // Close frame
          socket.write(Buffer.from([0x88, 0x00]));
          socket.destroy();
          break;
        }

        if (opcode === 0x09) {
          // Ping -> Pong
          const pong = Buffer.concat([Buffer.from([0x8a, unmaskedPayload.length]), unmaskedPayload]);
          socket.write(pong);
          continue;
        }

        if (opcode === 0x01) {
          // Text frame
          const text = unmaskedPayload.toString('utf8');
          (async () => {
            try {
              const cmd = JSON.parse(text);
              if (cmd.type === 'hello') {
                const activeEp = options.outputEndpoints?.[activeOutputId] ?? (
                  options.heosCliPort ? { cliPort: options.heosCliPort, mcuPort: options.mcuPort } : undefined
                );

                // 1. Passive volume query to CLI port (Feature 4)
                if (activeEp?.cliPort) {
                  attachCliListener(activeEp.cliPort, activeOutputId);
                  try {
                    const cliRes = await sendTcpLine(activeEp.cliPort, 'heos://player/get_volume?pid=1\r\n');
                    const levelMatch = /level=(\d+)/.exec(cliRes) ?? /"level":\s*(\d+)/.exec(cliRes);
                    if (levelMatch?.[1]) {
                      volume = Number.parseInt(levelMatch[1], 10);
                    }
                    const muteMatch = /state=(on|off)/.exec(cliRes) ?? /"mute":\s*"?(on|off)"?/.exec(cliRes);
                    if (muteMatch?.[1]) {
                      muted = muteMatch[1] === 'on';
                    }
                  } catch {}
                }

                // 2. Passive power query to MCU port (Feature 4 invariant: PW? only, zero wake commands)
                const targetMcuPort = activeEp?.mcuPort ?? options.mcuPort;
                if (targetMcuPort) {
                  try {
                    await sendTcpLine(targetMcuPort, 'PW?\r', '\r');
                  } catch {}
                }

                // Send welcome
                const welcome = {
                  type: 'welcome',
                  protocolVersion: 'v1',
                  receiverId: 'synth-receiver-01',
                  name: 'Synthetic Lab Receiver',
                  activeOutputId,
                  outputs: currentOutputs,
                  volume,
                  muted,
                  supportsHardwareVolume: true,
                };
                socket.write(encodeWsTextFrame(JSON.stringify(welcome)));

                // Passive initial query push (Feature 4)
                const volChanged = {
                  type: 'volume_changed',
                  volume,
                  muted,
                  outputId: activeOutputId,
                };
                socket.write(encodeWsTextFrame(JSON.stringify(volChanged)));
              } else if (cmd.type === 'ping') {
                const pong = {
                  type: 'pong',
                  clientTimestampMs: cmd.clientTimestampMs,
                  serverTimestampMs: Date.now(),
                };
                socket.write(encodeWsTextFrame(JSON.stringify(pong)));
              } else if (cmd.type === 'select_output') {
                activeOutputId = cmd.outputId;

                // Listener failover (Features 7 & 17): abort old listener, attach to new target
                const newEndpoint = options.outputEndpoints?.[activeOutputId];
                if (newEndpoint?.cliPort) {
                  attachCliListener(newEndpoint.cliPort, activeOutputId);
                  try {
                    const cliRes = await sendTcpLine(newEndpoint.cliPort, 'heos://player/get_volume?pid=2\r\n');
                    const levelMatch = /level=(\d+)/.exec(cliRes) ?? /"level":\s*(\d+)/.exec(cliRes);
                    if (levelMatch?.[1]) {
                      volume = Number.parseInt(levelMatch[1], 10);
                    }
                  } catch {}
                } else if (activeCliListenerSocket) {
                  activeCliListenerSocket.removeAllListeners();
                  activeCliListenerSocket.destroy();
                  activeCliListenerSocket = null;
                  activeCliListenerPort = null;
                }

                const ack = {
                  type: 'command_ack',
                  commandSeq: cmd.commandSeq,
                  success: true,
                };
                socket.write(encodeWsTextFrame(JSON.stringify(ack)));
                // Push updated volume for selected output
                broadcastWsJson({
                  type: 'volume_changed',
                  volume,
                  muted,
                  outputId: activeOutputId,
                });
              } else if (cmd.type === 'set_volume') {
                const targetOutput = currentOutputs.find((o) => o.id === activeOutputId);
                if (targetOutput && targetOutput.capabilities.supportsHardwareVolume === false) {
                  const errEvent = {
                    type: 'error',
                    code: 'set_volume_failed',
                    message: 'Hardware volume control is not supported on this output (use physical amplifier knob)',
                    commandSeq: cmd.commandSeq,
                  };
                  socket.write(encodeWsTextFrame(JSON.stringify(errEvent)));
                  return;
                }

                lastSetVolumePayload = { volume: cmd.volume, muted: cmd.muted };
                if (typeof cmd.volume === 'number') {
                  volume = Math.max(0, Math.min(100, cmd.volume));
                }
                if (typeof cmd.muted === 'boolean') {
                  muted = cmd.muted;
                }
                const ack = {
                  type: 'command_ack',
                  commandSeq: cmd.commandSeq,
                  success: true,
                };
                socket.write(encodeWsTextFrame(JSON.stringify(ack)));
                broadcastWsJson({
                  type: 'volume_changed',
                  volume,
                  muted,
                  outputId: activeOutputId,
                });
              }
            } catch {
              // Ignore parse errors in mock
            }
          })().catch(() => {});
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
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const wsUrl = `ws://127.0.0.1:${String(port)}/api/v1/ws`;

  return {
    port,
    baseUrl,
    wsUrl,
    pairingToken,
    getVolume() {
      return { volume, muted, supportsHardwareVolume: true };
    },
    setVolume(newVol: number, newMuted: boolean) {
      volume = newVol;
      muted = newMuted;
    },
    broadcastVolumeChanged(newVol: number, newMuted: boolean) {
      volume = newVol;
      muted = newMuted;
      broadcastWsJson({
        type: 'volume_changed',
        volume,
        muted,
        outputId: activeOutputId,
      });
    },
    broadcastOutputsUpdated(outputs: OutputDevice[]) {
      currentOutputs = [...outputs];
      broadcastWsJson({
        type: 'outputs_updated',
        outputs: currentOutputs,
      });
    },
    broadcastStateTick(tick) {
      broadcastWsJson({
        type: 'state_tick',
        state: tick.state,
        positionMs: tick.positionMs,
        durationMs: tick.durationMs,
        activeOutputId,
        volume,
        muted,
      });
    },
    broadcastTrackEnded(trackId: string, locatorId: string) {
      broadcastWsJson({
        type: 'track_ended',
        trackId,
        locatorId,
      });
    },
    simulateAuthTokenRequirement(requireAuth: boolean) {
      requireAuthOnVolume = requireAuth;
    },
    getConnectedClientCount() {
      return wsSockets.size;
    },
    getLastSetVolumePayload() {
      return lastSetVolumePayload;
    },
    triggerMcuKeepalive: async () => {
      const targetMcuPort = options.outputEndpoints?.[activeOutputId]?.mcuPort ?? options.mcuPort;
      if (!targetMcuPort) {
        throw new Error('No MCU port configured on receiver');
      }

      return new Promise<void>((resolve, reject) => {
        const sock = net.connect(targetMcuPort, '127.0.0.1');
        let stage: 'power' | 'input' = 'power';
        const timer = setTimeout(() => {
          sock.destroy();
          reject(new Error('MCU keepalive timed out'));
        }, 2000);

        sock.on('connect', () => {
          sock.write('PW?\r');
        });

        sock.on('data', (chunk: Buffer) => {
          const text = chunk.toString('utf8');
          if (stage === 'power' && text.includes('PWON')) {
            stage = 'input';
            sock.write('SI?\r');
          } else if (stage === 'input' && text.includes('SI')) {
            clearTimeout(timer);
            sock.end();
          }
        });

        sock.on('close', () => {
          clearTimeout(timer);
          resolve();
        });

        sock.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
    },
    async stop() {
      if (activeCliListenerSocket) {
        activeCliListenerSocket.removeAllListeners();
        activeCliListenerSocket.destroy();
        activeCliListenerSocket = null;
        activeCliListenerPort = null;
      }
      for (const sock of wsSockets) {
        sock.destroy();
      }
      wsSockets.clear();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
