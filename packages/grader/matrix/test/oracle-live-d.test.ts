// `pnpm cli oracle --live-judge` (plan phase P9, builder-33 item 4): the cache it writes from the
// live judge's answers is one the offline matrix grades the oracle from with no miss, and the
// matrix prints its source. Graded on the toy's oracle and null agent only, so it stays fast.
import { expect, it } from 'vitest';
import { matrix, TOY } from './harness.ts';
import { judgeWith, liveJudge } from './oracle-harness.ts';

it('the offline matrix passes on the cache the live judge wrote, and prints its source', async () => {
  const { code, written, text } = await liveJudge(judgeWith(() => 'met'), { ...TOY, alternatives: [], mutants: [], agents: {} });
  expect(code, text).toBe(0);
  const { entries } = written[0]!;
  // The oracle's summary and the null agent's, each with 2 judge items.
  expect(entries).toHaveLength(4);
  const cache = [...entries, ...TOY.cache.filter((e) => !entries.some((x) => x.key === e.key))];
  const offline = await matrix({ cache }, { trials: 1, regrades: 1, isolation: false, cases: ['oracle'] });
  expect(offline.text).toMatch(/^judge cache: 0 misses; source live 4, scripted 1[0-9]$/m);
  expect(offline.text).toContain('oracle: PASS score 1.000 judge.unknown 0');
  expect(offline.code).toBe(0);
});
