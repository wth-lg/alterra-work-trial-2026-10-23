// pnpm cli runner-check (plan phase P12b), gate case (9): --mock run with HOME at a temp dir T and
// CLINENV_CANONICAL_LEDGER at a temp file C holding k rows exits 0, leaves no T/.clinenv and C
// with exactly k rows, and the runner's and run-one's environments carry no
// CLINENV_CANONICAL_LEDGER and a HOME, SPEND_LEDGER and CLINENV_RUNS_DIR under runner-check's own
// temp dir, which it deletes. A missing dist fails with a clear message.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeDist, sentinels, tempDir } from '../../apps/runner/test/helpers.ts';
import { validateWorstCaseUsd } from '../../packages/core/runner-api.ts';
import { repoRoot } from '../../scripts/test/helpers.ts';
import { childEnv } from '../runner-check.ts';

const lines = (f: string) => readFileSync(f, 'utf8').split('\n').filter((l) => l.trim() !== '').length;

function runnerCheck(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [join(repoRoot, 'cli/index.ts'), 'runner-check', ...args], { cwd: repoRoot, env: { PATH: process.env.PATH ?? '', ...env }, encoding: 'utf8', timeout: 120_000 });
}

interface Report {
  ok: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
  events_equal: boolean | null;
  tmp: string;
  envs: Record<'runner' | 'run_one', Record<string, string | null>>;
}

describe('runner-check --mock (gate case 9)', () => {
  it('exits 0, compares events with run-one and touches neither HOME nor the canonical ledger', () => {
    const T = tempDir('rc-home');
    const C = join(tempDir('rc-canonical'), 'spend.jsonl');
    const row = (kind: string) => JSON.stringify({ ts: '2026-10-24T00:00:00.000Z', call_id: 'c1', kind, source: 'node', run_id: null, batch_id: null, trial: 'x', usage: null, cost_usd: 0.5 });
    writeFileSync(C, `${row('reserve')}\n${row('settle')}\n`);
    const k = lines(C);
    const r = runnerCheck(['--mock', '--json'], { HOME: T, CLINENV_CANONICAL_LEDGER: C, NODE_ENV: 'test', CLINENV_TEST_HOOKS: '1', CLINENV_WEB_DIST: fakeDist() });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    const report = JSON.parse(r.stdout) as Report;
    expect(report.ok).toBe(true);
    expect(report.events_equal).toBe(true);
    expect(report.checks.every((c) => c.ok)).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual(expect.arrayContaining(['health', 'index.html', 'foreign origin refused', 'foreign host refused', 'trial streamed', 'events equal run-one']));
    expect(existsSync(join(T, '.clinenv'))).toBe(false);
    expect(lines(C)).toBe(k);
    for (const who of ['runner', 'run_one'] as const) {
      const env = report.envs[who];
      expect(env.CLINENV_CANONICAL_LEDGER, who).toBeNull();
      expect(env.ANTHROPIC_API_KEY, who).toBeNull();
      for (const v of ['HOME', 'SPEND_LEDGER', 'CLINENV_RUNS_DIR']) expect(env[v]?.startsWith(`${report.tmp}/`), `${who} ${v}`).toBe(true);
    }
    expect(existsSync(report.tmp)).toBe(false);
  });

  it('fails with a clear message when the built UI is missing', () => {
    const r = runnerCheck(['--mock'], { HOME: tempDir('rc-nodist'), NODE_ENV: 'test', CLINENV_TEST_HOOKS: '1', CLINENV_WEB_DIST: join(tempDir('rc-nodist'), 'dist') });
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toMatch(/dist.*missing.*pnpm build/);
  });

  it('refuses a usage error with 2', () => {
    expect(runnerCheck(['--mock', '--live'], { HOME: tempDir('rc-usage') }).status).toBe(2);
    expect(runnerCheck(['--bogus'], { HOME: tempDir('rc-usage') }).status).toBe(2);
  });
});

// The live path offline: the runner's toy test transport answers every call, the key is a
// sentinel and the ledger a temp file. At 277075e the trial was refused 409 because its session
// cap left out the Validate call's spend (fixed in 523ddb9).
describe('runner-check --live over the toy test transport', () => {
  const liveEnv = () => {
    const home = tempDir('rc-live');
    const key = sentinels().skAnt;
    const env = {
      HOME: home, SPEND_LEDGER: join(home, 'spend.jsonl'), NODE_ENV: 'test', CLINENV_TEST_HOOKS: '1', CLINENV_RUNNER_TEST_TRANSPORT: 'toy',
      CLINENV_WEB_DIST: fakeDist(), ANTHROPIC_API_KEY: key,
    };
    return { env, key, ledger: env.SPEND_LEDGER };
  };

  it('validates the key, streams one graded trial under projection plus session spend and exits 0', () => {
    const { env, key, ledger } = liveEnv();
    const r = runnerCheck(['--live', '--json'], env);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(key);
    const report = JSON.parse(r.stdout) as Report;
    expect(report.checks.every((c) => c.ok)).toBe(true);
    expect(report.checks.map((c) => c.name)).toEqual(expect.arrayContaining(['key validated', 'trial streamed', 'graded record', 'runner exit']));
    const rows = readFileSync(ledger, 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as { trial: string | null; kind: string });
    expect(rows.some((x) => x.trial?.includes('validate') && x.kind === 'settle')).toBe(true);
    expect(rows.some((x) => !x.trial?.includes('validate') && x.kind === 'settle')).toBe(true);
  });

  it('--dry-run sends no key and prints the trial projection plus the Validate worst case', () => {
    const { env, key, ledger } = liveEnv();
    const r = runnerCheck(['--live', '--dry-run'], env);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(key);
    expect(r.stdout).not.toContain('key validated');
    const m = /^ok dry run: trial projection \$(\d+\.\d{6}) \+ Validate worst case \$(\d+\.\d{6}), 0 calls$/m.exec(r.stdout);
    expect(m, r.stdout).not.toBeNull();
    const [trial, validate] = [Number(m?.[1]), Number(m?.[2])];
    expect(validate).toBeCloseTo(validateWorstCaseUsd(), 6);
    expect(validate).toBeGreaterThan(0);
    expect(r.stdout).toContain(`LIVE_PROJECTION_USD=${(trial + validate).toFixed(6)}\n`);
    expect(existsSync(ledger) ? readFileSync(ledger, 'utf8') : '').toBe('');
  });
});

describe('childEnv', () => {
  const parent = { HOME: '/home/u', PATH: '/bin', ANTHROPIC_API_KEY: 'k'.repeat(20), CLINENV_CANONICAL_LEDGER: '/l/spend.jsonl', SPEND_LEDGER: '/l/spend.jsonl', CLINENV_RUNS_DIR: '/r' };

  it('--mock: no key, no canonical ledger, HOME, SPEND_LEDGER and CLINENV_RUNS_DIR under the temp dir', () => {
    const env = childEnv(parent, '/tmp/rc-x', 'mock');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLINENV_CANONICAL_LEDGER).toBeUndefined();
    expect(env).toMatchObject({ HOME: '/tmp/rc-x/home', SPEND_LEDGER: '/tmp/rc-x/spend.jsonl', CLINENV_RUNS_DIR: '/tmp/rc-x/runs', PATH: '/bin' });
  });

  it('--live: no key, the canonical marker kept, runs under the temp dir', () => {
    const env = childEnv(parent, '/tmp/rc-y', 'live');
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env).toMatchObject({ CLINENV_CANONICAL_LEDGER: '/l/spend.jsonl', HOME: '/home/u', CLINENV_RUNS_DIR: '/tmp/rc-y/runs' });
  });
});
