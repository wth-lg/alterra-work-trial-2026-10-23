// pnpm cli regrade <run> --grader-version <v> [--json]
// Grades every settled trial of a run again with this checkout's grader, from its trajectory and
// its record's judge cache, with no model call and no client, and appends {grader_version,
// outcome, score, valid, changed, at} to the record's regrades[]; the original grade is never
// changed (design section 6). --grader-version must name this checkout's GRADER_VERSION, so a
// regrade records the version that really ran. A record that already has an entry for the version
// is skipped, so a rerun changes nothing. A judge cache miss is an error: regrade names each
// trial and the missing cache key, exits 1 and writes no record. Exit 0 when every record is
// regraded or skipped; 1 on a miss or an unreadable trial; 2 on a usage error.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installEgressGuard } from '../packages/core/egress.ts';
import type { TaskSource } from '../packages/core/tasks.ts';
import { GRADER_VERSION } from '../packages/grader/grade.ts';
import { settledRecords, writeJson } from './adapters/result-sink-node.ts';
import { nodeTaskSource } from './adapters/tasks-node.ts';
import { regradeRun, trialName } from './replay.ts';

export interface Deps {
  out: (line: string) => void;
  err: (line: string) => void;
  tasks?: TaskSource;
}

export interface RegradeEntry {
  grader_version: string;
  outcome: string;
  score: number | null;
  valid: boolean;
  changed: boolean;
  at: string;
}

const defaults: Deps = { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) };
const USAGE = 'usage: pnpm cli regrade <run> --grader-version <v> [--json]';

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
  const todo = all.filter((s) => !((s.record as { regrades?: RegradeEntry[] }).regrades ?? []).some((e) => e.grader_version === version));
  const results = await regradeRun(dir, deps.tasks ?? nodeTaskSource({ testMode: false }), todo);
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
    const entry: RegradeEntry = { grader_version: version, outcome: r.grade.outcome, score: r.grade.score, valid: r.grade.valid, changed: r.grade.outcome !== rec.outcome, at };
    if (entry.changed) changed.push(`${trialName(rec)} ${rec.outcome} -> ${entry.outcome}`);
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
