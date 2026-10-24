// One TaskSource per batch request (reports/verifier-phase-replay-1.md item 3): a TaskSource reads
// the task directories once, so a runner holding one for its whole process would grade every
// later batch against the tasks as they were at start. A task file edited between two batches
// on one runner shows up in the second batch, at its new env_version.
import { appendFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTrialView } from '../../../packages/core/runner-api.ts';
import { taskVersions } from '../../../packages/core/tasks.ts';
import { nodeTaskSource, TASKS_DIR } from '../../../cli/adapters/tasks-node.ts';
import { launch, readSse, tempDir, toyTrial, type Launched } from './helpers.ts';

async function batchRecord(l: Launched): Promise<{ env_version: string; fixture_hash: string }> {
  const a = (await l.http('POST', '/api/trials', { body: toyTrial() })).json() as { trial_ids: string[] };
  const s = await readSse(l.port, `/api/trials/${a.trial_ids[0]}/events`, { token: l.runner.token });
  expect(s.frames.at(-1)?.event).toBe('graded');
  return parseTrialView((await l.http('GET', `/api/trials/${a.trial_ids[0]}`)).json()).record as { env_version: string; fixture_hash: string };
}

describe('a task edited between two batches', () => {
  it('is graded as edited: the second batch runs at the new env_version', async () => {
    const root = tempDir('runner-tasks');
    cpSync(join(TASKS_DIR, '_toy'), join(root, '_toy'), { recursive: true });
    const envVersion = async (worldHash: string) => (await taskVersions(await nodeTaskSource({ root }).get('_toy'), worldHash)).env_version;
    const l = await launch({ mock: true, transport: null, tasksDir: root });
    try {
      const first = await batchRecord(l);
      expect(first.env_version).toBe(await envVersion(first.fixture_hash));

      appendFileSync(join(root, '_toy', 'instruction.md'), '\nEdited between two batches.\n');
      const second = await batchRecord(l);
      expect(second.env_version).toBe(await envVersion(second.fixture_hash));
      expect(second.env_version).not.toBe(first.env_version);
    } finally {
      await l.runner.shutdown();
    }
  });
});
