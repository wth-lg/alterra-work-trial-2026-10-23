// Why one trial ended as it did (plan phase P14a): its outcome, fault, audit label, decisive check,
// reason and the M1-M5 criteria, from its record at the current grade (summary.ts currentGrade:
// the last regrade, else the recorded grade), its audit row when it has one, and what the caller
// can say about the world. The UI's "why this failed", cli/audit-check.ts, the auditor prompt and
// the writeup all call explainTrial, so none of them can disagree with the audit. The definitions
// it evaluates are outcomes.ts's. Pure: no Node, DOM or file access.
//
// The fault is decided in this order: an INFRA outcome is infra; a grader criterion that holds
// (a check threw, a regrade disagrees, an audit GRADER_BUG with evidence) makes it grader; an
// environment criterion that holds (an INTERNAL tool error, an initial hash that is not the
// manifest, an invariant, a replay mismatch) makes it env; otherwise the FAULT map's fault of
// the current outcome. The label is AUDIT_LABEL of the fault.
//
// The reason is one sentence of at most REASON_WORDS words, in the forms
// docs/requirements/ui-contract.md fixes for a valid non-pass trial:
//   <check id> failed: expected <value>, found <value>   the first failed gate check, then the
//                                                          taxonomy or the fault when they fit
//   turn limit reached: <n> turns (and the cost, time and output limit forms)
//   refused: <the first REFUSAL_WORDS words of the refusal>
// Expected and found come from the check's evidence: its expected and found fields when it has
// them, else a range and the value checked against it, else a list that should be empty.
import type { TrialEvent } from './events.ts';
import { PER_TRIAL_CAP_USD } from './cost.ts';
import { AUDIT_LABEL, AUDIT_LABELS, FAULT, FAULT_DEFINITIONS, type AttributionFacts, type AuditLabelName, type CriterionMet, type Fault, type Outcome } from './outcomes.ts';
import { currentGrade, type RegradeGrade } from './summary.ts';
import { TAXONOMY, type Taxonomy } from '../grader/attribution.ts';

export const REASON_WORDS = 25;
export const REFUSAL_WORDS = 12;
// The marker every surface shows next to the fault of a trial with no audit row.
export const NOT_AUDITED_MARKER = 'not human-audited';

export interface ExplainCheck {
  id: string;
  kind?: string;
  met: unknown;
  evidence?: { [k: string]: unknown };
}

// What explainTrial reads of a trial record (a BatchRecord or a run()'s TrialRecord).
export interface ExplainRecord {
  task_id?: string;
  task_version: string | null;
  outcome: string;
  valid?: boolean;
  score?: number | null;
  status?: string | null;
  detail?: string | null;
  turns?: number;
  cost_usd?: number;
  started?: string;
  ended?: string;
  summary?: string | null;
  refusal_category?: string | null;
  tool_errors?: Readonly<Record<string, number>>;
  state_hash: { initial: string | null; final: string | null; replay_final: string | null };
  checks?: ReadonlyArray<ExplainCheck> | null;
  attribution?: { auto: string; first_failed: string | null; decisive_step: number | null; exposure: ReadonlyArray<{ id: string; first_exposed_step: number | null }> } | null;
  error?: { check: string | null; message: string; stops_batch?: boolean } | null;
  regrades?: ReadonlyArray<RegradeGrade>;
}

// One line of <run>/audit.jsonl (design section 5, "Human audit"). label and label_subtype are
// optional: without them a taxonomy in TAXONOMY reads as model, and environment or grader as
// itself. criteria is what audit-check writes back: explainTrial's criteria for the trial.
export interface AuditRow {
  trial: string;
  outcome: string;
  taxonomy: string | null;
  model_fault: 'yes' | 'no' | 'unclear' | null;
  decisive_step: number | null;
  evidence_ids: string[];
  llm_auditor_agrees: boolean | null;
  label?: string | null;
  label_subtype?: string | null;
  adjudication?: string;
  note?: string;
  criteria?: CriterionRow[];
}

