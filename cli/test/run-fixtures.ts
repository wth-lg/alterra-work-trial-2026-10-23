// Run directories for the summary, audit-check and donewhen tests: a live run of two tasks of 10
// trials, 5 PASS and 5 FAIL each, with trajectories, replay.json, audit.jsonl, matrix.json and a manifest that
// expects both tasks, and one variant per violation the gate names. Records carry the fields summary and audit-check read, as cli run writes them.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { MODEL } from '../../packages/core/anthropic.ts';

export const SUMMARY_FIXTURES = ['nine-trials', 'model-mismatch', 'requeued-env-error', 'replay-mismatch', 'eight-of-ten', 'missing-task', 'mock-mode', 'grader-error', 'fail-regraded-pass'] as const;
export const AUDIT_FIXTURES = ['missing-label', 'environment-label', 'evidence-absent', 'unadjudicated', 'never-exposable', 'one-audited-pass', 'model-fault-no'] as const;
export type Fixture = 'clean' | 'grader-error-regraded' | (typeof SUMMARY_FIXTURES)[number] | (typeof AUDIT_FIXTURES)[number];

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
  const graded = outcome === 'PASS' || fail;
  return {
    trial_id: `run:fx:${task_id}/${index}`, run_id: 'final-1', task_id, task_version: `v-${task_id}`, index, attempt: 'a-1', mode: 'live',
    model_requested: MODEL, models_returned: [MODEL], effort: 'high', status: 'COMPLETED', outcome, valid: graded,
    score: graded ? (outcome === 'PASS' ? 1 : 0) : null, cost_usd: 0.4, judge_cost_usd: 0.02, turns: 2, tool_calls: 2,
    tool_errors: { INVALID_INPUT: 0, NOT_FOUND: 0, CONFLICT: 0, NOT_SUPPORTED: 0, INTERNAL: outcome === 'ENV_ERROR' ? 1 : 0 },
    state_hash: { initial: 'h-initial', final: 'h-final', replay_final: 'h-final' },
    checks: [{ id: 'G1', kind: 'gate', met: !fail }],
    attribution: fail ? { auto: 'reasoning', first_failed: 'G1', decisive_step: 2, exposure: [{ id: EXPOSED, first_exposed_step: 1 }] } : null,
    trajectory: `trajectories/${task_id}/${index}.jsonl`,
    ...over,
  };
}

// A cli regrade entry with its check results.
const regrade = (outcome: 'PASS' | 'FAIL') => ({
  grader_version: 'g-next', outcome, score: outcome === 'PASS' ? 1 : 0, valid: true, changed: true,
  checks: [{ id: 'G1', kind: 'gate', met: outcome === 'PASS' }], at: '2026-10-24T00:00:00.000Z',
});

export function writeFixtureRun(dir: string, fixture: Fixture): void {
  const labels: Array<Record<string, unknown>> = [];
  const replay: Record<string, { match: boolean }> = {};
  const mode = fixture === 'mock-mode' ? 'mock-fixture' : 'live';
  for (const task of TASKS) {
    if (fixture === 'missing-task' && task === 't-beta') continue;
    const count = fixture === 'nine-trials' && task === 't-alpha' ? 9 : 10;
    const passes = fixture === 'eight-of-ten' && task === 't-alpha' ? 8 : 5;
    for (let i = 0; i < count; i++) {
      const outcome = i < passes ? 'PASS' : 'FAIL';
      const over: Record<string, unknown> = {};
      if (fixture === 'model-mismatch' && task === 't-beta' && i === 7) over.models_returned = [MODEL, 'claude-other-model'];
      if (fixture === 'never-exposable' && task === 't-beta' && i === 9) {
        over.attribution = { auto: 'retrieval', first_failed: 'G1', decisive_step: 2, exposure: [{ id: 'Observation/never-in-world', first_exposed_step: null }] };
      }
      // fail-regraded-pass: a later grader passes t-alpha's 5 FAIL records (their labels still say FAIL).
      if (fixture === 'fail-regraded-pass' && task === 't-alpha' && outcome === 'FAIL') over.regrades = [regrade('PASS')];
      // grader-error-regraded: t-alpha/9, one of the 10 keys, was a GRADER_ERROR; a regrade with a
      // fixed grader fails it, as its label says.
      if (fixture === 'grader-error-regraded' && task === 't-alpha' && i === 9) Object.assign(over, { outcome: 'GRADER_ERROR', valid: false, score: null, attribution: null, regrades: [regrade('FAIL')] });
      const r = record(task, i, outcome, { mode, ...over });
      put(dir, `trials/${task}/${i}.json`, `${JSON.stringify(r, null, 2)}\n`);
      put(dir, `trajectories/${task}/${i}.jsonl`, TRAJECTORY);
      replay[`${task}/${i}`] = { match: !(fixture === 'replay-mismatch' && task === 't-alpha' && i === 2) };
      const key = `${task}/${i}`;
      if (outcome === 'FAIL') {
        if (fixture === 'missing-label' && key === 't-alpha/6') continue;
        labels.push({
          trial: key, outcome, taxonomy: fixture === 'environment-label' && key === 't-beta/8' ? 'environment' : 'reasoning',
          model_fault: fixture === 'model-fault-no' && key === 't-alpha/7' ? 'no' : 'yes', decisive_step: 2, evidence_ids: [fixture === 'evidence-absent' && key === 't-alpha/5' ? 'Observation/not-in-trajectory' : EXPOSED],
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
  if (fixture === 'grader-error') {
    // An eleventh record: a check threw.
    put(dir, 'trials/t-alpha/10.json', `${JSON.stringify(record('t-alpha', 10, 'GRADER_ERROR', { mode }), null, 2)}\n`);
    put(dir, 'trajectories/t-alpha/10.jsonl', TRAJECTORY);
    replay['t-alpha/10'] = { match: true };
  }
  put(dir, 'replay.json', `${JSON.stringify({ trials: replay }, null, 2)}\n`);
  put(dir, 'audit.jsonl', labels.map((l) => JSON.stringify(l)).join('\n') + '\n');
  put(dir, 'manifest.json', `${JSON.stringify({ run_id: 'final-1', model: MODEL, effort: 'high', mode, trials: 10, world_hash: 'h-initial', task_versions: Object.fromEntries(TASKS.map((t) => [t, `v-${t}`])), batches: [] }, null, 2)}\n`);
  // The grader validation matrix of each task_version (audit-check reads it for criterion M4).
  put(dir, 'matrix.json', `${JSON.stringify({ task_versions: Object.fromEntries(TASKS.map((t) => [`v-${t}`, { oracle_pass: true, alternatives_pass: true }])) }, null, 2)}\n`);
}
