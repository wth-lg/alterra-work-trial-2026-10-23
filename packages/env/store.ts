// Typed in-memory FHIR R4 store (design section 2, "Store"): resource type -> id -> resource,
// in insertion order. Every resource it holds is its own deeply frozen copy, so reads hand out
// the stored object and no caller can change state except through put(). A resource is
// admitted only if it has an exact JSON form (packages/env/hash.ts) and every value a date
// search parameter reads parses, so nothing stored can break the hash or a query later.
//
// There is no clear() and no delete: every trial builds a fresh store from the world bytes
// (packages/env/fixture-source.ts), so nothing can be left behind by forgetting a reset.
import type { Resource } from '@medplum/fhirtypes';
import { canonicalJson } from './hash.ts';
import { checkDates, search, type SearchQuery, type SearchResult } from './search.ts';

// Re-exported so apps/web, which does not depend on @medplum/fhirtypes, can name the type.
export type { Resource };

// Freezes every level, including below an object that is already frozen.
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

// The frozen copy the store keeps, after checking it can be hashed and searched.
function admit(resource: Resource, type: string, id: string): Readonly<Resource> {
  const copy = structuredClone(resource);
  try {
    canonicalJson(copy);
  } catch (e) {
    throw new Error(`${type}/${id}: ${(e as Error).message}`, { cause: e });
  }
  checkDates(copy);
  return deepFreeze(copy);
}

function key(resource: Resource): [string, string] {
  const { resourceType, id } = resource as { resourceType?: unknown; id?: unknown };
  if (typeof resourceType !== 'string' || resourceType === '') throw new Error('resource has no resourceType');
  if (typeof id !== 'string' || id === '') throw new Error(`${resourceType} has no id`);
  return [resourceType, id];
}

export class Store {
  readonly #byType = new Map<string, Map<string, Readonly<Resource>>>();
  #size = 0;

  // Stores a frozen copy of each resource; the caller's objects are never frozen or shared.
  // A duplicate (resourceType, id) is an error: a world never holds two versions of a resource.
  constructor(resources: Iterable<Resource>) {
    for (const resource of resources) {
      const [type, id] = key(resource);
      if (this.#byType.get(type)?.has(id)) throw new Error(`duplicate resource ${type}/${id}`);
      this.#set(type, id, admit(resource, type, id));
    }
  }

  #set(type: string, id: string, resource: Readonly<Resource>): void {
    let ofType = this.#byType.get(type);
    if (!ofType) this.#byType.set(type, (ofType = new Map()));
    if (!ofType.has(id)) this.#size++;
    // Map.set on an existing key keeps its position, so a replaced resource keeps its place.
    ofType.set(id, resource);
  }

  get size(): number {
    return this.#size;
  }

  get<T extends Resource = Resource>(resourceType: string, id: string): Readonly<T> | undefined {
    return this.#byType.get(resourceType)?.get(id) as Readonly<T> | undefined;
  }

  // Creates or replaces a resource. The store keeps a frozen copy, not the argument.
  put(resource: Resource): void {
    const [type, id] = key(resource);
    this.#set(type, id, admit(resource, type, id));
  }

  // Every resource, grouped by type in first-insertion order.
  *resources(): IterableIterator<Readonly<Resource>> {
    for (const ofType of this.#byType.values()) yield* ofType.values();
  }

  search<T extends Resource = Resource>(resourceType: string, query: SearchQuery): SearchResult<T> {
    const ofType = this.#byType.get(resourceType)?.values() ?? [];
    return search(ofType as Iterable<Readonly<T>>, resourceType, query);
  }
}
