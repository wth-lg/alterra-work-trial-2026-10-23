// Search latency on the committed world in each browser's Worker (design section 2, "Store":
// search is a linear scan, so PR 5 measures it). Each sample is the mean time of one search
// over a batch of at least 20 ms, so a 1 ms timer (Firefox, WebKit) adds under 5%.
// Measures only; it asserts that every search does real work (matches something), not a
// time limit. scripts/fixtures-latency.ts turns the JSON written here into
// docs/search-latency.md.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { expect, test } from '@playwright/test';
import type { LatencySearch } from '../../src/harness/protocol.ts';

const ROUNDS = 30;

// The patients the chart searches target, picked from the world this run serves (the file
// `pnpm build` copies into dist/data/), not fixed ids: a task overlay can rewrite any base
// patient, as T2's did to pt-0010's notes. The chart patient is the one with the most
// Observations among those with every kind of record the chart searches ask for; the
// medications patient is the one with the most active MedicationRequests.
type Row = { resourceType: string; id: string; status?: string; subject?: { reference?: string }; category?: Array<{ coding?: Array<{ code?: string }> }>; code?: { coding?: Array<{ system?: string; code?: string }> }; effectiveDateTime?: string };
const world = gunzipSync(readFileSync(new URL('../../../../fixtures/world.ndjson.gz', import.meta.url)))
  .toString('utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Row);
const category = (r: Row, c: string) => r.category?.some((x) => x.coding?.some((y) => y.code === c)) ?? false;
const CHART: Record<string, (r: Row) => boolean> = {
  lab: (r) => r.resourceType === 'Observation' && category(r, 'laboratory'),
  scr: (r) => r.resourceType === 'Observation' && (r.code?.coding?.some((c) => c.system === 'http://loinc.org' && c.code === '2160-0') ?? false),
  vitals: (r) => r.resourceType === 'Observation' && category(r, 'vital-signs') && (r.effectiveDateTime ?? '') >= '2025-10-23',
  condition: (r) => r.resourceType === 'Condition',
  encounter: (r) => r.resourceType === 'Encounter',
  note: (r) => r.resourceType === 'DocumentReference',
};
function most(pick: (r: Row) => boolean, among: (id: string) => boolean = () => true): string {
  const n = new Map<string, number>();
  for (const r of world) {
    const id = r.subject?.reference?.replace(/^Patient\//, '');
    if (id && among(id) && pick(r)) n.set(id, (n.get(id) ?? 0) + 1);
  }
  const best = [...n].sort(([a, x], [b, y]) => y - x || (a < b ? -1 : 1))[0];
  if (!best) throw new Error('no patient in the world has the records the latency searches need');
  return best[0];
}
const complete = (id: string) => Object.values(CHART).every((p) => world.some((r) => r.subject?.reference === `Patient/${id}` && p(r)));
const CHART_PT = most((r) => r.resourceType === 'Observation', complete);
const MEDS_PT = most((r) => r.resourceType === 'MedicationRequest' && r.status === 'active');

const TARGETS = `chart ${CHART_PT}, medications ${MEDS_PT}`;
// What the read tools will issue: one patient's chart, panel-wide code searches, and a
// whole-type date range with a sort.
const SEARCHES: LatencySearch[] = [
  { name: 'Patient labs, newest first', resourceType: 'Observation', query: { patient: CHART_PT, category: 'laboratory', _sort: '-date', _count: '50' } },
  { name: 'Patient SCr history', resourceType: 'Observation', query: { patient: CHART_PT, code: 'http://loinc.org|2160-0', _sort: '-date' } },
  { name: 'Patient vitals in the last year', resourceType: 'Observation', query: { patient: CHART_PT, category: 'vital-signs', date: 'ge2025-10-23' } },
  { name: 'Patient conditions', resourceType: 'Condition', query: { patient: CHART_PT } },
  { name: 'Patient active medications', resourceType: 'MedicationRequest', query: { patient: MEDS_PT, status: 'active' } },
  { name: 'Patient encounters, newest first', resourceType: 'Encounter', query: { patient: CHART_PT, _sort: '-date' } },
  { name: 'Patient notes, newest 10', resourceType: 'DocumentReference', query: { patient: CHART_PT, _sort: '-date', _count: '10' } },
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
  console.log(`${browserName} targets: ${TARGETS}`);
  console.log(`${browserName} store build from world bytes: ${r.buildMs.map((x) => x.toFixed(0)).join(', ')} ms (${r.resources} resources)`);
});
