// The one parse path from fixture bytes to a store (design section 1, "Isomorphism rule").
// A FixtureSource only produces bytes; cli/ reads them with fs and apps/web with fetch.
// parseNdjson turns bytes, gzipped or not, into resources the same way in both runtimes:
// gunzip when the gzip magic is present, strict UTF-8 decode (a leading BOM is dropped),
// then one JSON object per line.
import type { Resource } from '@medplum/fhirtypes';
import { Store } from './store.ts';

export interface FixtureSource {
  read(): Promise<Uint8Array>;
}

const isGzip = (b: Uint8Array) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Every line must be a JSON object with a string resourceType and id, and no (resourceType,
// id) may repeat. Lines end in LF or CRLF; only the final line may be empty. Errors name the
// 1-based line.
export async function parseNdjson(bytes: Uint8Array): Promise<Resource[]> {
  const raw = isGzip(bytes) ? await gunzip(bytes) : bytes;
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const seen = new Set<string>();
  return lines.map((line, i) => {
    const at = `fixture line ${i + 1}`;
    const body = line.endsWith('\r') ? line.slice(0, -1) : line;
    if (body.trim() === '') throw new Error(`${at}: empty line`);
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch (e) {
      throw new Error(`${at}: ${(e as Error).message}`, { cause: e });
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${at}: not a JSON object`);
    const { resourceType, id } = value as { resourceType?: unknown; id?: unknown };
    if (typeof resourceType !== 'string' || resourceType === '') throw new Error(`${at}: no resourceType`);
    if (typeof id !== 'string' || id === '') throw new Error(`${at}: no id`);
    const k = `${resourceType}/${id}`;
    if (seen.has(k)) throw new Error(`${at}: duplicate ${k}`);
    seen.add(k);
    return value as Resource;
  });
}

export async function loadStore(source: FixtureSource): Promise<Store> {
  return new Store(await parseNdjson(await source.read()));
}
