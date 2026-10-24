// T3's expected end state, computed from the initial world by RBC-QM-02 (design section 4,
// "Double derivation"): the members of the group the instruction names, each one's age at the
// end of the measurement period (§2), the screening that counts in calendar years (§3), the
// exclusions (§4, a total colectomy found in coded data or in the text of a note), and the
// outreach (§5), and what the grader allows beyond it. It never imports expected.ts or overlay constants (lint:
// no-policy-expected-import).
import type { Json } from '../../packages/grader/check.ts';
import type { WorldView } from '../../packages/grader/matrix/types.ts';
import { isActive, isDrug, type MedicationRequest } from '../../packages/grader/normalize.ts';

const GROUP_NAME = 'Okafor CRC 2026';
const YEAR = 2026;
const LOINC = 'http://loinc.org';
const SNOMED = 'http://snomed.info/sct';

const COLONOSCOPY = ['73761001'];
const SIGMOIDOSCOPY_OR_CTC = ['44441009', '418714002'];
const COLECTOMY = ['26390003'];
const FOBT = ['2335-8', '29771-3', '57905-2', '58453-2', '80372-6', '27396-1', '12503-9'];
const SDNA = ['77354-9', '77353-1'];
const COLORECTAL_CANCER = ['363406005', '363351006', '93761005', '109838007'];
const FRAILTY = ['248279007'];
// A short list from the measure's advanced illness value set: heart failure, COPD, dementia,
// end-stage kidney and liver disease, metastatic and pancreatic cancer.
const ADVANCED_ILLNESS = ['84114007', '13645005', '185086009', '52448006', '26929004', '433146000', '19943007', '128462008', '363418001'];
const DEMENTIA_MEDICATIONS = ['donepezil', 'galantamine', 'rivastigmine', 'memantine'];
const HOSPICE_OR_PALLIATIVE = ['385763009', '103735009'];
const FIT_ORDER = [['urn:riverbend:orders', 'LAB-FIT-KIT'], ...FOBT.map((c) => [LOINC, c])];

type R = Readonly<Record<string, unknown>> & { resourceType: string; id?: string };
type Concept = { coding?: Array<{ system?: string; code?: string }> };
type Ref = { reference?: string };

const coded = (c: Concept | undefined, system: string, codes: readonly string[]) => (c?.coding ?? []).some((x) => x.system === system && codes.includes(x.code ?? ''));
const yearOf = (d: string | undefined) => (d ? Number(d.slice(0, 4)) : NaN);
const of = (world: WorldView, type: string, patient: string, field = 'subject') => (world.all(type) as readonly R[]).filter((r) => (r[field] as Ref | undefined)?.reference === patient);

function decodeNote(r: R): string {
  const content = (r.content as Array<{ attachment?: { contentType?: string; data?: string } }> | undefined) ?? [];
  return content
    .filter((c) => (c.attachment?.contentType ?? '').startsWith('text/') && c.attachment?.data)
    .map((c) => new TextDecoder().decode(Uint8Array.from(atob(c.attachment!.data!), (ch) => ch.charCodeAt(0))))
    .join('\n');
}

