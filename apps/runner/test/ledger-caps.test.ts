// Gate case (5), caps and default mode: a batch whose projection would take the ledger to
// PROJECTED_CAP_USD + $0.01 gets 409 with no call, a session cap below the projection gets 409,
// settled spend reaching ACTUAL_CAP_USD mid-batch aborts it, and in default mode with HOME at a
// temp dir the rows land in <HOME>/.clinenv/spend.jsonl.
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ACTUAL_CAP_USD, PROJECTED_CAP_USD, type LedgerRow } from '../../../packages/core/ledger.ts';
import { parseDryRun, parseRunsList, parseTrialsRefused } from '../../../packages/core/runner-api.ts';
import { launch, readSse, stallAnswer, tempDir, toyTrial, until } from './helpers.ts';

const row = (kind: 'reserve' | 'settle', call_id: string, cost_usd: number): LedgerRow => ({
  ts: new Date().toISOString(), call_id, kind, source: 'node', run_id: null, batch_id: null, trial: 'elsewhere', usage: null, cost_usd,
});
const spent = (file: string, call_id: string, usd: number) => appendFileSync(file, [row('reserve', call_id, usd), row('settle', call_id, usd)].map((r) => `${JSON.stringify(r)}\n`).join(''));
const rows = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as LedgerRow) : []);
const KEY = 'caps-test-key-0123456789';

