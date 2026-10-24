// Security review P12b-3 F2 and F3: the session cap holds after admission. A batch whose trials
// keep failing over to INFRA_API reruns (5 expensive turns, then 529 on every retry, the review's
// C7 probe) stops at the cap instead of settling past it, and a Validate while a batch holds the
// session at its cap is refused. Review P12b-4 G3: caps are per batch, each batch keeping the
// cap of its own accepted POST, and Validate checks against the cap of the last batch accepted,
// never one a refused POST carried.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { totals, type LedgerRow } from '../../../packages/core/ledger.ts';
import { parseDryRun, parseRunsList, validateWorstCaseUsd } from '../../../packages/core/runner-api.ts';
import { sse, turnEvents } from '../../web/src/harness/scenarios.ts';
import { jsonError, launch, sentinels, stallAnswer, toyTrial, until, type Answer, type Launched } from './helpers.ts';

const rows = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as LedgerRow) : []);
const sessionOf = (runId: string) => runId.slice(0, runId.lastIndexOf('-'));
const dryRun = async (l: Launched) => parseDryRun((await l.http('POST', '/api/trials?dry_run=1', { body: toyTrial() })).json()).projection;

// Each attempt: 5 turns that each bill their whole max_tokens, then 529 on every retry, so the
// trial ends INFRA_API and is re-queued.
const stormAnswer: Answer = async (label, n, call) => {
  if (label.includes('validate') || label.includes('judge')) return undefined;
  if (n > 5) return jsonError(529, 'overloaded_error', 'overloaded');
  const ev = turnEvents({ thinking: `t${n}`, tools: [{ id: `toolu_x${n}`, name: 'get_context', input: {} }] }, n) as Array<Record<string, unknown>>;
  const body = JSON.parse(call.body) as { max_tokens: number };
  (ev[0] as { message: { usage: Record<string, number> } }).message.usage = { input_tokens: Buffer.byteLength(call.body), output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  (ev[ev.length - 2] as { usage: Record<string, number> }).usage = { output_tokens: body.max_tokens };
  return new Response(sse(ev), { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

describe('session cap after admission (security review P12b-3 F2, F3)', () => {
  it('stops a batch whose INFRA_API reruns would cross the session cap; the session settles within it', async () => {
    const l = await launch({ answer: stormAnswer });
    const ledger = join(l.home, '.clinenv', 'spend.jsonl');
    try {
      await l.http('POST', '/api/key', { body: { key: sentinels().skAnt } });
      const before = await dryRun(l);
      const cap = before.session_spent_usd + before.total_usd + 0.01;
      const a = await l.http('POST', '/api/trials', { body: toyTrial({ session_cap_usd: cap }) });
      expect(a.status).toBe(202);
      const { run_id: runId, trial_ids: [trialId] } = a.json() as { run_id: string; trial_ids: string[] };
      await until('the batch closes', () => rows(ledger).some((r) => r.kind === 'close' && r.run_id === runId), 60_000);
      await until('the run is done', async () => parseRunsList((await l.http('GET', '/api/runs')).json()).runs[0]?.done === true);
      const session = totals(rows(ledger).filter((r) => r.run_id?.startsWith(sessionOf(runId))));
      expect(session.reserved).toBe(0);
      expect(session.settled).toBeLessThanOrEqual(cap);
      expect((await dryRun(l)).session_spent_usd).toBeLessThanOrEqual(cap);
      // More than one attempt ran: the reruns counted against the same ceiling.
      expect(new Set(rows(ledger).filter((r) => r.run_id === runId && r.kind === 'reserve').map((r) => r.trial)).size).toBe(1);
      expect(l.calls.filter((c) => !c.label.includes('validate')).length).toBeGreaterThan(13);
      const run = parseRunsList((await l.http('GET', '/api/runs')).json()).runs[0];
      expect(run?.stopped).toBe('spend_refused_ceiling');
      // The trial that hit the ceiling is cancelled from outside: kept as a re-queued attempt.
      const trial = (await l.http('GET', `/api/trials/${trialId}`)).json() as { state: string; record: { outcome: string; settled: boolean; detail: string | null } | null };
      expect(trial.state).toBe('cancelled');
      expect(trial.record).toMatchObject({ outcome: 'CANCELLED', settled: false });
      expect(trial.record?.detail).toMatch(/session cap/);
    } finally {
      await l.runner.shutdown();
    }
  }, 90_000);

  it('refuses Validate while a batch holds the session at its cap, and allows it with room', async () => {
    const l = await launch({ answer: stallAnswer() });
    const ledger = join(l.home, '.clinenv', 'spend.jsonl');
    const key = sentinels().skAnt;
    try {
      expect((await l.http('POST', '/api/key', { body: { key } })).status).toBe(200);
      const before = await dryRun(l);
      const cap = before.session_spent_usd + before.total_usd + 0.001;
      const a = await l.http('POST', '/api/trials', { body: toyTrial({ session_cap_usd: cap }) });
      expect(a.status).toBe(202);
      const runId = (a.json() as { run_id: string }).run_id;
      await until('the trial call in flight', () => l.calls.some((c) => !c.label.includes('validate')));
      const validates = l.calls.filter((c) => c.label.includes('validate')).length;
      const vs = await Promise.all(Array.from({ length: 5 }, () => l.http('POST', '/api/key', { body: { key } })));
      expect(vs.map((v) => v.status)).toEqual([409, 409, 409, 409, 409]);
      for (const v of vs) expect((v.json() as { error: { type: string } }).error.type).toMatch(/^(session_cap|spend_refused_ceiling)$/);
      expect(l.calls.filter((c) => c.label.includes('validate')).length).toBe(validates);
      expect((await dryRun(l)).session_spent_usd).toBeLessThanOrEqual(cap);
      const keyRows = rows(ledger).filter((r) => r.run_id === `${sessionOf(runId)}-key`);
      expect(totals(keyRows).settled + totals(keyRows).reserved).toBeLessThanOrEqual(validateWorstCaseUsd() + 1e-9);
      // A refused Validate leaves the held key as it was: batches still run with it.
      expect((await l.http('GET', '/api/health')).json()).toMatchObject({ key_loaded: true });
    } finally {
      await l.runner.shutdown();
    }
  });

  it('allows Validate at the cap when its worst case still fits', async () => {
    const l = await launch({ answer: stallAnswer() });
    const key = sentinels().skAnt;
    try {
      expect((await l.http('POST', '/api/key', { body: { key } })).status).toBe(200);
      const before = await dryRun(l);
      const cap = before.session_spent_usd + before.total_usd + validateWorstCaseUsd() + 0.001;
      expect((await l.http('POST', '/api/trials', { body: toyTrial({ session_cap_usd: cap }) })).status).toBe(202);
      await until('the trial call in flight', () => l.calls.some((c) => !c.label.includes('validate')));
      expect((await l.http('POST', '/api/key', { body: { key } })).status).toBe(200);
    } finally {
      await l.runner.shutdown();
    }
  });

  it('a later POST with a lower cap is refused and changes nothing: the running batch and Validate keep the accepted cap (P12b-4 G3)', async () => {
    const l = await launch({ answer: stallAnswer() });
    const key = sentinels().skAnt;
    try {
      expect((await l.http('POST', '/api/key', { body: { key } })).status).toBe(200);
      const before = await dryRun(l);
      const hi = before.session_spent_usd + before.total_usd + validateWorstCaseUsd() + 0.001;
      const lo = before.session_spent_usd + before.total_usd / 2;
      const a = await l.http('POST', '/api/trials', { body: toyTrial({ session_cap_usd: hi }) });
      expect(a.status).toBe(202);
      await until('the trial call in flight', () => l.calls.some((c) => !c.label.includes('validate')));
      const b = await l.http('POST', '/api/trials', { body: toyTrial({ session_cap_usd: lo }) });
      expect(b.status).toBe(409);
      expect((b.json() as { error: { type: string } }).error.type).toBe('session_cap');
      // Validate still fits under A's cap; the refused POST's lower cap did not become the session's.
      expect((await l.http('POST', '/api/key', { body: { key } })).status).toBe(200);
      const run = parseRunsList((await l.http('GET', '/api/runs')).json()).runs;
      expect(run).toHaveLength(1);
      expect(run[0]).toMatchObject({ done: false, stopped: null });
    } finally {
      await l.runner.shutdown();
    }
  });

  it('a refused POST with a higher cap does not raise the cap Validate checks against (P12b-4 G3)', async () => {
    const l = await launch({ answer: stallAnswer() });
    const ledger = join(l.home, '.clinenv', 'spend.jsonl');
    const key = sentinels().skAnt;
    try {
      // A carries its own key, so none is held and B is refused with no_key.
      const before = await dryRun(l);
      const cap = before.session_spent_usd + before.total_usd + 0.001;
      const a = await l.http('POST', '/api/trials', { body: toyTrial({ session_cap_usd: cap, key }) });
      expect(a.status).toBe(202);
      const runId = (a.json() as { run_id: string }).run_id;
      await until('the trial call in flight', () => l.calls.some((c) => !c.label.includes('validate')));
      expect((await l.http('POST', '/api/key', { body: { key } })).status).toBe(409);
      for (const refused of [toyTrial({ session_cap_usd: 900 }), toyTrial({ session_cap_usd: 900, tasks: ['no-such-task'] })]) {
        const b = await l.http('POST', '/api/trials', { body: refused });
        expect(b.status).toBeGreaterThanOrEqual(400);
      }
      const vs = await Promise.all(Array.from({ length: 3 }, () => l.http('POST', '/api/key', { body: { key } })));
      expect(vs.map((v) => v.status)).toEqual([409, 409, 409]);
      expect(l.calls.filter((c) => c.label.includes('validate'))).toHaveLength(0);
      const session = totals(rows(ledger).filter((r) => r.run_id?.startsWith(sessionOf(runId))));
      expect(session.settled + session.reserved).toBeLessThanOrEqual(cap);
    } finally {
      await l.runner.shutdown();
    }
  });
});
