import { gzipSync } from 'node:zlib';
import type { Identifier, Observation, Resource } from '@medplum/fhirtypes';
import { describe, expect, it } from 'vitest';
import { loadStore, parseNdjson, type FixtureSource } from '../fixture-source.ts';
import { stateHash } from '../hash.ts';
import { search, SearchError } from '../search.ts';
import { Store } from '../store.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const source = (bytes: Uint8Array): FixtureSource => ({ read: async () => bytes });

const obs = (id: string, extra: Partial<Observation> = {}): Observation => ({
  resourceType: 'Observation',
  id,
  status: 'final',
  code: { coding: [{ system: 'http://loinc.org', code: '2160-0' }] },
  subject: { reference: 'Patient/pt-1' },
  ...extra,
});

const ids = (store: Store, type: string, query: Record<string, string | string[]>) =>
  store.search(type, query).resources.map((r) => r.id);

describe('Store', () => {
  it('reads by type and id and keeps insertion order', () => {
    const store = new Store([obs('b'), obs('a'), { resourceType: 'Patient', id: 'pt-1' }]);
    expect(store.get('Observation', 'a')?.id).toBe('a');
    expect(store.get('Observation', 'zz')).toBeUndefined();
    expect(store.get('Patient', 'a')).toBeUndefined();
    expect([...store.resources()].map((r) => r.id)).toEqual(['b', 'a', 'pt-1']);
    expect(store.size).toBe(3);
  });

  it('refuses duplicate ids and resources without a type or id', () => {
    expect(() => new Store([obs('a'), obs('a')])).toThrow(/Observation\/a/);
    expect(() => new Store([{ resourceType: 'Observation' } as Resource])).toThrow(/id/);
    expect(() => new Store([{ id: 'x' } as unknown as Resource])).toThrow(/resourceType/);
  });

  it('put creates or replaces, and a replaced resource keeps its place', () => {
    const store = new Store([obs('a'), obs('b')]);
    store.put(obs('a', { status: 'amended' }));
    store.put(obs('c'));
    expect(store.get<Observation>('Observation', 'a')?.status).toBe('amended');
    expect([...store.resources()].map((r) => r.id)).toEqual(['a', 'b', 'c']);
  });

  it('hands out frozen resources, so a read can never change state', () => {
    const input = obs('a');
    const store = new Store([input]);
    const read = store.get<Observation>('Observation', 'a')!;
    expect(() => {
      (read as { status: string }).status = 'cancelled';
    }).toThrow(TypeError);
    expect(() => (read.code!.coding as unknown[]).push({})).toThrow(TypeError);
    // put copies its argument, so the caller's object stays theirs.
    const mine = obs('b');
    store.put(mine);
    mine.status = 'cancelled';
    expect(store.get<Observation>('Observation', 'b')?.status).toBe('final');
  });

  it('never freezes or shares the caller\'s objects, even shallow-frozen ones', async () => {
    const plain = obs('a', { effectiveDateTime: '2026-10-01' });
    // Frozen at the top only: its code and subject stay mutable.
    const shallow = Object.freeze(obs('b', { effectiveDateTime: '2026-10-02' }));
    const input = [plain, shallow];
    const one = new Store(input);
    const two = new Store(input);
    const before = await stateHash(one.resources());
    expect(await stateHash(two.resources())).toBe(before);
    expect(Object.isFrozen(plain)).toBe(false);
    expect(Object.isFrozen(plain.code)).toBe(false);
    // Every nested stored object is frozen, including those under an already-frozen top.
    const stored = one.get<Observation>('Observation', 'b')!;
    expect(Object.isFrozen(stored.subject)).toBe(true);
    expect(Object.isFrozen(stored.code!.coding![0])).toBe(true);
    // The caller changes their objects; neither store sees it.
    plain.status = 'cancelled';
    plain.code!.coding![0]!.code = 'zz';
    shallow.subject!.reference = 'Patient/pt-2';
    shallow.code!.coding![0]!.code = 'zz';
    for (const store of [one, two]) {
      expect(store.get<Observation>('Observation', 'a')?.status).toBe('final');
      expect(store.get<Observation>('Observation', 'b')?.subject?.reference).toBe('Patient/pt-1');
      expect(ids(store, 'Observation', { patient: 'pt-2' })).toEqual([]);
      expect(ids(store, 'Observation', { code: '2160-0' })).toEqual(['a', 'b']);
      expect(await stateHash(store.resources())).toBe(before);
    }
  });

  it('put and the constructor reject dates search cannot read, naming the resource', () => {
    const bad: Array<Partial<Observation>> = [
      { effectiveDateTime: '23/10/2026' },
      { effectiveDateTime: '2026-10-23T12:00:00+05:99' },
      { effectiveDateTime: '2026-10-23T12:00:00+15:00' },
      { effectiveDateTime: '2026-10-23T12:00:00+14:30' },
      { effectiveDateTime: '2026-10-23T12:00:00-14:01' },
      { effectiveDateTime: '0100-02-29' },
      { effectivePeriod: { start: '2026-10-23', end: 'soon' } },
    ];
    const store = new Store([obs('a')]);
    for (const extra of bad) {
      expect(() => store.put(obs('x', extra)), JSON.stringify(extra)).toThrow(/Observation\/x.*not a FHIR date/);
      expect(() => new Store([obs('x', extra)]), JSON.stringify(extra)).toThrow(/Observation\/x.*not a FHIR date/);
    }
    expect(store.get('Observation', 'x')).toBeUndefined();
    // So no stored value can make a date query or a sort throw.
    expect(ids(store, 'Observation', { date: 'ge2026-01-01', _sort: 'date' })).toEqual([]);
    for (const ok of ['2026-10-23T12:00:00+14:00', '2026-10-23T12:00:00-14:00', '2026-10-23T12:00:00-12:00', '0000-02-29']) {
      expect(() => store.put(obs('y', { effectiveDateTime: ok })), ok).not.toThrow();
    }
  });

  it('put rejects values with no JSON form: sparse arrays and undefined elements', () => {
    const store = new Store([]);
    const sparse = obs('s', { identifier: [{ value: '1' }, , { value: '3' }] as Identifier[] });
    expect(() => store.put(sparse)).toThrow(/sparse/);
    expect(() => store.put(obs('u', { identifier: [undefined] as unknown as Identifier[] }))).toThrow(/no JSON form/);
    expect(() => new Store([sparse])).toThrow(/sparse/);
    expect(store.size).toBe(0);
  });

  it('has no clear(): a fresh trial builds a fresh store', () => {
    expect('clear' in new Store([])).toBe(false);
  });
});

