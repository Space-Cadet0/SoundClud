import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MockHlsServer, MockHlsServerOptions } from './types.js';

export async function createMockHlsServer(
  options: MockHlsServerOptions = {},
): Promise<MockHlsServer> {
  const defaultSegDurSec = options.defaultSegmentDurationSec ?? 3.0;
  let simulatedErrorCode: 403 | 404 | 500 | null = null;

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

  const server = http.createServer((req, res) => {
    const addr = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${String(addr.port)}`;

    if (req.url?.startsWith('/playlist.m3u8')) {
      const urlObj = new URL(req.url, origin);
      const totalDurMs = Number.parseInt(urlObj.searchParams.get('dur') ?? '12000', 10);
      const segDurSec = Number.parseFloat(urlObj.searchParams.get('seg') ?? String(defaultSegDurSec));

      const totalDurSec = totalDurMs / 1000;
      const segmentCount = Math.max(1, Math.ceil(totalDurSec / segDurSec));

      let body = '#EXTM3U\n#EXT-X-VERSION:3\n';
      body += `#EXT-X-TARGETDURATION:${String(Math.ceil(segDurSec))}\n`;

      let remainingSec = totalDurSec;
      for (let i = 0; i < segmentCount; i += 1) {
        const segLen = Math.min(segDurSec, remainingSec);
        remainingSec -= segLen;
        body += `#EXTINF:${segLen.toFixed(6)},\n`;
        body += `${origin}/seg${String(i)}.wav\n`;
      }
      body += '#EXT-X-ENDLIST\n';

      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      res.end(body);
      return;
    }

    if (req.url?.startsWith('/seg')) {
      if (simulatedErrorCode !== null) {
        const code = simulatedErrorCode;
        res.writeHead(code, { 'content-type': 'text/plain' });
        res.end(`Simulated Error ${String(code)}`);
        return;
      }

      // 44.1kHz 16-bit WAV chunk (3 seconds = 132,300 frames)
      const frames = 132_300;
      const wav = buildStereoWav16(44_100, frames, 16_384, -8_192);
      res.writeHead(200, {
        'content-type': 'audio/wav',
        'content-length': String(wav.length),
      });
      res.end(wav);
      return;
    }

    res.writeHead(404).end();
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

  return {
    port,
    baseUrl,
    getPlaylistUrl(options?: { trackDurationMs?: number | undefined; segmentDurationSec?: number | undefined }) {
      const dur = options?.trackDurationMs ?? 12_000;
      const seg = options?.segmentDurationSec ?? defaultSegDurSec;
      return `${baseUrl}/playlist.m3u8?dur=${String(dur)}&seg=${String(seg)}`;
    },
    simulateSegmentError(statusCode: 403 | 404 | 500 | null) {
      simulatedErrorCode = statusCode;
    },
    async stop() {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    },
  };
}
