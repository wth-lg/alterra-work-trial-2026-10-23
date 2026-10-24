// The matrix's own failure modes, part 3 (plan phase P9): the oracle's judge answers. Each test
// runs the oracle alone, once, with one grade.
import { describe, expect, it } from 'vitest';
import { matrix, ONE, TOY } from './harness.ts';

const metToUnknown = (keys?: Set<string>) =>
  TOY.cache.map((e) => (e.answer?.verdict === 'met' && (keys === undefined || keys.has(e.key)) ? { ...e, answer: { ...e.answer, verdict: 'unknown' } } : e));

describe('matrix --task _toy exits 1', () => {
  it('when an oracle judge item is unknown', async () => {
    const { code, text } = await matrix({ cache: metToUnknown() }, { ...ONE, cases: ['oracle'] });
    expect(code).toBe(1);
    expect(text).toMatch(/^oracle: PASS score \S+ judge\.unknown [1-9]/m);
  });
  it('on a judge cache miss, the oracle line says MISS with the missed items, not PASS (item 7)', async () => {
    const { code, text } = await matrix({ cache: [] }, { ...ONE, cases: ['oracle'] });
    expect(code).toBe(1);
    expect(text).toMatch(/^oracle: MISS judge cache misses states_note, summary_names$/m);
    expect(text).not.toMatch(/^oracle: PASS/m);
  });
});
