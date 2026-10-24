// run() grades (plan phase P8): it replays the tool log, grades the trial with the task's
// checks, emits the graded record as the last trial event for every outcome, and returns the
// same record. `pnpm cli run-one --mock` writes outcome, gate checks and rubric scores into its
// record, equal to a direct grader call on the trajectory it wrote, and a run() that throws
// before any spend still leaves an ENV_ERROR INTERNAL record.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir, write } from '../../../scripts/test/helpers.ts';
import { okResponse, scriptedTransport, SCENARIOS } from '../../../apps/web/src/harness/scenarios.ts';
import { nodeTaskSource } from '../../../cli/adapters/tasks-node.ts';
import { main, type Deps } from '../../../cli/run-one.ts';
import { gate, judged, rubric, type Check } from '../../grader/check.ts';
import { MessagesClient, type Transport } from '../anthropic.ts';
import { parseEvent, terminalEvent, type GradedEvent, type TrialEvent } from '../events.ts';
import { admitStore, createLedger, type LedgerRow, type LedgerStore } from '../ledger.ts';
import { gradeTrajectory, run, type RunOptions, type TrialRecord } from '../run.ts';
import { parseTrajectory, stripTimestamps, toJsonl } from '../trajectory.ts';

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

// _toy's checks: the patient read before finish (gate), the summary names the patient (judge),
// and a code item that is not met, so the score is not trivially 1.
const CHECKS: Check[] = [
  gate({ id: 'G1', category: 'retrieval', traces_to: 'instruction L4', decisive_ids: ['pt-0001'], fn: (ctx) => ({ met: ctx.exposedAt('pt-0001') !== null, evidence: { exposed: ctx.exposedAt('pt-0001') !== null } }) }),
  judged({ id: 'R1', points: 2, category: 'documentation', traces_to: 'instruction L5', decisive_ids: [], criterion: 'The summary names the patient that was read.', text: (ctx) => ctx.final_text ?? '' }),
  rubric({ id: 'R2', points: 1, method: 'code', category: 'action', traces_to: 'instruction L6', decisive_ids: [], fn: (ctx) => ({ met: ctx.writes().length > 0, evidence: { writes: ctx.writes().length } }) }),
];
const VERDICT = '{"verdict":"met","quote":"Patient/pt-0001"}';

// Trial requests (they carry tools) get the scenario; judge requests get VERDICT.
function routed(trial: Transport) {
  let judgeCalls = 0;
  const transport: Transport = async (request) => {
    const body = JSON.parse(await request.clone().text()) as { tools?: unknown };
    if (body.tools !== undefined) return trial(request);
    judgeCalls++;
    return okResponse({ text: VERDICT }, 100 + judgeCalls);
  };
  return { transport, judgeCalls: () => judgeCalls };
}

async function trial(over: Partial<RunOptions> = {}) {
  const store = new MemoryStore();
  admitStore(store);
  let id = 0;
  const ledger = createLedger({ store, clock: { now: () => 't' }, newId: () => `id-${++id}`, source: 'node', runId: null, pid: 1, host: 'h', isAlive: () => true });
  const grant = await ledger.batchStart(6);
  const r = routed(scriptedTransport(SCENARIOS.toy).transport);
  let clock = Date.UTC(2026, 9, 23, 12);
  const client = new MessagesClient({ grant, ledger, apiKey: 'test-key-not-real', fetch: (q) => ((clock += 4000), r.transport(q)), sleep: async () => {} });
  const events: TrialEvent[] = [];
  const result = await run('_toy', 'claude-opus-5-5', {
    tasks: nodeTaskSource({ testMode: true }), client, world: { read: async () => WORLD }, worldHash: MANIFEST.world.state_hash,
    now: () => clock, onEvent: (e) => events.push(e), checks: CHECKS, ...over,
  });
  return { result, events, judgeCalls: r.judgeCalls, rows: store.rows };
}

