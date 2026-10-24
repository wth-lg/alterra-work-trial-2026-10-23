// pnpm cli spend [--where] [--init] [--check [--projected X] [--final-reserve [--cost-from <run,...>]]]
//                [--close <batch_id> [--force <reason>]] [--ingest <file>] [--export <path>]
// With no action, prints the ledger totals.
//   --where           prints the ledger mode and path: `own-run <path>` or `default <path>`
//   --init            creates the ledger file; own-run mode needs this once, since an own-run
//                     open refuses a missing file. Leaves an existing file as it is
//   --check           prints each term and exits 1 when settled + reserved + open batch
//                     projections + X (+ the remaining final-run projection with
//                     --final-reserve) > PROJECTED_CAP_USD
//   --close <id>      closes a batch whose process died; its settled rows and unsettled
//                     reservations keep counting. Refuses while its pid is alive on this
//                     host, or when it was opened on another host, unless --force <reason>,
//                     which the close row records
//   --ingest <file>   appends browser reserve and settle rows (JSONL), deduped by call_id;
//                     refuses the whole file on any other row
//   --check --final-reserve counts the planned tasks in tasks/ under the current directory.
//   --export <path>   writes a byte-equal copy of the ledger
// The final run is results/runs/final-1 under RESULTS_ROOT (default: the current directory).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { finalReserve, formatProjection, money } from '../packages/core/cost.ts';
import { checkProjected, parseRow, PROJECTED_CAP_USD, type Totals } from '../packages/core/ledger.ts';
import {
  auditorDone, initNodeLedger, loadFinalTrials, loadPlannedTasks, loadTrialObservations, openNodeLedger, resolveLedgerPath,
} from './adapters/ledger-node.ts';

const ACTIONS = ['--where', '--init', '--check', '--close', '--ingest', '--export'];
const WITH_VALUE = new Set(['--close', '--force', '--ingest', '--export', '--projected', '--cost-from']);
const FLAGS = new Set(['--where', '--init', '--check', '--final-reserve']);

function usage(problem: string): number {
  process.stderr.write(`spend: ${problem}\nusage: pnpm cli spend [--where] [--init] [--check [--projected X] [--final-reserve [--cost-from <run,...>]]] [--close <batch_id> [--force <reason>]] [--ingest <file>] [--export <path>]\n`);
  return 2;
}

const term = (name: string, value: string) => `${name.padEnd(18)}${value}`;

function printTotals(t: Totals): void {
  const out = [
    term('settled', money(t.settled)),
    term('reserved', money(t.reserved)),
    term('open projections', `${money(t.openExcess)} (${t.open.length} open batches)`),
    ...t.open.map((b) => `  ${b.batch_id}: projection ${money(b.projection)}, own ${money(b.own)}, counts ${money(b.counted)}; pid ${b.pid ?? '?'} on ${b.host ?? '?'} since ${b.ts}`),
  ];
  process.stdout.write(out.join('\n') + '\n');
}

export default async function spend(args: string[]): Promise<number> {
  try {
    return await run(args);
  } catch (e) {
    process.stderr.write(`spend: ${(e as Error).message}\n`);
    return 1;
  }
}

async function run(args: string[]): Promise<number> {
  const opts = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (FLAGS.has(a)) opts.set(a, '');
    else if (WITH_VALUE.has(a)) {
      const v = args[++i];
      if (v === undefined) return usage(`${a} needs a value`);
      opts.set(a, v);
    } else return usage(`unknown argument ${a}`);
  }
  const actions = ACTIONS.filter((a) => opts.has(a));
  if (actions.length > 1) return usage(`one action at a time, got ${actions.join(' ')}`);
  if (!opts.has('--check') && ['--projected', '--final-reserve', '--cost-from'].some((o) => opts.has(o))) {
    return usage('--projected, --final-reserve and --cost-from go with --check');
  }
  if (opts.has('--cost-from') && !opts.has('--final-reserve')) return usage('--cost-from goes with --final-reserve');
  if (opts.has('--force') && !opts.has('--close')) return usage('--force goes with --close');
  if (opts.get('--force')?.trim() === '') return usage('--force needs a reason');

  if (opts.has('--where')) {
    const where = resolveLedgerPath();
    process.stdout.write(`${where.mode} ${where.path}\n`);
    for (const p of where.problems) process.stderr.write(`spend: ${p}\n`);
    return where.problems.length > 0 ? 1 : 0;
  }

  if (opts.has('--init')) {
    const { mode, path, created } = initNodeLedger();
    process.stdout.write(`${created ? 'created' : 'exists'} ${mode} ${path}\n`);
    return 0;
  }

  const { ledger, store, path } = openNodeLedger({ transport: 'offline' });

  if (opts.has('--close')) {
    const id = opts.get('--close') as string;
    const force = opts.get('--force');
    const wrote = await ledger.close(id, force === undefined ? {} : { force });
    process.stdout.write(wrote ? `closed batch ${id}\n` : `batch ${id} was already closed\n`);
    return 0;
  }

  if (opts.has('--ingest')) {
    const file = opts.get('--ingest') as string;
    const rows = readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l, i) => {
        try {
          return parseRow(JSON.parse(l));
        } catch (e) {
          throw new Error(`${file}:${i + 1}: ${(e as Error).message}`, { cause: e });
        }
      });
    const added = await ledger.ingest(rows);
    process.stdout.write(`ingested ${added} of ${rows.length} rows into ${path}\n`);
    return 0;
  }

  if (opts.has('--export')) {
    const dest = opts.get('--export') as string;
    await store.exportTo(dest);
    process.stdout.write(`exported ${path} to ${dest}\n`);
    return 0;
  }

  const t = await ledger.totals();
  if (!opts.has('--check')) {
    printTotals(t);
    return 0;
  }

  const projected = Number(opts.get('--projected') ?? '0');
  if (!Number.isFinite(projected) || projected < 0) return usage(`--projected must be a number >= 0`);
  printTotals(t);
  process.stdout.write(term('projected', money(projected)) + '\n');
  let reserve = 0;
  if (opts.has('--final-reserve')) {
    const costFrom = (opts.get('--cost-from') ?? '').split(',').filter((s) => s !== '');
    const finalRun = join(process.env.RESULTS_ROOT || process.cwd(), 'results', 'runs', 'final-1');
    const p = finalReserve({
      plannedTasks: loadPlannedTasks(process.cwd()),
      observations: loadTrialObservations(costFrom),
      finalTrials: loadFinalTrials(finalRun),
      auditorDone: auditorDone(finalRun),
    });
    reserve = p.total;
    const lines = formatProjection(p);
    process.stdout.write([...lines.slice(0, -1).map((l) => `  ${l}`), term('final-run reserve', money(p.total))].join('\n') + '\n');
  }
  const { total, over } = checkProjected(t, projected, reserve);
  process.stdout.write(
    [
      term('total', money(total)),
      term('cap', money(PROJECTED_CAP_USD)),
      over ? `over: the total exceeds the $${PROJECTED_CAP_USD} projected cap` : 'ok: within the projected cap',
    ].join('\n') + '\n',
  );
  return over ? 1 : 0;
}
