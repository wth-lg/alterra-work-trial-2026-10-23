// Where the key is, owned by the app shell. On browser-direct the key lives in this module's
// memory (and in sessionStorage only when the interviewer opts in); P15 hands tabKey() to each
// trial Worker. On the local runner the tab keeps no copy: the runner holds it, and this
// module records only that it does. The key never goes to localStorage or IndexedDB.
import { useSyncExternalStore } from 'react';

export type KeyStatus = { kind: 'none' } | { kind: 'tab'; masked: string } | { kind: 'runner' };

const REMEMBER = 'clinenv.key';

let key: string | null = null;
let status: KeyStatus = { kind: 'none' };
const listeners = new Set<() => void>();
const emit = (next: KeyStatus) => {
  status = next;
  for (const l of listeners) l();
};

export const mask = (k: string) => `${k.slice(0, 7)}…${k.slice(-4)}`;

const session = (): Storage | null => {
  try {
    return globalThis.sessionStorage;
  } catch {
    return null;
  }
};

export const keyStatus = (): KeyStatus => status;
export const tabKey = (): string | null => key;

export function holdInTab(k: string, remember: boolean): void {
  key = k;
  if (remember) session()?.setItem(REMEMBER, k);
  else session()?.removeItem(REMEMBER);
  emit({ kind: 'tab', masked: mask(k) });
}

export function heldByRunner(): void {
  key = null;
  session()?.removeItem(REMEMBER);
  emit({ kind: 'runner' });
}

export function forget(): void {
  key = null;
  session()?.removeItem(REMEMBER);
  emit({ kind: 'none' });
}

// Browser-direct only: a key the interviewer chose to remember in this tab.
export function restoreRemembered(): boolean {
  const k = session()?.getItem(REMEMBER);
  if (!k) return false;
  holdInTab(k, true);
  return true;
}

// The local runner never needs a tab copy; drop one an earlier browser-direct visit left.
export const dropRemembered = (): void => session()?.removeItem(REMEMBER);

export function useKeyStatus(): KeyStatus {
  return useSyncExternalStore((l) => (listeners.add(l), () => listeners.delete(l)), keyStatus);
}
