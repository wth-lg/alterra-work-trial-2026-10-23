// A run's summary (plan phase P12, design section 6 "summary <run>"): per task pass k/n over its
// valid trials with a Wilson 95% interval, the raw ENV_ERROR count (re-queued attempts included),
// the models seen, the initial state hashes and the replay check, plus the --require
// requirements. summary.json is a Summary; validateSummary is its schema, which P14 validates
// its sample against. Pure: cli/summary.ts reads the run directory and writes the file.
//
// The run's mode and expected tasks come from its manifest (task_versions) or --task. Whenever a
// requirement is given, a task expected and without records is a violation, and so is a run that
// is not live, unless the caller allows a mock run. grader_error=N checks each record's current
// grade: its last regrades[] entry, else its outcome, so a run whose grader bug was fixed and
// regraded can pass. grader_error_history counts the records that were GRADER_ERROR in an earlier
// grade; it is disclosed, never a requirement. A GRADER_ERROR is settled, never re-queued as a
// model trial: regrade grades it again from its trajectory.
//
// Wilson score interval, z = 1.959964 (two-sided 95%), for k passes in n valid trials, p = k/n:
//   centre = (p + z²/2n) / (1 + z²/n)
//   half   = z / (1 + z²/n) · sqrt(p(1-p)/n + z²/4n²)
//   [centre - half, centre + half]; 5/10 gives 0.2366 to 0.7634.
import { isValid, OUTCOMES } from './outcomes.ts';

export const SUMMARY_SCHEMA_VERSION = 1;
export const WILSON_Z = 1.959963984540054;

export interface Interval {
  lo: number;
  hi: number;
}

export function wilson(k: number, n: number, z = WILSON_Z): Interval | null {
  if (n === 0) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z / denom) * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

// What the summary reads from one trial record.
export interface SummaryTrial {
  task_id: string;
  task_version: string | null;
  index: number;
  outcome: string;
  model_requested: string;
  models_returned: readonly string[];
  state_hash: { initial: string | null; final: string | null; replay_final: string | null };
  tool_errors: Readonly<Record<string, number>>;
  cost_usd: number;
  judge_cost_usd?: number;
  score: number | null;
  // cli regrade's entries, oldest first; the last is the current grade.
  regrades?: ReadonlyArray<{ outcome: string }>;
}

export interface SummaryInput {
  run_id: string;
  // One settled record per trial key.
  trials: readonly SummaryTrial[];
  // Attempts that were re-queued (INFRA, ENV_ERROR, CANCELLED): counted raw, never in a rate.
  requeued: readonly SummaryTrial[];
  // replay.json, written by `pnpm cli replay`: whether each trial (<task>/<index>) reproduced
  // its grade. null when replay has not run.
  replay: Readonly<Record<string, boolean>> | null;
  // The manifest's mode (live, mock-<scenario>); null without a manifest.
  mode?: string | null;
  // The tasks the run must hold, and who says so: the manifest's task_versions, or --task.
  expected?: { tasks: readonly string[]; from: string };
}

export interface TaskSummary {
  task_versions: string[];
  records: number; // settled records
  trials: number; // valid trials: the headline denominator
  passes: number;
  pass_rate: number | null;
  wilson95: Interval | null;
  // The rate with refusals left out of the denominator (reported both ways).
  refusals: number;
  refusal_excluded_rate: number | null;
  outcomes: Record<string, number>;
  env_error_raw: number;
  grader_error: number; // records whose current grade is GRADER_ERROR
  grader_error_history: number; // records that were GRADER_ERROR in an earlier grade
  requeued: number;
  mean_score: number | null;
  mean_cost_usd: number | null;
}

export interface Requirements {
  valid?: number;
  band?: [number, number];
  env_error_raw?: number;
  grader_error?: number;
  model?: string;
  replay?: 'all';
  mode?: string;
  // Set by --allow-mock: a mock run may meet the requirements.
  allow_mock?: boolean;
}

