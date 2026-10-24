// The session's cap and what the tab ledger has spent against it, as one store the top bar
// meter and the key gate read. The cap the user set is kept in sessionStorage beside the tab
// ledger's rows, so a reload changes neither the cap nor the spend.
import { useSyncExternalStore } from 'react';
import { tabLedger } from '../adapters/ledger-browser.ts';
import { DEFAULT_SESSION_CAP_USD, parseCap } from './cap.ts';

export interface SessionSpend {
  cap: number;
  spent: number;
}

export const CAP_KEY = 'chartr.cap';

const session = (): Storage | null => {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
};

const storedCap = (): number => {
  try {
    return parseCap(session()?.getItem(CAP_KEY) ?? '') ?? DEFAULT_SESSION_CAP_USD;
  } catch {
    return DEFAULT_SESSION_CAP_USD;
  }
};

let state: SessionSpend = { cap: storedCap(), spent: 0 };
const listeners = new Set<() => void>();
const emit = (next: SessionSpend) => {
  state = next;
  for (const l of listeners) l();
};

export const sessionSpend = (): SessionSpend => state;

// The cap P15 sends with each local-runner batch and checks before each browser-direct trial.
export const sessionCap = (): number => state.cap;

export function setSessionCap(cap: number): void {
  try {
    session()?.setItem(CAP_KEY, String(cap));
  } catch {
    // storage blocked: the cap holds for this page
  }
  if (cap !== state.cap) emit({ ...state, cap });
}

// Re-reads the tab ledger: at load, and after a call settles.
export async function refreshSpent(): Promise<number> {
  const spent = (await tabLedger().totals()).exposure;
  if (spent !== state.spent) emit({ ...state, spent });
  return spent;
}

export function useSessionSpend(): SessionSpend {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), sessionSpend);
}
