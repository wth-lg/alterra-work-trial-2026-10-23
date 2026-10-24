// One definition of a valid trial (design section 5, "Outcomes"): the grader, the cost model
// and the final-run reserve read validity and fault from packages/core/outcomes.ts, so they
// cannot disagree on whether a trial counts.
import { describe, expect, it } from 'vitest';
import { FINAL_TRIALS_PER_TASK, finalReserve, isValidTrial } from '../../core/cost.ts';
import { FAULT, isValid as coreIsValid, OUTCOMES, VALID_OUTCOMES } from '../../core/outcomes.ts';
import { isValid } from '../outcome.ts';

describe('outcomes', () => {
  it.each(OUTCOMES)('%s: the cost model and the grader agree on validity', (o) => {
    expect(isValidTrial(o)).toBe(isValid(o));
    expect(isValidTrial(o)).toBe(coreIsValid(o));
    expect(isValidTrial(o)).toBe(VALID_OUTCOMES.includes(o));
  });

  it('only REFUSAL, LIMIT, FAIL and PASS are valid; an unknown or missing outcome is not', () => {
    expect(OUTCOMES.filter((o) => isValidTrial(o))).toEqual(['REFUSAL', 'LIMIT', 'FAIL', 'PASS']);
    for (const o of [undefined, '', 'INFRA', 'pass', 'GRADER_BUG']) expect(isValidTrial(o)).toBe(false);
  });

  it('every outcome has one fault: model, refusal, env, grader or infra (PASS none)', () => {
    expect(FAULT).toEqual({
      INVALID: 'infra', INFRA_HARNESS: 'infra', INFRA_API: 'infra', CANCELLED: 'infra',
      ENV_ERROR: 'env', GRADER_ERROR: 'grader', REFUSAL: 'refusal', LIMIT: 'model', FAIL: 'model', PASS: null,
    });
  });

  it('INFRA_API, INFRA_HARNESS, CANCELLED, INVALID, ENV_ERROR and GRADER_ERROR records do not count toward the 10 valid final trials', () => {
    const invalid = ['INFRA_API', 'INFRA_HARNESS', 'CANCELLED', 'INVALID', 'ENV_ERROR', 'GRADER_ERROR'];
    const finalTrials = [...invalid, ...invalid].map((outcome) => ({ task_id: 'T1', outcome }));
    const none = finalReserve({ plannedTasks: ['T1'], observations: [], finalTrials, auditorDone: true });
    expect(none.lines.find((l) => l.task_id === 'T1')?.trials).toBe(FINAL_TRIALS_PER_TASK);
    const two = finalReserve({ plannedTasks: ['T1'], observations: [], finalTrials: [...finalTrials, { task_id: 'T1', outcome: 'PASS' }, { task_id: 'T1', outcome: 'REFUSAL' }], auditorDone: true });
    expect(two.lines.find((l) => l.task_id === 'T1')?.trials).toBe(FINAL_TRIALS_PER_TASK - 2);
  });
});
