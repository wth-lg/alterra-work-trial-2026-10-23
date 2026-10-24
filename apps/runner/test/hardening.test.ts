// P12b fix round: a key-shaped query value is refused at any encoding depth; no request path
// reaches the request log or a 404 or 405 body (route templates only); the server has short
// header and request timeouts and a connection cap; main.ts honors its test hooks only with
// CLINENV_TEST_HOOKS=1; the errors an interviewer sees name the UI, not routes or variables;
// shutdown() reports a batch that did not close in time.
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROJECTED_CAP_USD } from '../../../packages/core/ledger.ts';
import { BASE, fakeDist, http, launch, sentinels, spawnRunner, tempDir, toyTrial, until } from './helpers.ts';

const KEY = 'hardening-test-key-0123456789';

describe('runner hardening', () => {
  it('refuses a query value shaped like an sk-ant key under any name, on static and API paths', async () => {
    const key = sentinels().skAnt;
    const l = await launch();
    try {
      for (const path of [`${BASE}?x=${key}`, `/?view=${key}`, `/api/trials?dry_run=${key}`, `${BASE}assets/index-abc.js?v=${encodeURIComponent(key)}`]) {
        const r = await l.http(path.startsWith('/api/') ? 'POST' : 'GET', path, path.startsWith('/api/') ? { body: toyTrial() } : {});
        expect(r.status, path).toBe(400);
        expect(r.text, path).not.toContain(key);
      }
      expect(l.logs.join('\n')).not.toContain(key);
    } finally {
      await l.runner.shutdown();
    }
  });

  it('keeps a key-shaped path out of the request log and the 404 body', async () => {
    const key = sentinels().skAnt;
    const l = await launch();
    try {
      const api = await l.http('GET', `/api/trials/${key}`);
      expect(api.status).toBe(404);
      expect(api.text).not.toContain(key);
      expect(api.text).not.toMatch(/sk-ant|redacted/);
      expect((await l.http('GET', `${BASE}assets/${key}.js`)).status).toBe(404);
      await until('the log lines', () => l.logs.filter((x) => x.includes('404')).length >= 2);
      const log = l.logs.join('\n');
      expect(log).not.toContain(key);
      expect(log).toMatch(/GET \/api\/trials\/:id 404 /);
      expect(log).toContain(`GET ${BASE}* 404 `);
    } finally {
      await l.runner.shutdown();
    }
  });

  it('refuses a query name shaped like an sk-ant key, and / does not echo it in Location', async () => {
    const key = sentinels().skAnt;
    const l = await launch();
    try {
      for (const path of [`/?${key}`, `/?${key}=1`, `${BASE}?${key}=1`, `${BASE}?${encodeURIComponent(key).replace('s', '%73')}=1`]) {
        const r = await l.http('GET', path);
        expect(r.status, path).toBe(400);
        expect(JSON.stringify(r.headers) + r.text, path).not.toContain(key);
      }
    } finally {
      await l.runner.shutdown();
    }
  });

  it('keeps a percent-encoded key path out of the log and the 404 body', async () => {
    const { skAnt: key } = sentinels();
    const l = await launch();
    try {
      // The key is held, so its exact text is redacted too; the tail is what must not leak.
      expect((await l.http('POST', '/api/key', { body: { key } })).status).toBe(200);
      const tail = key.slice(20);
      const enc = (i: number) => `${key.slice(0, i)}%${key.charCodeAt(i).toString(16).toUpperCase()}${key.slice(i + 1)}`;
      const paths = [`/api/trials/${enc(0)}`, `/api/trials/${enc(2)}`, `/api/trials/${enc(16)}`, `/api/trials/${encodeURIComponent(enc(16))}`, `${BASE}assets/${enc(16)}.js`];
      for (const path of paths) {
        const r = await l.http('GET', path);
        expect(r.status, path).toBe(404);
        expect(r.text, path).not.toContain(tail);
      }
      await until('the log lines', () => l.logs.filter((x) => / 404 /.test(x)).length >= paths.length);
      const log = l.logs.join('\n');
      expect(log).not.toContain(tail);
      expect(log).not.toMatch(/sk-ant|%[0-9A-F]{2}/i);
    } finally {
      await l.runner.shutdown();
    }
  });

  it('never echoes a request path: an invalid escape or a 4x-encoded key leaks into no body or log line (review P12b-3 F1)', async () => {
    const { skAnt: key } = sentinels();
    const l = await launch();
    try {
      const tail = key.slice(20);
      const enc1 = key.replace(/s/, '%73');
      const paths = [
        `/api/%E0${enc1}`, `/api/%FF${enc1}`, `/api/%C3${enc1}`, `/api/${enc1.replace('%', '%252525')}`,
        `/api/trials/%E0${enc1}`, `/api/trials/%E0${enc1}/events`, `/api/health/%E0${enc1}`, `${BASE}api/%FF${enc1}`,
        `${BASE}%E0${enc1}/a.js`, `${BASE}assets/${enc1.replace('%', '%252525')}.js`,
      ];
      for (const path of paths) {
        const before = l.logs.length;
        const r = await l.http('GET', path);
        expect(r.status, path).toBe(404);
        expect(JSON.stringify(r.headers) + r.text, path).not.toContain(tail);
        if (path.includes('/api/')) {
          const { error } = r.json() as { error: { type: string; message: string } };
          expect(error.type, path).toBe('not_found');
          expect(error.message, path).not.toMatch(/%|sk-ant|redacted/i);
        }
        await until('the log line', () => l.logs.length > before);
        expect(l.logs.slice(before).join('\n'), path).not.toContain(tail);
      }
      const r405 = await l.http('PUT', '/api/health');
      expect(r405.status).toBe(405);
      expect((r405.json() as { error: { message: string } }).error.message).toBe('PUT is not allowed on api/health');
      const r404 = await l.http('GET', `/api/trials/${enc1}x`);
      expect((r404.json() as { error: { message: string } }).error.message).toBe('no such trial: api/trials/:id');
      // The log names the route template, or 'unmatched', never the path.
      const log = l.logs.join('\n');
      expect(log).not.toMatch(/%[0-9A-F]{2}/i);
      expect(log).toMatch(/GET \/api\/trials\/:id 404 /);
      expect(log).toMatch(/GET unmatched 404 /);
      expect(log).toMatch(/PUT \/api\/health 405 /);
    } finally {
      await l.runner.shutdown();
    }
  });

  it('refuses a key in the query at any encoding depth, so / never echoes it in Location (review P12b-3 F4)', async () => {
    const { skAnt: key } = sentinels();
    const l = await launch();
    try {
      const tail = key.slice(20);
      const enc1 = key.replace(/s/, '%73');
      const deep = (n: number) => enc1.replace('%', `%${'25'.repeat(n)}`);
      for (const path of [`/?${deep(1)}`, `/?x=${deep(1)}`, `/?x=${deep(2)}`, `/?x=${deep(5)}`, `/?x=%E0${deep(1)}`, `${BASE}?a=1&${deep(3)}=1`, `/?x=${key.replace('sk-', 'sk%252D')}`]) {
        const r = await l.http('GET', path);
        expect(r.status, path).toBe(400);
        expect(r.headers.location, path).toBeUndefined();
        expect(JSON.stringify(r.headers) + r.text, path).not.toContain(tail);
      }
      // The contract's routes keep their query.
      expect((await l.http('GET', '/?view=runs&run=final-1&q=%2541')).headers.location).toBe(`${BASE}?view=runs&run=final-1&q=%2541`);
    } finally {
      await l.runner.shutdown();
    }
  });

  it('checks the header timeout often enough that it is real', async () => {
    const l = await launch();
    try {
      // Node reads the option into this field; @types/node does not declare it.
      expect((l.runner.server as unknown as { connectionsCheckingInterval: number }).connectionsCheckingInterval).toBeLessThanOrEqual(1_000);
    } finally {
      await l.runner.shutdown();
    }
  });

  it('sets short header and request timeouts and a connection cap', async () => {
    const l = await launch();
    try {
      const s = l.runner.server;
      expect(s.headersTimeout).toBeGreaterThan(0);
      expect(s.headersTimeout).toBeLessThanOrEqual(15_000);
      expect(s.requestTimeout).toBeGreaterThan(0);
      expect(s.requestTimeout).toBeLessThanOrEqual(60_000);
      expect(Number.isFinite(s.maxConnections) && s.maxConnections > 0).toBe(true);
    } finally {
      await l.runner.shutdown();
    }
  });

  it('honors CLINENV_WEB_DIST only with CLINENV_TEST_HOOKS=1, not with NODE_ENV=test alone', async () => {
    const home = tempDir('runner-hooks');
    const env = { HOME: home, CLINENV_RUNS_DIR: join(home, 'runs'), NODE_ENV: 'test', CLINENV_WEB_DIST: fakeDist() };
    for (const [hooks, fake] of [[undefined, false], ['1', true]] as const) {
      const c = spawnRunner(['--mock', '--port', '0'], { ...env, CLINENV_TEST_HOOKS: hooks });
      const port = Number(new URL(await c.url).port);
      const page = await http(port, 'GET', `${BASE}index.html`);
      expect(page.text.includes('<title>t</title>'), `CLINENV_TEST_HOOKS=${hooks}`).toBe(fake);
      c.child.kill('SIGINT');
      expect((await c.exit).code).toBe(0);
    }
  });

  it('words the errors an interviewer sees in terms of the UI', async () => {
    const l = await launch();
    try {
      const noKey = await l.http('POST', '/api/trials', { body: toyTrial() });
      expect(noKey.status).toBe(409);
      const messages = [(noKey.json() as { error: { message: string } }).error.message];
      const smoke = await l.http('POST', '/api/trials', { body: { ...toyTrial(), smoke: true } });
      expect(smoke.status).toBe(400);
      messages.push((smoke.json() as { error: { message: string } }).error.message);
      const over = await l.http('POST', '/api/trials', { body: toyTrial({ session_cap_usd: PROJECTED_CAP_USD + 1 }) });
      expect(over.status).toBe(400);
      messages.push((over.json() as { error: { message: string } }).error.message);
      for (const m of messages) expect(m).not.toMatch(/POST|api\/|CLINENV_|PROJECTED_CAP_USD|session_cap_usd/);
      expect(messages[0]).toMatch(/API key/);
    } finally {
      await l.runner.shutdown();
    }
  });

  it('shutdown() says whether every batch closed in time', async () => {
    // A transport that ignores the abort: the trial call never ends, so its batch cannot close.
    const l = await launch({ shutdownWaitMs: 300, answer: (label) => (label.includes('validate') ? undefined : new Promise<Response>(() => {})) });
    await l.http('POST', '/api/key', { body: { key: KEY } });
    expect((await l.http('POST', '/api/trials', { body: toyTrial() })).status).toBe(202);
    await until('the trial call in flight', () => l.calls.some((c) => !c.label.includes('validate')));
    expect(await l.runner.shutdown()).toBe(false);
    const ok = await launch();
    expect(await ok.runner.shutdown()).toBe(true);
  });
});
