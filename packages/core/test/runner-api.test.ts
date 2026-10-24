// The local runner's health, key, trial, run and SSE contracts: every sample the UI specs route-mock with
// passes its validator, and a body with a field missing or mistyped is rejected.
import { describe, expect, it } from 'vitest';
import { reserveRequest } from '../anthropic.ts';
import { FINAL_TRIALS_PER_TASK, worstCaseUsd } from '../cost.ts';
import {
  ContractError, HEALTH_PATH, KEY_PATH, MAX_CONCURRENCY, MAX_TRIALS_PER_TASK, parseDryRun, parseHealth, parseKeyRequest, parseKeyState,
  parseRunnerError, parseRunsList, parseSse, parseSseEnd, parseTrialsAccepted, parseTrialsRefused, parseTrialsRequest, parseTrialView,
  RUNNER_APP, RUNS_PATH, SAMPLES, sseFrame, SSE_END, TOKEN_HEADER, TOKEN_META, TRIALS_PATH, VALIDATE_REQUEST, validateWorstCaseUsd,
} from '../runner-api.ts';

const without = (o: object, k: string) => Object.fromEntries(Object.entries(o).filter(([name]) => name !== k));

describe('runner-api samples', () => {
  it('accepts every sample', () => {
    expect(parseHealth(SAMPLES.health)).toEqual(SAMPLES.health);
    expect(parseHealth(SAMPLES.healthWithKey).key_loaded).toBe(true);
    expect(parseHealth(SAMPLES.healthOwnRun).ledger.mode).toBe('own-run');
    expect(parseKeyRequest(SAMPLES.keyRequest)).toEqual(SAMPLES.keyRequest);
    expect(parseKeyState(SAMPLES.keyAccepted)).toEqual({ key_set: true });
    expect(parseKeyState(SAMPLES.keyCleared)).toEqual({ key_set: false });
    expect(parseRunnerError(SAMPLES.keyError).error.message).toMatch(/x-api-key/);
  });

  it('names the runner app, the same-origin paths, the token header and the token meta', () => {
    expect(SAMPLES.health.app).toBe(RUNNER_APP);
    expect(RUNNER_APP).toBe('clinenv-runner');
    expect([HEALTH_PATH, KEY_PATH]).toEqual(['api/health', 'api/key']);
    expect(TOKEN_HEADER).toBe('X-Clinenv-Token');
    expect(TOKEN_META).toBe('clinenv-runner-token');
  });
});

