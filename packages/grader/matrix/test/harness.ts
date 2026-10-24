// Runs `matrix --task _toy` on the toy with some inputs changed and only the cases a test needs,
// so each assertion costs one or two scripted trials, not the whole matrix (the full matrix is
// the CI step `pnpm cli matrix --task _toy`).
import { loadMatrixTask, main } from '../../../../cli/matrix.ts';
import type { MatrixOptions } from '../matrix.ts';
import type { Check } from '../../check.ts';
import type { MatrixTask } from '../types.ts';

export const TOY = await loadMatrixTask('_toy');

export async function matrix(task: Partial<MatrixTask> = {}, options: MatrixOptions = {}, env: Record<string, string | undefined> = {}) {
  const lines: string[] = [];
  const code = await main(['--task', '_toy'], { env: { ...process.env, ...env }, out: (l) => lines.push(l), load: async () => ({ ...TOY, ...task }), options });
  return { code, text: lines.join('\n') };
}

// The cheapest options: one trial, one grade, no fresh-process grade.
export const ONE = { trials: 1, regrades: 1, isolation: false } as const satisfies MatrixOptions;

// Runs `cases` with the isolation check on, grading with a planted checks module, and returns the
// report. One case is graded twice in a row in-process; with the oracle and another case the
// order is the oracle, the case, the oracle, then that reversed.
export async function isolationRun(checksModule: string, cases: readonly string[] = ['oracle']) {
  const { checks } = (await import(checksModule)) as { checks: Check[] };
  return matrix({ checks, checksModule }, { cases, trials: 1 });
}
