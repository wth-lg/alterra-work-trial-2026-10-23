// Gate case (4), same events: one mocked _toy trial posted to /api/trials streams SSE data equal
// line for line (timestamps stripped) to the trajectory JSONL `run-one --task _toy --mock toy`
// writes, ending in the same graded event and final hash; a reconnect with Last-Event-ID k
// replays exactly frames k+1..n.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scenarioTransport } from '../../web/src/harness/scenarios.ts';
import { MODEL } from '../../../packages/core/anthropic.ts';
import type { TrialEvent } from '../../../packages/core/events.ts';
import { stripTimestamps } from '../../../packages/core/trajectory.ts';
import { main as runOne } from '../../../cli/run-one.ts';
import { launch, readSse, tempDir, toyTrial } from './helpers.ts';

async function runOneToy(): Promise<string> {
  const home = tempDir('run-one-toy');
  const out = join(home, 'out');
  const lines: string[] = [];
  const code = await runOne(['--task', '_toy', '--model', MODEL, '--mock', 'toy', '--out', out], {
    env: { HOME: home, SPEND_LEDGER: join(home, 'spend.jsonl') },
    out: (l) => lines.push(l),
    fetch: async () => {
      throw new Error('no live call');
    },
    mock: (name) => scenarioTransport(name).transport,
  });
  expect(code, lines.join('\n')).toBe(0);
  return readFileSync(join(out, 'trajectories', '_toy', MODEL, 'high', 'mock-toy', '0.jsonl'), 'utf8');
}

describe('same events as run-one (gate case 4)', () => {
  it('streams the run-one trajectory, line for line without timestamps, and replays after Last-Event-ID', async () => {
    const expected = await runOneToy();
    const l = await launch({ mock: true, transport: null });
    try {
      const a = (await l.http('POST', '/api/trials', { body: toyTrial() })).json() as { trial_ids: string[] };
      const path = `/api/trials/${a.trial_ids[0]}/events`;
      const s = await readSse(l.port, path, { token: l.runner.token });
      expect(s.status).toBe(200);
      const jsonl = s.frames.map((f) => `${f.data}\n`).join('');
      expect(stripTimestamps(jsonl)).toBe(stripTimestamps(expected));
      expect(s.frames.map((f) => f.id)).toEqual(s.frames.map((_, i) => String(i)));
      for (const f of s.frames) expect((JSON.parse(f.data) as TrialEvent).type).toBe(f.event);
      const last = JSON.parse(s.frames.at(-1)!.data) as Extract<TrialEvent, { type: 'graded' }>;
      const want = JSON.parse(expected.trim().split('\n').at(-1)!) as Extract<TrialEvent, { type: 'graded' }>;
      expect(last.type).toBe('graded');
      expect(last.record.outcome).toBe(want.record.outcome);
      expect(last.record.state_hash.final).toBe(want.record.state_hash.final);
      expect(last.record.state_hash.replay_final).toBe(last.record.state_hash.final);

      const n = s.frames.length;
      for (const k of [0, 3, n - 2]) {
        const again = await readSse(l.port, path, { token: l.runner.token, lastEventId: String(k) });
        expect(again.frames.map((f) => f.id)).toEqual(s.frames.slice(k + 1).map((f) => f.id));
        expect(again.frames.map((f) => f.data)).toEqual(s.frames.slice(k + 1).map((f) => f.data));
      }
      expect((await readSse(l.port, path, { token: l.runner.token, lastEventId: String(n - 1) })).frames).toEqual([]);
    } finally {
      await l.runner.shutdown();
    }
  });

  it('sends `: ping` while a trial is live, and a late subscriber gets the whole stream', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const l = await launch({ pingMs: 30, answer: async (label, n) => {
      if (!label.includes('validate') && n === 1) await gate;
      return undefined;
    } });
    try {
      await l.http('POST', '/api/key', { body: { key: 'ping-test-key-0123456789' } });
      const a = (await l.http('POST', '/api/trials', { body: toyTrial() })).json() as { trial_ids: string[] };
      const path = `/api/trials/${a.trial_ids[0]}/events`;
      const pending = readSse(l.port, path, { token: l.runner.token });
      await new Promise((r) => setTimeout(r, 150));
      release();
      const s = await pending;
      expect(s.text).toMatch(/^: ping$/m);
      const late = await readSse(l.port, path, { token: l.runner.token });
      expect(late.frames.map((f) => f.data)).toEqual(s.frames.map((f) => f.data));
    } finally {
      await l.runner.shutdown();
    }
  });
});
