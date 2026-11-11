/**
 * Cast Pill & Extension Master Volume Unit Tests (Milestone 2).
 *
 * Verifies DOM structure, capability gating, 100ms debouncing, drag protection,
 * step button clamping, mute separation, and lifecycle disposal.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { setupSyntheticDomEnvironment, type SyntheticDomScope } from './e2e/harness/syntheticDomEnvironment.js';
import { ShadowDomCastPill, type CastPillCallbacks } from '../packages/extension/src/isolated-world/castPill.js';
import type {
  DiscoveredOutputEntry,
  ExtensionRuntimeRequest,
  ExtensionRuntimeResponse,
  ExtensionUiSnapshot,
} from '../packages/extension/src/shared/messages.js';
import { ExtensionBackgroundCoordinator } from '../packages/extension/src/background/serviceWorker.js';
import {
  createInMemoryStorageArea,
  updateEphemeralSessionState,
} from '../packages/extension/src/shared/storageSchema.js';
import { bootstrapPopup } from '../packages/extension/src/popup/popup.js';

function createMockOutputEntry(overrides?: {
  readonly id?: string;
  readonly kind?: 'heos_upnp' | 'coreaudio';
  readonly supportsHardwareVolume?: boolean;
}): DiscoveredOutputEntry {
  const kind = overrides?.kind ?? 'heos_upnp';
  const supportsHardwareVolume = overrides?.supportsHardwareVolume ?? (kind === 'heos_upnp');
  return {
    compositeKey: overrides?.id ?? 'heos-living-room',
    endpointBaseUrl: 'http://127.0.0.1:9876',
    receiverId: 'rcv_test_heos',
    receiverName: 'Test PM7000N',
    isLoopback: true,
    output: {
      id: overrides?.id ?? 'heos-living-room',
      name: 'Marantz PM7000N Living Room',
      kind,
      transport: 'heos_lan_wav',
      isAvailable: true,
      isRecommendedDefault: true,
      standbyState: 'on',
      capabilities: {
        bitPerfect: true,
        fixedGainDb: 0,
        targetSampleRateHz: 44100,
        targetBitDepth: 24,
        autoWakeFromStandby: false,
        displaysTrackMetadataOnDevice: true,
        seekDebounceMs: 250,
        supportsHardwareVolume,
      },
    },
  };
}

function createTestSnapshot(overrides?: Partial<ExtensionUiSnapshot>): ExtensionUiSnapshot {
  const defaultEntry = createMockOutputEntry();
  return {
    handoffEnabled: true,
    connectionState: 'connected',
    activeEndpointBaseUrl: 'http://127.0.0.1:9876',
    activeReceiverId: 'rcv_test_heos',
    activeReceiverName: 'Test PM7000N',
    activeOutputId: defaultEntry.output.id,
    activeOutput: defaultEntry.output,
    seekDebounceMs: 250,
    outputs: [defaultEntry],
    knownEndpoints: ['http://127.0.0.1:9876'],
    telemetry: null,
    lastAckedCommandSeq: 0,
    accountTier: 'go_plus',
    drmFallback: null,
    lastError: null,
    hardwareVolume: 45,
    hardwareMuted: false,
    ...overrides,
  };
}

describe('ShadowDomCastPill — Volume Architecture & Cast Pill UI', () => {
  let dom: SyntheticDomScope;

  beforeEach(() => {
    dom = setupSyntheticDomEnvironment();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    dom.teardown();
  });

  it('CP-VOL-01: constructs Cast Pill DOM tree with dedicated volume controls in shadow root', () => {
    const callbacks: CastPillCallbacks = {
      onToggleHandoff: vi.fn(),
      onSelectOutput: vi.fn(),
      onRefreshOutputs: vi.fn(),
      onSetVolume: vi.fn(),
    };

    const pill = new ShadowDomCastPill(callbacks);
    pill.mount();

    const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
    expect(host).not.toBeNull();
    const shadow = host?.shadowRoot;
    expect(shadow).not.toBeNull();

    // Pill shell quick vol indicator
    const quickVolBtn = shadow?.querySelector('.pill-quick-vol');
    expect(quickVolBtn).not.toBeNull();
    expect(quickVolBtn?.querySelector('.pill-quick-vol-text')).not.toBeNull();

    // Volume section inside flyout menu
    const volumeSection = shadow?.querySelector('.pill-volume');
    expect(volumeSection).not.toBeNull();
    expect(volumeSection?.querySelector('.pill-volume-badge')?.textContent).toBe('0 dB Bit-Perfect');
    expect(volumeSection?.querySelector('.pill-volume-title')?.textContent).toBe('Master Volume');
    expect(volumeSection?.querySelector('.pill-mute-btn')).not.toBeNull();
    expect(volumeSection?.querySelector('.pill-vol-down-btn')).not.toBeNull();
    expect(volumeSection?.querySelector('.pill-volume-slider')).not.toBeNull();
    expect(volumeSection?.querySelector('.pill-vol-up-btn')).not.toBeNull();
    expect(volumeSection?.querySelector('.pill-volume-label')).not.toBeNull();

    pill.dispose();
  });

  it('CP-VOL-02: keeps volume controls hidden when handoff is disabled or output lacks hardware volume', () => {
    const callbacks: CastPillCallbacks = {
      onToggleHandoff: vi.fn(),
      onSelectOutput: vi.fn(),
      onRefreshOutputs: vi.fn(),
      onSetVolume: vi.fn(),
    };

    const pill = new ShadowDomCastPill(callbacks);
    pill.mount();

    const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
    const shadow = host?.shadowRoot;
    const volumeSection = shadow?.querySelector('.pill-volume');
    const quickVolBtn = shadow?.querySelector('.pill-quick-vol');

    // Case A: handoff disabled
    pill.update(createTestSnapshot({ handoffEnabled: false }));
    expect(volumeSection?.hidden).toBe(true);
    expect(quickVolBtn?.hidden).toBe(true);

    // Case B: TOSLINK optical S/PDIF output (supportsHardwareVolume: false)
    const toslinkEntry = createMockOutputEntry({
      id: 'toslink-optical',
      kind: 'coreaudio',
      supportsHardwareVolume: false,
    });
    pill.update(
      createTestSnapshot({
        handoffEnabled: true,
        activeOutputId: toslinkEntry.output.id,
        activeOutput: toslinkEntry.output,
        outputs: [toslinkEntry],
      }),
    );
    expect(volumeSection?.hidden).toBe(true);
    expect(quickVolBtn?.hidden).toBe(true);

    pill.dispose();
  });

  it('CP-VOL-03: activates and populates volume controls when HEOS hardware volume is supported', () => {
    const callbacks: CastPillCallbacks = {
      onToggleHandoff: vi.fn(),
      onSelectOutput: vi.fn(),
      onRefreshOutputs: vi.fn(),
      onSetVolume: vi.fn(),
    };

    const pill = new ShadowDomCastPill(callbacks);
    pill.mount();

    const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
    const shadow = host?.shadowRoot;
    const volumeSection = shadow?.querySelector('.pill-volume');
    const quickVolBtn = shadow?.querySelector('.pill-quick-vol');
    const quickVolText = shadow?.querySelector('.pill-quick-vol-text');
    const slider = shadow?.querySelector('.pill-volume-slider');
    const label = shadow?.querySelector('.pill-volume-label');
    const muteBtn = shadow?.querySelector('.pill-mute-btn');

    pill.update(
      createTestSnapshot({
        handoffEnabled: true,
        hardwareVolume: 58,
        hardwareMuted: false,
      }),
    );

    expect(volumeSection?.hidden).toBe(false);
    expect(quickVolBtn?.hidden).toBe(false);
    expect(quickVolText?.textContent).toBe('58%');
    expect(slider?.value).toBe('58');
    expect(label?.textContent).toBe('58%');
    expect(muteBtn?.getAttribute('aria-pressed')).toBe('false');

    pill.dispose();
  });

  it('CP-VOL-04: opens flyout menu and triggers output refresh when quick volume button is clicked', () => {
    const onRefreshOutputs = vi.fn();
    const pill = new ShadowDomCastPill({
      onToggleHandoff: vi.fn(),
      onSelectOutput: vi.fn(),
      onRefreshOutputs,
      onSetVolume: vi.fn(),
    });
    pill.mount();

    pill.update(createTestSnapshot());

    const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
    const shadow = host?.shadowRoot;
    const quickVolBtn = shadow?.querySelector('.pill-quick-vol');
    const menu = shadow?.querySelector('.menu');
    const menuBtn = shadow?.querySelector('.pill-menu-btn');

    expect(menu?.hidden).toBe(true);

    quickVolBtn?.click();

    expect(menu?.hidden).toBe(false);
    expect(menuBtn?.getAttribute('aria-expanded')).toBe('true');
    expect(onRefreshOutputs).toHaveBeenCalledTimes(1);

    pill.dispose();
  });

  it('CP-VOL-05: debounces continuous slider input events by 100ms with immediate UI feedback', () => {
    const onSetVolume = vi.fn();
    const pill = new ShadowDomCastPill({
      onToggleHandoff: vi.fn(),
      onSelectOutput: vi.fn(),
      onRefreshOutputs: vi.fn(),
      onSetVolume,
    });
    pill.mount();
    pill.update(createTestSnapshot({ hardwareVolume: 30 }));

    const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
    const shadow = host?.shadowRoot;
    const slider = shadow?.querySelector('.pill-volume-slider');
    const label = shadow?.querySelector('.pill-volume-label');
    const quickVolText = shadow?.querySelector('.pill-quick-vol-text');

    expect(slider).not.toBeNull();
    if (slider) {
      slider.value = '55';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Synchronous immediate visual feedback (0ms latency)
    expect(label?.textContent).toBe('55%');
    expect(quickVolText?.textContent).toBe('55%');

    // Debounce guard: 50ms elapsed -> no IPC dispatched yet!
    vi.advanceTimersByTime(50);
    expect(onSetVolume).not.toHaveBeenCalled();

    // Debounce fires at 100ms
    vi.advanceTimersByTime(50);
    expect(onSetVolume).toHaveBeenCalledTimes(1);
    expect(onSetVolume).toHaveBeenCalledWith(55, undefined);

    pill.dispose();
  });

  it('CP-VOL-06: resets debounce timer on rapid slider input and emits only the final volume', () => {
    const onSetVolume = vi.fn();
    const pill = new ShadowDomCastPill({
      onToggleHandoff: vi.fn(),
      onSelectOutput: vi.fn(),
      onRefreshOutputs: vi.fn(),
      onSetVolume,
    });
    pill.mount();
    pill.update(createTestSnapshot({ hardwareVolume: 20 }));

    const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
    const shadow = host?.shadowRoot;
    const slider = shadow?.querySelector('.pill-volume-slider');

    // Rapid successive slider drags: 25 -> 35 -> 45 -> 72 within 40ms each
    slider!.value = '25';
    slider!.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(40);

    slider!.value = '35';
    slider!.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(40);

    slider!.value = '45';
    slider!.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(40);

    slider!.value = '72';
    slider!.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(40);

    expect(onSetVolume).not.toHaveBeenCalled();

    // Finish 100ms debounce from last event
    vi.advanceTimersByTime(60);
    expect(onSetVolume).toHaveBeenCalledTimes(1);
    expect(onSetVolume).toHaveBeenCalledWith(72, undefined);

    pill.dispose();
  });

  it('CP-VOL-07: cancels debounce timer and immediately commits on slider change event', () => {
    const onSetVolume = vi.fn();
    const pill = new ShadowDomCastPill({
      onToggleHandoff: vi.fn(),
      onSelectOutput: vi.fn(),
      onRefreshOutputs: vi.fn(),
      onSetVolume,
    });
    pill.mount();
    pill.update(createTestSnapshot({ hardwareVolume: 20 }));

    const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
    const shadow = host?.shadowRoot;
    const slider = shadow?.querySelector('.pill-volume-slider');

    slider!.value = '64';
    slider!.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(30);

    // User releases thumb (triggers 'change')
    slider!.dispatchEvent(new Event('change', { bubbles: true }));

    // Immediate dispatch on change
    expect(onSetVolume).toHaveBeenCalledTimes(1);
    expect(onSetVolume).toHaveBeenCalledWith(64, undefined);

    // Timer was cancelled: advancing 100ms does NOT fire duplicate command
    vi.advanceTimersByTime(100);
    expect(onSetVolume).toHaveBeenCalledTimes(1);

    pill.dispose();
  });

  it('CP-VOL-08: protects active slider drag from snapshot thumb snapback', () => {
    const onSetVolume = vi.fn();
    const pill = new ShadowDomCastPill({
      onToggleHandoff: vi.fn(),
      onSelectOutput: vi.fn(),
      onRefreshOutputs: vi.fn(),
      onSetVolume,
    });
    pill.mount();
    pill.update(createTestSnapshot({ hardwareVolume: 30 }));

    const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
    const shadow = host?.shadowRoot;
    const slider = shadow?.querySelector('.pill-volume-slider');
    const label = shadow?.querySelector('.pill-volume-label');
    const quickVolText = shadow?.querySelector('.pill-quick-vol-text');

    expect(slider?.value).toBe('30');
    expect(label?.textContent).toBe('30%');
    expect(quickVolText?.textContent).toBe('30%');

    // User begins dragging slider to 75
    slider!.value = '75';
    slider!.dispatchEvent(new Event('input', { bubbles: true }));

    // While isDragging is true, a background snapshot arrives with old volume 30
    pill.update(createTestSnapshot({ hardwareVolume: 30 }));

    // Invariant: slider value, label text, and quick volume MUST NOT snap back to 30 while user is dragging!
    expect(slider?.value).toBe('75');
    expect(label?.textContent).toBe('75%');
    expect(quickVolText?.textContent).toBe('75%');

    // Drag complete
    slider!.dispatchEvent(new Event('change', { bubbles: true }));

    // Now idle: subsequent snapshot updates slider smoothly
    pill.update(createTestSnapshot({ hardwareVolume: 80 }));
    expect(slider?.value).toBe('80');
    expect(label?.textContent).toBe('80%');
    expect(quickVolText?.textContent).toBe('80%');

    pill.dispose();
  });

  it('CP-VOL-09: step down button decrements volume by 2% clamped at 0% and cancels debounce', () => {
    const onSetVolume = vi.fn();
    const pill = new ShadowDomCastPill({
      onToggleHandoff: vi.fn(),
      onSelectOutput: vi.fn(),
      onRefreshOutputs: vi.fn(),
      onSetVolume,
    });
    pill.mount();
    pill.update(createTestSnapshot({ hardwareVolume: 3 }));

    const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
    const shadow = host?.shadowRoot;
    const volDownBtn = shadow?.querySelector('.pill-vol-down-btn');
    const slider = shadow?.querySelector('.pill-volume-slider');
    const label = shadow?.querySelector('.pill-volume-label');

    // First click: 3% -> 1%
    volDownBtn?.click();
    expect(slider?.value).toBe('1');
    expect(label?.textContent).toBe('1%');
    expect(onSetVolume).toHaveBeenCalledWith(1, undefined);

    // Second click: 1% -> 0% (clamped at 0)
    volDownBtn?.click();
    expect(slider?.value).toBe('0');
    expect(label?.textContent).toBe('0%');
    expect(onSetVolume).toHaveBeenCalledWith(0, undefined);

    // Third click: 0% -> 0% (still clamped at 0)
    volDownBtn?.click();
    expect(slider?.value).toBe('0');
    expect(label?.textContent).toBe('0%');
    expect(onSetVolume).toHaveBeenCalledWith(0, undefined);

    pill.dispose();
  });

  it('CP-VOL-10: step up button increments volume by 2% clamped at 100% and cancels debounce', () => {
    const onSetVolume = vi.fn();
    const pill = new ShadowDomCastPill({
      onToggleHandoff: vi.fn(),
      onSelectOutput: vi.fn(),
      onRefreshOutputs: vi.fn(),
      onSetVolume,
    });
    pill.mount();
    pill.update(createTestSnapshot({ hardwareVolume: 97 }));

    const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
    const shadow = host?.shadowRoot;
    const volUpBtn = shadow?.querySelector('.pill-vol-up-btn');
    const slider = shadow?.querySelector('.pill-volume-slider');
    const label = shadow?.querySelector('.pill-volume-label');

    // First click: 97% -> 99%
    volUpBtn?.click();
    expect(slider?.value).toBe('99');
    expect(label?.textContent).toBe('99%');
    expect(onSetVolume).toHaveBeenCalledWith(99, undefined);

    // Second click: 99% -> 100% (clamped at 100)
    volUpBtn?.click();
    expect(slider?.value).toBe('100');
    expect(label?.textContent).toBe('100%');
    expect(onSetVolume).toHaveBeenCalledWith(100, undefined);

    // Third click: 100% -> 100% (still clamped at 100)
    volUpBtn?.click();
    expect(slider?.value).toBe('100');
    expect(label?.textContent).toBe('100%');
    expect(onSetVolume).toHaveBeenCalledWith(100, undefined);

    pill.dispose();
  });

  it('CP-VOL-11: mute button toggles mute without sending volume payload (prevents PM7000N un-mute)', () => {
    const onSetVolume = vi.fn();
    const pill = new ShadowDomCastPill({
      onToggleHandoff: vi.fn(),
      onSelectOutput: vi.fn(),
      onRefreshOutputs: vi.fn(),
      onSetVolume,
    });
    pill.mount();
    pill.update(createTestSnapshot({ hardwareVolume: 42, hardwareMuted: false }));

    const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
    const shadow = host?.shadowRoot;
    const muteBtn = shadow?.querySelector('.pill-mute-btn');
    const quickVolText = shadow?.querySelector('.pill-quick-vol-text');

    expect(muteBtn?.getAttribute('aria-pressed')).toBe('false');
    expect(quickVolText?.textContent).toBe('42%');

    // Click mute: toggles to true
    muteBtn?.click();
    expect(muteBtn?.getAttribute('aria-pressed')).toBe('true');
    expect(quickVolText?.textContent).toBe('Muted');

    // CRITICAL INVARIANT: Volume MUST be undefined to prevent Marantz firmware from cancelling mute!
    expect(onSetVolume).toHaveBeenCalledWith(undefined, true);

    // Click mute again: toggles to false
    muteBtn?.click();
    expect(muteBtn?.getAttribute('aria-pressed')).toBe('false');
    expect(quickVolText?.textContent).toBe('42%');
    expect(onSetVolume).toHaveBeenCalledWith(undefined, false);

    pill.dispose();
  });

  it('CP-VOL-12: cleans up timers and elements cleanly on dispose', () => {
    const onSetVolume = vi.fn();
    const pill = new ShadowDomCastPill({
      onToggleHandoff: vi.fn(),
      onSelectOutput: vi.fn(),
      onRefreshOutputs: vi.fn(),
      onSetVolume,
    });
    pill.mount();
    pill.update(createTestSnapshot({ hardwareVolume: 20 }));

    const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
    const shadow = host?.shadowRoot;
    const slider = shadow?.querySelector('.pill-volume-slider');

    // Schedule debounced command
    slider!.value = '88';
    slider!.dispatchEvent(new Event('input', { bubbles: true }));

    const removeSpy = vi.spyOn(dom.document, 'removeEventListener');

    // Dispose before timer completes
    pill.dispose();

    expect(removeSpy).toHaveBeenCalledWith('click', expect.any(Function));

    // Verify element is removed from DOM
    expect(dom.document.body.querySelector('[data-soundclud-cast-pill]')).toBeNull();

    // Advancing timers does NOT fire the orphaned callback
    vi.advanceTimersByTime(200);
    expect(onSetVolume).not.toHaveBeenCalled();
  });
});

describe('ExtensionBackgroundCoordinator — handleRequest("set_volume")', () => {
  let storage: { local: ReturnType<typeof createInMemoryStorageArea>; session: ReturnType<typeof createInMemoryStorageArea> };
  let coordinator: ExtensionBackgroundCoordinator;

  beforeEach(() => {
    storage = {
      local: createInMemoryStorageArea(),
      session: createInMemoryStorageArea(),
    };
    coordinator = new ExtensionBackgroundCoordinator({
      storage,
    });
  });

  it('SW-VOL-01: rejects request when neither volume nor muted is provided', async () => {
    const res = await coordinator.handleRequest({ type: 'set_volume' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe("At least one of 'volume' or 'muted' must be specified");
    }
  });

  it('SW-VOL-02: rejects request when volume is out of range or non-integer', async () => {
    const resNegative = await coordinator.handleRequest({ type: 'set_volume', volume: -1 });
    expect(resNegative.ok).toBe(false);
    if (!resNegative.ok) {
      expect(resNegative.error).toBe('Volume must be an integer between 0 and 100');
    }

    const resOverflow = await coordinator.handleRequest({ type: 'set_volume', volume: 101 });
    expect(resOverflow.ok).toBe(false);
    if (!resOverflow.ok) {
      expect(resOverflow.error).toBe('Volume must be an integer between 0 and 100');
    }

    const resFloat = await coordinator.handleRequest({ type: 'set_volume', volume: 45.5 });
    expect(resFloat.ok).toBe(false);
    if (!resFloat.ok) {
      expect(resFloat.error).toBe('Volume must be an integer between 0 and 100');
    }
  });

  it('SW-VOL-03: rejects request when muted is not a boolean', async () => {
    const resInvalidMute = await coordinator.handleRequest({
      type: 'set_volume',
      muted: 'yes' as unknown as boolean,
    });
    expect(resInvalidMute.ok).toBe(false);
    if (!resInvalidMute.ok) {
      expect(resInvalidMute.error).toBe('Muted must be a boolean');
    }
  });

  it('SW-VOL-04: dispatches volume-only command with allocated commandSeq', async () => {
    const sendCommandSpy = vi
      .spyOn(coordinator.getWsController(), 'sendCommand')
      .mockResolvedValue(true);

    const res = await coordinator.handleRequest({ type: 'set_volume', volume: 65 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.snapshot.hardwareVolume).toBe(65);
    }
    expect(sendCommandSpy).toHaveBeenCalledTimes(1);
    const sentCommand = sendCommandSpy.mock.calls[0]?.[0];
    expect(sentCommand?.type).toBe('set_volume');
    expect((sentCommand as any)?.volume).toBe(65);
    expect((sentCommand as any)?.muted).toBeUndefined();
    expect(typeof (sentCommand as any)?.commandSeq).toBe('number');
  });

  it('SW-VOL-05: dispatches mute-only command with allocated commandSeq', async () => {
    const sendCommandSpy = vi
      .spyOn(coordinator.getWsController(), 'sendCommand')
      .mockResolvedValue(true);

    const res = await coordinator.handleRequest({ type: 'set_volume', muted: true });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.snapshot.hardwareMuted).toBe(true);
    }
    expect(sendCommandSpy).toHaveBeenCalledTimes(1);
    const sentCommand = sendCommandSpy.mock.calls[0]?.[0];
    expect(sentCommand?.type).toBe('set_volume');
    expect((sentCommand as any)?.muted).toBe(true);
    expect((sentCommand as any)?.volume).toBeUndefined();
    expect(typeof (sentCommand as any)?.commandSeq).toBe('number');
  });

  it('SW-VOL-06: returns error when wsController fails to deliver command', async () => {
    vi.spyOn(coordinator.getWsController(), 'sendCommand').mockResolvedValue(false);

    const res = await coordinator.handleRequest({ type: 'set_volume', volume: 50 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('Failed to deliver volume command to receiver');
    }
  });

  it('SW-VOL-07: returns optimistic snapshot with updated volume/mute state on set_volume completion to prevent step-button snapback', async () => {
    // 1. Seed initial session state with volume 50 and unmuted
    await updateEphemeralSessionState(storage.session, (prev) => ({
      ...prev,
      hardwareVolume: 50,
      hardwareMuted: false,
    }));

    const sendCommandSpy = vi
      .spyOn(coordinator.getWsController(), 'sendCommand')
      .mockResolvedValue(true);

    // Initial snapshot reflects seeded state
    const initialSnapshot = await coordinator.getSnapshot();
    expect(initialSnapshot.hardwareVolume).toBe(50);
    expect(initialSnapshot.hardwareMuted).toBe(false);

    // 2. User clicks step down button (50 -> 48)
    const stepDownRes = await coordinator.handleRequest({
      type: 'set_volume',
      volume: 48,
    });

    expect(stepDownRes.ok).toBe(true);
    expect(sendCommandSpy).toHaveBeenCalledTimes(1);

    // Crucial Invariant: returned snapshot MUST be optimistic (48), preventing UI snapback to 50
    expect(stepDownRes.snapshot?.hardwareVolume).toBe(48);
    expect(stepDownRes.snapshot?.hardwareMuted).toBe(false);

    // Verify session storage was updated optimistically
    const midSnapshot = await coordinator.getSnapshot();
    expect(midSnapshot.hardwareVolume).toBe(48);
    expect(midSnapshot.hardwareMuted).toBe(false);

    // 3. User clicks mute button (mute: true, volume omitted)
    const muteRes = await coordinator.handleRequest({
      type: 'set_volume',
      muted: true,
    });

    expect(muteRes.ok).toBe(true);
    expect(sendCommandSpy).toHaveBeenCalledTimes(2);

    // Optimistic snapshot reflects muted: true while preserving volume 48
    expect(muteRes.snapshot?.hardwareMuted).toBe(true);
    expect(muteRes.snapshot?.hardwareVolume).toBe(48);

    // 4. User clicks step up button (48 -> 50, mute omitted)
    const stepUpRes = await coordinator.handleRequest({
      type: 'set_volume',
      volume: 50,
    });

    expect(stepUpRes.ok).toBe(true);
    expect(sendCommandSpy).toHaveBeenCalledTimes(3);

    // Optimistic snapshot reflects volume 50 while preserving muted: true
    expect(stepUpRes.snapshot?.hardwareVolume).toBe(50);
    expect(stepUpRes.snapshot?.hardwareMuted).toBe(true);
  });

  it('SW-VOL-08: does not mutate session state when sendCommand delivery fails', async () => {
    vi.spyOn(coordinator.getWsController(), 'sendCommand').mockResolvedValue(false);

    const res = await coordinator.handleRequest({ type: 'set_volume', volume: 99 });
    expect(res.ok).toBe(false);

    const snapshot = await coordinator.getSnapshot();
    expect(snapshot.hardwareVolume).not.toBe(99);
  });
});

describe('Extension Popup — Volume Architecture & Drag Isolation', () => {
  let dom: SyntheticDomScope;
  let originalChrome: unknown;
  let sentRequests: ExtensionRuntimeRequest[];

  beforeEach(() => {
    dom = setupSyntheticDomEnvironment();
    (dom.document as any).getElementById = (id: string) =>
      dom.document.querySelector('#' + id);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    sentRequests = [];

    // Mock chrome extension runtime APIs
    originalChrome = (globalThis as any).chrome;
    (globalThis as any).chrome = {
      runtime: {
        sendMessage: vi.fn(async (req: ExtensionRuntimeRequest): Promise<ExtensionRuntimeResponse> => {
          sentRequests.push(req);
          return { ok: true, snapshot: createTestSnapshot() };
        }),
        connect: vi.fn(() => ({
          name: 'soundclud-popup',
          onMessage: { addListener: vi.fn() },
          disconnect: vi.fn(),
        })),
      },
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    (globalThis as any).chrome = originalChrome;
    dom.teardown();
  });

  it('POPUP-VOL-01: routes slider input through 100ms debounce and sends volume-only request', async () => {
    const card = dom.document.createElement('div');
    card.id = 'amp-volume-card';
    const slider = dom.document.createElement('input');
    slider.id = 'amp-volume-slider';
    slider.setAttribute('type', 'range');
    slider.setAttribute('value', '25');
    const label = dom.document.createElement('span');
    label.id = 'amp-volume-label';
    label.textContent = '25%';

    dom.document.body.append(card, slider, label);

    bootstrapPopup();
    // Flush initial get_ui_snapshot / discover_outputs
    await vi.runAllTicks();
    sentRequests.length = 0;

    // Simulate slider drag to 68%
    slider.value = '68';
    slider.dispatchEvent(new Event('input', { bubbles: true }));

    // Synchronous label update
    expect(label.textContent).toBe('68%');

    // 50ms: not yet sent
    vi.advanceTimersByTime(50);
    expect(sentRequests).toHaveLength(0);

    // 100ms: debounced send
    vi.advanceTimersByTime(50);
    expect(sentRequests).toHaveLength(1);
    expect(sentRequests[0]).toEqual({
      type: 'set_volume',
      volume: 68,
    });
    // Law 1: muted MUST be omitted!
    expect((sentRequests[0] as any)?.muted).toBeUndefined();
  });

  it('POPUP-VOL-02: routes mute button click with muted-only payload (omits volume to prevent PM7000N un-mute)', async () => {
    const card = dom.document.createElement('div');
    card.id = 'amp-volume-card';
    const muteBtn = dom.document.createElement('button');
    muteBtn.id = 'amp-mute-btn';
    muteBtn.setAttribute('aria-pressed', 'false');

    dom.document.body.append(card, muteBtn);

    bootstrapPopup();
    await vi.runAllTicks();
    sentRequests.length = 0;

    muteBtn.click();

    expect(muteBtn.getAttribute('aria-pressed')).toBe('true');
    expect(sentRequests).toHaveLength(1);
    expect(sentRequests[0]).toEqual({
      type: 'set_volume',
      muted: true,
    });
    // CRITICAL: volume MUST be omitted!
    expect((sentRequests[0] as any)?.volume).toBeUndefined();
  });

  it('POPUP-VOL-03: routes step buttons with clamped volume values and omits muted', async () => {
    const card = dom.document.createElement('div');
    card.id = 'amp-volume-card';
    const slider = dom.document.createElement('input');
    slider.id = 'amp-volume-slider';
    slider.setAttribute('type', 'range');
    slider.setAttribute('value', '25');
    const label = dom.document.createElement('span');
    label.id = 'amp-volume-label';
    label.textContent = '25%';
    const downBtn = dom.document.createElement('button');
    downBtn.id = 'amp-vol-down-btn';
    const upBtn = dom.document.createElement('button');
    upBtn.id = 'amp-vol-up-btn';

    dom.document.body.append(card, slider, label, downBtn, upBtn);

    bootstrapPopup();
    await vi.runAllTicks();
    sentRequests.length = 0;

    // Step down: 25 -> 23
    downBtn.click();
    expect(slider.value).toBe('23');
    expect(label.textContent).toBe('23%');
    expect(sentRequests).toHaveLength(1);
    expect(sentRequests[0]).toEqual({ type: 'set_volume', volume: 23 });

    // Step up: 23 -> 25
    upBtn.click();
    expect(slider.value).toBe('25');
    expect(label.textContent).toBe('25%');
    expect(sentRequests).toHaveLength(2);
    expect(sentRequests[1]).toEqual({ type: 'set_volume', volume: 25 });
  });

  it('POPUP-VOL-04: enforces zero direct HTTP fetch calls in popup.ts (100% IPC routing)', async () => {
    const fetchSpy = vi.fn();
    (globalThis as any).fetch = fetchSpy;

    const card = dom.document.createElement('div');
    card.id = 'amp-volume-card';
    const slider = dom.document.createElement('input');
    slider.id = 'amp-volume-slider';
    slider.setAttribute('type', 'range');
    const muteBtn = dom.document.createElement('button');
    muteBtn.id = 'amp-mute-btn';

    dom.document.body.append(card, slider, muteBtn);

    bootstrapPopup();
    await vi.runAllTicks();

    slider.value = '40';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(100);

    muteBtn.click();

    // Invariant: zero direct fetch calls from popup.ts!
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sentRequests.length).toBeGreaterThanOrEqual(2);
  });
});