export interface Summary {
  schema_version: number;
  run_id: string;
  tasks: Record<string, TaskSummary>;
  totals: { records: number; trials: number; passes: number; env_error_raw: number; grader_error: number; grader_error_history: number; requeued: number; internal_errors: number; cost_usd: number };
  mode: string | null;
  expected_tasks: { tasks: string[]; from: string } | null;
  models: string[];
  initial_state_hashes: string[];
  replay: { ran: boolean; matched: number; mismatched: string[]; missing: string[] };
  requirements: Requirements;
  violations: string[];
}

// A record's current grade, and the grades before it.
const currentOutcome = (t: SummaryTrial): string => t.regrades?.at(-1)?.outcome ?? t.outcome;
const earlierOutcomes = (t: SummaryTrial): string[] => (t.regrades?.length ? [t.outcome, ...t.regrades.slice(0, -1).map((r) => r.outcome)] : []);
const keyOf = (t: Pick<SummaryTrial, 'task_id' | 'index'>) => `${t.task_id}/${t.index}`;
const mean = (xs: readonly number[]): number | null => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort();

export function summarize(input: SummaryInput): Summary {
  const ids = sorted([...input.trials, ...input.requeued].map((t) => t.task_id).concat(input.expected?.tasks ?? []));
  const tasks: Record<string, TaskSummary> = {};
  for (const id of ids) {
    const mine = input.trials.filter((t) => t.task_id === id);
    const requeued = input.requeued.filter((t) => t.task_id === id);
    const valid = mine.filter((t) => isValid(t.outcome));
    const passes = valid.filter((t) => t.outcome === 'PASS').length;
    const refusals = valid.filter((t) => t.outcome === 'REFUSAL').length;
    const outcomes: Record<string, number> = {};
    for (const t of mine) outcomes[t.outcome] = (outcomes[t.outcome] ?? 0) + 1;
    tasks[id] = {
      task_versions: sorted(mine.flatMap((t) => (t.task_version === null ? [] : [t.task_version]))),
      records: mine.length,
      trials: valid.length,
      passes,
      pass_rate: valid.length === 0 ? null : passes / valid.length,
      wilson95: wilson(passes, valid.length),
      refusals,
      refusal_excluded_rate: valid.length - refusals === 0 ? null : passes / (valid.length - refusals),
      outcomes,
      env_error_raw: [...mine, ...requeued].filter((t) => t.outcome === 'ENV_ERROR').length,
      grader_error: [...mine, ...requeued].filter((t) => currentOutcome(t) === 'GRADER_ERROR').length,
      grader_error_history: [...mine, ...requeued].filter((t) => earlierOutcomes(t).includes('GRADER_ERROR')).length,
      requeued: requeued.length,
      mean_score: mean(valid.flatMap((t) => (t.score === null ? [] : [t.score]))),
      mean_cost_usd: mean(mine.map((t) => t.cost_usd + (t.judge_cost_usd ?? 0))),
    };
  }
  const all = [...input.trials, ...input.requeued];
  const replay = input.replay;
  const keys = input.trials.map(keyOf);
  const s = Object.values(tasks);
  return {
    schema_version: SUMMARY_SCHEMA_VERSION,
    run_id: input.run_id,
    tasks,
    totals: {
      records: input.trials.length,
      trials: s.reduce((a, t) => a + t.trials, 0),
      passes: s.reduce((a, t) => a + t.passes, 0),
      env_error_raw: s.reduce((a, t) => a + t.env_error_raw, 0),
      grader_error: s.reduce((a, t) => a + t.grader_error, 0),
      grader_error_history: s.reduce((a, t) => a + t.grader_error_history, 0),
      requeued: input.requeued.length,
      internal_errors: all.reduce((a, t) => a + (t.tool_errors.INTERNAL ?? 0), 0),
      cost_usd: all.reduce((a, t) => a + t.cost_usd + (t.judge_cost_usd ?? 0), 0),
    },
    mode: input.mode ?? null,
    expected_tasks: input.expected === undefined ? null : { tasks: sorted(input.expected.tasks), from: input.expected.from },
    models: sorted(all.flatMap((t) => [t.model_requested, ...t.models_returned])),
    initial_state_hashes: sorted(input.trials.flatMap((t) => (t.state_hash.initial === null ? [] : [t.state_hash.initial]))),
    replay: {
      ran: replay !== null,
      matched: replay === null ? 0 : keys.filter((k) => replay[k] === true).length,
      mismatched: sorted([
        ...(replay === null ? [] : keys.filter((k) => replay[k] === false)),
        ...input.trials.filter((t) => t.state_hash.final === null || t.state_hash.replay_final !== t.state_hash.final).map(keyOf),
      ]),
      missing: replay === null ? [] : keys.filter((k) => replay[k] === undefined).sort(),
    },
    requirements: {},
    violations: [],
  };
}

