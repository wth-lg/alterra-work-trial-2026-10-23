// summary --require and audit-check on fixture runs (plan phase P12): each violating fixture
// exits non-zero, the clean one exits 0; summary prints k/10 and Wilson 95% per task and writes a
// summary.json that validates. task-hash changes when one byte of a task directory changes.
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertSummary } from '../../packages/core/summary.ts';
import { MODEL } from '../../packages/core/anthropic.ts';
import { nodeTaskSource } from '../adapters/tasks-node.ts';
import { main as auditCheck } from '../audit-check.ts';
import { main as summary } from '../summary.ts';
import { main as taskHash } from '../task-hash.ts';
import { repoRoot, tempDir } from '../../scripts/test/helpers.ts';
import { AUDIT_FIXTURES, SUMMARY_FIXTURES, writeFixtureRun, type Fixture } from './run-fixtures.ts';

const REQUIRE = `valid=10,band=2-7,env_error_raw=0,model=${MODEL},replay=all`;

function run(fixture: Fixture): string {
  const dir = tempDir(`run-${fixture}`);
  writeFixtureRun(dir, fixture);
  return dir;
}

async function cli(main: (args: string[], deps: { out: (l: string) => void; err: (l: string) => void }) => Promise<number>, args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(args, { out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('summary --require', () => {
  it('exits 0 on the clean run, printing k/10 and Wilson 95% per task, and writes a summary.json that validates', async () => {
    const dir = run('clean');
    const r = await cli(summary, [dir, '--require', REQUIRE]);
    expect(r.code, r.out + r.err).toBe(0);
    expect(r.out).toMatch(/t-alpha\s+5\/10\s+Wilson 95% 23\.7%-76\.3%/);
    expect(r.out).toMatch(/t-beta\s+5\/10/);
    const written = JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8'));
    expect(() => assertSummary(written)).not.toThrow();
    expect(written.violations).toEqual([]);
  });

  it('--json prints only the summary on stdout, in the shape donewhen reads', async () => {
    const r = await cli(summary, [run('clean'), '--require', `trials=10,pass-min=2,pass-max=7,model=${MODEL}`, '--json']);
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out);
    expect(j.tasks['t-alpha']).toMatchObject({ passes: 5, trials: 10 });
    expect(j.initial_state_hashes).toEqual(['h-initial']);
  });

  it.each(SUMMARY_FIXTURES)('exits 1 on %s, naming the violation', async (fixture) => {
    const r = await cli(summary, [run(fixture), '--require', REQUIRE]);
    expect(r.code, r.out + r.err).toBe(1);
    const why = { 'nine-trials': /t-alpha.*9 valid trials.*10/, 'model-mismatch': /claude-other-model/, 'requeued-env-error': /ENV_ERROR.*1.*0/, 'replay-mismatch': /replay.*t-alpha\/2/, 'eight-of-ten': /t-alpha.*8\/10.*2-7/ }[fixture];
    expect(r.out + r.err).toMatch(why);
  });

  it('exits 2 on an unknown requirement and 1 on a missing run', async () => {
    expect((await cli(summary, [run('clean'), '--require', 'colour=blue'])).code).toBe(2);
    expect((await cli(summary, [join(tempDir('empty'), 'nope')])).code).toBe(1);
  });
});

describe('audit-check', () => {
  it('exits 0 on the clean run', async () => {
    const r = await cli(auditCheck, [run('clean'), '--json']);
    expect(r.code, r.out + r.err).toBe(0);
    expect(JSON.parse(r.out)).toMatchObject({ failures: 10, labelled: 10, environment: 0, grader: 0, violations: [] });
  });

  it.each(AUDIT_FIXTURES)('exits 1 on %s, naming the violation', async (fixture) => {
    const r = await cli(auditCheck, [run(fixture)]);
    expect(r.code, r.out + r.err).toBe(1);
    const why = {
      'missing-label': /t-alpha\/6.*no audit label/,
      'environment-label': /t-beta\/8.*environment/,
      'evidence-absent': /t-alpha\/5.*Observation\/not-in-trajectory.*not in the trajectory/,
      'unadjudicated': /t-beta\/5.*adjudicat/,
      'never-exposable': /t-beta\/9.*Observation\/never-in-world.*never exposed.*not exposable/,
      'one-audited-pass': /t-beta.*1 audited PASS/,
    }[fixture];
    expect(r.out + r.err).toMatch(why);
  });
});

describe('task-hash', () => {
  it('changes when one byte of a task directory changes, and only then', async () => {
    const root = tempDir('task-hash');
    cpSync(join(repoRoot, 'tasks/_toy'), join(root, '_toy'), { recursive: true });
    const hash = async () => {
      const out: string[] = [];
      expect(await taskHash(['_toy', '--json'], { out: (l) => out.push(l), err: () => {}, tasks: nodeTaskSource({ root, testMode: true }) })).toBe(0);
      return JSON.parse(out.join('\n')).tasks[0] as { id: string; files_hash: string; task_version: string };
    };
    const a = await hash();
    expect(await hash()).toEqual(a);
    const file = join(root, '_toy/instruction.md');
    const text = readFileSync(file, 'utf8');
    writeFileSync(file, text.slice(0, -1) + (text.endsWith('.') ? ',' : '.'));
    const b = await hash();
    expect(b.files_hash).not.toBe(a.files_hash);
    expect(b.task_version).not.toBe(a.task_version);
  });
});
