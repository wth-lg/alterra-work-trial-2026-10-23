/* eslint-disable local/isomorphic-imports -- Node-only test: node:zlib builds gzipped input. */
import { gzipSync } from 'node:zlib';
import type { Observation, Resource } from '@medplum/fhirtypes';
import { describe, expect, it } from 'vitest';
import { loadStore, parseNdjson, type FixtureSource } from '../fixture-source.ts';
import { SearchError } from '../search.ts';
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
    expect(ids(store, 'Observation', { _sort: '-date' })).toEqual(['d', 'a', 'b', 'c']);
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
      ['Observation', { date: '2026-10-01' }],
      ['Observation', { date: 'sa2026-10-01' }],
      ['Observation', { date: 'ge2026-13-01' }],
      ['Observation', { date: 'genot-a-date' }],
      ['Observation', { _sort: 'code' }],
      ['Observation', { _count: '-1' }],
      ['Observation', { _offset: '1.5' }],
      ['Observation', { code: '|' }],
      ['Observation', { status: '' }],
      ['Patient', { date: 'ge2026-01-01' }],
      ['Patient', { _sort: 'date' }],
    ];
    for (const [type, query] of bad) expect(() => store.search(type, query), JSON.stringify(query)).toThrow(SearchError);
    expect(() => store.search('Observation', { _count: ['1', '2'] })).toThrow(/_count/);
  });

  it('splits OR values on unescaped commas only', () => {
    const store = new Store([obs('a', { status: 'final' }), obs('b', { status: 'amended' })]);
    expect(ids(store, 'Observation', { status: 'amended,final' })).toEqual(['a', 'b']);
    expect(ids(store, 'Observation', { status: 'amended\\,final' })).toEqual([]);
  });
});
