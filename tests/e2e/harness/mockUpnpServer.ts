import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { MockUpnpServer, MockUpnpServerOptions } from './types.js';

export async function createMockUpnpServer(
  options: MockUpnpServerOptions = {},
): Promise<MockUpnpServer> {
  const friendlyName = options.friendlyName ?? 'Synthetic Reference Amp';
  const modelName = options.modelName ?? 'Reference Network Amp';

  let actPowerOn = true;
  let transportState: 'PLAYING' | 'PAUSED_PLAYBACK' | 'STOPPED' = 'PLAYING';
  let positionMs = 2000;
  let durationMs = 180000;

  let renderingControlHits = 0;
  let capturedStreamUri = '';
  let capturedDidlXml = '';
  const receivedSoapActions: string[] = [];

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

  const formatRelTime = (ms: number): string => {
    const totalSec = Math.floor(ms / 1000);
    const hours = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  };

  const server = http.createServer((req, res) => {
    const addr = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${String(addr.port)}`;

    if (req.method === 'GET' && req.url === '/desc.xml') {
      res.writeHead(200, { 'content-type': 'text/xml; charset="utf-8"' });
      res.end(
        `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device>` +
          `<deviceType>urn:schemas-denon-com:device:ACT-Denon:1</deviceType>` +
          `<friendlyName>${friendlyName}</friendlyName>` +
          `<modelName>${modelName}</modelName>` +
          `<UDN>uuid:synthetic-e2e-heos-harness</UDN>` +
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
      receivedSoapActions.push(soapAction);

      if (req.url === '/RC') {
        renderingControlHits += 1;
        res.writeHead(500).end();
        return;
      }

      if (req.url === '/ACT') {
        if (soapAction.includes('SetDevicePowerState') && body.includes('<devicePower>ON</devicePower>')) {
          actPowerOn = true;
          res.writeHead(200, { 'content-type': 'text/xml' });
          res.end('<s:Envelope><s:Body><u:SetDevicePowerStateResponse/></s:Body></s:Envelope>');
          return;
        }
        if (soapAction.includes('SetDevicePowerState') && body.includes('<devicePower>OFF</devicePower>')) {
          actPowerOn = false;
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
          capturedStreamUri = extractXmlTag(body, 'CurrentURI') ?? '';
          capturedDidlXml = extractXmlTag(body, 'CurrentURIMetaData') ?? '';
        } else if (soapAction.includes('#Play')) {
          transportState = 'PLAYING';
        } else if (soapAction.includes('#Pause')) {
          transportState = 'PAUSED_PLAYBACK';
        } else if (soapAction.includes('#Stop')) {
          transportState = 'STOPPED';
        } else if (soapAction.includes('#GetPositionInfo')) {
          res.writeHead(200, { 'content-type': 'text/xml' });
          res.end(
            `<s:Envelope><s:Body>` +
              `<TrackURI>${capturedStreamUri}</TrackURI>` +
              `<RelTime>${formatRelTime(positionMs)}</RelTime>` +
              `<TrackDuration>${formatRelTime(durationMs)}</TrackDuration>` +
              `</s:Body></s:Envelope>`,
          );
          return;
        } else if (soapAction.includes('#GetTransportInfo')) {
          res.writeHead(200, { 'content-type': 'text/xml' });
          res.end(
            `<s:Envelope><s:Body><CurrentTransportState>${transportState}</CurrentTransportState></s:Body></s:Envelope>`,
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

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
    server.once('error', reject);
  });

  const addr = server.address() as AddressInfo;
  const port = addr.port;
  const baseUrl = `http://127.0.0.1:${String(port)}`;
  const descUrl = `${baseUrl}/desc.xml`;

  return {
    port,
    baseUrl,
    descUrl,
    getCapturedStreamUri() {
      return capturedStreamUri;
    },
    getCapturedDidlXml() {
      return capturedDidlXml;
    },
    getReceivedSoapActions() {
      return [...receivedSoapActions];
    },
    assertValidDidlMetadata() {
      if (capturedDidlXml.trim().length === 0) {
        throw new Error('Assertion failed: Captured DIDL-Lite metadata was empty!');
      }
      if (!capturedDidlXml.includes('<DIDL-Lite')) {
        throw new Error('Assertion failed: Metadata did not contain <DIDL-Lite root tag!');
      }
      if (!capturedDidlXml.includes('<dc:title>')) {
        throw new Error('Assertion failed: Metadata did not contain track title tag!');
      }
    },
    assertZeroRenderingControlHits() {
      if (renderingControlHits > 0) {
        throw new Error(
          `Assertion failed: Law 1 Amp Invariant violated! RenderingControl endpoint was accessed ${String(
            renderingControlHits,
          )} times!`,
        );
      }
    },
    setTransportState(state: 'PLAYING' | 'PAUSED_PLAYBACK' | 'STOPPED') {
      transportState = state;
    },
    setPositionMs(pos: number, dur: number) {
      positionMs = pos;
      durationMs = dur;
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
