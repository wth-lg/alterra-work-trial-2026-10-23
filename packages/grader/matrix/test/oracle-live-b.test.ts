// `pnpm cli oracle --live-judge` (plan phase P9, builder-33 item 4) writes the cache only after
// the oracle passes on the live answers: a judge that answers unknown leaves the oracle with
// judge.unknown > 0, and the command exits 1 writing nothing. The transport is a mock and the
// ledger a temp file.
import { expect, it } from 'vitest';
import { TOY } from './harness.ts';
import { judgeWith, liveJudge } from './oracle-harness.ts';

it('writes no cache when the oracle does not pass on the live answers', async () => {
  const { code, written, text } = await liveJudge(judgeWith(() => 'unknown'), { ...TOY, alternatives: [], mutants: [], agents: {} });
  expect(code).toBe(1);
  expect(written).toHaveLength(0);
  expect(text).toMatch(/^oracle _toy: PASS score \S+ judge\.unknown 2$/m);
  expect(text).toContain('no cache written');
});
