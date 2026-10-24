// Gate case (3), origin and CSRF: a foreign Origin, an Origin of another port, a Host/Origin
// pair that does not match, a foreign Host (DNS rebinding) even with the token, a missing or
// wrong token, Sec-Fetch-Site cross-site, a text/plain POST and an OPTIONS preflight are each
// refused with a 4xx, start no trial and write no ledger row; a same-origin request with the
// token is accepted as 127.0.0.1 and as localhost; no response carries an Access-Control header.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { launch, toyTrial, type HttpResult } from './helpers.ts';

const ledgerRows = (home: string) => {
  const f = join(home, '.clinenv', 'spend.jsonl');
  return existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter((l) => l.trim() !== '').length : 0;
};

const noCors = (r: HttpResult) => {
  for (const h of Object.keys(r.headers)) expect(h.toLowerCase().startsWith('access-control-'), h).toBe(false);
};

describe('origin and CSRF (gate case 3)', () => {
  it('refuses every cross-origin, rebinding, tokenless or non-JSON request, and accepts same-origin with the token', async () => {
    const l = await launch({ mock: true, transport: null });
    const p = l.port;
    const T = '/api/trials';
    try {
      const refused: Array<[string, () => Promise<HttpResult>]> = [
        ['Origin http://evil.example', () => l.http('POST', T, { body: toyTrial(), origin: 'http://evil.example' })],
        ['Origin of another port', () => l.http('POST', T, { body: toyTrial(), origin: `http://127.0.0.1:${p + 1}` })],
        ['Host localhost with Origin 127.0.0.1', () => l.http('POST', T, { body: toyTrial(), host: `localhost:${p}`, origin: `http://127.0.0.1:${p}` })],
        ['Host 127.0.0.1 with Origin localhost', () => l.http('POST', T, { body: toyTrial(), origin: `http://localhost:${p}` })],
        ['Host evil.example with the token', () => l.http('POST', T, { body: toyTrial(), host: `evil.example:${p}` })],
        ['Host evil.example, no Origin, GET health', () => l.http('GET', '/api/health', { host: `evil.example:${p}` })],
        ['Host evil.example, GET index.html', () => l.http('GET', '/clinical-agent-env/', { host: `evil.example:${p}` })],
        ['Host 127.0.0.1 on another port', () => l.http('POST', T, { body: toyTrial(), host: `127.0.0.1:${p + 1}`, origin: `http://127.0.0.1:${p + 1}` })],
        ['no token', () => l.http('POST', T, { body: toyTrial(), token: false })],
        ['wrong token', () => l.http('POST', T, { body: toyTrial(), token: '0'.repeat(64) })],
        ['token of the right length, one char off', () => l.http('POST', T, { body: toyTrial(), token: `${l.runner.token.slice(0, -1)}${l.runner.token.endsWith('0') ? '1' : '0'}` })],
        ['Sec-Fetch-Site cross-site', () => l.http('POST', T, { body: toyTrial(), headers: { 'sec-fetch-site': 'cross-site' } })],
        ['Sec-Fetch-Site same-site', () => l.http('POST', T, { body: toyTrial(), headers: { 'sec-fetch-site': 'same-site' } })],
        ['text/plain POST', () => l.http('POST', T, { body: JSON.stringify(toyTrial()), contentType: 'text/plain' })],
        ['form POST', () => l.http('POST', T, { body: 'tasks=_toy', contentType: 'application/x-www-form-urlencoded' })],
        ['OPTIONS preflight', () => l.http('OPTIONS', T, { headers: { 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-clinenv-token,content-type' }, origin: 'http://evil.example' })],
        ['OPTIONS same-origin', () => l.http('OPTIONS', T, {})],
        ['GET runs without the token', () => l.http('GET', '/api/runs', { token: false })],
      ];
      for (const [name, send] of refused) {
        const r = await send();
        expect(r.status, name).toBeGreaterThanOrEqual(400);
        expect(r.status, name).toBeLessThan(500);
        noCors(r);
      }
      const runs = await l.http('GET', '/api/runs');
      expect(runs.json()).toEqual({ runs: [] });
      expect(ledgerRows(l.home)).toBe(0);

      const a = await l.http('POST', T, { body: toyTrial() });
      expect(a.status).toBe(202);
      noCors(a);
      const b = await l.http('POST', T, { body: toyTrial(), host: `localhost:${p}`, origin: `http://localhost:${p}` });
      expect(b.status).toBe(202);
      noCors(b);
      // A same-origin fetch GET sends no Origin; with Sec-Fetch-Site same-origin it is accepted.
      const g = await l.http('GET', '/api/runs', { headers: { 'sec-fetch-site': 'same-origin' } });
      expect(g.status).toBe(200);
      expect((g.json() as { runs: unknown[] }).runs).toHaveLength(2);
      // A typed URL (Sec-Fetch-Site none) opens the page; the API needs same-origin.
      expect((await l.http('GET', '/clinical-agent-env/', { headers: { 'sec-fetch-site': 'none' } })).status).toBe(200);
      expect((await l.http('GET', '/api/runs', { headers: { 'sec-fetch-site': 'none' } })).status).toBe(403);
    } finally {
      await l.runner.shutdown();
    }
  });
});
