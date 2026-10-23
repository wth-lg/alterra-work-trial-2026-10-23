// Grant binding per open, real-path ledger identity, an own-run ledger that must already exist,
// and a per-call refusal at the actual cap. Grant policy is process-wide state, so every case
// that depends on it runs in a fresh child process.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { repoRoot, tempDir } from '../../../scripts/test/helpers.ts';
import { SpendRefused, totals, type LedgerRow } from '../../../packages/core/ledger.ts';
import { worstCaseUsd } from '../../../packages/core/cost.ts';
import { openNodeLedger, readRows } from '../ledger-node.ts';

const ADAPTER = JSON.stringify(pathToFileURL(join(repoRoot, 'cli/adapters/ledger-node.ts')).href);
const CORE = JSON.stringify(pathToFileURL(join(repoRoot, 'packages/core/ledger.ts')).href);

type Env = Record<string, string | undefined>;

function envFor(home: string, extra: Env = {}): Env {
  return { HOME: home, SPEND_LEDGER: undefined, CHARTR_CANONICAL_LEDGER: undefined, ...extra };
}

// Runs `code` as an ES module in a child process with C bound to the core ledger module; the
// adapter is not imported unless the code imports it.
function child(code: string, env: Env, cwd: string): Promise<{ code: number | null; out: string; err: string }> {
  const full: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ANTHROPIC_API_KEY: undefined, ...env })) if (v !== undefined) full[k] = v;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', `const C = await import(${CORE});\n${code}`], { cwd, env: full });
    let out = '';
    let err = '';
    p.stdout.on('data', (d: Buffer) => (out += d.toString()));
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('close', (code) => resolve({ code, out, err }));
  });
}

function settleRow(usd: number, call_id: string): LedgerRow {
  return { ts: '2026-10-22T00:00:00.000Z', call_id, kind: 'settle', source: 'node', run_id: 'seed', batch_id: null, trial: null, usage: null, cost_usd: usd };
}

function seed(path: string, rows: LedgerRow[]): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r) + '\n').join(''));
}

describe('ledger identity is the real path', () => {
  it('a symlink to the ledger file takes the same lock as the real path', async () => {
    const root = tempDir('real-lock');
    const real = join(root, 'real', 'spend.jsonl');
    seed(real, []);
    mkdirSync(join(root, 'alias'));
    const alias = join(root, 'alias', 'spend.jsonl');
    symlinkSync(real, alias);
    const viaAlias = openNodeLedger({ transport: 'live', env: envFor(join(root, 'home'), { SPEND_LEDGER: alias }) });
    const viaReal = openNodeLedger({ transport: 'live', env: envFor(join(root, 'home'), { SPEND_LEDGER: real }) });
    expect(viaAlias.store.path).toBe(realpathSync(real));
    expect(viaReal.store.path).toBe(realpathSync(real));

    // Hold the lock through the real path, as a live process on this host would.
    const lock = `${realpathSync(real)}.lock`;
    mkdirSync(lock);
    const holder = join(lock, 'holder-test');
    writeFileSync(holder, JSON.stringify({ pid: process.pid, host: hostname(), ts: 'now' }));
    let done = false;
    const tx = viaAlias.store.transact(() => ({ append: [], result: undefined })).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    unlinkSync(holder);
    await tx;
    expect(done).toBe(true);
    expect(existsSync(`${alias}.lock`)).toBe(false);
  });

  it('4 processes on the real path and 4 on a symlink, with room for 1 reservation, make exactly 1', async () => {
    const root = tempDir('real-race');
    const real = join(root, 'real', 'spend.jsonl');
    const w = worstCaseUsd({ bodyBytes: 0, maxTokens: 1_000_000 });
    // Room for 1: with one lock per name, the first process under each name sees room and
    // appends, so 2 reservations land.
    seed(real, Array.from({ length: 10_000 }, (_, i) => settleRow((500 - 1.5 * w) / 10_000, `seed-${i}`)));
    mkdirSync(join(root, 'alias'));
    const alias = join(root, 'alias', 'spend.jsonl');
    symlinkSync(real, alias);
    const start = Date.now() + 1500;
    const code = `
const L = await import(${ADAPTER});
const { ledger } = L.openNodeLedger({ transport: 'live' });
while (Date.now() < ${start}) {}
try { await ledger.reserve({ bodyBytes: 0, maxTokens: 1000000 }); console.log('ok'); }
catch (e) { if (e.name !== 'SpendRefused') throw e; console.log('refused'); }
`;
    const runs = [real, alias].flatMap((p) => [0, 1, 2, 3].map(() => child(code, envFor(join(root, 'home'), { SPEND_LEDGER: p }), root)));
    const results = await Promise.all(runs);
    for (const r of results) expect(r.err).toBe('');
    expect(results.filter((r) => r.out.trim() === 'ok')).toHaveLength(1);
    const t = totals(readRows(real));
    expect(readRows(real).filter((x) => x.kind === 'reserve')).toHaveLength(1);
    expect(t.settled + t.reserved).toBeLessThanOrEqual(500 + 1e-9);
  });
});

describe('a refusal at the actual cap', () => {
  it('for one call whose own worst case crosses $500 throws for that call only; the grant and its in-flight call go on', async () => {
    const root = tempDir('per-call-refusal');
    const path = join(root, 'spend.jsonl');
    const { ledger } = openNodeLedger({ transport: 'live', env: envFor(join(root, 'home'), { SPEND_LEDGER: path }) });
    const grant = await ledger.batchStart(50);
    type Done = { usage: { input_tokens: number; output_tokens: number } };
    let finish: (v: Done) => void = () => {};
    let inFlightSignal: AbortSignal | undefined;
    const inFlight = grant.metered({ bodyBytes: 100, maxTokens: 1000 }, (signal) => {
      inFlightSignal = signal;
      return new Promise<Done>((resolve) => (finish = resolve));
    });
    await new Promise((r) => setTimeout(r, 50));
    // 30M max tokens is a $600 worst case on its own.
    await expect(grant.reserve({ bodyBytes: 0, maxTokens: 30_000_000 })).rejects.toThrow(SpendRefused);
    expect(grant.signal.aborted).toBe(false);
    expect(inFlightSignal?.aborted).toBe(false);
    finish({ usage: { input_tokens: 100, output_tokens: 10 } });
    await inFlight;
    await grant.metered({ bodyBytes: 10, maxTokens: 10 }, async () => ({ usage: { input_tokens: 10, output_tokens: 1 } }));
    const t = totals(readRows(path));
    expect(t.reserved).toBe(0);
    expect(t.settled).toBeCloseTo((100 * 4 + 10 * 20 + 10 * 4 + 1 * 20) / 1e6, 9);
  });
});
