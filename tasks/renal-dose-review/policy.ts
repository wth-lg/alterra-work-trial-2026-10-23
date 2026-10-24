// T1's expected end state, computed from the initial world by RBC-PHARM-07 (design section 4,
// "Double derivation"): the patient the instruction names by MRN, the inputs §1 picks, the
// CKD-EPI 2021 eGFR and Cockcroft-Gault CrCl from them, and each drug's rule (§2-§4). It never
// imports expected.ts or overlay constants (lint: no-policy-expected-import).
import { NOW_DATE } from '../../packages/env/clock.ts';
import type { Json } from '../../packages/grader/check.ts';
import type { WorldView } from '../../packages/grader/matrix/types.ts';
import { dailyDose, isActive, isDrug, quantity, type MedicationRequest } from '../../packages/grader/normalize.ts';

const MRN = '4410-22';
const LOINC = 'http://loinc.org';
const SCR = '2160-0';
const WEIGHT = '29463-7';
// The formulary's apixaban tablets by strength in mg (task.toml [[catalog]]).
const APIXABAN_PRODUCT: Record<number, string> = { 2.5: '1364435', 5: '1364445' };

type R = Readonly<Record<string, unknown>> & { resourceType: string; id?: string };
type Obs = R & { status?: string; code?: { coding?: Array<{ system?: string; code?: string }> }; subject?: { reference?: string }; effectiveDateTime?: string; valueQuantity?: { value?: number; unit?: string; code?: string } };

const round = (x: number, places: number) => Math.round(x * 10 ** places) / 10 ** places;

function ageOn(birthDate: string, date: string): number {
  const [by, bm, bd] = birthDate.split('-').map(Number) as [number, number, number];
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

// §1: the most recent valid result of a LOINC code for the patient; entered-in-error is not valid.
function results(world: WorldView, patient: string, code: string): Obs[] {
  return (world.all('Observation') as readonly Obs[])
    .filter((o) => o.subject?.reference === patient && (o.code?.coding ?? []).some((c) => c.system === LOINC && c.code === code))
    .sort((a, b) => Date.parse(b.effectiveDateTime ?? '') - Date.parse(a.effectiveDateTime ?? ''));
}
const valid = (o: Obs) => o.status !== 'entered-in-error' && o.status !== 'cancelled';

// CKD-EPI 2021 creatinine equation, race-free.
function ckdEpi2021(scr: number, age: number, female: boolean): number {
  const k = female ? 0.7 : 0.9;
  const a = female ? -0.241 : -0.302;
  return 142 * Math.min(scr / k, 1) ** a * Math.max(scr / k, 1) ** -1.2 * 0.9938 ** age * (female ? 1.012 : 1);
}

// Cockcroft-Gault with actual body weight.
const cockcroftGault = (scr: number, age: number, kg: number, female: boolean) => (((140 - age) * kg) / (72 * scr)) * (female ? 0.85 : 1);

export function derive(world: WorldView): Json {
  const patient = (world.all('Patient') as ReadonlyArray<R & { birthDate?: string; gender?: string; identifier?: Array<{ value?: string; type?: { coding?: Array<{ code?: string }> } }>; name?: Array<{ use?: string; given?: string[]; family?: string }> }>).find((p) =>
    (p.identifier ?? []).some((i) => i.value === MRN && (i.type?.coding ?? []).some((c) => c.code === 'MR')),
  );
  if (!patient?.birthDate) throw new Error(`no patient with MRN ${MRN} and a birth date`);
  const ref = `Patient/${patient.id}`;
  const name = patient.name?.find((n) => n.use === 'official') ?? patient.name?.[0];
  const female = patient.gender === 'female';
  const age = ageOn(patient.birthDate, NOW_DATE);

  const scrs = results(world, ref, SCR);
  const scr = scrs.find(valid);
  const weight = results(world, ref, WEIGHT).find(valid);
  const kg = weight?.valueQuantity ? quantity({ value: weight.valueQuantity.value!, unit: weight.valueQuantity.code ?? weight.valueQuantity.unit! }, 'kg')?.value : undefined;
  const mgdl = scr?.valueQuantity ? quantity({ value: scr.valueQuantity.value!, unit: scr.valueQuantity.code ?? scr.valueQuantity.unit! }, 'mg/dL')?.value : undefined;
  if (!scr || !weight || kg === undefined || mgdl === undefined) throw new Error(`${ref}: no valid SCr or weight`);
  const egfr = ckdEpi2021(mgdl, age, female);
  const crcl = cockcroftGault(mgdl, age, kg, female);

  const meds = (world.all('MedicationRequest') as ReadonlyArray<R & MedicationRequest & { subject?: { reference?: string } }>).filter((m) => m.subject?.reference === ref && isActive(m));
  const one = (ingredient: string) => {
    const found = meds.filter((m) => isDrug(m.medicationCodeableConcept, { ingredient }));
    if (found.length !== 1) throw new Error(`${ref}: ${found.length} active ${ingredient} requests`);
    return found[0]!;
  };
  const daily = (m: MedicationRequest) => dailyDose(m)!.value;

  // §2
  const criteria = { age: age >= 80, weight: kg <= 60, scr: mgdl >= 1.5 };
  const apixabanMg = Object.values(criteria).filter(Boolean).length >= 2 ? 2.5 : 5;

  // §3
  const metformin = one('metformin');
  const metforminNow = daily(metformin);
  const metforminRule =
    egfr >= 45 ? { action: 'unchanged', daily_mg: { min: metforminNow, max: metforminNow } }
    : egfr >= 30 ? { action: metforminNow > 1000 ? 'reduce' : 'unchanged', daily_mg: { min: Math.min(metforminNow, 1000), max: 1000 } }
    : { action: 'stop', daily_mg: { min: 0, max: 0 } };

  // §4
  const gabapentin = one('gabapentin');
  const band: [number, number, number | null] = crcl >= 60 ? [900, 3600, null] : crcl >= 30 ? [400, 1400, 2] : crcl >= 15 ? [200, 700, 1] : [100, 300, null];
  const gabapentinNow = daily(gabapentin);
  const gabapentinAction = gabapentinNow > band[1] ? 'reduce' : gabapentinNow < band[0] ? 'increase' : 'unchanged';

  const covered = new Set([one('apixaban').id, metformin.id, gabapentin.id]);
  return {
    patient: ref,
    patient_name: [...(name?.given ?? []), name?.family ?? ''].join(' ').trim(),
    age,
    scr: { id: `Observation/${scr.id}`, mg_dl: round(mgdl, 2) },
    weight: { id: `Observation/${weight.id}`, kg: round(kg, 2) },
    disregarded: scrs.filter((o) => !valid(o)).map((o) => `Observation/${o.id}`),
    egfr: round(egfr, 1),
    crcl: round(crcl, 1),
    apixaban: { request: `MedicationRequest/${one('apixaban').id}`, criteria, rxnorm: APIXABAN_PRODUCT[apixabanMg]!, dose_mg: apixabanMg, per_day: 2 },
    metformin: { request: `MedicationRequest/${metformin.id}`, ...metforminRule },
    gabapentin: { request: `MedicationRequest/${gabapentin.id}`, action: gabapentinAction, daily_mg: { min: band[0], max: band[1] }, per_day: band[2] },
    untouched: meds.filter((m) => !covered.has(m.id)).map((m) => `MedicationRequest/${m.id}`).sort(),
    cites: [`Observation/${scr.id}`, `Observation/${weight.id}`],
  };
}
