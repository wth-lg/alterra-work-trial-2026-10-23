// Fails if any workflow could read a repository credential, run a live Playwright spec, or
// hand the Pages deploy token scopes to a job that does not deploy.
//
//   pnpm ci:guard [dir]   dir defaults to .github/workflows
//
// Each workflow is parsed as YAML first, so block scalars, quoting, anchors, aliases and
// merge keys are resolved the way the runner resolves them before any check runs.
// Each finding prints file:line: reason. Exit codes: 0 ok, 1 finding, 2 usage error.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument, type Document } from 'yaml';

type Finding = { line: number; reason: string };

// A workflow value after alias and merge-key resolution. line is where the value is used,
// so a value reached through an alias reports at the alias.
type Value =
  | { kind: 'scalar'; line: number; text: string }
  | { kind: 'seq'; line: number; items: Value[] }
  | { kind: 'map'; line: number; entries: Array<[string, Value]> };

const ALLOWED_PROJECTS = new Set(['mocked', 'xbrowser']);

// Case-insensitive: the Actions runner resolves expression named values (secrets, vars)
// case-insensitively. Checked on the raw text and on every resolved key and value.
const RULES: Array<[RegExp, string]> = [
  [/\bsecrets\b/i, 'references repository secrets; CI runs with none'],
  [/\bvars\b/i, 'references repository variables; CI runs with none'],
];

// Token scopes only actions/deploy-pages needs. A job-level permissions block replaces the
// workflow-level one, so granting them to the deploy job alone keeps the build job read-only.
const DEPLOY_ONLY = new Set(['pages', 'id-token']);

// Bounds alias expansion, so a file of nested aliases cannot exhaust memory.
const MAX_VALUES = 100_000;

function resolve(doc: Document, lines: LineCounter): Value {
  let count = 0;
  const lineOf = (node: unknown, fallback: number): number => {
    const range = (node as { range?: [number, number, number] } | null)?.range;
    return range ? lines.linePos(range[0]).line : fallback;
  };
  const lift = (node: unknown, fallback: number, at?: number): Value => {
    if (++count > MAX_VALUES) throw new Error(`aliases expand to more than ${MAX_VALUES} values`);
    const line = at ?? lineOf(node, fallback);
    if (isAlias(node)) return lift(node.resolve(doc), line, line);
    if (isSeq(node)) return { kind: 'seq', line, items: node.items.map((item) => lift(item, line, at)) };
    if (isMap(node)) {
      const entries: Array<[string, Value]> = [];
      for (const pair of node.items) {
        const key = lift(pair.key, line, at);
        const value = lift(pair.value, key.line, at);
        const name = key.kind === 'scalar' ? key.text : JSON.stringify(key);
        // A merge key copies its map (or list of maps) in. Keeping the explicit keys as well
        // means both are checked, whichever one a parser would let win.
        if (name === '<<') {
          for (const m of value.kind === 'seq' ? value.items : [value]) if (m.kind === 'map') entries.push(...m.entries);
        } else entries.push([name, value]);
      }
      return { kind: 'map', line, entries };
    }
    const scalar = isScalar(node) ? node.value : node;
    return { kind: 'scalar', line, text: scalar == null ? '' : String(scalar) };
  };
  return lift(doc.contents, 1);
}

// Values under key in a map, compared case-insensitively. A merge key can repeat a key.
function lookup(value: Value | undefined, key: string): Value[] {
  if (value?.kind !== 'map') return [];
  return value.entries.filter(([k]) => k.toLowerCase() === key).map(([, v]) => v);
}

type Word = { raw: string; text: string };

