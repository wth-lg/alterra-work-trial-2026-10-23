// summary.json (plan phase P12): summarize() output validates against the exported schema, a
// record missing a field fails it, and Wilson 95% intervals match hand-checked values.
import { describe, expect, it } from 'vitest';
import { MODEL } from '../anthropic.ts';
import { assertSummary, checkRequirements, parseRequire, summarize, validateSummary, wilson, type SummaryTrial } from '../summary.ts';

const trial = (task_id: string, index: number, outcome: string, over: Partial<SummaryTrial> = {}): SummaryTrial => ({
  task_id, task_version: 'v1', index, outcome, model_requested: MODEL, models_returned: [MODEL],
  state_hash: { initial: 'h0', final: 'h1', replay_final: 'h1' }, tool_errors: { INTERNAL: 0 },
  cost_usd: 0.5, judge_cost_usd: 0.01, score: outcome === 'PASS' ? 1 : 0, ...over,
});

const tenOf = (task: string, passes: number) => Array.from({ length: 10 }, (_, i) => trial(task, i, i < passes ? 'PASS' : 'FAIL'));
const replayAll = (ts: SummaryTrial[]) => Object.fromEntries(ts.map((t) => [`${t.task_id}/${t.index}`, true]));

describe('wilson 95%', () => {
  it('5/10 is 23.7% to 76.3% (the design: 24-76%)', () => {
    const w = wilson(5, 10)!;
    expect(w.lo).toBeCloseTo(0.2366, 4);
    expect(w.hi).toBeCloseTo(0.7634, 4);
  });
  it('0/10 is 0% to 27.8%, 10/10 is 72.2% to 100%', () => {
    expect(wilson(0, 10)!.lo).toBeCloseTo(0, 10);
    expect(wilson(0, 10)!.hi).toBeCloseTo(0.2775, 4);
    expect(wilson(10, 10)!.lo).toBeCloseTo(0.7225, 4);
    expect(wilson(10, 10)!.hi).toBeCloseTo(1, 10);
  });
  it('no trials: no interval', () => expect(wilson(0, 0)).toBeNull());
});

describe('summary.json schema', () => {
  const trials = [...tenOf('t-a', 5), ...tenOf('t-b', 3)];
  const summary = () => summarize({ run_id: 'r1', trials, requeued: [], replay: replayAll(trials) });

  it("summarize's output validates, before and after a JSON round trip", () => {
    const s = summary();
    expect(validateSummary(s)).toEqual([]);
    expect(validateSummary(JSON.parse(JSON.stringify(s)))).toEqual([]);
    expect(() => assertSummary(s)).not.toThrow();
    expect(s.tasks['t-a']).toMatchObject({ trials: 10, passes: 5, records: 10 });
    expect(s.initial_state_hashes).toEqual(['h0']);
  });

  it('a task record missing a field fails, naming it', () => {
    const s = summary() as unknown as { tasks: Record<string, Record<string, unknown>> };
    delete s.tasks['t-a']!.passes;
    expect(validateSummary(s)).toContainEqual(expect.stringContaining('tasks.t-a.passes'));
    expect(() => assertSummary(s)).toThrow(/tasks\.t-a\.passes/);
  });

  it('a missing top-level field and a wrong type fail', () => {
    const s = summary() as unknown as Record<string, unknown>;
    delete s.initial_state_hashes;
    expect(validateSummary(s)).toContainEqual(expect.stringContaining('initial_state_hashes'));
    const t = summary() as unknown as { totals: Record<string, unknown> };
    t.totals.env_error_raw = '0';
    expect(validateSummary(t)).toContainEqual(expect.stringContaining('totals.env_error_raw'));
  });

  it('ENV_ERROR is counted raw, re-queued attempts included', () => {
    const s = summarize({ run_id: 'r1', trials, requeued: [trial('t-a', 3, 'ENV_ERROR')], replay: replayAll(trials) });
    expect(s.totals.env_error_raw).toBe(1);
    expect(s.tasks['t-a']!.env_error_raw).toBe(1);
  });
});

describe('--require', () => {
  it('parses the plan form and the donewhen aliases', () => {
    expect(parseRequire('valid=10,band=2-7,env_error_raw=0,model=claude-opus-5-5,replay=all')).toEqual({ valid: 10, band: [2, 7], env_error_raw: 0, model: MODEL, replay: 'all' });
    expect(parseRequire(`trials=10,pass-min=2,pass-max=7,model=${MODEL}`)).toEqual({ valid: 10, band: [2, 7], model: MODEL });
    expect(() => parseRequire('valid=ten')).toThrow(/valid/);
    expect(() => parseRequire('colour=blue')).toThrow(/colour/);
  });

  it('a clean run meets every requirement; 8/10 breaks the band', () => {
    const req = parseRequire(`valid=10,band=2-7,env_error_raw=0,model=${MODEL},replay=all`);
    const clean = [...tenOf('t-a', 5), ...tenOf('t-b', 3)];
    expect(checkRequirements(summarize({ run_id: 'r', trials: clean, requeued: [], replay: replayAll(clean), mode: 'live' }), req)).toEqual([]);
    const high = [...tenOf('t-a', 8), ...tenOf('t-b', 3)];
    expect(checkRequirements(summarize({ run_id: 'r', trials: high, requeued: [], replay: replayAll(high), mode: 'live' }), req)).toEqual([expect.stringMatching(/t-a.*8\/10.*2-7/)]);
  });

  it('with any requirement, an expected task without records, a mock run and a GRADER_ERROR record are violations', () => {
    const clean = [...tenOf('t-a', 5), ...tenOf('t-b', 3)];
    const base = { run_id: 'r', trials: clean, requeued: [], replay: replayAll(clean) };
    const missing = summarize({ ...base, mode: 'live', expected: { tasks: ['t-a', 't-b', 't-c'], from: 'the run manifest' } });
    expect(checkRequirements(missing, parseRequire('valid=10'))).toEqual(['t-c: expected by the run manifest, no records', 't-c: 0 valid trials, required 10']);
    expect(checkRequirements(missing, {})).toEqual([]);
    const mock = summarize({ ...base, mode: 'mock-toy' });
    expect(checkRequirements(mock, parseRequire('valid=10'))).toEqual([expect.stringMatching(/mode mock-toy: not a live run; pass --allow-mock/)]);
    expect(checkRequirements(mock, { ...parseRequire('valid=10'), allow_mock: true })).toEqual([]);
    expect(checkRequirements(mock, { ...parseRequire('valid=10,mode=live'), allow_mock: true })).toEqual(['mode mock-toy, required live']);
    const graderError = summarize({ ...base, mode: 'live', trials: [...clean, trial('t-a', 10, 'GRADER_ERROR')] });
    expect(graderError.totals).toMatchObject({ grader_error: 1, grader_error_history: 0 });
    expect(checkRequirements(graderError, parseRequire('valid=10,grader_error=0'))).toEqual([expect.stringMatching(/GRADER_ERROR in 1 record at its current grade/)]);
    const regrades = [{ outcome: 'GRADER_ERROR' }, { outcome: 'FAIL' }];
    const regraded = summarize({ ...base, mode: 'live', trials: [...clean, trial('t-a', 10, 'GRADER_ERROR', { regrades })] });
    expect(regraded.totals).toMatchObject({ grader_error: 0, grader_error_history: 1 });
    expect(checkRequirements(regraded, parseRequire('valid=10,grader_error=0'))).toEqual([]);
    expect(() => assertSummary(JSON.parse(JSON.stringify(graderError)))).not.toThrow();
  });
});
