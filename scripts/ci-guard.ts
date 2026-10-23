// Fails if any workflow could read a repository credential, run a live Playwright spec, or
// hand the Pages deploy token scopes to a job that does not deploy.
//
//   pnpm ci:guard [dir]   dir defaults to .github/workflows
//
// Each finding prints file:line: reason. Exit codes: 0 ok, 1 finding, 2 usage error.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED_PROJECTS = new Set(['mocked', 'xbrowser']);

// Case-insensitive: the Actions runner resolves expression named values (secrets, vars)
// case-insensitively, and Playwright lowercases --project values.
const RULES: Array<[RegExp, string]> = [
  [/\bsecrets\b/i, 'references repository secrets; CI runs with none'],
  [/\bvars\b/i, 'references repository variables; CI runs with none'],
  [/--project[= ]+["']?live\b/i, 'selects the live Playwright project'],
];

// Token scopes only actions/deploy-pages needs. A job-level permissions block replaces the
// workflow-level one, so granting them to the deploy job alone keeps the build job read-only.
const DEPLOY_ONLY = /\b(pages|id-token)\s*:\s*write\b/i;

// Joins shell continuation lines so a flag on the next line counts for the command.
function logicalLines(text: string): Array<{ line: number; text: string }> {
  const out: Array<{ line: number; text: string }> = [];
  let start = 0;
  let buf = '';
  text.split('\n').forEach((raw, i) => {
    if (!buf) start = i + 1;
    if (raw.trimEnd().endsWith('\\')) buf += `${raw.trimEnd().slice(0, -1)} `;
    else {
      out.push({ line: start, text: buf + raw });
      buf = '';
    }
  });
  if (buf) out.push({ line: start, text: buf });
  return out;
}

function playwrightProblem(text: string): string | undefined {
  if (!/\bplaywright\s+test\b/.test(text)) return undefined;
  // Takes the raw value, quotes and all: Playwright treats * as a wildcard, so only the bare
  // names mocked and xbrowser are accepted.
  const projects = [...text.matchAll(/--project(?:=(\S*)|\s+(\S+)|\s*$)/gi)].map((m) => m[1] ?? m[2] ?? '');
  if (projects.length === 0) return 'runs playwright test without --project=mocked or --project=xbrowser';
  const other = projects.filter((p) => !ALLOWED_PROJECTS.has(p.toLowerCase()));
  if (other.length) {
    return `runs playwright test with project(s) ${other.join(', ')}; only the unquoted names mocked and xbrowser may run in CI`;
  }
  return undefined;
}

// Tracks which top-level key and which job each line sits in, from indentation alone.
function permissionProblems(text: string): Array<{ line: number; reason: string }> {
  const out: Array<{ line: number; reason: string }> = [];
  const jobs: Array<{ text: string; grants: Array<{ line: number; scope: string }> }> = [];
  let top = '';
  let jobIndent = -1;
  let job: (typeof jobs)[number] | undefined;
  text.split('\n').forEach((raw, i) => {
    if (!raw.trim() || raw.trimStart().startsWith('#')) return;
    const indent = raw.length - raw.trimStart().length;
    if (indent === 0) {
      top = raw.split(':')[0]!.trim();
      jobIndent = -1;
      job = undefined;
    } else if (top === 'jobs') {
      if (jobIndent === -1) jobIndent = indent;
      if (indent === jobIndent) jobs.push((job = { text: '', grants: [] }));
    }
    if (job) job.text += `${raw}\n`;
    if (/\bwrite-all\b/i.test(raw)) out.push({ line: i + 1, reason: 'grants write-all; grant each scope a job needs by name' });
    const grant = DEPLOY_ONLY.exec(raw);
    if (!grant) return;
    if (job) job.grants.push({ line: i + 1, scope: grant[1]! });
    else out.push({ line: i + 1, reason: `grants ${grant[1]}: write at workflow level; grant it only to the job that runs actions/deploy-pages` });
  });
  for (const j of jobs) {
    if (/\bactions\/deploy-pages@/.test(j.text)) continue;
    for (const g of j.grants) out.push({ line: g.line, reason: `grants ${g.scope}: write to a job that does not run actions/deploy-pages` });
  }
  return out;
}

function main(): void {
  const dir = process.argv[2] ?? '.github/workflows';
  if (!existsSync(dir)) {
    process.stderr.write(`ci-guard: no such directory: ${dir}\n`);
    process.exit(2);
  }
  const files = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort();
  const findings: string[] = [];
  for (const file of files) {
    const content = readFileSync(join(dir, file), 'utf8');
    for (const { line, reason } of permissionProblems(content)) findings.push(`${join(dir, file)}:${line}: ${reason}`);
    for (const { line, text } of logicalLines(content)) {
      const where = `${join(dir, file)}:${line}`;
      for (const [pattern, reason] of RULES) if (pattern.test(text)) findings.push(`${where}: ${reason}`);
      const problem = playwrightProblem(text);
      if (problem) findings.push(`${where}: ${problem}`);
    }
  }
  for (const f of findings) process.stdout.write(`${f}\n`);
  if (findings.length) {
    process.stderr.write(`ci-guard: ${findings.length} finding(s) in ${files.length} workflow file(s)\n`);
    process.exit(1);
  }
  process.stderr.write(`ci-guard: ok, ${files.length} workflow file(s) checked\n`);
}

main();
