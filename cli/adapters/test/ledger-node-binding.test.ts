// Grant binding per open, real-path ledger identity, an own-run ledger that must already exist,
// and a per-call refusal at the actual cap. Grant policy is process-wide state, so every case
// that depends on it runs in a fresh child process.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { repoRoot, runScript, tempDir } from '../../../scripts/test/helpers.ts';
import { SpendRefused, totals, type LedgerRow } from '../../../packages/core/ledger.ts';
import { worstCaseUsd } from '../../../packages/core/cost.ts';
import { openNodeLedger, readRows } from '../ledger-node.ts';

const ADAPTER = JSON.stringify(pathToFileURL(join(repoRoot, 'cli/adapters/ledger-node.ts')).href);
const CORE = JSON.stringify(pathToFileURL(join(repoRoot, 'packages/core/ledger.ts')).href);

type Env = Record<string, string | undefined>;

function envFor(home: string, extra: Env = {}): Env {
  return { HOME: home, SPEND_LEDGER: undefined, CLINENV_CANONICAL_LEDGER: undefined, ...extra };
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

function spendCli(args: string[], env: Env, cwd: string) {
  return runScript('cli/index.ts', ['spend', ...args], { cwd, env });
}

function settleRow(usd: number, call_id: string): LedgerRow {
  return { ts: '2026-10-22T00:00:00.000Z', call_id, kind: 'settle', source: 'node', run_id: 'seed', batch_id: null, trial: null, usage: null, cost_usd: usd };
}

function seed(path: string, rows: LedgerRow[]): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r) + '\n').join(''));
}

// Child-side helpers: `check(g)` reports whether a grant passes assertGrant, and `memLedger()`
// builds a ledger over an in-memory store, admitted the way an adapter admits its own.
const HELPERS = `
const check = (g, ledger) => { try { ledger === undefined ? C.assertGrant(g) : C.assertClientGrant(g, ledger); return 'passes'; } catch { return 'throws'; } };
const memLedger = () => {
  const rows = [];
  const store = { transact: async (fn) => { const r = fn(rows); rows.push(...r.append); return r.result; }, read: async () => rows };
  C.admitStore?.(store);
  return C.createLedger({ store, clock: { now: () => 't' }, newId: () => crypto.randomUUID(), source: 'node', runId: null, pid: 1, host: 'h', isAlive: () => true });
};
const out = {};
`;