describe('fixture source', () => {
  const lines = [obs('a'), { resourceType: 'Patient', id: 'pt-1', name: [{ given: ['Zoë'] }] }].map((r) => JSON.stringify(r));

  it('parses NDJSON, plain or gzipped, into the same resources', async () => {
    const plain = enc(lines.join('\n') + '\n');
    expect(await parseNdjson(plain)).toEqual(await parseNdjson(gzipSync(plain)));
    expect((await parseNdjson(plain)).map((r) => r.id)).toEqual(['a', 'pt-1']);
    // A missing final newline, CRLF and a BOM are all accepted.
    expect(await parseNdjson(enc('﻿' + lines.join('\r\n')))).toEqual(await parseNdjson(plain));
  });

  it('loadStore reads its source once and builds a store', async () => {
    let reads = 0;
    const store = await loadStore({ read: async () => (reads++, enc(lines.join('\n'))) });
    expect(reads).toBe(1);
    expect(store.size).toBe(2);
  });

  it('refuses malformed input with the line number', async () => {
    await expect(parseNdjson(enc(`${lines[0]}\n{"resourceType":`))).rejects.toThrow(/line 2/);
    await expect(parseNdjson(enc(`${lines[0]}\n\n${lines[1]}\n`))).rejects.toThrow(/line 2.*empty/);
    await expect(parseNdjson(enc('[1,2]\n'))).rejects.toThrow(/line 1.*object/);
    await expect(parseNdjson(enc('{"resourceType":"Patient"}\n'))).rejects.toThrow(/line 1.*id/);
    await expect(parseNdjson(enc(`${lines[0]}\n${lines[0]}\n`))).rejects.toThrow(/line 2.*Observation\/a/);
    await expect(parseNdjson(new Uint8Array([0x7b, 0xff, 0x7d]))).rejects.toThrow();
    await expect(parseNdjson(new Uint8Array([0x1f, 0x8b, 0x00]))).rejects.toThrow();
    await expect(loadStore(source(enc('')))).resolves.toHaveProperty('size', 0);
  });
});

