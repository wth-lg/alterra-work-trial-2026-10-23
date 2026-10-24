// The grader (design section 5): one trial's outcome, check results, score and attribution,
// from its checks, the initial and final states, its trajectory and its record. Pure apart from
// the judge, whose answers are cached, so a regrade from the record's cache is byte-identical.
//
// Order: the outcome the trial already has (outcome.ts); an invalid trial is not graded (no
// checks run, no judge call). Otherwise every gate check, then every rubric item, each group in
// declared order (results keep the declared order). PASS when every gate is met (unless the
// trial ended REFUSAL or LIMIT). Score = Σ points of met items (negatives included) ÷ Σ positive
// points, clipped to [0, 1], over the rubric items that are not unknown (HealthBench style);
// null when no positive item is known.
//
// Grading never throws on the trial's account. A check that throws is the grader's fault: the
// trial is GRADER_ERROR, invalid, fault grader, with the check and the message in `error`. A
// judge call the client failed ends the trial as classifyFailure says, as a model call would
// (INFRA_API for a 401, 403, 404, billing error or retries exhausted), invalid, with stops_batch
// as the client says. A
// trial whose facts say it reached a final state that is not here is GRADER_ERROR too. Only a
// judge cache miss on a regrade throws (JudgeCacheMiss): a regrade never calls the judge.
import type { TrialEvent } from '../core/events.ts';
import type { Resource } from '../env/store.ts';
import { attribute, type Attribution } from './attribution.ts';
import type { Check, GateCheck, GateCtx, GateStateView, Json, Met, Note, RubricCheck, RubricCtx, StateView, Step } from './check.ts';
import { diff, keyOf } from './diff.ts';
import { firstExposed, lastWrite, stepsOf } from './exposure.ts';
import { gateResource, type GateResource } from './gate-view.ts';
import { Judge, JudgeCacheMiss, JudgeClientError, judgeCallBudget, type JudgeCacheEntry, type JudgeClient } from './judge.ts';
import { FAULT, isValid, trialOutcome, type Fault, type Outcome, type TrialFacts } from './outcome.ts';

// Bumped on any change that can change a grade; regrades record both versions.
export const GRADER_VERSION = '3';

export interface CheckResult {
  id: string;
  kind: Check['kind'];
  method: Check['method'];
  category: Check['category'];
  // null for a gate.
  points: number | null;
  met: Met;
  evidence: { [k: string]: Json };
  ids?: string[];
}

// Why a trial could not be graded: the check that threw or whose judge call failed (null when
// no check was running), the error, and whether the batch stops.
export interface GradeError {
  check: string | null;
  message: string;
  stops_batch: boolean;
}

export interface Grade {
  grader_version: string;
  outcome: Outcome;
  valid: boolean;
  fault: Fault | null;
  checks: CheckResult[];
  score: number | null;
  judge: { calls: number; unknown: number; over_allowance: number; cache_keys: string[]; cache: JudgeCacheEntry[] };
  attribution: Attribution | null;
  error: GradeError | null;
}

export interface GradeInput {
  checks: readonly Check[];
  initial: Iterable<Readonly<Resource>>;
  // null when the trial never reached a final state (ENV_ERROR).
  final: Iterable<Readonly<Resource>> | null;
  events: readonly TrialEvent[];
  trial: TrialFacts;
}

const statusOf = (r: object | undefined): string | null => {
  const s = (r as { status?: unknown } | undefined)?.status;
  return typeof s === 'string' ? s : null;
};

function view(resources: readonly Readonly<Resource>[]): StateView {
  const byKey = new Map(resources.map((r) => [keyOf(r), r]));
  return {
    get: (type, id) => byKey.get(`${type}/${id}`),
    all: (type) => (type === undefined ? resources : resources.filter((r) => r.resourceType === type)),
    has: (type, id) => byKey.has(`${type}/${id}`),
    status: (type, id) => statusOf(byKey.get(`${type}/${id}`)),
  };
}

// The gate view of a state, projected on first use.
function gateView(resources: readonly Readonly<Resource>[]): GateStateView {
  let projected: { list: GateResource[]; byKey: Map<string, GateResource> } | undefined;
  const p = () => {
    if (projected === undefined) {
      const list = resources.map(gateResource);
      projected = { list, byKey: new Map(list.map((r) => [`${r.resourceType}/${r.id}`, r])) };
    }
    return projected;
  };
  return {
    get: ((type: string, id: string) => p().byKey.get(`${type}/${id}`)) as GateStateView['get'],
    all: ((type?: string) => (type === undefined ? p().list : p().list.filter((r) => r.resourceType === type))) as GateStateView['all'],
    has: (type, id) => p().byKey.has(`${type}/${id}`),
    status: (type, id) => statusOf(p().byKey.get(`${type}/${id}`)),
  };
}

