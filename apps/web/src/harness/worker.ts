// Harness Worker: runs the environment off the main thread, as a trial Worker will
// (design section 1). The browser FixtureSource is a same-origin fetch.
import { loadStore, type FixtureSource } from '../../../../packages/env/fixture-source.ts';
import { stateHash } from '../../../../packages/env/hash.ts';
import type { HarnessReply, HarnessRequest, HarnessResult } from './protocol.ts';

const fetchSource = (url: string): FixtureSource => ({
  async read() {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fixture ${url}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  },
});

async function handle(req: HarnessRequest): Promise<HarnessResult> {
  switch (req.op) {
    case 'hash': {
      const store = await loadStore(fetchSource(req.url));
      return { op: 'hash', hash: await stateHash(store.resources()), resources: store.size };
    }
  }
}

addEventListener('message', (event: MessageEvent<{ id: number; req: HarnessRequest }>) => {
  const { id, req } = event.data;
  handle(req).then(
    (result) => postMessage({ id, ok: true, result } satisfies HarnessReply),
    (err: unknown) => postMessage({ id, ok: false, error: String(err) } satisfies HarnessReply),
  );
});
