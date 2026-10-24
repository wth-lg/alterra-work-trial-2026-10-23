// hostTrial's teardown (plan phase P7): what setup defers (the harness Worker defers closing
// its grant right after batchStart) runs once after run(), and also when setup fails after
// deferring it, before the result or failure is posted.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scenarioTransport } from '../../../apps/web/src/harness/scenarios.ts';
import { nodeTaskSource } from '../../../cli/adapters/tasks-node.ts';
import { MessagesClient } from '../anthropic.ts';
import { admitStore, createLedger, type LedgerRow, type LedgerStore } from '../ledger.ts';
import { hostTrial, type HostOutbound, type HostScope, type HostSetup, type HostStart } from '../worker-host.ts';

const root = new URL('../../../', import.meta.url);
const WORLD = new Uint8Array(readFileSync(new URL('fixtures/world.ndjson.gz', root)));
const MANIFEST = JSON.parse(readFileSync(new URL('fixtures/manifest.json', root), 'utf8')) as { world: { state_hash: string } };

class MemoryStore implements LedgerStore {
  rows: LedgerRow[] = [];
  async transact<T>(fn: (rows: readonly LedgerRow[]) => { append: LedgerRow[]; result: T }): Promise<T> {
    const { append, result } = fn(this.rows);
    this.rows.push(...append);
    return result;
  }
  async read(): Promise<LedgerRow[]> {
    return [...this.rows];
  }
}

// A fake Worker scope: start posts the message and resolves with every post up to the last.
function scope() {
  const posted: Array<HostOutbound | 'teardown'> = [];
  let listener: (e: { data: unknown }) => void = () => {};
  let done: () => void = () => {};
  const finished = new Promise<void>((r) => (done = r));
  const s: HostScope = {
    postMessage: (m) => {
      posted.push(m);
      if (m.type !== 'event') done();
    },
    addEventListener: (_t, l) => (listener = l),
  };
  return { s, posted, start: (msg: HostStart) => (listener({ data: msg }), finished) };
}

function setupWith(store: MemoryStore, posted: Array<HostOutbound | 'teardown'>, failAfterBatch: boolean): HostSetup<HostStart> {
  return async (_start, defer) => {
    let id = 0;
    const ledger = createLedger({ store, clock: { now: () => 't' }, newId: () => `id-${++id}`, source: 'node', runId: null, pid: 1, host: 'h', isAlive: () => true });
    const grant = await ledger.batchStart(6);
    defer(async () => {
      posted.push('teardown');
      await grant.close();
    });
    if (failAfterBatch) throw new Error('manifest: HTTP 404');
    return {
      tasks: nodeTaskSource({ testMode: true }),
      client: new MessagesClient({ grant, ledger, apiKey: 'test-key-not-real', fetch: scenarioTransport('toy').transport }),
      world: { read: async () => WORLD },
      worldHash: MANIFEST.world.state_hash,
      now: () => 0,
    };
  };
}

describe('hostTrial teardown', () => {
  it.each([false, true])('closes the grant once (setup fails after batchStart: %s), before posting the outcome', async (failAfterBatch) => {
    const store = new MemoryStore();
    admitStore(store);
    const { s, posted, start } = scope();
    hostTrial(s, setupWith(store, posted, failAfterBatch));
    await start({ type: 'start', task: '_toy', model: 'claude-opus-5-5' });
    const tail = posted.filter((p) => p === 'teardown' || p.type !== 'event').map((p) => (p === 'teardown' ? p : p.type));
    expect(tail).toEqual(['teardown', failAfterBatch ? 'failed' : 'result']);
    expect(store.rows.filter((r) => r.kind === 'open')).toHaveLength(1);
    expect(store.rows.filter((r) => r.kind === 'close')).toHaveLength(1);
  });
});
