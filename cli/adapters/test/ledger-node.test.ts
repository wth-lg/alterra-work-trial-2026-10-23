import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { repoRoot, runScript, tempDir, write } from '../../../scripts/test/helpers.ts';
import { ACTUAL_CAP_USD, assertGrant, PROJECTED_CAP_USD, SpendRefused, totals, type LedgerRow } from '../../../packages/core/ledger.ts';
import { AUDITOR_ALLOWANCE_USD, worstCaseUsd } from '../../../packages/core/cost.ts';
import { openNodeLedger, readRows, reserveSpend, resolveLedgerPath, settleSpend } from '../ledger-node.ts';

const ADAPTER = pathToFileURL(join(repoRoot, 'cli/adapters/ledger-node.ts')).href;
const CORE = pathToFileURL(join(repoRoot, 'packages/core/ledger.ts')).href;

// Every test names its ledger, so none reads the shell's settings or this machine's ledger.
function envFor(home: string, extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return { HOME: home, SPEND_LEDGER: undefined, CLINENV_CANONICAL_LEDGER: undefined, ...extra };
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

function reserveRow(usd: number, call_id: string, source: 'node' | 'browser' = 'node'): LedgerRow {
  return { ...settleRow(usd, call_id, source), kind: 'reserve' };
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
    expect(existsSync(join(root, 'home', '.clinenv'))).toBe(false);
  });

  it('default mode uses ~/.clinenv/spend.jsonl, creates it on a live open and keeps the caps (case 2)', async () => {
    const home = tempDir('ledger-c2');
    const where = spendCli(['--where'], envFor(home), home);
    expect(where.stdout).toBe(`default ${join(home, '.clinenv', 'spend.jsonl')}\n`);
    expect(where.status).toBe(0);

    const path = join(home, '.clinenv', 'spend.jsonl');
    expect(existsSync(path)).toBe(false);
    const { ledger, mode } = openNodeLedger({ transport: 'live', env: envFor(home) });
    expect(mode).toBe('default');
    expect(existsSync(path)).toBe(true);
    let calls = 0;
    await expect(ledger.batchStart(PROJECTED_CAP_USD + 0.01).then(() => calls++)).rejects.toThrow(SpendRefused);
    expect(calls).toBe(0);
    expect(readRows(path)).toEqual([]);
  });

  it('own-run mode reads the path only from the marker and refuses a bad setup with 0 calls (case 3)', async () => {
    const root = tempDir('ledger-c3');
    const marker = join(root, 'canon', 'spend.jsonl');
    mkdirSync(join(root, 'canon'));
    writeFileSync(marker, '');
    const home = join(root, 'home');

    const r = await child(ONE_CALL, envFor(home, { CLINENV_CANONICAL_LEDGER: marker }), root);
    expect(r.code).toBe(0);
    expect(readRows(marker)).toHaveLength(4);
    expect(spendCli(['--where'], envFor(home, { CLINENV_CANONICAL_LEDGER: marker }), root).stdout).toBe(`own-run ${marker}\n`);
    // SPEND_LEDGER naming the same file is consistent.
    expect(resolveLedgerPath(envFor(home, { CLINENV_CANONICAL_LEDGER: marker, SPEND_LEDGER: marker })).problems).toEqual([]);

    const bad: Array<[string, Record<string, string>]> = [
      ['SPEND_LEDGER names another path', { CLINENV_CANONICAL_LEDGER: marker, SPEND_LEDGER: '/tmp/x' }],
      ['marker directory is missing', { CLINENV_CANONICAL_LEDGER: join(root, 'gone', 'spend.jsonl') }],
      ['marker is not absolute', { CLINENV_CANONICAL_LEDGER: 'canon/spend.jsonl' }],
    ];
    for (const [why, extra] of bad) {
      let calls = 0;
      expect(() => {
        openNodeLedger({ transport: 'live', env: envFor(home, extra) });
        calls++;
      }, why).toThrow(/CLINENV_CANONICAL_LEDGER/);
      expect(calls, why).toBe(0);
      expect(spendCli(['--where'], envFor(home, extra), root).status, why).toBe(1);
    }
    expect(existsSync(join(root, 'gone'))).toBe(false);
    expect(existsSync('/tmp/x') && readFileSync('/tmp/x', 'utf8').includes('"kind"')).toBe(false);
    expect(existsSync(join(home, '.clinenv'))).toBe(false);
  });
});

