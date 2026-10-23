// Messages between the harness page and its Worker. Later phases add operations here.

export type HarnessRequest =
  // Load a store from a fixture URL (NDJSON, gzipped or not) and hash it.
  { op: 'hash'; url: string };

export type HarnessResult = { op: 'hash'; hash: string; resources: number };

export type HarnessReply = { id: number; ok: true; result: HarnessResult } | { id: number; ok: false; error: string };
