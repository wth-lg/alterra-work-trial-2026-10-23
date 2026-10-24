// Gate case (7), static: the built UI under the Vite base, with path escapes, symlinks out of
// dist and the two test pages refused; index.html keeps its CSP meta and gets a per-launch token
// meta; every response carries the framing and referrer headers.
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BASE, cspMeta, designCsp, fakeDist, launch, tempDir, tokenMeta } from './helpers.ts';

describe('static serving (gate case 7)', () => {
  it('refuses paths outside dist, symlinks out of it and the test pages with 404', async () => {
    const dist = fakeDist();
    const outside = tempDir('runner-outside');
    writeFileSync(join(outside, 'secret.txt'), 'outside dist\n');
    symlinkSync(join(outside, 'secret.txt'), join(dist, 'assets', 'leak.txt'));
    mkdirSync(join(dist, 'linked'), { recursive: true });
    symlinkSync(outside, join(dist, 'linked', 'dir'));
    const l = await launch({ dist });
    try {
      for (const path of [
        '/../package.json', `${BASE}../package.json`, `${BASE}..%2fpackage.json`, `${BASE}%2e%2e%2fpackage.json`, `${BASE}%2e%2e/%2e%2e/package.json`,
        `${BASE}%2E%2E%2F%2E%2E%2Fpackage.json`, `${BASE}assets/%2e%2e/%2e%2e/%2e%2e/package.json`, `${BASE}assets/leak.txt`, `${BASE}linked/dir/secret.txt`,
        `${BASE}probe.html`, `${BASE}harness.html`, '/probe.html', '/harness.html', `${BASE}assets/..%5c..%5cpackage.json`, `${BASE}%00index.html`,
        // A case-insensitive filesystem (macOS APFS) finds these too.
        `${BASE}PROBE.HTML`, `${BASE}Harness.html`, `${BASE}harness.HTML`, `${BASE}Probe.Html`, `${BASE}%50robe.html`, '/PROBE.HTML',
      ]) {
        const r = await l.http('GET', path);
        expect(r.status, path).toBe(404);
        expect(r.text, path).not.toContain('outside dist');
        expect(r.text, path).not.toContain('"name"');
      }
    } finally {
      await l.runner.shutdown();
    }
  });

  it('serves index.html with the design CSP meta and a token meta that differs per launch', async () => {
    const a = await launch();
    const b = await launch();
    try {
      const ra = await a.http('GET', BASE);
      const rb = await b.http('GET', `${BASE}index.html`);
      expect(ra.status).toBe(200);
      expect(rb.status).toBe(200);
      expect(cspMeta(ra.text)).toBe(designCsp());
      expect(cspMeta(rb.text)).toBe(designCsp());
      const ta = tokenMeta(ra.text);
      const tb = tokenMeta(rb.text);
      expect(ta).toMatch(/^[0-9a-f]{64}$/);
      expect(tb).toMatch(/^[0-9a-f]{64}$/);
      expect(ta).not.toBe(tb);
      expect(ta).toBe(a.runner.token);
      expect(ra.headers['x-frame-options']).toBe('DENY');
      expect(ra.headers['content-security-policy']).toBe("frame-ancestors 'none'");
      expect(ra.headers['referrer-policy']).toBe('no-referrer');
      expect(ra.headers['content-type']).toMatch(/^text\/html/);
    } finally {
      await a.runner.shutdown();
      await b.runner.shutdown();
    }
  });

  it('redirects / to the base keeping the query, falls back to index.html for app routes and serves assets and data', async () => {
    const l = await launch();
    try {
      const root = await l.http('GET', '/?view=runs&run=session');
      expect(root.status).toBe(302);
      expect(root.headers.location).toBe(`${BASE}?view=runs&run=session`);
      expect((await l.http('GET', '/')).headers.location).toBe(BASE);
      const route = await l.http('GET', `${BASE}?view=tasks&task=renal-dose-review&tab=prompt`);
      expect(route.status).toBe(200);
      expect(tokenMeta(route.text)).toBe(l.runner.token);
      expect((await l.http('GET', `${BASE}runs/final-1`)).status).toBe(200);
      const js = await l.http('GET', `${BASE}assets/index-abc.js`);
      expect(js.status).toBe(200);
      expect(js.headers['content-type']).toMatch(/javascript/);
      expect(js.headers['x-frame-options']).toBe('DENY');
      expect((await l.http('GET', `${BASE}data/tasks.json`)).json()).toEqual({ tasks: [] });
      expect((await l.http('GET', `${BASE}assets/missing.js`)).status).toBe(404);
      expect((await l.http('GET', '/elsewhere/index.html')).status).toBe(404);
      // The runner's own health, not the static build's file at the same path.
      expect((await l.http('GET', `${BASE}api/health`)).json()).toMatchObject({ app: 'clinenv-runner' });
      const missing = await l.http('GET', `${BASE}api/nothing`, {});
      expect(missing.status).toBe(404);
      expect(missing.headers['cache-control']).toBe('no-store');
      expect((await l.http('POST', `${BASE}assets/index-abc.js`, { body: {} })).status).toBe(405);
    } finally {
      await l.runner.shutdown();
    }
  });
});