const GRADE_KEYS = ['grader_version', 'outcome', 'valid', 'checks', 'score', 'judge', 'attribution'] as const;
const gradeOf = (r: Pick<TrialRecord, (typeof GRADE_KEYS)[number]>) => Object.fromEntries(GRADE_KEYS.map((k) => [k, r[k]]));

describe('run() grades', () => {
  it('emits the graded record last, equal to the returned record, cost and turns included', async () => {
    const { result, events, judgeCalls, rows } = await trial();
    const last = events.at(-1)!;
    expect(last.type).toBe('graded');
    expect(() => parseEvent(JSON.parse(JSON.stringify(last)))).not.toThrow();
    expect((last as GradedEvent).record).toEqual(result.record);
    expect(result.events.at(-1)).toBe(last);
    expect(events.filter((e) => e.type === 'graded')).toHaveLength(1);
    expect(result.record).toMatchObject({ status: 'COMPLETED', outcome: 'PASS', valid: true, turns: 2, score: 2 / 3 });
    expect(result.record.cost_usd).toBeGreaterThan(0);
    expect(result.record.checks.map((c) => [c.id, c.met])).toEqual([['G1', true], ['R1', true], ['R2', false]]);
    // The judge ran through the trial's client: metered by the same ledger, at effort low.
    expect(judgeCalls()).toBe(1);
    expect(result.record.judge_cost_usd).toBeGreaterThan(0);
    expect(rows.filter((r) => r.kind === 'settle')).toHaveLength(3);
    // The terminal-event helper skips graded.
    expect(terminalEvent(events)).toBe(events.at(-2));
  });

  it('a direct grader call on the trajectory gives the same grade, from the record cache', async () => {
    const { result, events } = await trial();
    const direct = await gradeTrajectory('_toy', { tasks: nodeTaskSource({ testMode: true }), world: { read: async () => WORLD }, checks: CHECKS, events, record: result.record });
    expect(direct).toEqual(gradeOf(result.record));
  });

  it('two runs on different clocks agree once stripped; a changed outcome or gate check does not', async () => {
    const a = await trial();
    const b = await trial({ now: () => 0 });
    const stripped = (events: readonly TrialEvent[]) => stripTimestamps(toJsonl(events));
    expect(stripped(b.events)).toBe(stripped(a.events));
    const plant = (change: (r: TrialRecord) => TrialRecord) => {
      const events = [...b.events];
      const g = events.at(-1) as GradedEvent;
      events[events.length - 1] = { ...g, record: change(structuredClone(g.record)) };
      return stripped(events);
    };
    expect(plant((r) => ({ ...r, outcome: 'FAIL' }))).not.toBe(stripped(a.events));
    expect(plant((r) => ({ ...r, checks: r.checks.map((c) => (c.id === 'G1' ? { ...c, met: false } : c)) }))).not.toBe(stripped(a.events));
    expect(plant((r) => ({ ...r, cost_usd: r.cost_usd + 0.01 }))).not.toBe(stripped(a.events));
  });

  it.each([
    ['ENV_ERROR', { worldHash: '0'.repeat(64) }],
    ['CANCELLED', { signal: AbortSignal.abort(new Error('user cancelled')) }],
  ] as const)('%s: graded last as an invalid trial, never a model failure, no judge call', async (outcome, over) => {
    const { result, events, judgeCalls } = await trial(over);
    expect(events.at(-1)).toMatchObject({ type: 'graded', record: { outcome, valid: false, checks: [], score: null, attribution: null } });
    expect(terminalEvent(events)!.type).toBe(outcome === 'CANCELLED' ? 'cancelled' : 'error');
    expect(result.record.outcome).toBe(outcome);
    expect(judgeCalls()).toBe(0);
  });
});

function harness(env: Record<string, string>, over: Partial<Deps> = {}) {
  const lines: string[] = [];
  const deps: Deps = {
    env,
    out: (l) => lines.push(l),
    fetch: () => Promise.reject(new Error('no live calls in this test')),
    mock: () => routed(scriptedTransport(SCENARIOS.toy).transport).transport,
    checks: async () => CHECKS,
    ...over,
  };
  return { deps, lines };
}

