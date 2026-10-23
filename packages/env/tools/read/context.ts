// What the read tools read from: the trial's world, the pinned clock, and the clinic's
// policies and catalog. Policies and the catalog are not FHIR resources; the task packages and
// the catalog module supply them, so the tools take them as plain records.
import type { Clock } from '../../clock.ts';
import type { WorldReader } from '../../overlay.ts';

// A local policy document (design section 2, "Policies").
export interface Policy {
  id: string;
  title: string;
  version: string;
  // The date it took effect, YYYY-MM-DD.
  effective: string;
  // Where its content comes from: a verified label or eCQM, or environment-local.
  source: string;
  text: string;
}

export const CATALOG_KINDS = ['medication', 'lab', 'imaging', 'referral'] as const;

// One orderable: a formulary drug (RxNorm) or an order-catalog entry.
export interface CatalogEntry {
  kind: (typeof CATALOG_KINDS)[number];
  code: string;
  system: string;
  display: string;
  strengths?: readonly string[];
}

// Inbox items are Tasks whose code names their queue in this system.
export const INBOX_QUEUE_SYSTEM = 'urn:riverbend:inbox-queue';
export const INBOX_QUEUES = ['results', 'messages'] as const;

export interface ReadContext {
  world: Pick<WorldReader, 'get' | 'search'>;
  clock: Clock;
  policies: readonly Policy[];
  catalog: readonly CatalogEntry[];
}