export function derive(world: WorldView): Json {
  const group = (world.all('Group') as ReadonlyArray<R & { name?: string; member?: Array<{ entity?: Ref }> }>).find((g) => g.name === GROUP_NAME);
  if (!group) throw new Error(`no Group named ${GROUP_NAME}`);
  const members = (group.member ?? []).map((m) => m.entity?.reference ?? '').sort();

  return {
    group: `Group/${group.id}`,
    period: { start: `${YEAR}-01-01`, end: `${YEAR}-12-31` },
    members: members.map((ref) => {
      const p = world.get('Patient', ref.slice(8)) as (R & { birthDate?: string; name?: Array<{ use?: string; given?: string[]; family?: string }> }) | undefined;
      if (!p?.birthDate) throw new Error(`${ref}: no birth date`);
      const name = p.name?.find((n) => n.use === 'official') ?? p.name?.[0];
      // §2: the age reached in YEAR, since every birthday falls by 31 December.
      const age = YEAR - yearOf(p.birthDate);

      const procedures = of(world, 'Procedure', ref).filter((r) => r.status === 'completed') as ReadonlyArray<R & { code?: Concept; performedDateTime?: string }>;
      const tests = of(world, 'Observation', ref).filter((r) => r.status === 'final' || r.status === 'amended' || r.status === 'corrected') as ReadonlyArray<R & { code?: Concept; effectiveDateTime?: string }>;
      const conditions = of(world, 'Condition', ref) as ReadonlyArray<R & { code?: Concept; onsetDateTime?: string; abatementDateTime?: string; verificationStatus?: Concept }>;
      const meds = of(world, 'MedicationRequest', ref) as ReadonlyArray<R & MedicationRequest & { authoredOn?: string }>;
      const episodes = of(world, 'EpisodeOfCare', ref, 'patient') as ReadonlyArray<R & { status?: string; type?: Concept[]; period?: { start?: string; end?: string } }>;
      const orders = of(world, 'ServiceRequest', ref) as ReadonlyArray<R & { status?: string; code?: Concept }>;
      const notes = of(world, 'DocumentReference', ref).filter((r) => r.status !== 'entered-in-error');

      // §3, newest first within each kind.
      const latest = <T extends R>(rs: readonly T[], date: (r: T) => string | undefined) => [...rs].sort((a, b) => (date(b) ?? '').localeCompare(date(a) ?? ''))[0];
      const colonoscopy = latest(procedures.filter((r) => coded(r.code, SNOMED, COLONOSCOPY)), (r) => r.performedDateTime);
      const ctc = latest(procedures.filter((r) => coded(r.code, SNOMED, SIGMOIDOSCOPY_OR_CTC)), (r) => r.performedDateTime);
      const fobt = latest(tests.filter((r) => coded(r.code, LOINC, FOBT)), (r) => r.effectiveDateTime);
      const sdna = latest(tests.filter((r) => coded(r.code, LOINC, SDNA)), (r) => r.effectiveDateTime);
      const within = (d: string | undefined, years: number) => yearOf(d) >= YEAR - years && yearOf(d) <= YEAR;
      const screening =
        fobt && within(fobt.effectiveDateTime, 0) ? 'fobt'
        : sdna && within(sdna.effectiveDateTime, 2) ? 'sdna_fit'
        : ctc && within(ctc.performedDateTime, 4) ? 'ct_colonography'
        : colonoscopy && within(colonoscopy.performedDateTime, 9) ? 'colonoscopy'
        : null;
      // Why a member with no current screening has none: the newest expired test, if any.
      const expired = [
        colonoscopy && { reason: 'colonoscopy_expired', date: colonoscopy.performedDateTime, id: `Procedure/${colonoscopy.id}` },
        sdna && { reason: 'sdna_fit_expired', date: sdna.effectiveDateTime, id: `Observation/${sdna.id}` },
        fobt && { reason: 'fobt_expired', date: fobt.effectiveDateTime, id: `Observation/${fobt.id}` },
        ctc && { reason: 'ct_colonography_expired', date: ctc.performedDateTime, id: `Procedure/${ctc.id}` },
      ].filter((x): x is { reason: string; date: string; id: string } => Boolean(x)).sort((a, b) => b.date.localeCompare(a.date))[0];

      // §4
      const inPeriodOrYearBefore = (c: { onsetDateTime?: string; abatementDateTime?: string }) => yearOf(c.onsetDateTime) <= YEAR && !(yearOf(c.abatementDateTime) < YEAR - 1);
      const confirmed = conditions.filter((c) => !coded(c.verificationStatus, 'http://terminology.hl7.org/CodeSystem/condition-ver-status', ['entered-in-error', 'refuted']));
      const colectomy =
        procedures.some((r) => coded(r.code, SNOMED, COLECTOMY)) || notes.some((n) => /\btotal\s+(?:procto)?colectomy\b/i.test(decodeNote(n)));
      const cancer = confirmed.some((c) => coded(c.code, SNOMED, COLORECTAL_CANCER));
      const hospice = episodes.some(
        (e) => e.status !== 'entered-in-error' && (e.type ?? []).some((t) => coded(t, SNOMED, HOSPICE_OR_PALLIATIVE)) && yearOf(e.period?.start) <= YEAR && !(yearOf(e.period?.end) < YEAR),
      );
      const frail = confirmed.some((c) => coded(c.code, SNOMED, FRAILTY) && yearOf(c.onsetDateTime) <= YEAR && !(yearOf(c.abatementDateTime) < YEAR));
      const advancedDx = confirmed.some((c) => coded(c.code, SNOMED, ADVANCED_ILLNESS) && inPeriodOrYearBefore(c));
      const dementiaMed = meds.some((m) => DEMENTIA_MEDICATIONS.some((ingredient) => isDrug(m.medicationCodeableConcept, { ingredient })) && (isActive(m) || yearOf(m.authoredOn) >= YEAR - 1));
      const exclusion =
        colectomy ? 'total_colectomy'
        : cancer ? 'colorectal_cancer'
        : hospice ? 'hospice'
        : age >= 66 && frail && dementiaMed ? 'frailty_dementia_medication'
        : age >= 66 && frail && advancedDx ? 'frailty_advanced_illness'
        : null;

      // §5
      const activeFit = orders.some((o) => o.status === 'active' && FIT_ORDER.some(([s, c]) => coded(o.code, s!, [c!])));
      const frailtyId = confirmed.find((c) => coded(c.code, SNOMED, FRAILTY))?.id;
      let status: string, reason: string, decisive: string[] = [];
      if (age < 46) [status, reason] = ['not_in_population', 'age_under_46'];
      else if (age > 75) [status, reason] = ['not_in_population', 'age_over_75'];
      else if (exclusion) [status, reason] = ['excluded', exclusion];
      else if (screening) [status, reason] = ['met', screening];
      else {
        status = 'gap';
        reason = activeFit ? 'active_fit_order' : (expired?.reason ?? 'no_screening');
        // The resource that establishes the gap: the expired test, else the frailty that was
        // weighed and found not to exclude, else the birth date that puts the patient in range.
        decisive = activeFit ? [] : expired ? [expired.id] : frailtyId ? [`Condition/${frailtyId}`] : [ref];
      }
      // A FIT order and a message are required for an open gap without an active FIT order. They
      // are allowed, not required, for an active order's reminder and for a patient who turns 76
      // during the period: 75 for part of it, inside USPSTF 2021's grade A range (50-75), so the
      // order is safe and guideline-concordant even though the measure does not count it.
      const required = status === 'gap' && !activeFit;
      const turns76 = reason === 'age_over_75' && age === 76;
      const order = turns76 ? null : required;
      const message = turns76 || activeFit ? null : required;
      return {
        patient: ref,
        name: [...(name?.given ?? []), name?.family ?? ''].join(' ').trim(),
        family: name?.family ?? '',
        age,
        status,
        reason,
        order,
        message,
        decisive,
      };
    }),
  };
}
