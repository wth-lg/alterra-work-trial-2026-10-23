import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { repoRoot, runScript, tempDir, write } from '../../../scripts/test/helpers.ts';
import { assertGrant, SpendRefused, totals, type LedgerRow } from '../../../packages/core/ledger.ts';
import { AUDITOR_ALLOWANCE_USD } from '../../../packages/core/cost.ts';
import { openNodeLedger, readRows, reserveSpend, resolveLedgerPath, settleSpend } from '../ledger-node.ts';

const ADAPTER = pathToFileURL(join(repoRoot, 'cli/adapters/ledger-node.ts')).href;

// Every test names its ledger, so none reads the shell's settings or this machine's ledger.
function envFor(home: string, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { HOME: home, SPEND_LEDGER: undefined, CHARTR_CANONICAL_LEDGER: undefined, ...extra };
}

function spendCli(args: string[], env: Record<string, string | undefined>, cwd: string) {
  return runScript('cli/index.ts', ['spend', ...args], { cwd, env });
}

// Runs `code` as an ES module in a child process; resolves with its exit code and output.
function child(code: string, env: Record<string, string | undefined>, cwd: string): Promise<{ code: number | null; signal: string | null; out: string; err: string }> {
  const full: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ANTHROPIC_API_KEY: undefined, ...env })) if (v !== undefined) full[k] = v;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', `import * as L from ${JSON.stringify(ADAPTER)};\n${code}`], { cwd, env: full });
    let out = '';
    let err = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('close', (code, signal) => resolve({ code, signal, out, err }));
  });
}

function settleRow(usd: number, call_id: string, source: 'node' | 'browser' = 'node'): LedgerRow {
  return { ts: '2026-10-22T00:00:00.000Z', call_id, kind: 'settle', source, run_id: 'seed', batch_id: null, trial: null, usage: null, cost_usd: usd };
}

function seed(path: string, rows: LedgerRow[]): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r) + '\n').join(''));
}

// A ledger with a long history: 10,000 settled rows that sum to `usd`.
function history(usd: number): LedgerRow[] {
  return Array.from({ length: 10_000 }, (_, i) => settleRow(usd / 10_000, `seed-${i}`));
}

// One batch with one completed call, as a live entrypoint makes it.
const ONE_CALL = `
const { ledger } = L.openNodeLedger({ transport: 'live' });
const grant = await ledger.batchStart(1);
await grant.metered({ bodyBytes: 10, maxTokens: 10 }, async () => ({ usage: { input_tokens: 10, output_tokens: 5 } }));
await grant.close();
`;

