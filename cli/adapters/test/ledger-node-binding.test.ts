// Grant binding per open, real-path ledger identity, an own-run ledger that must already exist,
// and a per-call refusal at the actual cap. Grant policy is process-wide state, so every case
// that depends on it runs in a fresh child process.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../scripts/test/helpers.ts';
import { SpendRefused, totals } from '../../../packages/core/ledger.ts';
import { openNodeLedger, readRows } from '../ledger-node.ts';

type Env = Record<string, string | undefined>;

function envFor(home: string, extra: Env = {}): Env {
  return { HOME: home, SPEND_LEDGER: undefined, CHARTR_CANONICAL_LEDGER: undefined, ...extra };
}

describe('a refusal at the actual cap', () => {
  it('for one call whose own worst case crosses $500 throws for that call only; the grant and its in-flight call go on', async () => {
    const root = tempDir('per-call-refusal');
    const path = join(root, 'spend.jsonl');
    const { ledger } = openNodeLedger({ transport: 'live', env: envFor(join(root, 'home'), { SPEND_LEDGER: path }) });
    const grant = await ledger.batchStart(50);
    type Done = { usage: { input_tokens: number; output_tokens: number } };
    let finish: (v: Done) => void = () => {};
    let inFlightSignal: AbortSignal | undefined;
    const inFlight = grant.metered({ bodyBytes: 100, maxTokens: 1000 }, (signal) => {
      inFlightSignal = signal;
      return new Promise<Done>((resolve) => (finish = resolve));
    });
    await new Promise((r) => setTimeout(r, 50));
    // 30M max tokens is a $600 worst case on its own.
    await expect(grant.reserve({ bodyBytes: 0, maxTokens: 30_000_000 })).rejects.toThrow(SpendRefused);
    expect(grant.signal.aborted).toBe(false);
    expect(inFlightSignal?.aborted).toBe(false);
    finish({ usage: { input_tokens: 100, output_tokens: 10 } });
    await inFlight;
    await grant.metered({ bodyBytes: 10, maxTokens: 10 }, async () => ({ usage: { input_tokens: 10, output_tokens: 1 } }));
    const t = totals(readRows(path));
    expect(t.reserved).toBe(0);
    expect(t.settled).toBeCloseTo((100 * 4 + 10 * 20 + 10 * 4 + 1 * 20) / 1e6, 9);
  });
});
