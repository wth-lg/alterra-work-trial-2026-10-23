// The GRADER_ERROR policy end to end (fix the grader, regrade offline, disclose): a mock batch
// whose first gate throws records GRADER_ERROR and still runs every other check, judge items
// included, so the record's judge cache is complete. With the grader fixed, regrade grades it
// again offline with no judge call, summary --require grader_error=0 passes with history 1, and
// replay=all passes. A change to the task's grader-side files (tests/**) changes its
// grader_task_version and not its env_version, so replay still compares the trajectory; a change
// to what the agent sees (instruction.md) changes env_version, and replay refuses.
import { cpSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { scenarioTransport } from '../../apps/web/src/harness/scenarios.ts';
import { MODEL } from '../../packages/core/anthropic.ts';
import { taskSource, taskVersions, type TaskSource } from '../../packages/core/tasks.ts';
import type { Check } from '../../packages/grader/check.ts';
import { GRADER_VERSION } from '../../packages/grader/grade.ts';
import { fakeKey, tempDir } from '../../scripts/test/helpers.ts';
import { nodeTaskDirs } from '../adapters/tasks-node.ts';
import { main as regrade } from '../regrade.ts';
import { main as replay } from '../replay.ts';
import { main as run, repoWorld, taskChecks } from '../run.ts';
import { main as summary } from '../summary.ts';

const BUG = 'injected grader bug in note_on_patient';
let dir: string;

// The toy's checks with its first gate throwing: the grader bug the fix removes.
async function buggyChecks(task: string): Promise<readonly Check[]> {
  const checks = await taskChecks(task);
  return checks.map((c, i) => (i === 0 ? ({ ...c, fn: () => { throw new Error(BUG); } } as Check) : c));
}

beforeAll(async () => {
  dir = join(tempDir('grader-fix-run'), 'grader-fix-run');
  const home = tempDir('grader-fix-home');
  const out: string[] = [];
  const code = await run(['--task', '_toy', '--model', MODEL, '--trials', '2', '--mock', 'toy', '--out', dir], {
    env: { HOME: home, SPEND_LEDGER: join(home, 'spend.jsonl') },
    out: (l) => out.push(l),
    fetch: () => Promise.reject(new Error('no live call')),
    mock: (name) => scenarioTransport(name).transport,
    checks: buggyChecks,
  });
  if (code !== 0) throw new Error(out.join('\n'));
});

async function cli(main: (args: string[], deps: { out: (l: string) => void; err: (l: string) => void; tasks?: TaskSource }) => Promise<number>, args: string[], tasks?: TaskSource) {
  const lines: string[] = [];
  const code = await main(args, { out: (l) => lines.push(l), err: (l) => lines.push(l), ...(tasks ? { tasks } : {}) });
  return { code, text: lines.join('\n') };
}

const copyOf = (label: string) => {
  const copy = join(tempDir(label), label);
  cpSync(dir, copy, { recursive: true });
  return copy;
};
type Rec = {
  outcome: string; env_version: string; grader_task_version: string; task_version: string;
  checks: Array<{ id: string; met: unknown; method: string }>; error: { check: string | null; message: string } | null;
  judge: { cache: Array<{ key: string }> }; regrades?: Array<Record<string, unknown>>;
};
const read = (run: string, i: number) => JSON.parse(readFileSync(join(run, 'trials', '_toy', `${i}.json`), 'utf8')) as Rec;

// This checkout's tasks with one _toy file changed.
const editedTasks = (path: string, edit: (text: string) => string): TaskSource =>
  taskSource(async () => nodeTaskDirs().map((d) => (d.id === '_toy' ? { ...d, files: { ...d.files, [path]: edit(d.files[path] as string) } } : d)), { testMode: true });

describe('fix the grader, regrade offline, disclose', () => {
  it('a gate that throws records GRADER_ERROR naming it, and every other check still runs, judge items included', () => {
    for (const i of [0, 1]) {
      const r = read(dir, i);
      expect(r.outcome).toBe('GRADER_ERROR');
      expect(r.error).toMatchObject({ check: 'note_on_patient', message: expect.stringContaining(BUG) });
      expect(r.checks.find((c) => c.id === 'note_on_patient')).toMatchObject({ met: 'unknown' });
      expect(r.checks.filter((c) => c.met !== 'unknown').length).toBeGreaterThan(0);
      expect(r.checks.some((c) => c.method !== 'code')).toBe(true);
      expect(r.judge.cache.length).toBeGreaterThan(0);
    }
  });

  it('records carry env_version and grader_task_version, and task_version is their combined hash', async () => {
    const r = read(dir, 0);
    const v = await taskVersions(await taskSource(async () => nodeTaskDirs(), { testMode: true }).get('_toy'), repoWorld().worldHash);
    expect(r).toMatchObject(v);
    expect(new Set([v.env_version, v.grader_task_version, v.task_version]).size).toBe(3);
  });

  it('after the fix: regrade offline with no judge call, summary grader_error=0 with history 1, replay=all', async () => {
    const run = copyOf('grader-fix-regrade');
    vi.stubEnv('ANTHROPIC_API_KEY', fakeKey('G'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const before = await cli(summary, [run, '--allow-mock', '--require', 'grader_error=0']);
    expect(before.code, before.text).toBe(1);
    expect(before.text).toContain('GRADER_ERROR in 2 records');

    const r = await cli(regrade, [run, '--grader-version', GRADER_VERSION]);
    expect(r.code, r.text).toBe(0);
    expect(r.text).toContain('_toy/0 GRADER_ERROR -> PASS');
    const entry = read(run, 0).regrades?.[0];
    expect(entry).toMatchObject({ grader_version: GRADER_VERSION, grader_task_version: read(run, 0).grader_task_version, outcome: 'PASS', error: null });

    const rp = await cli(replay, [run]);
    expect(rp.code, rp.text).toBe(0);
    expect(rp.text).toContain('2 of 2 trials reproduced');

    const s = await cli(summary, [run, '--allow-mock', '--require', 'grader_error=0,replay=all', '--json']);
    expect(s.code, s.text).toBe(0);
    expect(s.text).toContain('history 2');
    const json = JSON.parse(s.text.split('\n').at(-1) as string);
    expect(json.totals).toMatchObject({ grader_error: 0, grader_error_history: 2 });
    expect(json.tasks._toy).toMatchObject({ env_versions: [read(run, 0).env_version], grader_task_versions: [read(run, 0).grader_task_version] });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('with one trial regraded, grader_error_history is 1', async () => {
    const run = copyOf('grader-fix-one');
    const r = await cli(regrade, [run, '--grader-version', GRADER_VERSION]);
    expect(r.code, r.text).toBe(0);
    // The run then holds one trial that was GRADER_ERROR before its regrade.
    rmSync(join(run, 'trials', '_toy', '1.json'));
    const s = await cli(summary, [run, '--allow-mock', '--require', 'grader_error=0', '--json']);
    expect(s.code, s.text).toBe(0);
    expect(JSON.parse(s.text.split('\n').at(-1) as string).totals).toMatchObject({ grader_error: 0, grader_error_history: 1 });
  });

  it('a change to grader-side files changes grader_task_version only: replay still compares, and regrade grades again', async () => {
    const run = copyOf('grader-fix-tests-edit');
    expect((await cli(regrade, [run, '--grader-version', GRADER_VERSION])).code).toBe(0);
    const tasks = editedTasks('tests/judge-cache.json', (t) => `${t}\n`);
    const now = await taskVersions(await tasks.get('_toy'), repoWorld().worldHash);
    expect(now.env_version).toBe(read(run, 0).env_version);
    expect(now.grader_task_version).not.toBe(read(run, 0).grader_task_version);
    const rp = await cli(replay, [run], tasks);
    expect(rp.code, rp.text).toBe(0);
    const again = await cli(regrade, [run, '--grader-version', GRADER_VERSION], tasks);
    expect(again.code, again.text).toBe(0);
    expect(again.text).toContain('2 regraded');
    expect(read(run, 0).regrades?.at(-1)).toMatchObject({ grader_task_version: now.grader_task_version });
    expect((await cli(regrade, [run, '--grader-version', GRADER_VERSION], tasks)).text).toContain('0 regraded, 2 already at this version');
  });

  it('a change to what the agent sees changes env_version: replay refuses, naming both', async () => {
    const run = copyOf('grader-fix-env-edit');
    const tasks = editedTasks('instruction.md', (t) => `${t}\nOne more line.\n`);
    const now = await taskVersions(await tasks.get('_toy'), repoWorld().worldHash);
    expect(now.env_version).not.toBe(read(run, 0).env_version);
    const rp = await cli(replay, [run], tasks);
    expect(rp.code, rp.text).toBe(1);
    expect(rp.text).toContain(`_toy/0: environment changed: run at env_version ${read(run, 0).env_version}, checkout at ${now.env_version}`);
  });
});
