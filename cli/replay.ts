// pnpm cli replay <run> [--json]
// Re-executes every settled trial's tool log against a fresh store and grades it again from the
// record's judge cache (packages/core/run.ts gradeTrajectory), with no model call and no client:
// a judge cache miss is an error, named with its trial and cache key. A trial matches when the
// replay reaches the record's final state hash and the grade has the outcome, score and check
// results of the record's current grade (packages/core/summary.ts currentGrade: its last cli
// regrade, else its recorded grade). A last regrade entry written before regrade stored check
// results is compared on outcome and score only, and replay says so. A trial whose record's
// env_version is not the checkout's (what the agent sees changed since it ran: the task's env
// files, the world or the tools, packages/core/tasks.ts) is not replayed: it does not match,
// with the reason 'environment changed: run at env_version <record's>, checkout at <checkout's>'
// (regrade still grades it, and refuses it when its trajectory does not reach the record's
// state). A change to the task's grader-side files or the grader (its grader_task_version) does
// not stop a replay: after a grader fix and a regrade (the GRADER_ERROR policy,
// packages/grader/grade.ts), replay compares the trajectory against the regraded current grade,
// so `summary --require replay=all` can pass on that run.
// Writes <run>/replay.json, {trials: {"<trialName>": {match, outcome,
// recorded_outcome, current_outcome, error?}}}, which `summary --require replay=all` reads. Exit 0 when every trial
// matches; 1 otherwise; 2 on a usage error.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BatchRecord } from '../packages/core/batch.ts';
import { installEgressGuard } from '../packages/core/egress.ts';
import { gradeTrajectory } from '../packages/core/run.ts';
import { currentGrade, trialName } from '../packages/core/summary.ts';
import { taskVersions, type TaskSource, type TaskVersions } from '../packages/core/tasks.ts';
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

// The checkout's versions of each task, looked up once.
export function checkoutVersions(tasks: TaskSource): (id: string) => Promise<TaskVersions> {
  const { worldHash } = repoWorld();
  const versions = new Map<string, Promise<TaskVersions>>();
  return (id) => {
    if (!versions.has(id)) versions.set(id, tasks.get(id).then((t) => taskVersions(t, worldHash)));
    return versions.get(id) as Promise<TaskVersions>;
  };
}

// audit-check names trials through replay; the one definition is packages/core/summary.ts.
export { trialName };

// Why a record's trial is not this checkout's environment. A record written before env_version
// existed has none, and never matches.
export const envChanged = (r: Pick<BatchRecord, 'env_version' | 'task_version'>, now: string): string =>
  `environment changed: run at env_version ${r.env_version ?? `(none: recorded before env_version, task_version ${r.task_version})`}, checkout at ${now}`;

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
  const current = checkoutVersions(tasks);
  const same: StoredRecord[] = [];
  for (const stored of settledRecords(dir)) {
    const r = stored.record;
    let now: TaskVersions;
    try {
      now = await current(r.task_id);
    } catch (e) {
      trials[trialName(r)] = { match: false, outcome: null, recorded_outcome: r.outcome, current_outcome: currentGrade(r).outcome, error: (e as Error).message };
      continue;
    }
    if (r.env_version === now.env_version) same.push(stored);
    else trials[trialName(r)] = { match: false, outcome: null, recorded_outcome: r.outcome, current_outcome: currentGrade(r).outcome, error: envChanged(r, now.env_version) };
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
