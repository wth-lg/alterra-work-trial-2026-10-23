// The read tools (plan phase P5), in the order the model sees them. None writes to the world.
import type { Tool } from '../registry.ts';
import { calculate } from './calculate.ts';
import { lookupCatalog } from './catalog.ts';
import type { ReadContext } from './context.ts';
import { fhirRead, fhirSearch } from './fhir.ts';
import { getContext } from './get-context.ts';
import { listInbox } from './inbox.ts';
import { searchNotes } from './notes.ts';
import { searchPatients } from './patients.ts';
import { readPolicy } from './policy.ts';

export { CATALOG_KINDS, INBOX_QUEUE_SYSTEM, INBOX_QUEUES, type CatalogEntry, type Policy, type ReadContext } from './context.ts';

export const READ_TOOLS: readonly Tool<ReadContext>[] = [
  getContext,
  searchPatients,
  fhirSearch,
  fhirRead,
  searchNotes,
  readPolicy,
  lookupCatalog,
  listInbox,
  calculate,
];
