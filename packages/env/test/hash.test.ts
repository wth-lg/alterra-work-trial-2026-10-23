import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import type { Resource } from '@medplum/fhirtypes';
import canonicalize from 'canonicalize';
import { describe, expect, it } from 'vitest';
import { generateWorld, toNdjson } from '../../../apps/web/src/harness/generate.ts';
import { parseNdjson } from '../fixture-source.ts';
import { canonicalJson, stateHash } from '../hash.ts';

const EDGE = readFileSync(new URL('./fixtures/hash-edge.ndjson', import.meta.url));

// The golden: Node's own UTF-8 decode and JSON.parse, top-level meta removed, sorted by
// (resourceType, id) in UTF-16 code-unit order, then the canonicalize package (the RFC 8785
// reference implementation) and node:crypto SHA-256. Nothing here comes from hash.ts.
function golden(bytes: Uint8Array): string {
  const lines = Buffer.from(bytes).toString('utf8').split('\n').filter((l) => l !== '');
  const resources = lines.map((l) => {
    const { meta: _meta, ...rest } = JSON.parse(l) as Record<string, unknown>;
    return rest as { resourceType: string; id: string };
  });
  resources.sort((a, b) => (a.resourceType < b.resourceType ? -1 : a.resourceType > b.resourceType ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return createHash('sha256').update(canonicalize(resources)!, 'utf8').digest('hex');
}

const hashBytes = async (bytes: Uint8Array): Promise<string> => stateHash(await parseNdjson(bytes));

// RFC 8785 Appendix B: IEEE 754 bits and their JSON form. NaN and Infinity must be refused.
const APPENDIX_B: Array<[string, string | null]> = [
  ['0000000000000000', '0'],
  ['8000000000000000', '0'],
  ['0000000000000001', '5e-324'],
  ['8000000000000001', '-5e-324'],
  ['7fefffffffffffff', '1.7976931348623157e+308'],
  ['ffefffffffffffff', '-1.7976931348623157e+308'],
  ['4340000000000000', '9007199254740992'],
  ['c340000000000000', '-9007199254740992'],
  ['4430000000000000', '295147905179352830000'],
  ['7fffffffffffffff', null],
  ['7ff0000000000000', null],
  ['44b52d02c7e14af5', '9.999999999999997e+22'],
  ['44b52d02c7e14af6', '1e+23'],
  ['44b52d02c7e14af7', '1.0000000000000001e+23'],
  ['444b1ae4d6e2ef4e', '999999999999999700000'],
  ['444b1ae4d6e2ef4f', '999999999999999900000'],
  ['444b1ae4d6e2ef50', '1e+21'],
  ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
  ['3eb0c6f7a0b5ed8d', '0.000001'],
  ['41b3de4355555553', '333333333.3333332'],
  ['41b3de4355555554', '333333333.33333325'],
  ['41b3de4355555555', '333333333.3333333'],
  ['41b3de4355555556', '333333333.3333334'],
  ['41b3de4355555557', '333333333.33333343'],
  ['becbf647612f3696', '-0.0000033333333333333333'],
  ['43143ff3c1cb0959', '1424953923781206.2'],
];

const fromBits = (hex: string): number => {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${hex}`));
  return view.getFloat64(0);
};

// One JSON \uXXXX escape, as text.
const u = (hex: string) => `\\u${hex}`;

describe('RFC 8785 vectors', () => {
  it.each(APPENDIX_B)('Appendix B %s serializes as %s', (bits, expected) => {
    const n = fromBits(bits);
    if (expected === null) expect(() => canonicalJson(n)).toThrow();
    else expect(canonicalJson(n)).toBe(expected);
  });

  it('section 3.2.2 sample canonicalizes to the section 3.2.4 bytes', () => {
    // The RFC's input text, escapes and all.
    const input = `{
      "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
      "string": "${u('20ac')}$${u('000F')}${u('000a')}A'${u('0042')}${u('0022')}${u('005c')}\\\\\\"\\/",
      "literals": [null, true, false]
    }`;
    const expectedHex =
      '7b 22 6c 69 74 65 72 61 6c 73 22 3a 5b 6e 75 6c 6c 2c 74 72 75 65 2c 66 61 6c 73 65 5d 2c 22 6e 75 6d 62 65 72 73 22 3a ' +
      '5b 33 33 33 33 33 33 33 33 33 2e 33 33 33 33 33 33 33 2c 31 65 2b 33 30 2c 34 2e 35 2c 30 2e 30 30 32 2c 31 65 2d 32 37 ' +
      '5d 2c 22 73 74 72 69 6e 67 22 3a 22 e2 82 ac 24 5c 75 30 30 30 66 5c 6e 41 27 42 5c 22 5c 5c 5c 5c 5c 22 2f 22 7d';
    const bytes = new TextEncoder().encode(canonicalJson(JSON.parse(input)));
    expect(Buffer.from(bytes).toString('hex').match(/../g)!.join(' ')).toBe(expectedHex);
  });

  it('section 3.2.3 sorts property names by UTF-16 code units', () => {
    const input = `{"${u('20ac')}":"Euro Sign","\\r":"Carriage Return","${u('fb33')}":"Hebrew Letter Dalet With Dagesh","1":"One","${u('d83d')}${u('de00')}":"Emoji: Grinning Face","${u('0080')}":"Control","${u('00f6')}":"Latin Small Letter O With Diaeresis"}`;
    // Read the order from the text: Object.values would move the integer-like key first.
    const order = [...canonicalJson(JSON.parse(input)).matchAll(/:"([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual([
      'Carriage Return',
      'One',
      'Control',
      'Latin Small Letter O With Diaeresis',
      'Euro Sign',
      'Emoji: Grinning Face',
      'Hebrew Letter Dalet With Dagesh',
    ]);
  });

  it('refuses lone surrogates, non-finite numbers and non-JSON values', () => {
    expect(() => canonicalJson('\ud800')).toThrow(/surrogate/i);
    expect(() => canonicalJson({ a: '\udc00x' })).toThrow(/surrogate/i);
    expect(() => canonicalJson([Number.NaN])).toThrow();
    expect(() => canonicalJson({ a: [undefined] })).toThrow();
    // A hole is not JSON: [1,,3] would otherwise come out as the text '[1,,3]'.
    expect(() => canonicalJson({ a: [1, , 3] })).toThrow(/sparse/);
    expect(() => canonicalJson({ a: new Date(0) })).toThrow();
    expect(() => canonicalJson({ a: 1n })).toThrow();
    // Undefined object members are dropped, as JSON.stringify and canonicalize drop them.
    expect(canonicalJson({ b: 1, a: undefined })).toBe('{"b":1}');
  });

  it('agrees with canonicalize on the generated world', () => {
    for (const resource of generateWorld(7, 300)) expect(canonicalJson(resource)).toBe(canonicalize(resource));
  });
});

describe('state hash of raw NDJSON bytes', () => {
  it('the edge fixture holds the byte-level cases the gate names', () => {
    const text = EDGE.toString('utf8');
    for (const literal of ['"value":25.0', '"value":1e21', '"value":-0}', '"value":0.1}', '\\u00eb', 'Zoë', '🩺', '\\ud83e\\ude7a', 'Patient\\/pt-edge'])
      expect(text).toContain(literal);
    expect([...EDGE].some((b) => b > 0x7f)).toBe(true);
  });

  it('equals the canonicalize + SHA-256 golden, plain and gzipped', async () => {
    const expected = golden(EDGE);
    expect(await hashBytes(EDGE)).toBe(expected);
    expect(await hashBytes(gzipSync(EDGE))).toBe(expected);
    // CRLF line ends and a UTF-8 BOM are decoding details, not state.
    const crlf = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(EDGE.toString('utf8').replaceAll('\n', '\r\n'))]);
    expect(await hashBytes(crlf)).toBe(expected);
  });

  it('canonicalizes numbers: 25.0 equals 25, -0 equals 0, 1e21 is 1e+21', async () => {
    const canonical = canonicalJson(await parseNdjson(EDGE).then((rs) => rs.find((r) => r.id === 'obs-edge-2')));
    expect(canonical).toContain('"value":1e+21}');
    expect(canonical).toContain('"valueQuantity":{"value":0}');
    expect(canonical).toContain('{"value":1e-7}');
    expect(canonical).toContain('{"value":2.5}');
    const a = new TextEncoder().encode('{"resourceType":"Basic","id":"x","n":25.0,"z":-0}\n');
    const b = new TextEncoder().encode('{"z":0,"n":25,"id":"x","resourceType":"Basic"}\n');
    expect(await hashBytes(a)).toBe(await hashBytes(b));
    expect(await hashBytes(a)).toBe(golden(a));
  });

  it('a JSON escape and the literal character hash the same', async () => {
    const escaped = new TextEncoder().encode('{"resourceType":"Basic","id":"x","t":"Zo\\u00eb \\ud83e\\ude7a"}\n');
    const literal = new TextEncoder().encode('{"resourceType":"Basic","id":"x","t":"Zoë 🩺"}\n');
    expect(await hashBytes(escaped)).toBe(await hashBytes(literal));
  });

  it('equals the golden on a generated world of 600 resources', async () => {
    const bytes = new TextEncoder().encode(toNdjson(generateWorld(20261023, 600)));
    expect(await hashBytes(bytes)).toBe(golden(bytes));
  });

  it('does not depend on input order', async () => {
    const world = generateWorld(3, 200);
    expect(await stateHash([...world].reverse())).toBe(await stateHash(world));
  });
});

type Path = Array<string | number>;

// Every leaf (string, number, boolean, null) of a JSON value, with its path.
function leaves(value: unknown, path: Path = []): Path[] {
  if (Array.isArray(value)) return value.flatMap((v, i) => leaves(v, [...path, i]));
  if (value !== null && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => leaves(v, [...path, k]));
  return [path];
}

function withLeaf(resource: Resource, path: Path, change: (v: unknown) => unknown): Resource {
  const copy = structuredClone(resource) as unknown as Record<string | number, unknown>;
  let node = copy;
  for (const key of path.slice(0, -1)) node = node[key] as Record<string | number, unknown>;
  const last = path.at(-1)!;
  node[last] = change(node[last]);
  return copy as unknown as Resource;
}

// A different value of the same JSON type. n + 1 is the same double for 1e21, so double it.
function mutate(v: unknown): unknown {
  if (typeof v === 'string') return `${v}x`;
  if (typeof v === 'number') return v + 1 === v ? v * 2 : v + 1;
  if (typeof v === 'boolean') return !v;
  return 0;
}

describe('state hash sensitivity on the edge fixture', async () => {
  const resources = await parseNdjson(EDGE);
  const base = await stateHash(resources);
  const cases = resources.flatMap((resource, index) =>
    leaves(resource)
      .filter((p) => p[0] !== 'resourceType' && p[0] !== 'id')
      .map((path) => ({ index, label: `${resource.resourceType}/${resource.id} ${path.join('.')}`, path })),
  );
  const changeOne = (index: number, path: Path, change: (v: unknown) => unknown) =>
    resources.map((r, i) => (i === index ? withLeaf(r, path, change) : r));

  it('covers every leaf of the fixture', () => {
    // Counted from the fixture text: obs-edge-1 has 4 meta leaves (versionId, lastUpdated,
    // tag system and code) and pt-edge has 1. Asserted so a fixture edit is noticed.
    expect(cases.filter((c) => c.path[0] === 'meta').length).toBe(5);
    expect(cases.filter((c) => c.path[0] !== 'meta').length).toBe(37);
  });

  it.each(cases.filter((c) => c.path[0] !== 'meta'))('changing $label changes the hash', async ({ index, path }) => {
    expect(await stateHash(changeOne(index, path, mutate))).not.toBe(base);
  });

  it.each(cases.filter((c) => c.path[0] === 'meta'))('changing $label leaves the hash unchanged', async ({ index, path }) => {
    expect(await stateHash(changeOne(index, path, mutate))).toBe(base);
  });

  it('adding, replacing or removing meta leaves the hash unchanged', async () => {
    const edit = (f: (r: Record<string, unknown>) => void) =>
      resources.map((r) => {
        const copy = structuredClone(r) as unknown as Record<string, unknown>;
        f(copy);
        return copy as unknown as Resource;
      });
    expect(await stateHash(edit((r) => delete r.meta))).toBe(base);
    expect(await stateHash(edit((r) => (r.meta = { versionId: '99', source: 'urn:x' })))).toBe(base);
  });

  it('changing a resource id or type changes the hash', async () => {
    expect(await stateHash(changeOne(0, ['id'], mutate))).not.toBe(base);
    expect(await stateHash(changeOne(0, ['resourceType'], () => 'Basic'))).not.toBe(base);
  });

  it('meta inside a contained resource is state', async () => {
    const withContained = (versionId: string) =>
      [{ resourceType: 'Basic', id: 'b', contained: [{ resourceType: 'Basic', id: 'c', meta: { versionId } }] }] as unknown as Resource[];
    expect(await stateHash(withContained('1'))).not.toBe(await stateHash(withContained('2')));
  });
});
