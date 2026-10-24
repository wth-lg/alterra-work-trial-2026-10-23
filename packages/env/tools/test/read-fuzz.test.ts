// Property fuzz over the read tools (plan phase P5): mostly schema-valid calls built from ids,
// codes, names and words that exist in the committed world, plus mutated calls. A read must
// never throw (INTERNAL), never change the state hash, and every success must carry exposure
// tags equal to the ids in its payload, tags that follow the exposure rule (exposure-rule.ts),
// and stay within the 8k-token page cap.
import { readFileSync } from 'node:fs';
import type { DocumentReference, Patient, Resource, Task } from '@medplum/fhirtypes';
import { describe, expect, it } from 'vitest';
import { clock } from '../../clock.ts';
import { parseNdjson } from '../../fixture-source.ts';
import { stateHash } from '../../hash.ts';
import { Store } from '../../store.ts';
import { RESOURCE_TYPES } from '../../world.ts';
import { ERROR_CODES, internalError, ToolError } from '../errors.ts';
import { INBOX_QUEUE_SYSTEM, READ_TOOLS, type CatalogEntry, type Policy, type ReadContext } from '../read/index.ts';
import { approxTokens, callTool, RESULT_TOKEN_CAP, validateInput, type Tool, type ToolResult } from '../registry.ts';
import { ruleViolations } from './exposure-rule.ts';

const root = new URL('../../../../', import.meta.url);
const base = await parseNdjson(readFileSync(new URL('fixtures/world.ndjson.gz', root)));

// The world holds no inbox Tasks, policies or catalog until later phases, so these stand in.
const INBOX: Task[] = ['results', 'messages'].flatMap((queue, q) =>
  [1, 2, 3].map(
    (i): Task => ({
      resourceType: 'Task',
      id: `task-f-${queue}-${i}`,
      status: i === 3 ? 'completed' : 'requested',
      intent: 'order',
      code: { coding: [{ system: INBOX_QUEUE_SYSTEM, code: queue }] },
      focus: { reference: `DiagnosticReport/dr-0001${i}` },
      for: { reference: `Patient/pt-000${i + q}` },
      authoredOn: `2026-10-2${i}T09:00:00-04:00`,
      requester: { reference: `Patient/pt-000${i + q}` },
      description: `${queue} item ${i}`,
    }),
  ),
);
const POLICIES: Policy[] = ['RBC-PHARM-07', 'RBC-RAD-05', 'RBC-TOC-02'].map((id, i) => ({
  id,
  title: `Policy ${id}`,
  version: String(i + 1),
  effective: '2026-01-01',
  source: 'environment-local',
  text: `Policy ${id} text. `.repeat(20),
}));
const CATALOG: CatalogEntry[] = [
  { kind: 'medication', code: '860975', system: 'http://www.nlm.nih.gov/research/umls/rxnorm', display: 'metformin hydrochloride 500 MG Oral Tablet', strengths: ['500 mg'] },
  { kind: 'medication', code: '197361', system: 'http://www.nlm.nih.gov/research/umls/rxnorm', display: 'amlodipine 5 MG Oral Tablet', strengths: ['5 mg'] },
  { kind: 'lab', code: '2160-0', system: 'http://loinc.org', display: 'Creatinine [Mass/volume] in Serum or Plasma' },
  { kind: 'lab', code: '4548-4', system: 'http://loinc.org', display: 'Hemoglobin A1c/Hemoglobin.total in Blood' },
  { kind: 'imaging', code: 'IMG-CT-CHEST-WO', system: 'urn:riverbend:orders', display: 'CT chest without contrast' },
  { kind: 'referral', code: 'REF-GI', system: 'urn:riverbend:orders', display: 'Referral to gastroenterology' },
];

// mulberry32: a seeded generator, so a failing call can be reproduced from its index.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- pools of real values from the world ----

const idsByType = new Map<string, string[]>();
const codesByType = new Map<string, string[]>();
const categoriesByType = new Map<string, string[]>();
const statusesByType = new Map<string, string[]>();
const add = (m: Map<string, string[]>, k: string, v: string) => {
  const list = m.get(k) ?? [];
  if (!list.includes(v)) list.push(v);
  m.set(k, list);
};
const codings = (cc: unknown): Array<{ system?: string; code?: string }> =>
  (Array.isArray(cc) ? cc : [cc]).flatMap((c) => ((c as { coding?: Array<{ system?: string; code?: string }> } | undefined)?.coding ?? []));
