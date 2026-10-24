// `pnpm cli oracle --live-judge` (plan phase P9, builder-33 item 4) asks the judge through one
// Judge across the task's cases, so a question two cases share is asked once; each written cache
// entry records provenance {source: 'live', model, at}; and the offline matrix passes on it.
// The transport is a mock and the ledger a temp file.
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { MODEL } from '../../../core/anthropic.ts';
import { matrix, TOY } from './harness.ts';
import { judgeWith, liveJudge } from './oracle-harness.ts';

it('asks each distinct question once, records provenance, and the offline matrix passes on the cache', async () => {
  const judge = judgeWith(() => 'met');
  const { code, written, ledger, text } = await liveJudge(judge);
  expect(code, text).toBe(0);
  expect(written).toHaveLength(1);
  const { entries } = written[0]!;
  // oracle and one_answer share a summary: 2 distinct summaries x 2 judge items.
  expect(judge.calls).toBe(4);
  expect([...judge.asked.values()].every((n) => n === 1)).toBe(true);
  expect(entries).toHaveLength(4);
  for (const e of entries) {
    expect(e.answer?.verdict).toBe('met');
    expect(e.calls).toBe(1);
    expect(e.provenance).toMatchObject({ source: 'live', model: MODEL });
    expect(Number.isNaN(Date.parse(e.provenance!.at))).toBe(false);
  }
  const rows = readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string; call_id: string });
  expect(rows.filter((r) => r.kind === 'settle' && r.call_id !== 'seed')).toHaveLength(judge.calls);

  const offline = await matrix({ cache: [...entries, ...TOY.cache.filter((e) => !entries.some((x) => x.key === e.key))] }, { trials: 1, regrades: 1, isolation: false, cases: ['one_answer'] });
  expect(offline.text).toMatch(/^judge cache: 0 misses; source live 4, scripted 10$/m);
  expect(offline.code).toBe(0);
});