describe('ledger modes', () => {
  it('SPEND_LEDGER with no marker puts every row at that path and none under results/ (case 1)', async () => {
    const root = tempDir('ledger-c1');
    const work = join(root, 'work');
    mkdirSync(work);
    const path = join(root, 'elsewhere', 'spend.jsonl');
    const r = await child(ONE_CALL, envFor(join(root, 'home'), { SPEND_LEDGER: path }), work);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const rows = readRows(path);
    expect(rows.map((x) => x.kind)).toEqual(['open', 'reserve', 'settle', 'close']);
    expect(existsSync(join(work, 'results'))).toBe(false);
    expect(existsSync(join(root, 'home', '.chartr'))).toBe(false);
  });

  it('default mode uses ~/.chartr/spend.jsonl, creates it on a live open and keeps the caps (case 2)', async () => {
    const home = tempDir('ledger-c2');
    const where = spendCli(['--where'], envFor(home), home);
    expect(where.stdout).toBe(`default ${join(home, '.chartr', 'spend.jsonl')}\n`);
    expect(where.status).toBe(0);

    const path = join(home, '.chartr', 'spend.jsonl');
    expect(existsSync(path)).toBe(false);
    const { ledger, mode } = openNodeLedger({ transport: 'live', env: envFor(home) });
    expect(mode).toBe('default');
    expect(existsSync(path)).toBe(true);
    let calls = 0;
    await expect(ledger.batchStart(450.01).then(() => calls++)).rejects.toThrow(SpendRefused);
    expect(calls).toBe(0);
    expect(readRows(path)).toEqual([]);
  });

  it('own-run mode reads the path only from the marker and refuses a bad setup with 0 calls (case 3)', async () => {
    const root = tempDir('ledger-c3');
    const marker = join(root, 'canon', 'spend.jsonl');
    mkdirSync(join(root, 'canon'));
    const home = join(root, 'home');

    const r = await child(ONE_CALL, envFor(home, { CHARTR_CANONICAL_LEDGER: marker }), root);
    expect(r.code).toBe(0);
    expect(readRows(marker)).toHaveLength(4);
    expect(spendCli(['--where'], envFor(home, { CHARTR_CANONICAL_LEDGER: marker }), root).stdout).toBe(`own-run ${marker}\n`);
    // SPEND_LEDGER naming the same file is consistent.
    expect(resolveLedgerPath(envFor(home, { CHARTR_CANONICAL_LEDGER: marker, SPEND_LEDGER: marker })).problems).toEqual([]);

    const bad: Array<[string, Record<string, string>]> = [
      ['SPEND_LEDGER names another path', { CHARTR_CANONICAL_LEDGER: marker, SPEND_LEDGER: '/tmp/x' }],
      ['marker directory is missing', { CHARTR_CANONICAL_LEDGER: join(root, 'gone', 'spend.jsonl') }],
      ['marker is not absolute', { CHARTR_CANONICAL_LEDGER: 'canon/spend.jsonl' }],
    ];
    for (const [why, extra] of bad) {
      let calls = 0;
      expect(() => {
        openNodeLedger({ transport: 'live', env: envFor(home, extra) });
        calls++;
      }, why).toThrow(/CHARTR_CANONICAL_LEDGER/);
      expect(calls, why).toBe(0);
      expect(spendCli(['--where'], envFor(home, extra), root).status, why).toBe(1);
    }
    expect(existsSync(join(root, 'gone'))).toBe(false);
    expect(existsSync('/tmp/x') && readFileSync('/tmp/x', 'utf8').includes('"kind"')).toBe(false);
    expect(existsSync(join(home, '.chartr'))).toBe(false);
  });
});

