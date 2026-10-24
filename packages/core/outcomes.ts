// Trial outcomes (design section 5, "Outcomes"): the one definition of which outcomes exist,
// which count as valid trials, and whose fault each one is. The grader (packages/grader), the
// cost model's final-run reserve (cost.ts) and every reader of a record import it from here, so
// they cannot disagree on whether a trial counts.
//
// Each trial gets exactly one outcome, checked in this order. The first five are never valid
// trials and never model failures: they are rerun, not graded. CANCELLED sits with the INFRA
// outcomes: the run was stopped from outside, so it says nothing about the model. GRADER_ERROR
// is a check that threw, or a regrade whose world or replay differs from the record: the
// grader's fault, never rerun (RERUN_OUTCOMES). REFUSAL, LIMIT, FAIL and PASS are valid and count
// in the headline denominator. GRADER_BUG is set only by an audit, never by code, so it is not
// listed.
//
// The attribution definitions (plan phase P14a) live here too, and only here: FAULT_DEFINITIONS
// (one sentence per Fault and the criteria that decide it), FAULT_PRECEDENCE, the confirmation
// criteria M1-M5 and CONFIRMATION_DEFINITIONS, RUN_BLOCKS, AUDIT_LABEL, PASS_DEFINITION, DENOMINATOR_RULE and
// DENOMINATOR_OPERATOR_NOTE. explain.ts evaluates the criteria; the UI, cli/audit-check.ts, the
// auditor prompt and the writeup render these strings, and scripts/test/one-definition.test.ts
// fails on a copy written anywhere else.
export const OUTCOMES = ['INVALID', 'INFRA_HARNESS', 'INFRA_API', 'CANCELLED', 'ENV_ERROR', 'GRADER_ERROR', 'REFUSAL', 'LIMIT', 'FAIL', 'PASS'] as const;
export type Outcome = (typeof OUTCOMES)[number];
export const VALID_OUTCOMES: readonly Outcome[] = ['REFUSAL', 'LIMIT', 'FAIL', 'PASS'];

// An allowlist: an unknown, misspelled or missing outcome is not a valid trial.
export const isValid = (o: string | null | undefined): boolean => (VALID_OUTCOMES as readonly (string | null | undefined)[]).includes(o);

// Whose fault an outcome is: the model's (it failed or did not finish), a refusal (reported
// both ways), the environment's, the grader's, or the infrastructure's (API, harness, a
// substituted model, a stop from outside). A PASS is nobody's fault.
export type Fault = 'model' | 'refusal' | 'env' | 'grader' | 'infra';
export const FAULT: Readonly<Record<Outcome, Fault | null>> = {
  INVALID: 'infra',
  INFRA_HARNESS: 'infra',
  INFRA_API: 'infra',
  CANCELLED: 'infra',
  ENV_ERROR: 'env',
  GRADER_ERROR: 'grader',
  REFUSAL: 'refusal',
  LIMIT: 'model',
  FAIL: 'model',
  PASS: null,
};

// The excluded outcomes a rerun can cure. A grader's fault is not one: rerunning would pay for a
// model trial to work around a grader bug.
export const RERUN_OUTCOMES: readonly Outcome[] = OUTCOMES.filter((o) => !isValid(o) && FAULT[o] !== 'grader');
const NEVER_RERUN: readonly Outcome[] = OUTCOMES.filter((o) => !isValid(o) && FAULT[o] === 'grader');

// done-when (6)'s three attribution labels, and the one mapping from the five faults to them. An
// INFRA trial gets no label: it is not a failure, it is excluded from the valid denominator and
// rerun.
export type AuditLabelName = 'model' | 'environment' | 'grader';
export const AUDIT_LABEL: Readonly<Record<Fault, { label: AuditLabelName; subtype: 'refusal' | null } | null>> = {
  model: { label: 'model', subtype: null },
  refusal: { label: 'model', subtype: 'refusal' },
  grader: { label: 'grader', subtype: null },
  env: { label: 'environment', subtype: null },
  infra: null,
};
export const AUDIT_LABELS: readonly AuditLabelName[] = [...new Set(Object.values(AUDIT_LABEL).flatMap((l) => (l === null ? [] : [l.label])))];

