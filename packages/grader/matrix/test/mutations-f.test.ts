// The matrix's own failure modes, part 6: a mutant's declared rubric losses (`loses`). A mutant
// must lose exactly the rubric items it declares (a positive item not met, a penalty met), so a
// regression that leaves the gates alone but changes what the rubric takes away still fails the
// matrix (verifier-phase-P10-3 M1).
import { describe, expect, it } from 'vitest';
import { matrix, ONE, TOY } from './harness.ts';

const mutant = (id: string) => {
  const m = TOY.mutants.find((x) => x.id === id);
  if (!m) throw new Error(`no toy mutant ${id}`);
  return m;
};
const replace = (m: ReturnType<typeof mutant>) => TOY.mutants.map((x) => (x.id === m.id ? m : x));

describe('matrix --task _toy, rubric losses', () => {
  it('passes when each mutant loses exactly what it declares', async () => {
    const { code, text } = await matrix({}, { ...ONE, cases: ['read_only', 'note_before_read'] });
    expect(text).toMatch(/mutant read_only .* lost \[states_note, note_names_user\] declared \[states_note, note_names_user\] ok/);
    expect(text).toMatch(/mutant note_before_read .* lost \[\] declared \[\] ok/);
    expect(code).toBe(0);
  });
  it('exits 1 when a mutant keeps a rubric item it declares lost, naming the item', async () => {
    const m = { ...mutant('note_before_read'), loses: ['states_note'] };
    const { code, text } = await matrix({ mutants: replace(m) }, { ...ONE, cases: [m.id] });
    expect(code).toBe(1);
    expect(text).toContain('mutant note_before_read: declares it loses rubric item states_note, which it keeps');
  });
  it('exits 1 when a mutant loses a rubric item it does not declare, naming the item', async () => {
    const m = { ...mutant('read_only'), loses: ['states_note'] };
    const { code, text } = await matrix({ mutants: replace(m) }, { ...ONE, cases: [m.id] });
    expect(code).toBe(1);
    expect(text).toContain('mutant read_only: loses rubric item note_names_user, not declared');
    expect(text).toMatch(/mutant read_only .* MISMATCH/);
  });
  it('exits 1 when loses names no rubric item of the task, without running a case', async () => {
    const m = { ...mutant('read_only'), loses: ['note_on_patient', 'no_such_item'] };
    const { code, text } = await matrix({ mutants: replace(m) }, { ...ONE, cases: [] });
    expect(code).toBe(1);
    expect(text).toContain('mutant read_only declares loses no_such_item, which is not a rubric item of the task');
    expect(text).toContain('mutant read_only declares loses note_on_patient, which is not a rubric item of the task');
  });
  it('counts the mutants that declare their losses', async () => {
    const [first, ...rest] = TOY.mutants;
    const undeclared = { ...first! };
    delete undeclared.loses;
    const { text } = await matrix({ mutants: [undeclared, ...rest] }, { ...ONE, cases: [] });
    expect(text).toContain(`rubric losses: ${rest.length}/${TOY.mutants.length} mutants declare loses`);
  });
  it('every toy mutant declares its losses', () => {
    expect(TOY.mutants.filter((m) => m.loses === undefined).map((m) => m.id)).toEqual([]);
  });
});
