// The matrix's own failure modes, part 4 (plan phase P9, builder-33 item 9): an alternative whose
// judge item is unknown fails the matrix, as the oracle's does.
import { describe, expect, it } from 'vitest';
import { matrixEnv } from '../../../../cli/matrix.ts';
import { runMatrix } from '../matrix.ts';
import { matrix, ONE, TOY } from './harness.ts';

const metToUnknown = (keys?: Set<string>) =>
  TOY.cache.map((e) => (e.answer?.verdict === 'met' && (keys === undefined || keys.has(e.key)) ? { ...e, answer: { ...e.answer, verdict: 'unknown' } } : e));

describe('matrix --task _toy exits 1', () => {
  it("when an alternative's judge item is unknown, not only the oracle's (item 9)", async () => {
    const alt = TOY.alternatives.find((a) => a.id === 'extra_reads_typed_reference')!;
    const [oracle, other] = (await runMatrix(matrixEnv(), TOY, { ...ONE, cases: ['oracle', alt.id] })).results;
    const oracleKeys = new Set(oracle!.grade.judge.cache_keys);
    const altKeys = new Set(other!.grade.judge.cache_keys);
    const only = new Set([...altKeys].filter((k) => !oracleKeys.has(k)));
    expect(only.size).toBeGreaterThan(0);
    const { code, text } = await matrix({ cache: metToUnknown(only) }, { ...ONE, cases: [alt.id] });
    expect(code).toBe(1);
    expect(text).toMatch(new RegExp(`- alternative ${alt.id}: judge\\.unknown [1-9]`));
  });
});
