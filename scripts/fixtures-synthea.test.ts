// The Synthea base cohort's generator and prune (fixtures/synthea/generate.sh,
// scripts/fixtures-synthea.ts): the output may depend only on the committed flags and the
// export, never on the host's locale, the day it runs or a bad download.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { eastern, NOW_MS } from '../packages/env/clock.ts';

const repo = fileURLToPath(new URL('..', import.meta.url));
const temp = (prefix: string) => mkdtempSync(join(tmpdir(), `${prefix}-`));
const compact = (isoDate: string) => isoDate.replaceAll('-', '');

// Two living patients born the same day and three same-day Observations of one code, with
// Synthea ids that a Danish collation orders differently from code points ('aa' sorts as
// 'å', after 'z'). The patient order sets pt-0001/pt-0002, and the per-code cap of 2 keeps
// whichever two Observations sort last.
function syntheaExport(dir: string): void {
  const patient = (id: string) => ({ resourceType: 'Patient', id, birthDate: '1950-02-03', gender: 'male', name: [{ family: id }] });
  const obs = (id: string, patientId: string) => ({
    resourceType: 'Observation',
    id,
    status: 'final',
    category: [{ coding: [{ code: 'laboratory' }] }],
    code: { coding: [{ system: 'http://loinc.org', code: '2160-0' }] },
    subject: { reference: `urn:uuid:${patientId}` },
    effectiveDateTime: '2026-09-01T09:00:00-04:00',
    valueQuantity: { value: 1.1, unit: 'mg/dL' },
  });
  const bundle = (p: string, extra: object[]) => ({ resourceType: 'Bundle', entry: [patient(p), ...extra].map((resource) => ({ resource })) });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'A_a.json'), JSON.stringify(bundle('aab00000', [obs('aab10000', 'aab00000'), obs('b0020000', 'aab00000'), obs('c0030000', 'aab00000')])));
  writeFileSync(join(dir, 'B_b.json'), JSON.stringify(bundle('b0010000', [])));
}

function prune(locale: string): string {
  const dir = temp('synthea-prune');
  syntheaExport(join(dir, 'fhir'));
  const r = spawnSync(process.execPath, ['scripts/fixtures-synthea.ts', join(dir, 'fhir'), join(dir, 'out'), '--synthea', 'test', '--jar-sha256', '0', '--', '-s', '1'], {
    cwd: repo,
    env: { ...process.env, LC_ALL: locale, LANG: locale },
    encoding: 'utf8',
  });
  expect(r.stderr).toBe('');
  expect(r.status).toBe(0);
  return (JSON.parse(readFileSync(join(dir, 'out/base.json'), 'utf8')) as { ndjson_sha256: string }).ndjson_sha256;
}

describe('prune', () => {
  it('gives the same base under a Danish locale as under C', () => {
    // The host must actually collate Danish for this to test anything.
    const danish = spawnSync(process.execPath, ['-e', "console.log(['b','aa'].sort((x,y)=>x.localeCompare(y)).join())"], { env: { ...process.env, LC_ALL: 'da_DK.UTF-8' }, encoding: 'utf8' });
    expect(danish.stdout.trim()).toBe('b,aa');
    expect(prune('da_DK.UTF-8')).toBe(prune('C'));
  });

  it('no fixtures script sorts with localeCompare', () => {
    const scripts = readdirSync(join(repo, 'scripts')).filter((f) => /^fixtures-.*\.ts$/.test(f) && !f.endsWith('.test.ts'));
    expect(scripts.length).toBeGreaterThan(0);
    for (const f of scripts) expect(readFileSync(join(repo, 'scripts', f), 'utf8'), f).not.toMatch(/\.localeCompare\(|Intl\.Collator/);
  });
});

describe('generate.sh', () => {
  const script = readFileSync(join(repo, 'fixtures/synthea/generate.sh'), 'utf8');

  it('runs with LC_ALL=C', () => {
    expect(script).toMatch(/^export LC_ALL=C$/m);
  });

  it('pins the reference date to NOW and the end date to the day after, both read from clock.ts', () => {
    const { args } = JSON.parse(readFileSync(join(repo, 'fixtures/synthea/base.json'), 'utf8')) as { args: string[] };
    const flag = (f: string) => args[args.indexOf(f) + 1];
    expect(flag('-r')).toBe(compact(eastern(NOW_MS).slice(0, 10)));
    expect(flag('-e')).toBe(compact(eastern(NOW_MS + 86_400_000).slice(0, 10)));
    const dates = spawnSync(process.execPath, ['scripts/fixtures-synthea.ts', '--dates'], { cwd: repo, encoding: 'utf8' });
    expect(dates.stdout.trim()).toBe(`${flag('-r')} ${flag('-e')}`);
    expect(script).not.toMatch(/-[re] \d/);
  });

  it('deletes a download whose SHA-256 is wrong and leaves nothing in the cache', () => {
    const dir = temp('synthea-jar');
    const bin = join(dir, 'bin');
    const cache = join(dir, 'cache');
    mkdirSync(bin);
    // curl "downloads" junk; java must never be reached.
    writeFileSync(join(bin, 'curl'), '#!/bin/sh\nwhile [ "$#" -gt 0 ]; do [ "$1" = -o ] && { echo junk > "$2"; exit 0; }; shift; done\nexit 1\n');
    writeFileSync(join(bin, 'java'), '#!/bin/sh\necho "java reached" >&2\nexit 99\n');
    chmodSync(join(bin, 'curl'), 0o755);
    chmodSync(join(bin, 'java'), 0o755);
    const r = spawnSync('bash', [join(repo, 'fixtures/synthea/generate.sh'), join(dir, 'out')], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, SYNTHEA_CACHE: cache },
      encoding: 'utf8',
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SHA-256');
    expect(r.stderr).not.toContain('java reached');
    expect(existsSync(cache) ? readdirSync(cache) : []).toEqual([]);
  });
});
