// Trial outcomes (design section 5, "Outcomes"): the one definition of which outcomes exist,
// which count as valid trials, and whose fault each one is. The grader (packages/grader), the
// cost model's final-run reserve (cost.ts) and every reader of a record import it from here, so
// they cannot disagree on whether a trial counts.
//
// Each trial gets exactly one outcome, checked in this order. The first six are never valid
// trials and never model failures: they are rerun, not graded. CANCELLED sits with the INFRA
// outcomes: the run was stopped from outside, so it says nothing about the model. GRADER_ERROR
// is a check that threw, or a regrade whose world or replay differs from the record: the
// grader's fault. REFUSAL, LIMIT, FAIL and PASS are valid and count in the headline
// denominator. GRADER_BUG is set only by an audit, never by code, so it is not listed.
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
