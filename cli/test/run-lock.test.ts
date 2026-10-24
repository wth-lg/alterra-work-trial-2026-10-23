// The run lock (cli/adapters/result-sink-node.ts): it is linked into place whole, so no reader
// sees an empty .lock; an empty or unreadable lock older than a few seconds (a process killed
// while writing one by older code, or a hand-made file) is stale and taken over; a younger one is
// refused, saying it is unreadable rather than naming "pid ?".
import { existsSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BatchRefused } from '../../packages/core/batch.ts';
import { tempDir } from '../../scripts/test/helpers.ts';
import { nodeResultSink } from '../adapters/result-sink-node.ts';

const lockOf = (dir: string) => join(dir, '.lock');
const age = (file: string, seconds: number) => {
  const t = new Date(Date.now() - seconds * 1000);
  utimesSync(file, t, t);
};

describe('the run lock', () => {
  it('is created whole: the lock parses as this process, and no temp file is left beside it', async () => {
    const dir = tempDir('lock-atomic');
    const release = await nodeResultSink(dir).lock!(() => {});
    expect(JSON.parse(readFileSync(lockOf(dir), 'utf8'))).toMatchObject({ pid: process.pid });
    expect(readdirSync(dir)).toEqual(['.lock']);
    await release();
    expect(readdirSync(dir)).toEqual([]);
  });

  it('a temp file left by a process killed before it linked its lock does not hold the run', async () => {
    const dir = tempDir('lock-temp-left');
    writeFileSync(join(dir, '.lock.new-999999999'), '');
    const release = await nodeResultSink(dir).lock!(() => {});
    expect(JSON.parse(readFileSync(lockOf(dir), 'utf8'))).toMatchObject({ pid: process.pid });
    await release();
  });

  it.each([['empty', ''], ['half-written', '{"pid":12']])('an %s lock older than a few seconds (a crash mid-write) is stale and taken over', async (_name, text) => {
    const dir = tempDir('lock-crash');
    writeFileSync(lockOf(dir), text);
    age(lockOf(dir), 30);
    const log: string[] = [];
    const release = await nodeResultSink(dir).lock!((l) => log.push(l));
    expect(log.join('\n')).toMatch(/took over an unreadable lock on .* written 3\ds ago/);
    expect(JSON.parse(readFileSync(lockOf(dir), 'utf8'))).toMatchObject({ pid: process.pid });
    await release();
    expect(existsSync(lockOf(dir))).toBe(false);
  });

  it('a fresh unreadable lock is refused, saying so rather than naming pid ?', async () => {
    const dir = tempDir('lock-fresh');
    writeFileSync(lockOf(dir), '');
    const err = await nodeResultSink(dir).lock!(() => {}).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(BatchRefused);
    expect((err as Error).message).toMatch(/is locked: its lock file is empty or unreadable, written \ds ago; another batch may be starting/);
    expect((err as Error).message).not.toContain('pid ?');
    expect(readFileSync(lockOf(dir), 'utf8')).toBe('');
  });
});
