// Gate case (8), contract: every runner response validates against packages/core/runner-api.ts,
// and POST /api/trials?dry_run=1 with 20 trials per task returns a projection with no call,
// while 21 trials gets 400.
import { describe, expect, it } from 'vitest';
import {
  parseDryRun, parseHealth, parseKeyState, parseRunnerError, parseRunsList, parseSseEnd, parseTrialsAccepted, parseTrialsRefused, parseTrialView,
} from '../../../packages/core/runner-api.ts';
import { parseEvent } from '../../../packages/core/events.ts';
import { jsonError, launch, readSse, toyTrial } from './helpers.ts';

describe('runner responses follow packages/core/runner-api.ts (gate case 8)', () => {
  it('validates health, key, trials, trial, runs, SSE and error bodies', async () => {
    let fail401 = false;
    const l = await launch({ answer: (label) => (fail401 && label.includes('validate') ? jsonError(401, 'authentication_error', 'invalid x-api-key') : undefined) });
    try {
      const health = parseHealth((await l.http('GET', '/api/health')).json());
      expect(health).toMatchObject({ app: 'clinenv-runner', key_loaded: false, mock: false, ledger: { mode: 'default' } });
      const noKey = await l.http('POST', '/api/trials', { body: toyTrial() });
      expect(noKey.status).toBe(409);
      expect(parseTrialsRefused(noKey.json()).error.type).toBe('no_key');
      expect(l.calls).toHaveLength(0);

      const key = 'contract-test-key-0123456789';
      const set = await l.http('POST', '/api/key', { body: { key } });
      expect(set.status).toBe(200);
      expect(parseKeyState(set.json())).toEqual({ key_set: true });
      expect(parseHealth((await l.http('GET', '/api/health')).json()).key_loaded).toBe(true);

      const dry = await l.http('POST', '/api/trials?dry_run=1', { body: toyTrial({ trials: 20 }) });
      expect(dry.status).toBe(200);
      const d = parseDryRun(dry.json());
      expect(d.projection.lines[0]).toMatchObject({ task_id: '_toy', trials: 20 });
      expect(d.projection.total_usd).toBeGreaterThan(0);
      const callsAfterKey = l.calls.length;
      const over = await l.http('POST', '/api/trials?dry_run=1', { body: toyTrial({ trials: 21 }) });
      expect(over.status).toBe(400);
      expect(parseRunnerError(over.json()).error.message).toMatch(/trials/);
      expect((await l.http('POST', '/api/trials', { body: toyTrial({ trials: 21 }) })).status).toBe(400);
      expect(l.calls.length).toBe(callsAfterKey);

      const accepted = parseTrialsAccepted((await l.http('POST', '/api/trials', { body: toyTrial() })).json());
      const [id] = accepted.trial_ids;
      const stream = await readSse(l.port, `/api/trials/${id}/events`, { token: l.runner.token });
      expect(stream.status).toBe(200);
      expect(stream.headers['content-type']).toMatch(/^text\/event-stream/);
      for (const f of stream.frames) {
        if (f.event === 'end') parseSseEnd(JSON.parse(f.data));
        else expect(parseEvent(JSON.parse(f.data)).type).toBe(f.event);
      }
      expect(stream.frames.at(-1)?.event).toBe('graded');
      const trial = parseTrialView((await l.http('GET', `/api/trials/${id}`)).json());
      expect(trial).toMatchObject({ trial_id: id, run_id: accepted.run_id, task_id: '_toy', index: 0, state: 'graded' });
      expect(trial.record).toMatchObject({ outcome: 'PASS', status: 'COMPLETED' });
      const runs = parseRunsList((await l.http('GET', '/api/runs')).json());
      expect(runs.runs.map((r) => r.run_id)).toEqual([accepted.run_id]);
      expect(runs.runs[0]).toMatchObject({ done: true, stopped: null, mock: false, smoke: false });
      expect(parseTrialView((await l.http('DELETE', `/api/trials/${id}`)).json()).state).toBe('graded');

      for (const [method, path] of [['GET', '/api/trials/nope'], ['GET', '/api/trials/nope/events'], ['DELETE', '/api/trials/nope']] as const) {
        const r = await l.http(method, path);
        expect(r.status, path).toBe(404);
        parseRunnerError(r.json());
      }
      expect(parseRunnerError((await l.http('POST', '/api/key', { body: { key: '' } })).json()).error.type).toBe('invalid_request');
      expect(parseRunnerError((await l.http('POST', '/api/trials', { body: '{not json' })).json()).error.type).toBe('invalid_request');
      expect(parseRunnerError((await l.http('PUT', '/api/key', { body: { key } })).json()).error.type).toBe('method_not_allowed');
      fail401 = true;
      const bad = await l.http('POST', '/api/key', { body: { key } });
      expect(bad.status).toBe(401);
      expect(parseRunnerError(bad.json()).error.type).toBe('authentication_error');
      expect(parseHealth((await l.http('GET', '/api/health')).json()).key_loaded).toBe(false);
      const cleared = await l.http('DELETE', '/api/key');
      expect(parseKeyState(cleared.json())).toEqual({ key_set: false });
    } finally {
      await l.runner.shutdown();
    }
  });
});
