// replay and regrade on run-one's layout, trials/<task>/<model>/<effort>/<mode>/<index>.json with
// no `index` field (results/pilot-0 is one): each trial is named by its key, never
// '<task>/undefined', so three trials are three, not one. A regrade whose replay cannot reach the
// record's state refuses with the task version it ran at and the checkout's when they differ, and
// otherwise records the GRADER_ERROR with its error, never an entry with no checks and no error.
import { cpSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { scenarioTransport } from '../../apps/web/src/harness/scenarios.ts';
import { MODEL } from '../../packages/core/anthropic.ts';
import { GRADER_VERSION, ungraded } from '../../packages/grader/grade.ts';
import { tempDir } from '../../scripts/test/helpers.ts';
import { main as regrade } from '../regrade.ts';
import { main as replay } from '../replay.ts';
import { main as runOne } from '../run-one.ts';

let dir: string;
let names: string[];

beforeAll(async () => {
  dir = join(tempDir('run-one-layout'), 'run-one-layout');
  const home = tempDir('run-one-home');
  for (const index of [0, 1, 2]) {
    const out: string[] = [];
    const code = await runOne(['--task', '_toy', '--model', MODEL, '--index', String(index), '--mock', 'toy', '--out', dir], {
      env: { HOME: home, SPEND_LEDGER: join(home, 'spend.jsonl') },
      out: (l) => out.push(l),
      fetch: () => Promise.reject(new Error('no live call')),
      mock: (name) => scenarioTransport(name).transport,
    });
    if (code !== 0) throw new Error(out.join('\n'));
  }
  const trials = join(dir, 'trials');
  names = readdirSync(trials, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.json'))
    .map((e) => relative(trials, join(e.parentPath, e.name)).replace(/\.json$/, ''))
    .sort();
});

async function cli(main: (args: string[], deps: { out: (l: string) => void; err: (l: string) => void }) => Promise<number>, args: string[]) {
  const lines: string[] = [];
  const code = await main(args, { out: (l) => lines.push(l), err: (l) => lines.push(l) });
  return { code, text: lines.join('\n') };
}

const copyOf = (label: string) => {
  const copy = join(tempDir(label), label);
  cpSync(dir, copy, { recursive: true });
  return copy;
};
type Rec = { index?: number; task_version: string; state_hash: { initial: string; final: string; replay_final: string }; regrades?: Array<Record<string, unknown>> };
const file = (run: string, name: string) => join(run, 'trials', `${name}.json`);
const read = (run: string, name: string) => JSON.parse(readFileSync(file(run, name), 'utf8')) as Rec;
const edit = (run: string, name: string, f: (r: Rec) => void) => {
  const r = read(run, name);
  f(r);
  writeFileSync(file(run, name), JSON.stringify(r, null, 2));
};

describe('replay and regrade on run-one output', () => {
  it('the fixture is three run-one trials with no index field', () => {
    expect(names).toHaveLength(3);
    expect(names.every((n) => /^_toy\/claude-opus-5-5\/[a-z]+\/mock-toy\/[012]$/.test(n))).toBe(true);
    expect(names.map((n) => read(dir, n).index)).toEqual([undefined, undefined, undefined]);
  });

  it('replay names each trial by its key and reproduces all three', async () => {
    const run = copyOf('run-one-replay');
    const r = await cli(replay, [run]);
    expect(r.code, r.text).toBe(0);
    expect(r.text).toContain('3 of 3 trials reproduced');
    expect(r.text).not.toContain('undefined');
    const j = JSON.parse(readFileSync(join(run, 'replay.json'), 'utf8')) as { trials: Record<string, { match: boolean }> };
    expect(Object.keys(j.trials).sort()).toEqual(names);
  });

  it('regrade grades all three and records a PASS with its checks on each', async () => {
    const run = copyOf('run-one-regrade');
    const r = await cli(regrade, [run, '--grader-version', GRADER_VERSION]);
    expect(r.code, r.text).toBe(0);
    expect(r.text).toContain('3 regraded');
    expect(r.text).not.toContain('undefined');
    for (const n of names) {
      const e = read(run, n).regrades?.[0];
      expect(e).toMatchObject({ grader_version: GRADER_VERSION, outcome: 'PASS', error: null });
      expect((e?.checks as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it('regrade refuses a trial run in another world, naming both task versions, and writes no record', async () => {
    const run = copyOf('run-one-world');
    const [first] = names as [string];
    edit(run, first, (r) => Object.assign(r, { task_version: 'v-old-world', state_hash: { ...r.state_hash, initial: 'not-this-world' } }));
    const before = readFileSync(file(run, first), 'utf8');
    const r = await cli(regrade, [run, '--grader-version', GRADER_VERSION]);
    expect(r.code, r.text).toBe(1);
    expect(r.text).toContain(`${first}: task changed: run at v-old-world, checkout at ${read(run, names[1]!).task_version}`);
    expect(r.text).toContain('initial state hash');
    expect(r.text).not.toContain('undefined');
    expect(readFileSync(file(run, first), 'utf8')).toBe(before);
    expect(read(run, names[1]!).regrades).toBeUndefined();
  });

  it('a GRADER_ERROR regrade at the same task version is recorded with the step that failed', async () => {
    const run = copyOf('run-one-grader-error');
    const [first] = names as [string];
    edit(run, first, (r) => Object.assign(r, { state_hash: { ...r.state_hash, final: 'not-the-replayed-state', replay_final: 'not-the-replayed-state' } }));
    const r = await cli(regrade, [run, '--grader-version', GRADER_VERSION]);
    expect(r.code, r.text).toBe(0);
    expect(r.text).toContain(`${first} PASS -> GRADER_ERROR`);
    const e = read(run, first).regrades?.[0];
    expect(e).toMatchObject({ outcome: 'GRADER_ERROR', checks: [], error: { check: null, message: expect.stringContaining('replayed state hash') } });
  });

  it('a GRADER_ERROR grade cannot be built without an error', () => {
    expect(() => ungraded('GRADER_ERROR')).toThrow(/GRADER_ERROR needs an error/);
    expect(ungraded('ENV_ERROR').error).toBeNull();
  });
});