describe('search semantics outside the differential test', () => {
  it('sorts by instant, not by the date string, across offsets', () => {
    // 08:00-04:00 is 12:00Z and 11:30+01:00 is 10:30Z, the reverse of their string order.
    const store = new Store([
      obs('a', { effectiveDateTime: '2026-10-01T08:00:00-04:00' }),
      obs('b', { effectiveDateTime: '2026-10-01T11:00:00Z' }),
      obs('c', { effectiveDateTime: '2026-10-01T11:30:00+01:00' }),
      obs('d'),
    ]);
    expect(ids(store, 'Observation', { _sort: 'date' })).toEqual(['c', 'b', 'a', 'd']);
    // A resource without a date goes last in both directions.
    expect(ids(store, 'Observation', { _sort: '-date' })).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(store, 'Observation', { _sort: '-date', _count: '1' })).toEqual(['a']);
  });

  it('a month value ends on the last day of that month', () => {
    // Medplum fills every month to day 31, so it reads 2026-09 as ending on 1 October.
    const store = new Store([obs('sep', { effectiveDateTime: '2026-09' }), obs('feb', { effectiveDateTime: '2026-02' })]);
    expect(ids(store, 'Observation', { date: 'ge2026-09-30T23:00:00Z' })).toEqual(['sep']);
    expect(ids(store, 'Observation', { date: 'ge2026-10-01' })).toEqual([]);
    expect(ids(store, 'Observation', { date: 'ge2026-02-28' })).toEqual(['sep', 'feb']);
    expect(ids(store, 'Observation', { date: 'ge2026-03-01' })).toEqual(['sep']);
  });

  it('periods use their bounds and an open end runs forever', () => {
    const store = new Store([
      { resourceType: 'Encounter', id: 'open', status: 'in-progress', class: { code: 'AMB' }, period: { start: '2026-10-20' } },
      { resourceType: 'Encounter', id: 'shut', status: 'finished', class: { code: 'AMB' }, period: { start: '2026-01-01', end: '2026-01-02' } },
    ]);
    expect(ids(store, 'Encounter', { date: 'gt2030-01-01' })).toEqual(['open']);
    expect(ids(store, 'Encounter', { date: 'lt2026-01-02' })).toEqual(['shut']);
    expect(ids(store, 'Encounter', { date: ['ge2026-01-02', 'le2026-01-02'] })).toEqual(['shut']);
  });

  it('a period end covers the whole of its last unit', () => {
    // end 2026-10-23 runs to 23:59:59.999Z, so the encounter is still on at 18:00Z.
    const store = new Store([
      { resourceType: 'Encounter', id: 'day', status: 'finished', class: { code: 'AMB' }, period: { start: '2026-10-22T08:00:00Z', end: '2026-10-23' } },
      { resourceType: 'Encounter', id: 'min', status: 'finished', class: { code: 'AMB' }, period: { start: '2026-10-22T08:00:00Z', end: '2026-10-23T18:00' } },
    ]);
    expect(ids(store, 'Encounter', { date: 'ge2026-10-23T18:00:00Z' })).toEqual(['day', 'min']);
    expect(ids(store, 'Encounter', { date: 'gt2026-10-23T18:00:00Z' })).toEqual(['day', 'min']);
    expect(ids(store, 'Encounter', { date: 'gt2026-10-23T18:01:00Z' })).toEqual(['day']);
    expect(ids(store, 'Encounter', { date: 'ge2026-10-24' })).toEqual([]);
  });

  it('eq and a bare date match a resource whose range lies within the query range', () => {
    const enc = (id: string, start: string, end?: string): Resource =>
      ({ resourceType: 'Encounter', id, status: 'finished', class: { code: 'AMB' }, period: end ? { start, end } : { start } }) as Resource;
    const store = new Store([
      obs('day', { effectiveDateTime: '2026-10-23' }),
      obs('sec', { effectiveDateTime: '2026-10-23T12:00:00Z' }),
      obs('local', { effectiveDateTime: '2026-10-23T22:00:00-04:00' }), // 2026-10-24T02:00Z
      obs('month', { effectiveDateTime: '2026-10' }),
      obs('next', { effectiveDateTime: '2026-10-24' }),
      obs('none'),
      enc('inside', '2026-10-23T09:00:00Z', '2026-10-23T10:00:00Z'),
      enc('across', '2026-10-22T20:00:00Z', '2026-10-23T02:00:00Z'),
      enc('open', '2026-10-23T09:00:00Z'),
    ]);
    for (const q of ['2026-10-23', 'eq2026-10-23']) {
      expect(ids(store, 'Observation', { date: q }), q).toEqual(['day', 'sec']);
      // An encounter that only overlaps the day, or never ends, is not within it.
      expect(ids(store, 'Encounter', { date: q }), q).toEqual(['inside']);
    }
    // A coarser resource is not within a finer query.
    expect(ids(store, 'Observation', { date: '2026-10-23T12:00:00Z' })).toEqual(['sec']);
    expect(ids(store, 'Observation', { date: '2026-10' })).toEqual(['day', 'sec', 'local', 'month', 'next']);
    expect(ids(store, 'Observation', { date: '2026' })).toEqual(['day', 'sec', 'local', 'month', 'next']);
    expect(ids(store, 'Observation', { date: '2026-10-24' })).toEqual(['local', 'next']);
    expect(ids(store, 'Observation', { date: '2026-10-23,2026-10-24' })).toEqual(['day', 'sec', 'local', 'next']);
    expect(ids(store, 'Observation', { date: ['eq2026-10', 'ge2026-10-24'] })).toEqual(['local', 'month', 'next']);
  });

  it('reads years 0000-0099 as those years', () => {
    const store = new Store([obs('y50', { effectiveDateTime: '0050-06-01' }), obs('y0', { effectiveDateTime: '0000-02-29' })]);
    expect(ids(store, 'Observation', { date: 'ge1950-01-01' })).toEqual([]);
    expect(ids(store, 'Observation', { date: 'lt1000-01-01' })).toEqual(['y50', 'y0']);
    expect(ids(store, 'Observation', { date: '0050' })).toEqual(['y50']);
    expect(ids(store, 'Observation', { date: 'lt0050-06-01' })).toEqual(['y0']);
    expect(ids(store, 'Observation', { _sort: 'date' })).toEqual(['y0', 'y50']);
  });

  it('applies _offset before _count and reports the total before paging', () => {
    const store = new Store(['a', 'b', 'c', 'd', 'e'].map((id) => obs(id)));
    const page = store.search('Observation', { _offset: '1', _count: '2' });
    expect(page.resources.map((r) => r.id)).toEqual(['b', 'c']);
    expect(page.total).toBe(5);
    expect(ids(store, 'Observation', { _count: '0' })).toEqual([]);
  });

  it('refuses what it does not implement, naming the parameter', () => {
    const store = new Store([obs('a')]);
    const bad: Array<[string, Record<string, string>]> = [
      ['Observation', { 'code:not': '2160-0' }],
      ['Observation', { 'value-quantity': '5' }],
      ['Observation', { date: 'ne2026-10-01' }],
      ['Observation', { date: 'sa2026-10-01' }],
      ['Observation', { date: 'ge2026-10-01T12:00:00+05:99' }],
      ['Observation', { date: 'ge0100-02-29' }],
      ['Observation', { date: 'ge2026-13-01' }],
      ['Observation', { date: 'genot-a-date' }],
      ['Observation', { _sort: 'code' }],
      ['Observation', { _count: '-1' }],
      ['Observation', { _offset: '1.5' }],
      ['Observation', { code: '|' }],
      ['Observation', { status: '' }],
      ['Patient', { date: 'ge2026-01-01' }],
      ['Patient', { _sort: 'date' }],
      ['Patient', { toString: 'x' }],
      ['Basic', {}],
      ['constructor', { name: 'x' }],
      ['__proto__', {}],
      ['hasOwnProperty', {}],
    ];
    for (const [type, query] of bad) {
      expect(() => store.search(type, query), `${type} ${JSON.stringify(query)}`).toThrow(SearchError);
      expect(() => search([], type, query), `${type} ${JSON.stringify(query)}`).toThrow(SearchError);
    }
    // A known type with none of these parameters still pages.
    expect(new Store([{ resourceType: 'Patient', id: 'p' }]).search('Patient', { _count: '1' }).total).toBe(1);
    expect(() => store.search('Observation', { _count: ['1', '2'] })).toThrow(/_count/);
  });

  it('splits OR values on unescaped commas only', () => {
    const store = new Store([obs('a', { status: 'final' }), obs('b', { status: 'amended' })]);
    expect(ids(store, 'Observation', { status: 'amended,final' })).toEqual(['a', 'b']);
    expect(ids(store, 'Observation', { status: 'amended\\,final' })).toEqual([]);
  });
});
