// Gate case (1), bind: the runner listens on 127.0.0.1 only, a connection to this machine's
// non-loopback IPv4 address on its port is refused, and with port 5180 taken main.ts starts on
// another free port and prints its URL.
import { createServer, type AddressInfo, type Server } from 'node:net';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fakeDist, http, launch, portOf, spawnRunner, tempDir } from './helpers.ts';

const tryConnect = (host: string, port: number) =>
  new Promise<void>((resolve, reject) => {
    const s = connect({ host, port });
    s.once('connect', () => {
      s.destroy();
      resolve();
    });
    s.once('error', reject);
  });

function occupy(port: number): Promise<Server | null> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once('error', () => resolve(null)); // already taken by someone else: as good
    s.listen(port, '127.0.0.1', () => resolve(s));
  });
}

describe('bind (gate case 1)', () => {
  it('listens on 127.0.0.1, and this machine\'s non-loopback IPv4 address refuses the port', async () => {
    const l = await launch();
    try {
      expect((l.runner.server.address() as AddressInfo).address).toBe('127.0.0.1');
      const external = Object.values(networkInterfaces()).flat().filter((i) => i !== undefined && i.family === 'IPv4' && !i.internal);
      expect(external.length, 'a non-loopback IPv4 interface to try').toBeGreaterThan(0);
      for (const i of external) await expect(tryConnect(i!.address, l.port)).rejects.toThrow(/ECONNREFUSED/);
      await expect(tryConnect('127.0.0.1', l.port)).resolves.toBeUndefined();
    } finally {
      await l.runner.shutdown();
    }
  });

  it('starts on another free port when 5180 is taken, prints its URL and exits 0 on SIGINT', async () => {
    const held = await occupy(5180);
    const home = tempDir('runner-bind');
    try {
      const c = spawnRunner(['--mock'], { HOME: home, CLINENV_RUNS_DIR: join(home, 'runs'), NODE_ENV: 'test', CLINENV_TEST_HOOKS: '1', CLINENV_WEB_DIST: fakeDist() });
      const url = await c.url;
      expect(portOf(url)).not.toBe(5180);
      expect(c.stdout()).toMatch(/^clinenv local runner: http:\/\/127\.0\.0\.1:\d+\/clinical-agent-env\/$/m);
      expect(c.stdout()).toContain(`runner: port 5180 is in use; using port ${portOf(url)}\n`);
      expect((await http(portOf(url), 'GET', '/api/health')).status).toBe(200);
      c.child.kill('SIGINT');
      expect((await c.exit).code).toBe(0);
    } finally {
      held?.close();
    }
  });

  it('takes --port, else CLINENV_PORT', async () => {
    const free = await new Promise<number>((resolve) => {
      const s = createServer().listen(0, '127.0.0.1', () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    const home = tempDir('runner-port');
    const env = { HOME: home, CLINENV_RUNS_DIR: join(home, 'runs'), NODE_ENV: 'test', CLINENV_TEST_HOOKS: '1', CLINENV_WEB_DIST: fakeDist() };
    const a = spawnRunner(['--mock', '--port', String(free)], env);
    expect(portOf(await a.url)).toBe(free);
    expect(a.stdout()).not.toContain('is in use');
    a.child.kill('SIGINT');
    expect((await a.exit).code).toBe(0);
    const b = spawnRunner(['--mock'], { ...env, CLINENV_PORT: String(free) });
    expect(portOf(await b.url)).toBe(free);
    b.child.kill('SIGTERM');
    expect((await b.exit).code).toBe(0);
  });
});
