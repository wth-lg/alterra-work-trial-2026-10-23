// Gate case (6), cancel: DELETE /api/trials/:id mid-call aborts the call the fetch mock is
// holding, with no retry; the call settles once at its worst case, the trial records CANCELLED,
// the batch writes its close row and no reservation is left unsettled. SIGINT mid-trial exits 0
// within 10 s with the same ledger state.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LedgerRow } from '../../../packages/core/ledger.ts';
import { parseTrialView } from '../../../packages/core/runner-api.ts';
import { fakeDist, http, launch, portOf, readSse, spawnRunner, tempDir, tokenMeta, toyTrial, until } from './helpers.ts';

const rows = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as LedgerRow) : []);

function expectCancelledLedger(all: LedgerRow[], runId: string): void {
  const batch = all.filter((r) => r.run_id === runId);
  const reserves = batch.filter((r) => r.kind === 'reserve');
  const settles = batch.filter((r) => r.kind === 'settle');
  expect(reserves).toHaveLength(1);
  expect(settles).toHaveLength(1);
  expect(settles[0]?.call_id).toBe(reserves[0]?.call_id);
  expect(settles[0]?.cost_usd).toBe(reserves[0]?.cost_usd); // the worst case: usage unknown
  expect(settles[0]?.usage).toBeNull();
  expect(batch.filter((r) => r.kind === 'open')).toHaveLength(1);
  expect(batch.filter((r) => r.kind === 'close')).toHaveLength(1);
  const settled = new Set(all.filter((r) => r.kind === 'settle').map((r) => r.call_id));
  expect(all.filter((r) => r.kind === 'reserve' && !settled.has(r.call_id))).toEqual([]);
}

describe('cancel (gate case 6)', () => {
  it('DELETE mid-call aborts it with no retry, settles it at worst case and records CANCELLED', async () => {
    const l = await launch({
      answer: (label, _n, call) =>
        label.includes('validate') ? undefined : new Promise<Response>((_, reject) => call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true })),
    });
    const ledger = join(l.home, '.clinenv', 'spend.jsonl');
    try {
      await l.http('POST', '/api/key', { body: { key: 'cancel-test-key-0123456789' } });
      const a = (await l.http('POST', '/api/trials', { body: toyTrial() })).json() as { run_id: string; trial_ids: string[] };
      const id = a.trial_ids[0] as string;
      await until('the trial call in flight', () => l.calls.some((c) => !c.label.includes('validate')));
      const del = await l.http('DELETE', `/api/trials/${id}`);
      expect(del.status).toBe(200);
      const s = await readSse(l.port, `/api/trials/${id}/events`, { token: l.runner.token });
      const types = s.frames.map((f) => f.event);
      expect(types.at(-1)).toBe('graded');
      expect(types).toContain('cancelled');
      await until('the batch to close', () => rows(ledger).some((r) => r.kind === 'close' && r.run_id === a.run_id));
      const trialCalls = l.calls.filter((c) => !c.label.includes('validate'));
      expect(trialCalls).toHaveLength(1);
      expect(trialCalls[0]?.signal.aborted).toBe(true);
      const view = parseTrialView((await l.http('GET', `/api/trials/${id}`)).json());
      expect(view.state).toBe('cancelled');
      expect(view.record).toMatchObject({ status: 'CANCELLED', outcome: 'CANCELLED', settled: false });
      expectCancelledLedger(rows(ledger), a.run_id);
      expect(existsSync(join(l.home, 'runs', a.run_id, 'requeued', '_toy'))).toBe(true);
    } finally {
      await l.runner.shutdown();
    }
  });

  it('cancels one trial of a batch without stopping the others', async () => {
    const l = await launch({
      answer: (label, n, call) =>
        label.endsWith('/0') && n === 1 ? new Promise<Response>((_, reject) => call.signal.addEventListener('abort', () => reject(call.signal.reason), { once: true })) : undefined,
    });
    try {
      await l.http('POST', '/api/key', { body: { key: 'cancel-test-key-0123456789' } });
      const a = (await l.http('POST', '/api/trials', { body: toyTrial({ trials: 2, concurrency: 2 }) })).json() as { trial_ids: string[] };
      await until('trial 0 in flight', () => l.calls.some((c) => c.label.endsWith('/0')));
      await l.http('DELETE', `/api/trials/${a.trial_ids[0]}`);
      const second = await readSse(l.port, `/api/trials/${a.trial_ids[1]}/events`, { token: l.runner.token });
      const graded = JSON.parse(second.frames.at(-1)!.data) as { record: { outcome: string } };
      expect(graded.record.outcome).toBe('PASS');
      expect(parseTrialView((await l.http('GET', `/api/trials/${a.trial_ids[0]}`)).json()).state).toBe('cancelled');
    } finally {
      await l.runner.shutdown();
    }
  });

  it('SIGINT mid-trial cancels it, closes the batch and exits 0 within 10 s', async () => {
    const home = tempDir('runner-sigint');
    const c = spawnRunner(['--mock', '--port', '0'], { HOME: home, CLINENV_RUNS_DIR: join(home, 'runs'), NODE_ENV: 'test', CLINENV_RUNNER_TEST_TRANSPORT: 'stall', CLINENV_WEB_DIST: fakeDist() });
    const port = portOf(await c.url);
    const token = tokenMeta((await http(port, 'GET', '/clinical-agent-env/')).text) as string;
    const a = (await http(port, 'POST', '/api/trials', { token, body: toyTrial() })).json() as { run_id: string };
    const ledger = join(home, '.clinenv', 'spend.jsonl');
    await until('a reserve row for the trial', () => rows(ledger).some((r) => r.kind === 'reserve' && r.run_id === a.run_id));
    const t0 = Date.now();
    c.child.kill('SIGINT');
    const exit = await c.exit;
    expect(exit.code, c.stderr()).toBe(0);
    expect(Date.now() - t0).toBeLessThan(10_000);
    expectCancelledLedger(rows(ledger), a.run_id);
    const record = JSON.parse(readFileSync(join(home, 'runs', a.run_id, 'manifest.json'), 'utf8')) as { batches: Array<{ cancelled: boolean }> };
    expect(record.batches.at(-1)?.cancelled).toBe(true);
  });
});
