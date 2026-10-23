# Search latency

The store answers every search by a linear scan over one resource type (design section 2,
"Store"). This page measures that scan on the committed world in a Worker in each browser.

- World: `fixtures/world.ndjson.gz`, 7490 resources (3457 Observations), state hash `0b1b61ad3cc66e5b…`.
- Browsers: chromium 156.0.8078.4, firefox 157.0, webkit 27.2 (Playwright 1.64.1), headless.
- Machine: Apple M3 Max, 16 cores, 64 GB, darwin arm64.
- Command: `pnpm --filter web exec playwright test --project=xbrowser latency`, then `node scripts/fixtures-latency.ts`.

## Method

The harness page's Worker fetches the world once, builds a store, and runs each search 5
times to warm up. It then doubles a batch size until one batch takes at least 20 ms, and
takes 30 samples, each the mean time per search over one batch. Firefox and
WebKit clamp `performance.now()` to about 1 ms in a Worker that is not cross-origin
isolated, and a 20 ms batch keeps that rounding under 5% of a sample. p50 and p95 are
nearest-rank over the 30 samples. "Matches" is the total before `_count`,
the same in every browser; every search matches something, so none of them measures an
early exit.

## p95 per search, ms (p50 in brackets)

| Search | Matches | chromium | firefox | webkit |
|---|---:|---:|---:|---:|
| Patient labs, newest first | 137 | 0.775 (0.697) | 0.875 (0.719) | 0.594 (0.500) |
| Patient SCr history | 2 | 0.616 (0.588) | 0.688 (0.625) | 0.438 (0.406) |
| Patient vitals in the last year | 14 | 0.622 (0.606) | 0.688 (0.625) | 0.438 (0.422) |
| Patient conditions | 36 | 0.162 (0.159) | 0.172 (0.164) | 0.117 (0.109) |
| Patient active medications | 10 | 0.068 (0.067) | 0.070 (0.066) | 0.047 (0.045) |
| Patient encounters, newest first | 6 | 0.066 (0.066) | 0.066 (0.063) | 0.047 (0.045) |
| Patient notes, newest 10 | 6 | 0.061 (0.061) | 0.063 (0.061) | 0.045 (0.043) |
| Panel A1c results | 48 | 0.737 (0.713) | 0.969 (0.938) | 0.938 (0.750) |
| All Observations since 2026-01-01, newest 100 | 1389 | 3.688 (3.625) | 3.750 (3.500) | 3.000 (2.750) |

## Store build

A trial builds a fresh store from the world bytes (gunzip, parse, freeze and admit each
resource). Five builds, ms: chromium 102, 80, 80, 80, 76; firefox 155, 148, 147, 151, 140; webkit 134, 123, 111, 127, 120.

## Reading the numbers

Cost follows the size of the scanned type: searches over Observation (3457 resources) cost about
ten times those over Encounter or DocumentReference (358 each), whatever the patient filter
returns. The slowest search reads a date on every Observation and sorts 1389 matches. All are
far below a model turn (seconds), so the scan needs no index at this world size. These are
one run on one machine; they say where the time goes, not what a slower laptop will see.
