// pnpm cli run (plan phase P12): 60 mocked trials match the same batch driven through
// packages/core/batch.ts with an in-memory sink; a SIGKILL during trial 31 resumes with exactly
// the 30 unfinished trials; --task, --dry-run and --cost-from; the projected cap; the manifest's
// env_git_sha and env_dirty, and the refusal of a live batch on a dirty tree.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scenarioTransport } from '../../apps/web/src/harness/scenarios.ts';
import { MessagesClient, MODEL, type Transport } from '../../packages/core/anthropic.ts';
import { memorySink, runBatch } from '../../packages/core/batch.ts';
import { admitStore, createLedger, type LedgerRow, type LedgerStore } from '../../packages/core/ledger.ts';
import { taskVersion } from '../../packages/core/tasks.ts';
import { checks as toyChecks } from '../../tasks/_toy/tests/grader.ts';
import { commitFile, fakeKey, git, repoRoot, tempDir, tempRepo, write } from '../../scripts/test/helpers.ts';
import { readRows } from '../adapters/ledger-node.ts';
import { nodeTaskSource } from '../adapters/tasks-node.ts';
import { main, type Deps } from '../run.ts';

const WORLD = new Uint8Array(readFileSync(join(repoRoot, 'fixtures/world.ndjson.gz')));
const WORLD_HASH = (JSON.parse(readFileSync(join(repoRoot, 'fixtures/manifest.json'), 'utf8')) as { world: { state_hash: string } }).world.state_hash;
const DEFINITIONS = JSON.parse(readFileSync(join(repoRoot, 'fixtures/definitions-pruned.json'), 'utf8'));

interface Harness {
  deps: Deps;
  out: string[];
  calls: { mock: number; live: number };
  ledger: string;
}

function harness(over: Partial<Deps> = {}, env: Record<string, string | undefined> = {}): Harness {
  const home = tempDir('run-home');
  const ledger = join(home, 'spend.jsonl');
  const out: string[] = [];
  const calls = { mock: 0, live: 0 };
  const deps: Deps = {
    env: { HOME: home, SPEND_LEDGER: ledger, ...env },
    out: (l) => out.push(l),
    fetch: async () => {
      calls.live++;
      throw new Error('test: no live call');
    },
    mock: (name) => {
      const t = scenarioTransport(name).transport;
      return (request) => {
        calls.mock++;
        return t(request);
      };
    },
    ...over,
  };
  return { deps, out, calls, ledger };
}

const runArgs = (out: string, ...more: string[]) => ['--task', '_toy', '--model', MODEL, '--out', out, ...more];
const trialFiles = (dir: string) => readdirSync(join(dir, 'trials'), { recursive: true }).filter((f) => String(f).endsWith('.json')).map(String).sort();
const keysIn = (dir: string) =>
  trialFiles(dir).map((f) => {
    const r = JSON.parse(readFileSync(join(dir, 'trials', f), 'utf8')) as { task_version: string; model_requested: string; effort: string; index: number };
    return `${r.task_version}/${r.model_requested}/${r.effort}/${r.index}`;
  });

class MemoryStore implements LedgerStore {
  rows: LedgerRow[] = [];
  async transact<T>(fn: (rows: readonly LedgerRow[]) => { append: LedgerRow[]; result: T }): Promise<T> {
    const { append, result } = fn(this.rows);
    this.rows.push(...append);
    return result;
  }
  async read(): Promise<LedgerRow[]> {
    return [...this.rows];
  }
}

