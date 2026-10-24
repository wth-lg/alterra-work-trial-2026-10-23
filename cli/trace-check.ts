// pnpm cli trace-check [--plan <plan.md>] [--done <phase ids>] [--final --evidence-root <dir>]
//                      [--root <dir>] [--source <file>] [--trace <file>]
// The requirement-trace matrix (plan phase P9t). docs/requirements/source.md holds every sentence
// of the assignment's four sections (A, N, W, H) and every user modification (U), one per line as
// `- **<id>** <text>`; docs/requirements/trace.json holds one row per id. It exits 1, printing
// `<id>: <problem>; fix: <fix>` for each failure, when:
//   - a source id has no row, a row has no source line, or an id repeats
//   - ids in a section do not run <letter>1..<letter>n in order, or a source line holds more
//     than one sentence
//   - text_sha256 differs from the sha256 of the source line's text
//   - a row lacks code, tests, evidence, expect or phase, or its kind does not fit its section
//   - an N or W row has ui_required false, or a ui_required row lacks ui.route or ui.action
//   - an ax_text expect names a file that is not in the row's evidence list
//   - with --plan, a phase is not a `### <phase>:` heading in that plan
//   - with --done, a code or test path does not exist and the row's phase is in the list (a path
//     of a phase not yet done may be missing)
//   - with --final, any code, test or evidence path does not exist, or an expect does not hold:
//     the ax_text is absent from the snapshot under --evidence-root, or the command, run in the
//     repo root, exits with another code
// Paths in code and tests are relative to --root (default the repo root), evidence relative to
// --evidence-root. Exit codes: 0 ok, 1 failure, 2 usage error.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../', import.meta.url));
const USAGE = 'usage: pnpm cli trace-check [--plan <plan.md>] [--done <phase ids>] [--final --evidence-root <dir>] [--root <dir>] [--source <file>] [--trace <file>]';
const WITH_VALUE = new Set(['--plan', '--done', '--evidence-root', '--root', '--source', '--trace']);
// A command expect runs the suite or check it names; a whole-repo command can take minutes.
const COMMAND_TIMEOUT_MS = 15 * 60_000;

