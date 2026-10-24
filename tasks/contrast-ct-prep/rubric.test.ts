// Two things the matrix does not show for T5. Every scripted case runs without a rejected tool
// call, so a mutant fails on the trap it names and not on a write the tools refused (a mistyped
// creatinine window once did exactly that). And message_dose_times takes a dose time from the
// pattern only with its day after it; a message the pattern cannot read goes to the judge.
// The diphenhydramine time counts only in diphenhydramine's own clause.
import { describe, expect, it } from 'vitest';
import { loadMatrixTask, matrixEnv } from '../../cli/matrix.ts';
import { cases, gradeRun, trial, type Miss } from '../../packages/grader/matrix/matrix.ts';
import { ORACLE_MESSAGE } from './solution/steps.ts';
import { antihistamineTimed, clockTimes } from './tests/rubric.ts';

const task = await loadMatrixTask('contrast-ct-prep');
const env = matrixEnv();

describe('contrast-ct-prep scripts', () => {
  it.each(cases(task).map((c) => [c.id, c] as const))('%s: no tool call is rejected', async (_id, c) => {
    const { events } = await trial(env, task, c);
    const errors = events.flatMap((e) => (e.type === 'tool_result' && e.is_error ? [{ name: e.name, content: e.content }] : []));
    expect(errors).toEqual([]);
  });
});

describe('message_dose_times', () => {
  it.each([
    ['8 PM Sunday', 20 * 60],
    ['8:00 p.m. on Sunday', 20 * 60],
    ['2am Monday', 2 * 60],
    ['at 02:00 on 10/26', 2 * 60],
    ['20:00 Sunday 10/25', 20 * 60],
    ['12:30 AM', 30],
  ])('reads %j as %i minutes', (s, minutes) => {
    expect(clockTimes(s).map((t) => t.minutes)).toContain(minutes);
  });

  it.each([
    ['the oracle message', ORACLE_MESSAGE, true],
    ['diphenhydramine on its own line', 'Diphenhydramine 50 mg at 8:00 a.m. on Monday 10/26.', true],
    ['the time before the drug', 'At 8:00 AM on Monday 10/26, take diphenhydramine (Benadryl) 50 mg.', true],
    // verifier-task-T5-2 s2-residual: one sentence gives prednisone 08:00 Monday and Benadryl at
    // bedtime; the 08:00 is prednisone's, so the pattern must not credit diphenhydramine.
    [
      'Benadryl at bedtime beside prednisone at 08:00',
      'Take prednisone 50 mg at 8:00 PM Sunday 10/25 and 2:00 AM Monday 10/26, then prednisone 50 mg at 8:00 AM Monday 10/26 and Benadryl 50 mg at bedtime.',
      false,
    ],
    ['Benadryl at bedtime first', 'Take Benadryl 50 mg at bedtime and prednisone 50 mg at 8:00 AM Monday 10/26.', false],
  ])('diphenhydramine timed in %s: %s', (_name, text, want) => {
    expect(antihistamineTimed(text)).toBe(want);
  });

  // Case id -> how the item is decided and whether it is met.
  const WANT: Record<string, { source: 'regex' | 'judge'; met: boolean }> = {
    oracle: { source: 'regex', met: true },
    tablet_counts_and_more_reads: { source: 'regex', met: true },
    times_in_words: { source: 'judge', met: true },
    overnight_date_slip: { source: 'judge', met: false },
    copied_2023_times: { source: 'judge', met: false },
    // pr-review-T5-1 S2: the prednisone times are all there, but diphenhydramine is at bedtime.
    antihistamine_at_bedtime: { source: 'judge', met: false },
    split_doses: { source: 'regex', met: true },
  };
  it.each(Object.entries(WANT))('%s: %o', async (id, want) => {
    const c = cases(task).find((x) => x.id === id);
    expect(c, `case ${id}`).toBeDefined();
    const misses: Miss[] = [];
    const grade = await gradeRun(env, task, task.checks, await trial(env, task, c!), misses);
    expect(misses).toEqual([]);
    const r = grade.checks.find((x) => x.id === 'message_dose_times');
    expect({ source: (r?.evidence as { source?: string }).source, met: r?.met }).toEqual(want);
  });
});
