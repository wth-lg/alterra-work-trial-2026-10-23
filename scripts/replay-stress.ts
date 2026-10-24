// node scripts/replay-stress.ts [--rounds N] [--task <id>]... [--out <dir>]
// The matrix's replay determinism check in a loop: every case of every matrix task (or each
// --task) runs as a scripted trial once as the baseline, then again each round, and each run
// is compared with the baseline the way runCases compares a case's two trials (the trajectory
// without timestamps, and the final state hash). On a mismatch it writes both sides with
// writeReplayMismatch (cli/matrix.ts) and prints the first divergent line.
// Run it beside CPU load and parallel vitest workers to hunt a replay flake; it exits 1 when any
// run differed, 0 when none did.
import { parseArgs } from 'node:util';
import { nodeTaskSource, TASKS_DIR } from '../cli/adapters/tasks-node.ts';
import { loadMatrixTask, matrixEnv, matrixTaskIds, writeReplayMismatch } from '../cli/matrix.ts';
import { cases, replayDiff, trial } from '../packages/grader/matrix/matrix.ts';

const { values } = parseArgs({ options: { rounds: { type: 'string', default: '20' }, task: { type: 'string', multiple: true }, out: { type: 'string', default: 'results/replay-mismatch' } } });
const rounds = Number(values.rounds);
// One read of tasks/ for every task and every trial, as in a matrix run.
const source = nodeTaskSource({ root: TASKS_DIR, testMode: true });
const env = matrixEnv(TASKS_DIR, source);
const ids = values.task ?? matrixTaskIds();
const tasks = await Promise.all(ids.map((id) => loadMatrixTask(id, TASKS_DIR, source)));
const baselines = new Map<string, Awaited<ReturnType<typeof trial>>>();
for (const task of tasks) for (const c of cases(task)) baselines.set(`${task.id}/${c.id}`, await trial(env, task, c));
console.log(`replay-stress: ${baselines.size} cases in ${ids.join(', ')}; ${rounds} rounds`);

let runs = 0;
let differ = 0;
const started = Date.now();
for (let round = 1; round <= rounds; round++) {
  for (const task of tasks) {
    for (const c of cases(task)) {
      const first = baselines.get(`${task.id}/${c.id}`)!;
      const again = await trial(env, task, c);
      runs++;
      const d = replayDiff(first, again);
      if (d === null) continue;
      differ++;
      const dir = writeReplayMismatch(values.out!, task.id, c.id, first, again, d);
      console.log(`round ${round} ${task.id}/${c.id}: DIFF ${d.summary}\n  first: ${d.first.slice(0, 800)}\n  again: ${d.again.slice(0, 800)}\n  saved ${dir}`);
    }
  }
  console.log(`round ${round}: ${runs} runs, ${differ} differ, ${Math.round((Date.now() - started) / 1000)} s`);
}
console.log(`replay-stress: ${runs} runs, ${differ} differ`);
process.exit(differ > 0 ? 1 : 0);
