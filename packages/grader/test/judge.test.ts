// The judge request (design section 5, "Judge and hybrid items"): one isolated call per
// criterion on claude-opus-5-5 at effort low, through the same client and ledger as the trial,
// with no sampling parameter; the cache key is sha256 over model, effort, prompt version,
// prompt and the graded text.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MODEL } from '../../core/anthropic.ts';
import { JUDGE_EFFORT, JUDGE_PROMPT_VERSION, Judge, judgeAllowanceUsd } from '../judge.ts';
import { judged, hybrid } from '../check.ts';
import { scriptedJudge } from './helpers.ts';

describe('judge', () => {
  it('sends one user turn at effort low, without the gate result or any banned parameter', async () => {
    const j = scriptedJudge(['{"verdict":"met","quote":"5 mg BID"}']);
    const judge = new Judge({ client: j.client });
    const v = await judge.judge({ criterion: 'States the new apixaban dose.', text: 'Apixaban increased to 5 mg BID.' });
    expect(v).toMatchObject({ met: true, evidence: { verdict: 'met', quote: '5 mg BID' } });
    expect(j.requests).toHaveLength(1);
    const { history, params } = j.requests[0]!;
    expect(history).toHaveLength(1);
    expect(history[0]!.role).toBe('user');
    expect(JSON.stringify(history[0]!.content)).toContain('States the new apixaban dose.');
    expect(params.output_config).toEqual({ effort: JUDGE_EFFORT });
    expect(JUDGE_EFFORT).toBe('low');
    for (const k of ['temperature', 'top_p', 'top_k', 'model', 'tool_choice', 'tools']) expect(params).not.toHaveProperty(k);
  });

  it('keys the cache by sha256 of (model, effort, prompt version, prompt, text)', async () => {
    const j = scriptedJudge(['{"verdict":"not_met","quote":""}']);
    const judge = new Judge({ client: j.client });
    await judge.judge({ criterion: 'c', text: 't' });
    const [entry] = judge.entries();
    const prompt = JSON.stringify(j.requests[0]!.history[0]!.content);
    const expected = createHash('sha256').update(JSON.stringify([MODEL, 'low', JUDGE_PROMPT_VERSION, JSON.parse(prompt), 't'])).digest('hex');
    expect(entry).toMatchObject({ key: expected, kind: 'judge', model: MODEL, effort: 'low', prompt_version: JUDGE_PROMPT_VERSION });
    // A second ask of the same question is answered from the cache.
    await judge.judge({ criterion: 'c', text: 't' });
    expect(j.requests).toHaveLength(1);
  });

  it('a met verdict needs a quote; a judge error is unknown, not a crash', async () => {
    const empty = new Judge({ client: scriptedJudge(['{"verdict":"met","quote":""}']).client });
    expect(await empty.judge({ criterion: 'c', text: 'text' })).toMatchObject({ met: 'unknown', evidence: { reason: 'quote not in text' } });
    const failing = new Judge({ client: { send: () => Promise.reject(new Error('529 overloaded')) } });
    expect(await failing.judge({ criterion: 'c', text: 'text' })).toMatchObject({ met: 'unknown', evidence: { reason: 'judge error: 529 overloaded' } });
    // The error is cached in place of an answer, so a regrade reproduces the unknown.
    expect(failing.entries()).toMatchObject([{ answer: null, error: 'judge error: 529 overloaded' }]);
  });

  it('the projection allowance counts each judge and hybrid item, twice for the schema retry', () => {
    const t = () => 'x';
    const checks = [
      judged({ id: 'J', points: 1, category: 'documentation', traces_to: 'p', decisive_ids: [], criterion: 'c', text: t }),
      hybrid({ id: 'H', points: 1, category: 'documentation', traces_to: 'p', decisive_ids: [], field: 'f', text: t, pattern: /(\d+)/, truth: 1, tolerance: { abs: 0 } }),
    ];
    expect(judgeAllowanceUsd([])).toBe(0);
    expect(judgeAllowanceUsd(checks)).toBeGreaterThan(0);
    expect(judgeAllowanceUsd(checks)).toBe(2 * judgeAllowanceUsd(checks.slice(0, 1)));
  });
});
