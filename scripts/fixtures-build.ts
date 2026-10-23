// Builds the shared world from committed inputs (design section 2, "One shared world"):
//
//   pnpm fixtures:build [--out <dir>]     <dir> defaults to fixtures/
//
// Base cohort (fixtures/synthea/base.ndjson.gz) + setting (packages/env/world.ts) + every
// tasks/<id>/overlay.ts, through applyOverlays (packages/env/overlay.ts). Writes
// world.ndjson.gz, manifest.json and definitions-pruned.json. The output depends only on the
// inputs the manifest lists, so fixtures:verify can rebuild it and compare.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { NOW } from '../packages/env/clock.ts';
import { parseNdjson } from '../packages/env/fixture-source.ts';
import { stateHash } from '../packages/env/hash.ts';
import { applyOverlays, type Overlay } from '../packages/env/overlay.ts';
import { Store } from '../packages/env/store.ts';
import { SETTING, SETTING_LINT } from '../packages/env/world.ts';
import { gunzip, gzip, sha256, toNdjson } from './fixtures-lib.ts';

export const repo = resolve(fileURLToPath(new URL('..', import.meta.url)));
const BASE = 'fixtures/synthea/base.ndjson.gz';
const BASE_META = 'fixtures/synthea/base.json';
// Overlay code whose bytes the manifest pins, besides each tasks/<id>/overlay.ts.
const OVERLAY_SOURCES = ['packages/env/clock.ts', 'packages/env/overlay.ts', 'packages/env/world.ts'];

const posix = (p: string) => p.split('\\').join('/');

export function taskOverlays(): string[] {
  const tasks = join(repo, 'tasks');
  if (!existsSync(tasks)) return [];
  return readdirSync(tasks, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(tasks, e.name, 'overlay.ts')))
    .map((e) => `tasks/${e.name}/overlay.ts`)
    .sort();
}

export async function loadOverlays(files: readonly string[]): Promise<Overlay[]> {
  const overlays: Overlay[] = [];
  for (const f of files) overlays.push((await import(pathToFileURL(join(repo, f)).href)).default as Overlay);
  return overlays;
}

// The R4 StructureDefinitions validateResource needs for the world's types: every data type
// plus the world's resource types and the base Resource and DomainResource, with the prose
// fields validation never reads removed.
const PROSE = new Set(['definition', 'comment', 'requirements', 'mapping', 'alias', 'short', 'meaning']);
async function prunedDefinitions(types: readonly string[]): Promise<unknown> {
  const require = createRequire(join(repo, 'packages/env/package.json'));
  const { readJson } = (await import(pathToFileURL(require.resolve('@medplum/definitions')).href)) as { readJson(path: string): { entry: Array<{ resource: Record<string, unknown> }> } };
  const keep = new Set(['Resource', 'DomainResource', ...types]);
  const defs = ['fhir/r4/profiles-types.json', 'fhir/r4/profiles-resources.json']
    .flatMap((f) => readJson(f).entry.map((e) => e.resource))
    .filter((r) => r.resourceType === 'StructureDefinition' && (r.kind !== 'resource' || keep.has(r.id as string)))
    .sort((a, b) => ((a.id as string) < (b.id as string) ? -1 : 1));
  const strip = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(strip) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !PROSE.has(k)).map(([k, x]) => [k, strip(x)])) : v;
  const entry = defs.map((d) => {
    const { text: _t, description: _d, differential: _df, mapping: _m, ...rest } = d;
    return { resource: strip(rest) };
  });
  return { resourceType: 'Bundle', type: 'collection', entry };
}

export async function build(outDir: string): Promise<{ stateHash: string; resources: number }> {
  const baseBytes = readFileSync(join(repo, BASE));
  const baseMeta = JSON.parse(readFileSync(join(repo, BASE_META), 'utf8')) as { ndjson_sha256: string; resources: number };
  const baseSha = sha256(gunzip(baseBytes));
  if (baseSha !== baseMeta.ndjson_sha256) throw new Error(`${BASE} decompresses to ${baseSha}, but ${BASE_META} says ${baseMeta.ndjson_sha256}; rerun fixtures/synthea/generate.sh`);
  const base = await parseNdjson(baseBytes);

  const overlayFiles = taskOverlays();
  const overlays = await loadOverlays(overlayFiles);
  const world = applyOverlays(base, SETTING, SETTING_LINT, overlays);

  // The Store admits only resources the hash and search can handle.
  const store = new Store(world.resources);
  const hash = await stateHash(store.resources());
  const ndjson = toNdjson(world.resources);
  const byType: Record<string, number> = {};
  for (const r of world.resources) byType[r.resourceType] = (byType[r.resourceType] ?? 0) + 1;
  const types = Object.keys(byType).sort();
  const definitions = `${JSON.stringify(await prunedDefinitions(types))}\n`;

  const inputs = Object.fromEntries([...OVERLAY_SOURCES, ...overlayFiles].sort().map((f) => [f, sha256(readFileSync(join(repo, f)))]));
  const manifest = {
    now: NOW,
    world: {
      file: 'fixtures/world.ndjson.gz',
      state_hash: hash,
      ndjson_sha256: sha256(ndjson),
      resources: world.resources.length,
      by_type: Object.fromEntries(types.map((t) => [t, byType[t]])),
    },
    base: { file: BASE, ...baseMeta },
    overlays: overlays.map((o) => o.task).sort(),
    inputs,
    definitions: { file: 'fixtures/definitions-pruned.json', from: '@medplum/definitions 5.2.7', sha256: sha256(definitions), types },
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'world.ndjson.gz'), gzip(ndjson));
  writeFileSync(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(outDir, 'definitions-pruned.json'), definitions);
  return { stateHash: hash, resources: world.resources.length };
}

if (import.meta.main) {
  const i = process.argv.indexOf('--out');
  const out = resolve(i >= 0 ? process.argv[i + 1]! : join(repo, 'fixtures'));
  const { stateHash: hash, resources } = await build(out);
  console.log(`fixtures:build wrote ${posix(relative(process.cwd(), out)) || '.'}: ${resources} resources, state hash ${hash}`);
}