describe('cross-process caps', () => {
  it('4 concurrent processes near $500 never take settled + reserved past $500 (case 6)', async () => {
    const root = tempDir('ledger-c6');
    const path = join(root, 'spend.jsonl');
    seed(path, history(499.98));
    // All four reserve $0.01 in the same millisecond and 2 fit. Each reads a long ledger
    // before it appends, so without the lock all four see room and all four append.
    const start = Date.now() + 1500;
    const code = `
const { ledger } = L.openNodeLedger({ transport: 'live' });
while (Date.now() < ${start}) {}
try { await ledger.reserve({ bodyBytes: 0, maxTokens: 500 }); console.log('ok'); }
catch (e) { if (e.name !== 'SpendRefused') throw e; console.log('refused'); }
`;
    const env = envFor(join(root, 'home'), { SPEND_LEDGER: path });
    const results = await Promise.all([0, 1, 2, 3].map(() => child(code, env, root)));
    for (const r of results) expect(r.err).toBe('');
    const t = totals(readRows(path));
    expect(t.settled + t.reserved).toBeLessThanOrEqual(500 + 1e-9);
    expect(results.map((r) => r.out.trim()).sort()).toEqual(['ok', 'ok', 'refused', 'refused']);
  });

  it('exactly one of two concurrent batchStart(300) gets a grant; a killed batch counts until spend --close (case 12)', async () => {
    const root = tempDir('ledger-c12');
    const path = join(root, 'spend.jsonl');
    seed(path, history(100));
    const start = Date.now() + 1500;
    const code = `
const { ledger } = L.openNodeLedger({ transport: 'live' });
while (Date.now() < ${start}) {}
let grant;
try { grant = await ledger.batchStart(300); } catch (e) { if (e.name !== 'SpendRefused') throw e; console.log(JSON.stringify({ refused: true })); process.exit(0); }
await grant.reserve({ bodyBytes: 0, maxTokens: 250000 });
console.log(JSON.stringify({ batch_id: grant.batch_id }));
process.kill(process.pid, 'SIGKILL');
`;
    const env = envFor(join(root, 'home'), { SPEND_LEDGER: path });
    const results = await Promise.all([child(code, env, root), child(code, env, root)]);
    const outs = results.map((r) => JSON.parse(r.out) as { refused?: true; batch_id?: string });
    expect(outs.filter((o) => o.refused)).toHaveLength(1);
    const killed = results.find((r) => r.out.includes('batch_id'));
    expect(killed?.signal).toBe('SIGKILL');
    const batchId = outs.find((o) => o.batch_id)?.batch_id ?? '';

    // 100 settled + the dead batch at its 300 projection + 100 > 450.
    const { ledger } = openNodeLedger({ transport: 'live', env });
    await expect(ledger.batchStart(100)).rejects.toThrow(SpendRefused);
    const close = spendCli(['--close', batchId], env, root);
    expect(close.stderr).toBe('');
    expect(close.status).toBe(0);
    // The close keeps the dead batch's unsettled $5 reservation.
    const t = totals(readRows(path));
    expect(t.reserved).toBeCloseTo(5, 9);
    expect(t.exposure).toBeCloseTo(105, 9);
    assertGrant(await ledger.batchStart(100));
  });

  it('a restarted process re-reads settled, unsettled reservations and open projections (case 10)', async () => {
    const root = tempDir('ledger-c10');
    const path = join(root, 'spend.jsonl');
    seed(path, [settleRow(7, 'seed')]);
    const env = envFor(join(root, 'home'), { SPEND_LEDGER: path });
    const r = await child(`
const { ledger } = L.openNodeLedger({ transport: 'live' });
const grant = await ledger.batchStart(40);
await grant.reserve({ bodyBytes: 0, maxTokens: 150000 });
`, env, root);
    expect(r.code).toBe(0);
    const t = await openNodeLedger({ transport: 'offline', env }).ledger.totals();
    expect(t.settled).toBeCloseTo(7, 9);
    expect(t.reserved).toBeCloseTo(3, 9);
    expect(t.open).toEqual([expect.objectContaining({ projection: 40, host: hostname() })]);
    expect(t.exposure).toBeCloseTo(47, 9);
  });

  it('breaks a lock left by a dead process on this host', async () => {
    const root = tempDir('ledger-stale');
    const path = join(root, 'spend.jsonl');
    seed(path, []);
    const dead = spawn(process.execPath, ['-e', '']);
    await new Promise((r) => dead.on('close', r));
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: dead.pid, host: hostname() }));
    const { ledger } = openNodeLedger({ transport: 'live', env: envFor(join(root, 'home'), { SPEND_LEDGER: path }) });
    assertGrant(await ledger.batchStart(1));
    expect(existsSync(`${path}.lock`)).toBe(false);
  });
});

describe('spend command', () => {
  it('--ingest of the same browser rows twice leaves the total unchanged (case 8)', () => {
    const root = tempDir('ledger-c8');
    const path = join(root, 'spend.jsonl');
    seed(path, [settleRow(1, 'seed')]);
    const browser = join(root, 'browser.jsonl');
    write(root, 'browser.jsonl', [settleRow(0.25, 'b-1', 'browser'), settleRow(0.5, 'b-2', 'browser')].map((r) => JSON.stringify(r)).join('\n') + '\n');
    const env = envFor(join(root, 'home'), { SPEND_LEDGER: path });
    const first = spendCli(['--ingest', browser], env, root);
    expect(first.stdout).toContain('ingested 2 of 2 rows');
    const after = totals(readRows(path)).settled;
    expect(after).toBeCloseTo(1.75, 9);
    const second = spendCli(['--ingest', browser], env, root);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('ingested 0 of 2 rows');
    expect(totals(readRows(path)).settled).toBe(after);
    expect(readRows(path)).toHaveLength(3);
  });

  it('--export writes a byte-equal copy (case 9)', () => {
    const root = tempDir('ledger-c9');
    const path = join(root, 'spend.jsonl');
    seed(path, [settleRow(1, 'a'), settleRow(2.5, 'b')]);
    const out = join(root, 'results', 'spend.jsonl');
    const r = spendCli(['--export', out], envFor(join(root, 'home'), { SPEND_LEDGER: path }), root);
    expect(r.status).toBe(0);
    expect(readFileSync(out).equals(readFileSync(path))).toBe(true);
  });

  it('reserveSpend and settleSpend meter a call for a Playwright spec’s Node side', async () => {
    const root = tempDir('ledger-pw');
    const path = join(root, 'spend.jsonl');
    const { ledger } = openNodeLedger({ transport: 'live', env: envFor(join(root, 'home'), { SPEND_LEDGER: path }) });
    const grant = await ledger.batchStart(1);
    const res = await reserveSpend(grant, { bodyBytes: 100, maxTokens: 100, trial: 'spec' });
    await settleSpend(grant, res, { input_tokens: 100, output_tokens: 10 });
    await expect(reserveSpend({ ...grant }, { bodyBytes: 1, maxTokens: 1 })).rejects.toThrow(/grant/);
    expect(readRows(path).map((r) => r.kind)).toEqual(['open', 'reserve', 'settle']);
  });
});

