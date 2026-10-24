// The runtime egress guard. Lint (no-direct-anthropic) sees only how a URL is written; the guard
// sees where it resolves. installEgressGuard(globalThis) wraps the scope's fetch and refuses any
// request whose WHATWG-parsed host is an API host (isApiHost in anthropic.ts: %2E, IDNA dots,
// case, templates and joins all resolve to it) unless it is the Request MessagesClient registered
// for the call in flight, sent once, unchanged and with no init (claimOutbound). A Request's URL
// and headers are read from its internal slots (requestUrl). Every forwarded call carries the
// guard's own dispatcher (forwardInit), so one the caller supplied by any route, in fetch's init
// or in a Request's, is never used. In Node the guard also takes undici's global dispatcher
// slots: each holds a dispatcher that refuses an API-host origin and is locked, so request(),
// dispatch(), stream(), connect() and the rest refuse whatever name the caller reached the slot
// by, a fetch with no dispatcher of its own (one captured before install, or a redirect hop)
// is checked again, and nothing can swap the slot. Only the claimed MessagesClient Request is
// forwarded with the raw dispatcher. A refusal is an EgressRefusal: nothing was sent. XMLHttpRequest,
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
import { claimOutbound, EgressRefusal, isApiHost, requestUrl } from './anthropic.ts';

let installed = false;

const refused = (api: string, url: URL) =>
  new EgressRefusal(`egress guard: ${api} to ${url.origin} refused: only MessagesClient (packages/core/anthropic.ts) sends to the Anthropic API, once per registered Request`);

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
// Node's global undici dispatcher at install (undici 8, then the undici 6 symbol), or undefined
// where fetch takes no dispatcher (browsers). Only the claimed MessagesClient Request is sent
// with it; every other forwarded call gets the guarded one that replaced it in the slots.
let dispatcher: unknown;
let guardedDispatcher: unknown;

// undici's registry keys for the global dispatcher (lib/global.js): .2 holds the Agent, .1 the
// same Agent behind a wrapper for undici 6 handlers.
const SLOT = Symbol.for('undici.globalDispatcher.2');
const LEGACY_SLOT = Symbol.for('undici.globalDispatcher.1');

// The part of undici's Dispatcher the guard touches.
interface Dispatcher {
  dispatch(opts: object, handler: object): boolean;
  close(...a: unknown[]): unknown;
  destroy(...a: unknown[]): unknown;
  webSocketOptions?: unknown;
  eventSourceOptions?: unknown;
}

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

// The init to forward: a copy of its own properties with the dispatcher captured at install. A
// caller's dispatcher would pick the connection below the guard. Node's fetch uses
// `init.dispatcher || request's dispatcher` (undici's Request constructor), so the captured one
// also overrides a dispatcher set in `new Request(url, { dispatcher })` or inherited from the
// Request it copied. An inherited init property is not copied. The claimed client Request gets
// the raw dispatcher; anything else gets the guarded one, so a redirect to the API host is
// refused at the hop. Without a captured dispatcher, the copy has none.
function forwardInit(init: RequestInit | undefined, claimed: boolean): RequestInit | undefined {
  const use = claimed ? dispatcher : guardedDispatcher;
  const own = typeof init === 'object' || typeof init === 'function';
  if (!own && init != null) return init; // the platform rejects it the same way
  if (!own && use === undefined) return init;
  const copy: Record<string, unknown> = own ? { ...init } : {};
  delete copy.dispatcher;
  if (use !== undefined) copy.dispatcher = use;
  return copy;
}

// A dispatcher that refuses an API-host origin and hands everything else to `raw`. It extends
// undici's own Dispatcher class (found on raw's prototype chain), whose request(), stream(),
// pipeline(), upgrade(), connect() and compose() all end in this.dispatch, so every method
// meets the check; raw stays in this closure, never on the object. The origin is read once, from
// a copy of opts, and the string checked is the one raw gets.
function guardDispatcher(raw: Dispatcher): Dispatcher {
  let proto: object | null = Object.getPrototypeOf(raw) as object | null;
  while (proto !== null && !Object.prototype.hasOwnProperty.call(proto, 'request')) proto = Object.getPrototypeOf(proto) as object | null;
  const Base = (proto?.constructor ?? Object) as Ctor;
  return new (class extends Base {
    dispatch(opts: object, handler: object): boolean {
      const copy: Record<string, unknown> = { ...opts };
      const origin = copy.origin;
      if (typeof origin === 'string' || origin instanceof URL) {
        const s = String(origin);
        const url = new URL(s);
        if (isApiHost(url.hostname)) throw refused('undici dispatcher', url);
        copy.origin = s;
      }
      return raw.dispatch(copy, handler);
    }
    close(...a: unknown[]): unknown {
      return raw.close(...a);
    }
    destroy(...a: unknown[]): unknown {
      return raw.destroy(...a);
    }
    get webSocketOptions(): unknown {
      return raw.webSocketOptions;
    }
    get eventSourceOptions(): unknown {
      return raw.eventSourceOptions;
    }
  })() as unknown as Dispatcher;
}

type Ctor = new (...args: unknown[]) => object;

function lock(target: object, key: string | symbol, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: false, configurable: false, enumerable: false });
}


export function installEgressGuard(scope: object): void {
  if (installed) return;
  installed = true;
  const g = scope as Scope;
  base = g.document?.baseURI ?? g.location?.href;
  // Reading Request loads Node's undici, which sets the global dispatcher.
  void (g as { Request?: unknown }).Request;
  const slots = scope as Record<symbol, unknown>;
  dispatcher = slots[SLOT] ?? slots[LEGACY_SLOT];
  if (typeof (dispatcher as Dispatcher | undefined)?.dispatch === 'function') {
    const guarded = guardDispatcher(dispatcher as Dispatcher);
    // The .1 slot keeps undici's wrapper class, now around the guarded dispatcher.
    const Legacy = (slots[LEGACY_SLOT] as { constructor?: unknown } | undefined)?.constructor;
    guardedDispatcher = guarded;
    // undici defines both slots non-configurable but writable; locking them makes a later
    // assignment or setGlobalDispatcher throw.
    lock(scope, SLOT, guarded);
    lock(scope, LEGACY_SLOT, typeof Legacy === 'function' && slots[LEGACY_SLOT] !== dispatcher ? new (Legacy as Ctor)(guarded) : guarded);
  }

  const raw = g.fetch;
  if (typeof raw === 'function') {
    const guarded = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      try {
        // A real Request is checked by the URL in its slot, which is what fetch sends.
        const href = requestUrl(input);
        if (href !== null) {
          const url = resolveUrl(href);
          const claimed = url !== null && isApiHost(url.hostname);
          if (claimed && !claimOutbound(input, init)) throw refused('fetch', url);
          return raw.call(scope, input, forwardInit(init, claimed));
        }
        return raw.call(scope, checked('fetch', input), forwardInit(init, false));
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