// What the caller knows beyond the record. Each criterion that needs a missing part is pending.
export interface ExplainContext {
  // The trial's trajectory: the limit and refusal sentences read it.
  events?: readonly TrialEvent[];
  // The manifest's initial state hash (fixtures/manifest.json world.state_hash, or the run
  // manifest's world_hash).
  world_state_hash?: string | null;
  // Whether a resource is in the world, so the tool would have returned it had the model asked.
  exposable?: (id: string) => boolean;
  // The grader validation matrix of the task (pnpm cli matrix).
  matrix?: { task_version: string; oracle_pass: boolean; alternatives_pass: boolean } | null;
  // The task's gate checks, for traces_to.
  checks?: ReadonlyArray<{ id: string; traces_to: string }>;
}

export interface CriterionRow {
  id: string;
  met: CriterionMet;
  evidence: string;
}

export interface Explanation {
  outcome: string;
  valid: boolean;
  fault: Fault | null;
  label: AuditLabelName | null;
  label_subtype: 'refusal' | null;
  audited: boolean;
  decisive_check: { id: string; traces_to: string | null; expected: string; found: string } | null;
  decisive_step: number | null;
  taxonomy: Taxonomy | null;
  reason: string;
  criteria: CriterionRow[];
}

export const formatCriterion = (c: Pick<CriterionRow, 'id' | 'met'>): string => `${c.id}: ${c.met === true ? 'met' : c.met === false ? 'not met' : 'pending'}`;

// The audit label a row gives: its label, else the one its taxonomy implies.
export function auditLabelOf(row: Pick<AuditRow, 'label' | 'taxonomy' | 'outcome'>): string | null {
  if (row.label !== undefined && row.label !== null) return row.label;
  if ((AUDIT_LABELS as readonly (string | null)[]).includes(row.taxonomy)) return row.taxonomy;
  if ((TAXONOMY as readonly (string | null)[]).includes(row.taxonomy) || row.outcome === 'REFUSAL') return 'model';
  return null;
}

