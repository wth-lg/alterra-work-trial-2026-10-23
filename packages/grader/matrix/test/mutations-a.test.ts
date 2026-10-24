// The matrix's own failure modes, part 1 (plan phase P9): each broken input alone makes
// `matrix --task _toy` exit 1 and say why. Split from cli/test/matrix-offline.test.ts so the
// full-matrix runs spread over test workers.
import { describe, expect, it } from 'vitest';
import type { MatrixTask } from '../types.ts';
import { loadMatrixTask, main } from '../../../../cli/matrix.ts';

const TOY = await loadMatrixTask('_toy');

async function matrix(task: Partial<MatrixTask> = {}, env: Record<string, string | undefined> = {}) {
  const lines: string[] = [];
  const code = await main(['--task', '_toy'], { env: { ...process.env, ...env }, out: (l) => lines.push(l), load: async () => ({ ...TOY, ...task }) });
  return { code, text: lines.join('\n') };
}

describe('matrix --task _toy exits 1', () => {
  it('exits 1 with fewer than 4 mutants, and names the trap left without one', async () => {
    const { code, text } = await matrix({ mutants: TOY.mutants.slice(0, 1) });
    expect(code).toBe(1);
    expect(text).toContain('mutants: n=1 (min 4)');
    expect(text).toMatch(/trap \S+ has no mutant/);
  });
  it('exits 1 when a mutant declares the wrong check set', async () => {
    const [first, ...rest] = TOY.mutants;
    const { code, text } = await matrix({ mutants: [{ ...first!, fails: ['no_such_check'] }, ...rest] });
    expect(code).toBe(1);
    expect(text).toMatch(new RegExp(`mutant ${first!.id} .*MISMATCH`));
  });
  it('exits 1 when an oracle judge item is unknown', async () => {
    const cache = TOY.cache.map((e) => (e.answer?.verdict === 'met' ? { ...e, answer: { ...e.answer, verdict: 'unknown' } } : e));
    const { code, text } = await matrix({ cache });
    expect(code).toBe(1);
    expect(text).toMatch(/^oracle: PASS score \S+ judge\.unknown [1-9]/m);
  });
});
