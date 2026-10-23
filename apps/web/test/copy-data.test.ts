import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { copyData, repoRoot } from '../build/copy-data.ts';

const webRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = (p: string) => mkdtempSync(join(tmpdir(), `${p}-`));

function put(root: string, rel: string, content = '{}\n') {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

function resultsTree(): string {
  const root = tmp('results-root');
  put(root, 'results/official.json', JSON.stringify({ run: 'runs/final-1' }));
  put(root, 'results/runs/final-1/trials/t1/0.json');
  put(root, 'results/runs/final-1/trials/t1/1.json');
  put(root, 'results/runs/final-1/trajectories/t1/0.jsonl', '{}\n');
  put(root, 'results/runs/final-1/trajectories/t1/1.jsonl', '{}\n');
  put(root, 'results/runs/final-1/summary.json');
  put(root, 'results/runs/final-1/audit.jsonl', '{}\n');
  put(root, 'results/runs/final-1/scratch.tmp', 'not copied\n');
  put(root, 'results/runs/pilot-1/summary.json');
  put(root, 'docs/findings.md', '# Findings\n');
  return root;
}

const EXPECTED = [
  'docs/findings.md',
  'results/official.json',
  'results/runs/final-1/audit.jsonl',
  'results/runs/final-1/summary.json',
  'results/runs/final-1/trajectories/t1/0.jsonl',
  'results/runs/final-1/trajectories/t1/1.jsonl',
  'results/runs/final-1/trials/t1/0.json',
  'results/runs/final-1/trials/t1/1.json',
];

const index = (outDir: string) => JSON.parse(readFileSync(join(outDir, 'data/index.json'), 'utf8')) as { files: string[] };

describe('copyData', () => {
  it('defaults its source root to the repo root', () => {
    expect(existsSync(join(repoRoot, 'pnpm-workspace.yaml'))).toBe(true);
  });

  it('copies the official run, findings and fixtures and lists them in index.json', () => {
    const root = resultsTree();
    put(root, 'fixtures/world.ndjson.gz', 'gz');
    put(root, 'fixtures/manifest.json');
    const outDir = tmp('dist');
    copyData({ root, outDir });
    const files = [...EXPECTED, 'fixtures/manifest.json', 'fixtures/world.ndjson.gz'].sort();
    expect(index(outDir).files).toEqual(files);
    for (const f of files) expect(existsSync(join(outDir, 'data', f))).toBe(true);
    expect(existsSync(join(outDir, 'data/results/runs/pilot-1'))).toBe(false);
    expect(existsSync(join(outDir, 'data/results/runs/final-1/scratch.tmp'))).toBe(false);
  });

  it('writes an empty index when there is no source data', () => {
    const outDir = tmp('dist');
    copyData({ root: tmp('empty-root'), outDir });
    expect(index(outDir)).toEqual({ files: [] });
  });

  it('is safe to run twice', () => {
    const root = resultsTree();
    const outDir = tmp('dist');
    copyData({ root, outDir });
    copyData({ root, outDir });
    expect(index(outDir).files).toEqual(EXPECTED);
  });

  it('rejects an official.json run path that leaves results/', () => {
    const root = tmp('evil-root');
    put(root, 'results/official.json', JSON.stringify({ run: '../../etc' }));
    expect(() => copyData({ root, outDir: tmp('dist') })).toThrow(/outside results/);
  });
});

describe('vite build with copy-data', () => {
  const build = (resultsRoot: string, outDir: string) =>
    spawnSync('pnpm', ['exec', 'vite', 'build', '--outDir', outDir, '--emptyOutDir', '--logLevel', 'error'], {
      cwd: webRoot,
      env: { ...process.env, RESULTS_ROOT: resultsRoot },
      encoding: 'utf8',
    });

  it('copies data from RESULTS_ROOT into dist/data', () => {
    const outDir = tmp('dist');
    const r = build(resultsTree(), outDir);
    expect(r.status, r.stderr).toBe(0);
    expect(index(outDir).files).toEqual(EXPECTED);
    expect(existsSync(join(outDir, 'data/results/runs/final-1/trials/t1/1.json'))).toBe(true);
  });

  it('exits 0 with an empty index when there is no results/', () => {
    const outDir = tmp('dist');
    const r = build(tmp('empty-root'), outDir);
    expect(r.status, r.stderr).toBe(0);
    expect(index(outDir)).toEqual({ files: [] });
  });
});
