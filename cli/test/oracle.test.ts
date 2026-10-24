// pnpm cli oracle (plan phase P9): offline it grades each task's oracle from the canned judge
// cache; --live-judge asks the judge live through a client only batchStart can create, and
// --dry-run prints the projection and opens nothing. Every live path here is mocked: the
// transport is a spy, and each ledger is a temp file.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { Transport } from '../../packages/core/anthropic.ts';
import type { JudgeCacheEntry } from '../../packages/grader/judge.ts';
import { okResponse } from '../../apps/web/src/harness/scenarios.ts';
import { fakeKey, tempDir, write } from '../../scripts/test/helpers.ts';
import { loadMatrixTask, main as matrixMain } from '../matrix.ts';
import { main, type Deps } from '../oracle.ts';

const seed = (cost: number) =>
  ['reserve', 'settle'].map((kind) => JSON.stringify({ ts: 't', call_id: 'seed', kind, source: 'node', run_id: null, batch_id: null, trial: null, usage: null, cost_usd: cost })).join('\n') + '\n';

// A judge that says met and quotes the whole graded text.
const metJudge = (): Transport & { calls: number } => {
  const t = Object.assign(
    async (request: Request) => {
      t.calls++;
      const body = JSON.parse(await request.text()) as { messages: Array<{ content: string }> };
      const text = /<text>\n([\s\S]*)\n<\/text>/.exec(body.messages[0]!.content)![1]!;
      return okResponse({ text: JSON.stringify({ verdict: 'met', quote: text }) }, t.calls);
    },
    { calls: 0 },
  );
  return t;
};

function harness(env: Record<string, string | undefined> = {}, fetch: Transport = vi.fn<Transport>()) {
  const home = tempDir('oracle-home');
  const lines: string[] = [];
  const written: Array<{ task: string; entries: JudgeCacheEntry[] }> = [];
  const deps: Deps = {
    env: { HOME: home, ...env },
    out: (l) => lines.push(l),
    fetch,
    writeCache: (task, entries) => written.push({ task, entries }),
  };
  return { deps, lines, written, home, text: () => lines.join('\n') };
}

describe('oracle', () => {
  it('--task _toy --json grades the oracle from the canned cache: PASS, score 1, no unknown', async () => {
    const h = harness();
    expect(await main(['--task', '_toy', '--json'], h.deps)).toBe(0);
    expect(JSON.parse(h.text())).toEqual({ tasks: [{ id: '_toy', outcome: 'PASS', score: 1, judge_unknown: 0, misses: [] }] });
  });

  it('--live-judge --dry-run prints the projection and opens no ledger', async () => {
    const h = harness();
    expect(await main(['--task', '_toy', '--live-judge', '--dry-run'], h.deps)).toBe(0);
    expect(h.text()).toMatch(/^LIVE_PROJECTION_USD=\d+\.\d{6}$/m);
    expect(existsSync(join(h.home, '.chartr'))).toBe(false);
    expect(h.written).toHaveLength(0);
  });

  it('--live-judge with ledger + projection = $450.01 is refused with 0 calls and writes no cache', async () => {
    const dry = harness();
    await main(['--task', '_toy', '--live-judge', '--dry-run'], dry.deps);
    const projection = Number(/^LIVE_PROJECTION_USD=(\S+)$/m.exec(dry.text())![1]);
    const dir = tempDir('oracle-ledger');
    write(dir, 'spend.jsonl', seed(Number((450.01 - projection).toFixed(6))));
    const fetch = vi.fn<Transport>();
    const h = harness({ SPEND_LEDGER: join(dir, 'spend.jsonl'), ANTHROPIC_API_KEY: fakeKey('O') }, fetch);
    expect(await main(['--task', '_toy', '--live-judge'], h.deps)).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(h.text()).toMatch(/projected cap: .* = \$450\.01 > \$450/);
    expect(h.written).toHaveLength(0);
    expect(readFileSync(join(dir, 'spend.jsonl'), 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
  });

  it('--live-judge without a key exits 1 before opening a ledger', async () => {
    const h = harness();
    expect(await main(['--task', '_toy', '--live-judge'], h.deps)).toBe(1);
    expect(h.text()).toContain('ANTHROPIC_API_KEY is not set');
    expect(existsSync(join(h.home, '.chartr'))).toBe(false);
  });

  it('--live-judge with a mocked judge writes a fresh cache that the offline matrix then passes on', async () => {
    const dir = tempDir('oracle-ledger');
    write(dir, 'spend.jsonl', seed(1));
    const judge = metJudge();
    const h = harness({ SPEND_LEDGER: join(dir, 'spend.jsonl'), ANTHROPIC_API_KEY: fakeKey('O') }, judge);
    expect(await main(['--task', '_toy', '--live-judge'], h.deps)).toBe(0);
    expect(h.written).toHaveLength(1);
    const { entries } = h.written[0]!;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThanOrEqual(judge.calls);
    expect(entries.every((e) => e.answer?.verdict === 'met' && e.calls === 1)).toBe(true);
    const settles = readFileSync(join(dir, 'spend.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string; call_id: string });
    expect(settles.filter((r) => r.kind === 'settle' && r.call_id !== 'seed')).toHaveLength(judge.calls);

    const toy = await loadMatrixTask('_toy');
    const lines: string[] = [];
    expect(await matrixMain(['--task', '_toy'], { env: {}, out: (l) => lines.push(l), load: async () => ({ ...toy, cache: entries }) })).toBe(0);
  });
});