const words = (s: string) => s.trim().split(/\s+/).filter((w) => w !== '');
const firstWords = (s: string, n: number) => {
  const w = words(s);
  return w.length <= n ? w.join(' ') : `${w.slice(0, n).join(' ')}…`;
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function show(v: unknown): string {
  if (v === null || v === undefined) return 'none';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.length === 0 ? 'none' : v.map(show).join(', ');
  if (isObj(v) && typeof v.min === 'number' && typeof v.max === 'number') return v.min === v.max ? String(v.min) : `${v.min}-${v.max}`;
  return JSON.stringify(v);
}

// Evidence lists a passing check leaves empty (the writes beyond what is allowed, the writes
// before their inputs were read, the uncited inputs).
const SHOULD_BE_EMPTY = ['extra', 'late', 'uncited', 'written_before_read'];
// The value a range check compared, in the order graders name it.
const RANGE_VALUE = ['found', 'value', 'mg_per_day', 'mg', 'per_day'];

export function expectedFound(evidence: { [k: string]: unknown } | undefined): { expected: string; found: string } {
  const ev = evidence ?? {};
  if ('expected' in ev || 'found' in ev) return { expected: show(ev.expected), found: show(ev.found) };
  if (isObj(ev.range)) return { expected: show(ev.range), found: show(ev[RANGE_VALUE.find((k) => k in ev) ?? 'found']) };
  const empty = SHOULD_BE_EMPTY.find((k) => Array.isArray(ev[k]));
  if (empty !== undefined) return { expected: 'none', found: show(ev[empty]) };
  const rest = Object.entries(ev).filter(([k]) => k !== 'active');
  return { expected: 'the check met', found: rest.length === 0 ? 'not met' : rest.map(([k, v]) => `${k} ${show(v)}`).join(', ') };
}

// "<id> failed: expected <e>, found <f>", the values cut so that it fits in `max` words.
function checkSentence(id: string, expected: string, found: string, max: number): string {
  const full = `${id} failed: expected ${expected}, found ${found}`;
  if (words(full).length <= max) return full;
  const each = Math.floor((max - 4) / 2);
  return `${id} failed: expected ${firstWords(expected, each)}, found ${firstWords(found, each)}`;
}

const TAXONOMY_CLAUSE: Record<Taxonomy, (f: AttributionFacts) => string> = {
  reasoning: ({ decisive }) => {
    const seen = (decisive?.exposure ?? []).filter((e) => e.first_exposed_step !== null);
    if (seen.length === 1) return `${seen[0]!.id} was read at step ${seen[0]!.first_exposed_step}, so this is reasoning`;
    if (seen.length > 1) return `every decisive id was read by step ${Math.max(...seen.map((e) => e.first_exposed_step as number))}, so this is reasoning`;
    return 'the evidence was in view, so this is reasoning';
  },
  retrieval: ({ decisive }) => {
    const unseen = (decisive?.exposure ?? []).find((e) => e.first_exposed_step === null);
    return `${unseen?.id ?? 'a decisive id'} was never read, so this is retrieval`;
  },
  output_gap: () => 'stated but not done, so this is output gap',
  over_action: () => 'writes beyond what is allowed, so this is over action',
  process: () => 'inputs not consulted first, so this is process',
  did_not_finish: () => 'stopped at a limit, so this is did not finish',
};

function limitSentence(r: ExplainRecord, events: readonly TrialEvent[] | undefined): string {
  const e = events?.findLast((x) => x.type === 'limit');
  const limit = e?.type === 'limit' ? e : null;
  const kind = limit?.limit ?? r.detail;
  if (kind === 'cost') return `cost limit reached: $${(limit?.value ?? r.cost_usd ?? 0).toFixed(2)} of $${(limit?.cap ?? PER_TRIAL_CAP_USD).toFixed(2)}`;
  if (kind === 'wall_clock') {
    const elapsed = limit?.value ?? (r.started && r.ended ? Date.parse(r.ended) - Date.parse(r.started) : NaN);
    return `time limit reached: ${Number.isFinite(elapsed) ? Math.floor(elapsed / 1000) : '?'} s of ${limit ? Math.round(limit.cap / 1000) : '?'} s`;
  }
  if (kind === 'max_tokens') return `output limit reached: ${limit ? limit.value + limit.cap : 2} cut-off responses in a row`;
  return `turn limit reached: ${limit?.value ?? r.turns ?? '?'} turns`;
}

function refusalText(r: ExplainRecord, events: readonly TrialEvent[] | undefined): string | null {
  const e = events?.findLast((x) => x.type === 'response' && x.stop_reason === 'refusal');
  if (e?.type === 'response') {
    const explanation = e.stop_details?.explanation;
    if (typeof explanation === 'string' && explanation.trim() !== '') return explanation;
    const text = e.content.flatMap((b) => {
      const t = (b as unknown as { text?: unknown }).text;
      return b.type === 'text' && typeof t === 'string' ? [t] : [];
    }).join(' ');
    if (text.trim() !== '') return text;
  }
  return r.summary?.trim() ? r.summary : null;
}

const capWords = (s: string, max = REASON_WORDS) => firstWords(s, max);

export function explainTrial(record: ExplainRecord, audit?: AuditRow | null, ctx: ExplainContext = {}): Explanation {
  const grade = currentGrade(record);
  const outcome = grade.outcome;
  const checks = (grade.checks ?? []) as ReadonlyArray<ExplainCheck>;
  const failed = checks.find((c) => c.kind === 'gate' && c.met === false) ?? null;
  const att = record.attribution ?? null;
  // The recorded attribution speaks for the current grade only when it names the same check.
  const attFits = att !== null && att.first_failed === (failed?.id ?? null);
  const row = audit ?? null;
  const facts: AttributionFacts = {
    outcome,
    regraded: grade.regraded,
    status: record.status ?? null,
    detail: record.detail ?? null,
    internal_errors: record.tool_errors?.INTERNAL ?? 0,
    state_hash: record.state_hash,
    manifest_hash: ctx.world_state_hash ?? null,
    task_version: record.task_version,
    decisive: failed === null ? null : {
      id: failed.id,
      exposure: attFits ? att.exposure.map((e) => ({ ...e, exposable: e.first_exposed_step === null && ctx.exposable ? ctx.exposable(e.id) : null })) : null,
    },
    matrix: ctx.matrix ?? null,
    check_error: grade.regraded ? null : (record.error ?? null),
    audit: row === null ? null : {
      outcome: row.outcome,
      label: (AUDIT_LABELS as readonly (string | null)[]).includes(auditLabelOf(row)) ? (auditLabelOf(row) as AuditLabelName) : null,
      model_fault: row.model_fault ?? null,
      llm_auditor_agrees: row.llm_auditor_agrees ?? null,
      adjudication: typeof row.adjudication === 'string' && row.adjudication.trim() !== '' ? row.adjudication : null,
      evidence_ids: row.evidence_ids ?? [],
    },
  };
  const holds = (f: Fault) => FAULT_DEFINITIONS[f].criteria.map((c) => ({ c, r: c.check(facts) })).filter((x) => x.r.met === true);
  const mapped = FAULT[outcome as Outcome] ?? null;
  const graderHolds = holds('grader');
  const envHolds = holds('env');
  const fault: Fault | null = mapped === 'infra' ? 'infra' : graderHolds.length > 0 ? 'grader' : envHolds.length > 0 ? 'env' : mapped;
  const label = fault === null ? null : AUDIT_LABEL[fault];
  const taxonomy = attFits && (TAXONOMY as readonly string[]).includes(att.auto) ? (att.auto as Taxonomy) : null;
  const ef = failed === null ? null : expectedFound(failed.evidence);
  const decisive_check = failed === null || ef === null ? null : { id: failed.id, traces_to: ctx.checks?.find((c) => c.id === failed.id)?.traces_to ?? null, ...ef };

  let reason: string;
  if (grade.valid && outcome !== 'PASS') {
    if (decisive_check !== null) {
      const clause = fault === 'env' ? `${envHolds[0]!.r.evidence}, so this is environment`
        : fault === 'grader' ? `${graderHolds[0]!.c.id === 'GR3' ? 'an audit found a grader bug' : graderHolds[0]!.r.evidence}, so this is grader`
          : taxonomy !== null ? TAXONOMY_CLAUSE[taxonomy](facts) : null;
      const base = checkSentence(decisive_check.id, decisive_check.expected, decisive_check.found, REASON_WORDS);
      const fits = (s: string) => words(s).length <= REASON_WORDS;
      const short = fault === 'env' ? 'environment' : fault === 'grader' ? 'grader' : taxonomy?.replace(/_/g, ' ') ?? null;
      reason = clause !== null && fits(`${base}; ${clause}`) ? `${base}; ${clause}` : short !== null && fits(`${base}; ${short}`) ? `${base}; ${short}` : base;
    } else if (outcome === 'REFUSAL') {
      const text = refusalText(record, ctx.events);
      reason = text === null ? `refused: no refusal text recorded${record.refusal_category ? ` (category ${record.refusal_category})` : ''}` : `refused: ${words(text).slice(0, REFUSAL_WORDS).join(' ')}`;
    } else if (outcome === 'LIMIT') {
      reason = limitSentence(record, ctx.events);
    } else {
      reason = `${outcome}: no failed gate check recorded`;
    }
  } else if (outcome === 'PASS') {
    reason = fault === 'grader' ? 'PASS, but an audit found a grader bug' : fault === 'env' ? `PASS, but ${envHolds[0]!.r.evidence}` : 'PASS: every gate check met';
  } else {
    const detail = record.detail ? ` (${record.detail})` : '';
    if (fault === 'grader') {
      const why = graderHolds.find((x) => x.c.id === 'GR1') ? `check ${facts.check_error!.check} threw ${firstWords(facts.check_error!.message, 6)}` : graderHolds[0]?.c.id === 'GR3' ? 'an audit found a grader bug' : 'a regrade disagrees with the record';
      reason = `${outcome}: ${why}; the grader's fault, which blocks the run`;
    } else if (fault === 'env') {
      reason = `${outcome}${detail}: ${envHolds[0]?.r.evidence ?? 'the environment failed'}; the environment's fault, excluded and rerun`;
    } else if (outcome === 'CANCELLED') {
      reason = 'CANCELLED: stopped from outside; says nothing about the model, excluded and rerun';
    } else {
      reason = `${outcome}${detail}: the infrastructure's fault, not a trial of the model; excluded and rerun`;
    }
  }

  return {
    outcome,
    valid: grade.valid,
    fault,
    label: label?.label ?? null,
    label_subtype: label?.subtype ?? null,
    audited: row !== null,
    decisive_check,
    decisive_step: attFits ? att.decisive_step : (row?.decisive_step ?? null),
    taxonomy,
    reason: capWords(reason),
    criteria: FAULT_DEFINITIONS.model.criteria.map((c) => ({ id: c.id, ...c.check(facts) })),
  };
}
