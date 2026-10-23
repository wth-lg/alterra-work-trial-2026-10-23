// The runtime egress guard. Lint (no-direct-anthropic) sees only how a URL is written; the guard
// sees where it resolves. installEgressGuard(globalThis) wraps the scope's fetch and refuses any
// request whose WHATWG-parsed host is an API host (isApiHost in anthropic.ts: %2E, IDNA dots,
// case, templates and joins all resolve to it) unless it is the Request MessagesClient registered
// for the call in flight, sent once, unchanged and with no init (claimOutbound). A Request's URL
// and headers are read from its internal slots (requestUrl). XMLHttpRequest,
// WebSocket, EventSource and navigator.sendBeacon, where present, are refused for those hosts
// outright: the client never uses them. A URL is resolved once and the resolved string is what
// gets sent, so an object whose toString answers differently the second time sends nothing new.
// The wrapped globals are made read-only, so later code cannot put the raw ones back. The entry
// point passes its global scope in, since shared code does not touch DOM or Node globals
// (lint: isomorphic-imports).
//
// Every entry point that can make live calls installs it as its first statement: the cli/index.ts
// dispatcher, scripts/live-node.ts, the web app and the probe page (later: the local runner, and
// the Worker that hosts the browser client). See anthropic.ts for the threat model.
import { claimOutbound, isApiHost, requestUrl } from './anthropic.ts';

let installed = false;

const refused = (api: string, url: URL) =>
  new TypeError(`egress guard: ${api} to ${url.origin} refused: only MessagesClient (packages/core/anthropic.ts) sends to the Anthropic API, once per registered Request`);

// The globals the guard wraps, where the runtime has them.
interface Scope {
  fetch?: typeof fetch;
  XMLHttpRequest?: { prototype?: { open?: (...a: unknown[]) => void } };
  WebSocket?: unknown;
  EventSource?: unknown;
  navigator?: { sendBeacon?: (url: unknown, data?: unknown) => boolean };
  document?: { baseURI?: string };
  location?: { href?: string };
}

let base: string | undefined;

// The URL as the platform would resolve it against the page's base, or null when it does not parse.
function resolveUrl(s: string): URL | null {
  try {
    return new URL(s, base);
  } catch {
    return null;
  }
}

// The string to send: the resolved URL, after refusing an API host.
function checked(api: string, input: unknown): string {
  const s = String(input);
  const url = resolveUrl(s);
  if (url === null) return s; // the platform rejects it the same way
  if (isApiHost(url.hostname)) throw refused(api, url);
  return url.href;
}

function lock(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: false, configurable: false, enumerable: false });
}

type Ctor = new (...args: unknown[]) => object;

export function installEgressGuard(scope: object): void {
  if (installed) return;
  installed = true;
  const g = scope as Scope;
  base = g.document?.baseURI ?? g.location?.href;

  const raw = g.fetch;
  if (typeof raw === 'function') {
    const guarded = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      try {
        // A real Request is checked by the URL in its slot, which is what fetch sends.
        const href = requestUrl(input);
        if (href !== null) {
          const url = resolveUrl(href);
          if (url !== null && isApiHost(url.hostname) && !claimOutbound(input, init)) throw refused('fetch', url);
          return raw.call(scope, input, init);
        }
        return raw.call(scope, checked('fetch', input), init);
      } catch (e) {
        return Promise.reject(e);
      }
    };
    lock(scope, 'fetch', guarded);
  }

  const xhr = g.XMLHttpRequest;
  const open = xhr?.prototype?.open;
  if (xhr?.prototype && typeof open === 'function') {
    lock(xhr.prototype, 'open', function (this: unknown, method: unknown, url: unknown, ...rest: unknown[]) {
      return open.call(this, method, checked('XMLHttpRequest', url), ...rest);
    });
  }

  for (const name of ['WebSocket', 'EventSource'] as const) {
    const C = g[name];
    if (typeof C !== 'function') continue;
    const Guarded = class extends (C as Ctor) {
      constructor(url: unknown, ...rest: unknown[]) {
        super(checked(name, url), ...rest);
      }
    };
    Object.defineProperty(Guarded, 'name', { value: name });
    lock(scope, name, Guarded);
  }

  const nav = g.navigator;
  const beacon = nav?.sendBeacon;
  if (nav && typeof beacon === 'function') {
    lock(nav, 'sendBeacon', (url: unknown, data?: unknown) => beacon.call(nav, checked('sendBeacon', url), data));
  }
}