describe('grant binding is decided by each open, from the env that opened it', () => {
  it('an own-run open through opts.env leaves only canonical grants passing, whichever ledger minted the others and when', async () => {
    const root = tempDir('bind-optsenv');
    const canon = join(root, 'canon', 'spend.jsonl');
    seed(canon, [settleRow(449, 'seed')]);
    const shadow = join(root, 'shadow', 'spend.jsonl');
    const home = join(root, 'home');
    const r = await child(`
const L = await import(${ADAPTER});
${HELPERS}
const shadowEnv = { HOME: ${JSON.stringify(home)}, SPEND_LEDGER: ${JSON.stringify(shadow)} };
const shadowLedger = L.openNodeLedger({ transport: 'live', env: shadowEnv }).ledger;
const before = await shadowLedger.batchStart(1);
out.defaultBeforeOwnRun = check(before);
const { ledger } = L.openNodeLedger({ transport: 'live', env: { HOME: ${JSON.stringify(home)}, CLINENV_CANONICAL_LEDGER: ${JSON.stringify(canon)} } });
try { await ledger.batchStart(10); out.canonicalAt449 = 'granted'; } catch (e) { out.canonicalAt449 = e.name; }
const g = await ledger.batchStart(0.5);
out.canonical = check(g);
out.canonicalClient = check(g, ledger);
out.canonicalClientOtherLedger = check(g, shadowLedger);
out.defaultMintedBefore = check(before);
out.defaultMintedAfter = check(await L.openNodeLedger({ transport: 'live', env: shadowEnv }).ledger.batchStart(1));
const mem = memLedger();
const mg = await mem.batchStart(1);
out.memory = check(mg);
out.memoryClient = check(mg, mem);
try { await L.reserveSpend(before, { bodyBytes: 1, maxTokens: 1 }); out.reserveSpend = 'reserved'; } catch { out.reserveSpend = 'refused'; }
let sends = 0;
try { await before.metered({ bodyBytes: 1, maxTokens: 1 }, async () => { sends++; return { usage: null }; }); } catch {}
out.sends = sends;
console.log(JSON.stringify(out));
`, envFor(home), root);
    expect(r.err).toBe('');
    expect(JSON.parse(r.out)).toEqual({
      defaultBeforeOwnRun: 'passes',
      canonicalAt449: 'SpendRefused',
      canonical: 'passes',
      canonicalClient: 'passes',
      canonicalClientOtherLedger: 'throws',
      defaultMintedBefore: 'throws',
      defaultMintedAfter: 'throws',
      memory: 'throws',
      memoryClient: 'throws',
      reserveSpend: 'refused',
      sends: 0,
    });
    expect(readRows(shadow).filter((x) => x.kind === 'reserve')).toEqual([]);
  });

  it('a marker set in process.env after the adapter loaded binds the next open', async () => {
    const root = tempDir('bind-late');
    const canon = join(root, 'canon', 'spend.jsonl');
    seed(canon, [settleRow(449, 'seed')]);
    const shadow = join(root, 'shadow', 'spend.jsonl');
    const home = join(root, 'home');
    const r = await child(`
const L = await import(${ADAPTER});
${HELPERS}
const mem = memLedger();
const early = await mem.batchStart(1);
process.env.CLINENV_CANONICAL_LEDGER = ${JSON.stringify(canon)};
const { ledger, mode } = L.openNodeLedger({ transport: 'live' });
out.mode = mode;
try { await ledger.batchStart(10); out.canonicalAt449 = 'granted'; } catch (e) { out.canonicalAt449 = e.name; }
out.memoryMintedBefore = check(early);
out.memoryMintedAfter = check(await mem.batchStart(1));
out.otherPath = check(await L.openNodeLedger({ transport: 'live', env: { HOME: ${JSON.stringify(home)}, SPEND_LEDGER: ${JSON.stringify(shadow)} } }).ledger.batchStart(1));
try { await L.reserveSpend(early, { bodyBytes: 1, maxTokens: 1 }); out.reserveSpend = 'reserved'; } catch { out.reserveSpend = 'refused'; }
console.log(JSON.stringify(out));
`, envFor(home), root);
    expect(r.err).toBe('');
    expect(JSON.parse(r.out)).toEqual({
      mode: 'own-run', canonicalAt449: 'SpendRefused', memoryMintedBefore: 'throws', memoryMintedAfter: 'throws', otherPath: 'throws', reserveSpend: 'refused',
    });
  });

  it('with the marker in process.env, an open through opts.env without it, or naming a second canonical file, mints no passing grant', async () => {
    const root = tempDir('bind-procenv');
    const canon = join(root, 'canon', 'spend.jsonl');
    seed(canon, []);
    const other = join(root, 'other', 'spend.jsonl');
    seed(other, []);
    const shadow = join(root, 'shadow', 'spend.jsonl');
    const home = join(root, 'home');
    const r = await child(`
const L = await import(${ADAPTER});
${HELPERS}
out.defaultViaOptsEnv = check(await L.openNodeLedger({ transport: 'live', env: { HOME: ${JSON.stringify(home)}, SPEND_LEDGER: ${JSON.stringify(shadow)} } }).ledger.batchStart(1));
try { L.openNodeLedger({ transport: 'live', env: { HOME: ${JSON.stringify(home)}, CLINENV_CANONICAL_LEDGER: ${JSON.stringify(other)} } }); out.secondCanonical = 'opened'; } catch (e) { out.secondCanonical = /CLINENV_CANONICAL_LEDGER|canonical/.test(e.message) ? 'refused' : e.message; }
out.canonical = check(await L.openNodeLedger({ transport: 'live' }).ledger.batchStart(1));
console.log(JSON.stringify(out));
`, envFor(home, { CLINENV_CANONICAL_LEDGER: canon }), root);
    expect(r.err).toBe('');
    expect(JSON.parse(r.out)).toEqual({ defaultViaOptsEnv: 'throws', secondCanonical: 'refused', canonical: 'passes' });
    expect(readRows(other)).toEqual([]);
  });

  it('with the marker set and the adapter never imported, a grant over an ad-hoc store cannot meter a call', async () => {
    const root = tempDir('bind-noimport');
    const canon = join(root, 'canon', 'spend.jsonl');
    seed(canon, [settleRow(499.99, 'seed')]);
    const r = await child(`
const rows = [];
const store = { transact: async (fn) => { const r = fn(rows); rows.push(...r.append); return r.result; }, read: async () => rows };
const ledger = C.createLedger({ store, clock: { now: () => 't' }, newId: () => crypto.randomUUID(), source: 'node', runId: null, pid: 1, host: 'h', isAlive: () => true });
const grant = await ledger.batchStart(100);
const out = {};
try { C.assertClientGrant(grant, ledger); out.client = 'built'; } catch (e) { out.client = /grant/.test(e.message) ? 'refused' : e.message; }
let sends = 0;
try { await grant.metered({ bodyBytes: 10, maxTokens: 10 }, async () => { sends++; return { usage: { input_tokens: 10, output_tokens: 1 } }; }); out.metered = 'sent'; } catch (e) { out.metered = /grant/.test(e.message) ? 'refused' : e.message; }
out.sends = sends;
out.reserveRows = rows.filter((x) => x.kind === 'reserve').length;
console.log(JSON.stringify(out));
`, envFor(join(root, 'home'), { CLINENV_CANONICAL_LEDGER: canon }), root);
    expect(r.err).toBe('');
    expect(JSON.parse(r.out)).toEqual({ client: 'refused', metered: 'refused', sends: 0, reserveRows: 0 });
  });
});

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

