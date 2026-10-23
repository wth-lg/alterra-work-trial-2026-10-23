// Seeded generator of a synthetic R4 world for tests: the Medplum differential test and the
// browser state-hash spec. The same seed and count always give the same resources in the
// same order, in Node and in the browser.
//
// Every date the search parameters read is a day ('2026-10-01') or a UTC second
// ('2026-10-01T13:05:09Z', hour 01-23), and every Encounter and EpisodeOfCare has a period
// with a unique start. Within those forms Medplum MemoryRepository's _sort (a string compare
// of the JSON values) agrees with our chronological sort; see packages/env/search.ts.
import type { Resource } from '../../../../packages/env/store.ts';

const DAY = 86_400_000;
// 2020-11-01, six years before the world clock.
const START_MS = Date.UTC(2020, 10, 1);
const SPAN_DAYS = 6 * 365;

const LOINC = 'http://loinc.org';
const SNOMED = 'http://snomed.info/sct';
const RXNORM = 'http://www.nlm.nih.gov/research/umls/rxnorm';
const OBS_CATEGORY = 'http://terminology.hl7.org/CodeSystem/observation-category';
const CONDITION_CATEGORY = 'http://terminology.hl7.org/CodeSystem/condition-category';
const DR_CATEGORY = 'http://terminology.hl7.org/CodeSystem/v2-0074';
const LOCAL = 'urn:riverbend:local';

// Display strings never equal a code: Medplum's in-memory matcher also matches token
// searches against display and text, which we do not (FHIR token search matches codes).
const LABS: Array<[string, string, string]> = [
  ['2160-0', 'Creatinine [Mass/volume] in Serum or Plasma', 'mg/dL'],
  ['33914-3', 'eGFR (MDRD) per 1.73 sq M', 'mL/min'],
  ['2823-3', 'Potassium [Moles/volume] in Serum or Plasma', 'mmol/L'],
  ['29463-7', 'Body weight', 'kg'],
  ['4548-4', 'Hemoglobin A1c/Hemoglobin.total in Blood', '%'],
  ['2093-3', 'Cholesterol [Mass/volume] in Serum or Plasma', 'mg/dL'],
];
const CONDITIONS: Array<[string, string]> = [
  ['44054006', 'Diabetes mellitus type 2 (disorder)'],
  ['38341003', 'Hypertensive disorder, systemic arterial (disorder)'],
  ['431855005', 'Chronic kidney disease stage 1 (disorder)'],
  ['195967001', 'Asthma (disorder)'],
];
const MEDS: Array<[string, string]> = [
  ['860975', 'metformin hydrochloride 500 MG Oral Tablet'],
  ['314076', 'lisinopril 10 MG Oral Tablet'],
  ['197361', 'amlodipine 5 MG Oral Tablet'],
  ['310798', 'hydrochlorothiazide 25 MG Oral Tablet'],
];
const PROCEDURES: Array<[string, string]> = [
  ['73761001', 'Colonoscopy (procedure)'],
  ['76601001', 'Intramuscular injection (procedure)'],
];
const ORDERS: Array<[string, string]> = [
  ['CT-ABD-CON', 'CT abdomen with contrast'],
  ['LAB-BMP', 'Basic metabolic panel order'],
  ['REF-GI', 'Referral to gastroenterology'],
];
const GIVEN = ['Maya', 'Zoë', 'José', 'Ngọc', 'Søren', 'Aoife', '美玲', 'Daniel', 'Jordan'];
const FAMILY = ['Okafor', 'Muñoz', 'Nguyễn', 'Ødegaard', 'Lin', "O'Brien", 'Reyes', '山田'];

type Rng = { next(): number; int(n: number): number; pick<T>(xs: readonly T[]): T; chance(p: number): boolean };

// mulberry32: small, fast and identical in every JS engine.
export function rng(seed: number): Rng {
  let a = seed >>> 0;
  const next = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number): number => Math.floor(next() * n);
  return { next, int, pick: (xs) => xs[int(xs.length)]!, chance: (p) => next() < p };
}

const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');
const day = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

const coding = (system: string, code: string, display?: string) => ({ system, code, ...(display ? { display } : {}) });

