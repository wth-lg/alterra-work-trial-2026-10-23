// An environment exception anywhere in run() ends the trial as ENV_ERROR INTERNAL (plan phase
// P7): a terminal error event last in the trajectory and a record, never a throw out of run().
// Each site gets an injected throw: the world read, loadStore (the trial's and replay's), the
// state hash (initial, after a write, final, replay's) and the task_version hash.
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { scriptedTransport, SCENARIOS } from '../../../apps/web/src/harness/scenarios.ts';
import { WRITE_TASK } from '../../../apps/web/src/harness/write-task.ts';
import { MessagesClient } from '../anthropic.ts';
import { parseEvent, terminalEvent, type TrialEvent } from '../events.ts';
import { admitStore, createLedger, type LedgerRow, type LedgerStore } from '../ledger.ts';
import { run } from '../run.ts';
import { taskSource } from '../tasks.ts';
import { toJsonl } from '../trajectory.ts';

// Which call of each function throws (1-based); 0 for none.
const fail = vi.hoisted(() => ({ stateHash: 0, loadStore: 0, taskVersions: 0, calls: { stateHash: 0, loadStore: 0, taskVersions: 0 } }));

function counted<A extends unknown[], R>(name: 'stateHash' | 'loadStore' | 'taskVersions', fn: (...a: A) => R): (...a: A) => R {
  return (...a) => {
    if (++fail.calls[name] === fail[name]) throw new Error(`injected ${name} failure`);
    return fn(...a);
  };
}

vi.mock('../../env/hash.ts', async (orig) => {
  const m = await orig<typeof import('../../env/hash.ts')>();
  return { ...m, stateHash: counted('stateHash', m.stateHash) };
});
vi.mock('../../env/fixture-source.ts', async (orig) => {
  const m = await orig<typeof import('../../env/fixture-source.ts')>();
  return { ...m, loadStore: counted('loadStore', m.loadStore) };
});
vi.mock('../tasks.ts', async (orig) => {
  const m = await orig<typeof import('../tasks.ts')>();
  return { ...m, taskVersions: counted('taskVersions', m.taskVersions) };
});

const root = new URL('../../../', import.meta.url);
const WORLD = new Uint8Array(readFileSync(new URL('fixtures/world.ndjson.gz', root)));
const MANIFEST = JSON.parse(readFileSync(new URL('fixtures/manifest.json', root), 'utf8')) as { world: { state_hash: string } };
const DEFINITIONS = JSON.parse(readFileSync(new URL('fixtures/definitions-pruned.json', root), 'utf8'));

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

async function trial(worldRead: () => Promise<Uint8Array> = async () => WORLD) {
  const store = new MemoryStore();
  admitStore(store);
  let id = 0;
  const ledger = createLedger({ store, clock: { now: () => 't' }, newId: () => `id-${++id}`, source: 'node', runId: null, pid: 1, host: 'h', isAlive: () => true });
  const grant = await ledger.batchStart(6);
  const mock = scriptedTransport(SCENARIOS.write);
  const client = new MessagesClient({ grant, ledger, apiKey: 'test-key-not-real', fetch: mock.transport, sleep: async () => {} });
  const events: TrialEvent[] = [];
  const result = await run('_write', 'claude-opus-5-5', {
    tasks: taskSource(async () => [WRITE_TASK], { testMode: true }),
    client,
    world: { read: worldRead },
    worldHash: MANIFEST.world.state_hash,
    definitions: DEFINITIONS,
    now: () => 0,
    onEvent: (e) => events.push(e),
  });
  return { result, events };
}

beforeEach(() => {
  Object.assign(fail, { stateHash: 0, loadStore: 0, taskVersions: 0, calls: { stateHash: 0, loadStore: 0, taskVersions: 0 } });
});

describe('an environment exception in run()', () => {
  it('the write scenario runs clean with nothing injected (calls: 2 loadStore, 4 stateHash)', async () => {
    const { result } = await trial();
    expect(result.record.status).toBe('COMPLETED');
    expect(fail.calls).toEqual({ stateHash: 4, loadStore: 2, taskVersions: 1 });
  });

  it.each([
    ['the world read', {}, true],
    ['loadStore (trial)', { loadStore: 1 }, false],
    ['loadStore (replay)', { loadStore: 2 }, false],
    ['stateHash (initial)', { stateHash: 1 }, false],
    ['stateHash (after a write)', { stateHash: 2 }, false],
    ['stateHash (final)', { stateHash: 3 }, false],
    ['stateHash (replay)', { stateHash: 4 }, false],
    ['taskVersions', { taskVersions: 1 }, false],
  ] as const)('%s ends as ENV_ERROR INTERNAL with a record and a last error event', async (_site, inject, badWorld) => {
    Object.assign(fail, inject);
    const { result, events } = await trial(badWorld ? async () => Promise.reject(new Error('injected world read failure')) : undefined);
    expect(result.record).toMatchObject({ status: 'ENV_ERROR', detail: 'INTERNAL' });
    expect(terminalEvent(events)).toMatchObject({ type: 'error', status: 'ENV_ERROR', code: 'INTERNAL', message: expect.stringMatching(/injected/) });
    expect(events.at(-1)!.type).toBe('graded');
    expect(events.filter((e) => e.type === 'error' || e.type === 'limit' || e.type === 'cancelled')).toHaveLength(1);
    for (const e of events) parseEvent(JSON.parse(JSON.stringify(e)));
    expect(toJsonl(result.events)).toBe(events.map((e) => `${JSON.stringify(e)}\n`).join(''));
  });
});
