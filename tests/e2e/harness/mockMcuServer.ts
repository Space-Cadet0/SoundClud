import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { McuInput, MockMcuServer, MockMcuServerOptions, PowerState } from './types.js';

export async function createMockMcuServer(
  options: MockMcuServerOptions = {},
): Promise<MockMcuServer> {
  let powerState: PowerState = options.initialPower ?? 'STANDBY';
  let selectedInput: McuInput = options.initialInput ?? 'SITV';

  const receivedCommands: string[] = [];
  const activeSockets = new Set<net.Socket>();
  let currentConcurrentConnections = 0;
  let maxConcurrentConnections = 0;
  let sleepCommandCount = 0;

  const server = net.createServer((sock) => {
    activeSockets.add(sock);
    currentConcurrentConnections += 1;
    if (currentConcurrentConnections > maxConcurrentConnections) {
      maxConcurrentConnections = currentConcurrentConnections;
    }

    sock.on('close', () => {
      activeSockets.delete(sock);
      currentConcurrentConnections = Math.max(0, currentConcurrentConnections - 1);
    });

    sock.on('error', () => {
      activeSockets.delete(sock);
      currentConcurrentConnections = Math.max(0, currentConcurrentConnections - 1);
    });

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
        receivedCommands.push(cmd);

        if (cmd === 'PW?') {
          sock.write(powerState === 'ON' ? 'PWON\r' : 'PWSTANDBY\r');
        } else if (cmd === 'PWON') {
          powerState = 'ON';
          sock.write('PWON\r');
        } else if (cmd === 'PWSTANDBY') {
          powerState = 'STANDBY';
          sock.write('PWSTANDBY\r');
        } else if (cmd === 'SI?') {
          sock.write(`${selectedInput}\r`);
        } else if (cmd === 'SINET' || cmd === 'SITV' || cmd === 'SICD') {
          selectedInput = cmd as McuInput;
          sock.write(`${cmd}\r`);
        } else if (cmd.startsWith('SLP')) {
          sleepCommandCount += 1;
          sock.write('SLPOFF\r');
        } else {
          // Default echo for unknown queries
          sock.write(`${cmd}\r`);
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
  const baseUrl = `127.0.0.1:${String(port)}`;

  return {
    port,
    baseUrl,
    setPowerState(state: PowerState) {
      powerState = state;
    },
    setInput(input: McuInput) {
      selectedInput = input;
    },
    getReceivedCommands() {
      return [...receivedCommands];
    },
    assertZeroSleepCommands() {
      if (sleepCommandCount > 0) {
        throw new Error(
          `Assertion failed: Expected 0 Host-MCU sleep commands, but received ${String(
            sleepCommandCount,
          )} commands!`,
        );
      }
    },
    assertSerializedAccess() {
      if (maxConcurrentConnections > 1) {
        throw new Error(
          `Assertion failed: Expected serialized single-client access (max 1 concurrent), but saw ${String(
            maxConcurrentConnections,
          )} concurrent connections!`,
        );
      }
    },
    simulateDisconnect() {
      for (const sock of activeSockets) {
        sock.destroy();
      }
      activeSockets.clear();
      currentConcurrentConnections = 0;
    },
    async stop() {
      for (const sock of activeSockets) {
        sock.destroy();
      }
      activeSockets.clear();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
