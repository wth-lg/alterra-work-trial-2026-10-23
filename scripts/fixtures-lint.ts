// Fixture lint CLI (design section 2, "Fixture lint"; rules in packages/env/lint/index.ts).
//
//   pnpm fixtures:lint            the committed world, with the setting's and every task
//                                 overlay's lint specs
//   pnpm fixtures:lint <dir>      <dir>/world.ndjson[.gz] with the specs in <dir>/lint.json
//                                 ({"sources": [{"source", "spec"}]})
//
// Prints one line per finding (<source> <rule>: <message>). Exit codes: 0 clean, 1 findings,
// 2 usage or input error.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseNdjson } from '../packages/env/fixture-source.ts';
import { lintWorld, type LintSource } from '../packages/env/lint/index.ts';
import { applyOverlays } from '../packages/env/overlay.ts';
import { SETTING, SETTING_LINT } from '../packages/env/world.ts';
import { loadOverlays, repo, taskOverlays } from './fixtures-build.ts';

async function worldTarget(): Promise<{ label: string; bytes: Uint8Array; sources: LintSource[] }> {
  const overlays = await loadOverlays(taskOverlays());
  // Only the specs are taken from here; the resources linted are the committed world's.
  const base = await parseNdjson(readFileSync(join(repo, 'fixtures/synthea/base.ndjson.gz')));
  const { lint } = applyOverlays(base, SETTING, SETTING_LINT, overlays);
  return { label: 'fixtures/world.ndjson.gz', bytes: readFileSync(join(repo, 'fixtures/world.ndjson.gz')), sources: lint };
}

function dirTarget(dir: string): { label: string; bytes: Uint8Array; sources: LintSource[] } {
  const file = ['world.ndjson', 'world.ndjson.gz'].map((f) => join(dir, f)).find(existsSync);
  if (!file) throw new Error(`${dir}: no world.ndjson or world.ndjson.gz`);
  const { sources } = JSON.parse(readFileSync(join(dir, 'lint.json'), 'utf8')) as { sources: LintSource[] };
  return { label: file, bytes: readFileSync(file), sources };
}

const arg = process.argv[2];
try {
  const target = arg ? dirTarget(resolve(arg)) : await worldTarget();
  const resources = await parseNdjson(target.bytes);
  const findings = lintWorld(resources, target.sources);
  for (const f of findings) console.log(`${f.source} ${f.rule}: ${f.message}`);
  console.log(`fixtures:lint ${target.label}: ${resources.length} resources, ${target.sources.length} spec source(s), ${findings.length} finding(s)`);
  process.exit(findings.length ? 1 : 0);
} catch (e) {
  console.error(`fixtures:lint: ${(e as Error).message}`);
  process.exit(2);
}
