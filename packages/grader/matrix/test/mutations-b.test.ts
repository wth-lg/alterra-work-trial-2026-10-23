// The matrix's own failure modes, part 2 (plan phase P9): each broken input alone makes
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
  it('passes, printing oracle 1.0 with judge.unknown 0 and every count', async () => {
    const { code, text } = await matrix();
    expect(text).toContain('oracle: PASS score 1.000 judge.unknown 0');
    expect(Number(/alternatives: n=(\d+)/.exec(text)?.[1])).toBeGreaterThanOrEqual(3);
    expect(Number(/mutants: n=(\d+)/.exec(text)?.[1])).toBeGreaterThanOrEqual(4);
    expect(text).not.toMatch(/^ {2}alternative .*: (?!PASS)/m);
    expect(text).not.toMatch(/^ {2}mutant .* (MISMATCH|not FAIL)/m);
    for (const agent of ['null', 'spray', 'output-gap']) expect(text).toMatch(new RegExp(`^${agent}: FAIL`, 'm'));
    expect(text).toMatch(/^double derivation: equal/m);
    expect(text).toMatch(/^regrade idempotence: (\d+)\/\1 /m);
    expect(text).toMatch(/^replay determinism: (\d+)\/\1 /m);
    expect(text).toMatch(/^traceability: (\d+)\/\1 /m);
    expect(text).toMatch(/^judge cache: 0 misses/m);
    expect(text).toMatch(/^matrix _toy: PASS$/m);
    expect(code).toBe(0);
  });
  it('exits 1 when a check traces to no line of the prompt or a policy', async () => {
    const [first, ...rest] = TOY.checks;
    const { code, text } = await matrix({ checks: [{ ...first!, traces_to: 'instruction.md:99' }, ...rest] });
    expect(code).toBe(1);
    expect(text).toMatch(new RegExp(`traceability: .*${first!.id}`));
  });
  it('exits 1 when expected.ts and policy.ts disagree', async () => {
    const { code, text } = await matrix({ expected: { changed: true } });
    expect(code).toBe(1);
    expect(text).toMatch(/^double derivation: DIFFER/m);
  });
  it('exits 1 when the task declares a status-only case and has no status-only agent', async () => {
    const { status_only: _none, ...agents } = TOY.agents;
    const { code, text } = await matrix({ declares: { ...TOY.declares, status_only: true }, agents });
    expect(code).toBe(1);
    expect(text).toMatch(/^status-only: .*declared/m);
  });
});
