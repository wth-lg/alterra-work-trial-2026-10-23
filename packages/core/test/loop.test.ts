// run() against the mocked Messages API (plan phase P7, design section 6): thinking blocks
// echoed byte for byte, an append-only conversation, tool calls run one at a time in emitted
// order, ENV_ERROR when the initial hash is not the manifest's, LIMIT at each cap, and finish
// ending the episode mid-turn. In every scenario the onEvent stream, serialized, is the
// trajectory JSONL line for line, and every event validates against events.ts.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scriptedTransport, SCENARIOS, type Script, type ScriptedTransport } from '../../../apps/web/src/harness/scenarios.ts';
import { nodeTaskSource } from '../../../cli/adapters/tasks-node.ts';
import { MessagesClient } from '../anthropic.ts';
import { parseEvent, type TrialEvent } from '../events.ts';
import { admitStore, createLedger, type LedgerRow, type LedgerStore } from '../ledger.ts';
import { run, type RunOptions } from '../run.ts';
import { stripTimestamps, toJsonl } from '../trajectory.ts';

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

// A trial over the committed world and tasks/, through a real MessagesClient metered by an
// in-memory ledger, with a wall clock that moves 4 s per request sent.
async function trial(script: Script, over: Partial<RunOptions> = {}, task = '_toy') {
  const store = new MemoryStore();
  admitStore(store);
  let id = 0;
  const ledger = createLedger({ store, clock: { now: () => 't' }, newId: () => `id-${++id}`, source: 'node', runId: null, pid: 1, host: 'h', isAlive: () => true });
  const grant = await ledger.batchStart(6);
  const mock: ScriptedTransport = scriptedTransport(script);
  let clock = Date.UTC(2026, 9, 23, 12);
  const send = mock.transport;
  const client = new MessagesClient({ grant, ledger, apiKey: 'test-key-not-real', fetch: (r) => ((clock += 4000), send(r)), sleep: async () => {} });
  const events: TrialEvent[] = [];
  const result = await run(task, 'claude-opus-5-5', {
    tasks: nodeTaskSource({ testMode: true }),
    client,
    world: { read: async () => WORLD },
    worldHash: MANIFEST.world.state_hash,
    now: () => clock,
    onEvent: (e) => events.push(e),
    ...over,
  });
  return { result, events, mock, store };
}

// The checks every scenario must pass, whatever it ends in.
function checkStream(events: TrialEvent[], resultEvents: readonly TrialEvent[]) {
  for (const e of events) expect(() => parseEvent(JSON.parse(JSON.stringify(e)))).not.toThrow();
  const streamed = events.map((e) => JSON.stringify(e));
  expect(toJsonl(resultEvents).split('\n').filter((l) => l !== '')).toEqual(streamed);
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i));
}

const types = (events: readonly TrialEvent[]) => events.map((e) => e.type);

