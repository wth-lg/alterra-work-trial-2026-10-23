// pnpm cli replay <run> [--json]
// Re-executes every settled trial's tool log against a fresh store and grades it again from the
// record's judge cache (packages/core/run.ts gradeTrajectory), with no model call and no client:
// a judge cache miss is an error, named with its trial and cache key. A trial matches when the
// replay reaches the record's final state hash and the grade has the outcome, score and check
// results of the record's current grade (packages/core/summary.ts currentGrade: its last cli
// regrade, else its recorded grade). A last regrade entry written before regrade stored check
// results is compared on outcome and score only, and replay says so. A trial whose record's task_version is not the checkout's (the task or the world
// changed since it ran) is not replayed: it does not match, with the reason 'task changed: run at
// <record's>, checkout at <checkout's>' (regrade still grades it, against the newer version).
// Writes <run>/replay.json, {trials: {"<task>/<index>": {match, outcome,
// recorded_outcome, current_outcome, error?}}}, which `summary --require replay=all` reads. Exit 0 when every trial
// matches; 1 otherwise; 2 on a usage error.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BatchRecord } from '../packages/core/batch.ts';
import { installEgressGuard } from '../packages/core/egress.ts';
import { gradeTrajectory } from '../packages/core/run.ts';
import { currentGrade } from '../packages/core/summary.ts';
import { taskVersion, type TaskSource } from '../packages/core/tasks.ts';
import { parseTrajectory } from '../packages/core/trajectory.ts';
import type { Grade } from '../packages/grader/grade.ts';
import { JudgeCacheMiss } from '../packages/grader/judge.ts';
import { settledRecords, trajectoryOf, writeJson, type StoredRecord } from './adapters/result-sink-node.ts';
import { nodeTaskSource } from './adapters/tasks-node.ts';
import { repoWorld, taskChecks } from './run.ts';

export interface Deps {
  out: (line: string) => void;
  err: (line: string) => void;
  tasks?: TaskSource;
}

const defaults: Deps = { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) };

export const trialName = (r: Pick<BatchRecord, 'task_id' | 'index'>): string => `${r.task_id}/${r.index}`;

export type Regraded = { stored: StoredRecord; grade: Grade } | { stored: StoredRecord; miss: string } | { stored: StoredRecord; error: string };

// Grades each settled record of a run again from its trajectory and judge cache.
export async function regradeRun(dir: string, tasks: TaskSource, records = settledRecords(dir)): Promise<Regraded[]> {
  const { world, definitions } = repoWorld();
  const out: Regraded[] = [];
  for (const stored of records) {
    const r = stored.record;
    try {
      const events = parseTrajectory(readFileSync(trajectoryOf(dir, r), 'utf8'));
      out.push({ stored, grade: await gradeTrajectory(r.task_id, { tasks, world, checks: await taskChecks(r.task_id), events, record: r, definitions }) });
    } catch (e) {
      if (e instanceof JudgeCacheMiss) out.push({ stored, miss: e.message });
      else out.push({ stored, error: (e as Error).message });
    }
  }
  return out;
}

const metOf = (checks: ReadonlyArray<{ id: string; met: unknown }> | undefined) => JSON.stringify((checks ?? []).map((c) => [c.id, c.met]));

export async function main(args: string[], deps: Deps = defaults): Promise<number> {
  const json = args.includes('--json');
  const rest = args.filter((a) => a !== '--json');
  if (rest.length !== 1 || rest[0]!.startsWith('--')) {
    deps.err('usage: pnpm cli replay <run> [--json]');
    return 2;
  }
  const dir = rest[0] as string;
  if (!existsSync(join(dir, 'trials'))) {
    deps.err(`replay: ${dir} has no trials/ directory`);
    return 1;
  }
  const tasks = deps.tasks ?? nodeTaskSource({ testMode: false });
  const trials: Record<string, { match: boolean; outcome: string | null; recorded_outcome: string; current_outcome: string; error?: string }> = {};
  const notes: string[] = [];
  const { worldHash } = repoWorld();
  const versions = new Map<string, Promise<string>>();
  const current = (id: string) => {
    if (!versions.has(id)) versions.set(id, tasks.get(id).then((t) => taskVersion(t, worldHash)));
    return versions.get(id) as Promise<string>;
  };
  const same: StoredRecord[] = [];
  for (const stored of settledRecords(dir)) {
    const r = stored.record;
    let now: string;
    try {
      now = await current(r.task_id);
    } catch (e) {
      trials[trialName(r)] = { match: false, outcome: null, recorded_outcome: r.outcome, current_outcome: currentGrade(r).outcome, error: (e as Error).message };
      continue;
    }
    if (r.task_version === now) same.push(stored);
    else trials[trialName(r)] = { match: false, outcome: null, recorded_outcome: r.outcome, current_outcome: currentGrade(r).outcome, error: `task changed: run at ${r.task_version}, checkout at ${now}` };
  }
  const results = await regradeRun(dir, tasks, same);
  for (const res of results) {
    const r = res.stored.record;
    const name = trialName(r);
    const cur = currentGrade(r);
    const base = { recorded_outcome: r.outcome, current_outcome: cur.outcome };
    if ('grade' in res) {
      const g = res.grade;
      const checksKnown = !cur.regraded || cur.checks !== null;
      if (!checksKnown) notes.push(`replay: ${name}: its last regrade recorded no check results; compared outcome and score only`);
      const match = g.outcome === cur.outcome && g.score === cur.score && (!checksKnown || metOf(g.checks) === metOf(cur.checks ?? undefined));
      const was = `the ${cur.regraded ? 'current grade' : 'record'} ${cur.outcome} score ${cur.score}`;
      trials[name] = { match, outcome: g.outcome, ...base, ...(match ? {} : { error: g.error?.message ?? `regrade gives ${g.outcome} score ${g.score}, ${was}` }) };
    } else {
      trials[name] = { match: false, outcome: null, ...base, error: 'miss' in res ? res.miss : res.error };
    }
  }
  writeJson(join(dir, 'replay.json'), { trials });
  const bad = Object.entries(trials).filter(([, t]) => !t.match);
  const say = json ? deps.err : deps.out;
  for (const n of notes) say(n);
  for (const [name, t] of bad) say(`replay: ${name}: ${t.error}`);
  say(`replay: ${Object.keys(trials).length - bad.length} of ${Object.keys(trials).length} trials reproduced; wrote ${join(dir, 'replay.json')}`);
  if (json) deps.out(JSON.stringify({ trials }));
  return bad.length === 0 ? 0 : 1;
}

export default (args: string[]) => {
  installEgressGuard(globalThis);
  return main(args);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  installEgressGuard(globalThis);
  process.exitCode = await main(process.argv.slice(2));
}