for (const r of [...base, ...INBOX] as Array<Resource & Record<string, unknown>>) {
  add(idsByType, r.resourceType, r.id!);
  for (const c of codings(r.code ?? r.medicationCodeableConcept)) {
    if (c.code) add(codesByType, r.resourceType, c.code);
    if (c.code && c.system) add(codesByType, r.resourceType, `${c.system}|${c.code}`);
  }
  for (const c of codings(r.category)) if (c.code) add(categoriesByType, r.resourceType, c.code);
  if (typeof r.status === 'string') add(statusesByType, r.resourceType, r.status);
}
const patients = base.filter((r): r is Patient => r.resourceType === 'Patient');
const names = patients.flatMap((p) => [p.name?.[0]?.family ?? '', ...(p.name?.[0]?.given ?? [])]).filter(Boolean);
const mrns = patients.map((p) => p.identifier?.[0]?.value ?? '').filter(Boolean);
const birthdates = patients.map((p) => p.birthDate!);
const noteWords = [
  ...new Set(
    base
      .filter((r): r is DocumentReference => r.resourceType === 'DocumentReference')
      .slice(0, 40)
      .flatMap((d) => atob(d.content[0]!.attachment.data!).toLowerCase().match(/[a-z]{4,}/g) ?? []),
  ),
];
const noteTypes = ['history-and-physical-note', 'evaluation-plan-note', '34117-2', 'discharge-summary', 'clinical-note'];
const catalogWords = CATALOG.flatMap((c) => c.display.toLowerCase().split(/\s+/));
const TASK_STATUSES = ['requested', 'accepted', 'in-progress', 'completed', 'cancelled'];

type Input = Record<string, unknown>;

function generators(r: () => number) {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const maybe = (p: number) => r() < p;
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const day = () => `${int(2019, 2026)}-${String(int(1, 12)).padStart(2, '0')}-${String(int(1, 28)).padStart(2, '0')}`;
  const patient = () => (maybe(0.1) ? `Patient/${pick(patients).id}` : pick(patients).id!);
  const page = (input: Input, max: number) => {
    if (maybe(0.4)) input.count = int(1, max);
    if (maybe(0.3)) input.offset = int(0, 120);
    return input;
  };
  const expr = (depth: number): string => {
    if (depth <= 0 || maybe(0.3)) return maybe(0.5) ? String(int(0, 300)) : (r() * 200).toFixed(int(1, 3));
    switch (int(0, 6)) {
      case 0:
        return `${expr(depth - 1)} ${pick(['+', '-', '*', '/'])} ${expr(depth - 1)}`;
      case 1:
        return `(${expr(depth - 1)})`;
      case 2:
        return `-${expr(depth - 1)}`;
      case 3:
        return `${expr(depth - 1)} ^ ${int(0, 3)}`;
      case 4:
        return `${pick(['ln', 'log', 'exp', 'sqrt', 'abs'])}(${expr(depth - 1)})`;
      case 5:
        return `${pick(['min', 'max'])}(${expr(depth - 1)}, ${expr(depth - 1)})`;
      default:
        return `round(${expr(depth - 1)}, ${int(0, 4)})`;
    }
  };
  const gens: Record<string, () => Input> = {
    get_context: () => ({}),
    search_patients: () => {
      const input: Input = {};
      if (maybe(0.5)) input.name = maybe(0.3) ? `${pick(names)} ${pick(names)}` : pick(names);
      if (maybe(0.3)) input.birthdate = pick(birthdates);
      if (maybe(0.3)) input.mrn = pick(mrns);
      return page(input, 50);
    },
    fhir_search: () => {
      const type = pick(RESOURCE_TYPES);
      const input: Input = { resource_type: type };
      if (maybe(0.6)) input.patient = patient();
      if (maybe(0.3) && codesByType.has(type)) input.code = pick(codesByType.get(type)!);
      if (maybe(0.2) && categoriesByType.has(type)) input.category = pick(categoriesByType.get(type)!);
      if (maybe(0.2) && statusesByType.has(type)) input.status = pick(statusesByType.get(type)!);
      if (maybe(0.25)) input.date_ge = day();
      if (maybe(0.25)) input.date_le = maybe(0.2) ? `${day()}T12:00:00-04:00` : day();
      if (maybe(0.3)) input.sort = pick(['date', '-date']);
      return page(input, 50);
    },
    fhir_read: () => {
      const type = pick([...idsByType.keys()]);
      return { resource_type: type, id: maybe(0.1) ? `${pick(idsByType.get(type)!)}9` : pick(idsByType.get(type)!) };
    },
    search_notes: () => {
      const input: Input = { query: Array.from({ length: int(1, 3) }, () => pick(noteWords)).join(' ') };
      if (maybe(0.5)) input.patient = patient();
      if (maybe(0.2)) input.date_ge = day();
      if (maybe(0.2)) input.date_le = day();
      if (maybe(0.2)) input.type = pick(noteTypes);
      return page(input, 20);
    },
    read_policy: () => (maybe(0.3) ? page({}, 50) : { policy_id: maybe(0.1) ? 'RBC-NONE-01' : pick(POLICIES).id }),
    lookup_catalog: () => page({ query: pick(catalogWords), kind: pick(['medication', 'lab', 'imaging', 'referral']) }, 50),
    list_inbox: () => {
      const input: Input = { queue: pick(['results', 'messages']) };
      if (maybe(0.4)) input.status = pick(TASK_STATUSES);
      return page(input, 50);
    },
    calculate: () => ({ expression: expr(int(1, 5)) }),
  };
  // One schema-breaking or semantic edit, so error paths are fuzzed too.
  const mutate = (input: Input): unknown => {
    const keys = Object.keys(input);
    const key = keys.length > 0 ? pick(keys) : 'x';
    const junk = pick<unknown>([null, 42, -1, 1.5, 'x'.repeat(5000), '', '\u0000\ud800', [], {}, true, 'Patient/../../etc', "'; DROP TABLE"]);
    switch (int(0, 5)) {
      case 0:
        return { ...input, [key]: junk };
      case 1: {
        const { [key]: _drop, ...rest } = input;
        return rest;
      }
      case 2:
        return { ...input, [pick(['extra', '__proto__', 'constructor', 'count'])]: junk };
      case 3:
        return pick([null, [], 'get_context', 7, [input]]);
      case 4:
        return { ...input, count: pick([0, 51, 1e9, -3, 2.5, '10']) };
      default:
        return { ...input, offset: pick([-1, 1e12, 0.5, '0']) };
    }
  };
  return { gens, mutate, maybe };
}

