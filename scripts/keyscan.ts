// Scans for Anthropic API keys and prints file:line for each hit, never the match itself.
//
//   pnpm keyscan [paths...]              tracked and untracked (not ignored) files, build output, paths
//   pnpm keyscan --history [paths...]    every commit on every ref (`git log -p --all`), plus paths
//   pnpm keyscan --range A..B [paths...] the commits in A..B (a bare revision means all its history)
//
// A hit is an sk-ant-shaped string or, when ANTHROPIC_API_KEY is set, its exact value.
// Exit codes: 0 clean, 1 hit, 2 usage or git error.
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

const KEY_SHAPE = /sk-ant-[A-Za-z0-9_-]{20,}/;
// Build and test output that .gitignore hides from `git ls-files` but that can still ship or be uploaded.
const BUILD_DIRS = ['apps/web/dist', 'apps/web/test-results', 'apps/web/playwright-report'];
const SKIP_DIRS = new Set(['node_modules', '.git']);
const MIN_ENV_KEY_LENGTH = 8;

function fail(message: string): never {
  process.stderr.write(`keyscan: ${message}\n`);
  process.exit(2);
}

function parseArgs(argv: string[]) {
  const opts = { history: false, range: undefined as string | undefined, paths: [] as string[] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--history') opts.history = true;
    else if (arg === '--range') {
      const value = argv[++i];
      if (!value) fail('--range needs a revision range, e.g. origin/main..HEAD');
      opts.range = value;
    } else if (arg.startsWith('--range=')) opts.range = arg.slice('--range='.length);
    else if (arg === '--') {
      opts.paths.push(...argv.slice(i + 1));
      break;
    } else if (arg.startsWith('-')) fail(`unknown option ${arg}`);
    else opts.paths.push(arg);
  }
  if (opts.history && opts.range) fail('use --history or --range, not both');
  return opts;
}

function git(args: string[], cwd: string): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.status !== 0) fail(`git ${args[0]} failed: ${r.stderr.trim().split('\n')[0] ?? ''}`);
  return r.stdout;
}

function makeMatcher(): (line: string) => boolean {
  const envKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (envKey && envKey.length < MIN_ENV_KEY_LENGTH) {
    process.stderr.write(`keyscan: ANTHROPIC_API_KEY is shorter than ${MIN_ENV_KEY_LENGTH} characters; not matching its value\n`);
  }
  const exact = envKey && envKey.length >= MIN_ENV_KEY_LENGTH ? envKey : undefined;
  return (line) => KEY_SHAPE.test(line) || (exact !== undefined && line.includes(exact));
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile()) out.push(path);
  }
}

function scanFile(path: string, label: string, matches: (line: string) => boolean, hits: string[]): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isFile()) return;
  const buf = readFileSync(path);
  if (buf.subarray(0, 8000).includes(0)) return; // binary
  const lines = buf.toString('utf8').split('\n');
  lines.forEach((line, i) => {
    if (matches(line)) hits.push(`${label}:${i + 1}`);
  });
}

function scanPaths(root: string, paths: string[], matches: (line: string) => boolean, hits: string[]): number {
  const files = new Map<string, string>(); // absolute path -> label
  for (const p of paths) {
    const abs = resolve(p);
    if (!existsSync(abs)) fail(`no such path: ${p}`);
    const found: string[] = [];
    if (lstatSync(abs).isDirectory()) walk(abs, found);
    else found.push(abs);
    for (const f of found) {
      const rel = relative(root, f);
      files.set(f, rel.startsWith('..') || isAbsolute(rel) ? f : rel);
    }
  }
  for (const [abs, label] of files) scanFile(abs, label, matches, hits);
  return files.size;
}

function workingTreePaths(root: string): string[] {
  const listed = git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], root)
    .split('\0')
    .filter(Boolean)
    .map((rel) => join(root, rel))
    .filter((abs) => existsSync(abs));
  const build = BUILD_DIRS.map((d) => join(root, d)).filter((d) => existsSync(d));
  return [...listed, ...build];
}

const COMMIT_START = '\x01';
const MESSAGE_END = '\x02';

// Reads `git log -p` and checks every commit message line and every added line.
// Removed lines need no check: each was an added line in some earlier commit.
function scanHistory(root: string, revs: string[], matches: (line: string) => boolean, hits: string[]): number {
  const out = git(['log', '-p', '--no-color', '--no-ext-diff', '--no-renames', `--format=${COMMIT_START}%H%n%B${MESSAGE_END}`, ...revs, '--'], root);
  let commit = '';
  let commits = 0;
  let inMessage = false;
  let messageLine = 0;
  let file = '';
  let inHunk = false;
  let newLine = 0;
  for (const line of out.split('\n')) {
    if (line.startsWith(COMMIT_START)) {
      commit = line.slice(1, 13);
      commits++;
      inMessage = true;
      messageLine = 0;
      inHunk = false;
      continue;
    }
    if (inMessage) {
      const end = line.indexOf(MESSAGE_END);
      const text = end === -1 ? line : line.slice(0, end);
      messageLine++;
      if (matches(text)) hits.push(`${commit}:(commit message):${messageLine}`);
      if (end !== -1) inMessage = false;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      inHunk = false;
      file = '';
    } else if (!inHunk && line.startsWith('+++ ')) {
      file = line === '+++ /dev/null' ? '' : line.slice(4).replace(/^b\//, '');
    } else if (line.startsWith('@@ ')) {
      const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(line);
      newLine = m ? Number(m[1]) : 0;
      inHunk = true;
    } else if (inHunk && line.startsWith('+')) {
      if (matches(line.slice(1))) hits.push(`${commit}:${file}:${newLine}`);
      newLine++;
    } else if (inHunk && line.startsWith(' ')) {
      newLine++;
    }
  }
  return commits;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const root = git(['rev-parse', '--show-toplevel'], process.cwd()).trim();
  const matches = makeMatcher();
  const hits: string[] = [];
  let scanned: string;
  if (opts.history || opts.range) {
    const commits = scanHistory(root, opts.history ? ['--all'] : [opts.range!], matches, hits);
    const files = opts.paths.length ? scanPaths(root, opts.paths, matches, hits) : 0;
    scanned = `${commits} commit(s)${files ? ` and ${files} file(s)` : ''}`;
  } else {
    const files = scanPaths(root, [...workingTreePaths(root), ...opts.paths], matches, hits);
    scanned = `${files} file(s)`;
  }
  for (const hit of hits) process.stdout.write(`${hit}\n`);
  if (hits.length) {
    process.stderr.write(`keyscan: ${hits.length} key-shaped string(s) found in ${scanned}; locations above, values not printed\n`);
    process.exit(1);
  }
  process.stderr.write(`keyscan: clean, ${scanned} scanned\n`);
}

main();
