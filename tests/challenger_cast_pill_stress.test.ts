/**
 * Challenger Adversarial Stress Test Suite: Milestone 2 Cast Pill Volume Architecture.
 *
 * Empirically challenges and stress-tests:
 * 1. Rapid Slider Dragging: 100 rapid input events in 50ms window -> exactly 1 IPC call at 100ms.
 * 2. Drag Isolation Under Snapshot Flooding: conflicting telemetry during active drag never corrupts slider thumb.
 * 3. Boundary Clamping: rapid step-down past 0 clamped at 0, rapid step-up past 100 clamped at 100.
 * 4. Rapid Lifecycle Mounting/Disposing: 50 instances mounted and disposed rapidly with active debounce timers.
 * 5. Immediate Interactive Cancellation: step buttons, mute toggle, and change events cancel pending debounce timers.
 * 6. Telemetry Label Snapback Under Snapshot Flooding: label and quick-vol lock at dragged value with zero flicker.
 * 7. Concurrent Multi-Instance Mounting & Teardown: 50 concurrent instances isolate listeners and leave 0 leaks.
 * 8. Boundary Drag at 0% and Muted Drag Isolation: edge cases maintain visual and functional invariants.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { setMaxListeners } from 'node:events';
import { setupSyntheticDomEnvironment, type SyntheticDomScope } from './e2e/harness/syntheticDomEnvironment.js';
import { ShadowDomCastPill, type CastPillCallbacks } from '../packages/extension/src/isolated-world/castPill.js';
import type {
  DiscoveredOutputEntry,
  ExtensionUiSnapshot,
} from '../packages/extension/src/shared/messages.js';

function createMockOutputEntry(overrides?: {
  readonly id?: string;
  readonly kind?: 'heos_upnp' | 'coreaudio';
  readonly supportsHardwareVolume?: boolean;
}): DiscoveredOutputEntry {
  const kind = overrides?.kind ?? 'heos_upnp';
  const supportsHardwareVolume = overrides?.supportsHardwareVolume ?? (kind === 'heos_upnp');
  return {
    compositeKey: overrides?.id ?? 'heos-stress-device',
    endpointBaseUrl: 'http://127.0.0.1:9876',
    receiverId: 'rcv_test_heos',
    receiverName: 'Marantz PM7000N Stress Target',
    isLoopback: true,
    output: {
      id: overrides?.id ?? 'heos-stress-device',
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

function createStressSnapshot(overrides?: Partial<ExtensionUiSnapshot>): ExtensionUiSnapshot {
  const defaultEntry = createMockOutputEntry();
  return {
    handoffEnabled: true,
    connectionState: 'connected',
    activeEndpointBaseUrl: 'http://127.0.0.1:9876',
    activeReceiverId: 'rcv_test_heos',
    activeReceiverName: 'Marantz PM7000N Stress Target',
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
    hardwareVolume: 40,
    hardwareMuted: false,
    ...overrides,
  };
}

describe('Challenger 1: Cast Pill Master Volume Adversarial Stress Harness', () => {
  let dom: SyntheticDomScope;

  beforeEach(() => {
    dom = setupSyntheticDomEnvironment();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
    dom.teardown();
  });

  // =========================================================================
  // Requirement 1: Rapid Slider Dragging
  // =========================================================================
  it('ADV-VOL-01: absorbs 100 rapid input events in 50ms and emits exactly ONE debounced IPC call 100ms after last event', () => {
    const onSetVolume = vi.fn();
    const callbacks: CastPillCallbacks = {
      onToggleHandoff: vi.fn(),
      onSelectOutput: vi.fn(),
      onRefreshOutputs: vi.fn(),
      onSetVolume,
    };

    const pill = new ShadowDomCastPill(callbacks);
    pill.mount();
    pill.update(createStressSnapshot({ hardwareVolume: 20 }));

    const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
    expect(host).not.toBeNull();
    const slider = host?.shadowRoot?.querySelector('.pill-volume-slider');
    const label = host?.shadowRoot?.querySelector('.pill-volume-label');
    expect(slider).not.toBeNull();
    expect(label).not.toBeNull();

    // Fire 100 rapid input events within a simulated 50ms window (2 events per millisecond across 50ms)
    for (let step = 0; step < 50; step++) {
      const val1 = step * 2 + 1;
      slider!.value = String(val1);
      slider!.dispatchEvent(new Event('input', { bubbles: true }));
      expect(label?.textContent).toBe(`${val1}%`);

      const val2 = step * 2 + 2;
      slider!.value = String(val2);
      slider!.dispatchEvent(new Event('input', { bubbles: true }));
      expect(label?.textContent).toBe(`${val2}%`);

      // Invariant: no IPC message dispatched during scrubbing burst
      expect(onSetVolume).not.toHaveBeenCalled();

      if (step < 49) {
        vi.advanceTimersByTime(1);
        expect(onSetVolume).not.toHaveBeenCalled();
      }
    }

    // After 100 events, exactly 49ms elapsed, and the 100th event was just fired with value 100.
    expect(onSetVolume).not.toHaveBeenCalled();

    // Advance 99ms: 1ms short of the 100ms debounce threshold from the 100th event
    vi.advanceTimersByTime(99);
    expect(onSetVolume).not.toHaveBeenCalled();

    // Advance 1ms: reaches exactly 100ms after the 100th event
    vi.advanceTimersByTime(1);
    expect(onSetVolume).toHaveBeenCalledTimes(1);
    expect(onSetVolume).toHaveBeenCalledWith(100, undefined);

    // Advance further 500ms to guarantee zero trailing duplicate emissions
    vi.advanceTimersByTime(500);
    expect(onSetVolume).toHaveBeenCalledTimes(1);

    pill.dispose();
  });

  // =========================================================================
  // Requirement 2: Drag Isolation Under Snapshot Flooding
  // =========================================================================
  it('ADV-VOL-02: isolates slider thumb from snapshot flooding (volumeSlider.value NEVER snaps back while dragging)', () => {
    const onSetVolume = vi.fn();
    const pill = new ShadowDomCastPill({
      onToggleHandoff: vi.fn(),
      onSelectOutput: vi.fn(),
      onRefreshOutputs: vi.fn(),
      onSetVolume,
    });
    pill.mount();
    pill.update(createStressSnapshot({ hardwareVolume: 50 }));

    const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
    const slider = host?.shadowRoot?.querySelector('.pill-volume-slider');
    expect(slider?.value).toBe('50');

    // User begins active drag to 80%
    slider!.value = '80';
    slider!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(slider?.value).toBe('80');

    // While dragging (between 'input' and 'change'), flood the component with
    // 50 incoming snapshots containing conflicting hardwareVolume telemetry (10%, 15%, 5%, etc.)
    for (let i = 0; i < 50; i++) {
      const conflictingVol = 10 + (i % 6);
      pill.update(createStressSnapshot({ hardwareVolume: conflictingVol }));

      // CRITICAL LAW: volumeSlider.value must NEVER snap back to conflicting telemetry while dragging!
      expect(slider?.value).toBe('80');
    }

    // Now complete the user drag interaction
    slider!.dispatchEvent(new Event('change', { bubbles: true }));

    // Immediate commit with the dragged value
    expect(onSetVolume).toHaveBeenCalledWith(80, undefined);

    // After drag finishes, subsequent snapshots update the slider cleanly
    pill.update(createStressSnapshot({ hardwareVolume: 25 }));
    expect(slider?.value).toBe('25');

    pill.dispose();
  });

  // =========================================================================
  // Requirement 3: Boundary Clamping (Step Down <= 0 and Step Up >= 100)
  // =========================================================================
  it('ADV-VOL-03A: clamps rapid step-down clicks at 0% (never negative) and dispatches clamped values', () => {
    const onSetVolume = vi.fn();
    const pill = new ShadowDomCastPill({
      onToggleHandoff: vi.fn(),
      onSelectOutput: vi.fn(),
      onRefreshOutputs: vi.fn(),
      onSetVolume,
    });
    pill.mount();
    pill.update(createStressSnapshot({ hardwareVolume: 1 }));

    const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
    const volDownBtn = host?.shadowRoot?.querySelector('.pill-vol-down-btn');
    const slider = host?.shadowRoot?.querySelector('.pill-volume-slider');
    const label = host?.shadowRoot?.querySelector('.pill-volume-label');
    const quickVolText = host?.shadowRoot?.querySelector('.pill-quick-vol-text');

    expect(slider?.value).toBe('1');

    // Step 1: 1% - 2% -> Math.max(0, -1) = 0%
    volDownBtn?.click();
    expect(slider?.value).toBe('0');
    expect(label?.textContent).toBe('0%');
    expect(quickVolText?.textContent).toBe('0%');
    expect(onSetVolume).toHaveBeenLastCalledWith(0, undefined);

    // Rapid successive step-down clicks from 0: must never underflow below 0
    for (let click = 1; click <= 25; click++) {
      volDownBtn?.click();
      expect(Number(slider?.value)).toBe(0);
      expect(slider?.value).toBe('0');
      expect(label?.textContent).toBe('0%');
      expect(quickVolText?.textContent).toBe('0%');
      expect(onSetVolume).toHaveBeenLastCalledWith(0, undefined);
    }

    expect(onSetVolume).toHaveBeenCalledTimes(26);

    pill.dispose();
  });

  it('ADV-VOL-03B: clamps rapid step-up clicks at 100% (never > 100) and dispatches clamped values', () => {
    const onSetVolume = vi.fn();
    const pill = new ShadowDomCastPill({
      onToggleHandoff: vi.fn(),
      onSelectOutput: vi.fn(),
      onRefreshOutputs: vi.fn(),
      onSetVolume,
    });
    pill.mount();
    pill.update(createStressSnapshot({ hardwareVolume: 99 }));

    const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
    const volUpBtn = host?.shadowRoot?.querySelector('.pill-vol-up-btn');
    const slider = host?.shadowRoot?.querySelector('.pill-volume-slider');
    const label = host?.shadowRoot?.querySelector('.pill-volume-label');
    const quickVolText = host?.shadowRoot?.querySelector('.pill-quick-vol-text');

    expect(slider?.value).toBe('99');

    // Step 1: 99% + 2% -> Math.min(100, 101) = 100%
    volUpBtn?.click();
    expect(slider?.value).toBe('100');
    expect(label?.textContent).toBe('100%');
    expect(quickVolText?.textContent).toBe('100%');
    expect(onSetVolume).toHaveBeenLastCalledWith(100, undefined);

    // Rapid successive step-up clicks from 100: must never overflow above 100
    for (let click = 1; click <= 25; click++) {
      volUpBtn?.click();
      expect(Number(slider?.value)).toBe(100);
      expect(slider?.value).toBe('100');
      expect(label?.textContent).toBe('100%');
      expect(quickVolText?.textContent).toBe('100%');
      expect(onSetVolume).toHaveBeenLastCalledWith(100, undefined);
    }

    expect(onSetVolume).toHaveBeenCalledTimes(26);

    pill.dispose();
  });

  // =========================================================================
  // Requirement 4: Rapid Lifecycle Mounting/Disposing Stress
  // =========================================================================
  it('ADV-VOL-04: mounts and disposes 50 ShadowDomCastPill instances in rapid succession with active timers running (zero leaks/errors)', () => {
    const callbackSpies: ReturnType<typeof vi.fn>[] = [];
    const addListenerSpy = vi.spyOn(dom.document, 'addEventListener');
    const removeListenerSpy = vi.spyOn(dom.document, 'removeEventListener');

    // Rapidly instantiate, mount, start debounce timer, and dispose 50 instances
    for (let i = 0; i < 50; i++) {
      const onSetVolume = vi.fn();
      callbackSpies.push(onSetVolume);

      const pill = new ShadowDomCastPill({
        onToggleHandoff: vi.fn(),
        onSelectOutput: vi.fn(),
        onRefreshOutputs: vi.fn(),
        onSetVolume,
      });

      // Mount into synthetic DOM
      pill.mount();
      pill.update(createStressSnapshot({ hardwareVolume: 20 + (i % 30) }));

      const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
      expect(host).not.toBeNull();
      const slider = host?.shadowRoot?.querySelector('.pill-volume-slider');
      expect(slider).not.toBeNull();

      // Trigger slider input to schedule a 100ms debounce timer
      slider!.value = String(40 + (i % 20));
      slider!.dispatchEvent(new Event('input', { bubbles: true }));

      // Advance partial timer (e.g., 30ms into the 100ms debounce window)
      vi.advanceTimersByTime(30);

      // Verify timer has NOT fired yet
      expect(onSetVolume).not.toHaveBeenCalled();

      // Immediately dispose instance with active timer ticking
      pill.dispose();

      // Verify host was removed from DOM
      expect(dom.document.body.querySelector('[data-soundclud-cast-pill]')).toBeNull();
    }

    // Verify document.removeEventListener('click', ...) was called on every single disposal (50/50 times)
    expect(addListenerSpy).toHaveBeenCalledTimes(50);
    expect(removeListenerSpy).toHaveBeenCalledTimes(50);
    const clickRemovals = removeListenerSpy.mock.calls.filter((call) => call[0] === 'click');
    expect(clickRemovals.length).toBe(50);

    // Verify zero orphaned event listeners remain on document:
    // Dispatch a click event on document and verify no errors or lingering side-effects occur
    expect(() => {
      dom.document.dispatchEvent(new Event('click'));
    }).not.toThrow();

    // Check underlying Node EventTarget symbol to verify 0 active click listeners
    const kEvents = Object.getOwnPropertySymbols(dom.document).find(
      (s) => s.description === 'kEvents',
    );
    if (kEvents) {
      const clickMap = (dom.document as any)[kEvents]?.get('click');
      expect(clickMap?.size ?? 0).toBe(0);
    }

    // Now advance time by 10,000ms: ensure none of the 50 cancelled timers fire orphaned callbacks
    vi.advanceTimersByTime(10000);

    for (let i = 0; i < 50; i++) {
      expect(callbackSpies[i]).not.toHaveBeenCalled();
    }
  });

  // =========================================================================
  // Requirement 5: Interactive Interruption & Debounce Cancellation
  // =========================================================================
  it('ADV-VOL-05A: step-down button click immediately cancels pending slider debounce timer and dispatches once', () => {
    const onSetVolume = vi.fn();
    const pill = new ShadowDomCastPill({
      onToggleHandoff: vi.fn(),
      onSelectOutput: vi.fn(),
      onRefreshOutputs: vi.fn(),
      onSetVolume,
    });
    pill.mount();
    pill.update(createStressSnapshot({ hardwareVolume: 50 }));

    const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
    const slider = host?.shadowRoot?.querySelector('.pill-volume-slider');
    const volDownBtn = host?.shadowRoot?.querySelector('.pill-vol-down-btn');

    // Start a slider drag to 70 (schedules 100ms timer)
    slider!.value = '70';
    slider!.dispatchEvent(new Event('input', { bubbles: true }));

    // 40ms later, user clicks step-down
    vi.advanceTimersByTime(40);
    expect(onSetVolume).not.toHaveBeenCalled();

    // Step down click should cancel the pending 70 timer and immediately dispatch 68 (70 - 2)
    volDownBtn?.click();
    expect(onSetVolume).toHaveBeenCalledTimes(1);
    expect(onSetVolume).toHaveBeenCalledWith(68, undefined);

    // Advance past original 100ms: no duplicate message for 70
    vi.advanceTimersByTime(100);
    expect(onSetVolume).toHaveBeenCalledTimes(1);

    pill.dispose();
  });

  it('ADV-VOL-05B: mute toggle immediately cancels pending slider debounce timer and dispatches mute-only payload', () => {
    const onSetVolume = vi.fn();
    const pill = new ShadowDomCastPill({
      onToggleHandoff: vi.fn(),
      onSelectOutput: vi.fn(),
      onRefreshOutputs: vi.fn(),
      onSetVolume,
    });
    pill.mount();
    pill.update(createStressSnapshot({ hardwareVolume: 40, hardwareMuted: false }));

    const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
    const slider = host?.shadowRoot?.querySelector('.pill-volume-slider');
    const muteBtn = host?.shadowRoot?.querySelector('.pill-mute-btn');

    // Start a slider drag to 85 (schedules 100ms timer)
    slider!.value = '85';
    slider!.dispatchEvent(new Event('input', { bubbles: true }));

    // 60ms later, user clicks mute
    vi.advanceTimersByTime(60);
    expect(onSetVolume).not.toHaveBeenCalled();

    // Mute toggle must cancel debounce timer and send muted=true with NO volume payload
    muteBtn?.click();
    expect(onSetVolume).toHaveBeenCalledTimes(1);
    expect(onSetVolume).toHaveBeenCalledWith(undefined, true);

    // Advance past original 100ms: no duplicate volume emission
    vi.advanceTimersByTime(100);
    expect(onSetVolume).toHaveBeenCalledTimes(1);

    pill.dispose();
  });

  // =========================================================================
  // Requirement 6: Discrepancy Probe — Visual Readout During Drag
  // =========================================================================
  it('ADV-VOL-06: protects visual readout label and quick vol from snapshot snapback during active dragging under conflicting telemetry flood', () => {
    const onSetVolume = vi.fn();
    const pill = new ShadowDomCastPill({
      onToggleHandoff: vi.fn(),
      onSelectOutput: vi.fn(),
      onRefreshOutputs: vi.fn(),
      onSetVolume,
    });
    pill.mount();
    pill.update(createStressSnapshot({ hardwareVolume: 50 }));

    const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
    const slider = host?.shadowRoot?.querySelector('.pill-volume-slider');
    const label = host?.shadowRoot?.querySelector('.pill-volume-label');
    const quickVolText = host?.shadowRoot?.querySelector('.pill-quick-vol-text');

    expect(slider?.value).toBe('50');
    expect(label?.textContent).toBe('50%');
    expect(quickVolText?.textContent).toBe('50%');

    // Drag to 82%
    slider!.value = '82';
    slider!.dispatchEvent(new Event('input', { bubbles: true }));
    expect(label?.textContent).toBe('82%');
    expect(quickVolText?.textContent).toBe('82%');

    // Flood with 100 conflicting telemetry snapshots with arbitrary conflicting volume levels
    for (let i = 0; i < 100; i++) {
      const conflictingVol = (i * 17) % 101; // spreads values across 0..=100
      pill.update(createStressSnapshot({ hardwareVolume: conflictingVol }));

      // Invariant: slider value, readout label, and quick vol text MUST remain strictly locked at 82%
      expect(slider?.value).toBe('82');
      expect(label?.textContent).toBe('82%');
      expect(quickVolText?.textContent).toBe('82%');
    }

    // Advance 100ms debounce window and ensure dragged value dispatches cleanly
    vi.advanceTimersByTime(100);
    expect(onSetVolume).toHaveBeenCalledWith(82, undefined);

    // End active drag with change event
    slider!.dispatchEvent(new Event('change', { bubbles: true }));

    // Subsequent telemetry snapshot after dragging is complete now updates smoothly
    pill.update(createStressSnapshot({ hardwareVolume: 35 }));
    expect(slider?.value).toBe('35');
    expect(label?.textContent).toBe('35%');
    expect(quickVolText?.textContent).toBe('35%');

    pill.dispose();
  });

  // =========================================================================
  // Requirement 7: Concurrent Multi-Instance Mounting & Selective Teardown
  // =========================================================================
  it('ADV-VOL-07: 50 concurrent ShadowDomCastPill instances isolate listeners and leave 0 orphaned listeners when unmounted', () => {
    setMaxListeners(100, dom.document);
    const addListenerSpy = vi.spyOn(dom.document, 'addEventListener');
    const removeListenerSpy = vi.spyOn(dom.document, 'removeEventListener');

    const pills: ShadowDomCastPill[] = [];

    // Mount 50 concurrent instances into DOM
    for (let i = 0; i < 50; i++) {
      const pill = new ShadowDomCastPill({
        onToggleHandoff: vi.fn(),
        onSelectOutput: vi.fn(),
        onRefreshOutputs: vi.fn(),
        onSetVolume: vi.fn(),
      });
      pill.mount();
      pill.update(createStressSnapshot({ hardwareVolume: 20 + (i % 50) }));
      pills.push(pill);
    }

    expect(addListenerSpy).toHaveBeenCalledTimes(50);
    expect(removeListenerSpy).not.toHaveBeenCalled();

    // Check underlying Node EventTarget symbol to verify 50 active click listeners
    const kEvents = Object.getOwnPropertySymbols(dom.document).find(
      (s) => s.description === 'kEvents',
    );
    if (kEvents) {
      const clickMap = (dom.document as any)[kEvents]?.get('click');
      expect(clickMap?.size).toBe(50);
    }

    // Dispose all 50 one by one
    for (let i = 0; i < 50; i++) {
      pills[i]?.dispose();
      expect(removeListenerSpy).toHaveBeenCalledTimes(i + 1);
    }

    expect(removeListenerSpy).toHaveBeenCalledTimes(50);

    // Verify 0 active click listeners remain
    if (kEvents) {
      const clickMap = (dom.document as any)[kEvents]?.get('click');
      expect(clickMap?.size ?? 0).toBe(0);
    }

    // Clicking document does not throw and has zero handlers attached
    expect(() => {
      dom.document.dispatchEvent(new Event('click'));
    }).not.toThrow();
  });

  // =========================================================================
  // Requirement 8: Boundary Drag at 0% and Muted Drag Isolation
  // =========================================================================
  it('ADV-VOL-08: boundary drag at 0% and muted drag under 100-snapshot telemetry flood maintain visual invariants', () => {
    const onSetVolume = vi.fn();
    const pill = new ShadowDomCastPill({
      onToggleHandoff: vi.fn(),
      onSelectOutput: vi.fn(),
      onRefreshOutputs: vi.fn(),
      onSetVolume,
    });
    pill.mount();
    // Device starts muted at 30%
    pill.update(createStressSnapshot({ hardwareVolume: 30, hardwareMuted: true }));

    const host = dom.document.body.querySelector('[data-soundclud-cast-pill]');
    const slider = host?.shadowRoot?.querySelector('.pill-volume-slider');
    const label = host?.shadowRoot?.querySelector('.pill-volume-label');
    const quickVolText = host?.shadowRoot?.querySelector('.pill-quick-vol-text');

    expect(slider?.value).toBe('30');
    expect(label?.textContent).toBe('30%');
    expect(quickVolText?.textContent).toBe('Muted');

    // Drag slider to 0%
    slider!.value = '0';
    slider!.dispatchEvent(new Event('input', { bubbles: true }));

    // Slider label shows 0%, quickVolText still shows Muted because device is muted
    expect(slider?.value).toBe('0');
    expect(label?.textContent).toBe('0%');
    expect(quickVolText?.textContent).toBe('Muted');

    // Flood with 100 unmuted snapshots claiming 75%
    for (let i = 0; i < 100; i++) {
      pill.update(createStressSnapshot({ hardwareVolume: 75, hardwareMuted: false }));

      // Slider and label remain locked at dragged 0%
      expect(slider?.value).toBe('0');
      expect(label?.textContent).toBe('0%');
      // While dragging, unmuted telemetry does not revert slider or label
    }

    // Release drag with pointerup
    slider!.dispatchEvent(new Event('pointerup', { bubbles: true }));

    // Next incoming snapshot cleanly updates now that dragging ended
    pill.update(createStressSnapshot({ hardwareVolume: 45, hardwareMuted: false }));
    expect(slider?.value).toBe('45');
    expect(label?.textContent).toBe('45%');
    expect(quickVolText?.textContent).toBe('45%');

    pill.dispose();
  });
});