describe('cross-process caps', () => {
  it('4 concurrent processes near the actual cap never take settled + reserved past it (case 6)', async () => {
    const root = tempDir('ledger-c6');
    const path = join(root, 'spend.jsonl');
    // Each reservation's worst case is w; the seeded room fits exactly 2 of them.
    const w = worstCaseUsd({ bodyBytes: 0, maxTokens: 500 });
    seed(path, history(ACTUAL_CAP_USD - 2.1 * w));
    // All four reserve in the same millisecond and 2 fit. Each reads a long ledger before it
    // appends, so without the lock all four see room and all four append.
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
    expect(t.settled + t.reserved).toBeLessThanOrEqual(ACTUAL_CAP_USD + 1e-9);
    expect(results.map((r) => r.out.trim()).sort()).toEqual(['ok', 'ok', 'refused', 'refused']);
  });

  it('exactly one of two concurrent batchStarts that each fit alone gets a grant; a killed batch counts until spend --close (case 12)', async () => {
    const root = tempDir('ledger-c12');
    const path = join(root, 'spend.jsonl');
    seed(path, history(100));
    // One batch fits under the projected cap; two do not.
    const projection = 0.6 * (PROJECTED_CAP_USD - 100);
    const start = Date.now() + 1500;
    const code = `
const { ledger } = L.openNodeLedger({ transport: 'live' });
while (Date.now() < ${start}) {}
let grant;
try { grant = await ledger.batchStart(${projection}); } catch (e) { if (e.name !== 'SpendRefused') throw e; console.log(JSON.stringify({ refused: true })); process.exit(0); }
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

    // 100 settled + the dead batch at its projection + the rest of the projected cap and a cent.
    const { ledger } = openNodeLedger({ transport: 'live', env });
    await expect(ledger.batchStart(PROJECTED_CAP_USD - 100 - projection + 0.01)).rejects.toThrow(SpendRefused);
    const close = spendCli(['--close', batchId], env, root);
    expect(close.stderr).toBe('');
    expect(close.status).toBe(0);
    // The close keeps the dead batch's unsettled reservation (max_tokens 250,000: about $5).
    const w = worstCaseUsd({ bodyBytes: 0, maxTokens: 250_000 });
    const t = totals(readRows(path));
    expect(t.reserved).toBeCloseTo(w, 9);
    expect(t.exposure).toBeCloseTo(100 + w, 9);
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
    const w = worstCaseUsd({ bodyBytes: 0, maxTokens: 150_000 });
    expect(t.reserved).toBeCloseTo(w, 9);
    expect(t.open).toEqual([expect.objectContaining({ projection: 40, host: hostname() })]);
    // The open batch counts at max(projection 40, its own reserved w).
    expect(t.exposure).toBeCloseTo(7 + 40, 9);
  });

  it('breaks a lock left by a dead process on this host', async () => {
    const root = tempDir('ledger-stale');
    const path = join(root, 'spend.jsonl');
    seed(path, []);
    await deadHolder(root, path);
    expect(readdirSync(`${path}.lock`)).toHaveLength(1);
    const { ledger } = openNodeLedger({ transport: 'live', env: envFor(join(root, 'home'), { SPEND_LEDGER: path }) });
    assertGrant(await ledger.batchStart(1));
    // Released: the lock directory is empty, and no candidate directory is left behind.
    expect(readdirSync(`${path}.lock`)).toEqual([]);
    expect(readdirSync(root).filter((f) => f.includes('.candidate-'))).toEqual([]);
  });
});

describe('spend command', () => {
  it('--ingest of the same browser rows twice leaves the total unchanged (case 8)', () => {
    const root = tempDir('ledger-c8');
    const path = join(root, 'spend.jsonl');
    seed(path, [settleRow(1, 'seed')]);
    const browser = join(root, 'browser.jsonl');
    const rows = [reserveRow(0.3, 'b-1', 'browser'), settleRow(0.25, 'b-1', 'browser'), reserveRow(0.6, 'b-2', 'browser'), settleRow(0.5, 'b-2', 'browser')];
    write(root, 'browser.jsonl', rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    const env = envFor(join(root, 'home'), { SPEND_LEDGER: path });
    const first = spendCli(['--ingest', browser], env, root);
    expect(first.stdout).toContain('ingested 4 of 4 rows');
    const after = totals(readRows(path)).settled;
    expect(after).toBeCloseTo(1.75, 9);
    const second = spendCli(['--ingest', browser], env, root);
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('ingested 0 of 4 rows');
    expect(totals(readRows(path)).settled).toBe(after);
    expect(readRows(path)).toHaveLength(5);
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

  it('with no runs prints 60 x $6 x 1.15 plus the auditor allowance and exits 1 exactly above the projected cap', () => {
    for (const [seeded, status] of [
      [PROJECTED_CAP_USD - 10 - reserve, 0],
      [PROJECTED_CAP_USD - 10 - reserve + 0.01, 1],
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
    for (let t = 1; t <= 6; t++) write(root, `tasks/T${t}/task.toml`, `id = "T${t}"\n`);
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

describe('fixes for the P1 findings', () => {
  it('an empty CLINENV_CANONICAL_LEDGER is an error, not default mode', () => {
    const home = tempDir('ledger-empty-marker');
    const env = envFor(home, { CLINENV_CANONICAL_LEDGER: '' });
    expect(resolveLedgerPath(env).problems).not.toEqual([]);
    expect(() => openNodeLedger({ transport: 'live', env })).toThrow(/CLINENV_CANONICAL_LEDGER/);
    const where = spendCli(['--where'], env, home);
    expect(where.status).toBe(1);
    expect(where.stdout).not.toContain('default');
    expect(existsSync(join(home, '.clinenv'))).toBe(false);
  });

  it('in own-run mode only a grant from the canonical ledger passes assertGrant', async () => {
    const root = tempDir('ledger-bound');
    const marker = join(root, 'canon', 'spend.jsonl');
    mkdirSync(join(root, 'canon'));
    writeFileSync(marker, '');
    const shadowPath = join(root, 'shadow', 'spend.jsonl');
    const home = join(root, 'home');
    const r = await child(`
const C = await import(${JSON.stringify(CORE)});
const out = [];
const check = (name, g) => { try { C.assertGrant(g); out.push(name + ' passed'); } catch { out.push(name + ' refused'); } };
const { ledger } = L.openNodeLedger({ transport: 'live' });
check('canonical', await ledger.batchStart(1));
const other = L.openNodeLedger({ transport: 'live', env: { HOME: ${JSON.stringify(home)}, SPEND_LEDGER: ${JSON.stringify(shadowPath)} } }).ledger;
const g = await other.batchStart(1);
check('SPEND_LEDGER', g);
const rows = [];
const memStore = { transact: async (fn) => { const r = fn(rows); rows.push(...r.append); return r.result; }, read: async () => rows };
C.admitStore(memStore);
const mem = C.createLedger({ store: memStore,
  clock: { now: () => 't' }, newId: () => 'm1', source: 'node', runId: null, pid: 1, host: 'h', isAlive: () => true });
check('memory', await mem.batchStart(1));
try { await L.reserveSpend(g, { bodyBytes: 1, maxTokens: 1 }); out.push('reserveSpend passed'); } catch { out.push('reserveSpend refused'); }
console.log(JSON.stringify(out));
`, envFor(home, { CLINENV_CANONICAL_LEDGER: marker }), root);
    expect(r.err).toBe('');
    expect(JSON.parse(r.out)).toEqual(['canonical passed', 'SPEND_LEDGER refused', 'memory refused', 'reserveSpend refused']);
    expect(readRows(shadowPath).map((x) => x.kind)).toEqual(['open']);
  });

  it('spend --close refuses a batch whose pid is alive on this host; --force records the reason and the grant stops reserving', async () => {
    const root = tempDir('ledger-close-live');
    const path = join(root, 'spend.jsonl');
    seed(path, [settleRow(100, 'seed')]);
    const env = envFor(join(root, 'home'), { SPEND_LEDGER: path });
    const go = join(root, 'go');
    const running = child(`
const { ledger } = L.openNodeLedger({ transport: 'live' });
const grant = await ledger.batchStart(300);
console.log(grant.batch_id);
const { existsSync } = await import('node:fs');
while (!existsSync(${JSON.stringify(go)})) await new Promise((r) => setTimeout(r, 20));
try { await grant.reserve({ bodyBytes: 1, maxTokens: 1 }); console.log('reserve ok'); } catch (e) { console.log('reserve refused: ' + e.message); }
`, env, root);
    let batchId = '';
    for (let i = 0; i < 500 && batchId === ''; i++) {
      await new Promise((r) => setTimeout(r, 20));
      const open = readRows(path).find((x) => x.kind === 'open');
      batchId = open?.batch_id ?? '';
    }
    expect(batchId).not.toBe('');

    const refused = spendCli(['--close', batchId], env, root);
    expect(refused.status).toBe(1);
    expect(refused.stderr).toMatch(/alive/);
    expect(readRows(path).filter((x) => x.kind === 'close')).toEqual([]);

    const forced = spendCli(['--close', batchId, '--force', 'runner hung, verifier closing'], env, root);
    expect(forced.stderr).toBe('');
    expect(forced.status).toBe(0);
    expect(readRows(path).find((x) => x.kind === 'close')?.reason).toBe('runner hung, verifier closing');
    writeFileSync(go, '');
    const r = await running;
    expect(r.out).toMatch(/reserve refused: .*closed/);
    expect(readRows(path).filter((x) => x.kind === 'reserve')).toEqual([]);
  });

  it('--force goes only with --close and needs a reason', () => {
    const root = tempDir('ledger-force-usage');
    const env = envFor(join(root, 'home'), { SPEND_LEDGER: join(root, 'spend.jsonl') });
    expect(spendCli(['--force', 'why'], env, root).status).toBe(2);
    expect(spendCli(['--close', 'b', '--force', ''], env, root).status).toBe(2);
  });

  it('--ingest refuses node rows and settles for calls the browser did not reserve, leaving the ledger as it was', () => {
    const root = tempDir('ledger-ingest-forged');
    const path = join(root, 'spend.jsonl');
    seed(path, [settleRow(1, 'seed'), reserveRow(20, 'node-inflight')]);
    const env = envFor(join(root, 'home'), { SPEND_LEDGER: path });
    const before = readFileSync(path);
    for (const [why, rows] of [
      ['node row', [settleRow(0, 'x-1', 'node')]],
      ['settle for a node call', [settleRow(0, 'node-inflight', 'browser')]],
      ['settle with no reservation', [settleRow(0, 'b-9', 'browser')]],
    ] as const) {
      write(root, 'forged.jsonl', rows.map((x) => JSON.stringify(x)).join('\n') + '\n');
      const r = spendCli(['--ingest', join(root, 'forged.jsonl')], env, root);
      expect(r.status, why).toBe(1);
      expect(r.stderr, why).toMatch(/spend: /);
      expect(readFileSync(path).equals(before), why).toBe(true);
    }
  });

  it('ignores and quarantines a torn last line with a warning; any other malformed line still fails closed', async () => {
    const root = tempDir('ledger-torn');
    const path = join(root, 'spend.jsonl');
    seed(path, [settleRow(7, 'a'), settleRow(1, 'b')]);
    const torn = JSON.stringify(settleRow(4, 'c')).slice(0, -12);
    appendFileSync(path, torn);
    expect(totals(readRows(path)).settled).toBeCloseTo(8, 9);

    const env = envFor(join(root, 'home'), { SPEND_LEDGER: path });
    const r = await child(`
const { ledger } = L.openNodeLedger({ transport: 'live' });
const g = await ledger.batchStart(1);
console.log(g.batch_id);
`, env, root);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/torn/);
    expect(readRows(path).map((x) => x.kind)).toEqual(['settle', 'settle', 'open']);
    const quarantined = readdirSync(root).filter((f) => f.startsWith('spend.jsonl.torn'));
    expect(quarantined).toHaveLength(1);
    expect(readFileSync(join(root, quarantined[0] as string), 'utf8')).toBe(torn);

    // A complete last row without its newline is kept, and the next row starts on a new line.
    const whole = join(root, 'whole.jsonl');
    writeFileSync(whole, JSON.stringify(settleRow(2, 'w1')));
    const w = await child(`await L.openNodeLedger({ transport: 'live' }).ledger.batchStart(1);`, envFor(join(root, 'home'), { SPEND_LEDGER: whole }), root);
    expect(w.code).toBe(0);
    expect(readRows(whole).map((x) => x.kind)).toEqual(['settle', 'open']);

    // A bad line that is not the torn tail is not skipped.
    const bad = join(root, 'bad.jsonl');
    writeFileSync(bad, `${JSON.stringify(settleRow(1, 'x'))}\n{"half":\n${JSON.stringify(settleRow(1, 'y'))}\n`);
    expect(() => readRows(bad)).toThrow(/bad\.jsonl:2/);
    // A torn tail that follows a newline-terminated bad line does not hide it either.
    writeFileSync(bad, `{"kind":"settle"}\n${torn}`);
    expect(() => readRows(bad)).toThrow(/bad\.jsonl:1/);
  });
});

// Runs `code` in a child that waits for `start`, holds the ledger lock for `holdMs` inside a
// transaction and reports whether anyone else was inside at the same time (an `inside` file
// created with O_EXCL stands for the critical section).
function lockClient(root: string, path: string, opts: { start: number; holdMs: number; times?: number; slowRead?: boolean }) {
  const inside = join(root, 'inside');
  return child(`
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
if (${opts.slowRead === true}) {
  // A breaker that stalls after it has read who holds the lock and before it acts on it.
  const read = fs.readFileSync;
  fs.readFileSync = function (p, ...a) { const r = read.call(this, p, ...a); if (String(p).includes('.lock')) sleep(400); return r; };
  syncBuiltinESMExports();
}
const store = new L.FileLedgerStore(${JSON.stringify(path)}, { createDir: false });
while (Date.now() < ${opts.start}) {}
let overlaps = 0;
for (let i = 0; i < ${opts.times ?? 1}; i++) {
  await store.transact(() => {
    try { fs.closeSync(fs.openSync(${JSON.stringify(inside)}, 'wx')); } catch { overlaps++; return { append: [], result: 0 }; }
    sleep(${opts.holdMs});
    fs.unlinkSync(${JSON.stringify(inside)});
    return { append: [], result: 0 };
  });
}
console.log(JSON.stringify({ overlaps }));
`, envFor(join(root, 'home')), root);
}

// Leaves the ledger lock held by a process that is dead.
async function deadHolder(root: string, path: string): Promise<void> {
  const r = await child(`
const store = new L.FileLedgerStore(${JSON.stringify(path)}, { createDir: false });
await store.transact(() => { process.kill(process.pid, 'SIGKILL'); return { append: [], result: 0 }; });
`, envFor(join(root, 'home')), root);
  expect(r.signal).toBe('SIGKILL');
}

describe('stale lock', () => {
  it('4 contenders and a dead holder: exactly one owner at a time', async () => {
    const root = tempDir('ledger-lock4');
    const path = join(root, 'spend.jsonl');
    seed(path, []);
    for (let round = 0; round < 3; round++) {
      await deadHolder(root, path);
      const start = Date.now() + 1000;
      const results = await Promise.all([0, 1, 2, 3].map(() => lockClient(root, path, { start, holdMs: 5, times: 5 })));
      for (const r of results) {
        expect(r.err).toBe('');
        expect(JSON.parse(r.out)).toEqual({ overlaps: 0 });
      }
    }
  });

  it('a breaker that stalls between judging the dead holder and removing its lock cannot unseat the next owner', async () => {
    const root = tempDir('ledger-lock-slow');
    const path = join(root, 'spend.jsonl');
    seed(path, []);
    await deadHolder(root, path);
    const t0 = Date.now() + 1000;
    const [slow, first, third] = await Promise.all([
      lockClient(root, path, { start: t0, holdMs: 50, slowRead: true }),
      lockClient(root, path, { start: t0 + 100, holdMs: 1500 }),
      lockClient(root, path, { start: t0 + 200, holdMs: 50 }),
    ]);
    for (const r of [slow, first, third]) expect(r.err).toBe('');
    expect([slow, first, third].map((r) => JSON.parse(r.out))).toEqual([{ overlaps: 0 }, { overlaps: 0 }, { overlaps: 0 }]);
  });
});
