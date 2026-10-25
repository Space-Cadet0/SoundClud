/**
 * Cryptographic 128-bit nonce-verified `CustomEvent` bridge between `ISOLATED`
 * and `MAIN` content-script worlds (`run_at: "document_start"`).
 *
 * Uses string-serialized `CustomEvent.detail` envelopes so V8 cross-world context
 * boundaries never strip object properties and page scripts cannot inject getter traps.
 * Immediately deletes the bootstrap DOM attribute upon handshake completion.
 */

import {
  isRecord,
  type IsolatedToMainMessage,
  type MainToIsolatedMessage,
} from '../shared/messages.js';

export const BRIDGE_BOOTSTRAP_ATTR = 'data-soundclud-bridge-init' as const;
export const BRIDGE_BOOTSTRAP_EVENT = '__soundclud_bridge_bootstrap_v1' as const;

interface BootstrapDescriptor {
  readonly nonce: string;
  readonly m2i: string;
  readonly i2m: string;
}

export interface BridgeEnvironment {
  readonly eventTarget: EventTarget;
  readonly rootElement: Element | null;
}

export function generateHexNonce128(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function getDefaultBridgeEnvironment(): BridgeEnvironment {
  return {
    eventTarget: window,
    rootElement: document.documentElement,
  };
}

function parseBootstrapDescriptor(raw: unknown): BootstrapDescriptor | undefined {
  if (typeof raw !== 'string' || raw.length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) {
      return undefined;
    }
    const nonce = parsed['nonce'];
    const m2i = parsed['m2i'];
    const i2m = parsed['i2m'];
    if (
      typeof nonce === 'string' &&
      /^[0-9a-f]{32}$/.test(nonce) &&
      typeof m2i === 'string' &&
      m2i.startsWith('__sc_m2i_') &&
      typeof i2m === 'string' &&
      i2m.startsWith('__sc_i2m_')
    ) {
      return { nonce, m2i, i2m };
    }
  } catch {
    // Ignore malformed bootstrap strings.
  }
  return undefined;
}

function dispatchSerializedCustomEvent(
  target: EventTarget,
  eventName: string,
  payload: unknown,
): void {
  const serialized = JSON.stringify(payload);
  target.dispatchEvent(new CustomEvent<string>(eventName, { detail: serialized }));
}

export interface IsolatedWorldNonceBridge {
  send(message: IsolatedToMainMessage): boolean;
  readonly isHandshakeComplete: boolean;
  dispose(): void;
}

export function createIsolatedWorldNonceBridge(
  onMainMessage: (message: MainToIsolatedMessage) => void,
  env: BridgeEnvironment = getDefaultBridgeEnvironment(),
): IsolatedWorldNonceBridge {
  const nonce = generateHexNonce128();
  const m2i = `__sc_m2i_${generateHexNonce128().slice(0, 16)}`;
  const i2m = `__sc_i2m_${generateHexNonce128().slice(0, 16)}`;

  let handshakeComplete = false;
  const pendingOutbound: IsolatedToMainMessage[] = [];

  const clearBootstrapAttribute = (): void => {
    try {
      env.rootElement?.removeAttribute(BRIDGE_BOOTSTRAP_ATTR);
    } catch {
      // Ignore detached documentElement edge case.
    }
  };

  const handleInbound = (event: Event): void => {
    if (!(event instanceof CustomEvent) || typeof event.detail !== 'string') {
      return;
    }
    try {
      const parsed: unknown = JSON.parse(event.detail);
      if (!isRecord(parsed) || parsed['nonce'] !== nonce) {
        return;
      }
      if (parsed['kind'] === 'ack') {
        handshakeComplete = true;
        clearBootstrapAttribute();
        while (pendingOutbound.length > 0) {
          const next = pendingOutbound.shift();
          if (next !== undefined) {
            dispatchSerializedCustomEvent(env.eventTarget, i2m, {
              nonce,
              kind: 'msg',
              message: next,
            });
          }
        }
        return;
      }
      if (parsed['kind'] === 'msg' && isRecord(parsed['message'])) {
        handshakeComplete = true;
        clearBootstrapAttribute();
        onMainMessage(parsed['message'] as unknown as MainToIsolatedMessage);
      }
    } catch {
      // Ignore spoofed or malformed event payloads.
    }
  };

  env.eventTarget.addEventListener(m2i, handleInbound);

  const descriptor: BootstrapDescriptor = { nonce, m2i, i2m };
  const serializedDescriptor = JSON.stringify(descriptor);
  try {
    env.rootElement?.setAttribute(BRIDGE_BOOTSTRAP_ATTR, serializedDescriptor);
  } catch {
    // Ignore if documentElement is not yet attached.
  }
  env.eventTarget.dispatchEvent(
    new CustomEvent<string>(BRIDGE_BOOTSTRAP_EVENT, {
      detail: serializedDescriptor,
    }),
  );

  if (handshakeComplete) {
    clearBootstrapAttribute();
  }

  return {
    get isHandshakeComplete(): boolean {
      return handshakeComplete;
    },
    send(message: IsolatedToMainMessage): boolean {
      if (!handshakeComplete) {
        if (pendingOutbound.length < 64) {
          pendingOutbound.push(message);
        }
        return false;
      }
      dispatchSerializedCustomEvent(env.eventTarget, i2m, {
        nonce,
        kind: 'msg',
        message,
      });
      return true;
    },
    dispose(): void {
      clearBootstrapAttribute();
      env.eventTarget.removeEventListener(m2i, handleInbound);
    },
  };
}