const KINDS = [...RESOURCE_TYPES, 'Policy'];
const REF = new RegExp(`^(${KINDS.join('|')})/[A-Za-z0-9.-]{1,64}$`);
// Written apart from the registry's walker: a JSON.parse reviver visits every value once.
function payloadIds(content: unknown): { exposed: string[]; referenced: string[] } {
  const exposed = new Set<string>();
  const refs = new Set<string>();
  JSON.parse(JSON.stringify(content), (_k, v: unknown) => {
    if (typeof v === 'string' && REF.test(v)) refs.add(v);
    else if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const { resourceType, id } = v as { resourceType?: unknown; id?: unknown };
      // A resource whose note text was left out (an attachment naming read_with) is referenced.
      if (typeof resourceType === 'string' && typeof id === 'string') (JSON.stringify(v).includes('"read_with":') ? refs : exposed).add(`${resourceType}/${id}`);
    }
    return v;
  });
  return { exposed: [...exposed].sort(), referenced: [...refs].filter((x) => !exposed.has(x)).sort() };
}

interface Stats {
  calls: number;
  schemaValid: number;
  internal: number;
  hashChanges: number;
  perTool: Record<string, { calls: number; valid: number; ok: number; exposed: number; referenced: number; errors: Record<string, number> }>;
  defects: string[];
  firstInternal: string[];
}

async function fuzz(tools: readonly Tool<ReadContext>[], perTool: number, seed: number): Promise<Stats> {
  const store = new Store([...base, ...INBOX]);
  const ctx: ReadContext = { world: store, clock, policies: POLICIES, catalog: CATALOG };
  const initial = await stateHash(store.resources());
  const r = rng(seed);
  const { gens, mutate, maybe } = generators(r);
  const stats: Stats = { calls: 0, schemaValid: 0, internal: 0, hashChanges: 0, perTool: {}, defects: [], firstInternal: [] };
  const defect = (s: string) => stats.defects.length < 20 && stats.defects.push(s);
  const plan = tools.flatMap((t) => Array.from({ length: perTool }, () => t.name));
  // Interleave tools so state left behind by one call would show up in the next.
  for (let i = plan.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [plan[i], plan[j]] = [plan[j]!, plan[i]!];
  }
  for (const [n, name] of plan.entries()) {
    const tool = tools.find((t) => t.name === name)!;
    const input = maybe(0.25) ? mutate(gens[name]!()) : gens[name]!();
    const s = (stats.perTool[name] ??= { calls: 0, valid: 0, ok: 0, exposed: 0, referenced: 0, errors: {} });
    s.calls++;
    stats.calls++;
    if (validateInput(tool.inputSchema, input) === undefined) {
      s.valid++;
      stats.schemaValid++;
    }
    let result: ToolResult;
    try {
      result = callTool(tools, name, input, ctx);
    } catch (e) {
      stats.internal++;
      s.errors.INTERNAL = (s.errors.INTERNAL ?? 0) + 1;
      if (stats.firstInternal.length < 5) stats.firstInternal.push(`#${n} ${name} ${JSON.stringify(input)?.slice(0, 200)}: ${internalError(e).error.message}`);
      continue;
    }
    if (result.is_error) {
      const code = (result.content as { error: { code: string } }).error.code;
      s.errors[code] = (s.errors[code] ?? 0) + 1;
      if (code === 'INTERNAL') stats.internal++;
      if (!(ERROR_CODES as readonly string[]).includes(code)) defect(`#${n} ${name}: unknown error code ${code}`);
      if (result.exposed_ids.length + result.referenced_ids.length > 0) defect(`#${n} ${name}: an error carries ids`);
    } else {
      s.ok++;
      const { exposed, referenced } = payloadIds(result.content);
      s.exposed += exposed.length;
      s.referenced += referenced.length;
      if (JSON.stringify(exposed) !== JSON.stringify(result.exposed_ids)) defect(`#${n} ${name}: exposed_ids ${result.exposed_ids} != payload ${exposed}`);
      if (JSON.stringify(referenced) !== JSON.stringify(result.referenced_ids)) defect(`#${n} ${name}: referenced_ids differ from payload`);
      for (const v of ruleViolations(result, (key) => store.get(key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)))) defect(`#${n} ${name}: ${v}`);
      for (const id of exposed) {
        const [type, rid] = id.split('/') as [string, string];
        if (type === 'Policy' ? !POLICIES.some((p) => p.id === rid) : !store.get(type, rid)) defect(`#${n} ${name}: exposed ${id} is not in the world`);
      }
      if (approxTokens(JSON.stringify(result.content)) > RESULT_TOKEN_CAP) defect(`#${n} ${name}: result over the cap`);
      // Same input, same bytes: reads are pure.
      if (n % 10 === 0 && JSON.stringify(callTool(tools, name, input, ctx)) !== JSON.stringify(result)) defect(`#${n} ${name}: not deterministic`);
    }
    if ((n + 1) % 1000 === 0 && (await stateHash(store.resources())) !== initial) stats.hashChanges++;
  }
  if ((await stateHash(store.resources())) !== initial) stats.hashChanges++;
  return stats;
}

