// Cost model: prices, the worst case a call reserves, and batch projections. Pure: run
// directories are read by cli/adapters/ledger-node.ts and passed in as observations.
import { isValid } from './outcomes.ts';

// USD per million tokens for claude-opus-5-5. Source: the bundled claude-api skill (model
// table cached 2026-10-06, and shared/prompt-caching.md: 5-minute writes 1.25x input, 1-hour
// writes 2x, reads $0.20). The P2 client sends only 5-minute cache_control; a 1-hour write
// is priced in case usage reports one.
export const PRICE_USD_PER_MTOK = {
  input: 4,
  cache_write_5m: 5,
  cache_write_1h: 8,
  cache_read: 0.2,
  output: 20,
} as const;
// Fast mode (usage.speed "fast") is $8 in / $40 out on claude-opus-5-5, 2x every standard
// price (same source, Fast Mode section).
export const FAST_MODE_MULTIPLIER = 2;
// Input tokens the API adds to a request beyond its body: the tool-use system prompt and the
// message template. Those are a few hundred tokens; 4,096 leaves wide margin. Server tools,
// whose results add input, are not used by the P2 client.
export const INPUT_OVERHEAD_TOKENS = 4096;

// Per-trial cap: the cost a trial is projected at when no run has observed its task.
export const PER_TRIAL_CAP_USD = 6;
// Batch projections assume 15% of trials rerun (INFRA and ENV trials are re-queued).
export const RERUN_FACTOR = 1.15;
// Added once to every batch projection for LLM-judge calls. The design budgets ~1,200
// judge, extractor and auditor calls at $15 for the whole project; a judge call is short.
export const JUDGE_ALLOWANCE_USD = 1;
// Added to the final-run reserve until results/runs/final-1/auditor/ holds outputs: one
// blinded auditor pass over ~40 audited trajectories of the final run.
export const AUDITOR_ALLOWANCE_USD = 10;
// The final run (user decision, 2026-10-24): FINAL_TRIALS_PER_TASK trials of each planned
// task, and the pass band a task's final pass rate is calibrated into, inclusive. Every
// final-run count in the code reads these.
export const PLANNED_TASKS = 6;
export const FINAL_TRIALS_PER_TASK = 20;
export const FINAL_PASS_BAND = [0.2, 0.7] as const;

// The usage block of a Messages response.
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation?: { ephemeral_5m_input_tokens?: number | null; ephemeral_1h_input_tokens?: number | null } | null;
  speed?: string | null;
}

const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const optionalCount = (v: unknown): number | null => (v === undefined || v === null ? 0 : isCount(v) ? v : null);

// The cost of a call from its usage block, or null when the usage cannot be priced (a token
// field missing, negative or not a number, or an unknown speed). The ledger settles such a
// call at its worst case.
export function usageCostUsd(u: Usage): number | null {
  if (typeof u !== 'object' || u === null || !isCount(u.input_tokens) || !isCount(u.output_tokens)) return null;
  const cc: unknown = u.cache_creation ?? {};
  if (typeof cc !== 'object' || cc === null) return null;
  const { ephemeral_5m_input_tokens: e5m, ephemeral_1h_input_tokens: e1h } = cc as NonNullable<Usage['cache_creation']>;
  const creation = optionalCount(u.cache_creation_input_tokens);
  const read = optionalCount(u.cache_read_input_tokens);
  const write5m = optionalCount(e5m);
  const write1h = optionalCount(e1h);
  if (creation === null || read === null || write5m === null || write1h === null) return null;
  const speed = u.speed ?? 'standard';
  if (speed !== 'standard' && speed !== 'fast') return null;
  const p = PRICE_USD_PER_MTOK;
  const writeAll = Math.max(creation, write5m + write1h);
  const usd =
    (u.input_tokens * p.input + (writeAll - write1h) * p.cache_write_5m + write1h * p.cache_write_1h + read * p.cache_read + u.output_tokens * p.output) / 1e6;
  return speed === 'fast' ? usd * FAST_MODE_MULTIPLIER : usd;
}

