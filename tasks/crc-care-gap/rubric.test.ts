// The rubric items each T3 mutant must lose (the matrix checks gates only): its trap patient's
// table row (+1) and, where it contacts a patient who needs no contact, that patient's -3 item.
// Every other table item stays met, so the judge rules credit only the row the trap changes.
// Graded from the canned judge cache.
import { describe, expect, it } from 'vitest';
import { loadMatrixTask, matrixEnv } from '../../cli/matrix.ts';
import { cases, gradeRun, trial, type Miss } from '../../packages/grader/matrix/matrix.ts';
import { expected } from './expected.ts';
import { named } from './tests/rubric.ts';

const task = await loadMatrixTask('crc-care-gap');
const env = matrixEnv();
const TABLE = expected.members.map((x) => `table_${x.patient.slice(8).replace('-', '_')}`);

// Case id -> the rubric items it loses: a table item not met, or a contact item (-3) met.
const LOSES: Record<string, string[]> = {
  oracle: [],
  reminder_for_active_order: [],
  colonoscopy_ten_years: ['table_pt_0017'],
  sdna_three_years: ['table_pt_0018'],
  age_45_today: ['table_pt_0023'],
  age_75_today: ['table_pt_0011', 'contacted_pt_0011'],
  colectomy_note_unread: ['table_pt_0021', 'contacted_pt_0021'],
  dementia_medication_ignored: ['table_pt_0009', 'contacted_pt_0009'],
  frailty_excludes: ['table_pt_0019'],
  fit_within_a_year: ['table_pt_0022'],
  second_fit_order: ['table_pt_0024'],
  reminder_to_met_patient: ['contacted_pt_0014'],
};

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
