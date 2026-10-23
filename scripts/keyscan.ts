// Scans for Anthropic API keys and prints file:line for each hit, never the match itself.
//
//   pnpm keyscan [paths...]              tracked and untracked (not ignored) files, build output, paths
//   pnpm keyscan --history [paths...]    every commit on every ref (`git log -p --all`), plus paths
//   pnpm keyscan --range A..B [paths...] the commits in A..B (a bare revision means all its history)
//
// A hit is an sk-ant-shaped string or, when ANTHROPIC_API_KEY is set, its exact value.
// Every file is scanned byte for byte, binary or not. A symlink in a build directory that
// resolves outside it is a finding too: the Pages upload dereferences symlinks.
// Exit codes: 0 clean, 1 hit, 2 usage or git error.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

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
  const test = (text: string) => KEY_SHAPE.test(text) || (exact !== undefined && text.includes(exact));
  // Dropping NUL bytes turns UTF-16 text back into the ASCII a key is made of.
  return (line) => test(line) || (line.includes('\0') && test(line.replaceAll('\0', '')));
}

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(path);
  }
}

function scanText(text: string, label: string, matches: (line: string) => boolean, hits: string[]): void {
  text.split('\n').forEach((line, i) => {
    if (matches(line)) hits.push(`${label}:${i + 1}`);
  });
}

// A key is ASCII, so latin1 (one char per byte) finds it in any file, text or binary.
function scanFile(root: string, path: string, label: string, matches: (line: string) => boolean, hits: string[]): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat?.isSymbolicLink()) {
    const buildDir = BUILD_DIRS.map((d) => join(root, d)).find((d) => path === d || path.startsWith(d + sep));
    if (buildDir && !resolvesInside(path, buildDir)) {
      hits.push(`${label}: symlink that resolves outside ${relative(root, buildDir)}`);
    }
    // Git stores a symlink as its target path, so that text is what a commit would publish.
    scanText(readlinkSync(path, 'latin1'), label, matches, hits);
    return;
  }
  if (!stat?.isFile()) return;
  scanText(readFileSync(path).toString('latin1'), label, matches, hits);
}

function resolvesInside(link: string, dir: string): boolean {
  try {
    return realpathSync(link).startsWith(realpathSync(dir) + sep);
  } catch {
    return false; // dangling link
  }
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
  for (const [abs, label] of files) scanFile(root, abs, label, matches, hits);
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

// Reads `git log -p` and checks every commit message line and every added line.
// Removed lines need no check: each was an added line in some earlier commit.
// --text and --no-textconv print the real bytes of binary and `-diff` paths; first-parent
// merge diffs show what a merge resolution added. The markers carry a per-run nonce so no
// commit message or file content can forge or end them.
function scanHistory(root: string, revs: string[], matches: (line: string) => boolean, hits: string[]): number {
  const nonce = randomBytes(16).toString('hex');
  const COMMIT_START = `keyscan-commit-${nonce} `;
  const MESSAGE_END = `keyscan-message-end-${nonce}`;
  const out = git(
    [
      'log',
      '-p',
      '--text',
      '--no-textconv',
      '--no-ext-diff',
      '--diff-merges=first-parent',
      '--no-color',
      '--no-renames',
      `--format=${COMMIT_START}%H%n%B${MESSAGE_END}`,
      ...revs,
      '--',
    ],
    root,
  );
  let commit = '';
  let commits = 0;
  let inMessage = false;
  let messageLine = 0;
  let file = '';
  let inHunk = false;
  let newLine = 0;
  for (const line of out.split('\n')) {
    if (!inMessage && line.startsWith(COMMIT_START)) {
      commit = line.slice(COMMIT_START.length, COMMIT_START.length + 12);
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
    process.stderr.write(`keyscan: ${hits.length} finding(s) in ${scanned}; locations above, values not printed\n`);
    process.exit(1);
  }
  process.stderr.write(`keyscan: clean, ${scanned} scanned\n`);
}

main();
