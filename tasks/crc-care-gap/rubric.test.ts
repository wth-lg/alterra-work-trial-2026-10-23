// The rubric items each T3 mutant declares it loses (tests/mutants.ts `loses`), checked here
// until the matrix checks them itself: every other table item stays met, so the judge rules
// credit only the row the trap changes. Graded from the canned judge cache.
import { describe, expect, it } from 'vitest';
import { loadMatrixTask, matrixEnv } from '../../cli/matrix.ts';
import { stepsOf } from '../../packages/grader/exposure.ts';
import { cases, gradeRun, trial, type Miss } from '../../packages/grader/matrix/matrix.ts';
import { expected } from './expected.ts';
import { alternatives, pendingExposure } from './tests/alternatives.ts';
import { mutants } from './tests/mutants.ts';
import { named } from './tests/rubric.ts';

const task = await loadMatrixTask('crc-care-gap');
const env = matrixEnv();

// Case id -> the rubric items it loses: a table item not met, or a penalty (-3) met. The
// mutants and alternatives declare theirs in tests/; the oracle loses none.
const LOSES: Record<string, readonly string[]> = {
  oracle: [],
  ...Object.fromEntries(alternatives.map((a) => [a.id, a.loses ?? []])),
  ...Object.fromEntries(mutants.map((m) => [m.id, m.loses])),
};

// The resources each member's status rests on, which the oracle must read in full (exposed, not
// only referenced by a search row) before it finishes: the table must rest on what it saw.
const DECIDING: Record<string, readonly string[]> = {
  'Patient/pt-0009': ['Condition/cond-t3-e7-frailty', 'MedicationRequest/mr-t3-e7-donepezil'],
  'Patient/pt-0011': ['Patient/pt-0011'],
  'Patient/pt-0014': ['Procedure/proc-t3-e1-colonoscopy'],
  'Patient/pt-0020': ['EpisodeOfCare/eoc-t3-e9-hospice'],
  'Patient/pt-0021': ['DocumentReference/doc-t3-e6-opnote'],
  'Patient/pt-0024': ['ServiceRequest/sr-t3-e11-fit'],
  'Patient/pt-0025': ['Procedure/proc-t3-e12-ctc'],
  ...Object.fromEntries(expected.members.filter((x) => x.decisive.length).map((x) => [x.patient, x.decisive])),
};

describe('crc-care-gap rubric', () => {
  it.each(Object.entries(LOSES))('%s loses %j', async (id, loses) => {
    const c = cases(task).find((x) => x.id === id);
    expect(c, `case ${id}`).toBeDefined();
    const misses: Miss[] = [];
    const grade = await gradeRun(env, task, task.checks, await trial(env, task, c!), misses);
    expect(misses).toEqual([]);
    const lost = grade.checks.filter((r) => r.kind === 'rubric' && ((r.points! > 0 && r.met !== true) || (r.points! < 0 && r.met !== false))).map((r) => r.id).sort();
    expect(lost).toEqual([...loses].sort());
  });

  it('the oracle exposes every resource a member\'s status rests on', async () => {
    const oracle = cases(task).find((x) => x.id === 'oracle')!;
    const steps = stepsOf((await trial(env, task, oracle)).events);
    const exposed = new Set(steps.flatMap((s) => s.exposed_ids));
    expect(Object.keys(DECIDING).sort()).toEqual(expected.members.map((x) => x.patient).sort());
    expect(Object.values(DECIDING).flat().filter((id) => !exposed.has(id))).toEqual([]);
  });

  // Until the exposure PR tags search_patients rows as exposing the Patient, G4 sees E4's birth
  // date only as referenced: the case may fail gap_seen_before_order on E4 and nothing else.
  // When it passes, move it into `alternatives`.
  it('E4 read through search_patients fails at most G4 on her birth date', async () => {
    const run = await trial(env, task, { kind: 'alternative', id: pendingExposure.id, script: pendingExposure.script });
    expect(stepsOf(run.events).some((s) => s.tool === 'search_patients' && s.referenced_ids.includes('Patient/pt-0023'))).toBe(true);
    const misses: Miss[] = [];
    const grade = await gradeRun(env, task, task.checks, run, misses);
    expect(misses).toEqual([]);
    const failed = grade.checks.filter((r) => r.kind === 'gate' && r.met === false);
    if (grade.outcome === 'PASS') expect(failed).toEqual([]);
    else expect(failed.map((r) => [r.id, r.evidence.late])).toEqual([['gap_seen_before_order', ['Patient/pt-0023']]]);
    expect(grade.score).toBe(1);
  });

  it.each([
    ["Harrison O’Keefe", 'Patient/pt-0019'],
    ['HARRISON OKEEFE', 'Patient/pt-0019'],
    ['Angela Vigil', 'Patient/pt-0021'],
    ['Pagac', 'Patient/pt-0014'],
    ['Okafor CRC 2026', null],
    ['Ángela Vigil', 'Patient/pt-0021'],
    ['Mrs. Vigil', 'Patient/pt-0021'],
    ['| pt-0017 | Open gap |', 'Patient/pt-0017'],
    ['Patient/pt-0023', 'Patient/pt-0023'],
    ['pt-00170', null],
  ])('finds the row of %j', (text, patient) => {
    const hit = expected.members.filter((x) => named(x, text)).map((x) => x.patient);
    expect(hit).toEqual(patient ? [patient] : []);
  });
});