describe('ledger caps and default mode (gate case 5)', () => {
  it('refuses a batch that would cross PROJECTED_CAP_USD by $0.01, with no call', async () => {
    const l = await launch();
    const ledger = join(l.home, '.clinenv', 'spend.jsonl');
    try {
      await l.http('POST', '/api/key', { body: { key: KEY } });
      const calls = l.calls.length;
      const p = parseDryRun((await l.http('POST', '/api/trials?dry_run=1', { body: toyTrial() })).json()).projection.total_usd;
      spent(ledger, 'pre-1', PROJECTED_CAP_USD + 0.01 - p);
      const before = rows(ledger).length;
      const r = await l.http('POST', '/api/trials', { body: toyTrial() });
      expect(r.status).toBe(409);
      const refused = parseTrialsRefused(r.json());
      expect(refused.error.type).toBe('projected_cap');
      expect(refused.projection?.total_usd).toBeCloseTo(p, 9);
      expect(refused.projection?.projected_cap_usd).toBe(PROJECTED_CAP_USD);
      expect(l.calls.length).toBe(calls);
      expect(rows(ledger).length).toBe(before);
      expect(parseRunsList((await l.http('GET', '/api/runs')).json()).runs).toEqual([]);
    } finally {
      await l.runner.shutdown();
    }
  });

  it('refuses a batch whose projection is above the session cap, with no call', async () => {
    const l = await launch();
    try {
      await l.http('POST', '/api/key', { body: { key: KEY } });
      const calls = l.calls.length;
      const p = parseDryRun((await l.http('POST', '/api/trials?dry_run=1', { body: toyTrial() })).json()).projection.total_usd;
      const r = await l.http('POST', '/api/trials', { body: toyTrial({ session_cap_usd: p - 0.01 }) });
      expect(r.status).toBe(409);
      expect(parseTrialsRefused(r.json()).error.type).toBe('session_cap');
      expect(l.calls.length).toBe(calls);
      expect((await l.http('POST', '/api/trials', { body: toyTrial({ session_cap_usd: PROJECTED_CAP_USD + 1 }) })).status).toBe(400);
    } finally {
      await l.runner.shutdown();
    }
  });

  it('counts a running batch against the session cap: a second batch that would cross it gets 409 with 0 calls', async () => {
    // Each trial call stalls until it is aborted, so batch A is still running when B is posted.
    const l = await launch({ answer: stallAnswer() });
    const ledger = join(l.home, '.clinenv', 'spend.jsonl');
    try {
      await l.http('POST', '/api/key', { body: { key: KEY } });
      const before = parseDryRun((await l.http('POST', '/api/trials?dry_run=1', { body: toyTrial() })).json()).projection;
      const p = before.total_usd;
      const cap = before.session_spent_usd + 1.5 * p;
      // Back to back, before A has reserved anything.
      const [ra, rb] = await Promise.all([
        l.http('POST', '/api/trials', { body: toyTrial({ session_cap_usd: cap }) }),
        l.http('POST', '/api/trials', { body: toyTrial({ session_cap_usd: cap }) }),
      ]);
      expect([ra.status, rb.status].sort()).toEqual([202, 409]);
      const [accepted, refused] = ra.status === 202 ? [ra, rb] : [rb, ra];
      expect(parseTrialsRefused(refused.json()).error.type).toBe('session_cap');
      const a = accepted.json() as { run_id: string; trial_ids: string[] };
      await until('the trial call in flight', () => l.calls.some((c) => !c.label.includes('validate')));
      // A third batch while A's call is in flight and reserved is refused too.
      const c = await l.http('POST', '/api/trials', { body: toyTrial({ session_cap_usd: cap }) });
      expect(c.status).toBe(409);
      expect(parseTrialsRefused(c.json()).projection?.session_spent_usd).toBeGreaterThanOrEqual(before.session_spent_usd + p - 1e-9);
      expect(parseRunsList((await l.http('GET', '/api/runs')).json()).runs.map((r) => r.run_id)).toEqual([a.run_id]);
      expect(l.calls.filter((x) => !x.label.includes('validate'))).toHaveLength(1);
      expect(l.calls.every((x) => x.label.includes('validate') || x.label.includes(a.run_id))).toBe(true);
      // Once A closes, only what its rows hold counts: the commitment is released.
      await l.http('DELETE', `/api/trials/${a.trial_ids[0]}`);
      await until('batch A to close', () => rows(ledger).some((r) => r.kind === 'close' && r.run_id === a.run_id));
      await until('batch A done', async () => parseRunsList((await l.http('GET', '/api/runs')).json()).runs[0]?.done === true);
      const session = a.run_id.slice(0, a.run_id.lastIndexOf('-'));
      const mine = rows(ledger).filter((r) => r.run_id?.startsWith(session));
      const settled = mine.filter((r) => r.kind === 'settle').reduce((s, r) => s + (r.cost_usd ?? 0), 0);
      const after = parseDryRun((await l.http('POST', '/api/trials?dry_run=1', { body: toyTrial() })).json()).projection;
      expect(after.session_spent_usd).toBeCloseTo(settled, 6);
    } finally {
      await l.runner.shutdown();
    }
  });

  it('stops the batch once settled spend reaches ACTUAL_CAP_USD', async () => {
    let ledger = '';
    const l = await launch({
      answer: (label, n) => {
        // Another process settles up to the actual cap while this trial's first call is in flight.
        if (!label.includes('validate') && n === 1) spent(ledger, 'elsewhere-1', ACTUAL_CAP_USD);
        return undefined;
      },
    });
    ledger = join(l.home, '.clinenv', 'spend.jsonl');
    try {
      await l.http('POST', '/api/key', { body: { key: KEY } });
      const a = (await l.http('POST', '/api/trials', { body: toyTrial({ trials: 3 }) })).json() as { run_id: string; trial_ids: string[] };
      const s = await readSse(l.port, `/api/trials/${a.trial_ids[0]}/events`, { token: l.runner.token });
      expect(s.frames.at(-1)?.event).toBe('graded');
      for (const id of a.trial_ids.slice(1)) {
        const rest = await readSse(l.port, `/api/trials/${id}/events`, { token: l.runner.token });
        expect(rest.frames.at(-1)?.event).toBe('end');
      }
      const runs = parseRunsList((await l.http('GET', '/api/runs')).json()).runs;
      expect(runs[0]).toMatchObject({ run_id: a.run_id, done: true, stopped: 'actual_cap' });
      const batchRows = rows(ledger).filter((r) => r.run_id === a.run_id);
      expect(batchRows.some((r) => r.kind === 'close')).toBe(true);
      expect(l.calls.filter((c) => !c.label.includes('validate'))).toHaveLength(1);
    } finally {
      await l.runner.shutdown();
    }
  });

  it('in default mode writes to <HOME>/.clinenv/spend.jsonl', async () => {
    const l = await launch({ mock: true, transport: null });
    try {
      const ledger = join(l.home, '.clinenv', 'spend.jsonl');
      expect((await l.http('GET', '/api/health')).json()).toMatchObject({ ledger: { mode: 'default', path: ledger } });
      const a = (await l.http('POST', '/api/trials', { body: toyTrial() })).json() as { run_id: string; trial_ids: string[] };
      await readSse(l.port, `/api/trials/${a.trial_ids[0]}/events`, { token: l.runner.token });
      await until('the batch close row', () => rows(ledger).some((r) => r.kind === 'close' && r.run_id === a.run_id));
      expect(new Set(rows(ledger).filter((r) => r.run_id === a.run_id).map((r) => r.kind))).toEqual(new Set(['open', 'reserve', 'settle', 'close']));
      expect(existsSync(join(l.home, 'runs', a.run_id, 'manifest.json'))).toBe(true);
    } finally {
      await l.runner.shutdown();
    }
  });

  it('writes records under CLINENV_RUNS_DIR, else ~/.clinenv/runs/<run_id>/', async () => {
    const l = await launch({ mock: true, transport: null, env: { CLINENV_RUNS_DIR: undefined } });
    try {
      const a = (await l.http('POST', '/api/trials', { body: toyTrial() })).json() as { run_id: string; trial_ids: string[] };
      await readSse(l.port, `/api/trials/${a.trial_ids[0]}/events`, { token: l.runner.token });
      expect(existsSync(join(l.home, '.clinenv', 'runs', a.run_id, 'trials', '_toy', '0.json'))).toBe(true);
    } finally {
      await l.runner.shutdown();
    }
  });

  it('refuses to start when the own-run marker names a missing ledger', async () => {
    const dir = tempDir('runner-marker');
    await expect(launch({ env: { CLINENV_CANONICAL_LEDGER: join(dir, 'nope.jsonl') } })).rejects.toThrow(/own-run spend ledger refused/);
  });
});