describe('run() with a mocked API', () => {
  it('echoes every thinking block byte for byte in the next request', async () => {
    const { result, events, mock } = await trial(SCENARIOS.thinking);
    checkStream(events, result.events);
    expect(result.record.status).toBe('COMPLETED');
    expect(mock.raw).toHaveLength(3);
    const responses = events.filter((e) => e.type === 'response');
    for (let i = 0; i < 2; i++) {
      const thinking = responses[i]!.content.find((b) => b.type === 'thinking')!;
      expect(thinking.thinking).toBe(SCENARIOS.thinking[i]!.thinking);
      // The assistant turn of request i+1 is the answer to request i, exactly as streamed.
      const echoed = mock.bodies[i + 1]!.messages[2 * i + 1]!;
      expect(echoed.role).toBe('assistant');
      expect(JSON.stringify(echoed.content)).toBe(JSON.stringify(responses[i]!.content));
      expect(mock.raw[i + 1]).toContain(JSON.stringify(thinking));
    }
  });

  it('keeps the conversation append-only: each request extends the last one', async () => {
    const { result, events, mock } = await trial(SCENARIOS.thinking);
    checkStream(events, result.events);
    for (let i = 1; i < mock.bodies.length; i++) {
      const before = mock.bodies[i - 1]!.messages.map((m) => JSON.stringify(m));
      const after = mock.bodies[i]!.messages.map((m) => JSON.stringify(m));
      expect(after.length).toBe(before.length + 2);
      expect(after.slice(0, before.length)).toEqual(before);
    }
    // Every request but the conversation is the same bytes, so the prompt cache prefix holds.
    const rest = mock.bodies.map(({ messages: _m, ...r }) => JSON.stringify(r));
    expect(new Set(rest).size).toBe(1);
    // The request events carry the deltas: concatenated with the answers, they are the conversation.
    const rebuilt: unknown[] = [];
    for (const e of events) {
      if (e.type === 'request') rebuilt.push(...e.messages);
      if (e.type === 'response') rebuilt.push({ role: 'assistant', content: e.content });
    }
    expect(JSON.stringify(rebuilt.slice(0, mock.bodies.at(-1)!.messages.length))).toBe(JSON.stringify(mock.bodies.at(-1)!.messages));
  });

  it('runs parallel tool calls one at a time, in emitted order, and answers them in that order', async () => {
    const { result, events, mock } = await trial(SCENARIOS.serial);
    checkStream(events, result.events);
    const ids = SCENARIOS.serial[0]!.tools!.map((t) => t.id);
    const toolEvents = events.filter((e) => e.type === 'tool_call' || e.type === 'tool_result').map((e) => `${e.type}:${'tool_use_id' in e ? e.tool_use_id : ''}`);
    expect(toolEvents).toEqual(ids.flatMap((id) => [`tool_call:${id}`, `tool_result:${id}`]));
    const answer = mock.bodies[1]!.messages.at(-1)!;
    expect(answer.role).toBe('user');
    expect((answer.content as Array<{ type: string; tool_use_id: string }>).map((b) => `${b.type}:${b.tool_use_id}`)).toEqual(ids.map((id) => `tool_result:${id}`));
    const results = events.filter((e) => e.type === 'tool_result');
    expect(results.map((r) => r.exposed_ids)).toEqual([['Patient/pt-0003'], [], ['Patient/pt-0001']]);
    expect(result.record.tool_calls).toBe(3);
  });

  it('ends as ENV_ERROR before the first call when the initial hash is not the manifest hash', async () => {
    const { result, events, mock } = await trial(SCENARIOS.toy, { worldHash: '0'.repeat(64) });
    checkStream(events, result.events);
    expect(mock.raw).toHaveLength(0);
    expect(result.record.status).toBe('ENV_ERROR');
    expect(types(events)).toEqual(['state_hash', 'error']);
    expect(events.at(-1)).toMatchObject({ type: 'error', status: 'ENV_ERROR', code: 'initial_hash_mismatch' });
    expect(result.record.state_hash.initial).toBe(MANIFEST.world.state_hash);
  });

  it.each([
    ['turns', { maxTurns: 3 }, 3],
    ['cost', { maxCostUsd: 0.03 }, 3],
    ['wall_clock', { maxWallMs: 9_500 }, 3],
  ] as const)('ends as LIMIT at the %s cap', async (limit, caps, calls) => {
    const { result, events, mock } = await trial(SCENARIOS.forever, caps);
    checkStream(events, result.events);
    expect(result.record.status).toBe('LIMIT');
    expect(mock.raw).toHaveLength(calls);
    expect(events.at(-1)).toMatchObject({ type: 'limit', limit });
    expect(result.record.state_hash.replay_final).toBe(result.record.state_hash.final);
  });

  it('stops at finish mid-turn: earlier calls run, later ones are recorded as skipped', async () => {
    const { result, events, mock } = await trial(SCENARIOS.finishMid);
    checkStream(events, result.events);
    expect(mock.raw).toHaveLength(1);
    expect(result.record).toMatchObject({ status: 'COMPLETED', stop: 'finish', summary: 'Stopping early on purpose.' });
    const results = events.filter((e) => e.type === 'tool_result');
    expect(results.map((r) => [r.tool_use_id, r.executed, r.is_error])).toEqual([
      ['toolu_f1', true, false],
      ['toolu_f2', true, false],
      ['toolu_f3', false, true],
    ]);
    expect(results[2]!.content).toEqual({ error: { code: 'CONFLICT', message: 'episode finished' } });
  });

  it('completes the toy scenario with replay_final equal to final and the record filled in', async () => {
    const { result, events } = await trial(SCENARIOS.toy);
    checkStream(events, result.events);
    const r = result.record;
    expect(r).toMatchObject({ status: 'COMPLETED', stop: 'finish', task_id: '_toy', effort: 'high', models_returned: ['claude-opus-5-5'], turns: 2, tool_calls: 3 });
    expect(r.state_hash.initial).toBe(MANIFEST.world.state_hash);
    expect(r.state_hash.replay_final).toBe(r.state_hash.final);
    expect(r.task_version).toMatch(/^[0-9a-f]{64}$/);
    expect(r.cost_usd).toBeGreaterThan(0);
    // Timestamps are the only thing an injected clock changes.
    const again = await trial(SCENARIOS.toy, { now: () => 0 });
    expect(stripTimestamps(toJsonl(again.result.events))).toBe(stripTimestamps(toJsonl(result.events)));
  });
});
