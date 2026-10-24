// P12b fix round: a key-shaped query value is refused; a key-shaped path is redacted from the
// request log and the 404 body; the server has short header and request timeouts and a
// connection cap; main.ts honors its test hooks only with CLINENV_TEST_HOOKS=1; the errors an
// interviewer sees name the UI, not routes or variables; shutdown() reports a batch that did not
// close in time.
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

  it('redacts a key-shaped path from the request log and the 404 body', async () => {
    const key = sentinels().skAnt;
    const l = await launch();
    try {
      const api = await l.http('GET', `/api/trials/${key}`);
      expect(api.status).toBe(404);
      expect(api.text).not.toContain(key);
      expect(api.text).toContain('[redacted]');
      expect((await l.http('GET', `${BASE}assets/${key}.js`)).status).toBe(404);
      await until('the log lines', () => l.logs.filter((x) => x.includes('404')).length >= 2);
      const log = l.logs.join('\n');
      expect(log).not.toContain(key);
      expect(log).toContain('[redacted]');
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

  it('decodes a percent-encoded path before redacting it from the log and the 404 body', async () => {
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
      expect(log).toContain('[redacted]');
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
