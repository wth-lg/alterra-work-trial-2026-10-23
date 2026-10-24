// Pins the session cap's bound: no session may be allowed to spend more than the ledger's
// projected cap, and the cap field accepts exactly the cent amounts up to it.
import { describe, expect, it } from 'vitest';
import { ACTUAL_CAP_USD, PROJECTED_CAP_USD } from '../../../packages/core/ledger.ts';
import { MAX_SESSION_CAP_USD, parseCap } from '../src/spend/cap.ts';

describe('session cap bound', () => {
  it('never exceeds the projected cap, which stays below the actual cap', () => {
    expect(MAX_SESSION_CAP_USD).toBeLessThanOrEqual(PROJECTED_CAP_USD);
    expect(PROJECTED_CAP_USD).toBeLessThanOrEqual(ACTUAL_CAP_USD);
  });

  it('accepts the projected cap and refuses a cent above it', () => {
    expect(parseCap(String(PROJECTED_CAP_USD))).toBe(PROJECTED_CAP_USD);
    expect(parseCap((PROJECTED_CAP_USD + 0.01).toFixed(2))).toBeNull();
    expect(parseCap(String(ACTUAL_CAP_USD))).toBeNull();
  });
});
