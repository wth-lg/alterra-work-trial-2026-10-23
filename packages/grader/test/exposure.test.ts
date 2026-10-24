// Exposure as the grader reads it, from tags the real read tools computed. The regressions are
// T3's (a trajectory that learns the patient's birth date only from search_patients, then
// writes, has the Patient exposed before the write: reports/pr-review-T3-1.md S1) and T2/T4's
// (a search_notes snippet that shows the decisive text exposes the note and records the text:
// reports/pr-review-T4-1.md S1).
import { describe, expect, it } from 'vitest';
import { clock } from '../../env/clock.ts';
import { Store, type Resource } from '../../env/store.ts';
import { INBOX_QUEUE_SYSTEM, READ_TOOLS, type ReadContext } from '../../env/tools/read/index.ts';
import { callTool } from '../../env/tools/registry.ts';
import { firstExposed, lastWrite, stepsOf, textShown } from '../exposure.ts';
import { INITIAL, note, PATIENT, trajectory } from './helpers.ts';

const inboxItem: Resource = {
  resourceType: 'Task', id: 'task-1', status: 'requested', intent: 'order', code: { coding: [{ system: INBOX_QUEUE_SYSTEM, code: 'results' }] },
  focus: { reference: 'Observation/obs-scr-1020' }, for: { reference: 'Patient/pt-1' }, authoredOn: '2026-10-22T09:00:00-04:00', description: 'New creatinine',
} as Resource;
const world = new Store([...INITIAL.map((r): Resource => (r.id === PATIENT.id ? ({ ...r, birthDate: '1948-03-02', gender: 'male' } as Resource) : r)), inboxItem]);
const ctx: ReadContext = { world, clock, policies: [], catalog: [] };
const read = (name: string, input: unknown) => {
  const r = callTool(READ_TOOLS, name, input, ctx);
  return { name, input, content: r.content, exposed: r.exposed_ids, referenced: r.referenced_ids };
};

describe('exposure from the read tools', () => {
  it('a birth date read only via search_patients exposes the Patient before the first write', () => {
    const found = read('search_patients', { name: 'vance' });
    expect((found.content as { entries: Array<{ birthDate: string }> }).entries[0]!.birthDate).toBe('1948-03-02');
    const steps = stepsOf(trajectory([found, { name: 'write_note', written: ['DocumentReference/doc-new'] }]));
    expect(firstExposed(steps, 'Patient/pt-1')).toBe(1);
    expect(firstExposed(steps, 'pt-1')).toBe(1);
    expect(lastWrite(steps, ['DocumentReference/doc-new'])).toBe(2);
  });
  it('a fhir_search row shows a note\'s size, not its text: referenced, nothing shown', () => {
    const steps = stepsOf(trajectory([read('fhir_search', { resource_type: 'DocumentReference', patient: 'pt-1' })]));
    expect(steps[0]!.referenced_ids).toContain('DocumentReference/doc-nurse-1');
    expect(steps[0]!.exposed_ids).not.toContain('DocumentReference/doc-nurse-1');
    expect(steps[0]!.shown).toEqual({});
    expect(firstExposed(steps, 'DocumentReference/doc-nurse-1')).toBeNull();
  });
  it('a search_notes step exposes the note and records its snippet', () => {
    const steps = stepsOf(trajectory([read('search_notes', { query: 'weight' })]));
    expect(steps[0]!.exposed_ids).toEqual(['DocumentReference/doc-nurse-1']);
    expect(steps[0]!.shown).toEqual({ 'DocumentReference/doc-nurse-1': 'Weight today 143 lb on the clinic scale.' });
    expect(firstExposed(steps, 'doc-nurse-1')).toBe(1);
  });
  it('a fhir_read of a note records the decoded text', () => {
    const steps = stepsOf(trajectory([read('fhir_read', { resource_type: 'DocumentReference', id: 'doc-nurse-1' })]));
    expect(steps[0]!.shown).toEqual({ 'DocumentReference/doc-nurse-1': 'Weight today 143 lb on the clinic scale.' });
  });
  it('textShown concatenates the text shown for a reference up to an index, inclusive', () => {
    const steps = stepsOf(
      trajectory([
        read('search_notes', { query: 'weight' }),
        read('fhir_read', { resource_type: 'Observation', id: 'obs-wt-1020' }),
        read('fhir_read', { resource_type: 'DocumentReference', id: 'doc-nurse-1' }),
        { name: 'fhir_read', is_error: true, error_code: 'NOT_FOUND', content: { error: { code: 'NOT_FOUND', message: 'x' } } },
      ]),
    );
    const text = 'Weight today 143 lb on the clinic scale.';
    expect(textShown(steps, 'DocumentReference/doc-nurse-1', -1)).toBe('');
    expect(textShown(steps, 'DocumentReference/doc-nurse-1', 0)).toBe(text);
    expect(textShown(steps, 'DocumentReference/doc-nurse-1', 1)).toBe(text);
    expect(textShown(steps, 'doc-nurse-1', 3)).toBe(`${text}\n${text}`);
    expect(textShown(steps, 'Observation/obs-wt-1020', 3)).toBe('');
    expect(steps[3]!.shown).toEqual({});
  });
  it('a long note shows only the snippet around the match', () => {
    const long = `${'Filler words about the visit. '.repeat(20)}Signed addendum: patient declines statin.${' More filler.'.repeat(30)}`;
    const w = new Store([...INITIAL, note('doc-long', long)]);
    const r = callTool(READ_TOOLS, 'search_notes', { query: 'addendum' }, { ...ctx, world: w });
    const steps = stepsOf(trajectory([{ name: 'search_notes', content: r.content, exposed: r.exposed_ids, referenced: r.referenced_ids }]));
    const shown = textShown(steps, 'DocumentReference/doc-long', 0);
    expect(shown).toContain('Signed addendum: patient declines statin.');
    expect(shown.length).toBeLessThan(long.length);
    expect(steps[0]!.exposed_ids).toContain('DocumentReference/doc-long');
  });
  it('an inbox row naming the patient does not expose it', () => {
    const steps = stepsOf(trajectory([read('list_inbox', { queue: 'results' }), read('fhir_read', { resource_type: 'Patient', id: 'pt-1' })]));
    expect(steps[0]!.referenced_ids).toEqual(['Observation/obs-scr-1020', 'Patient/pt-1', 'Task/task-1']);
    expect(firstExposed(steps, 'Patient/pt-1')).toBe(2);
  });
});
