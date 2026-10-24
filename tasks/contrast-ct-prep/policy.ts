// T5's expected end state, computed from the initial world by RBC-RAD-07 (design section 4,
// "Double derivation"): the patient and the slot the instruction names, the contrast reaction
// §1 makes the risk factor and its severity (§2, §3), the dose times counted back from the scan,
// and whether §4 needs a new creatinine. It never imports expected.ts or overlay constants
// (lint: no-policy-expected-import).
import { eastern, NOW_DATE } from '../../packages/env/clock.ts';
import type { Json } from '../../packages/grader/check.ts';
import type { WorldView } from '../../packages/grader/matrix/types.ts';
import { clinicDate } from '../../packages/grader/normalize.ts';

const NAME = { given: 'Daniel', family: 'Ferreira' };
// The slot the instruction names: Monday 10/26 at 9:00, clinic time.
const SLOT = { date: '2026-10-26', time: '09:00' };
const LOINC = 'http://loinc.org';
const SNOMED = 'http://snomed.info/sct';
const SCR = '2160-0';
// Type 2, type 1 and unspecified diabetes mellitus.
const DIABETES = ['44054006', '46635009', '73211009'];
// Iodinated contrast media (§1): an allergy to one of these is the risk factor.
const IODINATED = ['iohexol', 'iopamidol', 'iodixanol', 'ioversol', 'iopromide', 'iomeprol', 'diatrizoate', 'iothalamate'];
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type Coding = { system?: string; code?: string; display?: string };
type R = Readonly<Record<string, unknown>> & { resourceType: string; id?: string };
type Patient = R & { birthDate?: string; name?: Array<{ use?: string; given?: string[]; family?: string }> };
type Appointment = R & { status?: string; start?: string; participant?: Array<{ actor?: { reference?: string } }> };
type Allergy = R & {
  patient?: { reference?: string };
  clinicalStatus?: { coding?: Coding[] };
  verificationStatus?: { coding?: Coding[] };
  code?: { coding?: Coding[]; text?: string };
  onsetDateTime?: string;
  reaction?: Array<{ severity?: string }>;
};
type Condition = R & { subject?: { reference?: string }; clinicalStatus?: { coding?: Coding[] }; code?: { coding?: Coding[] } };
type Obs = R & { status?: string; subject?: { reference?: string }; code?: { coding?: Coding[] }; effectiveDateTime?: string };
type Doc = R & { subject?: { reference?: string }; date?: string; content?: Array<{ attachment?: { data?: string } }> };

const key = (r: R) => `${r.resourceType}/${r.id}`;
const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function ageOn(birthDate: string, date: string): number {
  const [by, bm, bd] = birthDate.split('-').map(Number) as [number, number, number];
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

function decode(data: string | undefined): string {
  if (data === undefined) return '';
  const binary = atob(data);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

const status = (c: { coding?: Coding[] } | undefined) => c?.coding?.[0]?.code;
const substanceOf = (a: Allergy) => (a.code?.coding?.[0]?.display ?? a.code?.text ?? '').toLowerCase();
const SEVERITY = ['mild', 'moderate', 'severe'];

export function derive(world: WorldView): Json {
  const patients = (world.all('Patient') as readonly Patient[]).filter((p) => (p.name ?? []).some((n) => n.family === NAME.family && (n.given ?? []).includes(NAME.given)));
  if (patients.length !== 1 || !patients[0]!.birthDate) throw new Error(`${patients.length} patients named ${NAME.given} ${NAME.family}`);
  const patient = patients[0]!;
  const ref = key(patient);
  const age = ageOn(patient.birthDate!, NOW_DATE);
  const diabetes = (world.all('Condition') as readonly Condition[]).some(
    (c) => c.subject?.reference === ref && status(c.clinicalStatus) === 'active' && (c.code?.coding ?? []).some((x) => x.system === SNOMED && DIABETES.includes(x.code ?? '')),
  );

  // The booked appointment in the named slot.
  const slots = (world.all('Appointment') as readonly Appointment[]).filter(
    (a) => a.status === 'booked' && (a.participant ?? []).some((p) => p.actor?.reference === ref) && a.start !== undefined && eastern(Date.parse(a.start)).startsWith(`${SLOT.date}T${SLOT.time}`),
  );
  if (slots.length !== 1) throw new Error(`${ref}: ${slots.length} booked appointments at ${SLOT.date} ${SLOT.time}`);
  const appointment = slots[0]!;
  const scan = Date.parse(appointment.start!);

  // §1: the active allergies; a reaction to iodinated contrast is the risk factor.
  const allergies = (world.all('AllergyIntolerance') as readonly Allergy[]).filter(
    (a) => a.patient?.reference === ref && status(a.clinicalStatus) === 'active' && !['refuted', 'entered-in-error'].includes(status(a.verificationStatus) ?? ''),
  );
  const contrast = allergies.filter((a) => IODINATED.includes(substanceOf(a)));
  if (contrast.length !== 1) throw new Error(`${ref}: ${contrast.length} contrast allergies`);
  const allergy = contrast[0]!;
  const severity = SEVERITY[Math.max(...(allergy.reaction ?? []).map((r) => SEVERITY.indexOf(r.severity ?? '')))] ?? 'unknown';
  // §2 or §3.
  const regimen = severity === 'severe' ? 'no_contrast' : severity === 'unknown' ? 'unknown' : 'premedicate';

  // The record of the reaction: the patient's note of that day that names the agent.
  const onset = clinicDate(allergy.onsetDateTime!);
  const notes = (world.all('DocumentReference') as readonly Doc[]).filter(
    (d) => d.subject?.reference === ref && d.date !== undefined && clinicDate(d.date) === onset && decode(d.content?.[0]?.attachment?.data).toLowerCase().includes(substanceOf(allergy)),
  );
  if (notes.length !== 1) throw new Error(`${ref}: ${notes.length} notes record the ${substanceOf(allergy)} reaction`);

  // §2: each dose counted back from the scan.
  const before = (hours: number[]) => hours.map((h) => eastern(scan - h * HOUR));

  // §4: the most recent valid creatinine, and whether it is within 30 days before the scan.
  const scr = (world.all('Observation') as readonly Obs[])
    .filter((o) => o.subject?.reference === ref && o.status !== 'entered-in-error' && o.status !== 'cancelled' && (o.code?.coding ?? []).some((c) => c.system === LOINC && c.code === SCR))
    .sort((a, b) => Date.parse(b.effectiveDateTime ?? '') - Date.parse(a.effectiveDateTime ?? ''));
  const latest = scr[0];
  if (!latest?.effectiveDateTime) throw new Error(`${ref}: no creatinine`);
  const current = Date.parse(latest.effectiveDateTime) >= scan - 30 * DAY;

  return {
    patient: ref,
    patient_name: `${NAME.given} ${NAME.family}`,
    age,
    diabetes,
    appointment: { id: key(appointment), start: eastern(scan) },
    contrast_allergy: { id: key(allergy), substance: substanceOf(allergy), severity },
    reaction_note: key(notes[0]!),
    other_allergies: allergies.filter((a) => a !== allergy).map(key).sort(byKey),
    regimen,
    prednisone: { mg: 50, at: before([13, 7, 1]) },
    diphenhydramine: { mg: 50, at: before([1]) },
    creatinine: { latest: key(latest), date: clinicDate(latest.effectiveDateTime), required: age >= 60 || diabetes, current, before: eastern(scan) },
    ct_supporting: [key(allergy), key(notes[0]!)],
  };
}
