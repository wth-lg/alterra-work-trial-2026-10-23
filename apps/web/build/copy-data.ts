// Copies the committed results the static site serves into <outDir>/data/ and writes
// <outDir>/data/index.json listing every copied file (paths relative to data/).
// Sources, relative to the source root (env RESULTS_ROOT, default the repo root):
//   results/official.json and, from the run directory it names ({"run": "runs/<id>"},
//   relative to results/), trials/, trajectories/, summary.json and audit.jsonl;
//   docs/findings.md; fixtures/world.ndjson.gz and fixtures/manifest.json.
// A missing source is skipped, so a tree with no results/ yields an empty index.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const RUN_ENTRIES = ['trials', 'trajectories', 'summary.json', 'audit.jsonl'];
const FIXED_FILES = ['results/official.json', 'docs/findings.md', 'fixtures/world.ndjson.gz', 'fixtures/manifest.json'];

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

function listFiles(root: string, rel: string): string[] {
  const abs = join(root, rel);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile()).map((e) => relative(root, join(e.parentPath, e.name)).split(sep).join('/'));
}

function officialRunFiles(root: string): string[] {
  const official = join(root, 'results/official.json');
  if (!existsSync(official)) return [];
  const { run } = JSON.parse(readFileSync(official, 'utf8')) as { run?: unknown };
  if (typeof run !== 'string') throw new Error('results/official.json: expected {"run": "runs/<id>"}');
  const results = join(root, 'results');
  const runDir = resolve(results, run);
  if (!runDir.startsWith(results + sep)) throw new Error(`results/official.json: run path ${run} is outside results/`);
  const runRel = relative(root, runDir).split(sep).join('/');
  return RUN_ENTRIES.flatMap((entry) => {
    const rel = `${runRel}/${entry}`;
    const stat = statSync(join(root, rel), { throwIfNoEntry: false });
    if (!stat) return [];
    return stat.isDirectory() ? listFiles(root, rel) : [rel];
  });
}

export function copyData({ root, outDir }: { root: string; outDir: string }): string[] {
  const files = [...FIXED_FILES.filter((f) => existsSync(join(root, f))), ...officialRunFiles(root)].sort();
  const dataDir = join(outDir, 'data');
  rmSync(dataDir, { recursive: true, force: true });
  mkdirSync(dataDir, { recursive: true });
  for (const f of files) cpSync(join(root, f), join(dataDir, f));
  writeFileSync(join(dataDir, 'index.json'), `${JSON.stringify({ files }, null, 2)}\n`);
  return files;
}

export function copyDataPlugin(): Plugin {
  let outDir = '';
  return {
    name: 'copy-data',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      copyData({ root: process.env.RESULTS_ROOT ?? repoRoot, outDir });
    },
  };
}