describe('spend --check --final-reserve (case 16)', () => {
  const reserve = 60 * 6 * 1.15 + AUDITOR_ALLOWANCE_USD;

  it('with no runs prints 60 x $6 x 1.15 plus the auditor allowance and exits 1 exactly above $450', () => {
    for (const [seeded, status] of [
      [450 - 10 - reserve, 0],
      [450 - 10 - reserve + 0.01, 1],
    ] as const) {
      const root = tempDir('ledger-c16');
      const path = join(root, 'spend.jsonl');
      seed(path, [settleRow(seeded, 'seed')]);
      const r = spendCli(['--check', '--projected', '10', '--final-reserve'], envFor(join(root, 'home'), { SPEND_LEDGER: path }), root);
      expect(r.stdout).toContain('6 tasks without data x 10 trials x $6.00');
      expect(r.stdout).toContain(`auditor allowance $${AUDITOR_ALLOWANCE_USD.toFixed(2)}`);
      expect(r.stdout).toMatch(new RegExp(`final-run reserve\\s+\\$${reserve.toFixed(2)}`));
      expect(r.stdout).toMatch(/projected\s+\$10\.00/);
      expect(r.stdout).toMatch(new RegExp(`total\\s+\\$${(seeded + 10 + reserve).toFixed(2)}`));
      expect(r.status, r.stdout + r.stderr).toBe(status);
    }
  });

  it('with a --cost-from run holding all 6 tasks uses their p90', () => {
    const root = tempDir('ledger-c16b');
    const path = join(root, 'spend.jsonl');
    seed(path, []);
    for (let t = 1; t <= 6; t++)
      for (let n = 1; n <= 10; n++)
        write(root, `results/pilot-2/trials/T${t}/${n}.json`, JSON.stringify({ task_id: `T${t}`, task_version: `T${t}-v1`, cost_usd: n / 5, started: `2026-10-23T00:00:${n}Z`, outcome: 'PASS' }));
    // One valid and one ENV_ERROR trial of T1 already in the final run.
    write(root, 'results/runs/final-1/trials/T1/1.json', JSON.stringify({ task_id: 'T1', task_version: 'T1-v1', cost_usd: 1, outcome: 'FAIL' }));
    write(root, 'results/runs/final-1/trials/T1/2.json', JSON.stringify({ task_id: 'T1', task_version: 'T1-v1', cost_usd: 1, outcome: 'ENV_ERROR' }));
    const r = spendCli(['--check', '--projected', '0', '--final-reserve', '--cost-from', 'results/pilot-2'], envFor(join(root, 'home'), { SPEND_LEDGER: path }), root);
    // p90 of 0.2..2.0 is 1.8; 59 trials remain.
    const expected = 59 * 1.8 * 1.15 + AUDITOR_ALLOWANCE_USD;
    expect(r.stdout).toContain('T1: 9 trials x $1.80 per trial (p90 of 10 trials of T1-v1 in results/pilot-2)');
    expect(r.stdout).toMatch(new RegExp(`total\\s+\\$${expected.toFixed(2)}`));
    expect(r.status).toBe(0);
  });
});