function decode(data: string): string {
  const binary = atob(data);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

// The parts of a DocumentReference a note is read from.
interface DocumentReference {
  description?: string;
  subject?: { reference?: string };
  content?: Array<{ attachment?: { data?: string; title?: string } }>;
  context?: { related?: Array<{ reference?: string }> };
}

// The notes the trial created, with their text.
function notesOf(final: StateView, created: readonly string[], steps: readonly Step[]): Note[] {
  return created.flatMap((k) => {
    if (!k.startsWith('DocumentReference/')) return [];
    const doc = final.get('DocumentReference', k.slice('DocumentReference/'.length)) as Readonly<DocumentReference>;
    const attachment = doc.content?.[0]?.attachment;
    return [{
      id: k,
      patient: doc.subject?.reference ?? null,
      title: doc.description ?? attachment?.title ?? '',
      text: attachment?.data === undefined ? '' : decode(attachment.data),
      cites: (doc.context?.related ?? []).flatMap((r) => (r.reference === undefined ? [] : [r.reference])),
      step: lastWrite(steps, [k]),
    }];
  });
}

const noJudge = (): Grade['judge'] => ({ calls: 0, unknown: 0, over_allowance: 0, cache_keys: [], cache: [] });

// The grade of a trial that is not graded: an invalid outcome, no checks, no score.
export const ungraded = (outcome: Outcome, error: GradeError | null = null): Grade => {
  if (isValid(outcome)) throw new TypeError(`ungraded: ${outcome} is a valid outcome, and a valid trial is graded`);
  return { grader_version: GRADER_VERSION, outcome, valid: false, fault: FAULT[outcome], checks: [], score: null, judge: noJudge(), attribution: null, error };
};

const errorText = (e: unknown): string => (e instanceof Error ? `${e.name}: ${e.message}` : String(e));

export function score(results: readonly CheckResult[]): number | null {
  let met = 0;
  let positive = 0;
  for (const r of results) {
    if (r.kind !== 'rubric' || r.met === 'unknown') continue;
    if (r.points! > 0) positive += r.points!;
    if (r.met) met += r.points!;
  }
  return positive === 0 ? null : Math.min(1, Math.max(0, met / positive));
}

function judgeOf(judge: Judge, results: readonly CheckResult[]): Grade['judge'] {
  const cache = judge.entries();
  return { calls: judge.calls, unknown: results.filter((r) => r.method !== 'code' && r.met === 'unknown').length, over_allowance: judge.overAllowance, cache_keys: cache.map((e) => e.key), cache };
}

// Grades with `judge`, whose cost and cache entries the caller can read afterwards.
export async function gradeWith(input: GradeInput, judge: Judge): Promise<Grade> {
  const early = trialOutcome(input.trial);
  if (early !== null && !isValid(early)) return ungraded(early);
  if (input.final === null) {
    return ungraded('GRADER_ERROR', { check: null, message: `the record says the trial reached a final state (status ${input.trial.status}), and the grader has none`, stops_batch: false });
  }
  const initial = [...input.initial];
  const final = [...input.final];
  const steps = stepsOf(input.events);
  const d = diff(initial, final);
  const writes = [...new Set(steps.flatMap((s) => s.written_ids))];
  const common = { diff: d, steps, exposedAt: (id: string) => firstExposed(steps, id), writes: () => writes };
  const gateCtx: GateCtx = { initial: gateView(initial), final: gateView(final), ...common };
  const full = view(final);
  const rubricCtx: RubricCtx = {
    initial: view(initial), final: full, ...common,
    notes: notesOf(full, d.created, steps),
    final_text: input.trial.summary,
    judge: (q) => judge.judge(q),
    extract: (q) => judge.extract(q),
  };

  // Gates first, then rubric items; results keep the declared order.
  const gates = input.checks.filter((c): c is GateCheck => c.kind === 'gate');
  const rubrics = input.checks.filter((c): c is RubricCheck => c.kind === 'rubric');
  const byCheck = new Map<Check, CheckResult>();
  const result = (c: Check, v: { met: Met; evidence: { [k: string]: Json }; ids?: readonly string[] }): CheckResult => ({
    id: c.id, kind: c.kind, method: c.method, category: c.category, points: c.kind === 'rubric' ? c.points : null, met: v.met, evidence: v.evidence, ...(v.ids ? { ids: [...v.ids] } : {}),
  });
  const ordered = () => input.checks.flatMap((c) => byCheck.get(c) ?? []);
  for (const c of [...gates, ...rubrics]) {
    try {
      byCheck.set(c, result(c, c.kind === 'gate' ? c.fn(gateCtx) : await c.fn(rubricCtx)));
    } catch (e) {
      if (e instanceof JudgeCacheMiss) throw e;
      const infra = e instanceof JudgeClientError;
      const message = infra ? e.message : errorText(e);
      byCheck.set(c, result(c, { met: 'unknown', evidence: { [infra ? 'judge_error' : 'grader_error']: message } }));
      const outcome: Outcome = infra ? e.failure.status : 'GRADER_ERROR';
      const checks = ordered();
      return {
        grader_version: GRADER_VERSION, outcome, valid: false, fault: FAULT[outcome], checks, score: null, judge: judgeOf(judge, checks), attribution: null,
        error: { check: c.id, message, stops_batch: infra && e.failure.stopsBatch },
      };
    }
  }
  const results = ordered();
  const passed = results.every((r) => r.kind !== 'gate' || r.met === true);
  const outcome: Outcome = early ?? (passed ? 'PASS' : 'FAIL');
  return {
    grader_version: GRADER_VERSION,
    outcome,
    valid: isValid(outcome),
    fault: FAULT[outcome],
    checks: results,
    score: score(results),
    judge: judgeOf(judge, results),
    attribution: attribute(outcome, gates, results, steps),
    error: null,
  };
}

export interface GradeOptions {
  // The client judge and extractor calls go through: the trial's own MessagesClient.
  judge?: JudgeClient | null;
  // A record's judge.cache: with no judge, a regrade answers only from it.
  cache?: readonly JudgeCacheEntry[];
}

// The judge a grading of `checks` uses: its calls bounded by the checks' allowance.
export const judgeFor = (checks: readonly Check[], opts: GradeOptions = {}): Judge =>
  new Judge({ client: opts.judge ?? null, maxCalls: judgeCallBudget(checks), ...(opts.cache ? { cache: opts.cache } : {}) });

export const grade = (input: GradeInput, opts: GradeOptions = {}): Promise<Grade> => gradeWith(input, judgeFor(input.checks, opts));
