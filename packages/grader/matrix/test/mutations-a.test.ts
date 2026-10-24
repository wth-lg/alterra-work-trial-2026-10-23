// The matrix's own failure modes, part 1 (plan phase P9): each broken input alone makes
// `matrix --task _toy` exit 1 and say why. Each test runs only the cases its assertion needs
// (none for a count or a trap, one for a case's verdict), with one trial and one grade.
import { describe, expect, it } from 'vitest';
import { cases, runMatrix } from '../matrix.ts';
import { matrixEnv } from '../../../../cli/matrix.ts';
import { matrix, ONE, TOY } from './harness.ts';

describe('matrix options', () => {
  it('runs only the cases asked for, once each, with one grade', async () => {
    const r = await runMatrix(matrixEnv(), TOY, { ...ONE, cases: ['oracle'] });
    expect(r.results.map((x) => x.case.id)).toEqual(['oracle']);
    expect(r.lines).toContain('replay determinism: not run (1 trial per case)');
    expect(r.pass).toBe(true);
  });
  it('rejects a case id the task does not have', async () => {
    await expect(runMatrix(matrixEnv(), TOY, { ...ONE, cases: ['no_such_case'] })).rejects.toThrow(/no case no_such_case/);
  });
});

describe('matrix --task _toy exits 1', () => {
  it('with fewer than 4 mutants, naming the trap left without one, without running a case', async () => {
    const { code, text } = await matrix({ mutants: TOY.mutants.slice(0, 1) }, { ...ONE, cases: [] });
    expect(code).toBe(1);
    expect(text).toContain('mutants: n=1 (min 4)');
    expect(text).toMatch(/trap \S+ has no mutant/);
  });
  it('with fewer than 3 alternatives', async () => {
    const { code, text } = await matrix({ alternatives: TOY.alternatives.slice(0, 2) }, { ...ONE, cases: [] });
    expect(code).toBe(1);
    expect(text).toContain('2 alternatives, need 3');
  });
  it('when a mutant declares the wrong check set', async () => {
    const [first, ...rest] = TOY.mutants;
    const { code, text } = await matrix({ mutants: [{ ...first!, fails: ['no_such_check'] }, ...rest] }, { ...ONE, cases: [first!.id] });
    expect(code).toBe(1);
    expect(text).toMatch(new RegExp(`mutant ${first!.id} .*MISMATCH`));
  });
  it('every case kind is in the report order', () => {
    expect(cases(TOY).map((c) => c.kind)).toEqual(['oracle', 'alternative', 'alternative', 'alternative', 'mutant', 'mutant', 'mutant', 'mutant', 'mutant', 'null', 'spray', 'output-gap']);
  });
});
