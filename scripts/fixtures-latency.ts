// Writes docs/search-latency.md from the JSON apps/web/e2e/xbrowser/latency.spec.ts leaves in
// apps/web/test-results/latency/, one file per browser:
//
//   pnpm --filter web exec playwright test --project=xbrowser latency && node scripts/fixtures-latency.ts
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { arch, cpus, platform, totalmem } from 'node:os';
import { join } from 'node:path';
import type { LatencyResult } from '../apps/web/src/harness/protocol.ts';
import { repo } from './fixtures-build.ts';

interface Run {
  browser: string;
  version?: string;
  rounds: number;
  resources: number;
  buildMs: number[];
  results: LatencyResult[];
}

const dir = join(repo, 'apps/web/test-results/latency');
const order = ['chromium', 'firefox', 'webkit'];
const runs = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Run)
  .sort((a, b) => order.indexOf(a.browser) - order.indexOf(b.browser));
if (runs.length !== 3) throw new Error(`expected 3 browsers in ${dir}, found ${runs.map((r) => r.browser).join(', ') || 'none'}`);

const manifest = JSON.parse(readFileSync(join(repo, 'fixtures/manifest.json'), 'utf8')) as { world: { state_hash: string; resources: number; by_type: Record<string, number> } };
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.ceil((p / 100) * xs.length) - 1]!;
const ms = (x: number) => x.toFixed(3);
const playwright = (JSON.parse(readFileSync(join(repo, 'apps/web/package.json'), 'utf8')) as { devDependencies: Record<string, string> }).devDependencies['@playwright/test'];

const names = runs[0]!.results.map((r) => r.name);
const row = (name: string) => {
  const cells = runs.map((run) => run.results.find((r) => r.name === name)!);
  return `| ${name} | ${cells[0]!.total} | ${cells.map((c) => `${ms(pct(c.samplesMs, 95))} (${ms(pct(c.samplesMs, 50))})`).join(' | ')} |`;
};

const doc = `# Search latency

The store answers every search by a linear scan over one resource type (design section 2,
"Store"). This page measures that scan on the committed world in a Worker in each browser.

- World: \`fixtures/world.ndjson.gz\`, ${manifest.world.resources} resources (${manifest.world.by_type.Observation} Observations), state hash \`${manifest.world.state_hash.slice(0, 16)}…\`.
- Browsers: ${runs.map((r) => `${r.browser} ${r.version ?? ''}`.trim()).join(', ')} (Playwright ${playwright}), headless.
- Machine: ${cpus()[0]?.model ?? 'unknown CPU'}, ${cpus().length} cores, ${Math.round(totalmem() / 2 ** 30)} GB, ${platform()} ${arch()}.
- Command: \`pnpm --filter web exec playwright test --project=xbrowser latency\`, then \`node scripts/fixtures-latency.ts\`.

## Method

The harness page's Worker fetches the world once, builds a store, and runs each search 5
times to warm up. It then doubles a batch size until one batch takes at least 20 ms, and
takes ${runs[0]!.rounds} samples, each the mean time per search over one batch. Firefox and
WebKit clamp \`performance.now()\` to about 1 ms in a Worker that is not cross-origin
isolated, and a 20 ms batch keeps that rounding under 5% of a sample. p50 and p95 are
nearest-rank over the ${runs[0]!.rounds} samples. "Matches" is the total before \`_count\`,
the same in every browser; every search matches something, so none of them measures an
early exit.

## p95 per search, ms (p50 in brackets)

| Search | Matches | ${runs.map((r) => r.browser).join(' | ')} |
|---|---:|${runs.map(() => '---:').join('|')}|
${names.map(row).join('\n')}

## Store build

A trial builds a fresh store from the world bytes (gunzip, parse, freeze and admit each
resource). Five builds, ms: ${runs.map((r) => `${r.browser} ${r.buildMs.map((x) => x.toFixed(0)).join(', ')}`).join('; ')}.

## Reading the numbers

Cost follows the size of the scanned type: searches over Observation (${manifest.world.by_type.Observation} resources) cost about
ten times those over Encounter or DocumentReference (${manifest.world.by_type.Encounter} each), whatever the patient filter
returns. The slowest search reads a date on every Observation and sorts ${runs[0]!.results.at(-1)!.total} matches. All are
far below a model turn (seconds), so the scan needs no index at this world size. These are
one run on one machine; they say where the time goes, not what a slower laptop will see.
`;
writeFileSync(join(repo, 'docs/search-latency.md'), doc);
console.log(`wrote docs/search-latency.md from ${runs.map((r) => r.browser).join(', ')}`);
