import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  API_V1_AUDIO_VOLUME_PATH,
  parseClientWsCommand,
  parseSetVolumeRequest,
} from '@soundclud/protocol';
import { ShadowDomCastPill } from '@soundclud/extension';
import {
  deriveUiSnapshot,
  createDefaultDurableLocalConfig,
  createDefaultEphemeralSessionState,
} from '../../../packages/extension/src/shared/storageSchema.js';
import {
  createMockHeosCliServer,
  createMockReceiverServer,
  setupSyntheticDomEnvironment,
  stopAllResources,
  SYNTHETIC_OUTPUT_HEOS,
  SYNTHETIC_OUTPUT_TOSLINK,
  SYNTHETIC_PAIRING_TOKEN,
  type ClosableResource,
  type SyntheticElement,
} from '../harness/index.js';

function sendTcpCommand(port: number, command: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(command.endsWith('\r\n') ? command : `${command}\r\n`);
    });
    let data = '';
    const timeout = setTimeout(() => {
      sock.destroy();
      reject(new Error(`Timeout waiting for TCP response on port ${port}`));
    }, 2000);

    sock.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (data.includes('\r\n')) {
        clearTimeout(timeout);
        sock.end();
        resolve(data.trim());
      }
    });
    sock.once('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

describe('Tier 2: Volume & Mute Boundaries, Off-By-One & Edge Cases', () => {
  const closables: ClosableResource[] = [];

  afterEach(async () => {
    vi.useRealTimers();
    vi.clearAllTimers();
    await stopAllResources(closables);
    closables.length = 0;
  });

  describe('Protocol Schema & REST Value Boundaries', () => {
    it('T2-F01-01: accepts minimum allowed volume boundary (volume: 0)', () => {
      const parsedWs = parseClientWsCommand({
        type: 'set_volume',
        commandSeq: 301,
        volume: 0,
      });

      expect(parsedWs.ok).toBe(true);
      if (parsedWs.ok && parsedWs.value.type === 'set_volume') {
        expect(parsedWs.value.volume).toBe(0);
      }

      const parsedRest = parseSetVolumeRequest({ volume: 0 });
      expect(parsedRest.ok).toBe(true);
      if (parsedRest.ok) {
        expect(parsedRest.value.volume).toBe(0);
      }
    });

    it('T2-F01-02: accepts maximum allowed volume boundary (volume: 100)', () => {
      const parsedWs = parseClientWsCommand({
        type: 'set_volume',
        commandSeq: 302,
        volume: 100,
      });

      expect(parsedWs.ok).toBe(true);
      if (parsedWs.ok && parsedWs.value.type === 'set_volume') {
        expect(parsedWs.value.volume).toBe(100);
      }

      const parsedRest = parseSetVolumeRequest({ volume: 100 });
      expect(parsedRest.ok).toBe(true);
      if (parsedRest.ok) {
        expect(parsedRest.value.volume).toBe(100);
      }
    });

    it('T2-F01-03: rejects below-minimum volume (volume: -1) with descriptive error', () => {
      const parsedWs = parseClientWsCommand({
        type: 'set_volume',
        commandSeq: 303,
        volume: -1,
      });

      expect(parsedWs.ok).toBe(false);
      if (!parsedWs.ok) {
        expect(parsedWs.error).toContain('volume');
      }

      const parsedRest = parseSetVolumeRequest({ volume: -1 });
      expect(parsedRest.ok).toBe(false);
    });

    it('T2-F01-04: rejects above-maximum volume (volume: 101) with descriptive error', () => {
      const parsedWs = parseClientWsCommand({
        type: 'set_volume',
        commandSeq: 304,
        volume: 101,
      });

      expect(parsedWs.ok).toBe(false);
      if (!parsedWs.ok) {
        expect(parsedWs.error).toContain('volume between 0 and 100');
      }

      const parsedRest = parseSetVolumeRequest({ volume: 101 });
      expect(parsedRest.ok).toBe(false);
    });

    it('T2-F01-05: rejects empty payload missing both volume and muted', async () => {
      const parsedWs = parseClientWsCommand({
        type: 'set_volume',
        commandSeq: 305,
      });
      expect(parsedWs.ok).toBe(false);
      if (!parsedWs.ok) {
        expect(parsedWs.error).toContain('either volume or muted must be provided');
      }

      const parsedRest = parseSetVolumeRequest({});
      expect(parsedRest.ok).toBe(false);

      const receiver = await createMockReceiverServer();
      closables.push(receiver);

      const res = await fetch(`${receiver.baseUrl}${API_V1_AUDIO_VOLUME_PATH}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${SYNTHETIC_PAIRING_TOKEN}`,
        },
        body: JSON.stringify({}),
      });

      expect(res.status).toBe(400);
      const data = (await res.json()) as { error: { code: string } };
      expect(data.error.code).toBe('INVALID_PAYLOAD');
    });
  });

  describe('Hardware Execution Edge Conditions', () => {
    it('T2-F03-01: executes mute on uninitialized hardware volume without jumping to default 25%', async () => {
      const cli = await createMockHeosCliServer({ initialVolume: 42, initialMuted: false });
      closables.push(cli);

      // Trigger mute over live TCP socket
      const resp = await sendTcpCommand(cli.port, 'heos://player/set_mute?pid=1&state=on');
      const parsed = JSON.parse(resp) as { heos: { result: string } };
      expect(parsed.heos.result).toBe('success');

      expect(cli.currentMuted).toBe(true);
      expect(cli.currentVolume).toBe(42);
      expect(cli.currentVolume).not.toBe(25);
    });

    it('T2-F03-02: executes volume 0 on muted hardware preserving mute state', async () => {
      const cli = await createMockHeosCliServer({ initialVolume: 35, initialMuted: true });
      closables.push(cli);

      // Send volume 0 over live TCP socket
      const resp = await sendTcpCommand(cli.port, 'heos://player/set_volume?pid=1&level=0');
      const parsed = JSON.parse(resp) as { heos: { result: string } };
      expect(parsed.heos.result).toBe('success');

      expect(cli.currentVolume).toBe(0);
      expect(cli.currentMuted).toBe(true);
    });

    it('T2-F03-03: rejects volume adjustment for nonexistent output target with HTTP 404', async () => {
      const receiver = await createMockReceiverServer();
      closables.push(receiver);

      const res = await fetch(`${receiver.baseUrl}/api/v1/outputs/unknown_output/volume`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${SYNTHETIC_PAIRING_TOKEN}`,
        },
        body: JSON.stringify({ volume: 50 }),
      });

      expect(res.status).toBe(404);
    });

    it('T2-F03-04: handles rapid mute flaps (10 toggles in rapid succession) without socket reset', async () => {
      const cli = await createMockHeosCliServer({ initialVolume: 30, initialMuted: false });
      closables.push(cli);

      for (let i = 0; i < 10; i += 1) {
        const nextState = i % 2 === 0 ? 'on' : 'off';
        const resp = await sendTcpCommand(cli.port, `heos://player/set_mute?pid=1&state=${nextState}`);
        expect(resp).toContain('"result":"success"');
      }

      expect(cli.currentMuted).toBe(false); // 10 toggles ends on off (false)
      expect(cli.currentVolume).toBe(30);
    });

    it('T2-F03-05: rejects volume adjustment when output target does not support hardware volume', async () => {
      const receiver = await createMockReceiverServer();
      closables.push(receiver);

      const ws = new WebSocket(receiver.wsUrl);
      const errorPromise = new Promise<{ code: string; message: string }>((resolve) => {
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: 'hello' }));
        };
        ws.onmessage = (e) => {
          const msg = JSON.parse(String(e.data));
          if (msg.type === 'error') {
            resolve({ code: msg.code, message: msg.message });
          }
        };
      });

      await new Promise<void>((r) => {
        ws.onopen = () => r();
      });

      // Switch to TOSLINK (supportsHardwareVolume: false)
      ws.send(JSON.stringify({ type: 'select_output', commandSeq: 1, outputId: 'coreaudio:spdf' }));
      // Attempt volume adjustment on TOSLINK
      ws.send(JSON.stringify({ type: 'set_volume', commandSeq: 2, volume: 50 }));

      const err = await errorPromise;
      expect(err.code).toBe('set_volume_failed');
      expect(err.message).toContain('Hardware volume control is not supported on this output');

      ws.close();
    });
  });

  describe('Extension UI Slider & Cast Pill Boundaries', () => {
    function createTestSnapshot(vol: number, muted = false) {
      const local = {
        ...createDefaultDurableLocalConfig(),
        handoffEnabled: true,
        activeReceiverId: 'rcv-1',
        activeEndpointBaseUrl: 'http://127.0.0.1:9876',
        activeOutputId: SYNTHETIC_OUTPUT_HEOS.id,
      };
      const session = {
        ...createDefaultEphemeralSessionState(),
        connectionState: 'connected' as const,
        discoveredReceivers: [
          {
            receiverId: 'rcv-1',
            receiverName: 'Synthetic Receiver',
            endpointBaseUrl: 'http://127.0.0.1:9876',
            host: '127.0.0.1',
            port: 9876,
            isLoopback: true,
            requiresPairing: false,
            discoveredAtMs: Date.now(),
            outputs: [SYNTHETIC_OUTPUT_HEOS],
          },
        ],
        hardwareVolume: vol,
        hardwareMuted: muted,
      };
      return deriveUiSnapshot(local, session);
    }

    it('T2-F10-01: clamps step-down at minimum boundary volume 0 via ShadowDomCastPill step button', () => {
      const dom = setupSyntheticDomEnvironment();
      try {
        const onSetVolume = vi.fn();
        const pill = new ShadowDomCastPill({
          onToggleHandoff: vi.fn(),
          onSelectOutput: vi.fn(),
          onRefreshOutputs: vi.fn(),
          onSetVolume,
        });
        pill.mount();

        // Seed with hardwareVolume: 1 (near lower boundary)
        pill.update(createTestSnapshot(1));

        const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
        const shadow = host?.shadowRoot;
        const volDownBtn = shadow?.querySelector('.pill-vol-down-btn');
        const slider = shadow?.querySelector<SyntheticElement>('.pill-volume-slider');
        const label = shadow?.querySelector('.pill-volume-label');

        // First click: 1% - 2% -> clamped at 0%
        volDownBtn?.click();
        expect(slider?.value).toBe('0');
        expect(label?.textContent).toBe('0%');
        expect(onSetVolume).toHaveBeenCalledWith(0, undefined);

        // Second click: 0% - 2% -> strictly clamped at 0%
        volDownBtn?.click();
        expect(slider?.value).toBe('0');
        expect(label?.textContent).toBe('0%');
        expect(onSetVolume).toHaveBeenLastCalledWith(0, undefined);
        expect(Number(slider?.value)).not.toBeLessThan(0);

        pill.dispose();
      } finally {
        dom.teardown();
      }
    });

    it('T2-F10-02: clamps step-up at maximum boundary volume 100 via ShadowDomCastPill step button', () => {
      const dom = setupSyntheticDomEnvironment();
      try {
        const onSetVolume = vi.fn();
        const pill = new ShadowDomCastPill({
          onToggleHandoff: vi.fn(),
          onSelectOutput: vi.fn(),
          onRefreshOutputs: vi.fn(),
          onSetVolume,
        });
        pill.mount();

        // Seed with hardwareVolume: 99 (near upper boundary)
        pill.update(createTestSnapshot(99));

        const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
        const shadow = host?.shadowRoot;
        const volUpBtn = shadow?.querySelector('.pill-vol-up-btn');
        const slider = shadow?.querySelector<SyntheticElement>('.pill-volume-slider');
        const label = shadow?.querySelector('.pill-volume-label');

        // First click: 99% + 2% -> clamped at 100%
        volUpBtn?.click();
        expect(slider?.value).toBe('100');
        expect(label?.textContent).toBe('100%');
        expect(onSetVolume).toHaveBeenCalledWith(100, undefined);

        // Second click: 100% + 2% -> strictly clamped at 100%
        volUpBtn?.click();
        expect(slider?.value).toBe('100');
        expect(label?.textContent).toBe('100%');
        expect(onSetVolume).toHaveBeenLastCalledWith(100, undefined);
        expect(Number(slider?.value)).not.toBeGreaterThan(100);

        pill.dispose();
      } finally {
        dom.teardown();
      }
    });

    it('T2-F10-03: rapid step clicks immediately cancel debounce and commit accumulated step adjustments', () => {
      vi.useFakeTimers();
      const dom = setupSyntheticDomEnvironment();
      try {
        const onSetVolume = vi.fn();
        const pill = new ShadowDomCastPill({
          onToggleHandoff: vi.fn(),
          onSelectOutput: vi.fn(),
          onRefreshOutputs: vi.fn(),
          onSetVolume,
        });
        pill.mount();

        pill.update(createTestSnapshot(50));

        const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
        const shadow = host?.shadowRoot;
        const volUpBtn = shadow?.querySelector('.pill-vol-up-btn');
        const slider = shadow?.querySelector<SyntheticElement>('.pill-volume-slider');

        // User drags slider to 60 (initiating 100ms debounce timer)
        slider!.value = '60';
        slider!.dispatchEvent(new Event('input', { bubbles: true }));
        vi.advanceTimersByTime(40);
        expect(onSetVolume).not.toHaveBeenCalled();

        // Rapid step up clicks: cancels pending debounce and immediately commits step increments
        volUpBtn?.click(); // 60 -> 62
        volUpBtn?.click(); // 62 -> 64
        volUpBtn?.click(); // 64 -> 66

        expect(onSetVolume).toHaveBeenCalledTimes(3);
        expect(onSetVolume).toHaveBeenLastCalledWith(66, undefined);
        expect(slider?.value).toBe('66');

        // Advancing past original debounce window fires no duplicate or stale calls
        vi.advanceTimersByTime(120);
        expect(onSetVolume).toHaveBeenCalledTimes(3);

        pill.dispose();
      } finally {
        vi.useRealTimers();
        dom.teardown();
      }
    });

    it('T2-F10-04: throttles 50 rapid slider drag input events delivering only trailing value via ShadowDomCastPill', () => {
      vi.useFakeTimers();
      const dom = setupSyntheticDomEnvironment();
      try {
        const onSetVolume = vi.fn();
        const pill = new ShadowDomCastPill({
          onToggleHandoff: vi.fn(),
          onSelectOutput: vi.fn(),
          onRefreshOutputs: vi.fn(),
          onSetVolume,
        });
        pill.mount();

        pill.update(createTestSnapshot(10));

        const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
        const shadow = host?.shadowRoot;
        const slider = shadow?.querySelector<SyntheticElement>('.pill-volume-slider');
        const label = shadow?.querySelector('.pill-volume-label');

        expect(slider).not.toBeNull();

        // Dispatch 50 rapid input events within debounce window (1ms apart, total 50ms < 100ms debounce)
        for (let i = 1; i <= 50; i += 1) {
          slider!.value = String(i);
          slider!.dispatchEvent(new Event('input', { bubbles: true }));
          vi.advanceTimersByTime(1);
        }

        // Debounce timer is still active: onSetVolume must NOT have fired yet!
        expect(onSetVolume).not.toHaveBeenCalled();
        expect(label?.textContent).toBe('50%');

        // Advance timers by 200ms (safely exceeding 100ms debounce threshold)
        vi.advanceTimersByTime(200);

        // Exactly one call delivered with trailing value 50
        expect(onSetVolume).toHaveBeenCalledTimes(1);
        expect(onSetVolume).toHaveBeenCalledWith(50, undefined);
        expect(slider?.value).toBe('50');

        pill.dispose();
      } finally {
        vi.useRealTimers();
        dom.teardown();
      }
    });

    it('T2-F10-05: preserves volume state across DOM detach and reattachment via ShadowDomCastPill', () => {
      const dom = setupSyntheticDomEnvironment();
      try {
        const onSetVolume = vi.fn();
        const pill = new ShadowDomCastPill({
          onToggleHandoff: vi.fn(),
          onSelectOutput: vi.fn(),
          onRefreshOutputs: vi.fn(),
          onSetVolume,
        });
        pill.mount();

        pill.update(createTestSnapshot(68));

        const host = dom.document.body.querySelector<SyntheticElement>('[data-soundclud-cast-pill]');
        expect(host).not.toBeNull();
        expect(host?.isConnected).toBe(true);

        const slider = host?.shadowRoot?.querySelector<SyntheticElement>('.pill-volume-slider');
        const label = host?.shadowRoot?.querySelector('.pill-volume-label');
        expect(slider?.value).toBe('68');
        expect(label?.textContent).toBe('68%');

        // Detach host element from DOM
        host?.remove();
        expect(host?.isConnected).toBe(false);

        // Reattach host element to DOM
        dom.document.body.append(host!);
        expect(host?.isConnected).toBe(true);

        // Verify volume state and label are fully preserved
        expect(slider?.value).toBe('68');
        expect(label?.textContent).toBe('68%');

        pill.dispose();
      } finally {
        dom.teardown();
      }
    });
  });
});
