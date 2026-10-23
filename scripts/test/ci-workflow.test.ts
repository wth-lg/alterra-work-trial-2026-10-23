import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { repoRoot } from './helpers.ts';

// The e2e job runs in the official Playwright image so CI never installs browsers or apt
// packages. The image ships browsers for one Playwright version, so its tag must follow the
// pinned @playwright/test; a version bump without an image bump fails here.

type Step = { run?: string; uses?: string; if?: string; with?: Record<string, unknown> };
type Job = { 'runs-on'?: string; 'timeout-minutes'?: number; needs?: string | string[]; container?: string | { image?: string }; steps: Step[] };

const workflow = parse(readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8')) as { jobs: Record<string, Job> };
const pkg = JSON.parse(readFileSync(join(repoRoot, 'apps/web/package.json'), 'utf8')) as { devDependencies: Record<string, string> };
const { check, e2e } = workflow.jobs;
const runs = (job: Job | undefined) => (job?.steps ?? []).map((s) => s.run ?? '');

describe('ci workflow', () => {
  it('runs e2e after check, each with a 20 minute timeout', () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual(['check', 'e2e']);
    expect(check?.['runs-on']).toBe('ubuntu-latest');
    expect(check?.['timeout-minutes']).toBe(20);
    expect(e2e?.['timeout-minutes']).toBe(20);
    expect([e2e?.needs].flat()).toEqual(['check']);
  });

  it('runs e2e in the Playwright image that matches the pinned @playwright/test', () => {
    const version = pkg.devDependencies['@playwright/test'];
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    const image = typeof e2e?.container === 'string' ? e2e.container : e2e?.container?.image;
    expect(image).toBe(`mcr.microsoft.com/playwright:v${version}-noble`);
  });

  it('never installs browsers or system packages', () => {
    for (const run of [...runs(check), ...runs(e2e)]) {
      expect(run).not.toMatch(/playwright\s+install/);
      expect(run).not.toMatch(/\bapt(-get)?\b/);
    }
  });

  it('runs Playwright only in e2e and uploads the report on failure', () => {
    expect(runs(check).filter((r) => /playwright/.test(r))).toEqual([]);
    expect(runs(e2e)).toContain('pnpm --filter web exec playwright test --project=mocked --project=xbrowser');
    const upload = e2e?.steps.find((s) => s.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.if).toBe('failure()');
    expect(upload?.with?.path).toBe('apps/web/playwright-report');
  });
});
