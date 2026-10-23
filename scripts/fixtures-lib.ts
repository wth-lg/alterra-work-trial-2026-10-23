// Shared by the fixtures-* scripts: NDJSON and gzip in a form that rebuilds byte for byte.
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Resource } from '../packages/env/store.ts';

export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

// UTF-16 code unit order. localeCompare follows the host's LC_ALL/LANG (a Danish collation
// sorts 'aa' after 'z'), so no fixtures script may sort with it.
export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byTypeThenId = (a: Resource, b: Resource): number => cmp(a.resourceType, b.resourceType) || cmp(a.id!, b.id!);

// One resource per line, sorted by (resourceType, id), LF after every line.
export function toNdjson(resources: Iterable<Resource>): string {
  return [...resources].sort(byTypeThenId).map((r) => `${JSON.stringify(r)}\n`).join('');
}

// gzip with a fixed header: zlib writes mtime 0 but an OS byte that differs by platform
// (19 on macOS, 3 on Linux), so the byte is set to 255 ("unknown"). The deflate stream itself
// can still differ between zlib builds, which is why every check compares the decompressed
// NDJSON and never the .gz bytes.
export function gzip(text: string): Buffer {
  const out = gzipSync(text, { level: 9 });
  out[9] = 0xff;
  return out;
}

export const gunzip = (bytes: Uint8Array): Buffer => gunzipSync(bytes);
