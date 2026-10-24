// Why one trial ended as it did (plan phase P14a): its outcome, fault, audit label, the criterion
// that decided the fault, the confirmation state, decisive check, reason and the M1-M5 criteria,
// from its record at the current grade (summary.ts currentGrade: the last regrade, else the
// recorded grade), its audit row when it has one, and what the caller can say about the world.
// The UI's "why this failed", cli/audit-check.ts, the auditor prompt and the writeup all call
// explainTrial, so none of them can disagree with the audit. Pure: no Node, DOM or file access.
//
// Every criterion of outcomes.ts FAULT_DEFINITIONS is checked; the fault is the first of
// FAULT_PRECEDENCE with a criterion that holds, and the label is AUDIT_LABEL of it. Criteria of
// the other faults that hold are returned as notes, and so is a run-level block (RUN_BLOCKS) that
// holds. A PASS has no fault: whatever holds on it is a note (PASS_DEFINITION). The confirmation
// state follows CONFIRMATION_DEFINITIONS, and blocksRun says why a trial blocks the run.
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
import { MODEL } from './anthropic.ts';
import { PER_TRIAL_CAP_USD } from './cost.ts';
import {
  AUDIT_LABEL, AUDIT_LABELS, CONFIRMATION_CRITERIA, FAULT_DEFINITIONS, FAULT_PRECEDENCE, RUN_BLOCKS, type AttributionFacts, type AuditLabelName, type Confirmation, type CriterionMet, type Fault,
  type MatrixResult,
} from './outcomes.ts';
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
  stop_reason?: string | null;
  model_requested?: string | null;
  models_returned?: readonly string[];
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
// optional: without them a taxonomy in TAXONOMY reads as model, environment or grader as itself,
// and an outcome GRADER_BUG as grader. adjudicated_label settles a row whose model_fault is unclear
// or whose LLM auditor disagrees; the reasoning goes in note. criteria is what audit-check writes
// back: explainTrial's criteria for the trial.
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
  adjudicated_label?: AuditLabelName | null;
  note?: string;
  criteria?: CriterionRow[];
}

// What the caller knows beyond the record. Each criterion that needs a missing part is pending.
export interface ExplainContext {
  // The trial's trajectory: the limit and refusal sentences read it. Required, so a UI caller
  // cannot leave it out and get "?" where the limit event has the value.
  events: readonly TrialEvent[];
  // The manifest's initial state hash (fixtures/manifest.json world.state_hash, or the run
  // manifest's world_hash).
  world_state_hash?: string | null;
  // Whether a resource is in the world, so the tool would have returned it had the model asked.
  exposable?: (id: string) => boolean;
  // The exposure of the current decisive check's ids, when the caller recomputed it from the
  // trajectory (a regrade failed another check than the recorded attribution names).
  exposure?: { check: string; ids: ReadonlyArray<{ id: string; first_exposed_step: number | null }> } | null;
  // The grader validation matrix of the task (pnpm cli matrix), with the checks it fails when it says.
  matrix?: MatrixResult | null;
  // The task's gate checks, for traces_to.
  checks?: ReadonlyArray<{ id: string; traces_to: string }>;
}

export interface CriterionRow {
  id: string;
  met: CriterionMet;
  evidence: string;
}

export interface Holding {
  fault: Fault;
  id: string;
  evidence: string;
}

export interface Explanation {
  outcome: string;
  valid: boolean;
  fault: Fault | null;
  label: AuditLabelName | null;
  label_subtype: 'refusal' | null;
  // The criterion that decided the fault; null on a PASS.
  deciding: Holding | null;
  confirmation: Confirmation | null;
  // Infra, grader and env criteria that hold but did not decide (lower in FAULT_PRECEDENCE, or on a
  // PASS), then the run-level blocks (RUN_BLOCKS) that hold, as fault grader.
  notes: Holding[];
  audited: boolean;
  // The label the audit row gives (its adjudicated_label when it has one), next to the computed one.
  audit_label: AuditLabelName | null;
  decisive_check: { id: string; traces_to: string | null; expected: string; found: string } | null;
  decisive_step: number | null;
  taxonomy: Taxonomy | null;
  reason: string;
  // CONFIRMATION_CRITERIA, M1-M5.
  criteria: CriterionRow[];
  // Every criterion of every fault, met or not.
  fault_criteria: Record<Fault, CriterionRow[]>;
}

const MET_TEXT: Record<string, string> = { true: 'met', false: 'not met', pending: 'pending', 'n/a': 'not applicable' };
export const formatCriterion = (c: Pick<CriterionRow, 'id' | 'met'>): string => `${c.id}: ${MET_TEXT[String(c.met)]}`;

