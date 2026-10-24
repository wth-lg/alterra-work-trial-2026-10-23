// Done-when clause (3) against the real oracle command (plan phase P9). Two test-only overrides
// of scripts/donewhen.ts, honoured only under NODE_ENV=test, make the one task we have count:
//   DONEWHEN_MIN_TASKS=1            the minimum of 5 complete tasks becomes 1;
//   DONEWHEN_INCLUDE_UNDERSCORE=1   clause (3) counts _-prefixed task directories, so tasks/_toy
//                                   is the task it checks.
// DONEWHEN_CLI is the real `node cli/index.ts`, so `oracle --task all --json` is the shipped
// command grading the toy oracle from its canned judge cache. The broken case runs the same
// command from a temp copy of the CLI and tasks/_toy (packages, fixtures and node_modules
// linked), whose solution/solve.ts reads and writes on the wrong patient; the repo is never
// changed. Each run gets a temp SPEND_LEDGER and HOME, so the spend command reads no real ledger.
import { cpSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot, runScript, tempDir } from './helpers.ts';

function clause3(root: string) {
  const home = tempDir('donewhen-oracle-home');
  const r = runScript('scripts/donewhen.ts', [], {
    cwd: root,
    env: {
      NODE_ENV: 'test',
      DONEWHEN_MIN_TASKS: '1',
      DONEWHEN_INCLUDE_UNDERSCORE: '1',
      DONEWHEN_CLI: `${process.execPath} ${join(root, 'cli/index.ts')}`,
      HOME: home,
      SPEND_LEDGER: join(home, 'spend.jsonl'),
      CLINENV_CANONICAL_LEDGER: undefined,
    },
  });
  const line = r.stdout.split('\n').find((l) => /^(PASS|FAIL) \(3\)/.test(l));
  if (!line) throw new Error(`no clause 3 line in:\n${r.stdout}\n${r.stderr}`);
  return line;
}

// A temp root with its own cli/ and tasks/_toy (copies) and links to everything they import.
function brokenRoot(): string {
  const root = tempDir('donewhen-oracle-broken');
  cpSync(join(repoRoot, 'cli'), join(root, 'cli'), { recursive: true, filter: (src) => !src.includes(`${join('cli', 'test')}`) });
  cpSync(join(repoRoot, 'tasks/_toy'), join(root, 'tasks/_toy'), { recursive: true });
  for (const link of ['packages', 'fixtures', 'node_modules', 'apps', 'package.json']) symlinkSync(join(repoRoot, link), join(root, link));
  const solve = join(root, 'tasks/_toy/solution/solve.ts');
  writeFileSync(solve, readFileSync(solve, 'utf8').replaceAll('pt-0001', 'pt-0002'));
  return root;
}

describe('done-when clause (3) with the real oracle on _toy', () => {
  it('PASS on the repo, under DONEWHEN_MIN_TASKS=1 and DONEWHEN_INCLUDE_UNDERSCORE=1', () => {
    const line = clause3(repoRoot);
    expect(line).toMatch(/^PASS \(3\)/);
    expect(line).toContain('1/1 at 1.0');
  });

  it('FAIL when the toy oracle is broken', () => {
    const line = clause3(brokenRoot());
    expect(line).toMatch(/^FAIL \(3\)/);
    expect(line).toContain('not 1.0: _toy');
  });

  it('the underscore override is test-only: without NODE_ENV=test clause (3) skips _toy', () => {
    const home = tempDir('donewhen-oracle-home');
    const r = runScript('scripts/donewhen.ts', [], {
      cwd: repoRoot,
      env: { NODE_ENV: 'production', DONEWHEN_MIN_TASKS: '1', DONEWHEN_INCLUDE_UNDERSCORE: '1', DONEWHEN_CLI: 'false', HOME: home, SPEND_LEDGER: join(home, 'spend.jsonl') },
    });
    expect(r.stdout).toMatch(/^FAIL \(3\) .*0 task\(s\), need 5/m);
  });
});