export function generateWorld(seed: number, count: number): Resource[] {
  const r = rng(seed);
  const out: Resource[] = [];
  const seq = new Map<string, number>();
  const id = (prefix: string): string => {
    const n = (seq.get(prefix) ?? 0) + 1;
    seq.set(prefix, n);
    return `${prefix}-${String(n).padStart(4, '0')}`;
  };
  // A random instant on a whole second, hour 01-23 UTC, so it never ties with a bare day.
  const instant = (): number => START_MS + r.int(SPAN_DAYS) * DAY + (1 + r.int(23)) * 3_600_000 + r.int(3600) * 1000;
  // Day or second precision, chosen at random.
  const when = (): string => (r.chance(0.3) ? day(instant()) : iso(instant()));
  let periodStart = START_MS + 3_600_000;
  // Unique, increasing starts, so no two periods tie on start.
  const period = (): { start: string; end?: string } => {
    periodStart += (1 + r.int(72)) * 3_600_000 + r.int(3600) * 1000;
    const start = r.chance(0.2) ? day(periodStart) : iso(periodStart);
    if (r.chance(0.15)) return { start };
    const endMs = periodStart + (1 + r.int(96)) * 3_600_000;
    return { start, end: r.chance(0.3) ? day(endMs) : iso(endMs) };
  };

  out.push(
    { resourceType: 'Organization', id: 'org-riverbend', name: 'Riverbend Family Medicine' },
    { resourceType: 'Practitioner', id: 'pr-okafor', name: [{ given: ['Maya'], family: 'Okafor' }] },
    { resourceType: 'Practitioner', id: 'pr-lin', name: [{ given: ['Daniel'], family: 'Lin' }] },
  );
  const patients: string[] = [];
  const nPatients = Math.max(4, Math.round(count / 25));
  for (let i = 0; i < nPatients; i++) {
    const pid = id('pt');
    patients.push(pid);
    out.push({
      resourceType: 'Patient',
      id: pid,
      name: [{ given: [r.pick(GIVEN)], family: r.pick(FAMILY) }],
      gender: r.pick(['female', 'male', 'other'] as const),
      birthDate: day(Date.UTC(1940, 0, 1) + r.int(60 * 365) * DAY),
    });
  }
  const group: Resource = { resourceType: 'Group', id: 'grp-crc-panel', type: 'person', actual: true, code: { coding: [coding(LOCAL, 'panel-crc', 'CRC outreach panel')] } };
  out.push(group);
  const encounters: Array<[string, string]> = [];

  const makers: Array<(pid: string) => Resource> = [
    (pid) => {
      const [code, display, unit] = r.pick(LABS);
      // A few labs have no system or no date, so |code searches and missing dates are exercised.
      const noSystem = r.chance(0.08);
      const effective = r.chance(0.07) ? {} : r.chance(0.1) ? { effectiveInstant: iso(instant()) } : { effectiveDateTime: when() };
      return {
        resourceType: 'Observation',
        id: id('obs'),
        status: r.pick(['final', 'final', 'final', 'amended', 'preliminary', 'cancelled'] as const),
        category: [{ coding: [coding(OBS_CATEGORY, r.chance(0.85) ? 'laboratory' : 'vital-signs')] }],
        code: { coding: [noSystem ? { code, display } : coding(LOINC, code, display)] },
        // Some observations belong to the panel group, so subject and patient differ.
        subject: { reference: r.chance(0.05) ? `Group/${group.id}` : `Patient/${pid}` },
        ...effective,
        valueQuantity: { value: Math.round(r.next() * 2000) / 10, unit },
      };
    },
    (pid) => {
      const [code, display] = r.pick(CONDITIONS);
      return {
        resourceType: 'Condition',
        id: id('cond'),
        category: [{ coding: [coding(CONDITION_CATEGORY, r.chance(0.7) ? 'problem-list-item' : 'encounter-diagnosis')] }],
        code: { coding: [coding(SNOMED, code, display)] },
        subject: { reference: `Patient/${pid}` },
        onsetDateTime: when(),
      };
    },
    (pid) => {
      const [code, display] = r.pick(MEDS);
      const events = r.chance(0.8) ? { dosageInstruction: [{ text: 'once daily', timing: { event: [when()] } }] } : {};
      return {
        resourceType: 'MedicationRequest',
        id: id('mr'),
        status: r.pick(['active', 'active', 'stopped', 'completed', 'on-hold'] as const),
        intent: 'order',
        category: [{ coding: [coding('http://terminology.hl7.org/CodeSystem/medicationrequest-category', r.pick(['outpatient', 'community']))] }],
        medicationCodeableConcept: { coding: [coding(RXNORM, code, display)] },
        subject: { reference: `Patient/${pid}` },
        authoredOn: when(),
        ...events,
      };
    },
    (pid) => {
      const eid = id('enc');
      encounters.push([eid, pid]);
      return {
        resourceType: 'Encounter',
        id: eid,
        status: r.pick(['finished', 'finished', 'in-progress', 'planned'] as const),
        class: coding('http://terminology.hl7.org/CodeSystem/v3-ActCode', 'AMB'),
        subject: { reference: `Patient/${pid}` },
        period: period(),
      };
    },
    (pid) => ({
      resourceType: 'DiagnosticReport',
      id: id('dr'),
      status: r.pick(['final', 'preliminary', 'amended'] as const),
      category: [{ coding: [coding(DR_CATEGORY, r.pick(['LAB', 'RAD']))] }],
      code: { coding: [coding(LOINC, r.pick(['24323-8', '30746-2', '24627-2']), 'Panel report')] },
      subject: { reference: `Patient/${pid}` },
      effectiveDateTime: when(),
    }),
    (pid) => ({
      resourceType: 'DocumentReference',
      id: id('doc'),
      status: r.pick(['current', 'current', 'superseded'] as const),
      category: [{ coding: [coding('http://hl7.org/fhir/us/core/CodeSystem/us-core-documentreference-category', 'clinical-note')] }],
      subject: { reference: `Patient/${pid}` },
      date: iso(instant()),
      content: [{ attachment: { contentType: 'text/plain', title: 'Discharge summary — St. Brigid Regional' } }],
    }),
    (pid) => {
      const [code, display] = r.pick(MEDS);
      return {
        resourceType: 'AllergyIntolerance',
        id: id('alg'),
        patient: { reference: `Patient/${pid}` },
        category: [r.pick(['medication', 'food', 'environment'] as const)],
        code: { coding: [coding(RXNORM, code, display)] },
        ...(r.chance(0.3) ? { reaction: [{ substance: { coding: [coding(SNOMED, '387207008', 'Ibuprofen (substance)')] }, manifestation: [{ text: 'hives' }] }] } : {}),
        recordedDate: when(),
      };
    },
    (pid) => {
      const [code, display] = r.pick(PROCEDURES);
      return {
        resourceType: 'Procedure',
        id: id('proc'),
        status: r.pick(['completed', 'completed', 'not-done'] as const),
        category: { coding: [coding(SNOMED, '387713003', 'Surgical procedure')] },
        code: { coding: [coding(SNOMED, code, display)] },
        subject: { reference: `Patient/${pid}` },
        performedDateTime: when(),
      };
    },
    (pid) => {
      const [code, display] = r.pick(ORDERS);
      return {
        resourceType: 'ServiceRequest',
        id: id('sr'),
        status: r.pick(['active', 'draft', 'completed', 'revoked'] as const),
        intent: 'order',
        category: [{ coding: [coding(SNOMED, r.pick(['363679005', '108252007']), 'Order category')] }],
        code: { coding: [coding(LOCAL, code, display)] },
        subject: { reference: `Patient/${pid}` },
      };
    },
    (pid) => ({
      resourceType: 'Task',
      id: id('task'),
      status: r.pick(['requested', 'in-progress', 'completed'] as const),
      intent: 'order',
      code: { coding: [coding(LOCAL, r.pick(['inbox-result', 'refill-request', 'callback']), 'Inbox item')] },
      for: { reference: r.chance(0.1) ? `Group/${group.id}` : `Patient/${pid}` },
    }),
    (pid) => ({
      resourceType: 'Communication',
      id: id('comm'),
      status: r.pick(['completed', 'in-progress'] as const),
      category: [{ coding: [coding(LOCAL, r.pick(['patient-message', 'staff-note']), 'Message')] }],
      subject: { reference: `Patient/${pid}` },
      payload: [{ contentString: r.pick(['Can I get a refill?', 'Résumé of visit ✓', 'Dose 2.50 mg — confirm']) }],
    }),
    (pid) => ({
      resourceType: 'Appointment',
      id: id('appt'),
      status: r.pick(['booked', 'fulfilled', 'cancelled'] as const),
      start: iso(instant()),
      participant: [
        { actor: { reference: `Patient/${pid}` }, status: 'accepted' },
        { actor: { reference: 'Practitioner/pr-okafor' }, status: 'accepted' },
      ],
    }),
    (pid) => ({
      resourceType: 'EpisodeOfCare',
      id: id('eoc'),
      status: r.pick(['active', 'finished'] as const),
      patient: { reference: `Patient/${pid}` },
      period: period(),
    }),
    (pid) => ({
      resourceType: 'Provenance',
      id: id('prov'),
      target: [{ reference: `Patient/${pid}` }, ...(encounters.length ? [{ reference: `Encounter/${r.pick(encounters)[0]}` }] : [])],
      recorded: iso(instant()),
      agent: [{ who: { reference: 'Practitioner/pr-okafor' } }],
    }),
  ];
  // Clinical resources dominate a real chart; weights are rough shares of a Synthea export.
  const weights = [30, 8, 8, 10, 5, 4, 3, 4, 4, 5, 4, 4, 2, 3];
  const total = weights.reduce((a, b) => a + b, 0);
  while (out.length < count) {
    let w = r.int(total);
    let k = 0;
    while (w >= weights[k]!) w -= weights[k++]!;
    const resource = makers[k]!(r.pick(patients));
    // A meta block the hash must ignore, as Medplum and the tool layer add one.
    if (r.chance(0.2)) resource.meta = { versionId: String(1 + r.int(9)), lastUpdated: iso(instant()) };
    out.push(resource);
  }
  return out;
}

export const toNdjson = (resources: readonly Resource[]): string => resources.map((x) => JSON.stringify(x)).join('\n') + '\n';
