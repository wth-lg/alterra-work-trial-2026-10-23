// Helpers for `pnpm cli oracle --live-judge` tests (plan phase P9, builder-33 item 4): a mocked
// judge transport, a temp ledger and HOME, and the reduced toy the live tests grade.
import { join } from 'node:path';
import type { Transport } from '../../../core/anthropic.ts';
import type { JudgeCacheEntry } from '../../judge.ts';
import type { MatrixTask } from '../types.ts';
import { okResponse } from '../../../../apps/web/src/harness/scenarios.ts';
import { fakeKey, tempDir, write } from '../../../../scripts/test/helpers.ts';
import { main, type Deps } from '../../../../cli/oracle.ts';
import { TOY } from './harness.ts';

// The oracle, an alternative that shares its summary, and the null agent.
export const SMALL: MatrixTask = { ...TOY, alternatives: TOY.alternatives.filter((a) => a.id === 'one_answer'), mutants: [], agents: {} };

const seed = (cost: number) =>
  ['reserve', 'settle'].map((kind) => JSON.stringify({ ts: 't', call_id: 'seed', kind, source: 'node', run_id: null, batch_id: null, trial: null, usage: null, cost_usd: cost })).join('\n') + '\n';

// A judge that quotes the whole graded text with `verdict(text)`, counting each prompt it is asked.
export const judgeWith = (verdict: (text: string) => string): Transport & { calls: number; asked: Map<string, number> } => {
  const t = Object.assign(
    async (request: Request) => {
      t.calls++;
      const body = JSON.parse(await request.text()) as { messages: Array<{ content: string }> };
      const prompt = body.messages[0]!.content;
      const text = /<text>\n([\s\S]*)\n<\/text>/.exec(prompt)![1]!;
      t.asked.set(prompt, (t.asked.get(prompt) ?? 0) + 1);
      return okResponse({ text: JSON.stringify({ verdict: verdict(text), quote: text }) }, t.calls);
    },
    { calls: 0, asked: new Map<string, number>() },
  );
  return t;
};

// `oracle --task _toy --live-judge` on `task` with a mocked judge and a temp ledger holding $1.
export async function liveJudge(fetch: Transport, task: MatrixTask = SMALL) {
  const dir = tempDir('oracle-ledger');
  write(dir, 'spend.jsonl', seed(1));
  const lines: string[] = [];
  const written: Array<{ task: string; entries: JudgeCacheEntry[] }> = [];
  const deps: Deps = {
    env: { HOME: tempDir('oracle-home'), SPEND_LEDGER: join(dir, 'spend.jsonl'), ANTHROPIC_API_KEY: fakeKey('O') },
    out: (l) => lines.push(l),
    fetch,
    load: async () => task,
    writeCache: (t, entries) => written.push({ task: t, entries }),
  };
  const code = await main(['--task', '_toy', '--live-judge'], deps);
  return { code, written, ledger: join(dir, 'spend.jsonl'), text: lines.join('\n') };
}

