// Rebuilds the world from the committed inputs in a fresh process and an empty temp
// directory, and checks it against what is committed (design section 2, "One shared world"):
//
//   pnpm fixtures:verify
//
// Passes only if the rebuilt manifest and pruned definitions equal the committed files byte
// for byte (so the state hash, the NDJSON SHA-256, every count and every pinned input hash
// agree), and the committed world.ndjson.gz decompresses to exactly the rebuilt NDJSON. The
// .gz bytes themselves are not compared: zlib builds may deflate differently
// (scripts/fixtures-lib.ts). Exit codes: 0 match, 1 mismatch or build failure.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repo } from './fixtures-build.ts';
import { gunzip, sha256 } from './fixtures-lib.ts';

const tmp = mkdtempSync(join(tmpdir(), 'fixtures-verify-'));
const problems: string[] = [];
try {
  const run = spawnSync(process.execPath, [join(repo, 'scripts/fixtures-build.ts'), '--out', tmp], { cwd: tmp, encoding: 'utf8' });
  if (run.status !== 0) {
    problems.push(`rebuild failed (exit ${run.status}): ${run.stderr.trim()}`);
  } else {
    const committed = (f: string) => readFileSync(join(repo, 'fixtures', f));
    const rebuilt = (f: string) => readFileSync(join(tmp, f));
    const manifest = JSON.parse(committed('manifest.json').toString('utf8')) as { world: { state_hash: string; resources: number } };
    const fresh = JSON.parse(rebuilt('manifest.json').toString('utf8')) as Record<string, unknown>;

    if (!committed('manifest.json').equals(rebuilt('manifest.json'))) {
      for (const k of new Set([...Object.keys(manifest), ...Object.keys(fresh)])) {
        const a = JSON.stringify((manifest as Record<string, unknown>)[k]);
        const b = JSON.stringify(fresh[k]);
        if (a !== b) problems.push(`manifest.json "${k}": committed ${a}, rebuilt ${b}`);
      }
      if (problems.length === 0) problems.push('manifest.json: same content, different formatting; run pnpm fixtures:build');
    }
    if (!committed('definitions-pruned.json').equals(rebuilt('definitions-pruned.json'))) problems.push('definitions-pruned.json differs from the rebuild');
    const theirs = gunzip(rebuilt('world.ndjson.gz'));
    try {
      const ours = gunzip(committed('world.ndjson.gz'));
      if (!ours.equals(theirs)) problems.push(`world.ndjson.gz decompresses to ${sha256(ours)}, the rebuild to ${sha256(theirs)}`);
    } catch (e) {
      problems.push(`world.ndjson.gz does not decompress: ${(e as Error).message}`);
    }

    if (problems.length === 0) console.log(`fixtures:verify OK: rebuilt in ${tmp}, ${manifest.world.resources} resources, state hash ${manifest.world.state_hash}`);
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
for (const p of problems) console.log(`fixtures:verify: ${p}`);
process.exit(problems.length ? 1 : 0);