// The grader validation matrix's verdict on one task_version (pnpm cli matrix). failed_checks
// names the gate checks the oracle or an alternative fails; absent when the matrix does not say.
export interface MatrixResult {
  task_version: string;
  oracle_pass: boolean;
  alternatives_pass: boolean;
  failed_checks?: readonly string[];
}

// What a criterion is checked over: one trial's facts at its current grade, gathered by
// explain.ts from the record, the audit row and the caller's context. null where the caller
// could not say (no manifest, no matrix, no world to ask).
export interface AttributionFacts {
  // record.outcome, or the last record.regrades[].outcome (summary.ts currentGrade).
  outcome: string;
  regraded: boolean;
  status: string | null;
  detail: string | null;
  stop_reason: string | null;
  model_requested: string | null;
  // MODEL (packages/core/anthropic.ts), the model every trial must request and get.
  model_expected: string | null;
  models_returned: readonly string[];
  internal_errors: number;
  state_hash: { initial: string | null; final: string | null; replay_final: string | null };
  manifest_hash: string | null;
  task_version: string | null;
  // The first failed gate check of the current grade and its decisive ids; exposure null when
  // nothing says what this check's ids were exposed at (a regrade failed another check and the
  // caller could not recompute it).
  decisive: { id: string; exposure: ReadonlyArray<{ id: string; first_exposed_step: number | null; exposable: boolean | null }> | null } | null;
  matrix: MatrixResult | null;
  check_error: { check: string | null; message: string } | null;
  audit: { outcome: string; label: AuditLabelName | null; model_fault: string | null; llm_auditor_agrees: boolean | null; adjudicated_label: AuditLabelName | null; evidence_ids: readonly string[] } | null;
}

