// Exposure as the grader reads it, from tags the real read tools computed. The regressions are
// T3's (a trajectory that learns the patient's birth date only from search_patients, then
// writes, has the Patient exposed before the write: reports/pr-review-T3-1.md S1), T2/T4's
// (a search_notes snippet records the text it showed: reports/pr-review-T4-1.md S1) and the
// exposure review's (a snippet is shown text, not exposure, so a note found by a snippet that
// misses the decisive fact is a retrieval failure; shown text is compared the same way whatever
// showed it: reports/pr-review-exposure-1.md S1, S2, S4).
import { describe, expect, it } from 'vitest';
import { clock } from '../../env/clock.ts';
import { Store, type Resource } from '../../env/store.ts';
import { INBOX_QUEUE_SYSTEM, READ_TOOLS, type ReadContext } from '../../env/tools/read/index.ts';
import { callTool } from '../../env/tools/registry.ts';
import { attribute } from '../attribution.ts';
import { gate } from '../check.ts';
import { firstExposed, lastWrite, shows, stepsOf } from '../exposure.ts';
import type { CheckResult } from '../grade.ts';
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
  it('a search_notes step references the note and records its snippet as shown text', () => {
    const steps = stepsOf(trajectory([read('search_notes', { query: 'weight' })]));
    expect(steps[0]!.exposed_ids).toEqual([]);
    expect(steps[0]!.referenced_ids).toContain('DocumentReference/doc-nurse-1');
    expect(steps[0]!.shown).toEqual({ 'DocumentReference/doc-nurse-1': 'Weight today 143 lb on the clinic scale.' });
    expect(firstExposed(steps, 'doc-nurse-1')).toBeNull();
  });
  it('a fhir_read of a note exposes it and records the decoded text', () => {
    const steps = stepsOf(trajectory([read('fhir_read', { resource_type: 'DocumentReference', id: 'doc-nurse-1' })]));
    expect(steps[0]!.exposed_ids).toEqual(['DocumentReference/doc-nurse-1']);
    expect(steps[0]!.shown).toEqual({ 'DocumentReference/doc-nurse-1': 'Weight today 143 lb on the clinic scale.' });
  });
  it('shows() looks only at steps numbered below beforeStepN (Step.n, 1-based)', () => {
    const steps = stepsOf(
      trajectory([
        read('fhir_read', { resource_type: 'Observation', id: 'obs-wt-1020' }),
        read('search_notes', { query: 'weight' }),
        { name: 'fhir_read', is_error: true, error_code: 'NOT_FOUND', content: { error: { code: 'NOT_FOUND', message: 'x' } } },
      ]),
    );
    expect(shows(steps, 'DocumentReference/doc-nurse-1', 2, '143 lb')).toBe(false);
    expect(shows(steps, 'DocumentReference/doc-nurse-1', 3, '143 lb')).toBe(true);
    expect(shows(steps, 'doc-nurse-1', 3, '143 lb')).toBe(true);
    expect(shows(steps, 'doc-nurse-1', 3, '150 lb')).toBe(false);
    expect(shows(steps, 'Observation/obs-wt-1020', 4, '143')).toBe(false);
    expect(steps[2]!.shown).toEqual({});
    // Two texts one step showed for a resource are searched apart, never across the join.
    const joined = [{ ...steps[1]!, shown: { 'DocumentReference/doc-nurse-1': 'ends with 143\nlb starts here' } }];
    expect(shows(joined, 'doc-nurse-1', 3, '143 lb')).toBe(false);
    expect(shows(joined, 'doc-nurse-1', 3, 'LB starts')).toBe(true);
  });
  it('a long note shows only the snippet around the match', () => {
    const long = `${'Filler words about the visit. '.repeat(20)}Signed addendum: patient declines statin.${' More filler.'.repeat(30)}`;
    const w = new Store([...INITIAL, note('doc-long', long)]);
    const r = callTool(READ_TOOLS, 'search_notes', { query: 'addendum' }, { ...ctx, world: w });
    const steps = stepsOf(trajectory([{ name: 'search_notes', content: r.content, exposed: r.exposed_ids, referenced: r.referenced_ids }]));
    const shown = steps[0]!.shown['DocumentReference/doc-long']!;
    expect(shown).toContain('Signed addendum: patient declines statin.');
    expect(shown.length).toBeLessThan(long.length);
    expect(shows(steps, 'doc-long', 2, 'signed addendum: patient declines statin')).toBe(true);
    expect(steps[0]!.exposed_ids).not.toContain('DocumentReference/doc-long');
  });
  it('a snippet that misses the decisive fact is retrieval; one that shows it, or a fhir_read, is reasoning', () => {
    // reports/pr-review-exposure-1.md S1 probe: the query finds the note, the snippet ends before
    // the plan.
    const text = `Visit for knee pain. Weight stable. ${'Filler words about the visit. '.repeat(16)}Plan: STOP apixaban per cardiology.`;
    const w = { ...ctx, world: new Store([...INITIAL, note('doc-long', text)]) };
    const call = (name: string, input: unknown) => {
      const r = callTool(READ_TOOLS, name, input, w);
      return { name, input, content: r.content, exposed: r.exposed_ids, referenced: r.referenced_ids };
    };
    const spec = { id: 'G1', category: 'reasoning', traces_to: 'x', decisive_ids: ['DocumentReference/doc-long'], fn: () => ({ met: false, evidence: {} }) } as const;
    const g = gate({ ...spec, decisive_phrases: { 'DocumentReference/doc-long': 'stop apixaban' } });
    const failed = [{ id: 'G1', kind: 'gate', method: 'code', category: 'reasoning', points: null, met: false, evidence: {} }] satisfies CheckResult[];
    const knee = stepsOf(trajectory([call('search_notes', { query: 'knee' }), { name: 'finish' }]));
    expect(knee[0]!.shown['DocumentReference/doc-long']).not.toContain('apixaban');
    expect(firstExposed(knee, 'DocumentReference/doc-long')).toBeNull();
    expect(attribute('FAIL', [g], failed, knee)).toMatchObject({ auto: 'retrieval', exposure: [{ id: 'DocumentReference/doc-long', first_exposed_step: null, first_shown_step: null }] });
    const plan = stepsOf(trajectory([call('search_notes', { query: 'knee' }), call('search_notes', { query: 'apixaban' }), { name: 'finish' }]));
    expect(firstExposed(plan, 'DocumentReference/doc-long')).toBeNull();
    expect(attribute('FAIL', [g], failed, plan)).toMatchObject({ auto: 'reasoning', exposure: [{ first_exposed_step: null, first_shown_step: 2 }] });
    const read = stepsOf(trajectory([call('search_notes', { query: 'knee' }), call('fhir_read', { resource_type: 'DocumentReference', id: 'doc-long' }), { name: 'finish' }]));
    expect(attribute('FAIL', [g], failed, read)).toMatchObject({ auto: 'reasoning', exposure: [{ first_exposed_step: 2, first_shown_step: 2 }] });
    // Without a declared phrase, a note counts as seen only when exposed (fhir_read), as before.
    const bare = gate(spec);
    expect(attribute('FAIL', [bare], failed, plan)).toMatchObject({ auto: 'retrieval', exposure: [{ first_exposed_step: null }] });
    expect(attribute('FAIL', [bare], failed, plan)!.exposure[0]).not.toHaveProperty('first_shown_step');
    expect(attribute('FAIL', [bare], failed, read)).toMatchObject({ auto: 'reasoning' });
  });
  it('shown text is whitespace-normalised the same way for a snippet and a fhir_read', () => {
    // reports/pr-review-exposure-1.md S2 probe.
    const text = 'Seen for follow-up.\nPlan:   STOP\n apixaban per cardiology.';
    const w = { ...ctx, world: new Store([...INITIAL, note('doc-ws', text)]) };
    const call = (name: string, input: unknown) => {
      const r = callTool(READ_TOOLS, name, input, w);
      return { name, input, content: r.content, exposed: r.exposed_ids, referenced: r.referenced_ids };
    };
    const steps = stepsOf(trajectory([call('search_notes', { query: 'apixaban' }), call('fhir_read', { resource_type: 'DocumentReference', id: 'doc-ws' })]));
    expect(steps[1]!.shown['DocumentReference/doc-ws']).toBe('Seen for follow-up. Plan: STOP apixaban per cardiology.');
    expect(steps[0]!.shown['DocumentReference/doc-ws']).toContain('STOP apixaban');
    const [snippet, whole] = [steps.slice(0, 1), steps.slice(1)];
    expect(shows(snippet, 'doc-ws', 3, 'stop   APIXABAN')).toBe(true);
    expect(shows(whole, 'doc-ws', 3, 'stop   APIXABAN')).toBe(true);
    expect(shows(whole, 'doc-ws', 3, 'Plan: stop apixaban')).toBe(true);
  });
  it('an inbox row naming the patient does not expose it', () => {
    const steps = stepsOf(trajectory([read('list_inbox', { queue: 'results' }), read('fhir_read', { resource_type: 'Patient', id: 'pt-1' })]));
    expect(steps[0]!.referenced_ids).toEqual(['Observation/obs-scr-1020', 'Patient/pt-1', 'Task/task-1']);
    expect(firstExposed(steps, 'Patient/pt-1')).toBe(2);
  });
});
