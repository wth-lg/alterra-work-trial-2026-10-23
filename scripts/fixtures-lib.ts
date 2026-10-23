// Shared by the fixtures-* scripts: NDJSON and gzip in a form that rebuilds byte for byte.
import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Resource } from '../packages/env/store.ts';

export const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

const byTypeThenId = (a: Resource, b: Resource): number =>
  a.resourceType < b.resourceType ? -1 : a.resourceType > b.resourceType ? 1 : a.id! < b.id! ? -1 : a.id! > b.id! ? 1 : 0;

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
