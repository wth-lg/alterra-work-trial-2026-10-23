// The probe page as a transport for MessagesClient. The live spec builds the client in Node,
// where the grant and ledger live, and hands it relayFetch, which claims the client's Request
// (claimOutbound: once, unchanged, so the relay sends nothing the client did not register)
// and runs it through pageFetch inside the page served under the production CSP. Chromium makes
// the real POST from that origin; the client still reserves before it and settles after, and
// checks the status, the stream and the model as it does for any fetch. The key travels only in
// the request headers, as a page.evaluate argument, never in a URL.
import { claimOutbound, type Transport } from '../../../../packages/core/anthropic.ts';

export interface PageRequest {
  method: string;
  headers: Record<string, string>;
  body: string;
}
export type PageReply = { status: number; headers: Record<string, string>; body: string } | { error: { name: string; message: string } };

// Browser side: one fetch through `send` (the page's fetch from before the egress guard), with
// the whole body read, or the error fetch threw.
export async function pageFetch(send: typeof fetch, url: string, req: PageRequest): Promise<PageReply> {
  try {
    const res = await send(url, req);
    return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
  } catch (e) {
    return { error: { name: (e as Error).name, message: (e as Error).message } };
  }
}

// Node side: a transport that sends the client's Request through `send` (page.evaluate of
// pageFetch) and rebuilds the Response, or throws the browser's error as a TypeError, as fetch would.
export function relayFetch(send: (url: string, req: PageRequest) => Promise<PageReply>): Transport {
  return async (request) => {
    if (!claimOutbound(request)) throw new TypeError('the probe relay sends only the Request MessagesClient registered for this call, once');
    const req: PageRequest = { method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() };
    const reply = await send(request.url, req);
    if ('error' in reply) throw new TypeError(`${reply.error.name}: ${reply.error.message}`);
    return new Response(reply.body, { status: reply.status, headers: reply.headers });
  };
}
