// The session spend cap: what the interviewer allows this session to spend, never above the
// ledger's projected cap. On browser-direct the tab enforces it before each call (admitTrial
// against the tab ledger); on the local runner it is sent with each batch (P15). Amounts are
// compared in micro-dollars, as the ledger does, so a cap check is exact.
import { PROJECTED_CAP_USD } from '../../../../packages/core/ledger.ts';

export const DEFAULT_SESSION_CAP_USD = 20;
export const MAX_SESSION_CAP_USD = PROJECTED_CAP_USD;

const µ = (usd: number) => Math.round(usd * 1e6);
const fmt = (usd: number) => `$${usd.toFixed(2)}`;

// The cap a field's text sets, rounded to the cent, or null when that is not in
// [$0.01, MAX_SESSION_CAP_USD]. The field has no step of its own, so every value this accepts
// submits.
export function parseCap(text: string): number | null {
  const v = Number(text.trim());
  if (text.trim() === '' || !Number.isFinite(v)) return null;
  const cents = Math.round(v * 100) / 100;
  return cents >= 0.01 && cents <= MAX_SESSION_CAP_USD ? cents : null;
}

export type Admission = { ok: true } | { ok: false; reason: string };

// spent is the session's exposure so far (settled + reserved + open batches); a trial is
// admitted when spent + its estimate stays within the cap.
export function admitTrial({ cap, spent, estimate }: { cap: number; spent: number; estimate: number }): Admission {
  for (const v of [cap, spent, estimate]) if (!Number.isFinite(v) || v < 0) throw new TypeError(`cap terms must be finite numbers >= 0, got ${v}`);
  if (µ(spent) + µ(estimate) <= µ(cap)) return { ok: true };
  return { ok: false, reason: `Refused: spent ${fmt(spent)} + this estimate ${fmt(estimate)} would cross the session cap ${fmt(cap)}.` };
}
