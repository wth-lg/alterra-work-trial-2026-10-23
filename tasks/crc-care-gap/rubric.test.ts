// The rubric items each T3 mutant declares it loses (tests/mutants.ts `loses`), checked here
// until the matrix checks them itself: every other table item stays met, so the judge rules
// credit only the row the trap changes. Graded from the canned judge cache.
import { describe, expect, it } from 'vitest';
import { loadMatrixTask, matrixEnv } from '../../cli/matrix.ts';
import { cases, gradeRun, trial, type Miss } from '../../packages/grader/matrix/matrix.ts';
import { expected } from './expected.ts';
import { mutants } from './tests/mutants.ts';
import { named } from './tests/rubric.ts';

const task = await loadMatrixTask('crc-care-gap');
const env = matrixEnv();
const TABLE = expected.members.map((x) => `table_${x.patient.slice(8).replace('-', '_')}`);

// Case id -> the rubric items it loses: a table item not met, or a contact item (-3) met. The
// mutants declare theirs in tests/mutants.ts; the oracle and an alternative lose none.
const LOSES: Record<string, readonly string[]> = { oracle: [], reminder_for_active_order: [], ...Object.fromEntries(mutants.map((m) => [m.id, m.loses])) };

describe('crc-care-gap rubric', () => {
  it.each(Object.entries(LOSES))('%s loses %j', async (id, loses) => {
    const c = cases(task).find((x) => x.id === id);
    expect(c, `case ${id}`).toBeDefined();
    const misses: Miss[] = [];
    const grade = await gradeRun(env, task, task.checks, await trial(env, task, c!), misses);
    expect(misses).toEqual([]);
    const lost = grade.checks.filter((r) => (TABLE.includes(r.id) && r.met !== true) || (r.id.startsWith('contacted_') && r.met !== false)).map((r) => r.id).sort();
    expect(lost).toEqual([...loses].sort());
  });

  it.each([
    ["Harrison O’Keefe", 'Patient/pt-0019'],
    ['HARRISON OKEEFE', 'Patient/pt-0019'],
    ['Angela Vigil', 'Patient/pt-0021'],
    ['Pagac', 'Patient/pt-0014'],
    ['Okafor CRC 2026', null],
    ['Ángela Vigil', 'Patient/pt-0021'],
    ['Mrs. Vigil', 'Patient/pt-0021'],
  ])('finds the row of %j', (text, patient) => {
    const hit = expected.members.filter((x) => named(x, text)).map((x) => x.patient);
    expect(hit).toEqual(patient ? [patient] : []);
  });
});
