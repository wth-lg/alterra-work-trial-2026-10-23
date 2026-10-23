import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Lints code through the real eslint.config.js as if it lived at a repo path, so these tests
// cover the rule and its file scope together.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const eslint = new ESLint({ cwd: root });
async function ruleIds(code: string, path: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(root, path) });
  return (result?.messages ?? []).map((m) => m.ruleId ?? `fatal: ${m.message}`);
}

const RULE = 'local/no-direct-anthropic';
const HOST = ['api', 'anthropic', 'com'].join('.');

describe('no-direct-anthropic', () => {
  it.each([
    `export const r = fetch('https://${HOST}/v1/messages');`,
    `export const r = fetch(\`https://${HOST}/v1/\${'messages'}\`);`,
    `export const u = new URL('/v1/messages', 'https://${HOST}');`,
    `export const h = '${HOST}';`,
  ])('flags %s in cli/', async (code) => {
    expect(await ruleIds(code, 'cli/planted.ts')).toContain(RULE);
  });

  it.each(['apps/web/src/a.ts', 'apps/web/e2e/live/a.spec.ts', 'scripts/a.ts', 'packages/core/loop.ts', 'packages/core/test/a.test.ts'])(
    'applies in %s',
    async (path) => {
      expect(await ruleIds(`export const r = fetch('https://${HOST}/v1/messages');`, path)).toContain(RULE);
    },
  );

  it('allows the host in packages/core/anthropic.ts', async () => {
    expect(await ruleIds(`export const API_ORIGIN = 'https://${HOST}';`, 'packages/core/anthropic.ts')).not.toContain(RULE);
  });

  it('allows a Content-Security-Policy string that lists the host in connect-src', async () => {
    const csp = `export const CSP = "default-src 'self'; connect-src 'self' https://${HOST}; script-src 'self'";`;
    expect(await ruleIds(csp, 'apps/web/e2e/smoke.spec.ts')).not.toContain(RULE);
  });

  it('flags importing probeOnce outside the probe page and tests', async () => {
    const code = "import { probeOnce } from '../packages/core/anthropic.ts'; export { probeOnce };";
    expect(await ruleIds(code, 'cli/planted.ts')).toContain(RULE);
    expect(await ruleIds("export { probeOnce } from '../../../packages/core/anthropic.ts';", 'apps/web/src/a.ts')).toContain(RULE);
    expect(await ruleIds("import * as A from '../../../packages/core/anthropic.ts'; export const p = A.probeOnce;", 'apps/web/src/a.ts')).toContain(RULE);
    expect(await ruleIds("import * as A from '../../../packages/core/anthropic.ts'; export const { probeOnce } = A;", 'apps/web/src/a.ts')).toContain(RULE);
  });

  it('allows probeOnce in apps/web/src/probe and test files', async () => {
    const code = "import { probeOnce } from '../../../../packages/core/anthropic.ts'; export { probeOnce };";
    expect(await ruleIds(code, 'apps/web/src/probe/main.ts')).not.toContain(RULE);
    expect(await ruleIds("import { probeOnce } from '../anthropic.ts'; export { probeOnce };", 'packages/core/test/a.test.ts')).not.toContain(RULE);
  });

  it('allows the client and constants anywhere', async () => {
    const code = "import { MessagesClient, API_ORIGIN } from '../packages/core/anthropic.ts'; export { MessagesClient, API_ORIGIN };";
    expect(await ruleIds(code, 'cli/a.ts')).not.toContain(RULE);
  });
});
