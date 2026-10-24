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
// (one sentence and the ordered criteria per Fault), AUDIT_LABEL, PASS_DEFINITION and
// DENOMINATOR_RULE. explain.ts evaluates the criteria; the UI, cli/audit-check.ts, the auditor
// prompt and the writeup render these strings, and scripts/test/one-definition.test.ts fails on
// a copy written anywhere else.
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

// What a criterion is checked over: one trial's facts at its current grade, gathered by
// explain.ts from the record, the audit row and the caller's context. undefined or null where
// the caller could not say (no manifest, no matrix, no world to ask).
export interface AttributionFacts {
  outcome: string;
  regraded: boolean;
  status: string | null;
  detail: string | null;
  internal_errors: number;
  state_hash: { initial: string | null; final: string | null; replay_final: string | null };
  manifest_hash: string | null;
  task_version: string | null;
  // The first failed gate check and its decisive ids; exposure null when the record does not
  // say what this check's ids were exposed at (a regrade failed another check).
  decisive: { id: string; exposure: ReadonlyArray<{ id: string; first_exposed_step: number | null; exposable: boolean | null }> | null } | null;
  matrix: { task_version: string; oracle_pass: boolean; alternatives_pass: boolean } | null;
  check_error: { check: string | null; message: string } | null;
  audit: { outcome: string; label: AuditLabelName | null; model_fault: string | null; llm_auditor_agrees: boolean | null; adjudication: string | null; evidence_ids: readonly string[] } | null;
}

