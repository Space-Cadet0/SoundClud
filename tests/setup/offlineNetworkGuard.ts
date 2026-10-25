import http from 'node:http';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { URL } from 'node:url';

const GUARD_INSTALLED_SYMBOL = Symbol.for('soundclud.offlineNetworkGuard.installed');

const BRACKETED_IPV6_HOST_PATTERN = /^\[([^\]]+)\](?::\d+)?$/;
const HOST_WITH_PORT_PATTERN = /^([^:]+):\d+$/;

const ALLOWED_LOOPBACK_HOSTS = new Set<string>([
  '127.0.0.1',
  'localhost',
  '::1',
  '0:0:0:0:0:0:0:1',
  '::ffff:127.0.0.1',
  '::ffff:7f00:1',
]);

export class OfflineNetworkGuardError extends Error {
  public readonly blockedTarget: string;
  public readonly resolvedHost: string;

  public constructor(blockedTarget: string, resolvedHost: string) {
    super(
      `[OfflineNetworkGuard] Outbound non-loopback network request blocked: target="${blockedTarget}" (host="${resolvedHost}"). ` +
        'Default test runs must remain 100% offline and target only loopback (127.0.0.1, localhost, ::1).',
    );
    this.name = 'OfflineNetworkGuardError';
    this.blockedTarget = blockedTarget;
    this.resolvedHost = resolvedHost;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isLoopbackHost(host: string): boolean {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.length === 0) {
    return false;
  }

  if (trimmed.startsWith('[')) {
    const match = BRACKETED_IPV6_HOST_PATTERN.exec(trimmed);
    const ipv6Host = match?.[1];
    if (ipv6Host === undefined) {
      return false;
    }
    return ALLOWED_LOOPBACK_HOSTS.has(ipv6Host);
  }

  if (ALLOWED_LOOPBACK_HOSTS.has(trimmed)) {
    return true;
  }

  const hostWithPortMatch = HOST_WITH_PORT_PATTERN.exec(trimmed);
  const bareHost = hostWithPortMatch?.[1];
  if (bareHost !== undefined) {
    return ALLOWED_LOOPBACK_HOSTS.has(bareHost);
  }

  return false;
}

type FetchFn = typeof globalThis.fetch;
type FetchInput = Parameters<FetchFn>[0];
type RequestCallback = (res: http.IncomingMessage) => void;

function assertAllowedUrl(url: URL, rawTarget: string): void {
  if (url.protocol === 'data:' || url.protocol === 'blob:') {
    return;
  }

  if (!isLoopbackHost(url.hostname)) {
    throw new OfflineNetworkGuardError(rawTarget, url.hostname || '<empty-host>');
  }
}

function extractFetchUrlString(input: FetchInput): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  if (
    typeof input === 'object' &&
    input !== null &&
    'url' in input &&
    typeof input.url === 'string'
  ) {
    return input.url;
  }
  return String(input);
}

function assertAllowedFetchTarget(input: FetchInput): void {
  if (input instanceof URL) {
    assertAllowedUrl(input, input.href);
    return;
  }

  const rawUrl = extractFetchUrlString(input);
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new OfflineNetworkGuardError(rawUrl, '<invalid-or-relative-url>');
  }

  assertAllowedUrl(parsed, rawUrl);
}

function assertAllowedRequestOptions(
  defaultProtocol: 'http:' | 'https:',
  options: http.RequestOptions,
): void {
  if (typeof options.socketPath === 'string' && options.socketPath.length > 0) {
    if (options.hostname === undefined && options.host === undefined) {
      return;
    }
  }

  const explicitHost = options.hostname ?? options.host;
  if (explicitHost === undefined || explicitHost === null) {
    return;
  }

  if (!isLoopbackHost(explicitHost)) {
    const portSuffix = options.port !== undefined ? `:${String(options.port)}` : '';
    const pathSuffix = options.path ?? '/';
    const target = `${defaultProtocol}//${explicitHost}${portSuffix}${pathSuffix}`;
    throw new OfflineNetworkGuardError(target, explicitHost);
  }
}

