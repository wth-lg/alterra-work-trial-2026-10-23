// The Pages artifact holds the app only: harness.html and probe.html are test pages, built for
// the e2e runs (pnpm build) and left out of the build pages.yml uploads. Each build goes to a
// temp outDir, so apps/web/dist, which the e2e runs serve, is left as it is.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(webRoot, '..', '..');

// The run command of the pages.yml step that builds what upload-pages-artifact uploads.
function pagesBuildCommand(): string {
  const wf = parse(readFileSync(join(repoRoot, '.github/workflows/pages.yml'), 'utf8')) as { jobs: { build: { steps: Array<{ run?: string; uses?: string }> } } };
  const steps = wf.jobs.build.steps;
  const upload = steps.findIndex((s) => s.uses?.startsWith('actions/upload-pages-artifact@'));
  const builds = steps.slice(0, upload).filter((s) => s.run !== undefined && /\bbuild\b/.test(s.run) && !/install/.test(s.run));
  expect(builds).toHaveLength(1);
  return builds[0]!.run!.trim();
}

function build(args: string[]): string[] {
  const out = mkdtempSync(join(tmpdir(), 'pages-build-'));
  const r = spawnSync(join(webRoot, 'node_modules/.bin/vite'), ['build', ...args, '--outDir', out, '--emptyOutDir', '--logLevel', 'error'], { cwd: webRoot, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`vite build exited ${r.status}: ${r.stderr}`);
  return readdirSync(out, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => join(e.parentPath, e.name).slice(out.length + 1)).sort();
}

describe('the Pages build', () => {
  const command = pagesBuildCommand();
  const mode = /--mode (\S+)/.exec(command)?.[1];

  it('pages.yml builds the web app in its own mode', () => {
    expect(command).toBe('pnpm --filter web build --mode pages');
    expect(mode).toBe('pages');
  });

  it('holds index.html and its assets, and no test page', () => {
    const files = build(['--mode', mode ?? '']);
    expect(files.filter((f) => f.endsWith('.html'))).toEqual(['index.html']);
    expect(files.filter((f) => /probe|harness|worker/.test(f))).toEqual([]);
  });

  it('the default build, which the e2e runs serve, still has the test pages', () => {
    expect(build([]).filter((f) => f.endsWith('.html')).sort()).toEqual(['harness.html', 'index.html', 'probe.html']);
  });
});
