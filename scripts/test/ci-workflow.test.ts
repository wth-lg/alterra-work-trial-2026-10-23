import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { repoRoot } from './helpers.ts';

// The e2e job runs in the official Playwright image so CI never installs browsers or apt
// packages. The image ships browsers for one Playwright version, so its tag must follow the
// pinned @playwright/test; a version bump without an image bump fails here.

type Step = { id?: string; run?: string; uses?: string; if?: string; env?: Record<string, string>; with?: Record<string, unknown> };
type Job = {
  name?: string;
  'runs-on'?: string;
  'timeout-minutes'?: number;
  needs?: string | string[];
  if?: string;
  outputs?: Record<string, string>;
  strategy?: { 'fail-fast'?: boolean; matrix?: Record<string, unknown> };
  container?: string | { image?: string };
  steps: Step[];
};

const workflow = parse(readFileSync(join(repoRoot, '.github/workflows/ci.yml'), 'utf8')) as { jobs: Record<string, Job> };
const pkg = JSON.parse(readFileSync(join(repoRoot, 'apps/web/package.json'), 'utf8')) as { devDependencies: Record<string, string> };
const { check, e2e, tasks, matrix } = workflow.jobs;
const matrixOk = workflow.jobs['matrix-ok'];
const runs = (job: Job | undefined) => (job?.steps ?? []).map((s) => s.run ?? '');

describe('ci workflow', () => {
  it('runs e2e after check, each with a 20 minute timeout', () => {
    expect(Object.keys(workflow.jobs).sort()).toEqual(['check', 'e2e', 'matrix', 'matrix-ok', 'tasks']);
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
    for (const run of Object.values(workflow.jobs).flatMap(runs)) {
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

  // The grader validation matrix runs one job per task, in parallel with check, over the ids
  // `pnpm cli matrix --list-tasks` prints, so a new task needs no edit here.
  it('runs the grader matrix as one job per listed task, not in check', () => {
    expect(runs(check).filter((r) => /\bmatrix\b/.test(r))).toEqual([]);
    const list = tasks?.steps.find((s) => s.id === 'list');
    // Assigned first: under the runner's bash -e a failing listing then fails the step, where
    // echo "ids=$(...)" would hide its exit code.
    expect(list?.run).toBe('ids=$(pnpm --silent cli matrix --list-tasks)\necho "ids=$ids" >> "$GITHUB_OUTPUT"\n');
    expect(tasks?.outputs?.ids).toBe('${{ steps.list.outputs.ids }}');
    expect([matrix?.needs].flat()).toEqual(['tasks']);
    expect(matrix?.strategy?.['fail-fast']).toBe(false);
    expect(matrix?.strategy?.matrix).toEqual({ task: '${{ fromJSON(needs.tasks.outputs.ids) }}' });
    const step = matrix?.steps.find((s) => s.run?.includes('cli matrix'));
    expect(step?.env).toEqual({ TASK: '${{ matrix.task }}' });
    expect(step?.run).toBe('pnpm cli matrix --task "$TASK"');
  });

  it('sizes the matrix timeouts and gives branch protection one stable check', () => {
    expect(tasks?.['timeout-minutes']).toBe(5);
    expect(matrix?.['timeout-minutes']).toBe(20);
    expect([matrixOk?.needs].flat()).toEqual(['matrix']);
    expect(matrixOk?.if).toBe('always()');
    expect(matrixOk?.steps.at(-1)?.env).toEqual({ RESULT: '${{ needs.matrix.result }}' });
    expect(matrixOk?.steps.at(-1)?.run).toBe('test "$RESULT" = success');
  });
});