describe('runner-api validators', () => {
  it('rejects the static build\'s health body, so the hosted page is browser-direct', () => {
    expect(() => parseHealth(SAMPLES.staticHealth)).toThrow(ContractError);
  });

  it('has the P12b plan health shape: app, version, ledger {mode, path}, key_loaded, mock', () => {
    expect(Object.keys(SAMPLES.health).sort()).toEqual(['app', 'key_loaded', 'ledger', 'mock', 'version']);
    expect(Object.keys(SAMPLES.health.ledger).sort()).toEqual(['mode', 'path']);
  });

  it('rejects a health body missing any field, or a ledger missing mode or path', () => {
    for (const k of Object.keys(SAMPLES.health)) expect(() => parseHealth(without(SAMPLES.health, k)), k).toThrow(ContractError);
    for (const k of Object.keys(SAMPLES.health.ledger)) {
      expect(() => parseHealth({ ...SAMPLES.health, ledger: without(SAMPLES.health.ledger, k) }), `ledger.${k}`).toThrow(ContractError);
    }
  });

  it('rejects a health body from another app or with a mistyped field', () => {
    expect(() => parseHealth({ ...SAMPLES.health, app: 'vite' })).toThrow(ContractError);
    expect(() => parseHealth({ ...SAMPLES.health, version: 1 })).toThrow(ContractError);
    expect(() => parseHealth({ ...SAMPLES.health, key_loaded: 'no' })).toThrow(ContractError);
    expect(() => parseHealth({ ...SAMPLES.health, mock: 'no' })).toThrow(ContractError);
    expect(() => parseHealth({ ...SAMPLES.health, ledger: null })).toThrow(ContractError);
    expect(() => parseHealth({ ...SAMPLES.health, ledger: { ...SAMPLES.health.ledger, mode: 'other' } })).toThrow(ContractError);
    expect(() => parseHealth({ ...SAMPLES.health, ledger: { ...SAMPLES.health.ledger, path: 7 } })).toThrow(ContractError);
    for (const x of [null, [], 'clinenv-runner', 200, '<!doctype html>']) expect(() => parseHealth(x)).toThrow(ContractError);
  });

  it('rejects a key request missing its key, with an empty or padded key, or with any other field', () => {
    expect(() => parseKeyRequest({})).toThrow(ContractError);
    expect(() => parseKeyRequest({ key: '' })).toThrow(ContractError);
    expect(() => parseKeyRequest({ key: ' padded ' })).toThrow(ContractError);
    expect(() => parseKeyRequest({ key: 'x'.repeat(513) })).toThrow(ContractError);
    expect(() => parseKeyRequest({ ...SAMPLES.keyRequest, remember: true })).toThrow(ContractError);
  });

  it('rejects a key state or runner error missing a field', () => {
    expect(() => parseKeyState({})).toThrow(ContractError);
    expect(() => parseRunnerError({ error: { type: 'x' } })).toThrow(ContractError);
    expect(() => parseRunnerError({ error: { message: 'x' } })).toThrow(ContractError);
    expect(() => parseRunnerError({})).toThrow(ContractError);
  });

  it('never echoes a key in an error message', () => {
    const key = ['sk', 'ant', 'api03', 'Q'.repeat(40)].join('-');
    try {
      parseKeyRequest({ key, extra: 1 });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).not.toContain(key);
    }
  });
});

