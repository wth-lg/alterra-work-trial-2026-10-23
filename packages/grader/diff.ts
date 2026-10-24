// The state diff (design section 5): the resources a trial created, the ones it changed, and
// among those the status changes, keyed <Type>/<id> and compared as canonical JSON, so member
// order never makes a difference. Provenance is listed like any other resource.
import type { Resource } from '../env/store.ts';
import { canonicalJson } from '../env/hash.ts';

export interface Diff {
  created: readonly string[];
  updated: readonly string[];
  status_changed: ReadonlyArray<{ id: string; from: string | null; to: string | null }>;
}

export const keyOf = (r: Readonly<Resource>): string => `${r.resourceType}/${r.id}`;

const statusOf = (r: Readonly<Resource>): string | null => {
  const s = (r as { status?: unknown }).status;
  return typeof s === 'string' ? s : null;
};

export function diff(initial: Iterable<Readonly<Resource>>, final: Iterable<Readonly<Resource>>): Diff {
  const before = new Map<string, Readonly<Resource>>();
  for (const r of initial) before.set(keyOf(r), r);
  const created: string[] = [];
  const updated: string[] = [];
  const status_changed: Diff['status_changed'][number][] = [];
  for (const r of final) {
    const k = keyOf(r);
    const old = before.get(k);
    if (old === undefined) created.push(k);
    else if (canonicalJson(old) !== canonicalJson(r)) {
      updated.push(k);
      if (statusOf(old) !== statusOf(r)) status_changed.push({ id: k, from: statusOf(old), to: statusOf(r) });
    }
  }
  return { created, updated, status_changed };
}
