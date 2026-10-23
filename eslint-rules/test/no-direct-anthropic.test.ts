import { execFileSync } from 'node:child_process';
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

  it('flags a Content-Security-Policy string in a .ts file: only apps/web/*.html CSP metas name the host', async () => {
    const csp = `export const CSP = "default-src 'self'; connect-src 'self' https://${HOST}; script-src 'self'";`;
    expect(await ruleIds(csp, 'apps/web/e2e/smoke.spec.ts')).toContain(RULE);
    expect(await ruleIds(`export const r = fetch('https://${HOST}/v1/messages?connect-src');`, 'cli/planted.ts')).toContain(RULE);
  });

  it.each([
    `export const r = fetch('https://api.' + 'anthropic.com/v1/messages');`,
    `export const r = fetch('https://' + 'api' + '.anthropic' + \`.com/v1/messages\`);`,
    `export const r = (p: string) => fetch('https://${HOST}/' + p + '/x');`,
  ])('flags the host split across a string concatenation: %s', async (code) => {
    expect(await ruleIds(code, 'cli/planted.ts')).toContain(RULE);
  });

  it.each(['cli/planted.mts', 'cli/planted.cts', 'cli/planted.cjs', 'cli/planted.tsx', 'cli/planted.js', 'cli/planted.mjs'])('applies to %s', async (path) => {
    expect(await ruleIds(`export const r = fetch('https://${HOST}/v1/messages');`, path)).toContain(RULE);
  });

  it('pnpm typecheck covers the eslint-rules tests', () => {
    const files = execFileSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.json', '--listFilesOnly'], { cwd: root, encoding: 'utf8' });
    for (const f of ['no-direct-anthropic', 'no-forged-grant', 'no-ledger-factory']) expect(files).toContain(`eslint-rules/test/${f}.test.ts`);
  }, 60_000);

  it('allows the client and constants anywhere', async () => {
    const code = "import { MessagesClient, MODEL } from '../packages/core/anthropic.ts'; export { MessagesClient, MODEL };";
    expect(await ruleIds(code, 'cli/a.ts')).not.toContain(RULE);
  });

  // P2 second fix round (pr-review-P2-7 defect 1, plants j to m; verifier-phase-P2-7 issue 1):
  // each test below fails at 6e517a9.
  it.each([
    ['a next-line disable', `// eslint-disable-next-line ${RULE}\nexport const r = fetch('https://${HOST}/v1/messages');`],
    ['a same-line disable', `export const r = fetch('https://${HOST}/v1/messages'); // eslint-disable-line ${RULE}`],
    ['a file-wide disable', `/* eslint-disable */\nexport const r = fetch('https://${HOST}/v1/messages');`],
    ['an inline rule config', `/* eslint ${RULE}: "off" */\nexport const r = fetch('https://${HOST}/v1/messages');`],
  ])('ignores %s: inline config cannot turn the P2 rules off', async (_name, code) => {
    expect(await ruleIds(code, 'cli/planted.ts')).toContain(RULE);
    expect(await ruleIds(code, 'eslint-rules/fixtures/planted.ts')).toContain(RULE);
  });

  it.each(['apps/web/src/planted.jsx', 'cli/planted.jsx'])('lints %s', async (path) => {
    expect(await ruleIds(`export const r = () => fetch('https://${HOST}/v1/messages');\nexport const C = () => <p>x</p>;`, path)).toContain(RULE);
  });

  it('lints eslint-rules/fixtures, so a sender there cannot be re-exported into cli/ unlinted', async () => {
    expect(await ruleIds(`export const go = () => fetch('https://${HOST}/v1/messages');`, 'eslint-rules/fixtures/zz-sender.ts')).toContain(RULE);
  });

  it('allows the exact design CSP literal in apps/web/e2e/smoke.spec.ts only', async () => {
    const csp = `export const CSP = "default-src 'self'; connect-src 'self' https://${HOST}; script-src 'self'; worker-src 'self'";`;
    expect(await ruleIds(csp, 'apps/web/e2e/smoke.spec.ts')).not.toContain(RULE);
    expect(await ruleIds(csp, 'cli/planted.ts')).toContain(RULE);
    expect(await ruleIds(csp.replace("worker-src 'self'", "worker-src 'self' x"), 'apps/web/e2e/smoke.spec.ts')).toContain(RULE);
    expect(await ruleIds(`${csp}\nexport const r = fetch('https://${HOST}/v1/messages');`, 'apps/web/e2e/smoke.spec.ts')).toContain(RULE);
  });
});
