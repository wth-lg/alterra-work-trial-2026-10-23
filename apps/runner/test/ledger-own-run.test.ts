// Gate case (5), own-run mode: with CLINENV_CANONICAL_LEDGER at a temp path, a mocked trial
// writes its open, reserve, settle and close rows there, and POST /api/key writes its Validate
// reserve and settle rows. Its own file: an own-run open binds the process to that ledger.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LedgerRow } from '../../../packages/core/ledger.ts';
import { launch, readSse, tempDir, toyTrial, until } from './helpers.ts';

const rows = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l) as LedgerRow);

describe('ledger, own-run mode (gate case 5)', () => {
  it('meters the Validate call and a mocked trial through CLINENV_CANONICAL_LEDGER', async () => {
    const dir = tempDir('runner-canonical');
    const canonical = join(dir, 'spend.jsonl');
    writeFileSync(canonical, '');
    const l = await launch({ mock: true, transport: null, env: { CLINENV_CANONICAL_LEDGER: canonical, SPEND_LEDGER: undefined } });
    try {
      expect((await l.http('GET', '/api/health')).json()).toMatchObject({ ledger: { mode: 'own-run', path: canonical }, mock: true });
      expect((await l.http('POST', '/api/key', { body: { key: 'own-run-test-key-0123456789' } })).status).toBe(200);
      const validate = rows(canonical);
      expect(validate.filter((r) => r.kind === 'reserve' && r.trial?.includes('validate'))).toHaveLength(1);
      expect(validate.filter((r) => r.kind === 'settle' && r.trial?.includes('validate'))).toHaveLength(1);

      const a = (await l.http('POST', '/api/trials', { body: toyTrial() })).json() as { run_id: string; trial_ids: string[] };
      const s = await readSse(l.port, `/api/trials/${a.trial_ids[0]}/events`, { token: l.runner.token });
      expect(s.frames.at(-1)?.event).toBe('graded');
      await until('the batch close row', () => rows(canonical).some((r) => r.kind === 'close' && r.run_id === a.run_id));
      const batch = rows(canonical).filter((r) => r.run_id === a.run_id);
      const kinds = new Set(batch.map((r) => r.kind));
      expect([...kinds].sort()).toEqual(['close', 'open', 'reserve', 'settle']);
      const reserves = batch.filter((r) => r.kind === 'reserve').map((r) => r.call_id);
      const settled = new Set(batch.filter((r) => r.kind === 'settle').map((r) => r.call_id));
      expect(reserves.every((id) => settled.has(id))).toBe(true);
      expect(batch.every((r) => r.trial === null || r.trial.startsWith(`mock:run:${a.run_id}:`))).toBe(true);
      expect(readFileSync(canonical, 'utf8')).not.toContain('own-run-test-key-0123456789');
    } finally {
      await l.runner.shutdown();
    }
  });
});
