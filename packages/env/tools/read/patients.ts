// search_patients (design section 3): find a patient by name words, birth date or MRN. A row
// shows the demographics a clinician acts on (name, birth date, gender, MRN), so it carries
// resourceType and id and exposes the Patient (the exposure rule, registry.ts).
import type { Patient } from '@medplum/fhirtypes';
import type { Tool } from '../registry.ts';
import type { ReadContext } from './context.ts';
import { displayName } from './get-context.ts';
import { page } from './page.ts';
import { count, offset } from './schema.ts';

const words = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) as string[];
const mrnOf = (p: Readonly<Patient>) => p.identifier?.find((i) => i.type?.coding?.some((c) => c.code === 'MR'))?.value ?? null;
const officialName = (p: Readonly<Patient>) => p.name?.find((n) => n.use === 'official') ?? p.name?.[0];

type PatientsInput = {
  name?: string;
  birthdate?: string;
  mrn?: string;
  count?: number;
  offset?: number;
};

export const searchPatients: Tool<ReadContext> = {
  name: 'search_patients',
  description:
    'Find patients. name matches when every word starts a given or family name (any case); birthdate and mrn match exactly. ' +
    'Filters combine with AND; with none, every patient is listed. Returns {resourceType, id, patient, name, birthDate, gender, mrn, pcp} rows in id order.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Name words, e.g. "maya ok"', minLength: 1, maxLength: 100 },
      birthdate: { type: 'string', description: 'YYYY-MM-DD', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      mrn: { type: 'string', description: 'Medical record number', minLength: 1, maxLength: 40 },
      count: count(50, 20),
      offset,
    },
    additionalProperties: false,
  },
  run(input: PatientsInput, { world }) {
    const want = input.name === undefined ? [] : words(input.name);
    const rows = [...world.search<Patient>('Patient', {}).resources]
      .filter((p) => {
        if (input.birthdate !== undefined && p.birthDate !== input.birthdate) return false;
        if (input.mrn !== undefined && mrnOf(p) !== input.mrn) return false;
        const parts = (p.name ?? []).flatMap((n) => [...(n.given ?? []), n.family ?? '']).flatMap(words);
        return want.every((w) => parts.some((part) => part.startsWith(w)));
      })
      .sort((a, b) => (a.id! < b.id! ? -1 : a.id! > b.id! ? 1 : 0))
      .map((p) => ({
        resourceType: 'Patient',
        id: p.id!,
        patient: `Patient/${p.id}`,
        name: displayName(officialName(p)),
        birthDate: p.birthDate ?? null,
        gender: p.gender ?? null,
        mrn: mrnOf(p),
        pcp: p.generalPractitioner?.[0]?.reference ?? null,
      }));
    return page(rows, input.offset ?? 0, input.count ?? 20);
  },
};
