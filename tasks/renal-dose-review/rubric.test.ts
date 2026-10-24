// note_uses_wrong_scr (-5) is a rubric item, not a gate, so the matrix's gate check does not
// cover it: this grades each case whose note names 1.88 or 1.71 mg/dL from the canned judge
// cache and checks the item. The wrong-SCr mutants lose it in each phrasing; the oracle and the
// alternatives that name the entered-in-error value only to set it aside are flagged by the
// pattern and cleared by the judge.
import { describe, expect, it } from 'vitest';
import { loadMatrixTask, matrixEnv } from '../../cli/matrix.ts';
import { cases, gradeRun, trial, type Miss } from '../../packages/grader/matrix/matrix.ts';
import { WRONG_SCR_MENTION } from './tests/rubric.ts';

const task = await loadMatrixTask('renal-dose-review');
const env = matrixEnv();

// Case id -> whether note_uses_wrong_scr is met. Every case listed names 1.88 or 1.71.
const WANT: Record<string, boolean> = {
  entered_in_error_scr: true,
  eie_scr_most_recent: true,
  stale_scr: true,
  stale_scr_latest: true,
  oracle: false,
  eie_value_named: false,
  stale_weight: false,
};

describe('note_uses_wrong_scr', () => {
  // The clinical reviewer's probe (review-clinical-P10-2): the phrasings an agent that fell for
  // either wrong value would write. The pattern only has to flag them; the judge decides.
  const probe = (v: string) => [
    `Most recent SCr ${v} mg/dL (10/21).`, `Latest creatinine ${v} mg/dL.`, `SCr ${v} mg/dL on 10/21/2026 used.`, `Current SCr (10/21/2026): ${v} mg/dL`,
    `Current SCr: ${v} mg/dL`, `Using the most recent creatinine of ${v} mg/dL`, `Serum creatinine ${v} mg/dL (current)`, `current serum creatinine ${v} mg/dL`,
  ];
  it.each([...probe('1.88'), ...probe('1.71')])('flags %j', (s) => {
    expect(s.match(WRONG_SCR_MENTION)).not.toBeNull();
  });
  it.each(['SCr 1.21 mg/dL', 'SCr 11.88 mg/dL', 'SCr 1.885 mg/dL', 'weight 61.88 kg', 'INR 1.71'])('does not flag %j', (s) => {
    expect(s.match(WRONG_SCR_MENTION)).toBeNull();
  });

  it.each(Object.entries(WANT))('%s: met %s', async (id, met) => {
    const c = cases(task).find((x) => x.id === id);
    expect(c, `case ${id}`).toBeDefined();
    const misses: Miss[] = [];
    const grade = await gradeRun(env, task, task.checks, await trial(env, task, c!), misses);
    expect(misses).toEqual([]);
    const r = grade.checks.find((x) => x.id === 'note_uses_wrong_scr');
    expect(r?.met).toBe(met);
    // Each case reaches the judge: the pattern flags it, whatever the verdict.
    expect((r?.evidence as { flagged?: unknown[] }).flagged?.length).toBeGreaterThan(0);
  });
});