// Splits a run value into commands of words the way sh does before expansion: quotes and
// backslashes are removed, a backslash-newline joins lines, and newlines and ; & | ( ) end
// a command. The file name after a redirection is dropped. raw keeps the source spelling.
function shellCommands(src: string): Word[][] {
  const commands: Word[][] = [[]];
  let word: Word | undefined;
  let redirectTarget = false;
  const add = (raw: string, text: string) => {
    word ??= { raw: '', text: '' };
    word.raw += raw;
    word.text += text;
  };
  const end = () => {
    if (word && !redirectTarget) commands.at(-1)!.push(word);
    if (word) redirectTarget = false;
    word = undefined;
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === '\\') {
      const next = src[i + 1];
      if (next === undefined) throw new Error('ends in a lone backslash');
      if (next !== '\n') add(c + next, next);
      i++;
    } else if (c === "'") {
      const close = src.indexOf("'", i + 1);
      if (close < 0) throw new Error('has an unterminated single quote');
      add(src.slice(i, close + 1), src.slice(i + 1, close));
      i = close;
    } else if (c === '"') {
      let j = i + 1;
      let text = '';
      for (; j < src.length && src[j] !== '"'; j++) {
        if (src[j] === '\\' && '"\\$`\n'.includes(src[j + 1] ?? '')) {
          j++;
          if (src[j] !== '\n') text += src[j];
        } else text += src[j];
      }
      if (j >= src.length) throw new Error('has an unterminated double quote');
      add(src.slice(i, j + 1), text);
      i = j;
    } else if (c === '#' && !word) {
      const eol = src.indexOf('\n', i);
      i = (eol < 0 ? src.length : eol) - 1;
    } else if (c === ' ' || c === '\t') {
      end();
    } else if (c === '<' || c === '>') {
      if (word && /^\d+$/.test(word.raw)) word = undefined; // the fd in 2>&1
      else end();
      while ('<>&'.includes(src[i + 1] ?? ' ')) i++;
      redirectTarget = true;
    } else if ('\n;&|()'.includes(c)) {
      end();
      redirectTarget = false;
      if (commands.at(-1)!.length) commands.push([]);
    } else add(c, c);
  }
  end();
  return commands.filter((c) => c.length > 0);
}