const ALIASES: Record<string, string> = { trials: 'valid' };

// --require valid=N,band=a-b,env_error_raw=N,grader_error=N,model=M,replay=all,mode=M. donewhen's
// form is accepted too: trials=N for valid=N, pass-min=a and pass-max=b for band=a-b. Throws on
// anything else.
export function parseRequire(spec: string): Requirements {
  const req: Requirements = {};
  let min: number | undefined;
  let max: number | undefined;
  const count = (k: string, v: string) => {
    if (!/^\d+$/.test(v)) throw new Error(`--require ${k}=${v}: ${k} must be a whole number`);
    return Number(v);
  };
  for (const part of spec.split(',').filter((p) => p !== '')) {
    const eq = part.indexOf('=');
    if (eq < 1) throw new Error(`--require ${part}: expected key=value`);
    const raw = part.slice(0, eq);
    const k = ALIASES[raw] ?? raw;
    const v = part.slice(eq + 1);
    if (k === 'valid') req.valid = count(raw, v);
    else if (k === 'env_error_raw') req.env_error_raw = count(raw, v);
    else if (k === 'grader_error') req.grader_error = count(raw, v);
    else if (k === 'mode') {
      if (v === '') throw new Error('--require mode= needs a mode, e.g. mode=live');
      req.mode = v;
    }
    else if (k === 'pass-min') min = count(raw, v);
    else if (k === 'pass-max') max = count(raw, v);
    else if (k === 'band') {
      const m = /^(\d+)-(\d+)$/.exec(v);
      if (!m || Number(m[1]) > Number(m[2])) throw new Error(`--require band=${v}: expected a-b with a <= b`);
      req.band = [Number(m[1]), Number(m[2])];
    } else if (k === 'model') {
      if (v === '') throw new Error('--require model= needs a model id');
      req.model = v;
    } else if (k === 'replay') {
      if (v !== 'all') throw new Error(`--require replay=${v}: only replay=all is defined`);
      req.replay = 'all';
    } else throw new Error(`--require ${raw}: unknown requirement; known: valid (trials), band (pass-min, pass-max), env_error_raw, grader_error, model, replay, mode`);
  }
  if (min !== undefined || max !== undefined) {
    if (req.band) throw new Error('--require: give band or pass-min/pass-max, not both');
    req.band = [min ?? 0, max ?? Number.MAX_SAFE_INTEGER];
  }
  return req;
}

