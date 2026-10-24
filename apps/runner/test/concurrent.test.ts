// P12b fix round 3 (verifier N1, security S2-1): POST /api/trials sent at the same moment.
// Each batch gets its own run id, taken before any await, and counts against the session cap
// in full while it runs; a DELETE reaches the trial of the batch it names; a batch that
// runBatch refuses after the runner's own checks gets 409 with the reason, never 202, and
// leaves no run, trial or session-cap term behind.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LedgerRow } from '../../../packages/core/ledger.ts';
import { parseDryRun, parseRunsList, parseTrialsRefused, parseTrialView } from '../../../packages/core/runner-api.ts';
import { launch, stallAnswer, toyTrial, until, type Launched } from './helpers.ts';

const rows = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as LedgerRow) : []);
const KEY = 'concurrent-test-key-0123456789';

type Accepted = { run_id: string; trial_ids: string[] };

async function setup(): Promise<{ l: Launched; ledger: string; p: number; spent: number }> {
  const l = await launch({ answer: stallAnswer() });
  await l.http('POST', '/api/key', { body: { key: KEY } });
  const before = parseDryRun((await l.http('POST', '/api/trials?dry_run=1', { body: toyTrial() })).json()).projection;
  return { l, ledger: join(l.home, '.clinenv', 'spend.jsonl'), p: before.total_usd, spent: before.session_spent_usd };
}

const trialCalls = (l: Launched, runId: string) => l.calls.filter((c) => !c.label.includes('validate') && c.label.includes(`${runId}:`));
const runIds = async (l: Launched) => parseRunsList((await l.http('GET', '/api/runs')).json()).runs.map((r) => r.run_id);
const sessionSpent = async (l: Launched) => parseDryRun((await l.http('POST', '/api/trials?dry_run=1', { body: toyTrial() })).json()).projection.session_spent_usd;