function assertTokenCount(name: string, v: unknown): void {
  if (!Number.isSafeInteger(v) || (v as number) < 0) throw new TypeError(`${name} must be a whole number >= 0, got ${String(v)}`);
}

// An upper bound on a call's cost before it is sent. Input: every request body byte counted
// as one token (a token covers at least one byte of text), plus INPUT_OVERHEAD_TOKENS, all at
// the 1-hour cache-write price, the highest input rate a call can incur. Output: max_tokens,
// which also caps thinking tokens. Fast mode doubles it. Throws on a bodyBytes or maxTokens
// that is not a whole number >= 0, so no NaN or negative reservation reaches the cap check.
export function worstCaseUsd(req: { bodyBytes: number; maxTokens: number; fast?: boolean }): number {
  assertTokenCount('bodyBytes', req.bodyBytes);
  assertTokenCount('maxTokens', req.maxTokens);
  const p = PRICE_USD_PER_MTOK;
  const usd = ((req.bodyBytes + INPUT_OVERHEAD_TOKENS) * p.cache_write_1h + req.maxTokens * p.output) / 1e6;
  return req.fast === true ? usd * FAST_MODE_MULTIPLIER : usd;
}

// One trial record from a --cost-from run. run_order is the run's position in the
// --cost-from list: a later run is newer. cost_usd is the trial's loop cost plus its judge cost.
export interface TrialObservation {
  run: string;
  run_order: number;
  task_id: string;
  task_version: string;
  cost_usd: number;
  started?: string;
  outcome?: string;
}

export type PerTrialCost =
  | { usd: number; basis: 'cap' }
  | { usd: number; basis: 'p90' | 'earlier-version-p90'; run: string; task_version: string; n: number };

// Nearest-rank 90th percentile.
export function p90(values: readonly number[]): number {
  if (values.length === 0) throw new Error('p90 of no values');
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(0.9 * sorted.length) - 1] as number;
}

function newer(a: TrialObservation, b: TrialObservation): boolean {
  return a.run_order !== b.run_order ? a.run_order > b.run_order : (a.started ?? '') > (b.started ?? '');
}

// p90 over one version's trials in the latest run that holds that version.
function latestP90(group: TrialObservation[], basis: 'p90' | 'earlier-version-p90'): PerTrialCost {
  const order = Math.max(...group.map((o) => o.run_order));
  const run = group.filter((o) => o.run_order === order);
  const first = run[0] as TrialObservation;
  return { usd: p90(run.map((o) => o.cost_usd)), basis, run: first.run, task_version: first.task_version, n: run.length };
}

// The per-trial cost of a task: the latest p90 for task_version, else the p90 of the same
// task's latest other (earlier) version, else the cap. A null task_version takes the
// task's latest observed version.
export function perTrialCost(task_id: string, task_version: string | null, observations: readonly TrialObservation[]): PerTrialCost {
  const mine = observations.filter((o) => o.task_id === task_id && isCount(o.cost_usd));
  const exact = mine.filter((o) => o.task_version === task_version);
  if (exact.length > 0) return latestP90(exact, 'p90');
  if (mine.length === 0) return { usd: PER_TRIAL_CAP_USD, basis: 'cap' };
  const latest = mine.reduce((a, b) => (newer(b, a) ? b : a));
  return latestP90(
    mine.filter((o) => o.task_version === latest.task_version),
    task_version === null ? 'p90' : 'earlier-version-p90',
  );
}

export interface ProjectionLine {
  // null for the line that stands for planned tasks not written yet.
  task_id: string | null;
  tasks: number;
  trials: number; // per task
  per_trial: PerTrialCost;
  usd: number; // tasks x trials x per_trial x RERUN_FACTOR
}

