import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// Lints code through the real eslint.config.js as if it lived at a repo path, so these tests
// cover the rule and its file scope together.
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const eslint = new ESLint({ cwd: root });
async function lint(code: string, path: string) {
  const [result] = await eslint.lintText(code, { filePath: join(root, path) });
  return result?.messages ?? [];
}
const ruleIds = async (code: string, path: string) => (await lint(code, path)).map((m) => m.ruleId ?? `fatal: ${m.message}`);

const RULE = 'local/no-grader-module-state';
const GRADER = 'tasks/t9/tests/grader.ts';

// A rubric item records what it saw in a module-level Set, and a gate reads it: in one process
// the gate of the next trial would pass on the previous trial's rubric data.
const CROSS_TRIAL = `
const seen = new Set<string>();
export const checks = [
  { kind: 'rubric', fn: (ctx: { final_text: string | null }) => { seen.add(ctx.final_text ?? ''); return { met: true, evidence: {} }; } },
  { kind: 'gate', fn: () => ({ met: seen.size > 0, evidence: {} }) },
];
`;

describe('no-grader-module-state', () => {
  it('flags the planted cross-trial closure and names the fix', async () => {
    const messages = (await lint(CROSS_TRIAL, GRADER)).filter((m) => m.ruleId === RULE);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.message).toContain('keep check state inside the check; gates must not read rubric data');
  });

  it.each([
    'let n = 0; export const f = () => n;',
    'var n = 0; export const f = () => n;',
    'export let n = 0;',
    'const xs: number[] = []; export const f = (x: number) => { xs.push(x); };',
    'const m = new Map<string, number>(); export const f = (k: string) => m.set(k, 1);',
    'const o: Record<string, number> = {}; export const f = (k: string) => { o[k] = 1; };',
    'const o = { n: 0 }; export function f() { o.n++; }',
    'const o = { n: 0 }; export function f() { Object.assign(o, { n: 1 }); }',
    'const o: Record<string, number> = { a: 1 }; export function f() { delete o.a; }',
    'const s = new Set<number>(); export const f = () => () => s.clear();',
    // The forms the P9 gate found missing (builder-33 item 2).
    'const seen = new Set<string>(); const alias = seen; export const f = (t: string) => { alias.add(t); };',
    'const o = Object.create(null) as Record<string, number>; export const f = (k: string) => { o[k] = 1; };',
    'const xs = Array.of<number>(); export const f = (x: number) => { xs.push(x); };',
    'const make = () => new Set<string>(); const s = make(); export const f = (t: string) => { s.add(t); };',
    'const st = { xs: [] as number[] }; export const f = (x: number) => { st.xs.push(x); };',
    "import { seen } from './state.ts'; export const f = (t: string) => { seen.add(t); };",
    'class Memo { static last: string | null = null; } export const f = (t: string) => { Memo.last = t; };',
    'export class Memo { static seen = new Set<string>(); }',
    'export const f = (t: string) => { (globalThis as Record<string, unknown>).last = t; };',
    "export const f = (t: string) => { globalThis['last' as never] = t as never; };",
    'export const f = (t: string) => { Object.assign(globalThis, { last: t }); };',
    'export const f = (t: string) => { Reflect.set(globalThis, "last", t); };',
  ])('flags module state a function changes: %s', async (code) => {
    expect(await ruleIds(code, GRADER)).toContain(RULE);
  });

  it.each([
    // Tables built once at load time and only read afterwards.
    'const IDS = [1, 2]; export const f = (x: number) => IDS.includes(x);',
    'const M = new Map([["a", 1]]); M.set("b", 2); export const f = (k: string) => M.get(k);',
    'const O = { a: 1 }; export const f = () => O.a;',
    // State inside the check.
    'export const f = (xs: number[]) => { const seen = new Set<number>(); for (const x of xs) seen.add(x); let n = 0; n++; return seen.size + n; };',
    // A local that shadows the module binding.
    'const xs: number[] = []; export const f = () => { const xs: number[] = []; xs.push(1); return xs; };',
  ])('allows %s', async (code) => {
    expect(await ruleIds(code, GRADER)).not.toContain(RULE);
  });

  it.each(['tasks/t9/tests/rubric.ts', 'tasks/t9/tests/helpers.ts', 'tasks/t9/tests/lib/state.ts', 'packages/grader/check.ts', 'packages/grader/normalize.ts', 'packages/grader/grade.ts', 'packages/grader/matrix/matrix.ts'])('covers %s', async (path) => {
    expect(await ruleIds('let n = 0; export const f = () => n;', path)).toContain(RULE);
  });

  it('names the matrix isolation check as the real guard', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(root, 'eslint-rules/no-grader-module-state.js'), 'utf8')).toMatch(/isolation check/);
  });

  it('leaves files outside the graders alone', async () => {
    expect(await ruleIds('let n = 0; export const f = () => n;', 'cli/planted.ts')).not.toContain(RULE);
    expect(await ruleIds('let n = 0; export const f = () => n;', 'packages/grader/test/planted.test.ts')).not.toContain(RULE);
  });
});
