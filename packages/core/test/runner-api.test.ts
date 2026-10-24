// The local runner's health and key contracts: every sample the UI specs route-mock with
// passes its validator, and a body with a field missing or mistyped is rejected.
import { describe, expect, it } from 'vitest';
import {
  ContractError, HEALTH_PATH, KEY_PATH, parseHealth, parseKeyRequest, parseKeyState, parseRunnerError,
  RUNNER_APP, SAMPLES, TOKEN_HEADER, TOKEN_META,
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
