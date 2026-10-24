// The normalisers (design section 5, "Normalisation"): formatting never changes a comparison.
// The tau2 regressions are here: 25 and 25.0 are the same number, 2.5 mg and 2.50 mg the same
// dose, mg and MG the same unit.
import { describe, expect, it } from 'vitest';
import { canonicalNumber, clinicDate, conceptIs, dailyDose, displayKey, dosesPerDay, drugOf, isActive, isDrug, quantity, sameNumber, sameQuantity, type MedicationRequest } from '../normalize.ts';
import { medication } from './helpers.ts';

describe('numbers', () => {
  it.each([
    ['25', 25], ['25.0', 25], [' 25.00 ', 25], ['2.50', 2.5], ['.5', 0.5], ['1,000', 1000], ['-3', -3], [25, 25],
  ] as const)('%j is %d', (x, n) => expect(canonicalNumber(x)).toBe(n));

  it.each(['', 'abc', '1.2.3', '1,00', 'NaN', 'Infinity', '25 mg'])('%j is not a number', (x) => expect(canonicalNumber(x)).toBeNull());

  it.each([['25.', 25], ['42,', 42], ['42.', 42], ['1,000.', 1000], ['43.2,', 43.2], ['7;', 7]] as const)('%j, with trailing punctuation, is %d', (x, n) => expect(canonicalNumber(x)).toBe(n));

  it('25 vs 25.0 is the same number, 25 vs 25.1 is not', () => {
    expect(sameNumber('25', '25.0')).toBe(true);
    expect(sameNumber(25, '25.0')).toBe(true);
    expect(sameNumber('25', '25.1')).toBe(false);
    expect(sameNumber('25', 'x')).toBe(false);
  });
});

describe('units', () => {
  it('2.5 mg vs 2.50 mg and mg vs MG are the same dose', () => {
    expect(sameQuantity({ value: 2.5, unit: 'mg' }, { value: '2.50', unit: 'mg' })).toBe(true);
    expect(sameQuantity({ value: 2.5, unit: 'mg' }, { value: 2.5, unit: 'MG' })).toBe(true);
    expect(sameQuantity({ value: 2.5, unit: 'mg' }, { value: 5, unit: 'mg' })).toBe(false);
  });

  it('converts mass (g, mg, mcg) and body weight (lb to kg)', () => {
    expect(sameQuantity({ value: 1, unit: 'g' }, { value: 1000, unit: 'mg' })).toBe(true);
    expect(sameQuantity({ value: 250, unit: 'mcg' }, { value: 0.25, unit: 'mg' })).toBe(true);
    expect(sameQuantity({ value: 250, unit: 'ug' }, { value: 0.25, unit: 'mg' })).toBe(true);
    expect(quantity({ value: 143, unit: '[lb_av]' }, 'kg')!.value).toBeCloseTo(64.86, 2);
    expect(quantity({ value: 143, unit: 'lb' }, 'kg')!.value).toBeCloseTo(64.86, 2);
  });

  it('refuses to compare across dimensions', () => {
    expect(sameQuantity({ value: 1, unit: 'mg' }, { value: 1, unit: 'mL' })).toBe(false);
    expect(quantity({ value: 1, unit: 'mL' }, 'mg')).toBeNull();
  });
});