// 'n/a': the criterion asks about something the trial does not have (M1 with no failed check).
export type CriterionMet = boolean | 'pending' | 'n/a';
export interface CriterionResult {
  met: CriterionMet;
  evidence: string;
}
export interface Criterion {
  id: string;
  // One sentence a reader can check against the record.
  text: string;
  // The record fields (and audit row, manifest, matrix, world or trajectory) the check reads.
  reads: readonly string[];
  check: (f: AttributionFacts) => CriterionResult;
  // An environment or grader criterion that is a fact of the record: when it decides, the label is
  // confirmed without an audit (CONFIRMATION_DEFINITIONS). The others are judgments an audit confirms.
  record_fact?: boolean;
}
export interface FaultDefinition {
  sentence: string;
  // Any one that holds makes the fault apply; FAULT_PRECEDENCE picks among faults that apply.
  criteria: readonly Criterion[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (xs: readonly string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const replayOk = (h: AttributionFacts['state_hash']) => h.final !== null && h.replay_final === h.final;
const ENV_DETAILS = ['INTERNAL', 'initial_hash_mismatch', 'replay_mismatch'];
const result = (met: CriterionMet, evidence: string): CriterionResult => ({ met, evidence });
// Holds exactly when the criterion is not met; pending or n/a decide nothing.
const negation = (c: Criterion['check']): Criterion['check'] => (f) => {
  const r = c(f);
  return result(r.met === false, r.evidence);
};
const statusIs = (o: Outcome) => (f: AttributionFacts) => result(f.status === o || f.outcome === o, `status ${f.status}${f.detail ? `, detail ${f.detail}` : ''}`);

// The criteria that confirm a model or refusal label: all met is confirmed, one pending is
// provisional, one not met is contradicted. M1-M4 not met each make an env or grader criterion
// hold (E5, E1, E2 or E4, GR4), so a trial labelled model never shows them not met. M4 and GR4 ask
// about the check the trial failed: a matrix that fails another check is the run-level block B1,
// a note, and decides no trial's fault.
const M1: Criterion = {
  id: 'M1',
  text: 'Every decisive id of the failed gate check was shown to the model, or is in the world so the tool would have returned it had the model asked.',
  reads: ['record.attribution.exposure (recomputed from the trajectory when a regrade failed another check)', 'world (is the id a resource of the world)'],
  check: ({ decisive }) => {
    if (decisive === null) return result('n/a', 'no gate check failed');
    if (decisive.exposure === null) return result('pending', `the record does not say what ${decisive.id}'s decisive ids were exposed at`);
    if (decisive.exposure.length === 0) return result(true, `${decisive.id} names no decisive ids`);
    const lines = decisive.exposure.map((e) =>
      e.first_exposed_step !== null ? `${e.id} exposed at step ${e.first_exposed_step}`
        : e.exposable === true ? `${e.id} never exposed but exposable (in the world)`
          : e.exposable === false ? `${e.id} was never exposed and is not exposable (not in the world)`
            : `${e.id} never exposed; exposability not checked`);
    const met = decisive.exposure.every((e) => e.first_exposed_step !== null || e.exposable === true) ? true
      : decisive.exposure.some((e) => e.first_exposed_step === null && e.exposable === false) ? false : 'pending';
    return result(met, lines.join('; '));
  },
};
const M3: Criterion = {
  id: 'M3',
  text: "The initial state hash equals the manifest's, and the replayed final state hash equals the final hash.",
  reads: ['record.state_hash.initial', 'record.state_hash.final', 'record.state_hash.replay_final', 'manifest world_hash'],
  check: ({ state_hash: h, manifest_hash }) => {
    const replay = replayOk(h) ? `replay_final equals final ${h.final}` : `replay_final ${h.replay_final} is not final ${h.final}`;
    if (!replayOk(h) || h.initial === null) return result(false, `${h.initial === null ? 'no initial hash; ' : ''}${replay}`);
    if (manifest_hash === null) return result('pending', `no manifest hash to compare initial ${h.initial} with; ${replay}`);
    return result(h.initial === manifest_hash, `initial ${h.initial} ${h.initial === manifest_hash ? 'equals' : 'is not'} the manifest's ${manifest_hash}; ${replay}`);
  },
};
const M4: Criterion = {
  id: 'M4',
  text: "The task's oracle and every declared alternative pass the grader validation matrix on the trial's task_version, or none of them fails the gate check the trial failed, or the trial's outcome is not FAIL (a REFUSAL or LIMIT comes from the record status, which no grader fix changes).",
  reads: ['record.outcome', 'record.task_version', 'record.checks (the first failed gate check)', 'matrix oracle_pass, alternatives_pass and failed_checks for that task_version'],
  check: ({ outcome, matrix, task_version, decisive }) => {
    if (matrix === null) return result('pending', `no grader validation matrix result for ${task_version}`);
    if (matrix.task_version !== task_version) return result('pending', `the matrix result is for task_version ${matrix.task_version}, the trial ran ${task_version}`);
    const verdict = `oracle ${matrix.oracle_pass ? 'passes' : 'fails'}, alternatives ${matrix.alternatives_pass ? 'all pass' : 'do not all pass'} on ${task_version}`;
    if (matrix.oracle_pass && matrix.alternatives_pass) return result(true, verdict);
    if (decisive === null) return result(true, `${verdict}; the trial failed no gate check`);
    if (outcome !== 'FAIL') return result(true, `${verdict}; the outcome ${outcome} comes from the record status, not from ${decisive.id}`);
    if (matrix.failed_checks === undefined) return result('pending', `${verdict}; the matrix does not say which checks fail, so it cannot say whether ${decisive.id} does`);
    const fails = matrix.failed_checks.includes(decisive.id);
    return result(!fails, `${verdict}, failing ${matrix.failed_checks.length === 0 ? 'no named check' : list(matrix.failed_checks)}; the trial failed ${decisive.id}`);
  },
};

export const CONFIRMATION_CRITERIA: readonly Criterion[] = [
  M1,
  {
    id: 'M2',
    text: 'No tool call of the trial returned an INTERNAL error.',
    reads: ['record.tool_errors.INTERNAL'],
    check: (f) => result(f.internal_errors === 0, plural(f.internal_errors, 'INTERNAL tool error')),
  },
  M3,
  M4,
  {
    id: 'M5',
    text: "A human audit's adjudicated_label, else its label, is model, and either the adjudicated_label is set or the audit says model_fault yes with no disagreeing LLM auditor.",
    reads: ['audit.adjudicated_label', 'audit.label (else implied by audit.taxonomy)', 'audit.model_fault', 'audit.llm_auditor_agrees'],
    check: ({ audit, outcome }) => {
      if (audit === null) return result('pending', 'not human-audited');
      if (outcome === 'PASS') return result(audit.outcome === 'PASS', `audited ${audit.outcome}`);
      const llm = audit.llm_auditor_agrees === null ? 'no LLM auditor verdict' : `LLM auditor ${audit.llm_auditor_agrees ? 'agrees' : 'disagrees'}`;
      const said = audit.adjudicated_label ?? audit.label;
      const met = said === 'model' && (audit.adjudicated_label !== null || (audit.model_fault === 'yes' && audit.llm_auditor_agrees !== false));
      return result(met, `labelled ${audit.label ?? 'none'}, model_fault ${audit.model_fault ?? 'none'}, ${llm}${audit.adjudicated_label === null ? '' : `, adjudicated ${audit.adjudicated_label}`}`);
    },
  },
];

export const FAULT_DEFINITIONS: Readonly<Record<Fault, FaultDefinition>> = {
  model: {
    sentence: 'The model is at fault when a valid trial failed a gate check or stopped at a limit and no infra, grader or environment criterion holds.',
    criteria: [
      {
        id: 'MF1',
        text: "A gate check failed in the trial's current grade.",
        reads: ['record.outcome or the last record.regrades[].outcome', 'record.checks or the last record.regrades[].checks'],
        check: (f) => result(f.outcome === 'FAIL', `current outcome ${f.outcome}${f.decisive === null ? '' : `, ${f.decisive.id} failed`}`),
      },
      {
        id: 'MF2',
        text: 'The trial stopped at its turn, cost, time or output limit before the model finished.',
        reads: ['record.status', 'record.detail'],
        check: (f) => result(f.outcome === 'LIMIT', `current outcome ${f.outcome}${f.outcome === 'LIMIT' && f.detail ? `, ${f.detail} limit` : ''}`),
      },
    ],
  },
  refusal: {
    sentence: 'A refusal is the model declining the task: it counts as a model failure in the headline rate and is also reported with refusals left out.',
    criteria: [
      {
        id: 'R1',
        text: 'The API ended the model\'s turn with stop_reason refusal.',
        reads: ['record.stop_reason', 'record.status'],
        check: (f) => result(f.stop_reason === 'refusal' || f.status === 'REFUSAL' || f.outcome === 'REFUSAL', `stop_reason ${f.stop_reason ?? 'not recorded'}, status ${f.status}`),
      },
    ],
  },
  env: {
    sentence: 'The environment is at fault when a tool failed internally, the starting or final state cannot be trusted, an invariant broke, or the evidence a check relies on is not in the world.',
    criteria: [
      {
        id: 'E1',
        record_fact: true,
        text: 'A tool call returned an INTERNAL error, or the trial ended ENV_ERROR with detail INTERNAL (M2 not met).',
        reads: ['record.tool_errors.INTERNAL', 'record.status', 'record.detail'],
        check: (f) => result(f.internal_errors > 0 || (f.status === 'ENV_ERROR' && f.detail === 'INTERNAL'), `${plural(f.internal_errors, 'INTERNAL tool error')}${f.detail === 'INTERNAL' ? ', ended ENV_ERROR INTERNAL' : ''}`),
      },
      {
        id: 'E2',
        record_fact: true,
        text: "The initial state hash is missing or differs from the manifest's.",
        reads: ['record.state_hash.initial', 'record.detail', 'manifest world_hash'],
        check: ({ detail, state_hash: h, manifest_hash }) =>
          result(detail === 'initial_hash_mismatch' || h.initial === null || (manifest_hash !== null && h.initial !== manifest_hash), `initial ${h.initial ?? 'missing'}, manifest ${manifest_hash ?? 'not given'}`),
      },
      {
        id: 'E3',
        record_fact: true,
        text: 'The trial ended ENV_ERROR for a reason other than an INTERNAL error or a state hash mismatch, such as a broken environment invariant.',
        reads: ['record.status', 'record.detail'],
        check: ({ status, detail }) => result(status === 'ENV_ERROR' && !ENV_DETAILS.includes(detail ?? ''), `status ${status}, detail ${detail}`),
      },
      {
        id: 'E4',
        record_fact: true,
        text: 'The final state hash is missing, or replaying the trajectory did not reproduce it.',
        reads: ['record.state_hash.final', 'record.state_hash.replay_final', 'record.detail'],
        check: ({ detail, state_hash: h }) => result(detail === 'replay_mismatch' || !replayOk(h), `final ${h.final ?? 'missing'}, replay_final ${h.replay_final ?? 'missing'}`),
      },
      {
        id: 'E5',
        text: 'A decisive id of the failed gate check was never shown to the model and is not in the world, so no tool could have returned it (M1 not met).',
        reads: M1.reads,
        check: negation(M1.check),
      },
    ],
  },
  grader: {
    sentence: "The grader is at fault when a check threw, a regrade could not grade the record, a human audit found a grader bug, or the task's own oracle or alternatives fail the check the trial failed.",
    criteria: [
      {
        id: 'GR1',
        record_fact: true,
        text: 'A grader check threw an exception while the trial was graded.',
        reads: ['record.outcome', 'record.error.check', 'record.error.message'],
        check: (f) => result(f.outcome === 'GRADER_ERROR' && !f.regraded && f.check_error?.check != null, f.check_error === null ? 'no grader error' : `check ${f.check_error.check}: ${f.check_error.message}`),
      },
      {
        // A regrade keeps no error, so a check that threw in a regrade lands here too. A regrade
        // that cannot rebuild the recorded world is the grader's fault, not the environment's: the
        // trial's own hashes were checked when it ran (E2, E4), and only the regrade failed.
        id: 'GR2',
        record_fact: true,
        text: 'An offline regrade ended GRADER_ERROR, or the grade ended GRADER_ERROR without naming the check that threw.',
        reads: ['record.regrades[].outcome', 'record.outcome', 'record.error.check'],
        check: (f) => result(f.outcome === 'GRADER_ERROR' && (f.regraded || f.check_error?.check == null), `current outcome ${f.outcome}${f.regraded ? ', from a regrade' : ''}`),
      },
      {
        id: 'GR3',
        text: 'A human audit marks the trial GRADER_BUG and cites at least one evidence id.',
        reads: ['audit.outcome', 'audit.evidence_ids'],
        check: ({ audit }) => result(audit !== null && audit.outcome === 'GRADER_BUG' && audit.evidence_ids.length > 0, audit === null ? 'not human-audited' : `audited ${audit.outcome}, ${plural(audit.evidence_ids.length, 'evidence id')}`),
      },
      {
        id: 'GR4',
        text: "The trial is a FAIL, and the task's oracle or a declared alternative fails, on the trial's task_version, the same gate check the trial failed, as the matrix's failed_checks names it (M4 not met).",
        reads: M4.reads,
        check: negation(M4.check),
      },
    ],
  },
  infra: {
    sentence: 'The infrastructure is at fault when the API, the harness, a substituted model or a stop from outside ended the trial, so it says nothing about the model.',
    criteria: [
      {
        id: 'I1',
        text: 'The API answered with a model other than the one requested or other than MODEL, the trial requested a model other than MODEL, or the harness marked the trial INVALID.',
        reads: ['record.models_returned', 'record.model_requested', 'record.status', 'record.model_requested and record.models_returned against MODEL (packages/core/anthropic.ts), as packages/grader/outcome.ts compares them'],
        check: (f) => {
          const want = [f.model_requested, f.model_expected].filter((m): m is string => m !== null);
          const other = f.models_returned.filter((m) => want.some((w) => m !== w));
          const wrongRequest = f.model_requested !== null && f.model_expected !== null && f.model_requested !== f.model_expected;
          const evidence = wrongRequest ? `requested ${f.model_requested}, MODEL is ${f.model_expected}` : other.length > 0 ? `requested ${f.model_requested}, returned ${list([...new Set(other)])}` : `status ${f.status}${f.detail ? `, detail ${f.detail}` : ''}`;
          return result(other.length > 0 || wrongRequest || f.status === 'INVALID' || f.outcome === 'INVALID', evidence);
        },
      },
      { id: 'I2', text: 'The harness crashed or lost its worker before the trial ended.', reads: ['record.status', 'record.detail'], check: statusIs('INFRA_HARNESS') },
      { id: 'I3', text: 'The Anthropic API kept failing after the client\'s retries.', reads: ['record.status', 'record.detail'], check: statusIs('INFRA_API') },
      { id: 'I4', text: 'The run was stopped from outside before the trial ended.', reads: ['record.status', 'record.detail'], check: statusIs('CANCELLED') },
    ],
  },
};

// Which fault decides when criteria of several hold. The FAULT map's fault of an outcome is
// always among them (an INFRA outcome meets an I criterion, GRADER_ERROR a GR one, and so on).
export const FAULT_PRECEDENCE: readonly Fault[] = ['infra', 'grader', 'env', 'refusal', 'model'];
export const FAULT_PRECEDENCE_RULE = 'When criteria of several faults hold, the first in the order infra, grader, environment, refusal, model decides and the others are shown as notes: a trial the infrastructure ended says nothing about the model, a grader fault on the check the trial failed means the grade itself is wrong, an environment fault means the trial was unfair to the model, and a refusal is reported both with and without refusals.';

// Run-level blocks: facts about a task_version, not about one trial. One that holds is shown as a
// note on every trial of that task_version, decides no trial's fault, and blocks the run
// (cli/audit-check.ts exits 1) until it no longer holds.
export const RUN_BLOCKS: readonly Criterion[] = [
  {
    id: 'B1',
    text: "The task's oracle or a declared alternative fails the grader validation matrix on the trial's task_version, which blocks the run until the task or the grader is fixed.",
    reads: ['record.task_version', 'matrix oracle_pass and alternatives_pass for that task_version'],
    check: ({ matrix, task_version }) => {
      if (matrix === null || matrix.task_version !== task_version) return result('pending', `no grader validation matrix result for ${task_version}`);
      const failed = matrix.failed_checks?.length ? `, failing ${list(matrix.failed_checks)}` : '';
      return result(!(matrix.oracle_pass && matrix.alternatives_pass), `oracle ${matrix.oracle_pass ? 'passes' : 'fails'}, alternatives ${matrix.alternatives_pass ? 'all pass' : 'do not all pass'} on ${task_version}${failed}`);
    },
  },
];

export type Confirmation = 'confirmed' | 'provisional' | 'contradicted';
export const CONFIRMATION_DEFINITIONS: Readonly<Record<Confirmation, string>> = {
  confirmed: 'Every criterion that can confirm the label is met: M1-M5 for a model or refusal label; for an environment or grader label, the record alone when E1-E4, GR1 or GR2 decided it, and a human audit with the same label when E5, GR3 or GR4 decided it; and the record alone for infra.',
  provisional: 'Nothing contradicts the label, but a confirming criterion is still pending, such as a missing audit, manifest hash or matrix result.',
  contradicted: 'A confirming criterion is not met or a human audit gives another label, so the label must be reviewed before it is used.',
};

export const PASS_DEFINITION = 'A trial is a PASS when every gate check of its current grade is met (record.checks, or the last record.regrades[].checks); any environment or grader criterion that holds is shown as a note and does not change the outcome.';

export const DENOMINATOR_RULE = [
  `Only ${list(VALID_OUTCOMES)} count in the denominator, and every other outcome is excluded: ${list(RERUN_OUTCOMES)} are excluded and rerun, and ${list(NEVER_RERUN)} ${NEVER_RERUN.length === 1 ? 'is' : 'are'} excluded and never rerun as a model trial.`,
  'A GRADER_ERROR in a committed run blocks the run until a grader fix and a full offline regrade, and a valid failure labelled environment or grader is not allowed in a committed run: cli audit-check fails the run until a grader label is resolved by that fix and regrade, or an environment label by an environment fix and a rerun of only the affected trials, disclosed in results/CHANGELOG.md, so a run with one has no headline pass rate.',
  'A refusal counts as a model failure inside the denominator, and refusal_excluded_rate gives the pass rate with refusals left out.',
].join(' ');

export const DENOMINATOR_OPERATOR_NOTE = [
  'ENV_ERROR trials still count raw against the env_error_raw requirement.',
  "`summary --require grader_error=0` checks each record's current grade after any offline regrade, so a regraded record counts by its new outcome; the summary prints grader_error_history (every GRADER_ERROR ever recorded, regraded ones included) for disclosure, and grader_error_history is never a require key.",
].join(' ');
