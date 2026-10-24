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
    // t-a/9, one of the 10 keys, was a GRADER_ERROR and a regrade graded it FAIL.
    const regraded = summarize({ ...base, mode: 'live', trials: clean.map((t) => (t.task_id === 't-a' && t.index === 9 ? { ...t, outcome: 'GRADER_ERROR', regrades } : t)) });
    expect(regraded.totals).toMatchObject({ grader_error: 0, grader_error_history: 1 });
    expect(checkRequirements(regraded, parseRequire('valid=10,grader_error=0'))).toEqual([]);
    expect(() => assertSummary(JSON.parse(JSON.stringify(graderError)))).not.toThrow();
  });
});

describe('every figure reads the current grade: the last regrade, else the recorded outcome', () => {
  const pass = (over: Partial<SummaryTrial> = {}) => ({ outcome: 'PASS', score: 1, valid: true, ...over });
  const live = (ts: SummaryTrial[]) => summarize({ run_id: 'r', trials: ts, requeued: [], replay: replayAll(ts), mode: 'live' });

  it('5 FAIL regraded to PASS moves 5/10 to 10/10, out of band 2-7; the recorded counts stay as disclosure', () => {
    const ts = tenOf('t-a', 5).map((t) => (t.outcome === 'FAIL' ? { ...t, regrades: [pass()] } : t));
    const s = live(ts);
    expect(s.tasks['t-a']).toMatchObject({ trials: 10, passes: 10, pass_rate: 1, refusals: 0, outcomes: { PASS: 10 }, mean_score: 1, recorded_outcomes: { PASS: 5, FAIL: 5 }, regraded: 5 });
    expect(s.tasks['t-a']!.wilson95!.lo).toBeCloseTo(0.7225, 4);
    expect(s.totals).toMatchObject({ trials: 10, passes: 10, regraded: 5 });
    expect(checkRequirements(s, parseRequire('valid=10,band=2-7'))).toEqual(['t-a: 10/10 passes, outside the band 2-7']);
    expect(validateSummary(JSON.parse(JSON.stringify(s)))).toEqual([]);
  });

  it('a GRADER_ERROR among the 10 keys regraded to FAIL gives valid=10', () => {
    const ts = tenOf('t-a', 5).map((t) => (t.index === 9 ? { ...t, outcome: 'GRADER_ERROR', score: null, regrades: [{ outcome: 'FAIL', score: 0, valid: true }] } : t));
    const s = live(ts);
    expect(s.tasks['t-a']).toMatchObject({ trials: 10, passes: 5, grader_error: 0, grader_error_history: 1, outcomes: { PASS: 5, FAIL: 5 }, recorded_outcomes: { PASS: 5, FAIL: 4, GRADER_ERROR: 1 }, regraded: 1 });
    expect(checkRequirements(s, parseRequire('valid=10,band=2-7,grader_error=0'))).toEqual([]);
  });

  it("refusals and mean_score read the regrade's outcome and score; a regrade that is not valid leaves the denominator", () => {
    const ts = tenOf('t-a', 5).map((t) => {
      if (t.index === 0) return { ...t, regrades: [{ outcome: 'REFUSAL', score: 0, valid: true }] };
      if (t.index === 1) return { ...t, regrades: [{ outcome: 'GRADER_ERROR', score: null, valid: false }] };
      if (t.index === 5) return { ...t, regrades: [{ outcome: 'FAIL', score: 0.5, valid: true }] };
      return t;
    });
    const t = live(ts).tasks['t-a']!;
    expect(t).toMatchObject({ trials: 9, passes: 3, refusals: 1, refusal_excluded_rate: 3 / 8, grader_error: 1, regraded: 3 });
    expect(t.mean_score).toBeCloseTo((3 * 1 + 0 + 0.5 + 0 * 4) / 9, 10);
  });

  it('currentGrade is the one reader: the last entry wins, a missing score or valid falls back to the outcome', async () => {
    const { currentGrade } = await import('../summary.ts');
    expect(currentGrade({ outcome: 'FAIL', score: 0 })).toEqual({ outcome: 'FAIL', score: 0, valid: true, checks: null, regraded: false });
    expect(currentGrade({ outcome: 'FAIL', score: 0, checks: [{ id: 'G1', met: false }], regrades: [{ outcome: 'GRADER_ERROR' }, { outcome: 'PASS', score: 1, valid: true }] }))
      .toEqual({ outcome: 'PASS', score: 1, valid: true, checks: null, regraded: true });
    expect(currentGrade({ outcome: 'PASS', score: 1, regrades: [{ outcome: 'CANCELLED' }] })).toMatchObject({ outcome: 'CANCELLED', score: null, valid: false });
  });
});

describe('summary.json schema version', () => {
  it('is 2; a version 1 file is rejected with a message naming the version', () => {
    const ts = tenOf('t-a', 5);
    const s = summarize({ run_id: 'r', trials: ts, requeued: [], replay: replayAll(ts) });
    expect(s.schema_version).toBe(2);
    const v1 = { ...JSON.parse(JSON.stringify(s)), schema_version: 1 };
    expect(validateSummary(v1)).toContainEqual(expect.stringMatching(/schema_version 1.*version 2/));
    expect(() => assertSummary(v1)).toThrow(/schema_version 1/);
  });
});