function assertAllowedNodeRequest(
  defaultProtocol: 'http:' | 'https:',
  urlOrOptions: http.RequestOptions | string | URL,
  optionsOrCallback?: http.RequestOptions | RequestCallback,
): void {
  if (typeof urlOrOptions === 'string') {
    let parsed: URL;
    try {
      parsed = new URL(urlOrOptions);
    } catch {
      throw new OfflineNetworkGuardError(urlOrOptions, '<invalid-url>');
    }
    assertAllowedUrl(parsed, urlOrOptions);
  } else if (urlOrOptions instanceof URL) {
    assertAllowedUrl(urlOrOptions, urlOrOptions.href);
  } else {
    assertAllowedRequestOptions(defaultProtocol, urlOrOptions);
  }

  if (
    typeof optionsOrCallback === 'object' &&
    optionsOrCallback !== null &&
    !(optionsOrCallback instanceof URL)
  ) {
    assertAllowedRequestOptions(defaultProtocol, optionsOrCallback);
  }
}

type NodeRequestFn<TOptions extends http.RequestOptions> = {
  (options: TOptions | string | URL, callback?: RequestCallback): http.ClientRequest;
  (url: string | URL, options: TOptions, callback?: RequestCallback): http.ClientRequest;
};

function createGuardedNodeRequest<TOptions extends http.RequestOptions>(
  original: NodeRequestFn<TOptions>,
  defaultProtocol: 'http:' | 'https:',
): NodeRequestFn<TOptions> {
  function guarded(
    urlOrOptions: TOptions | string | URL,
    optionsOrCallback?: TOptions | RequestCallback,
    maybeCallback?: RequestCallback,
  ): http.ClientRequest {
    assertAllowedNodeRequest(defaultProtocol, urlOrOptions, optionsOrCallback);

    if (typeof urlOrOptions === 'string' || urlOrOptions instanceof URL) {
      if (typeof optionsOrCallback === 'function') {
        return original(urlOrOptions, optionsOrCallback);
      }
      if (optionsOrCallback !== undefined) {
        return maybeCallback !== undefined
          ? original(urlOrOptions, optionsOrCallback, maybeCallback)
          : original(urlOrOptions, optionsOrCallback);
      }
      return maybeCallback !== undefined
        ? original(urlOrOptions, maybeCallback)
        : original(urlOrOptions);
    }

    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    return callback !== undefined ? original(urlOrOptions, callback) : original(urlOrOptions);
  }

  return guarded;
}

export function installOfflineNetworkGuard(): void {
  if (Reflect.get(globalThis, GUARD_INSTALLED_SYMBOL) === true) {
    return;
  }

  if (typeof globalThis.fetch === 'function') {
    const originalFetch: FetchFn = globalThis.fetch.bind(globalThis);
    const guardedFetchImpl = async (...args: Parameters<FetchFn>): Promise<Response> => {
      assertAllowedFetchTarget(args[0]);
      return originalFetch(...args);
    };
    const guardedFetch = Object.assign(guardedFetchImpl, globalThis.fetch);
    Reflect.set(globalThis, 'fetch', guardedFetch);
  }

  const originalHttpRequest = http.request.bind(http);
  const originalHttpGet = http.get.bind(http);
  const originalHttpsRequest = https.request.bind(https);
  const originalHttpsGet = https.get.bind(https);

  Reflect.set(http, 'request', createGuardedNodeRequest(originalHttpRequest, 'http:'));
  Reflect.set(http, 'get', createGuardedNodeRequest(originalHttpGet, 'http:'));
  Reflect.set(https, 'request', createGuardedNodeRequest(originalHttpsRequest, 'https:'));
  Reflect.set(https, 'get', createGuardedNodeRequest(originalHttpsGet, 'https:'));
  syncBuiltinESMExports();

  Reflect.set(globalThis, GUARD_INSTALLED_SYMBOL, true);
}

installOfflineNetworkGuard();
