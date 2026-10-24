// One definition (plan phase P14a): the attribution definitions live only in
// packages/core/outcomes.ts. Every FAULT_DEFINITIONS sentence and criterion text, every
// CONFIRMATION_CRITERIA text, CONFIRMATION_DEFINITIONS, FAULT_PRECEDENCE_RULE, PASS_DEFINITION,
// DENOMINATOR_RULE and DENOMINATOR_OPERATOR_NOTE (whole, and each of their sentences) is searched for verbatim in every file
// git tracks or would track (untracked files that .gitignore does not hide count, so a copy
// planted before it is committed fails too). A surface imports the constant instead. The only
// copies allowed are outcomes.ts itself and the blocks docs-gen (P24) writes between
// GENERATED_BEGIN and GENERATED_END.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONFIRMATION_CRITERIA, CONFIRMATION_DEFINITIONS, DENOMINATOR_OPERATOR_NOTE, DENOMINATOR_RULE, FAULT_DEFINITIONS, FAULT_PRECEDENCE_RULE, PASS_DEFINITION,
} from '../../packages/core/outcomes.ts';
import { repoRoot } from './helpers.ts';

const HOME = 'packages/core/outcomes.ts';
// docs-gen (P24) wraps each block it renders from outcomes.ts in these two lines.
const GENERATED_BEGIN = '<!-- docs-gen:begin outcomes -->';
const GENERATED_END = '<!-- docs-gen:end outcomes -->';
const MAX_BYTES = 2_000_000;

const sentences = (text: string) => text.split(/(?<=\.)\s+(?=[A-Z`])/).map((s) => s.trim()).filter((s) => s.length > 0);

// Every definition string, with where it comes from.
function definitions(): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  for (const [fault, d] of Object.entries(FAULT_DEFINITIONS)) {
    out.push({ name: `FAULT_DEFINITIONS.${fault}.sentence`, text: d.sentence });
    for (const c of d.criteria) out.push({ name: `FAULT_DEFINITIONS.${fault} ${c.id}`, text: c.text });
  }
  for (const c of CONFIRMATION_CRITERIA) out.push({ name: `CONFIRMATION_CRITERIA ${c.id}`, text: c.text });
  for (const [k, text] of Object.entries(CONFIRMATION_DEFINITIONS)) out.push({ name: `CONFIRMATION_DEFINITIONS.${k}`, text });
  const rules = [['FAULT_PRECEDENCE_RULE', FAULT_PRECEDENCE_RULE], ['PASS_DEFINITION', PASS_DEFINITION], ['DENOMINATOR_RULE', DENOMINATOR_RULE], ['DENOMINATOR_OPERATOR_NOTE', DENOMINATOR_OPERATOR_NOTE]] as const;
  for (const [name, text] of rules) {
    out.push({ name, text });
    for (const s of sentences(text)) if (s !== text) out.push({ name: `${name} sentence`, text: s });
  }
  return out;
}

const stripGenerated = (text: string) => text.split(GENERATED_BEGIN).map((part, i) => (i === 0 ? part : part.split(GENERATED_END).slice(1).join(GENERATED_END))).join('');

// Each restatement as "<file>: <definition>".
function restatements(files: ReadonlyArray<{ path: string; text: string }>): string[] {
  const defs = definitions();
  return files.flatMap(({ path, text }) => {
    if (path === HOME) return [];
    const body = stripGenerated(text);
    return defs.filter((d) => body.includes(d.text)).map((d) => `${path}: ${d.name}`);
  });
}

function repoFiles(): Array<{ path: string; text: string }> {
  const list = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: repoRoot, encoding: 'utf8' }).split('\0').filter((p) => p !== '');
  return [...new Set(list)].flatMap((path) => {
    const file = join(repoRoot, path);
    if (!existsSync(file) || !statSync(file).isFile() || statSync(file).size > MAX_BYTES) return [];
    const bytes = readFileSync(file);
    if (bytes.includes(0)) return []; // binary
    return [{ path, text: bytes.toString('utf8') }];
  });
}

describe('one definition', () => {
  it('has definitions to look for', () => {
    expect(definitions().length).toBeGreaterThan(10);
    for (const d of definitions()) expect(d.text.length, d.name).toBeGreaterThan(20);
  });

  it('no file but packages/core/outcomes.ts restates a definition', () => {
    const files = repoFiles();
    expect(files.some((f) => f.path === HOME)).toBe(true);
    expect(files.some((f) => f.path.startsWith('apps/web/src/'))).toBe(true);
    expect(restatements(files)).toEqual([]);
  });

  it('a definition sentence, PASS_DEFINITION or DENOMINATOR_RULE planted in apps/web/src is found', () => {
    const planted = (text: string) => restatements([{ path: 'apps/web/src/planted.ts', text: `export const copy = ${JSON.stringify(text)};\n` }]);
    expect(planted(FAULT_DEFINITIONS.env.sentence)).toEqual(['apps/web/src/planted.ts: FAULT_DEFINITIONS.env.sentence']);
    expect(planted(CONFIRMATION_CRITERIA[0]!.text)).toEqual(['apps/web/src/planted.ts: CONFIRMATION_CRITERIA M1']);
    expect(planted(FAULT_DEFINITIONS.env.criteria[4]!.text)).toEqual(['apps/web/src/planted.ts: FAULT_DEFINITIONS.env E5']);
    expect(planted(FAULT_PRECEDENCE_RULE)).toContain('apps/web/src/planted.ts: FAULT_PRECEDENCE_RULE');
    expect(planted(CONFIRMATION_DEFINITIONS.contradicted)).toEqual(['apps/web/src/planted.ts: CONFIRMATION_DEFINITIONS.contradicted']);
    expect(planted(DENOMINATOR_OPERATOR_NOTE)).toContain('apps/web/src/planted.ts: DENOMINATOR_OPERATOR_NOTE');
    expect(planted(PASS_DEFINITION)).toContain('apps/web/src/planted.ts: PASS_DEFINITION');
    expect(planted(DENOMINATOR_RULE)).toContain('apps/web/src/planted.ts: DENOMINATOR_RULE');
    // One sentence of the rule is enough.
    expect(planted(`Note: ${sentences(DENOMINATOR_RULE).at(-1)}`)).toEqual(['apps/web/src/planted.ts: DENOMINATOR_RULE sentence']);
  });

  it('a copy inside a docs-gen block is allowed; the same copy outside it is not', () => {
    const block = `# Glossary\n${GENERATED_BEGIN}\n${FAULT_DEFINITIONS.grader.sentence}\n${GENERATED_END}\n`;
    expect(restatements([{ path: 'docs/glossary.md', text: block }])).toEqual([]);
    expect(restatements([{ path: 'docs/glossary.md', text: `${block}${FAULT_DEFINITIONS.grader.sentence}\n` }])).toEqual(['docs/glossary.md: FAULT_DEFINITIONS.grader.sentence']);
  });
});