export interface Projection {
  lines: ProjectionLine[];
  allowance: { name: 'judge' | 'auditor'; usd: number };
  total: number;
}

function line(task_id: string | null, tasks: number, trials: number, per_trial: PerTrialCost): ProjectionLine {
  return { task_id, tasks, trials, per_trial, usd: tasks * trials * per_trial.usd * RERUN_FACTOR };
}

function sum(lines: ProjectionLine[], allowance: Projection['allowance']): Projection {
  return { lines, allowance, total: lines.reduce((s, l) => s + l.usd, 0) + allowance.usd };
}

// What a batch of trials will cost: trials x per-trial cost x 1.15 per task, plus the
// judge allowance. Every live entrypoint's --dry-run prints this.
export function projectBatch(
  tasks: ReadonlyArray<{ task_id: string; task_version: string; trials: number }>,
  observations: readonly TrialObservation[],
): Projection {
  return sum(
    tasks.map((t) => line(t.task_id, 1, t.trials, perTrialCost(t.task_id, t.task_version, observations))),
    { name: 'judge', usd: JUDGE_ALLOWANCE_USD },
  );
}

// Whether a final trial counts toward its task's FINAL_TRIALS_PER_TASK valid trials:
// outcomes.ts decides.
export const isValidTrial = (outcome: string | undefined): boolean => isValid(outcome);

// What the rest of the final run will cost: per planned task, (FINAL_TRIALS_PER_TASK - valid
// final trials) x its per-trial cost x RERUN_FACTOR; planned tasks not written yet (up to
// PLANNED_TASKS) at the cap; plus the auditor allowance until the auditor has run. A final
// trial's valid flag, when given, is its current grade's (summary.ts currentGrade) and wins
// over its recorded outcome. Observed task ids outside the plan are ignored, so a stray id
// cannot stand in for a planned task. Ids starting with '_' are not real tasks.
export function finalReserve(input: {
  plannedTasks: readonly string[];
  observations: readonly TrialObservation[];
  finalTrials: ReadonlyArray<{ task_id: string; outcome?: string; valid?: boolean }>;
  auditorDone: boolean;
}): Projection {
  const ids = [...new Set(input.plannedTasks)].filter((id) => !id.startsWith('_')).sort();
  const lines = ids.map((id) => {
    const valid = input.finalTrials.filter((t) => t.task_id === id && (t.valid ?? isValidTrial(t.outcome))).length;
    return line(id, 1, Math.max(0, FINAL_TRIALS_PER_TASK - valid), perTrialCost(id, null, input.observations));
  });
  const missing = Math.max(0, PLANNED_TASKS - ids.length);
  if (missing > 0) lines.push(line(null, missing, FINAL_TRIALS_PER_TASK, { usd: PER_TRIAL_CAP_USD, basis: 'cap' }));
  return sum(lines, { name: 'auditor', usd: input.auditorDone ? 0 : AUDITOR_ALLOWANCE_USD });
}

export function money(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

function basisText(c: PerTrialCost): string {
  if (c.basis === 'cap') return 'cap: no cost data';
  const what = `p90 of ${c.n} trials of ${c.task_version} in ${c.run}`;
  return c.basis === 'p90' ? what : `earlier version: ${what}`;
}

// One line per task, the allowance and the total, as dry runs print them.
export function formatProjection(p: Projection, totalLabel = 'total'): string[] {
  return [
    ...p.lines.map((l) => {
      const each = `${money(l.per_trial.usd)} per trial (${basisText(l.per_trial)})`;
      const head = l.task_id === null ? `${l.tasks} tasks without data x ${l.trials} trials x` : `${l.task_id}: ${l.trials} trials x`;
      return `${head} ${each} x ${RERUN_FACTOR} reruns = ${money(l.usd)}`;
    }),
    `${p.allowance.name} allowance ${money(p.allowance.usd)}`,
    `${totalLabel} ${money(p.total)}`,
  ];
}
