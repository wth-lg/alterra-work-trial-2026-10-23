// The session's cap and what the tab ledger has spent against it, as one store the top bar
// meter and the key gate read.
import { useSyncExternalStore } from 'react';
import { tabLedger } from '../adapters/ledger-browser.ts';
import { DEFAULT_SESSION_CAP_USD } from './cap.ts';

export interface SessionSpend {
  cap: number;
  spent: number;
}

let state: SessionSpend = { cap: DEFAULT_SESSION_CAP_USD, spent: 0 };
const listeners = new Set<() => void>();
const emit = (next: SessionSpend) => {
  state = next;
  for (const l of listeners) l();
};

export const sessionSpend = (): SessionSpend => state;

// The cap P15 sends with each local-runner batch and checks before each browser-direct trial.
export const sessionCap = (): number => state.cap;

export function setSessionCap(cap: number): void {
  if (cap !== state.cap) emit({ ...state, cap });
}

// Re-reads the tab ledger after a call settles.
export async function refreshSpent(): Promise<number> {
  const spent = (await tabLedger().totals()).exposure;
  if (spent !== state.spent) emit({ ...state, spent });
  return spent;
}

export function useSessionSpend(): SessionSpend {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), sessionSpend);
}