export const SECTIONS = ['A', 'N', 'W', 'H', 'U'] as const;
type Section = (typeof SECTIONS)[number];
const KINDS: Record<Section, readonly string[]> = {
  A: ['scope'],
  // N14 ("A human-facing UI is out of scope.") is kind scope, superseded by the user's UI rows.
  N: ['need', 'scope'],
  W: ['want'],
  H: ['handover'],
  U: ['user'],
};
const LINE = /^- \*\*([A-Z])(\d+)\*\* (.+)$/;
const HEADING = /^## ([A-Z])\. /;
// The end of a sentence: terminal punctuation, optional closing quotes or brackets, then the end
// of the line or a space before a capital letter or an opening quote. "127.0.0.1" and ".html"
// do not end one.
const SENTENCE_END = /[.!?]+["'”’)\]]*(?=$|\s+["'“‘(]?[A-Z])/g;

export type Expect = { ax_text: { file: string; text: string } } | { command: { cmd: string; exit: number } };

export interface TraceRow {
  id: string;
  text_sha256: string;
  kind: string;
  status?: 'active' | 'superseded' | 'amended';
  by?: string[];
  code: string[];
  tests: string[];
  ui_required: boolean;
  ui?: { route: string; action: string };
  evidence: string[];
  expect: Expect;
  phase: string;
  note?: string;
}

export interface SourceLine {
  id: string;
  section: string;
  line: number;
  text: string;
}

export interface Deps {
  out: (line: string) => void;
  // Runs a command expect in the repo root and returns its exit code and output.
  run?: (cmd: string, cwd: string) => { exit: number; output: string };
}

type Failure = { id: string; problem: string; fix: string };

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

export const sentenceCount = (text: string): number => text.match(SENTENCE_END)?.length ?? 0;

// Every `- **<id>** <text>` line under a `## <letter>. ` heading, plus structural failures.
export function parseSource(text: string): { lines: SourceLine[]; failures: Failure[] } {
  const lines: SourceLine[] = [];
  const failures: Failure[] = [];
  let section: string | undefined;
  text.split('\n').forEach((raw, i) => {
    const heading = HEADING.exec(raw);
    if (heading) {
      section = heading[1];
      if (!(SECTIONS as readonly string[]).includes(section!)) failures.push({ id: `line ${i + 1}`, problem: `unknown section ${section}`, fix: `use one of ${SECTIONS.join(', ')}` });
      return;
    }
    if (!raw.startsWith('- ')) return;
    const m = LINE.exec(raw);
    if (!m) {
      failures.push({ id: `line ${i + 1}`, problem: 'a top-level list item that is not `- **<id>** <text>`', fix: 'write the line as `- **<id>** <sentence>`, or indent it as a sub-item' });
      return;
    }
    const [, letter, n, body] = m as unknown as [string, string, string, string];
    const id = `${letter}${n}`;
    if (letter !== section) failures.push({ id, problem: `id is under section ${section ?? '(none)'}`, fix: `move the line under "## ${letter}. " or renumber it` });
    lines.push({ id, section: letter, line: i + 1, text: body });
  });
  for (const s of SECTIONS) {
    lines
      .filter((l) => l.section === s)
      .forEach((l, k) => {
        if (l.id !== `${s}${k + 1}`) failures.push({ id: l.id, problem: `ids in section ${s} must run ${s}1..${s}n in order; expected ${s}${k + 1} here`, fix: 'number the section by reading order, one id per sentence' });
      });
  }
  for (const l of lines) {
    const n = sentenceCount(l.text);
    if (n > 1) failures.push({ id: l.id, problem: `the source line holds ${n} sentences`, fix: 'split it into one line per sentence, each with its own id' });
  }
  return { lines, failures };
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.trim() !== '';
const stringList = (v: unknown): v is string[] => Array.isArray(v) && v.every(nonEmpty);

// The default-mode checks of one row against its source line.
function checkRow(r: TraceRow, src: SourceLine, failures: Failure[]): void {
  const fail = (problem: string, fix: string) => failures.push({ id: r.id, problem, fix });
  const section = src.section as Section;
  const actual = sha256(src.text);
  if (r.text_sha256 !== actual) fail(`text_sha256 ${String(r.text_sha256).slice(0, 12)}… does not match the source line (sha256 ${actual.slice(0, 12)}…)`, 'if the source text changed on purpose, re-read the row against it and set text_sha256 to the new sha256');
  if (!KINDS[section]?.includes(r.kind)) fail(`kind ${JSON.stringify(r.kind)} does not fit section ${section}`, `use ${KINDS[section]?.join(' or ')}`);
  if (r.status === 'superseded' || r.status === 'amended') {
    if (!stringList(r.by) || r.by.length === 0) fail(`status ${r.status} names no row in by`, 'list the U rows that supersede or amend it in by');
  }
  for (const key of ['code', 'tests', 'evidence'] as const) {
    const v = r[key];
    if (!Array.isArray(v) || v.length === 0) fail(`${key} is empty`, `name at least one ${key === 'evidence' ? 'evidence file P25c produces' : `${key} path`}`);
    else if (!stringList(v)) fail(`${key} holds a value that is not a path`, 'use non-empty relative path strings');
    else for (const p of v) if (isAbsolute(p) || p.split('/').includes('..')) fail(`${key} path ${p} is not relative inside its root`, 'write it relative to the repo root (code, tests) or the evidence root (evidence)');
  }
  if (!nonEmpty(r.phase)) fail('phase is missing', 'name the plan phase that owns the row, as in "### P14:"');
  else if (!/^P[0-9A-Za-z]+$/.test(r.phase)) fail(`phase ${r.phase} is not a plan phase id`, 'use the id of a "### P<id>:" heading');
  if (typeof r.ui_required !== 'boolean') fail('ui_required is not true or false', 'set ui_required');
  if ((section === 'N' || section === 'W') && r.ui_required !== true) fail('ui_required must be true for every N and W row', 'set ui_required true and name the screen and the action');
  if (r.ui_required === true) {
    if (!nonEmpty(r.ui?.route)) fail('ui.route is missing', 'name the screen as its URL route, e.g. /?view=environment');
    if (!nonEmpty(r.ui?.action)) fail('ui.action is missing', 'say what the interviewer sees or does on that screen');
  }
  const e = r.expect as Partial<{ ax_text: { file?: unknown; text?: unknown }; command: { cmd?: unknown; exit?: unknown } }> | undefined;
  if (!e) fail('expect is missing', 'add {ax_text: {file, text}} or {command: {cmd, exit}} that shows the outcome');
  else if (e.ax_text && !e.command) {
    if (!nonEmpty(e.ax_text.file) || !nonEmpty(e.ax_text.text)) fail('expect ax_text needs file and text', 'name the AX snapshot and the text it must contain');
    else if (!r.evidence?.includes(e.ax_text.file)) fail(`expect ax_text file ${e.ax_text.file} is not in evidence`, 'add the snapshot to the row evidence list, so the audit produces it');
  } else if (e.command && !e.ax_text) {
    if (!nonEmpty(e.command.cmd) || !Number.isInteger(e.command.exit)) fail('expect command needs cmd and an integer exit', 'name the repo command and its expected exit code');
  } else fail('expect must hold exactly one of ax_text or command', 'keep one');
}

function defaultRun(cmd: string, cwd: string): { exit: number; output: string } {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', timeout: COMMAND_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  return { exit: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}` };
}

const tail = (text: string, n: number): string => text.trimEnd().split('\n').slice(-n).join(' | ');

export async function main(args: string[], deps: Deps = { out: (l) => process.stdout.write(`${l}\n`) }): Promise<number> {
  const opts = new Map<string, string>();
  let finalMode = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === '--final') finalMode = true;
    else if (WITH_VALUE.has(a) && args[i + 1] !== undefined) opts.set(a, args[++i] as string);
    else {
      deps.out(`trace-check: ${WITH_VALUE.has(a) ? `${a} needs a value` : `unknown argument ${a}`}\n${USAGE}`);
      return 2;
    }
  }
  const evidenceRoot = opts.get('--evidence-root');
  if (finalMode && !evidenceRoot) {
    deps.out(`trace-check: --final needs --evidence-root\n${USAGE}`);
    return 2;
  }
  const root = resolve(opts.get('--root') ?? REPO);
  const sourcePath = resolve(root, opts.get('--source') ?? 'docs/requirements/source.md');
  const tracePath = resolve(root, opts.get('--trace') ?? 'docs/requirements/trace.json');
  const done = new Set((opts.get('--done') ?? '').split(/[\s,]+/).filter(Boolean));

  let rows: TraceRow[];
  let source: ReturnType<typeof parseSource>;
  try {
    source = parseSource(readFileSync(sourcePath, 'utf8'));
    rows = (JSON.parse(readFileSync(tracePath, 'utf8')) as { rows: TraceRow[] }).rows;
    if (!Array.isArray(rows)) throw new Error(`${tracePath}: rows is not an array`);
  } catch (e) {
    deps.out(`trace-check: ${(e as Error).message}`);
    return 2;
  }
  let planPhases: Set<string> | undefined;
  const plan = opts.get('--plan');
  if (plan) {
    try {
      planPhases = new Set([...readFileSync(plan, 'utf8').matchAll(/^### (P[0-9A-Za-z]+):/gm)].map((m) => m[1]!));
    } catch (e) {
      deps.out(`trace-check: --plan: ${(e as Error).message}`);
      return 2;
    }
  }

  const failures: Failure[] = [...source.failures];
  const byId = new Map<string, TraceRow>();
  for (const r of rows) {
    if (byId.has(r.id)) failures.push({ id: r.id, problem: 'more than one row has this id', fix: 'merge them into one row' });
    byId.set(r.id, r);
  }
  const sourceIds = new Map(source.lines.map((l) => [l.id, l]));
  for (const l of source.lines) if (!byId.has(l.id)) failures.push({ id: l.id, problem: 'no row in trace.json', fix: `add a row for ${l.id} with code, tests, ui, evidence, expect and phase` });
  for (const r of rows) {
    const src = sourceIds.get(r.id);
    if (!src) {
      failures.push({ id: r.id, problem: 'row has no source line', fix: 'remove the row, or add its sentence to source.md' });
      continue;
    }
    checkRow(r, src, failures);
    for (const by of r.by ?? []) if (!sourceIds.has(by)) failures.push({ id: r.id, problem: `by names ${by}, which has no source line`, fix: 'name an existing U row' });
    if (planPhases && nonEmpty(r.phase) && !planPhases.has(r.phase)) failures.push({ id: r.id, problem: `phase ${r.phase} is not a "### ${r.phase}:" heading in ${plan}`, fix: 'use the id of the plan phase that owns the row' });
    for (const key of ['code', 'tests'] as const) {
      for (const p of stringList(r[key]) ? r[key] : []) {
        if (existsSync(join(root, p))) continue;
        if (finalMode) failures.push({ id: r.id, problem: `${key === 'code' ? 'code' : 'test'} path ${p} does not exist`, fix: 'build it, or update the row to the path that holds it' });
        else if (done.has(r.phase)) failures.push({ id: r.id, problem: `${key === 'code' ? 'code' : 'test'} path ${p} does not exist and phase ${r.phase} is done`, fix: 'update the row to the path the phase built' });
      }
    }
  }

  if (finalMode && evidenceRoot) {
    const evRoot = resolve(evidenceRoot);
    const run = deps.run ?? defaultRun;
    for (const r of rows) {
      if (!sourceIds.has(r.id)) continue;
      for (const p of stringList(r.evidence) ? r.evidence : []) {
        if (!existsSync(join(evRoot, p))) failures.push({ id: r.id, problem: `evidence file ${p} does not exist under ${evRoot}`, fix: 'produce it in the audit (P25c) under that name' });
      }
      const e = r.expect as Partial<{ ax_text: { file: string; text: string }; command: { cmd: string; exit: number } }> | undefined;
      if (e?.ax_text && nonEmpty(e.ax_text.file) && nonEmpty(e.ax_text.text)) {
        const file = join(evRoot, e.ax_text.file);
        if (!existsSync(file)) continue; // reported above as missing evidence
        const snapshot = readFileSync(file, 'utf8');
        if (!snapshot.includes(e.ax_text.text)) failures.push({ id: r.id, problem: `expect ax_text not met: expected ${JSON.stringify(e.ax_text.text)} in ${e.ax_text.file}, observed ${JSON.stringify(tail(snapshot, 3).slice(0, 200))}`, fix: 'fix the screen so it shows the text, or retake the snapshot on the right screen' });
      } else if (e?.command && nonEmpty(e.command.cmd)) {
        const got = run(e.command.cmd, root);
        const said = tail(got.output, 3).slice(0, 300);
        if (got.exit !== e.command.exit) failures.push({ id: r.id, problem: `expect command not met: \`${e.command.cmd}\` expected exit ${e.command.exit}, observed exit ${got.exit}${said ? ` (${said})` : ''}`, fix: 'fix what the command checks, then run it again' });
      }
    }
  }

  for (const f of failures) deps.out(`${f.id}: ${f.problem}; fix: ${f.fix}`);
  const counts = SECTIONS.map((s) => `${s} ${source.lines.filter((l) => l.section === s).length}`).join(', ');
  const mode = finalMode ? 'final' : 'default';
  if (failures.length > 0) {
    deps.out(`trace-check: FAIL, ${failures.length} failure(s); ${source.lines.length} source lines (${counts}), ${rows.length} rows, mode ${mode}`);
    return 1;
  }
  deps.out(`trace-check: OK, ${source.lines.length} source lines (${counts}), ${rows.length} rows, mode ${mode}${plan ? ', phases checked against the plan' : ''}${done.size ? `, done ${[...done].join(',')}` : ''}`);
  return 0;
}

export default (args: string[]) => main(args);
