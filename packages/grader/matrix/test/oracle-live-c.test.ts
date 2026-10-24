// `pnpm cli oracle --live-judge` (plan phase P9 gate): with the ledger one cent over
// PROJECTED_CAP_USD minus the command's own dry-run projection, batchStart refuses before any judge call, writes no cache
// and appends no ledger row. Graded on the toy's oracle and null agent only, so it stays fast.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { Transport } from '../../../core/anthropic.ts';
import { PROJECTED_CAP_USD } from '../../../core/ledger.ts';
import type { JudgeCacheEntry } from '../../judge.ts';
import { fakeKey, tempDir, write } from '../../../../scripts/test/helpers.ts';
import { main } from '../../../../cli/oracle.ts';
import { TOY } from './harness.ts';

const TINY = { ...TOY, alternatives: [], mutants: [], agents: {} };
const seed = (cost: number) =>
  ['reserve', 'settle'].map((kind) => JSON.stringify({ ts: 't', call_id: 'seed', kind, source: 'node', run_id: null, batch_id: null, trial: null, usage: null, cost_usd: cost })).join('\n') + '\n';

it('--live-judge with ledger + projection one cent over the projected cap is refused with 0 calls and writes no cache', async () => {
  const home = tempDir('oracle-home');
  const lines: string[] = [];
  const written: JudgeCacheEntry[][] = [];
  const fetch = vi.fn<Transport>();
  const run = (args: string[], env: Record<string, string> = {}) =>
    main(['--task', '_toy', '--live-judge', ...args], { env: { HOME: home, ...env }, out: (l) => lines.push(l), fetch, load: async () => TINY, writeCache: (_t, e) => written.push(e) });

  expect(await run(['--dry-run'])).toBe(0);
  const projection = Number(/^LIVE_PROJECTION_USD=(\d+\.\d{6})$/m.exec(lines.join('\n'))![1]);
  expect(projection).toBeGreaterThan(0);
  const dir = tempDir('oracle-ledger');
  write(dir, 'spend.jsonl', seed(Number((PROJECTED_CAP_USD + 0.01 - projection).toFixed(6))));
  expect(await run([], { SPEND_LEDGER: join(dir, 'spend.jsonl'), ANTHROPIC_API_KEY: fakeKey('O') })).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
  expect(lines.join('\n')).toMatch(/projected cap: /);
  expect(lines.join('\n')).toContain(`= $${(PROJECTED_CAP_USD + 0.01).toFixed(2)} > $${PROJECTED_CAP_USD}`);
  expect(written).toHaveLength(0);
  expect(readFileSync(join(dir, 'spend.jsonl'), 'utf8').split('\n').filter(Boolean)).toHaveLength(2);
});
