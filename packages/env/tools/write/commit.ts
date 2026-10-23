// Validation steps 4 and 5 and the commit (design section 2, "Write validation"). A write tool
// checks its input (steps 1-3) and then calls commit with a builder; commit allocates the
// write's sequence number, id tag and stamp, validates every resource with Medplum, checks the
// invariants, and only then puts the resources and the write's Provenance into the store.
// Nothing is put and the sequence does not advance unless every check passes, so a rejected
// write leaves the store, the hash and the next id unchanged.
//
// A failure is the model's only when it traces to an input field: a builder lists, per
// resource, the FHIR paths each input string was written to. Any other failure means the
// environment built an invalid resource or a dangling reference from valid input; that is
// thrown as a plain Error, which the loop records as INTERNAL (errors.ts).
import type { Provenance, Resource } from '@medplum/fhirtypes';
import { Store } from '../../store.ts';
import { validate } from '../../validate.ts';
import { RESOURCE_TYPES } from '../../world.ts';
import { ToolError } from '../errors.ts';
import { Committed } from '../registry.ts';
import { key } from './checks.ts';
import { USER, type WriteContext } from './context.ts';

export interface Allocation {
  seq: number;
  // NOW + seq seconds.
  stamp: string;
  // The id of the resource this write creates: <prefix>-t<seq, 4 digits>.
  id(prefix: string): string;
}

export interface Written {
  resource: Resource;
  // Whether the write creates the resource (true) or replaces one in the store (false).
  created: boolean;
  // Input field -> the FHIR paths of this resource its value was written to.
  fields?: Readonly<Record<string, readonly string[]>>;
}

export interface Draft {
  // The result payload the model sees.
  content: unknown;
  resources: readonly Written[];
  // References the write was based on, recorded as Provenance.entity with role source.
  sources?: readonly string[];
}

const tag = (seq: number) => `t${String(seq).padStart(4, '0')}`;

// The input field whose value an invalid path came from, or undefined.
function fieldFor(path: string, fields: Written['fields']): string | undefined {
  let best: [string, number] | undefined;
  for (const [field, paths] of Object.entries(fields ?? {})) {
    for (const p of paths) {
      const hit = path === p || path.startsWith(`${p}.`) || path.startsWith(`${p}[`);
      if (hit && (!best || p.length > best[1])) best = [field, p.length];
    }
  }
  return best?.[0];
}

// Every reference string in a resource, at any depth.
function references(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const v of value) references(v, out);
  else if (value !== null && typeof value === 'object') {
    const r = (value as { reference?: unknown }).reference;
    if (typeof r === 'string') out.push(r);
    for (const v of Object.values(value)) references(v, out);
  }
  return out;
}

export function commit(ctx: WriteContext, tool: string, build: (a: Allocation) => Draft): Committed {
  const seq = ctx.session.writeSeq + 1;
  const stamp = ctx.clock.stamp(seq);
  const draft = build({ seq, stamp, id: (prefix) => `${prefix}-${tag(seq)}` });

  const provenance: Provenance = {
    resourceType: 'Provenance',
    id: `prov-${tag(seq)}`,
    target: draft.resources.map((w) => key(w.resource)).sort().map((reference) => ({ reference })),
    recorded: stamp,
    activity: {
      coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-DataOperation', code: draft.resources.some((w) => w.created) ? 'CREATE' : 'UPDATE' }],
      text: tool,
    },
    agent: [{ type: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/provenance-participant-type', code: 'author' }] }, who: { reference: USER } }],
    ...(draft.sources?.length ? { entity: draft.sources.map((reference) => ({ role: 'source' as const, what: { reference } })) } : {}),
  };
  const all: Written[] = [...draft.resources, { resource: provenance, created: true }];

  // Step 4: Medplum validateResource.
  for (const w of all) {
    const invalid = validate(w.resource);
    if (!invalid) continue;
    const field = fieldFor(invalid.path, w.fields);
    if (field === undefined) throw new Error(`${tool}: built an invalid ${key(w.resource)}: ${invalid.message} (${invalid.path})`);
    throw new ToolError('INVALID_INPUT', `'${field}' is not valid FHIR: ${invalid.message}`, field);
  }

  // Step 5: invariants. Ids are fresh or existing as declared, and no reference dangles.
  const keys = all.map((w) => key(w.resource));
  if (new Set(keys).size !== keys.length) throw new Error(`${tool}: one write puts the same resource twice (${keys.join(', ')})`);
  for (const w of all) {
    const exists = ctx.world.get(w.resource.resourceType, w.resource.id!) !== undefined;
    if (w.created && exists) throw new Error(`${tool}: ${key(w.resource)} is already in the store`);
    if (!w.created && !exists) throw new Error(`${tool}: updates ${key(w.resource)}, which is not in the store`);
  }
  for (const w of all) {
    for (const r of references(w.resource)) {
      const [type, id] = r.split('/');
      const known = (RESOURCE_TYPES as readonly string[]).includes(type!) && id !== undefined && r.split('/').length === 2;
      if (!known || (!keys.includes(r) && ctx.world.get(type!, id!) === undefined)) throw new Error(`${tool}: dangling reference ${r} in ${key(w.resource)}`);
    }
  }
  // The store admits only resources it can hash and search; a scratch store runs the same
  // admission first, so the puts below cannot fail halfway.
  new Store(all.map((w) => w.resource));

  for (const w of all) ctx.world.put(w.resource);
  ctx.session.writeSeq = seq;
  return new Committed(draft.content, keys);
}
