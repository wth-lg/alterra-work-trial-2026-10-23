// Done-when clauses (5) and (6) against the real summary and audit-check (plan phase P12).
// scripts/donewhen.ts reads results/runs/final-1 under its working directory, so each case is a
// temp root holding a fixture run there, with the repo's cli/, packages/, fixtures/, tasks/ and
// node_modules linked in; DONEWHEN_CLI is the real `node cli/index.ts`. The clauses must flip
// PASS/FAIL exactly with the exit codes those commands give on the same fixture.
import { spawnSync } from 'node:child_process';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeFixtureRun, type Fixture } from '../../cli/test/run-fixtures.ts';
import { repoRoot, runScript, tempDir } from './helpers.ts';

function rootWith(fixture: Fixture): string {
  const root = tempDir(`donewhen-cli-${fixture}`);
  for (const link of ['cli', 'packages', 'fixtures', 'node_modules', 'apps', 'tasks', 'package.json']) symlinkSync(join(repoRoot, link), join(root, link));
  writeFixtureRun(join(root, 'results/runs/final-1'), fixture);
  return root;
}

function clauses(root: string) {
  const home = tempDir('donewhen-cli-home');
  const env = { NODE_ENV: 'test', DONEWHEN_CLI: `${process.execPath} ${join(repoRoot, 'cli/index.ts')}`, HOME: home, SPEND_LEDGER: join(home, 'spend.jsonl'), CLINENV_CANONICAL_LEDGER: undefined };
  const r = runScript('scripts/donewhen.ts', [], { cwd: root, env });
  const line = (n: number) => r.stdout.split('\n').find((l) => new RegExp(`^(PASS|FAIL) \\(${n}\\)`).test(l)) ?? `no clause ${n} line in:\n${r.stdout}\n${r.stderr}`;
  return { five: line(5), six: line(6) };
}

// The exit code of a real command on the fixture, run as donewhen runs it.
function exit(root: string, args: string[]): number | null {
  const home = tempDir('donewhen-cli-home');
  const env: Record<string, string | undefined> = { ...process.env, HOME: home, SPEND_LEDGER: join(home, 'spend.jsonl'), ANTHROPIC_API_KEY: undefined, CLINENV_CANONICAL_LEDGER: undefined };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  return spawnSync(process.execPath, [join(repoRoot, 'cli/index.ts'), ...args], { cwd: root, env, encoding: 'utf8' }).status;
}

const SUMMARY = ['summary', 'results/runs/final-1', '--require', 'trials=10,pass-min=2,pass-max=7,model=claude-opus-5-5', '--json'];
const AUDIT = ['audit-check', 'results/runs/final-1', '--json'];

describe('done-when clauses (5) and (6) with the real summary and audit-check', () => {
  it('PASS on the clean run, where both commands exit 0', () => {
    const root = rootWith('clean');
    expect(exit(root, SUMMARY)).toBe(0);
    expect(exit(root, AUDIT)).toBe(0);
    const c = clauses(root);
    expect(c.five).toMatch(/^PASS \(5\).*summary: exit 0; t-alpha 5\/10, t-beta 5\/10/);
    expect(c.six).toMatch(/^PASS \(6\).*audit-check: exit 0; labelled 10\/10 failures, environment 0, grader 0/);
  });

  it('clause (5) FAILs on a task at 8/10, where summary exits 1; clause (6) still PASSes', () => {
    const root = rootWith('eight-of-ten');
    expect(exit(root, SUMMARY)).toBe(1);
    expect(exit(root, AUDIT)).toBe(0);
    const c = clauses(root);
    expect(c.five).toMatch(/^FAIL \(5\).*summary: exit 1; t-alpha 8\/10/);
    expect(c.six).toMatch(/^PASS \(6\)/);
  });

  it('clause (5) reads the current grade: 5 FAIL regraded to PASS give t-alpha 10/10 and FAIL', () => {
    const root = rootWith('fail-regraded-pass');
    expect(exit(root, SUMMARY)).toBe(1);
    expect(clauses(root).five).toMatch(/^FAIL \(5\).*summary: exit 1; t-alpha 10\/10, t-beta 5\/10/);
  });

  it('clause (6) FAILs on a missing label, where audit-check exits 1; clause (5) still PASSes', () => {
    const root = rootWith('missing-label');
    expect(exit(root, SUMMARY)).toBe(0);
    expect(exit(root, AUDIT)).toBe(1);
    const c = clauses(root);
    expect(c.five).toMatch(/^PASS \(5\)/);
    expect(c.six).toMatch(/^FAIL \(6\).*audit-check: exit 1; labelled 9\/10 failures/);
  });

  it('clause (6) FAILs on an environment label', () => {
    const root = rootWith('environment-label');
    expect(exit(root, AUDIT)).toBe(1);
    expect(clauses(root).six).toMatch(/^FAIL \(6\).*environment 1, grader 0/);
  });
});
