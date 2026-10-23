// The key gate on browser-direct: the design's one-call check from the tab. One Messages call
// (effort low, 16 output tokens) through MessagesClient, metered by the tab ledger and admitted
// against the session cap first; one attempt, no retry. A 200 proves CORS, the key and model
// access at once. An org that does not allow browser access answers HTTP 401 with a message
// the UI matches, and the gate points to the local runner instead.
import { ApiError, MessagesClient, reserveRequest, type MessageParam, type MessageParams } from '../../../../packages/core/anthropic.ts';
import { worstCaseUsd } from '../../../../packages/core/cost.ts';
import { SpendRefused } from '../../../../packages/core/ledger.ts';
import { tabLedger } from '../adapters/ledger-browser.ts';
import { admitTrial } from '../spend/cap.ts';
import { refreshSpent } from '../spend/session.ts';

const TRIAL = 'validate';
const history = (): MessageParam[] => [{ role: 'user', content: 'Reply with the word ok.' }];
const PARAMS: MessageParams = { max_tokens: 16, output_config: { effort: 'low' } };

// The API's message when the key's organization does not allow browser (CORS) access.
const ORG_CORS = /CORS requests are not allowed for this Organization/i;

export type DirectResult =
  | { ok: true }
  | { ok: false; kind: 'org-cors' | 'network' | 'cap' | 'api'; message: string };

export const validateEstimate = (): number => worstCaseUsd(reserveRequest(history(), PARAMS, TRIAL));

export async function validateDirect(apiKey: string, cap: number): Promise<DirectResult> {
  const ledger = tabLedger();
  const estimate = validateEstimate();
  const admitted = admitTrial({ cap, spent: await refreshSpent(), estimate });
  if (!admitted.ok) return { ok: false, kind: 'cap', message: admitted.reason };
  let grant;
  try {
    grant = await ledger.batchStart(estimate);
  } catch (e) {
    return { ok: false, kind: 'cap', message: (e as Error).message };
  }
  try {
    const client = new MessagesClient({ grant, ledger, apiKey, maxAttempts: 1, trial: TRIAL });
    await client.send(history(), PARAMS);
    return { ok: true };
  } catch (e) {
    return classify(e);
  } finally {
    await grant.close();
    await refreshSpent();
  }
}

function classify(e: unknown): DirectResult & { ok: false } {
  const message = (e as Error).message;
  if (e instanceof SpendRefused) return { ok: false, kind: 'cap', message };
  if (e instanceof ApiError && e.status === 401 && ORG_CORS.test(message)) return { ok: false, kind: 'org-cors', message };
  // No status: the browser never got a readable response, which is how a CORS block looks.
  if (e instanceof ApiError && e.status === null && e.partial) return { ok: false, kind: 'network', message };
  return { ok: false, kind: 'api', message };
}
