// replay and regrade (plan phase P12) never make a live call: on a mocked toy run, replay
// reproduces every grade and writes replay.json, regrade appends one regrades[] entry per grader
// version, and with one judge cache entry removed both exit 1 naming the miss, with 0 fetch calls
// while ANTHROPIC_API_KEY holds a sentinel.
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { scenarioTransport } from '../../apps/web/src/harness/scenarios.ts';
import { MODEL } from '../../packages/core/anthropic.ts';
import { GRADER_VERSION } from '../../packages/grader/grade.ts';
import { fakeKey, tempDir } from '../../scripts/test/helpers.ts';
import { main as regrade } from '../regrade.ts';
import { main as replay } from '../replay.ts';
import { main as run } from '../run.ts';

let dir: string;

beforeAll(async () => {
  dir = join(tempDir('replay-run'), 'replay-run');
  const home = tempDir('replay-home');
  const out: string[] = [];
  const code = await run(['--task', '_toy', '--model', MODEL, '--trials', '2', '--mock', 'toy', '--out', dir], {
    env: { HOME: home, SPEND_LEDGER: join(home, 'spend.jsonl') },
    out: (l) => out.push(l),
    fetch: () => Promise.reject(new Error('no live call')),
    mock: (name) => scenarioTransport(name).transport,
  });
  if (code !== 0) throw new Error(out.join('\n'));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function cli(main: (args: string[], deps: { out: (l: string) => void; err: (l: string) => void }) => Promise<number>, args: string[]) {
  const lines: string[] = [];
  const code = await main(args, { out: (l) => lines.push(l), err: (l) => lines.push(l) });
  return { code, text: lines.join('\n') };
}

const recordFile = (i: number) => join(dir, 'trials', '_toy', `${i}.json`);
const readRecord = (i: number) => JSON.parse(readFileSync(recordFile(i), 'utf8')) as { regrades?: unknown[]; judge: { cache: Array<{ key: string }> } };

describe('replay and regrade', () => {
  it('replay reproduces every grade and writes replay.json', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const r = await cli(replay, [dir]);
    expect(r.code, r.text).toBe(0);
    const j = JSON.parse(readFileSync(join(dir, 'replay.json'), 'utf8'));
    expect(Object.values(j.trials)).toEqual([expect.objectContaining({ match: true }), expect.objectContaining({ match: true })]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('regrade appends one regrades[] entry for this grader version, once', async () => {
    expect((await cli(regrade, [dir, '--grader-version', GRADER_VERSION])).code).toBe(0);
    expect((await cli(regrade, [dir, '--grader-version', GRADER_VERSION])).code).toBe(0);
    expect(readRecord(0).regrades).toEqual([expect.objectContaining({ grader_version: GRADER_VERSION, outcome: 'PASS' })]);
    const other = await cli(regrade, [dir, '--grader-version', `${GRADER_VERSION}0`]);
    expect(other.code).toBe(2);
    expect(other.text).toMatch(new RegExp(`grader version is ${GRADER_VERSION}`));
  });

  it('replay refuses a trial whose task_version is not the checkout\'s, naming both; regrade still runs', async () => {
    const copy = join(tempDir('replay-changed'), 'replay-changed');
    cpSync(dir, copy, { recursive: true });
    const file = join(copy, 'trials', '_toy', '0.json');
    const rec = JSON.parse(readFileSync(file, 'utf8')) as { task_version: string; regrades?: unknown };
    const current = rec.task_version;
    delete rec.regrades;
    writeFileSync(file, JSON.stringify({ ...rec, task_version: 'v-before-the-edit' }, null, 2));
    const r = await cli(replay, [copy]);
    expect(r.code, r.text).toBe(1);
    expect(r.text).toContain(`_toy/0: task changed: run at v-before-the-edit, checkout at ${current}`);
    const j = JSON.parse(readFileSync(join(copy, 'replay.json'), 'utf8'));
    expect(j.trials['_toy/0']).toMatchObject({ match: false });
    expect(j.trials['_toy/1']).toMatchObject({ match: true });
    expect((await cli(regrade, [copy, '--grader-version', GRADER_VERSION])).code).toBe(0);
  });

  it('with one judge cache entry removed, regrade and replay exit 1 naming the miss, with 0 fetch calls', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', fakeKey('R'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const rec = readRecord(1) as Record<string, unknown> & { judge: { cache: Array<{ key: string }> } };
    const removed = rec.judge.cache.shift()!;
    delete rec.regrades;
    writeFileSync(recordFile(1), JSON.stringify(rec, null, 2));
    const before = readFileSync(recordFile(1), 'utf8');
    for (const [main, args] of [[regrade, [dir, '--grader-version', GRADER_VERSION]], [replay, [dir]]] as const) {
      const r = await cli(main, [...args]);
      expect(r.code, r.text).toBe(1);
      expect(r.text).toContain('_toy/1');
      expect(r.text).toContain(removed.key);
      expect(r.text).not.toContain(fakeKey('R'));
    }
    expect(readFileSync(recordFile(1), 'utf8')).toBe(before);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
