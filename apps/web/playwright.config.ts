import { createServer } from 'node:net';
import { defineConfig, devices } from '@playwright/test';

// Projects:
//   mocked    chromium, e2e/*.spec.ts; runs in CI
//   xbrowser  chromium, firefox and webkit, e2e/xbrowser/**; runs in CI
//   live      chromium, e2e/live/**; calls the real API, never runs in CI (scripts/ci-guard.ts).
//             Each live spec skips itself when ANTHROPIC_API_KEY is unset, so the project still
//             lists them. Trace, video, screenshot and HAR are off so a key can never land in an artifact.
// The server belongs to this run: never reused, on PW_PORT or a port free when the run starts.
// The port goes into PW_PORT so the worker processes, which load this file again, use it too,
// and two worktrees never test each other's dist/.
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
process.env.PW_PORT ??= String(await freePort());
const PORT = Number(process.env.PW_PORT);
const xbrowser = { name: 'xbrowser', testDir: './e2e/xbrowser' };

export default defineConfig({
  testDir: './e2e',
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}/clinical-agent-env/`,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm exec vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}/clinical-agent-env/`,
    reuseExistingServer: false,
  },
  projects: [
    {
      name: 'mocked',
      testDir: './e2e',
      testIgnore: ['**/xbrowser/**', '**/live/**'],
      use: { ...devices['Desktop Chrome'] },
    },
    { ...xbrowser, use: { ...devices['Desktop Chrome'] } },
    { ...xbrowser, use: { ...devices['Desktop Firefox'] } },
    { ...xbrowser, use: { ...devices['Desktop Safari'] } },
    {
      name: 'live',
      testDir: './e2e/live',
      use: { ...devices['Desktop Chrome'], trace: 'off', video: 'off', screenshot: 'off' },
    },
  ],
});
