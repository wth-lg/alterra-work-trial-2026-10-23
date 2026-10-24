// pnpm cli matrix (plan phase P9) on the toy task, offline. The matrix never makes a live call:
// with ANTHROPIC_API_KEY set to a sentinel and one toy judge cache entry deleted, it exits 1
// naming the missing item, and a fetch spy installed under the egress guard records no call.
// Each test runs only the case it needs; the full matrix is the CI step.
import { describe, expect, it, vi } from 'vitest';
import { installEgressGuard } from '../../packages/core/egress.ts';
import { gate } from '../../packages/grader/check.ts';
import { runMatrix, type MatrixOptions } from '../../packages/grader/matrix/matrix.ts';
import type { MatrixTask } from '../../packages/grader/matrix/types.ts';
import { fakeKey } from '../../scripts/test/helpers.ts';
import { loadMatrixTask, main, matrixEnv } from '../matrix.ts';

// Any call at all is a failure; the spy is the scope's fetch before the guard wraps it.
const fetchSpy = vi.fn(async () => new Response('{}', { status: 500 }));
globalThis.fetch = fetchSpy as unknown as typeof fetch;
installEgressGuard(globalThis);

const TOY = await loadMatrixTask('_toy');
const ONE: MatrixOptions = { trials: 1, regrades: 1, isolation: false };

async function matrix(task: Partial<MatrixTask>, options: MatrixOptions, env: Record<string, string | undefined> = {}) {
  const lines: string[] = [];
  const code = await main(['--task', '_toy'], { env: { ...process.env, ...env }, out: (l) => lines.push(l), load: async () => ({ ...TOY, ...task }), options });
  return { code, text: lines.join('\n') };
}

describe('matrix --task _toy', () => {
  it('exits 1 naming a judge cache miss, with a key in the environment and no call made', async () => {
    const [dropKey] = (await runMatrix(matrixEnv(), TOY, { ...ONE, cases: ['oracle'] })).results[0]!.grade.judge.cache_keys;
    const { code, text } = await matrix({ cache: TOY.cache.filter((e) => e.key !== dropKey) }, { ...ONE, cases: ['oracle'] }, { ANTHROPIC_API_KEY: fakeKey('S') });
    expect(code).toBe(1);
    expect(text).toMatch(/^judge cache: 1 miss;/m);
    expect(text).toContain(dropKey!);
    expect(text).toMatch(/^oracle: MISS judge cache misses /m);
    expect(text).not.toMatch(/judge\.unknown [1-9]/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('exits 1 naming the check when a case grades GRADER_ERROR', async () => {
    const boom = gate({ id: 'boom', category: 'process', traces_to: 'instruction.md:1', decisive_ids: [], fn: () => { throw new Error('planted'); } });
    const { code, text } = await matrix({ checks: [...TOY.checks, boom] }, { ...ONE, cases: ['spray'] });
    expect(code).toBe(1);
    expect(text).toMatch(/GRADER_ERROR in boom/);
  });
});
