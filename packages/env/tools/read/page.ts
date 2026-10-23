// Paging for every list result (design section 3): at most `count` entries from `offset`,
// further cut so the JSON stays under the token cap. `next_offset` is present whenever entries
// remain after the page; `truncated` marks a page the cap cut short. A page always holds at
// least one entry when any remain, so following next_offset always reaches the end.
import { withinCap } from '../registry.ts';

export interface Page<T> {
  total: number;
  entries: T[];
  next_offset?: number;
  truncated?: true;
}

export function page<T>(all: readonly T[], offset: number, count: number): Page<T> {
  const total = all.length;
  const candidates = all.slice(offset, offset + count);
  const build = (n: number, truncated: boolean): Page<T> => {
    const p: Page<T> = { total, entries: candidates.slice(0, n) };
    if (offset + n < total) p.next_offset = offset + n;
    if (truncated) p.truncated = true;
    return p;
  };
  const whole = build(candidates.length, false);
  if (withinCap(JSON.stringify(whole).length)) return whole;
  // JSON.stringify writes an array as its items' JSON joined by commas, so a page of n entries
  // is exactly its envelope (with entries empty) plus the first n entry lengths plus n - 1 commas.
  const lengths = candidates.map((e) => JSON.stringify(e).length);
  const size = (n: number, items: number) => JSON.stringify({ ...build(n, true), entries: [] }).length + items + n - 1;
  let n = 1;
  let items = lengths[0]!;
  while (n < candidates.length && withinCap(size(n + 1, items + lengths[n]!))) items += lengths[n++]!;
  return build(n, true);
}
