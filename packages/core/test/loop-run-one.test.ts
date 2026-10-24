// `pnpm cli run-one` (plan phase P7) with the mocked API: its dry run prints the projection
// batchStart is given and opens nothing; a ledger whose exposure plus that projection crosses
// $450 refuses before any call; a mocked trial writes the record and the trajectory JSONL,
// meters through the ledger and closes its batch; a rerun of a recorded trial key sends nothing.
// The toy has a grader (tasks/_toy/tests/grader.ts), so the projection is the per-trial cap plus
// its judge allowance, and the mocked trial makes three model calls and two judge calls and PASSes.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir, write } from '../../../scripts/test/helpers.ts';
import { scenarioTransport } from '../../../apps/web/src/harness/scenarios.ts';
import { main, projection, type Deps } from '../../../cli/run-one.ts';
import { checks as TOY_CHECKS } from '../../../tasks/_toy/tests/grader.ts';
import type { Transport } from '../anthropic.ts';
import { parseTrajectory } from '../trajectory.ts';

function harness(env: Record<string, string>) {
  const lines: string[] = [];
  let calls = 0;
  const counted = (t: Transport): Transport => (r) => {
    calls++;
    return t(r);
  };
  const deps: Deps = {
    env,
    out: (l) => lines.push(l),
    fetch: counted(() => Promise.reject(new Error('no live calls in this test'))),
    mock: (name) => counted(scenarioTransport(name).transport),
  };
  return { deps, lines, calls: () => calls };
}

const seed = (cost: number) =>
  ['reserve', 'settle'].map((kind) => JSON.stringify({ ts: 't', call_id: 'seed', kind, source: 'node', run_id: null, batch_id: null, trial: null, usage: null, cost_usd: cost })).join('\n') + '\n';

const ARGS = ['--task', '_toy', '--model', 'claude-opus-5-5', '--effort', 'high', '--index', '0'];

