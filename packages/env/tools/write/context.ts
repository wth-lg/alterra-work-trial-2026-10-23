// What the write tools act on: everything the read tools read, a store they may put into, and
// the trial's write session. The session is per trial like the store, so a replay of the tool
// log on a fresh store and a fresh session reproduces every id, stamp and result.
import type { Store } from '../../store.ts';
import { STAFF } from '../../world.ts';
import type { ReadContext } from '../read/context.ts';

export interface WriteSession {
  // Committed writes so far. The n-th committed write is stamped clock.stamp(n), its created
  // resource gets id <prefix>-t<n>, and its Provenance prov-t<n>. A rejected write does not
  // advance it.
  writeSeq: number;
  // The agent's summary from finish; set once, when the episode ends. Its presence is what
  // makes every later write CONFLICT (tool.ts).
  summary?: string;
}

export const newSession = (): WriteSession => ({ writeSeq: 0 });

export interface WriteContext extends ReadContext {
  world: Pick<Store, 'get' | 'search' | 'put'>;
  session: WriteSession;
}

// The signed-in user every write is made as (get_context reports the same practitioner).
export const USER = `Practitioner/${STAFF[0]}`;