const isLabel = (l: unknown): l is AuditLabelName => (AUDIT_LABELS as readonly unknown[]).includes(l);

// The audit label a row gives: its adjudicated_label, else its label, else the one its taxonomy or a
// GRADER_BUG outcome implies. explainTrial's audit_label and M5 and audit-check all read it so.
export function auditLabelOf(row: Pick<AuditRow, 'label' | 'taxonomy' | 'outcome' | 'adjudicated_label'>): string | null {
  if (row.adjudicated_label !== undefined && row.adjudicated_label !== null) return row.adjudicated_label;
  if (row.label !== undefined && row.label !== null) return row.label;
  if ((AUDIT_LABELS as readonly (string | null)[]).includes(row.taxonomy)) return row.taxonomy;
  if (row.outcome === 'GRADER_BUG') return 'grader';
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
  if (typeof v === 'string') return v.trim() === '' ? 'none' : v;
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

export function explainTrial(record: ExplainRecord, audit: AuditRow | null | undefined, ctx: ExplainContext): Explanation {
  const grade = currentGrade(record);
  const outcome = grade.outcome;
  const checks = (grade.checks ?? []) as ReadonlyArray<ExplainCheck>;
  // The first failed gate check; a check with no kind (a hand-built record) counts as a gate.
  const failed = checks.find((c) => c.kind === 'gate' && c.met === false) ?? (outcome === 'FAIL' ? checks.find((c) => c.kind === undefined && c.met === false) : undefined) ?? null;
  const att = record.attribution ?? null;
  // The recorded attribution speaks for the current grade only when it names the same check.
  const attFits = att !== null && att.first_failed === (failed?.id ?? null);
  const recomputed = failed !== null && !attFits && ctx.exposure?.check === failed.id ? ctx.exposure.ids : null;
  const exposure = attFits ? att.exposure : recomputed;
  const row = audit ?? null;
  // The row's own label, before adjudication; M5 and audit_label put adjudicated_label first.
  const rowLabel = row === null ? null : auditLabelOf({ ...row, adjudicated_label: null });
  const facts: AttributionFacts = {
    outcome,
    regraded: grade.regraded,
    status: record.status ?? null,
    detail: record.detail ?? null,
    stop_reason: record.stop_reason ?? null,
    model_requested: record.model_requested ?? null,
    model_expected: MODEL,
    models_returned: record.models_returned ?? [],
    internal_errors: record.tool_errors?.INTERNAL ?? 0,
    state_hash: record.state_hash,
    manifest_hash: ctx.world_state_hash ?? null,
    task_version: record.task_version,
    decisive: failed === null ? null : {
      id: failed.id,
      exposure: exposure === null ? null : exposure.map((e) => ({ ...e, exposable: e.first_exposed_step === null && ctx.exposable ? ctx.exposable(e.id) : null })),
    },
    matrix: ctx.matrix ?? null,
    check_error: grade.regraded ? null : (record.error ?? null),
    audit: row === null ? null : {
      outcome: row.outcome,
      label: isLabel(rowLabel) ? rowLabel : null,
      model_fault: row.model_fault ?? null,
      llm_auditor_agrees: row.llm_auditor_agrees ?? null,
      adjudicated_label: isLabel(row.adjudicated_label) ? row.adjudicated_label : null,
      evidence_ids: row.evidence_ids ?? [],
    },
  };
  const fault_criteria = Object.fromEntries(FAULT_PRECEDENCE.map((f) => [f, FAULT_DEFINITIONS[f].criteria.map((c) => ({ id: c.id, ...c.check(facts) }))])) as Record<Fault, CriterionRow[]>;
  const holding: Holding[] = FAULT_PRECEDENCE.flatMap((f) => fault_criteria[f].filter((c) => c.met === true).map((c) => ({ fault: f, id: c.id, evidence: c.evidence })));
  const deciding = outcome === 'PASS' ? null : (holding[0] ?? null);
  const fault = deciding?.fault ?? null;
  // MF and R criteria restate the outcome, so only infra, grader and env criteria are notes.
  // A run-level block is a note, and is not repeated when GR4 decided on the same matrix.
  const blocks: Holding[] = RUN_BLOCKS.flatMap((c) => {
    const r = c.check(facts);
    return r.met === true && deciding?.id !== 'GR4' ? [{ fault: 'grader' as const, id: c.id, evidence: r.evidence }] : [];
  });
  const notes = [...holding.filter((h) => h.fault !== fault && h.fault !== 'model' && h.fault !== 'refusal'), ...blocks];
  const label = fault === null ? null : AUDIT_LABEL[fault];
  const criteria = CONFIRMATION_CRITERIA.map((c) => ({ id: c.id, ...c.check(facts) }));
  const audit_label = facts.audit === null ? null : (facts.audit.adjudicated_label ?? facts.audit.label);
  const recordFact = fault !== null && FAULT_DEFINITIONS[fault].criteria.find((c) => c.id === deciding?.id)?.record_fact === true;
  const confirmation: Confirmation | null = fault === null ? null
    : fault === 'infra' ? (audit_label === null ? 'confirmed' : 'contradicted')
      : fault === 'model' || fault === 'refusal' ? (criteria.some((c) => c.met === false) ? 'contradicted' : criteria.some((c) => c.met === 'pending') ? 'provisional' : 'confirmed')
        : facts.audit !== null ? (audit_label === label!.label ? 'confirmed' : 'contradicted') : recordFact ? 'confirmed' : 'provisional';
  const taxonomy = attFits && (TAXONOMY as readonly string[]).includes(att.auto) ? (att.auto as Taxonomy) : null;
  const ef = failed === null ? null : expectedFound(failed.evidence);
  const decisive_check = failed === null || ef === null ? null : { id: failed.id, traces_to: ctx.checks?.find((c) => c.id === failed.id)?.traces_to ?? null, ...ef };

  let reason: string;
  if (grade.valid && outcome !== 'PASS') {
    if (decisive_check !== null) {
      // The taxonomy speaks only for a model or refusal fault; an infra trial gets the check alone.
      const modelFault = fault === 'model' || fault === 'refusal';
      const clause = fault === 'env' ? `${deciding!.evidence}, so this is environment`
        : fault === 'grader' ? `${deciding!.id === 'GR3' ? 'an audit found a grader bug' : deciding!.evidence}, so this is grader`
          : modelFault && taxonomy !== null ? TAXONOMY_CLAUSE[taxonomy](facts) : null;
      const base = checkSentence(decisive_check.id, decisive_check.expected, decisive_check.found, REASON_WORDS);
      const fits = (s: string) => words(s).length <= REASON_WORDS;
      const short = fault === 'env' ? 'environment' : fault === 'grader' ? 'grader' : modelFault ? (taxonomy?.replace(/_/g, ' ') ?? null) : null;
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
    reason = notes.length === 0 ? 'PASS: every gate check met' : `PASS: every gate check met; note ${notes[0]!.id}: ${notes[0]!.evidence}`;
  } else {
    const detail = record.detail ? ` (${record.detail})` : '';
    if (fault === 'grader') {
      const why = deciding!.id === 'GR1' ? `check ${facts.check_error!.check} threw ${firstWords(facts.check_error!.message, 6)}` : deciding!.id === 'GR3' ? 'an audit found a grader bug' : deciding!.id === 'GR4' ? deciding!.evidence : 'a regrade could not grade the record';
      reason = `${outcome}: ${why}; the grader's fault, which blocks the run`;
    } else if (fault === 'env') {
      reason = `${outcome}${detail}: ${deciding!.evidence}; the environment's fault, excluded and rerun`;
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
    deciding,
    confirmation,
    notes,
    audited: row !== null,
    audit_label,
    decisive_check,
    decisive_step: attFits ? att.decisive_step : (row?.decisive_step ?? null),
    taxonomy,
    reason: capWords(reason),
    criteria,
    fault_criteria,
  };
}

// Why a trial blocks the run, or null. A valid failure labelled environment or grader is excluded
// from the headline denominator and blocks the run (DENOMINATOR_RULE); a run-level block (B1) on
// its task_version blocks it too. Excluded outcomes are not covered here: INFRA and ENV_ERROR are
// rerun, and summary --require grader_error=0 blocks a GRADER_ERROR. cli/audit-check.ts enforces
// both: summary.ts sees no audit rows, matrix or world, so it cannot compute these labels.
export function excludedFromHeadline(e: Explanation): string | null {
  if (!e.valid || e.outcome === 'PASS' || (e.fault !== 'env' && e.fault !== 'grader')) return null;
  const fix = e.fault === 'env' ? 'an environment fix and a rerun of the affected trials' : 'a grader fix and a full offline regrade';
  return `${e.outcome} is the ${e.fault === 'env' ? "environment's" : "grader's"} fault (${e.deciding!.id}): excluded from the headline denominator, and it blocks the run until ${fix}`;
}

export function blocksRun(e: Explanation): string | null {
  const block = e.notes.find((n) => RUN_BLOCKS.some((c) => c.id === n.id));
  return excludedFromHeadline(e) ?? (block === undefined ? null : `${block.id} holds: ${block.evidence}; it blocks the run until the task or the grader is fixed`);
}
