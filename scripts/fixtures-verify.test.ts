// fixtures:verify is only a gate if CI runs it: an overlay or world.ts edit without
// pnpm fixtures:build must fail the PR.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

const repo = fileURLToPath(new URL('..', import.meta.url));

it('CI runs pnpm fixtures:verify in the check job, after the build', () => {
  const ci = parse(readFileSync(join(repo, '.github/workflows/ci.yml'), 'utf8')) as { jobs: { check: { steps: Array<{ run?: string }> } } };
  const runs = ci.jobs.check.steps.map((s) => s.run ?? '');
  expect(runs).toContain('pnpm fixtures:verify');
  expect(runs.indexOf('pnpm fixtures:verify')).toBeGreaterThan(runs.indexOf('pnpm build'));
});
