// The probe page as a fetch for MessagesClient. The live spec builds the client in Node, where
// the grant and ledger live, and hands it relayFetch, which runs each request through
// pageFetch inside the page served under the production CSP. Chromium makes the real POST
// from that origin; the client still reserves before it and settles after, and checks the
// status, the stream and the model as it does for any fetch. The key travels only in the
// request headers, as a page.evaluate argument, never in a URL.
export interface PageRequest {
  method: string;
  headers: Record<string, string>;
  body: string;
}
export type PageReply = { status: number; headers: Record<string, string>; body: string } | { error: { name: string; message: string } };

// Browser side: one fetch, with the whole body read, or the error fetch threw.
export async function pageFetch(url: string, req: PageRequest): Promise<PageReply> {
  try {
    const res = await fetch(url, req);
    return { status: res.status, headers: Object.fromEntries(res.headers), body: await res.text() };
  } catch (e) {
    return { error: { name: (e as Error).name, message: (e as Error).message } };
  }
}

// Node side: a fetch that sends through `send` (page.evaluate of pageFetch) and rebuilds the
// Response, or throws the browser's error as a TypeError, as fetch would.
export function relayFetch(send: (url: string, req: PageRequest) => Promise<PageReply>): typeof fetch {
  return async (input, init) => {
    const req: PageRequest = { method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers)), body: String(init?.body ?? '') };
    const reply = await send(String(input), req);
    if ('error' in reply) throw new TypeError(`${reply.error.name}: ${reply.error.message}`);
    return new Response(reply.body, { status: reply.status, headers: reply.headers });
  };
}