export interface MainWorldNonceBridge {
  send(message: MainToIsolatedMessage): boolean;
  onReady(callback: () => void): void;
  dispose(): void;
}

export function attachMainWorldNonceBridge(
  onIsolatedMessage: (message: IsolatedToMainMessage) => void,
  env: BridgeEnvironment = getDefaultBridgeEnvironment(),
): MainWorldNonceBridge {
  let activeDescriptor: BootstrapDescriptor | null = null;
  let inboundListener: ((event: Event) => void) | null = null;
  const readyCallbacks: Array<() => void> = [];

  const activateDescriptor = (descriptor: BootstrapDescriptor): void => {
    if (activeDescriptor !== null) {
      return;
    }
    activeDescriptor = descriptor;
    try {
      env.rootElement?.removeAttribute(BRIDGE_BOOTSTRAP_ATTR);
    } catch {
      // Ignore attribute removal failure.
    }

    inboundListener = (event: Event): void => {
      if (!(event instanceof CustomEvent) || typeof event.detail !== 'string') {
        return;
      }
      try {
        const parsed: unknown = JSON.parse(event.detail);
        if (
          !isRecord(parsed) ||
          parsed['nonce'] !== descriptor.nonce ||
          parsed['kind'] !== 'msg' ||
          !isRecord(parsed['message'])
        ) {
          return;
        }
        onIsolatedMessage(parsed['message'] as unknown as IsolatedToMainMessage);
      } catch {
        // Ignore untrusted payloads.
      }
    };

    env.eventTarget.addEventListener(descriptor.i2m, inboundListener);
    dispatchSerializedCustomEvent(env.eventTarget, descriptor.m2i, {
      nonce: descriptor.nonce,
      kind: 'ack',
    });

    while (readyCallbacks.length > 0) {
      const cb = readyCallbacks.shift();
      cb?.();
    }
  };

  const onBootstrapEvent = (event: Event): void => {
    if (!(event instanceof CustomEvent)) {
      return;
    }
    const parsed = parseBootstrapDescriptor(event.detail);
    if (parsed !== undefined) {
      env.eventTarget.removeEventListener(BRIDGE_BOOTSTRAP_EVENT, onBootstrapEvent);
      activateDescriptor(parsed);
    }
  };

  const existingAttr = env.rootElement?.getAttribute(BRIDGE_BOOTSTRAP_ATTR) ?? null;
  const parsedFromAttr = parseBootstrapDescriptor(existingAttr);
  if (parsedFromAttr !== undefined) {
    activateDescriptor(parsedFromAttr);
  } else {
    env.eventTarget.addEventListener(BRIDGE_BOOTSTRAP_EVENT, onBootstrapEvent);
  }

  return {
    send(message: MainToIsolatedMessage): boolean {
      if (activeDescriptor === null) {
        return false;
      }
      dispatchSerializedCustomEvent(env.eventTarget, activeDescriptor.m2i, {
        nonce: activeDescriptor.nonce,
        kind: 'msg',
        message,
      });
      return true;
    },
    onReady(callback: () => void): void {
      if (activeDescriptor !== null) {
        callback();
      } else {
        readyCallbacks.push(callback);
      }
    },
    dispose(): void {
      env.eventTarget.removeEventListener(BRIDGE_BOOTSTRAP_EVENT, onBootstrapEvent);
      if (activeDescriptor !== null && inboundListener !== null) {
        env.eventTarget.removeEventListener(activeDescriptor.i2m, inboundListener);
      }
    },
  };
}
