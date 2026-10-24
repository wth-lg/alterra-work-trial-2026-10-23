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
    expect(drugOf(scd)).toEqual({ ingredient: 'apixaban', strength_mg: 5 });
    expect(drugOf(sbd)).toEqual({ ingredient: 'apixaban', strength_mg: 5 });
    expect(drugOf(ingredient)).toEqual({ ingredient: 'apixaban', strength_mg: null });
    for (const c of [scd, sbd, ingredient]) expect(isDrug(c, { ingredient: 'Apixaban' })).toBe(true);
    expect(isDrug(scd, { ingredient: 'apixaban', strength_mg: 5 })).toBe(true);
    expect(isDrug(scd, { ingredient: 'apixaban', strength_mg: 2.5 })).toBe(false);
    expect(isDrug(scd, { ingredient: 'rivaroxaban' })).toBe(false);
    expect(isDrug({ coding: [{ system: RX, code: '999', display: 'something' }] }, { ingredient: 'x', rxcuis: ['999'] })).toBe(true);
  });

  it('metoprolol XL is metoprolol succinate ER', () => {
    expect(drugOf('24 HR metoprolol succinate 50 MG Extended Release Oral Tablet')).toEqual({ ingredient: 'metoprolol succinate', strength_mg: 50 });
    expect(drugOf('Metoprolol XL 50 mg tablet')).toEqual({ ingredient: 'metoprolol succinate', strength_mg: 50 });
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