// Each mocked trial loads and hashes the world (about 0.5 s), so the 60-trial cases get 8 minutes (125 s seen under a parallel run).
describe('cli run', { timeout: 480_000 }, () => {
  it('60 mocked trials: the same keys and call count as the batch driven through batch.ts with an in-memory sink', async () => {
    const dir = join(tempDir('run-60'), 'run-60');
    const h = harness();
    const code = await main(runArgs(dir, '--trials', '60', '--concurrency', '4', '--mock', 'toy'), h.deps);
    expect(code, h.out.join('\n')).toBe(0);
    const cliKeys = keysIn(dir);
    expect(new Set(cliKeys).size).toBe(60);

    const store = new MemoryStore();
    admitStore(store);
    let id = 0;
    const ledger = createLedger({ store, clock: { now: () => 't' }, newId: () => `m-${++id}`, source: 'node', runId: 'run-60', pid: 1, host: 'h', isAlive: () => true });
    const sink = memorySink();
    let calls = 0;
    const result = await runBatch(
      { runId: 'run-60', taskIds: ['_toy'], trials: 60, model: MODEL, effort: 'high', mode: 'mock-toy', concurrency: 4, observations: [] },
      {
        ledger, rows: () => store.read(), sink, tasks: nodeTaskSource({ testMode: true }), checks: async () => toyChecks,
        world: { read: async () => WORLD }, worldHash: WORLD_HASH, definitions: DEFINITIONS, now: () => 0,
        client: (grant, trial) => {
          const t = scenarioTransport('toy').transport;
          const fetch: Transport = (r) => {
            calls++;
            return t(r);
          };
          return new MessagesClient({ grant, ledger, apiKey: 'test-key-not-real', fetch, trial, sleep: async () => {} });
        },
      },
    );
    expect(result.settled).toBe(60);
    const memKeys = (await sink.settled()).map((r) => `${r.task_version}/${r.model_requested}/${r.effort}/${r.index}`).sort();
    expect(memKeys).toEqual([...cliKeys].sort());
    expect(calls).toBe(h.calls.mock);
    expect(h.calls.mock).toBe(300);

    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(manifest.env_git_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(typeof manifest.env_dirty).toBe('boolean');
    expect(manifest.batches).toHaveLength(1);
    // A mocked run meters through its SPEND_LEDGER, never ~/.clinenv.
    expect(readRows(h.ledger).filter((r) => r.kind === 'close')).toHaveLength(1);
    expect(existsSync(join(h.deps.env.HOME as string, '.clinenv'))).toBe(false);
  });

  it('a SIGKILL during trial 31, then a rerun: 60 unique keys, the partial call billed once, and calls only for the 30 unfinished trials', async () => {
    const dir = join(tempDir('run-kill'), 'run-kill');
    const h = harness();
    const marker = join(tempDir('kill-marker'), 'marker');
    const env: Record<string, string> = { ...(process.env as Record<string, string>), HOME: h.deps.env.HOME as string, SPEND_LEDGER: h.ledger };
    delete env.CLINENV_CANONICAL_LEDGER;
    delete env.ANTHROPIC_API_KEY;
    const child = spawn(process.execPath, [join(repoRoot, 'cli/test/kill-child.ts'), marker, '30', ...runArgs(dir, '--trials', '60', '--concurrency', '1', '--mock', 'toy')], { env, stdio: 'ignore' });
    const exited = new Promise<NodeJS.Signals | null>((resolve) => child.on('exit', (_code, signal) => resolve(signal)));
    await expect.poll(() => existsSync(marker), { timeout: 150_000, interval: 50 }).toBe(true);
    child.kill('SIGKILL');
    expect(await exited).toBe('SIGKILL');
    expect(trialFiles(dir)).toHaveLength(30);
    const trial31 = readFileSync(marker, 'utf8');
    const before = readRows(h.ledger);
    const settledIds = new Set(before.filter((r) => r.kind === 'settle').map((r) => r.call_id));
    const partial = before.filter((r) => r.kind === 'reserve' && r.trial === trial31 && !settledIds.has(r.call_id));
    expect(partial).toHaveLength(1);

    const code = await main(runArgs(dir, '--trials', '60', '--concurrency', '1', '--mock', 'toy'), h.deps);
    expect(code, h.out.join('\n')).toBe(0);
    const keys = keysIn(dir);
    expect(keys).toHaveLength(60);
    expect(new Set(keys).size).toBe(60);
    expect(h.calls.mock).toBe(30 * 5);
    const after = readRows(h.ledger);
    expect(after.filter((r) => r.call_id === partial[0]!.call_id)).toHaveLength(1);
    const dead = before.find((r) => r.kind === 'open')!;
    expect(after.filter((r) => r.kind === 'close' && r.batch_id === dead.batch_id)).toHaveLength(1);
  });

  it('--task takes an explicit list; --dry-run lists exactly those tasks; --cost-from uses the later run; a task with no cost data projects at $6', async () => {
    const tasksRoot = tempDir('fixture-tasks');
    for (const id of ['renal-dose-review', 'crc-care-gap', 'other-task']) {
      cpSync(join(repoRoot, 'tasks/_toy'), join(tasksRoot, id), { recursive: true });
      const toml = join(tasksRoot, id, 'task.toml');
      writeFileSync(toml, readFileSync(toml, 'utf8').replace(/^id = "_toy"$/m, `id = "${id}"`));
    }
    const tasks = nodeTaskSource({ root: tasksRoot, testMode: false });
    const crc = await taskVersion(await tasks.get('crc-care-gap'), WORLD_HASH);
    const runs = tempDir('cost-runs');
    for (const [name, cost] of [['a', 1], ['b', 2]] as const) {
      for (let i = 0; i < 10; i++) write(runs, `${name}/trials/crc-care-gap/${i}.json`, JSON.stringify({ task_id: 'crc-care-gap', task_version: crc, cost_usd: cost }));
    }
    const h = harness({ tasks, checks: async () => [] });
    const out = join(tempDir('dry'), 'dry');
    const code = await main(['--task', 'renal-dose-review,crc-care-gap', '--model', MODEL, '--trials', '10', '--out', out, '--dry-run', '--cost-from', `${join(runs, 'a')},${join(runs, 'b')}`], h.deps);
    const text = h.out.join('\n');
    expect(code, text).toBe(0);
    const lines = h.out.filter((l) => / trials x /.test(l));
    expect(lines.map((l) => l.split(':')[0]).sort()).toEqual(['crc-care-gap', 'renal-dose-review']);
    expect(text).toMatch(/renal-dose-review: 10 trials x \$6\.00 per trial \(cap: no cost data\)/);
    expect(text).toMatch(new RegExp(`crc-care-gap: 10 trials x \\$2\\.00 per trial \\(p90 of 10 trials of ${crc} in ${join(runs, 'b')}\\)`));
    expect(text).not.toContain('other-task');
    expect(text).toMatch(/LIVE_PROJECTION_USD=93\.000000/); // 10 x 6 x 1.15 + 10 x 2 x 1.15 + 1
    expect(existsSync(out)).toBe(false);
    expect(existsSync(h.ledger)).toBe(false);

    const nope = harness({ tasks });
    expect(await main(['--task', 'nope', '--model', MODEL, '--out', out, '--dry-run'], nope.deps)).toBe(1);
    expect(nope.out.join('\n')).toMatch(/no task 'nope'/);
  });

  it('a projection over $450 refuses the batch with 0 calls', async () => {
    const h = harness();
    const dir = join(tempDir('run-cap'), 'run-cap');
    expect(await main(runArgs(dir, '--trials', '66', '--mock', 'toy'), h.deps)).toBe(1);
    expect(h.out.join('\n')).toMatch(/projected cap/);
    expect(h.calls.mock).toBe(0);
    expect(readRows(h.ledger).filter((r) => r.kind !== 'open')).toEqual([]);
  });

  it('the manifest carries env_git_sha and env_dirty; with an uncommitted edit under packages/grader a live run refuses with 0 calls', async () => {
    const repo = tempRepo();
    commitFile(repo, 'packages/grader/x.ts', 'export const x = 1;\n');
    const sha = git(repo, 'rev-parse', 'HEAD');
    write(repo, 'packages/grader/x.ts', 'export const x = 2;\n');

    const mocked = harness({ repo });
    const dir = join(tempDir('run-dirty'), 'run-dirty');
    expect(await main(runArgs(dir, '--trials', '1', '--mock', 'toy'), mocked.deps)).toBe(0);
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({ env_git_sha: sha, env_dirty: true });

    const live = harness({ repo }, { ANTHROPIC_API_KEY: fakeKey('S') });
    const liveDir = join(tempDir('run-live'), 'run-live');
    expect(await main(runArgs(liveDir, '--trials', '1'), live.deps)).toBe(1);
    expect(live.out.join('\n')).toMatch(/dirty.*packages\/grader\/x\.ts/s);
    expect(live.out.join('\n')).not.toContain(fakeKey('S'));
    expect(live.calls.live).toBe(0);
    expect(existsSync(live.ledger)).toBe(false);
    expect(existsSync(liveDir)).toBe(false);
  });
});
