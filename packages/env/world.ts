// The setting every task shares (design section 2, "One shared world"): the clinic, the
// outside hospital, the staff and the work pools. fixtures:build adds these to the Synthea
// base cohort before any task overlay; the base cohort's practitioner and organization
// references already point at them (scripts/fixtures-synthea.ts).
import type { Resource } from '@medplum/fhirtypes';
import { NOW_PROMPT } from './clock.ts';
import type { LintSpec } from './lint/index.ts';

// Every resource type the world may hold and the tools write or validate (design section 2,
// "Store"). fixtures:build prunes the R4 definitions to these, so a write of any of them can be
// validated even before the world holds one.
export const RESOURCE_TYPES = [
  'Patient',
  'Practitioner',
  'Organization',
  'Group',
  'Encounter',
  'EpisodeOfCare',
  'Appointment',
  'Condition',
  'Observation',
  'DiagnosticReport',
  'DocumentReference',
  'AllergyIntolerance',
  'Procedure',
  'MedicationRequest',
  'ServiceRequest',
  'Task',
  'Communication',
  'Provenance',
] as const;

export const CLINIC = 'org-riverbend';
export const OUTSIDE_HOSPITAL = 'org-st-brigid';
// The user is Dr. Okafor; the other two share the base cohort's encounters and orders.
export const STAFF = ['pr-okafor', 'pr-lin', 'pr-reyes'] as const;
export const POOLS = ['pool-oncall', 'pool-rn-triage', 'pool-scheduling'] as const;

const practitioner = (id: string, given: string, family: string, suffix: string): Resource => ({
  resourceType: 'Practitioner',
  id,
  active: true,
  name: [{ use: 'official', given: [given], family, suffix: [suffix] }],
});

const pool = (id: string, name: string): Resource => ({ resourceType: 'Group', id, type: 'practitioner', actual: true, name });

export const SETTING: readonly Resource[] = [
  { resourceType: 'Organization', id: CLINIC, active: true, name: 'Riverbend Family Medicine' },
  { resourceType: 'Organization', id: OUTSIDE_HOSPITAL, active: true, name: 'St. Brigid Regional' },
  practitioner('pr-okafor', 'Maya', 'Okafor', 'MD'),
  practitioner('pr-lin', 'Daniel', 'Lin', 'MD'),
  practitioner('pr-reyes', 'Jordan', 'Reyes', 'NP'),
  pool('pool-oncall', 'On-call clinician'),
  pool('pool-rn-triage', 'RN triage'),
  pool('pool-scheduling', 'Scheduling'),
];

export const SETTING_LINT: LintSpec = { prompts: [NOW_PROMPT] };
