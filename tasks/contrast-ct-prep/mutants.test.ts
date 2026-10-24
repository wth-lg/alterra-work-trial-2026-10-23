// T5's mutants and alternatives declare the rubric items they lose, and this holds them to it
// until the branch has wth-lg/p11-matrix-loses, whose matrix checks the same. A mutant fails
// exactly the gates it declares and loses exactly its items; an alternative passes and loses only
// what it declares. Lost: a positive item not met, or a penalty met.
import { describe, expect, it } from 'vitest';
import { loadMatrixTask, matrixEnv } from '../../cli/matrix.ts';
import { cases, gradeRun, trial, type Miss } from '../../packages/grader/matrix/matrix.ts';
import { alternatives } from './tests/alternatives.ts';
import { mutants } from './tests/mutants.ts';

const task = await loadMatrixTask('contrast-ct-prep');
const env = matrixEnv();

async function grade(id: string) {
  const c = cases(task).find((x) => x.id === id);
  expect(c, `case ${id}`).toBeDefined();
  const misses: Miss[] = [];
  const g = await gradeRun(env, task, task.checks, await trial(env, task, c!), misses);
  expect(misses).toEqual([]);
  const failed = g.checks.filter((x) => x.kind === 'gate' && !x.met).map((x) => x.id);
  const lost = g.checks.filter((x) => x.kind === 'rubric' && ((x.points ?? 0) > 0 ? !x.met : x.met)).map((x) => x.id);
  return { outcome: g.outcome, failed: failed.sort(), lost: lost.sort() };
}

describe('contrast-ct-prep cases', () => {
  it.each(mutants.map((m) => [m.id, m] as const))('mutant %s fails and loses what it declares', async (id, m) => {
    expect(await grade(id)).toEqual({ outcome: 'FAIL', failed: [...m.fails].sort(), lost: [...m.loses].sort() });
  });
  it.each(alternatives.map((a) => [a.id, a] as const))('alternative %s passes and loses what it declares', async (id, a) => {
    expect(await grade(id)).toEqual({ outcome: 'PASS', failed: [], lost: [...a.loses].sort() });
  });
});
