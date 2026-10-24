// Run directories for the summary, audit-check and donewhen tests: two tasks of 10 trials, 5 PASS
// and 5 FAIL each, with trajectories, replay.json and audit.jsonl, and one variant per violation
// the gate names. Records carry the fields summary and audit-check read, as cli run writes them.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MODEL } from '../../packages/core/anthropic.ts';

export const SUMMARY_FIXTURES = ['nine-trials', 'model-mismatch', 'requeued-env-error', 'replay-mismatch', 'eight-of-ten'] as const;
export const AUDIT_FIXTURES = ['missing-label', 'environment-label', 'evidence-absent', 'unadjudicated', 'never-exposable', 'one-audited-pass'] as const;
export type Fixture = 'clean' | (typeof SUMMARY_FIXTURES)[number] | (typeof AUDIT_FIXTURES)[number];

export const TASKS = ['t-alpha', 't-beta'];
const EXPOSED = 'Patient/pt-0001';
const NOTE = 'DocumentReference/note-fx-1';

function put(dir: string, rel: string, content: string): void {
  const file = join(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

const base = (seq: number) => ({ v: 2, seq, ts: '2026-10-24T00:00:00.000Z', turn: 1 });
const result = (seq: number, name: string, ids: { exposed?: string[]; written?: string[] }) => ({
  ...base(seq), type: 'tool_result', tool_use_id: `toolu_${seq}`, name, executed: true, is_error: false, error_code: null, content: {},
  exposed_ids: ids.exposed ?? [], referenced_ids: [], written_ids: ids.written ?? [],
});

// Step 1 exposes the patient, step 2 writes the note.
const TRAJECTORY = [result(1, 'fhir_read', { exposed: [EXPOSED] }), result(2, 'write_note', { written: [NOTE] })].map((e) => JSON.stringify(e)).join('\n') + '\n';

function record(task_id: string, index: number, outcome: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  const fail = outcome === 'FAIL';
  return {
    trial_id: `run:fx:${task_id}/${index}`, run_id: 'final-1', task_id, task_version: `v-${task_id}`, index, attempt: 'a-1', mode: 'mock-fixture',
    model_requested: MODEL, models_returned: [MODEL], effort: 'high', status: 'COMPLETED', outcome, valid: outcome !== 'ENV_ERROR',
    score: outcome === 'PASS' ? 1 : 0, cost_usd: 0.4, judge_cost_usd: 0.02, turns: 2, tool_calls: 2,
    tool_errors: { INVALID_INPUT: 0, NOT_FOUND: 0, CONFLICT: 0, NOT_SUPPORTED: 0, INTERNAL: outcome === 'ENV_ERROR' ? 1 : 0 },
    state_hash: { initial: 'h-initial', final: 'h-final', replay_final: 'h-final' },
    checks: [{ id: 'G1', kind: 'gate', met: !fail }],
    attribution: fail ? { auto: 'reasoning', first_failed: 'G1', decisive_step: 2, exposure: [{ id: EXPOSED, first_exposed_step: 1 }] } : null,
    trajectory: `trajectories/${task_id}/${index}.jsonl`,
    ...over,
  };
}

export function writeFixtureRun(dir: string, fixture: Fixture): void {
  const labels: Array<Record<string, unknown>> = [];
  const replay: Record<string, { match: boolean }> = {};
  for (const task of TASKS) {
    const count = fixture === 'nine-trials' && task === 't-alpha' ? 9 : 10;
    const passes = fixture === 'eight-of-ten' && task === 't-alpha' ? 8 : 5;
    for (let i = 0; i < count; i++) {
      const outcome = i < passes ? 'PASS' : 'FAIL';
      const over: Record<string, unknown> = {};
      if (fixture === 'model-mismatch' && task === 't-beta' && i === 7) over.models_returned = [MODEL, 'claude-other-model'];
      if (fixture === 'never-exposable' && task === 't-beta' && i === 9) {
        over.attribution = { auto: 'retrieval', first_failed: 'G1', decisive_step: 2, exposure: [{ id: 'Observation/never-in-world', first_exposed_step: null }] };
      }
      const r = record(task, i, outcome, over);
      put(dir, `trials/${task}/${i}.json`, `${JSON.stringify(r, null, 2)}\n`);
      put(dir, `trajectories/${task}/${i}.jsonl`, TRAJECTORY);
      replay[`${task}/${i}`] = { match: !(fixture === 'replay-mismatch' && task === 't-alpha' && i === 2) };
      const key = `${task}/${i}`;
      if (outcome === 'FAIL') {
        if (fixture === 'missing-label' && key === 't-alpha/6') continue;
        labels.push({
          trial: key, outcome, taxonomy: fixture === 'environment-label' && key === 't-beta/8' ? 'environment' : 'reasoning',
          model_fault: 'yes', decisive_step: 2, evidence_ids: [fixture === 'evidence-absent' && key === 't-alpha/5' ? 'Observation/not-in-trajectory' : EXPOSED],
          llm_auditor_agrees: !(fixture === 'unadjudicated' && key === 't-beta/5'), note: 'chose the wrong value with the evidence in view',
        });
      } else if (i < (fixture === 'one-audited-pass' && task === 't-beta' ? 1 : 2)) {
        labels.push({ trial: key, outcome, taxonomy: null, model_fault: null, decisive_step: null, evidence_ids: [EXPOSED], llm_auditor_agrees: true, note: 'passed for the right reasons' });
      }
    }
  }
  if (fixture === 'requeued-env-error') {
    put(dir, 'requeued/t-alpha/3.a-0.json', `${JSON.stringify(record('t-alpha', 3, 'ENV_ERROR', { status: 'ENV_ERROR', attempt: 'a-0', settled: false, requeue_reason: 'ENV_ERROR' }), null, 2)}\n`);
  }
  put(dir, 'replay.json', `${JSON.stringify({ trials: replay }, null, 2)}\n`);
  put(dir, 'audit.jsonl', labels.map((l) => JSON.stringify(l)).join('\n') + '\n');
  put(dir, 'manifest.json', `${JSON.stringify({ run_id: 'final-1', model: MODEL, effort: 'high', mode: 'mock-fixture', batches: [] }, null, 2)}\n`);
}