// One line per violated requirement; empty when the run meets them all.
export function checkRequirements(s: Summary, req: Requirements): string[] {
  const out: string[] = [];
  const tasks = Object.entries(s.tasks);
  if (tasks.length === 0) out.push('no trials in the run');
  const any = Object.keys(req).some((k) => k !== 'allow_mock');
  if (any && s.expected_tasks !== null) {
    for (const id of s.expected_tasks.tasks) if ((s.tasks[id]?.records ?? 0) === 0) out.push(`${id}: expected by ${s.expected_tasks.from}, no records`);
  }
  if (req.mode !== undefined && s.mode !== req.mode) out.push(`mode ${s.mode ?? '(no manifest)'}, required ${req.mode}`);
  else if (any && s.mode !== 'live' && !req.allow_mock) out.push(`mode ${s.mode ?? '(no manifest)'}: not a live run; pass --allow-mock to check a mock run`);
  for (const [id, t] of tasks) {
    if (req.valid !== undefined && t.trials !== req.valid) out.push(`${id}: ${t.trials} valid trials, required ${req.valid}`);
    if (req.band && (t.passes < req.band[0] || t.passes > req.band[1])) out.push(`${id}: ${t.passes}/${t.trials} passes, outside the band ${req.band[0]}-${req.band[1]}`);
  }
  if (req.env_error_raw !== undefined && s.totals.env_error_raw > req.env_error_raw) {
    out.push(`ENV_ERROR raw count ${s.totals.env_error_raw} (re-queued attempts included), required at most ${req.env_error_raw}`);
  }
  if (req.grader_error !== undefined && s.totals.grader_error > req.grader_error) {
    const n = s.totals.grader_error;
    out.push(`GRADER_ERROR in ${n} record${n === 1 ? ' at its' : 's at their'} current grade, required at most ${req.grader_error}`);
  }
  if (req.model !== undefined) {
    const other = s.models.filter((m) => m !== req.model);
    if (other.length > 0) out.push(`model: ${other.join(', ')} in the run, required ${req.model} only`);
  }
  if (req.replay === 'all') {
    if (!s.replay.ran) out.push('replay: replay.json is missing; run pnpm cli replay first');
    if (s.replay.mismatched.length > 0) out.push(`replay: did not reproduce ${s.replay.mismatched.join(', ')}`);
    if (s.replay.missing.length > 0) out.push(`replay: not replayed ${s.replay.missing.join(', ')}`);
  }
  return out;
}

// The schema of summary.json: every error, by path; [] when x is a Summary.
export function validateSummary(x: unknown): string[] {
  const errors: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const rate = (v: unknown) => v === null || (num(v) && (v as number) >= 0 && (v as number) <= 1);
  const strings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === 'string');
  const interval = (v: unknown) => v === null || (isObj(v) && rate(v.lo) && rate(v.hi) && (v.lo as number) <= (v.hi as number));
  const check = (path: string, obj: Record<string, unknown>, fields: Record<string, (v: unknown) => boolean>) => {
    for (const [k, ok] of Object.entries(fields)) {
      if (!Object.hasOwn(obj, k)) errors.push(`${path}${k}: missing`);
      else if (!ok(obj[k])) errors.push(`${path}${k}: bad value ${JSON.stringify(obj[k])}`);
    }
  };
  if (!isObj(x)) return ['summary: not an object'];
  check('', x, {
    schema_version: (v) => v === SUMMARY_SCHEMA_VERSION, run_id: (v) => typeof v === 'string', tasks: isObj, totals: isObj, models: strings,
    initial_state_hashes: strings, replay: isObj, requirements: isObj, violations: strings, mode: (v) => v === null || typeof v === 'string',
    expected_tasks: (v) => v === null || (isObj(v) && strings(v.tasks) && typeof v.from === 'string'),
  });
  if (isObj(x.totals)) {
    check('totals.', x.totals, { records: count, trials: count, passes: count, env_error_raw: count, grader_error: count, grader_error_history: count, requeued: count, internal_errors: count, cost_usd: num });
  }
  if (isObj(x.replay)) check('replay.', x.replay, { ran: (v) => typeof v === 'boolean', matched: count, mismatched: strings, missing: strings });
  if (isObj(x.tasks)) {
    for (const [id, t] of Object.entries(x.tasks)) {
      if (!isObj(t)) {
        errors.push(`tasks.${id}: not an object`);
        continue;
      }
      check(`tasks.${id}.`, t, {
        task_versions: strings, records: count, trials: count, passes: count, pass_rate: rate, wilson95: interval, refusals: count,
        refusal_excluded_rate: rate, env_error_raw: count, grader_error: count, grader_error_history: count, requeued: count, mean_score: (v) => v === null || num(v), mean_cost_usd: (v) => v === null || num(v),
        outcomes: (v) => isObj(v) && Object.entries(v).every(([o, n]) => (OUTCOMES as readonly string[]).includes(o) && count(n)),
      });
      if (count(t.passes) && count(t.trials) && (t.passes as number) > (t.trials as number)) errors.push(`tasks.${id}.passes: more than its trials`);
    }
  }
  return errors;
}

export function assertSummary(x: unknown): asserts x is Summary {
  const errors = validateSummary(x);
  if (errors.length > 0) throw new TypeError(`not a summary: ${errors.join('; ')}`);
}