export type CriterionMet = boolean | 'pending';
export interface CriterionResult {
  met: CriterionMet;
  evidence: string;
}
export interface Criterion {
  id: string;
  text: string;
  check: (f: AttributionFacts) => CriterionResult;
}
export interface FaultDefinition {
  sentence: string;
  criteria: readonly Criterion[];
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (xs: readonly string[]) => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
const replayOk = (h: AttributionFacts['state_hash']) => h.final !== null && h.replay_final === h.final;
const ENV_DETAILS = ['INTERNAL', 'initial_hash_mismatch', 'replay_mismatch'];
const result = (met: CriterionMet, evidence: string): CriterionResult => ({ met, evidence });

// One criterion per outcome the FAULT map gives this fault, so infra and refusal follow the map.
const byOutcome = (fault: Fault, prefix: string): Criterion[] =>
  OUTCOMES.filter((o) => FAULT[o] === fault).map((o, i) => ({
    id: `${prefix}${i + 1}`,
    text: `The trial's current outcome is ${o}, which the FAULT map assigns to ${fault}.`,
    check: (f) => result(f.outcome === o, `current outcome ${f.outcome}`),
  }));

export const FAULT_DEFINITIONS: Readonly<Record<Fault, FaultDefinition>> = {
  model: {
    sentence: 'The model is at fault when a valid trial failed or did not finish while the environment, the grader and the evidence it needed were all sound.',
    criteria: [
      {
        id: 'M1',
        text: 'Every decisive id of the first failed gate check was exposed to the model, or the tool would have returned it had the model asked.',
        check: ({ decisive }) => {
          if (decisive === null) return result(true, 'no gate check failed');
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
      },
      {
        id: 'M2',
        text: 'No tool call of the trial failed with an INTERNAL error.',
        check: (f) => result(f.internal_errors === 0, plural(f.internal_errors, 'INTERNAL tool error')),
      },
      {
        id: 'M3',
        text: "The initial state hash equals the manifest's, and the replayed final state hash equals the final hash.",
        check: ({ state_hash: h, manifest_hash }) => {
          const replay = replayOk(h) ? `replay_final equals final ${h.final}` : `replay_final ${h.replay_final} is not final ${h.final}`;
          if (!replayOk(h) || h.initial === null) return result(false, `${h.initial === null ? 'no initial hash; ' : ''}${replay}`);
          if (manifest_hash === null) return result('pending', `no manifest hash to compare initial ${h.initial} with; ${replay}`);
          return result(h.initial === manifest_hash, `initial ${h.initial} ${h.initial === manifest_hash ? 'equals' : 'is not'} the manifest's ${manifest_hash}; ${replay}`);
        },
      },
      {
        id: 'M4',
        text: "The oracle and every alternative solution pass the grader on the trial's task_version.",
        check: ({ matrix, task_version }) => {
          if (matrix === null) return result('pending', 'no grader validation matrix result given');
          if (matrix.task_version !== task_version) return result('pending', `the matrix result is for task_version ${matrix.task_version}, the trial ran ${task_version}`);
          return result(matrix.oracle_pass && matrix.alternatives_pass, `oracle ${matrix.oracle_pass ? 'passes' : 'fails'}, alternatives ${matrix.alternatives_pass ? 'all pass' : 'do not all pass'} on ${task_version}`);
        },
      },
      {
        id: 'M5',
        text: "The human audit agrees that the failure is the model's, or an independent adjudication says model.",
        check: ({ audit, outcome }) => {
          if (audit === null) return result('pending', 'not human-audited');
          if (outcome === 'PASS') return result(audit.outcome === 'PASS', `audited ${audit.outcome}`);
          const adjudicated = audit.adjudication !== null && /\bmodel\b/i.test(audit.adjudication);
          const agrees = audit.label === 'model' && audit.model_fault === 'yes' && audit.llm_auditor_agrees !== false;
          const met = audit.label === 'model' && audit.model_fault !== 'no' && (agrees || adjudicated);
          return result(met, `labelled ${audit.label ?? 'none'}, model_fault ${audit.model_fault ?? 'none'}, LLM auditor ${audit.llm_auditor_agrees === false ? 'disagrees' : 'agrees'}${audit.adjudication === null ? '' : `, adjudication: ${audit.adjudication}`}`);
        },
      },
    ],
  },
  refusal: {
    sentence: 'A refusal is the model declining the task: the trial stays valid and counts as a model failure, reported with and without refusals in the denominator.',
    criteria: byOutcome('refusal', 'R'),
  },
  env: {
    sentence: 'The environment is at fault when a tool failed internally, the starting state was not the manifest, an environment invariant broke or the replay did not reproduce the final state.',
    criteria: [
      {
        id: 'E1',
        text: 'A tool call failed with an INTERNAL error inside the environment.',
        check: (f) => result(f.internal_errors > 0 || (f.status === 'ENV_ERROR' && f.detail === 'INTERNAL'), `${plural(f.internal_errors, 'INTERNAL tool error')}${f.detail === 'INTERNAL' ? ', ended ENV_ERROR INTERNAL' : ''}`),
      },
      {
        id: 'E2',
        text: "The initial state hash differs from the manifest's.",
        check: ({ detail, state_hash: h, manifest_hash }) =>
          result(detail === 'initial_hash_mismatch' || (manifest_hash !== null && h.initial !== null && h.initial !== manifest_hash), `initial ${h.initial}, manifest ${manifest_hash ?? 'not given'}`),
      },
      {
        id: 'E3',
        text: 'An environment invariant broke: the trial ended ENV_ERROR for a reason other than an INTERNAL error or a hash mismatch.',
        check: ({ status, detail }) => result(status === 'ENV_ERROR' && !ENV_DETAILS.includes(detail ?? ''), `status ${status}, detail ${detail}`),
      },
      {
        id: 'E4',
        text: 'The replayed final state hash differs from the final hash.',
        check: ({ detail, state_hash: h }) => result(detail === 'replay_mismatch' || (h.final !== null && h.replay_final !== h.final), `final ${h.final}, replay_final ${h.replay_final}`),
      },
    ],
  },
  grader: {
    sentence: 'The grader is at fault when a check threw, a regrade disagrees with the record, or a human audit finds a grader bug and shows the evidence.',
    criteria: [
      {
        id: 'GR1',
        text: 'A grader check threw while the trial was graded.',
        check: (f) => result(f.outcome === 'GRADER_ERROR' && !f.regraded && f.check_error?.check != null, f.check_error === null ? 'no grader error' : `check ${f.check_error.check}: ${f.check_error.message}`),
      },
      {
        id: 'GR2',
        text: 'A grade or regrade disagrees with the record: the world or replay it rebuilt is not the one the record names.',
        check: (f) => result(f.outcome === 'GRADER_ERROR' && (f.regraded || f.check_error?.check == null), `current outcome ${f.outcome}${f.regraded ? ', from a regrade' : ''}`),
      },
      {
        id: 'GR3',
        text: 'A human audit labels the trial GRADER_BUG and cites evidence ids.',
        check: ({ audit }) => result(audit !== null && audit.outcome === 'GRADER_BUG' && audit.evidence_ids.length > 0, audit === null ? 'not human-audited' : `audited ${audit.outcome}, ${plural(audit.evidence_ids.length, 'evidence id')}`),
      },
    ],
  },
  infra: {
    sentence: 'The infrastructure is at fault when the API, the harness, a substituted model or a stop from outside ended the trial, so it says nothing about the model.',
    criteria: byOutcome('infra', 'I'),
  },
};

export const PASS_DEFINITION = `A trial is a PASS when every gate check is met, the environment is clean and replay reproduces its final state; PASS is one of the ${VALID_OUTCOMES.length} valid outcomes.`;

export const DENOMINATOR_RULE = [
  `Only ${list(VALID_OUTCOMES)} count in the denominator, and every other outcome is excluded: ${list(RERUN_OUTCOMES)} are excluded and rerun (ENV_ERROR still counts raw against the env_error_raw requirement), and ${list(NEVER_RERUN)} ${NEVER_RERUN.length === 1 ? 'is' : 'are'} excluded and never rerun as a model trial: a GRADER_ERROR in a committed run is a grader bug that blocks the run until a grader fix and a full offline regrade.`,
  "`summary --require grader_error=0` checks each record's current grade after any offline regrade, so a regraded record counts by its new outcome; the summary prints grader_error_history (every GRADER_ERROR ever recorded, regraded ones included) for disclosure, and grader_error_history is never a require key.",
  'A refusal counts as a model failure inside the denominator.',
].join(' ');