describe('frequency and total daily dose', () => {
  it('BID = Q12H = 2/day, whatever the spelling', () => {
    expect(dosesPerDay('BID')).toBe(2);
    expect(dosesPerDay('Q12H')).toBe(2);
    expect(dosesPerDay('2/day')).toBe(2);
    expect(dosesPerDay({ frequency: 2, period: 1, periodUnit: 'd' })).toBe(2);
    expect(dosesPerDay({ frequency: 1, period: 12, periodUnit: 'h' })).toBe(2);
    expect(dosesPerDay('TID')).toBe(3);
    expect(dosesPerDay('QHS')).toBe(1);
    expect(dosesPerDay({ frequency: 1, period: 48, periodUnit: 'h' })).toBe(0.5);
    expect(dosesPerDay({ count: 1 })).toBeNull();
  });

  it.each([
    ['Q24H', 1], ['QOD', 0.5], ['Q2H', 12], ['Q3H', 8], ['Q8H', 3], ['Q12H', 2], ['Q48H', 0.5], ['QWK', 1 / 7],
    ['once a day', 1], ['twice a day', 2], ['Once a day', 1], ['three times a day', 3], ['every other day', 0.5],
  ] as const)('%j is %d doses per day', (code, n) => expect(dosesPerDay(code)).toBeCloseTo(n, 12));

  it('reads the frequency code of a timing that has no repeat', () => {
    const mr = {
      resourceType: 'MedicationRequest', status: 'active', intent: 'order', subject: { reference: 'Patient/pt-1' },
      dosageInstruction: [{ timing: { code: { coding: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-GTSAbbreviation', code: 'Q24H' }] } }, doseAndRate: [{ doseQuantity: { value: 5, unit: 'mg', code: 'mg' } }] }],
    } as MedicationRequest;
    expect(dailyDose(mr)).toEqual({ value: 5, unit: 'mg' });
  });

  it('totals dose x frequency, in mg', () => {
    expect(dailyDose(medication('m1', 'metformin 1000 MG Oral Tablet', 1000, 'mg', 2) as MedicationRequest)).toEqual({ value: 2000, unit: 'mg' });
    expect(dailyDose(medication('m2', 'metformin 1000 MG Oral Tablet', 1, 'g', 2) as MedicationRequest)).toEqual({ value: 2000, unit: 'mg' });
  });

  it('totals explicit timing events per clinic day: three events = TID', () => {
    const mr = {
      resourceType: 'MedicationRequest', status: 'active', intent: 'order', subject: { reference: 'Patient/pt-1' },
      dosageInstruction: [{
        timing: { event: ['2026-10-24T08:00:00-04:00', '2026-10-24T14:00:00-04:00', '2026-10-24T20:00:00-04:00'] },
        doseAndRate: [{ doseQuantity: { value: 300, unit: 'mg', code: 'mg' } }],
      }],
    } as MedicationRequest;
    expect(dailyDose(mr)).toEqual({ value: 900, unit: 'mg' });
  });

  it('a clinic date is the America/New_York calendar date', () => {
    expect(clinicDate('2026-10-24T02:00:00Z')).toBe('2026-10-23');
    expect(clinicDate('2026-10-24T08:00:00-04:00')).toBe('2026-10-24');
    expect(clinicDate('2026-10-24')).toBe('2026-10-24');
  });
});

describe('codes', () => {
  const RX = 'http://www.nlm.nih.gov/research/umls/rxnorm';
  it('RxNorm SCD, branded and ingredient forms of the same drug are one drug', () => {
    const scd = { coding: [{ system: RX, code: '1364445', display: 'apixaban 5 MG Oral Tablet' }] };
    const sbd = { coding: [{ system: RX, code: '1364447', display: 'Eliquis 5 MG Oral Tablet' }] };
    const ingredient = { coding: [{ system: RX, code: '1364430', display: 'apixaban' }] };
    expect(drugOf(scd)).toMatchObject({ ingredient: 'apixaban', strength_mg: 5 });
    expect(drugOf(sbd)).toMatchObject({ ingredient: 'apixaban', strength_mg: 5 });
    expect(drugOf(ingredient)).toMatchObject({ ingredient: 'apixaban', strength_mg: null });
    for (const c of [scd, sbd, ingredient]) expect(isDrug(c, { ingredient: 'Apixaban' })).toBe(true);
    expect(isDrug(scd, { ingredient: 'apixaban', strength_mg: 5 })).toBe(true);
    expect(isDrug(scd, { ingredient: 'apixaban', strength_mg: 2.5 })).toBe(false);
    expect(isDrug(scd, { ingredient: 'rivaroxaban' })).toBe(false);
    expect(isDrug({ coding: [{ system: RX, code: '999', display: 'something' }] }, { ingredient: 'x', rxcuis: ['999'] })).toBe(true);
  });

  it('metoprolol XL is metoprolol succinate ER', () => {
    expect(drugOf('24 HR metoprolol succinate 50 MG Extended Release Oral Tablet')).toMatchObject({ ingredient: 'metoprolol succinate', strength_mg: 50 });
    expect(drugOf('Metoprolol XL 50 mg tablet')).toMatchObject({ ingredient: 'metoprolol succinate', strength_mg: 50 });
  });

  // A multi-ingredient SCD is one drug with an ingredient set: it matches only that whole set.
  it('combination products: amoxicillin alone is not amox-clav; the full set and the brand are', () => {
    // The world fixture's SCD (rxcui 562251, 7 MedicationRequests) and the RxNorm 875/125 form.
    const fixture = { coding: [{ system: RX, code: '562251', display: 'Amoxicillin 250 MG / Clavulanate 125 MG Oral Tablet' }] };
    const scd875 = { coding: [{ system: RX, code: '562508', display: 'Amoxicillin 875 MG / Clavulanate potassium 125 MG Oral Tablet' }] };
    expect(drugOf(fixture)).toEqual({ ingredient: 'amoxicillin / clavulanate', strength_mg: null, strength: null, ingredients: [{ name: 'amoxicillin', strength_mg: 250, strength: { value: 250, unit: 'mg' } }, { name: 'clavulanate', strength_mg: 125, strength: { value: 125, unit: 'mg' } }] });
    expect(drugOf(scd875)).toEqual({ ingredient: 'amoxicillin / clavulanate', strength_mg: null, strength: null, ingredients: [{ name: 'amoxicillin', strength_mg: 875, strength: { value: 875, unit: 'mg' } }, { name: 'clavulanate', strength_mg: 125, strength: { value: 125, unit: 'mg' } }] });
    for (const c of [fixture, scd875]) {
      expect(isDrug(c, { ingredient: 'amoxicillin' })).toBe(false);
      expect(isDrug(c, { ingredient: 'clavulanate' })).toBe(false);
      expect(isDrug(c, { ingredient: 'amoxicillin-clavulanate' })).toBe(true);
      expect(isDrug(c, { ingredient: 'Augmentin' })).toBe(true);
      expect(isDrug(c, { ingredient: 'amoxicillin / clavulanate potassium' })).toBe(true);
    }
    // Plain amoxicillin is not amox-clav either.
    expect(isDrug({ coding: [{ system: RX, code: '308191', display: 'amoxicillin 875 MG Oral Tablet' }] }, { ingredient: 'Augmentin' })).toBe(false);
    // Per-ingredient strengths, when the accepted name states them.
    expect(isDrug(scd875, { ingredient: 'amoxicillin 875 MG / clavulanate 125 MG' })).toBe(true);
    expect(isDrug(fixture, { ingredient: 'amoxicillin 875 MG / clavulanate 125 MG' })).toBe(false);
  });

  it('combination products: a two-ingredient antihypertensive matches its set, in any order, not either part', () => {
    const scd = { coding: [{ system: RX, code: '197885', display: 'hydrochlorothiazide 12.5 MG / lisinopril 20 MG Oral Tablet' }] };
    expect(drugOf(scd)).toMatchObject({ ingredient: 'hydrochlorothiazide / lisinopril', strength_mg: null });
    expect(isDrug(scd, { ingredient: 'lisinopril' })).toBe(false);
    expect(isDrug(scd, { ingredient: 'hydrochlorothiazide' })).toBe(false);
    expect(isDrug(scd, { ingredient: 'lisinopril / hydrochlorothiazide' })).toBe(true);
    expect(isDrug(scd, { ingredient: 'Zestoretic' })).toBe(true);
    expect(isDrug({ coding: [{ system: RX, code: '314076', display: 'lisinopril 20 MG Oral Tablet' }] }, { ingredient: 'lisinopril / hydrochlorothiazide' })).toBe(false);
    // A salt word after the ingredient is not part of it.
    expect(drugOf('Acetaminophen 325 MG / Oxycodone Hydrochloride 10 MG Oral Tablet [Percocet]')).toMatchObject({ ingredient: 'acetaminophen / oxycodone' });
  });

  // Strengths that are not a mass: mEq, units, and a concentration per mL or per actuation,
  // which is one strength, never a second ingredient.
  it('mEq: potassium chloride 20 MEQ is potassium chloride at 20 mEq, however mEq is written', () => {
    for (const s of ['potassium chloride 20 MEQ Extended Release Oral Tablet', 'Potassium Chloride 20 mEq ER tablet', 'potassium chloride 20 meq']) {
      expect(drugOf(s)).toEqual({ ingredient: 'potassium chloride', strength_mg: null, strength: { value: 20, unit: 'mEq' }, ingredients: [{ name: 'potassium chloride', strength_mg: null, strength: { value: 20, unit: 'mEq' } }] });
      expect(isDrug({ text: s }, { ingredient: 'potassium chloride' })).toBe(true);
      expect(isDrug({ text: s }, { ingredient: 'potassium chloride 20 mEq' })).toBe(true);
      expect(isDrug({ text: s }, { ingredient: 'potassium chloride 10 mEq' })).toBe(false);
      expect(isDrug({ text: s }, { ingredient: 'potassium chloride 20 mg' })).toBe(false);
    }
  });

  it('units: UNT, units and IU are one unit; a units-per-mL concentration is one strength', () => {
    expect(drugOf('Vitamin D3 1000 units tablet')).toMatchObject({ ingredient: 'vitamin d3', strength_mg: null, strength: { value: 1000, unit: '[iU]' } });
    expect(drugOf('vitamin D3 1000 UNT Oral Tablet')).toMatchObject({ ingredient: 'vitamin d3', strength: { value: 1000, unit: '[iU]' } });
    expect(drugOf('insulin glargine 100 UNT/ML Injectable Solution')).toMatchObject({ ingredient: 'insulin glargine', strength: { value: 100, unit: '[iU]/mL' } });
    // The world's heparin and Humulin 70/30 SCDs.
    expect(drugOf('heparin sodium, porcine 100 UNT/ML Injectable Solution')).toMatchObject({ ingredient: 'heparin, porcine', strength: { value: 100, unit: '[iU]/mL' } });
    const humulin = drugOf('insulin isophane, human 70 UNT/ML / insulin, regular, human 30 UNT/ML Injectable Suspension [Humulin]');
    expect(humulin).toMatchObject({ ingredient: 'insulin isophane, human / insulin, regular, human', strength: null });
    expect(humulin!.ingredients.map((i) => i.strength)).toEqual([{ value: 70, unit: '[iU]/mL' }, { value: 30, unit: '[iU]/mL' }]);
    expect(isDrug({ text: 'insulin glargine 100 UNT/ML Injectable Solution' }, { ingredient: 'insulin glargine 100 units/mL' })).toBe(true);
    expect(isDrug({ text: 'insulin glargine 100 UNT/ML Injectable Solution' }, { ingredient: 'insulin glargine 100 units' })).toBe(false);
  });

  it('MCG: a microgram strength is the same strength in mg; per actuation is one strength', () => {
    expect(drugOf('cyanocobalamin 1000 MCG Oral Tablet')).toMatchObject({ ingredient: 'cyanocobalamin', strength_mg: 1, strength: { value: 1, unit: 'mg' } });
    expect(isDrug({ text: 'levothyroxine sodium 0.05 MG Oral Tablet' }, { ingredient: 'levothyroxine 50 mcg' })).toBe(true);
    expect(drugOf('fluticasone propionate 50 MCG/ACTUAT Nasal Spray')).toMatchObject({ ingredient: 'fluticasone propionate', strength_mg: null, strength: { value: 0.05, unit: 'mg/{actuat}' } });
  });

  it('mL: a per-mL concentration, in any spelling, is one strength; a leading package volume is not part of the name', () => {
    for (const s of ['amoxicillin 50 MG/ML Oral Suspension', 'Amoxicillin 250 MG in 5 ML Oral Suspension', 'amoxicillin 250 mg/5 mL suspension']) {
      expect(drugOf(s)).toMatchObject({ ingredient: 'amoxicillin', strength_mg: null, strength: { value: 50, unit: 'mg/mL' } });
    }
    expect(isDrug({ text: 'Amoxicillin 250 MG in 5 ML Oral Suspension' }, { ingredient: 'amoxicillin 50 mg/mL' })).toBe(true);
    expect(isDrug({ text: 'Amoxicillin 250 MG in 5 ML Oral Suspension' }, { ingredient: 'amoxicillin 250 mg' })).toBe(false);
    expect(drugOf('albuterol 5 MG/ML Inhalation Solution')).toMatchObject({ ingredient: 'albuterol', strength: { value: 5, unit: 'mg/mL' } });
    expect(drugOf('1 ML medroxyprogesterone acetate 150 MG/ML Injection')).toMatchObject({ ingredient: 'medroxyprogesterone acetate', strength: { value: 150, unit: 'mg/mL' } });
    expect(drugOf('5 ML SUFentanil 0.05 MG/ML Injection')).toMatchObject({ ingredient: 'sufentanil', strength: { value: 0.05, unit: 'mg/mL' } });
    const three = drugOf('Acetaminophen 21.7 MG/ML / Dextromethorphan Hydrobromide 1 MG/ML / doxylamine succinate 0.417 MG/ML Oral Solution');
    expect(three!.ingredients.map((i) => [i.name, i.strength])).toEqual([
      ['acetaminophen', { value: 21.7, unit: 'mg/mL' }], ['dextromethorphan hydrobromide', { value: 1, unit: 'mg/mL' }], ['doxylamine succinate', { value: 0.417, unit: 'mg/mL' }],
    ]);
  });

  it('LOINC: the code decides, display text formatting does not', () => {
    const a = { coding: [{ system: 'http://loinc.org', code: '2160-0', display: 'Creatinine [Mass/volume] in Serum or Plasma' }] };
    expect(conceptIs(a, { system: 'http://loinc.org', code: '2160-0' })).toBe(true);
    expect(conceptIs(a, { system: 'http://loinc.org', code: '29463-7' })).toBe(false);
    const textOnly = { text: 'creatinine  [mass/volume] in serum or plasma.' };
    expect(conceptIs(textOnly, { system: 'http://loinc.org', code: '2160-0', display: 'Creatinine [Mass/volume] in Serum or Plasma' })).toBe(true);
    expect(displayKey('Body  Weight.')).toBe(displayKey('body weight'));
  });

  it('status sets: stopped, cancelled, completed and entered-in-error are not active', () => {
    expect(isActive({ status: 'active' })).toBe(true);
    for (const status of ['stopped', 'cancelled', 'completed', 'entered-in-error', 'on-hold', 'draft']) expect(isActive({ status })).toBe(false);
  });
});

describe('drugOf on EHR-style names', () => {
  it('drops salt forms and the HFA, ER and XR dosage-form words', () => {
    expect(drugOf('albuterol sulfate HFA 90 MCG/ACTUAT')).toEqual({ ingredient: 'albuterol', strength_mg: null, strength: { value: 0.09, unit: 'mg/{actuat}' }, ingredients: [{ name: 'albuterol', strength_mg: null, strength: { value: 0.09, unit: 'mg/{actuat}' } }] });
    expect(drugOf('albuterol sulfate HFA')).toMatchObject({ ingredient: 'albuterol', strength: null });
    expect(drugOf('metformin ER 500 mg')).toMatchObject({ ingredient: 'metformin', strength_mg: 500 });
    expect(drugOf('metformin XR 500 mg')).toMatchObject({ ingredient: 'metformin', strength_mg: 500 });
    expect(isDrug({ text: 'albuterol sulfate HFA 90 MCG/ACTUAT' }, { ingredient: 'albuterol' })).toBe(true);
  });

  it('gives each strength of a paired combination strength to its ingredient', () => {
    const want = { ingredient: 'amoxicillin / clavulanate', strength_mg: null, strength: null, ingredients: [{ name: 'amoxicillin', strength_mg: 875, strength: { value: 875, unit: 'mg' } }, { name: 'clavulanate', strength_mg: 125, strength: { value: 125, unit: 'mg' } }] };
    expect(drugOf('amoxicillin-clavulanate 875-125 mg')).toEqual(want);
    expect(drugOf('amoxicillin-clavulanate 875/125 mg')).toEqual(want);
    expect(drugOf('Amoxicillin-Clavulanate 875-125 MG Oral Tablet')).toEqual(want);
    expect(isDrug({ text: 'amoxicillin-clavulanate 875-125 mg' }, { ingredient: 'amoxicillin 875 MG / clavulanate 125 MG' })).toBe(true);
    expect(isDrug({ text: 'amoxicillin-clavulanate 875-125 mg' }, { ingredient: 'amoxicillin 500 MG / clavulanate 125 MG' })).toBe(false);
  });
});