const PER_TOOL = 1150;

// Straight to stdout: vitest's default reporter hides console output from passing tests, and
// the gate command reads these counters.
const print = (line: string) => process.stdout.write(`${line}\n`);

describe('read tool fuzz', () => {
  it(`${PER_TOOL * READ_TOOLS.length} calls: no INTERNAL, no hash change, exposure matches every payload`, async () => {
    const stats = await fuzz(READ_TOOLS, PER_TOOL, 20261023);
    const pct = ((100 * stats.schemaValid) / stats.calls).toFixed(1);
    print(`fuzz: calls=${stats.calls} schema_valid=${stats.schemaValid} (${pct}%) INTERNAL=${stats.internal} hash_changes=${stats.hashChanges} defects=${stats.defects.length}`);
    for (const [name, s] of Object.entries(stats.perTool)) {
      print(`  ${name.padEnd(15)} calls=${s.calls} valid=${s.valid} ok=${s.ok} exposed_ids_checked=${s.exposed} referenced_ids_checked=${s.referenced} errors=${JSON.stringify(s.errors)}`);
    }
    for (const line of [...stats.firstInternal, ...stats.defects]) print(`  ! ${line}`);
    expect(stats.calls).toBeGreaterThanOrEqual(10_000);
    expect(stats.schemaValid / stats.calls).toBeGreaterThanOrEqual(0.5);
    for (const s of Object.values(stats.perTool)) expect(s.valid).toBeGreaterThanOrEqual(500);
    expect(stats.internal).toBe(0);
    expect(stats.hashChanges).toBe(0);
    expect(stats.defects).toEqual([]);
  });

  // The planted fhir_read throws on every call that passes its schema, whatever the world holds,
  // so INTERNAL is exactly the schema-valid fhir_read calls (a world regen cannot zero it).
  it('counts INTERNAL when a tool throws', async () => {
    const broken = READ_TOOLS.map((t) =>
      t.name !== 'fhir_read'
        ? t
        : {
            ...t,
            run: () => {
              throw new TypeError('planted');
            },
          },
    );
    const stats = await fuzz(broken, 60, 7);
    const valid = stats.perTool.fhir_read!.valid;
    print(`planted throw in fhir_read: INTERNAL=${stats.internal} fhir_read schema_valid=${valid}`);
    expect(valid).toBeGreaterThanOrEqual(1);
    expect(stats.internal).toBe(valid);
    expect(stats.perTool.fhir_read!.errors.INTERNAL).toBe(valid);
  });

  it('a ToolError thrown by a tool is a typed error result, not INTERNAL', () => {
    const tools = [{ name: 'boom', description: 'test tool', inputSchema: { type: 'object' as const, properties: {}, additionalProperties: false as const }, run: () => { throw new ToolError('CONFLICT', 'no'); } }];
    expect(callTool(tools, 'boom', {}, undefined)).toEqual({ is_error: true, content: { error: { code: 'CONFLICT', message: 'no' } }, exposed_ids: [], referenced_ids: [] });
  });
});