const ARGS = ['--task', '_toy', '--model', 'claude-opus-5-5', '--effort', 'high', '--index', '0'];
const KEY = '_toy/claude-opus-5-5/high/mock-toy/0';

describe('cli run-one grades', () => {
  it('writes outcome, gate checks and rubric scores equal to a direct grader call; the last line is the graded event', async () => {
    const dir = tempDir('run-one-graded');
    const h = harness({ SPEND_LEDGER: join(dir, 'spend.jsonl') });
    expect(await main([...ARGS, '--mock', 'toy', '--out', dir], h.deps)).toBe(0);
    const record = JSON.parse(readFileSync(join(dir, `trials/${KEY}.json`), 'utf8')) as TrialRecord & { mock: string; trajectory: string };
    expect(record).toMatchObject({ outcome: 'PASS', valid: true, score: 2 / 3, mock: 'toy', trajectory: `trajectories/${KEY}.jsonl` });
    expect(record.checks.filter((c) => c.kind === 'gate').map((c) => [c.id, c.met])).toEqual([['G1', true]]);
    expect(record.checks.filter((c) => c.kind === 'rubric').map((c) => [c.id, c.points, c.met])).toEqual([['R1', 2, true], ['R2', 1, false]]);
    expect(h.lines.join('\n')).toMatch(/outcome PASS, score 0\.667, gates 1\/1/);

    const events = parseTrajectory(readFileSync(join(dir, record.trajectory), 'utf8'));
    const last = events.at(-1)!;
    expect(last.type).toBe('graded');
    expect(gradeOf((last as GradedEvent).record)).toEqual(gradeOf(record));
    const direct = await gradeTrajectory('_toy', { tasks: nodeTaskSource({ testMode: true }), world: { read: async () => WORLD }, checks: CHECKS, events, record });
    expect(direct).toEqual(gradeOf(record));
  });

  it('adds the judge allowance to the projection', async () => {
    const dir = tempDir('run-one-graded');
    const h = harness({ SPEND_LEDGER: join(dir, 'spend.jsonl') });
    expect(await main([...ARGS, '--dry-run', '--out', dir], h.deps)).toBe(0);
    const line = h.lines.find((l) => l.startsWith('LIVE_PROJECTION_USD='))!;
    expect(Number(line.split('=')[1])).toBeGreaterThan(6);
    const none = harness({ SPEND_LEDGER: join(dir, 'spend.jsonl') }, { checks: async () => [] });
    expect(await main([...ARGS, '--dry-run', '--out', dir], none.deps)).toBe(0);
    expect(none.lines).toContain('LIVE_PROJECTION_USD=6.000000');
  });

  it('records a run() that throws before any spend as ENV_ERROR INTERNAL, never a model failure', async () => {
    const dir = tempDir('run-one-graded');
    write(dir, 'spend.jsonl', '');
    const real = nodeTaskSource({ testMode: true });
    let gets = 0;
    // The first get is run-one's own check of --task; the second, inside run(), fails.
    const tasks = { all: () => real.all(), get: (id: string) => (++gets === 1 ? real.get(id) : Promise.reject(new Error('task source went away'))) };
    const h = harness({ SPEND_LEDGER: join(dir, 'spend.jsonl') }, { tasks });
    expect(await main([...ARGS, '--mock', 'toy', '--out', dir], h.deps)).toBe(1);
    const record = JSON.parse(readFileSync(join(dir, `trials/${KEY}.json`), 'utf8')) as TrialRecord;
    expect(record).toMatchObject({ status: 'ENV_ERROR', detail: 'INTERNAL', outcome: 'ENV_ERROR', valid: false, checks: [], score: null, cost_usd: 0, turns: 0 });
    const rows = readFileSync(join(dir, 'spend.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as LedgerRow);
    expect(rows.filter((r) => r.kind === 'reserve')).toHaveLength(0);
  });
});