describe('concurrent POST /api/trials', () => {
  it('two at once with room for both: distinct run ids, both run, and a third over the cap gets 409', async () => {
    const { l, p, spent } = await setup();
    try {
      const cap = spent + 2.5 * p;
      const rs = await Promise.all([0, 1].map(() => l.http('POST', '/api/trials', { body: toyTrial({ session_cap_usd: cap }) })));
      expect(rs.map((r) => r.status)).toEqual([202, 202]);
      const [a, b] = rs.map((r) => r.json() as Accepted) as [Accepted, Accepted];
      expect(a.run_id).not.toBe(b.run_id);
      expect(a.trial_ids[0]).not.toBe(b.trial_ids[0]);
      await until('a trial call of each batch', () => trialCalls(l, a.run_id).length === 1 && trialCalls(l, b.run_id).length === 1);
      expect((await runIds(l)).sort()).toEqual([a.run_id, b.run_id].sort());
      // Both count in full while they run.
      expect(await sessionSpent(l)).toBeGreaterThanOrEqual(spent + 2 * p - 1e-9);
      for (let i = 0; i < 2; i++) {
        const c = await l.http('POST', '/api/trials', { body: toyTrial({ session_cap_usd: cap }) });
        expect(c.status).toBe(409);
        expect(parseTrialsRefused(c.json()).error.type).toBe('session_cap');
      }
      expect(await runIds(l)).toHaveLength(2);
      expect(l.calls.filter((c) => !c.label.includes('validate'))).toHaveLength(2);
    } finally {
      await l.runner.shutdown();
    }
  });

  it('DELETE cancels the batch it names; the other keeps running and counting', async () => {
    const { l, ledger, p, spent } = await setup();
    try {
      const cap = spent + 2.5 * p;
      const [a, b] = (await Promise.all([0, 1].map(() => l.http('POST', '/api/trials', { body: toyTrial({ session_cap_usd: cap }) })))).map((r) => r.json() as Accepted) as [Accepted, Accepted];
      await until('a trial call of each batch', () => trialCalls(l, a.run_id).length === 1 && trialCalls(l, b.run_id).length === 1);
      expect((await l.http('DELETE', `/api/trials/${b.trial_ids[0]}`)).status).toBe(200);
      await until('batch B to close', () => rows(ledger).some((r) => r.kind === 'close' && r.run_id === b.run_id));
      expect(trialCalls(l, b.run_id)[0]?.signal.aborted).toBe(true);
      expect(trialCalls(l, a.run_id)[0]?.signal.aborted).toBe(false);
      expect(parseTrialView((await l.http('GET', `/api/trials/${b.trial_ids[0]}`)).json()).state).toBe('cancelled');
      expect(parseTrialView((await l.http('GET', `/api/trials/${a.trial_ids[0]}`)).json()).state).toBe('running');
      expect(rows(ledger).some((r) => r.kind === 'close' && r.run_id === a.run_id)).toBe(false);
      // A still counts in full: one more batch of p fits under spent + 2.5p only with room for A.
      const settledB = rows(ledger).filter((r) => r.run_id === b.run_id && r.kind === 'settle').reduce((s, r) => s + (r.cost_usd ?? 0), 0);
      expect(await sessionSpent(l)).toBeGreaterThanOrEqual(spent + p + settledB - 1e-9);
      const tight = await l.http('POST', '/api/trials', { body: toyTrial({ session_cap_usd: spent + settledB + 1.5 * p }) });
      expect(tight.status).toBe(409);
      expect(parseTrialsRefused(tight.json()).error.type).toBe('session_cap');
    } finally {
      await l.runner.shutdown();
    }
  });

  it('three at once with room for three: three distinct run ids, all running, and a fourth gets 409', async () => {
    const { l, p, spent } = await setup();
    try {
      const cap = spent + 3.5 * p;
      const rs = await Promise.all([0, 1, 2].map(() => l.http('POST', '/api/trials', { body: toyTrial({ session_cap_usd: cap }) })));
      expect(rs.map((r) => r.status)).toEqual([202, 202, 202]);
      const ids = rs.map((r) => (r.json() as Accepted).run_id);
      expect(new Set(ids).size).toBe(3);
      await until('a trial call of each batch', () => ids.every((id) => trialCalls(l, id).length === 1));
      expect((await runIds(l)).sort()).toEqual([...ids].sort());
      const d = await l.http('POST', '/api/trials', { body: toyTrial({ session_cap_usd: cap }) });
      expect(d.status).toBe(409);
      expect(parseTrialsRefused(d.json()).projection?.session_spent_usd).toBeGreaterThanOrEqual(spent + 3 * p - 1e-9);
    } finally {
      await l.runner.shutdown();
    }
  });

  it('a batch runBatch refuses gets 409 with the reason, not 202, and leaves nothing behind', async () => {
    const l = await launch();
    const ledger = join(l.home, '.clinenv', 'spend.jsonl');
    try {
      await l.http('POST', '/api/key', { body: { key: KEY } });
      // A first batch runs to its end, which names this session and its last run number.
      const first = (await l.http('POST', '/api/trials', { body: toyTrial() })).json() as Accepted;
      await until('the first batch to close', () => rows(ledger).some((r) => r.kind === 'close' && r.run_id === first.run_id));
      const cut = first.run_id.lastIndexOf('-');
      const next = `${first.run_id.slice(0, cut)}-${Number(first.run_id.slice(cut + 1)) + 1}`;
      // Another live batch (this process) holds the next run's lock.
      const dir = join(l.env.CLINENV_RUNS_DIR as string, next);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, '.lock'), JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString() }));
      const calls = l.calls.length;
      const before = rows(ledger).length;
      const r = await l.http('POST', '/api/trials', { body: toyTrial() });
      expect(r.status).toBe(409);
      const refused = parseTrialsRefused(r.json());
      expect(refused.error.type).toBe('batch_refused');
      expect(refused.error.message).toMatch(/locked/);
      expect(l.calls.length).toBe(calls);
      expect(rows(ledger).length).toBe(before);
      expect(await runIds(l)).toEqual([first.run_id]);
      expect((await l.http('GET', `/api/trials/${next}._toy.0`)).status).toBe(404);
      // Its term is gone: what the session has committed is what its rows hold.
      const settled = rows(ledger).filter((x) => x.run_id === first.run_id && x.kind === 'settle').reduce((s, x) => s + (x.cost_usd ?? 0), 0);
      const p = parseDryRun((await l.http('POST', '/api/trials?dry_run=1', { body: toyTrial() })).json()).projection;
      expect(p.session_spent_usd).toBeLessThan(settled + 0.05);
      const again = await l.http('POST', '/api/trials', { body: toyTrial() });
      expect(again.status).toBe(202);
      expect((again.json() as Accepted).run_id).not.toBe(next);
    } finally {
      await l.runner.shutdown();
    }
  });
});
