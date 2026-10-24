// The grader (design section 5): one trial's outcome, check results, score and attribution,
// from its checks, the initial and final states, its trajectory and its record. Pure apart from
// the judge, whose answers are cached, so a regrade from the record's cache is byte-identical.
//
// Order: the outcome the trial already has (outcome.ts); an invalid trial is not graded (no
// checks run, no judge call). Otherwise every gate check, then every rubric item in declared
// order. PASS when every gate is met (unless the trial ended REFUSAL or LIMIT). Score =
// Σ points of met items (negatives included) ÷ Σ positive points, clipped to [0, 1], over the
// rubric items that are not unknown (HealthBench style); null when no positive item is known.
import type { TrialEvent } from '../core/events.ts';
import type { Resource } from '../env/store.ts';
import { attribute, type Attribution } from './attribution.ts';
import type { Check, GateCheck, GateCtx, Json, Met, Note, RubricCtx, StateView, Step } from './check.ts';
import { diff, keyOf } from './diff.ts';
import { firstExposed, lastWrite, stepsOf } from './exposure.ts';
import { Judge, type JudgeCacheEntry, type JudgeClient } from './judge.ts';
import { isValid, trialOutcome, type Outcome, type TrialFacts } from './outcome.ts';

// Bumped on any change that can change a grade; regrades record both versions.
export const GRADER_VERSION = '1';

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

export interface Grade {
  grader_version: string;
  outcome: Outcome;
  valid: boolean;
  checks: CheckResult[];
  score: number | null;
  judge: { calls: number; unknown: number; cache_keys: string[]; cache: JudgeCacheEntry[] };
  attribution: Attribution | null;
}

export interface GradeInput {
  checks: readonly Check[];
  initial: Iterable<Readonly<Resource>>;
  // null when the trial never reached a final state (ENV_ERROR).
  final: Iterable<Readonly<Resource>> | null;
  events: readonly TrialEvent[];
  trial: TrialFacts;
}

// Free text a gate must not read: attachment bodies (note text), message payload text,
// annotation text and narrative.
function stripText(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => (key === 'note' && v !== null && typeof v === 'object' ? stripText(omit(v, 'text')) : stripText(v)));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  const attachment = Object.hasOwn(value, 'contentType');
  for (const [k, v] of Object.entries(value)) {
    if ((attachment && k === 'data') || k === 'contentString' || k === 'div') continue;
    out[k] = stripText(v, k);
  }
  return out;
}
const omit = (o: object, k: string) => Object.fromEntries(Object.entries(o).filter(([key]) => key !== k));

function view(resources: readonly Readonly<Resource>[]): StateView {
  const byKey = new Map(resources.map((r) => [keyOf(r), r]));
  return {
    get: (type, id) => byKey.get(`${type}/${id}`),
    all: (type) => (type === undefined ? resources : resources.filter((r) => r.resourceType === type)),
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

// The grade of a trial that is not graded: an invalid outcome, no checks, no score.
export const ungraded = (outcome: Outcome): Grade => ({
  grader_version: GRADER_VERSION, outcome, valid: false, checks: [], score: null, judge: { calls: 0, unknown: 0, cache_keys: [], cache: [] }, attribution: null,
});

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

// Grades with `judge`, whose cost and cache entries the caller can read afterwards.
export async function gradeWith(input: GradeInput, judge: Judge): Promise<Grade> {
  const early = trialOutcome(input.trial);
  if ((early !== null && !isValid(early)) || input.final === null) return ungraded(early ?? 'ENV_ERROR');
  const initial = [...input.initial];
  const final = [...input.final];
  const steps = stepsOf(input.events);
  const d = diff(initial, final);
  const writes = [...new Set(steps.flatMap((s) => s.written_ids))];
  const common = { diff: d, steps, exposedAt: (id: string) => firstExposed(steps, id), writes: () => writes };
  const gateCtx: GateCtx = { initial: view(initial.map((r) => stripText(r) as Resource)), final: view(final.map((r) => stripText(r) as Resource)), ...common };
  const full = view(final);
  const rubricCtx: RubricCtx = {
    initial: view(initial), final: full, ...common,
    notes: notesOf(full, d.created, steps),
    final_text: input.trial.summary,
    judge: (q) => judge.judge(q),
    extract: (q) => judge.extract(q),
  };

  const results: CheckResult[] = [];
  const gates = input.checks.filter((c): c is GateCheck => c.kind === 'gate');
  for (const c of input.checks) {
    const v = c.kind === 'gate' ? c.fn(gateCtx) : await c.fn(rubricCtx);
    results.push({ id: c.id, kind: c.kind, method: c.method, category: c.category, points: c.kind === 'rubric' ? c.points : null, met: v.met, evidence: v.evidence, ...(v.ids ? { ids: [...v.ids] } : {}) });
  }
  const passed = results.every((r) => r.kind !== 'gate' || r.met === true);
  const outcome: Outcome = early ?? (passed ? 'PASS' : 'FAIL');
  const cache = judge.entries();
  return {
    grader_version: GRADER_VERSION,
    outcome,
    valid: true,
    checks: results,
    score: score(results),
    judge: { calls: judge.asked, unknown: results.filter((r) => r.method !== 'code' && r.met === 'unknown').length, cache_keys: cache.map((e) => e.key), cache },
    attribution: attribute(outcome, gates, results, steps),
  };
}

export interface GradeOptions {
  // The client judge and extractor calls go through: the trial's own MessagesClient.
  judge?: JudgeClient | null;
  // A record's judge.cache: with no judge, a regrade answers only from it.
  cache?: readonly JudgeCacheEntry[];
}

export const grade = (input: GradeInput, opts: GradeOptions = {}): Promise<Grade> =>
  gradeWith(input, new Judge({ client: opts.judge ?? null, ...(opts.cache ? { cache: opts.cache } : {}) }));
