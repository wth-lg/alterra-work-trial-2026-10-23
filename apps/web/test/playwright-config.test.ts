import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

// The web server Playwright starts belongs to this run only: it is never reused, and its port
// is free when the run starts (or PW_PORT), so two worktrees never test each other's dist/.
const config = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), '..', 'playwright.config.ts')).href;

function load(env: Record<string, string>) {
  const code = `const c = (await import(${JSON.stringify(config)})).default; process.stdout.write(JSON.stringify({ reuse: c.webServer.reuseExistingServer, command: c.webServer.command, url: c.webServer.url, base: c.use.baseURL, port: process.env.PW_PORT }));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', ...env } });
  return JSON.parse(out) as { reuse: boolean; command: string; url: string; base: string; port: string };
}

describe('playwright.config.ts', () => {
  it('never reuses an existing server, in CI or locally', () => {
    expect(load({}).reuse).toBe(false);
    expect(load({ CI: '1' }).reuse).toBe(false);
  });

  it('serves on PW_PORT when it is set', () => {
    const c = load({ PW_PORT: '5999' });
    expect(c.command).toContain('--port 5999 --strictPort');
    expect(c.url).toBe('http://localhost:5999/clinical-agent-env/');
    expect(c.base).toBe(c.url);
  });

  it('otherwise picks a free port per run and exports it as PW_PORT, so workers use the same one', () => {
    const c = load({});
    expect(Number(c.port)).toBeGreaterThan(0);
    expect(c.command).toContain(`--port ${c.port} --strictPort`);
    expect(c.url).toBe(`http://localhost:${c.port}/clinical-agent-env/`);
  });
});
