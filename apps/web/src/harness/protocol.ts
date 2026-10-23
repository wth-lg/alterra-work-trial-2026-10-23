// Messages between the harness page and its Worker. Later phases add operations here.
import type { SearchQuery } from '../../../../packages/env/search.ts';

export type HarnessRequest =
  // Load a store from a fixture URL (NDJSON, gzipped or not) and hash it.
  | { op: 'hash'; url: string }
  // Build store A, hash it, make `writes` writes to it and hash it again, then build `fresh`
  // new stores from the same bytes and hash each (design section 2, "Reset and state hash").
  | { op: 'stateHashRounds'; url: string; writes: number; fresh: number }
  // Time each search on one store built from the URL: `rounds` samples per search, each the
  // mean over a batch long enough that timer granularity stays under 5% of it.
  | { op: 'latency'; url: string; searches: readonly LatencySearch[]; rounds: number };

export interface LatencySearch {
  name: string;
  resourceType: string;
  query: SearchQuery;
}

export interface LatencyResult {
  name: string;
  // Matches before _count, and resources returned, so a search that matches nothing shows.
  total: number;
  returned: number;
  batch: number;
  samplesMs: number[];
}

export type HarnessResult =
  | { op: 'hash'; hash: string; resources: number }
  | { op: 'stateHashRounds'; resources: number; initial: string; afterWrites: string; fresh: string[] }
  | { op: 'latency'; resources: number; buildMs: number[]; results: LatencyResult[] };

export type HarnessReply = { id: number; ok: true; result: HarnessResult } | { id: number; ok: false; error: string };
