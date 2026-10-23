// Search latency on the committed world in each browser's Worker (design section 2, "Store":
// search is a linear scan, so PR 5 measures it). Each sample is the mean time of one search
// over a batch of at least 20 ms, so a 1 ms timer (Firefox, WebKit) adds under 5%.
// Measures only; it asserts that every search does real work (matches something), not a
// time limit. scripts/fixtures-latency.ts turns the JSON written here into
// docs/search-latency.md.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { LatencySearch } from '../../src/harness/protocol.ts';

const ROUNDS = 30;
// What the read tools will issue: one patient's chart (pt-0010 has the most Observations),
// panel-wide code searches, and a whole-type date range with a sort.
const SEARCHES: LatencySearch[] = [
  { name: 'Patient labs, newest first', resourceType: 'Observation', query: { patient: 'pt-0010', category: 'laboratory', _sort: '-date', _count: '50' } },
  { name: 'Patient SCr history', resourceType: 'Observation', query: { patient: 'pt-0010', code: 'http://loinc.org|2160-0', _sort: '-date' } },
  { name: 'Patient vitals in the last year', resourceType: 'Observation', query: { patient: 'pt-0010', category: 'vital-signs', date: 'ge2025-10-23' } },
  { name: 'Patient conditions', resourceType: 'Condition', query: { patient: 'pt-0010' } },
  { name: 'Patient active medications', resourceType: 'MedicationRequest', query: { patient: 'pt-0002', status: 'active' } },
  { name: 'Patient encounters, newest first', resourceType: 'Encounter', query: { patient: 'pt-0010', _sort: '-date' } },
  { name: 'Patient notes, newest 10', resourceType: 'DocumentReference', query: { patient: 'pt-0010', _sort: '-date', _count: '10' } },
  { name: 'Panel A1c results', resourceType: 'Observation', query: { code: 'http://loinc.org|4548-4' } },
  { name: 'All Observations since 2026-01-01, newest 100', resourceType: 'Observation', query: { date: 'ge2026-01-01', _sort: '-date', _count: '100' } },
];

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.ceil((p / 100) * xs.length) - 1]!;

test('search latency per search in this browser', async ({ page, browserName }) => {
  test.setTimeout(180_000);
  await page.goto('./harness.html');
  await expect(page.locator('body[data-ready="true"]')).toBeAttached();
  const r = await page.evaluate(
    ([searches, rounds]) => window.harness.call({ op: 'latency', url: new URL('data/fixtures/world.ndjson.gz', location.href).href, searches, rounds }),
    [SEARCHES, ROUNDS] as const,
  );

  const userAgent = await page.evaluate(() => navigator.userAgent);
  const dir = join(import.meta.dirname, '../../test-results/latency');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${browserName}.json`), `${JSON.stringify({ browser: browserName, version: page.context().browser()?.version(), userAgent, rounds: ROUNDS, ...r }, null, 2)}\n`);
  for (const s of r.results) {
    console.log(`${browserName} ${s.name}: p50 ${pct(s.samplesMs, 50).toFixed(3)} ms, p95 ${pct(s.samplesMs, 95).toFixed(3)} ms (batch ${s.batch}, ${s.total} matches)`);
    expect(s.total, s.name).toBeGreaterThan(0);
    expect(s.samplesMs).toHaveLength(ROUNDS);
  }
  console.log(`${browserName} store build from world bytes: ${r.buildMs.map((x) => x.toFixed(0)).join(', ')} ms (${r.resources} resources)`);
});