describe('own-run mode needs the canonical file to exist', () => {
  it('refuses a marker naming a missing file or a directory, creates nothing, and spend --init creates the file once', async () => {
    const root = tempDir('ownrun-init');
    const home = join(root, 'home');
    mkdirSync(join(root, 'canon'));
    const marker = join(root, 'canon', 'spend.jsonl');
    const env = envFor(home, { CLINENV_CANONICAL_LEDGER: marker });

    for (const transport of ['live', 'offline'] as const) {
      expect(() => openNodeLedger({ transport, env }), transport).toThrow(/does not exist.*spend --init/);
    }
    const where = spendCli(['--where'], env, root);
    expect(where.stdout).toBe(`own-run ${marker}\n`);
    expect(where.stderr).toMatch(/spend --init/);
    expect(where.status).toBe(1);
    expect(spendCli([], env, root).status).toBe(1);
    expect(existsSync(marker)).toBe(false);

    const init = spendCli(['--init'], env, root);
    expect(init.stderr).toBe('');
    expect(init.stdout).toBe(`created own-run ${marker}\n`);
    expect(init.status).toBe(0);
    // A successful own-run open binds its process, so it runs in a child.
    const opened = await child(`
const L = await import(${ADAPTER});
await L.openNodeLedger({ transport: 'live' }).ledger.batchStart(1);
`, env, root);
    expect(opened.err).toBe('');
    expect(readRows(marker).map((x) => x.kind)).toEqual(['open']);
    const before = readFileSync(marker);
    // A second --init changes nothing.
    const again = spendCli(['--init'], env, root);
    expect(again.stdout).toBe(`exists own-run ${marker}\n`);
    expect(again.status).toBe(0);
    expect(readFileSync(marker).equals(before)).toBe(true);

    // --init never creates the directory, and a marker naming a directory is refused.
    const gone = envFor(home, { CLINENV_CANONICAL_LEDGER: join(root, 'gone', 'spend.jsonl') });
    expect(spendCli(['--init'], gone, root).status).toBe(1);
    expect(existsSync(join(root, 'gone'))).toBe(false);
    const dir = envFor(home, { CLINENV_CANONICAL_LEDGER: join(root, 'canon') });
    expect(() => openNodeLedger({ transport: 'live', env: dir })).toThrow(/not a file/);
    expect(existsSync(join(home, '.clinenv'))).toBe(false);
  });

  it('default mode still creates ~/.clinenv/spend.jsonl on a live open', () => {
    const home = tempDir('default-create');
    openNodeLedger({ transport: 'live', env: envFor(home) });
    expect(existsSync(join(home, '.clinenv', 'spend.jsonl'))).toBe(true);
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
