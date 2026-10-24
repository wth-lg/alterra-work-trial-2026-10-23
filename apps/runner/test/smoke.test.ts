// The forced-fail smoke trial (docs/requirements/ui-contract.md, P25c follow-ups): only with
// CLINENV_FORCED_FAIL=1; run id smoke-<n>; a valid FAIL on a gate with models_returned
// [claude-opus-5-5]; its record carries mock: true and lives only under CLINENV_RUNS_DIR; no key
// and no ledger row; GET /api/runs lists it.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { recordKey, trialKey, type BatchRecord } from '../../../packages/core/batch.ts';
import { parseRunsList, parseTrialView } from '../../../packages/core/runner-api.ts';
import { taskVersions } from '../../../packages/core/tasks.ts';
import { nodeTaskSource } from '../../../cli/adapters/tasks-node.ts';
import { launch, readSse } from './helpers.ts';

const smoke = { tasks: ['renal-dose-review'], trials: 1, concurrency: 1, effort: 'high', session_cap_usd: 1, smoke: true };

describe('forced-fail smoke trial', () => {
  it('is refused unless the runner started with CLINENV_FORCED_FAIL=1', async () => {
    const l = await launch();
    try {
      expect((await l.http('POST', '/api/trials', { body: smoke })).status).toBe(400);
    } finally {
      await l.runner.shutdown();
    }
  });

  it('runs a valid gate FAIL as claude-opus-5-5, with mock: true, no key and no ledger row', async () => {
    const l = await launch({ env: { CLINENV_FORCED_FAIL: '1' } });
    try {
      const r = await l.http('POST', '/api/trials', { body: smoke });
      expect(r.status).toBe(202);
      const a = r.json() as { run_id: string; trial_ids: string[] };
      expect(a.run_id).toBe('smoke-1');
      const s = await readSse(l.port, `/api/trials/${a.trial_ids[0]}/events`, { token: l.runner.token });
      expect(s.frames.at(-1)?.event).toBe('graded');
      const view = parseTrialView((await l.http('GET', `/api/trials/${a.trial_ids[0]}`)).json());
      expect(view.state).toBe('graded');
      expect(view.record).toMatchObject({ outcome: 'FAIL', valid: true, mock: true, run_id: 'smoke-1', models_returned: ['claude-opus-5-5'] });
      const file = join(l.env.CLINENV_RUNS_DIR as string, 'smoke-1', 'trials', 'renal-dose-review', '0.json');
      const stored = JSON.parse(readFileSync(file, 'utf8')) as BatchRecord;
      expect(stored).toMatchObject({ mock: true, outcome: 'FAIL' });
      // Keyed on env_version like a batch's trials (#28), so replay and resume find it by that key.
      const { env_version } = await taskVersions(await nodeTaskSource({ testMode: false }).get('renal-dose-review'), stored.fixture_hash);
      expect(recordKey(stored)).toBe(trialKey({ task_id: 'renal-dose-review', env_version, model: 'claude-opus-5-5', effort: 'high', index: 0 }));
      expect(existsSync(join(l.home, '.clinenv', 'spend.jsonl'))).toBe(false);
      expect(l.calls).toHaveLength(0);
      expect(parseRunsList((await l.http('GET', '/api/runs')).json()).runs[0]).toMatchObject({ run_id: 'smoke-1', smoke: true, mock: true, done: true });
      expect(((await l.http('POST', '/api/trials', { body: smoke })).json() as { run_id: string }).run_id).toBe('smoke-2');
    } finally {
      await l.runner.shutdown();
    }
  });
});
