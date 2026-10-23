// Canonical state hash (design section 2, "Reset and state hash"): SHA-256 over the RFC 8785
// (JCS) canonical JSON of every resource, sorted by (resourceType, id), with each resource's
// top-level meta removed. meta holds versionId and lastUpdated, which a server may set from
// the wall clock; a contained resource's meta is part of its parent's content and stays.
//
// Numbers are canonical because JSON.parse already made them doubles (25.0 and 25 are the
// same double) and JCS serializes a double the way ECMAScript does (-0 as 0, 1e21 as 1e+21).
// crypto.subtle is the one SHA-256 both runtimes provide, so the hash is the same in Node and
// the browser.
import type { Resource } from '@medplum/fhirtypes';

// In a u-mode regex, \p{Cs} matches only surrogates that are not part of a pair.
const LONE_SURROGATE = /\p{Cs}/u;

function str(s: string): string {
  if (LONE_SURROGATE.test(s)) throw new Error('canonical JSON: lone surrogate in a string');
  // JSON.stringify escapes exactly what RFC 8785 section 3.2.2.2 requires.
  return JSON.stringify(s);
}

// RFC 8785 canonical JSON. Refuses anything without one exact JSON form (NaN, Infinity,
// bigint, undefined in an array, class instances) instead of coercing it. Object members whose
// value is undefined are dropped, as JSON.stringify drops them.
export function canonicalJson(value: unknown): string {
  switch (typeof value) {
    case 'string':
      return str(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`canonical JSON: ${value} has no JSON form`);
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'object': {
      if (value === null) return 'null';
      if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) throw new Error('canonical JSON: not a plain object');
      const obj = value as Record<string, unknown>;
      // The default sort compares UTF-16 code units, the order RFC 8785 section 3.2.3 requires.
      const members = Object.keys(obj)
        .sort()
        .filter((k) => obj[k] !== undefined)
        .map((k) => `${str(k)}:${canonicalJson(obj[k])}`);
      return `{${members.join(',')}}`;
    }
    default:
      throw new Error(`canonical JSON: a ${typeof value} has no JSON form`);
  }
}

const byTypeThenId = (a: Resource, b: Resource): number =>
  a.resourceType < b.resourceType ? -1 : a.resourceType > b.resourceType ? 1 : a.id! < b.id! ? -1 : a.id! > b.id! ? 1 : 0;

// The canonical JSON the state hash is taken over: an array of resources without meta.
export function canonicalState(resources: Iterable<Resource>): string {
  const sorted = [...resources].sort(byTypeThenId);
  return `[${sorted.map(({ meta: _meta, ...rest }) => canonicalJson(rest)).join(',')}]`;
}

// Lowercase hex SHA-256 of the UTF-8 bytes of canonicalState(resources).
export async function stateHash(resources: Iterable<Resource>): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalState(resources)));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