describe('cli run-one', () => {
  it('--dry-run prints the projection and opens no ledger', async () => {
    const dir = tempDir('run-one');
    const h = harness({ SPEND_LEDGER: join(dir, 'spend.jsonl') });
    expect(await main([...ARGS, '--dry-run', '--out', dir], h.deps)).toBe(0);
    expect(h.lines).toContain(`LIVE_PROJECTION_USD=${projection(TOY_CHECKS).toFixed(6)}`);
    expect(h.calls()).toBe(0);
    expect(existsSync(join(dir, 'spend.jsonl'))).toBe(false);
  });

  it('refuses with 0 calls when ledger + projection = $450.01', async () => {
    const dir = tempDir('run-one');
    write(dir, 'spend.jsonl', seed(Number((450.01 - projection(TOY_CHECKS)).toFixed(6))));
    const h = harness({ SPEND_LEDGER: join(dir, 'spend.jsonl') });
    expect(await main([...ARGS, '--mock', 'toy', '--out', dir], h.deps)).toBe(1);
    expect(h.calls()).toBe(0);
    expect(h.lines.join('\n')).toMatch(/projected cap: .* = \$450\.01 > \$450/);
    expect(existsSync(join(dir, 'trials/_toy/claude-opus-5-5/high/mock-toy/0.json'))).toBe(false);
  });

  it('runs a mocked trial, writes record and trajectory, and skips a recorded key on rerun', async () => {
    const dir = tempDir('run-one');
    write(dir, 'spend.jsonl', seed(1));
    const h = harness({ SPEND_LEDGER: join(dir, 'spend.jsonl') });
    expect(await main([...ARGS, '--mock', 'toy', '--out', dir], h.deps)).toBe(0);
    expect(h.calls()).toBe(5);
    const record = JSON.parse(readFileSync(join(dir, 'trials/_toy/claude-opus-5-5/high/mock-toy/0.json'), 'utf8'));
    expect(record).toMatchObject({ task_id: '_toy', status: 'COMPLETED', outcome: 'PASS', score: 1, effort: 'high', models_returned: ['claude-opus-5-5'], mock: 'toy', trajectory: 'trajectories/_toy/claude-opus-5-5/high/mock-toy/0.jsonl' });
    expect(record.state_hash.replay_final).toBe(record.state_hash.final);
    const events = parseTrajectory(readFileSync(join(dir, 'trajectories/_toy/claude-opus-5-5/high/mock-toy/0.jsonl'), 'utf8'));
    expect(events.filter((e) => e.type === 'request')).toHaveLength(3);
    const rows = readFileSync(join(dir, 'spend.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.filter((r) => r.kind === 'settle' && r.call_id !== 'seed')).toHaveLength(5);
    expect(rows.filter((r) => r.kind === 'open')).toHaveLength(1);
    expect(rows.filter((r) => r.kind === 'close')).toHaveLength(1);
    expect(rows.filter((r) => r.kind === 'reserve' && r.call_id !== 'seed').every((r) => r.trial === 'mock:run-one:_toy/claude-opus-5-5/high/mock-toy/0')).toBe(true);

    const again = harness({ SPEND_LEDGER: join(dir, 'spend.jsonl') });
    expect(await main([...ARGS, '--mock', 'toy', '--out', dir], again.deps)).toBe(0);
    expect(again.calls()).toBe(0);
    expect(again.lines.join('\n')).toMatch(/already recorded/);
  });

  it('rejects a model other than claude-opus-5-5 and an unknown effort', async () => {
    const h = harness({});
    expect(await main(['--task', '_toy', '--model', 'claude-opus-5', '--dry-run'], h.deps)).toBe(2);
    expect(await main(['--task', '_toy', '--model', 'claude-opus-5-5', '--effort', 'huge', '--dry-run'], h.deps)).toBe(2);
  });

  it('never lets a mock record stand in for a live trial: the live form with no key fails', async () => {
    const dir = tempDir('run-one');
    write(dir, 'spend.jsonl', seed(1));
    const mocked = harness({ SPEND_LEDGER: join(dir, 'spend.jsonl') });
    expect(await main([...ARGS, '--mock', 'toy', '--out', dir], mocked.deps)).toBe(0);
    const live = harness({ SPEND_LEDGER: join(dir, 'spend.jsonl') });
    const code = await main([...ARGS, '--out', dir], live.deps);
    expect(code).not.toBe(0);
    expect(live.lines.join('\n')).toMatch(/ANTHROPIC_API_KEY is not set/);
    expect(live.lines.join('\n')).not.toMatch(/already recorded/);
    expect(live.calls()).toBe(0);
  });

  it('keys a trial by effort: --effort low after --effort high at the same index runs', async () => {
    const dir = tempDir('run-one');
    write(dir, 'spend.jsonl', seed(1));
    const env = { SPEND_LEDGER: join(dir, 'spend.jsonl') };
    expect(await main([...ARGS, '--mock', 'toy', '--out', dir], harness(env).deps)).toBe(0);
    const low = harness(env);
    const lowArgs = ['--task', '_toy', '--model', 'claude-opus-5-5', '--effort', 'low', '--index', '0', '--mock', 'toy', '--out', dir];
    expect(await main(lowArgs, low.deps)).toBe(0);
    expect(low.calls()).toBe(5);
    expect(low.lines.join('\n')).not.toMatch(/already recorded/);
    const recordLine = low.lines.find((l) => l.startsWith('record '))!;
    expect(JSON.parse(readFileSync(recordLine.slice('record '.length), 'utf8'))).toMatchObject({ effort: 'low', mock: 'toy' });
  });

  it.each(['../escape', 'a/b', 'a\\b', '..', 'no-such-task'])('rejects --task %s before any file or ledger write', async (task) => {
    const dir = tempDir('run-one');
    const out = join(dir, 'out');
    const h = harness({ SPEND_LEDGER: join(dir, 'spend.jsonl') });
    const args = ['--task', task, '--model', 'claude-opus-5-5', '--mock', 'toy', '--out', out];
    expect(await main(args, h.deps)).not.toBe(0);
    expect(await main([...args, '--dry-run'], h.deps)).not.toBe(0);
    expect(h.calls()).toBe(0);
    expect(existsSync(out)).toBe(false);
    expect(existsSync(join(dir, 'spend.jsonl'))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });
});