// Playwright declares --project <project-name...> as variadic: `--project a b` selects a and
// b, up to the next flag, while `--project=a` takes one value. Every command is checked, not
// only playwright ones, because a package script can pass --project through to Playwright.
function commandProblems(words: Word[]): string[] {
  const out: string[] = [];
  const projects: Word[] = [];
  let hasProject = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    // A quoted word with spaces is a nested command line, as in bash -c "...".
    if (/\s/.test(w.text)) {
      try {
        for (const inner of shellCommands(w.text)) out.push(...commandProblems(inner));
      } catch {
        if (/--project|playwright/i.test(w.text)) out.push(`passes ${w.raw}, which cannot be read as shell words`);
      }
    }
    if (w.text.startsWith('--project=')) {
      hasProject = true;
      projects.push({ raw: w.raw.slice(w.raw.indexOf('=') + 1), text: w.text.slice('--project='.length) });
    } else if (w.text === '--project') {
      hasProject = true;
      const before = projects.length;
      while (i + 1 < words.length && !/^-./.test(words[i + 1]!.text)) projects.push(words[++i]!);
      if (projects.length === before) out.push('passes --project with no value');
    }
  }
  // Compared on the raw spelling: Playwright lowercases project names and treats * as a
  // wildcard, so only the bare names mocked and xbrowser are accepted.
  const other = projects.filter((p) => p.raw !== p.text || !ALLOWED_PROJECTS.has(p.text.toLowerCase()));
  if (other.length) {
    out.push(
      `selects Playwright project(s) ${other.map((p) => p.raw || "''").join(', ')}; only the unquoted names mocked and xbrowser may run in CI`,
    );
  }
  const pw = words.findIndex((w, k) => /(^|\/)playwright(@[^/]*)?$/.test(w.text) && words[k + 1]?.text === 'test');
  if (pw >= 0) {
    if (!hasProject) out.push('runs playwright test without --project=mocked or --project=xbrowser');
    const expanded = words.slice(pw).filter((w) => /[$`]/.test(w.text));
    if (expanded.length) {
      out.push(`runs playwright test with ${expanded.map((w) => w.raw).join(' ')}, which expands at run time; pass literal arguments`);
    }
  }
  return out;
}

// key is the map key the scalar sits under. Only run values must be valid shell; any other
// value that will not tokenize fails only if it mentions --project or playwright.
function scalarProblems(key: string, value: Value & { kind: 'scalar' }): string[] {
  try {
    return shellCommands(value.text).flatMap(commandProblems);
  } catch (err) {
    if (key === 'run' || /--project|playwright/i.test(value.text)) return [`${key} value ${(err as Error).message}`];
    return [];
  }
}

function valueProblems(root: Value): Finding[] {
  const out: Finding[] = [];
  const visit = (value: Value, key: string) => {
    if (value.kind === 'seq') return value.items.forEach((item) => visit(item, key));
    if (value.kind === 'map') {
      for (const [k, v] of value.entries) {
        for (const [pattern, reason] of RULES) if (pattern.test(k)) out.push({ line: v.line, reason });
        visit(v, k);
      }
      return;
    }
    for (const [pattern, reason] of RULES) if (pattern.test(value.text)) out.push({ line: value.line, reason });
    for (const reason of scalarProblems(key, value)) out.push({ line: value.line, reason });
  };
  visit(root, '');
  return out;
}

function permissionProblems(root: Value): Finding[] {
  const out: Finding[] = [];
  const check = (permissions: Value, where: 'workflow' | 'job' | 'deploy') => {
    if (permissions.kind === 'scalar' && /^write-all$/i.test(permissions.text.trim())) {
      out.push({ line: permissions.line, reason: 'grants write-all; grant each scope a job needs by name' });
    }
    if (permissions.kind !== 'map' || where === 'deploy') return;
    for (const [scope, level] of permissions.entries) {
      if (!DEPLOY_ONLY.has(scope.trim().toLowerCase())) continue;
      if (level.kind !== 'scalar' || !/^write$/i.test(level.text.trim())) continue;
      const reason =
        where === 'workflow'
          ? `grants ${scope}: write at workflow level; grant it only to the job that runs actions/deploy-pages`
          : `grants ${scope}: write to a job that does not run actions/deploy-pages`;
      out.push({ line: level.line, reason });
    }
  };
  for (const p of lookup(root, 'permissions')) check(p, 'workflow');
  for (const jobs of lookup(root, 'jobs')) {
    if (jobs.kind !== 'map') continue;
    for (const [, job] of jobs.entries) {
      const deploys = lookup(job, 'steps').some(
        (steps) =>
          steps.kind === 'seq' &&
          steps.items.some((step) => lookup(step, 'uses').some((u) => u.kind === 'scalar' && /^actions\/deploy-pages@/.test(u.text.trim()))),
      );
      for (const p of lookup(job, 'permissions')) check(p, deploys ? 'deploy' : 'job');
    }
  }
  return out;
}

function workflowProblems(content: string): Finding[] {
  const out: Finding[] = [];
  content.split('\n').forEach((text, i) => {
    for (const [pattern, reason] of RULES) if (pattern.test(text)) out.push({ line: i + 1, reason });
  });
  const lines = new LineCounter();
  const doc = parseDocument(content, { lineCounter: lines });
  if (doc.errors.length) {
    for (const e of doc.errors) out.push({ line: lines.linePos(e.pos[0]).line, reason: `is not valid YAML: ${e.message.split('\n')[0]}` });
    return out;
  }
  let root: Value;
  try {
    root = resolve(doc, lines);
  } catch (err) {
    return [...out, { line: 1, reason: `cannot be resolved: ${(err as Error).message}` }];
  }
  return [...out, ...permissionProblems(root), ...valueProblems(root)];
}

function main(): void {
  const dir = process.argv[2] ?? '.github/workflows';
  if (!existsSync(dir)) {
    process.stderr.write(`ci-guard: no such directory: ${dir}\n`);
    process.exit(2);
  }
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  const findings = new Set<string>();
  for (const file of files) {
    const path = join(dir, file);
    const found = workflowProblems(readFileSync(path, 'utf8')).sort((a, b) => a.line - b.line);
    for (const { line, reason } of found) findings.add(`${path}:${line}: ${reason}`);
  }
  for (const f of findings) process.stdout.write(`${f}\n`);
  if (findings.size) {
    process.stderr.write(`ci-guard: ${findings.size} finding(s) in ${files.length} workflow file(s)\n`);
    process.exit(1);
  }
  process.stderr.write(`ci-guard: ok, ${files.length} workflow file(s) checked\n`);
}

main();
