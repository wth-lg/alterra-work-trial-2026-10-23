// pnpm cli regrade <run> --grader-version <v> [--json]
// Grades every settled trial of a run again with this checkout's grader, from its trajectory and
// its record's judge cache, with no model call and no client, and appends {grader_version,
// grader_task_version, outcome, score, valid, checks, error, changed, at} to the record's
// regrades[]; the original grade is never changed (design section 6). The last entry is the
// record's current grade, which summary, audit-check and replay read (packages/core/summary.ts
// currentGrade); checks are its check results, so replay can compare them; changed says the
// outcome differs from the grade before. --grader-version must name this checkout's
// GRADER_VERSION, so a regrade records the version that really ran; grader_task_version is the
// checkout's for the record's task (packages/core/tasks.ts: its grader-side files and
// GRADER_VERSION). A record that already has an entry at both is skipped, so a rerun changes
// nothing, and a fix to a task's tests/** regrades that task's records with no GRADER_VERSION
// bump. A judge cache miss is an error: regrade names each trial and the missing cache key, exits
// 1 and writes no record. So is a trial whose trajectory does not reach its record's state in
// this checkout when its env_version is not the checkout's (it ran against task files, a world
// or tools this checkout does not have): regrade names both versions and the step that failed.
// Any other GRADER_ERROR is recorded with its error.
//
// This is the second step of the GRADER_ERROR policy (packages/grader/grade.ts header): fix the
// grader, regrade the whole run offline, disclose. A check that threw did not stop the other
// checks, so the record's judge cache answers every judge item and the regrade needs no live
// call; summary then reads the regraded grade (--require grader_error=0) and prints the earlier
// GRADER_ERRORs as grader_error_history. Exit 0 when every record is regraded or skipped; 1 on a
// miss or an unreadable trial; 2 on a usage error.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installEgressGuard } from '../packages/core/egress.ts';
import { currentGrade, trialName } from '../packages/core/summary.ts';
import type { TaskSource, TaskVersions } from '../packages/core/tasks.ts';
import { GRADER_VERSION, type CheckResult, type GradeError } from '../packages/grader/grade.ts';
import { settledRecords, writeJson } from './adapters/result-sink-node.ts';
import { nodeTaskSource } from './adapters/tasks-node.ts';
import { checkoutVersions, envChanged, regradeRun, type Regraded } from './replay.ts';

export interface Deps {
  out: (line: string) => void;
  err: (line: string) => void;
  tasks?: TaskSource;
}

export interface RegradeEntry {
  grader_version: string;
  grader_task_version: string;
  outcome: string;
  score: number | null;
  valid: boolean;
  checks: CheckResult[];
  error: GradeError | null;
  changed: boolean;
  at: string;
}

const defaults: Deps = { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) };
const USAGE = 'usage: pnpm cli regrade <run> --grader-version <v> [--json]';

// A GRADER_ERROR from no check (the trajectory replayed against this checkout does not reach the
// record's state) of a record whose env_version is not the checkout's is not a grade: the trial
// ran against task files, a world or tools this checkout does not have. It is refused, naming
// both versions and the failed step, like a judge cache miss.
async function refuseOtherWorlds(results: Regraded[], current: (id: string) => Promise<TaskVersions>): Promise<Regraded[]> {
  const out: Regraded[] = [];
  for (const r of results) {
    const rec = r.stored.record;
    const g = 'grade' in r ? r.grade : null;
    if (g?.outcome === 'GRADER_ERROR' && g.error?.check === null) {
      const now = await current(rec.task_id);
      if (rec.env_version !== now.env_version) {
        out.push({ stored: r.stored, error: `${envChanged(rec, now.env_version)}; not regraded: ${g.error.message}` });
        continue;
      }
    }
    out.push(r);
  }
  return out;
}

export async function main(args: string[], deps: Deps = defaults): Promise<number> {
  let dir: string | undefined;
  let version: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--json') json = true;
    else if (a === '--grader-version' && args[i + 1] !== undefined) version = args[++i];
    else if (!a.startsWith('--') && dir === undefined) dir = a;
    else {
      deps.err(`regrade: unexpected argument ${a}\n${USAGE}`);
      return 2;
    }
  }
  if (dir === undefined || version === undefined) {
    deps.err(`regrade: a run and --grader-version are required\n${USAGE}`);
    return 2;
  }
  if (version !== GRADER_VERSION) {
    deps.err(`regrade: --grader-version ${version}, but this checkout's grader version is ${GRADER_VERSION}`);
    return 2;
  }
  if (!existsSync(join(dir, 'trials'))) {
    deps.err(`regrade: ${dir} has no trials/ directory`);
    return 1;
  }
  const all = settledRecords(dir);
  const tasks = deps.tasks ?? nodeTaskSource({ testMode: false });
  const current = checkoutVersions(tasks);
  // The checkout's grader_task_version of each record's task; a task this checkout lacks has none,
  // and its records go on to regradeRun, which names the error.
  const graderAt = new Map<string, string | null>();
  for (const s of all) {
    const id = s.record.task_id;
    if (!graderAt.has(id)) graderAt.set(id, await current(id).then((v) => v.grader_task_version, () => null));
  }
  const done = (s: (typeof all)[number]) =>
    ((s.record as { regrades?: RegradeEntry[] }).regrades ?? []).some((e) => e.grader_version === version && e.grader_task_version === graderAt.get(s.record.task_id));
  const todo = all.filter((s) => !done(s));
  const results = await refuseOtherWorlds(await regradeRun(dir, tasks, todo), current);
  const say = json ? deps.err : deps.out;
  const failed = results.filter((r) => !('grade' in r));
  if (failed.length > 0) {
    for (const r of failed) say(`regrade: ${trialName(r.stored.record)}: ${'miss' in r ? r.miss : 'error' in r ? r.error : ''}`);
    say(`regrade: ${failed.length} of ${todo.length} trials could not be regraded; no record written`);
    if (json) deps.out(JSON.stringify({ regraded: 0, skipped: all.length - todo.length, failed: failed.map((r) => trialName(r.stored.record)) }));
    return 1;
  }
  const at = new Date().toISOString();
  const changed: string[] = [];
  for (const r of results) {
    if (!('grade' in r)) continue;
    const rec = r.stored.record as typeof r.stored.record & { regrades?: RegradeEntry[] };
    const before = currentGrade(rec).outcome;
    const entry: RegradeEntry = { grader_version: version, grader_task_version: graderAt.get(rec.task_id) as string, outcome: r.grade.outcome, score: r.grade.score, valid: r.grade.valid, checks: r.grade.checks, error: r.grade.error, changed: r.grade.outcome !== before, at };
    if (entry.changed) changed.push(`${trialName(rec)} ${before} -> ${entry.outcome}`);
    writeJson(r.stored.file, { ...rec, regrades: [...(rec.regrades ?? []), entry] });
  }
  say(`regrade: grader ${version}: ${results.length} regraded, ${all.length - todo.length} already at this version${changed.length ? `; outcome changed: ${changed.join(', ')}` : ''}`);
  if (json) deps.out(JSON.stringify({ regraded: results.length, skipped: all.length - todo.length, changed }));
  return 0;
}

export default (args: string[]) => {
  installEgressGuard(globalThis);
  return main(args);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  installEgressGuard(globalThis);
  process.exitCode = await main(process.argv.slice(2));
}