describe('runner-api trial, run and SSE contracts (P12b)', () => {
  it('accepts every P12b sample', () => {
    expect(parseTrialsRequest(SAMPLES.trialsRequest)).toEqual(SAMPLES.trialsRequest);
    expect(parseTrialsAccepted(SAMPLES.trialsAccepted)).toEqual(SAMPLES.trialsAccepted);
    expect(parseDryRun(SAMPLES.dryRun).projection.total_usd).toBe(SAMPLES.dryRun.projection.total_usd);
    expect(parseTrialsRefused(SAMPLES.trialsRefused).error.type).toBe('session_cap');
    expect(parseTrialView(SAMPLES.trial)).toEqual(SAMPLES.trial);
    expect(parseRunsList(SAMPLES.runs)).toEqual(SAMPLES.runs);
    expect(parseSseEnd(SAMPLES.sseEnd)).toEqual(SAMPLES.sseEnd);
    expect([TRIALS_PATH, RUNS_PATH]).toEqual(['api/trials', 'api/runs']);
  });

  it('takes 1 to 20 trials per task (the final run N) and 1 to 4 concurrency', () => {
    expect(MAX_TRIALS_PER_TASK).toBe(FINAL_TRIALS_PER_TASK);
    expect(parseTrialsRequest({ ...SAMPLES.trialsRequest, trials: MAX_TRIALS_PER_TASK }).trials).toBe(20);
    for (const trials of [0, 21, 1.5, '1', null]) expect(() => parseTrialsRequest({ ...SAMPLES.trialsRequest, trials }), String(trials)).toThrow(ContractError);
    expect(parseTrialsRequest({ ...SAMPLES.trialsRequest, concurrency: MAX_CONCURRENCY }).concurrency).toBe(4);
    for (const concurrency of [0, 5]) expect(() => parseTrialsRequest({ ...SAMPLES.trialsRequest, concurrency })).toThrow(ContractError);
  });

  it('refuses unknown fields, bad task ids, a bad effort or cap, and never echoes a key', () => {
    const key = ['sk', 'ant', 'api03', 'Z'.repeat(40)].join('-');
    const bad: unknown[] = [
      { ...SAMPLES.trialsRequest, extra: key },
      { ...SAMPLES.trialsRequest, tasks: [] },
      { ...SAMPLES.trialsRequest, tasks: ['../x'] },
      { ...SAMPLES.trialsRequest, tasks: ['a', 'a'] },
      { ...SAMPLES.trialsRequest, effort: 'turbo' },
      { ...SAMPLES.trialsRequest, session_cap_usd: 0 },
      { ...SAMPLES.trialsRequest, key: ` ${key}` },
      { ...SAMPLES.trialsRequest, smoke: 'yes' },
      { ...SAMPLES.trialsRequest, tasks: [key, 'x y'] },
    ];
    for (const b of bad) {
      try {
        parseTrialsRequest(b);
        expect.unreachable(JSON.stringify(b).slice(0, 80));
      } catch (e) {
        expect(e).toBeInstanceOf(ContractError);
        expect((e as Error).message).not.toContain(key);
      }
    }
    expect(parseTrialsRequest({ ...SAMPLES.trialsRequest, key }).key).toBe(key);
    // Unknown fields are counted, never named: a field name is client text, and an encoded key
    // passes redaction (security review P12b-4 G1).
    const encoded = key.replace('s', '%73');
    expect(() => parseTrialsRequest({ ...SAMPLES.trialsRequest, [encoded]: 1 })).toThrow(/^trials request: 1 unknown field$/);
    expect(() => parseTrialsRequest({ ...SAMPLES.trialsRequest, [encoded]: 1, [key.slice(14)]: 2 })).toThrow(/^trials request: 2 unknown fields$/);
    expect(() => parseKeyRequest({ key, [encoded]: 1 })).toThrow(/^key request: 1 unknown field$/);
  });

  it('frames and parses the SSE stream: id, event, one data line, comments dropped, a partial frame kept', () => {
    const a = sseFrame({ id: '0', event: 'request', data: '{"seq":0}' });
    const end = sseFrame({ id: null, event: SSE_END, data: JSON.stringify(SAMPLES.sseEnd) });
    expect(a).toBe('id: 0\nevent: request\ndata: {"seq":0}\n\n');
    const { frames, rest } = parseSse(`${a}: ping\n\n${end}id: 1\nevent: resp`);
    expect(frames).toEqual([{ id: '0', event: 'request', data: '{"seq":0}' }, { id: null, event: 'end', data: JSON.stringify(SAMPLES.sseEnd) }]);
    expect(rest).toBe('id: 1\nevent: resp');
  });

  it('rejects a trial view, runs list or stream end with a missing or mistyped field', () => {
    for (const k of Object.keys(SAMPLES.trial)) expect(() => parseTrialView(without(SAMPLES.trial, k)), k).toThrow(ContractError);
    expect(() => parseTrialView({ ...SAMPLES.trial, state: 'done' })).toThrow(ContractError);
    expect(() => parseRunsList({ runs: [without(SAMPLES.runs.runs[0], 'smoke')] })).toThrow(ContractError);
    expect(() => parseSseEnd({ state: 'graded' })).toThrow(ContractError);
    expect(() => parseDryRun({ ...SAMPLES.dryRun, calls: 1 })).toThrow(ContractError);
    expect(() => parseTrialsAccepted({ ...SAMPLES.trialsAccepted, trial_ids: [] })).toThrow(ContractError);
  });
});

describe('the Validate call', () => {
  it('is one low-effort call of at most 16 output tokens, and its worst case is what the ledger reserves for it', () => {
    expect(VALIDATE_REQUEST.params).toEqual({ max_tokens: 16, output_config: { effort: 'low' } });
    expect(validateWorstCaseUsd()).toBe(worstCaseUsd(reserveRequest(VALIDATE_REQUEST.history, VALIDATE_REQUEST.params)));
    expect(validateWorstCaseUsd()).toBeGreaterThan(0);
    expect(validateWorstCaseUsd()).toBeLessThan(0.1);
  });
});
