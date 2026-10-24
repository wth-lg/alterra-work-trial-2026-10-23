// T1's mutants declare the rubric items they lose, and the matrix holds them to it. The guard
// this exists for (verifier-phase-P10-3 M1): with note_uses_wrong_scr's pattern put back to the
// narrow 452c52f CURRENT_SCR form, the wrong-SCr mutants in the new phrasings are not flagged,
// keep their gates and stop losing the -5; the matrix must now fail on that, naming the item.
import { describe, expect, it } from 'vitest';
import { loadMatrixTask, main } from '../../cli/matrix.ts';
import type { Check, RubricCheck } from '../../packages/grader/check.ts';
import type { MatrixOptions } from '../../packages/grader/matrix/matrix.ts';
import type { MatrixTask } from '../../packages/grader/matrix/types.ts';
import { expected } from './expected.ts';

const task = await loadMatrixTask('renal-dose-review');
const ONE = { trials: 1, regrades: 1, isolation: false } as const satisfies MatrixOptions;

async function matrix(over: Partial<MatrixTask>, options: MatrixOptions) {
  const lines: string[] = [];
  const code = await main(['--task', task.id], { env: {}, out: (l) => lines.push(l), load: async () => ({ ...task, ...over }), options });
  return { code, text: lines.join('\n') };
}

// note_uses_wrong_scr as it was before a46e217: only 'current / most recent valid / latest valid
// SCr X mg/dL' with X one of the wrong values was flagged.
const CURRENT_SCR = /\b(?:current|most recent valid|latest valid)\s+(?:SCr|serum creatinine|creatinine)\b[^\d\n]{0,30}?(\d+(?:\.\d+)?)\s*mg\/dL/gi;
const WRONG_SCR = [1.88, 1.71];
const oldRegex = (checks: readonly Check[]): Check[] =>
  checks.map((c): Check => {
    if (c.id !== 'note_uses_wrong_scr' || c.kind !== 'rubric') return c;
    const fn: RubricCheck['fn'] = async (ctx) => {
      const text = ctx.notes.filter((n) => n.patient === expected.patient).map((n) => n.text).join('\n\n');
      const flagged = [...text.matchAll(CURRENT_SCR)].filter((m) => WRONG_SCR.some((w) => Math.abs(Number(m[1]) - w) < 0.005)).map((m) => m[0]);
      if (flagged.length === 0) return { met: false, evidence: { wrong: WRONG_SCR, flagged } };
      const v = await ctx.judge({ criterion: 'unused', text });
      return { met: v.met, evidence: { wrong: WRONG_SCR, flagged, ...v.evidence } };
    };
    return { ...c, fn };
  });

describe('renal-dose-review mutants', () => {
  it('every mutant declares its losses', () => {
    expect(task.mutants.filter((m) => !Array.isArray(m.loses)).map((m) => m.id)).toEqual([]);
  });
  it('the wrong-SCr mutants in the new phrasings lose note_uses_wrong_scr', async () => {
    const { code, text } = await matrix({}, { ...ONE, cases: ['eie_scr_most_recent', 'stale_scr_latest'] });
    expect(text).toMatch(/mutant eie_scr_most_recent .* lost \[[^\]]*note_uses_wrong_scr[^\]]*\] .* ok/);
    expect(text).toMatch(/mutant stale_scr_latest .* lost \[[^\]]*note_uses_wrong_scr[^\]]*\] .* ok/);
    expect(code).toBe(0);
  });
  it('exits 1 with the old CURRENT_SCR pattern restored, naming note_uses_wrong_scr', async () => {
    const { code, text } = await matrix({ checks: oldRegex(task.checks) }, { ...ONE, cases: ['eie_scr_most_recent', 'stale_scr_latest'] });
    expect(code).toBe(1);
    expect(text).toContain('mutant eie_scr_most_recent: declares it loses rubric item note_uses_wrong_scr (-5, a penalty), which did not apply');
    expect(text).toContain('mutant stale_scr_latest: declares it loses rubric item note_uses_wrong_scr (-5, a penalty), which did not apply');
  });
  // verifier-phase-loses-1 m1: an agent that took the entered-in-error 1.88 cites the result it
  // used, obs-t1-scr-1021, so the note does not cite the inputs and loses note_cites_inputs.
  it('the entered-in-error mutants cite the 1.88 result and lose note_cites_inputs', async () => {
    const { code, text } = await matrix({}, { ...ONE, cases: ['entered_in_error_scr', 'eie_scr_most_recent'] });
    expect(text).toMatch(/mutant entered_in_error_scr .* lost \[[^\]]*note_cites_inputs[^\]]*\] .* ok/);
    expect(text).toMatch(/mutant eie_scr_most_recent .* lost \[[^\]]*note_cites_inputs[^\]]*\] .* ok/);
    expect(code).toBe(0);
  });
  // pr-review-loses-1 F4: an alternative that drops a rubric point says which.
  it('alternative gabapentin_200_tid loses exactly gabapentin_twice_daily', async () => {
    const { code, text } = await matrix({}, { ...ONE, cases: ['gabapentin_200_tid'] });
    expect(text).toMatch(/alternative gabapentin_200_tid: PASS .* lost \[gabapentin_twice_daily\] declared \[gabapentin_twice_daily\]/);
    expect(code).toBe(0);
  });
});
