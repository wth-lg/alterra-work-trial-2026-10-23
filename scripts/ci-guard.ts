// Fails if any workflow could read a repository credential or run a live Playwright spec.
//
//   pnpm ci:guard [dir]   dir defaults to .github/workflows
//
// Each finding prints file:line: reason. Exit codes: 0 ok, 1 finding, 2 usage error.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED_PROJECTS = new Set(['mocked', 'xbrowser']);

const RULES: Array<[RegExp, string]> = [
  [/\bsecrets\b/, 'references repository secrets; CI runs with none'],
  [/\bvars\b/, 'references repository variables; CI runs with none'],
  [/--project[= ]+["']?live\b/, 'selects the live Playwright project'],
];

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
  const projects = [...text.matchAll(/--project[= ]+["']?([\w-]+)/g)].map((m) => m[1]!);
  if (projects.length === 0) return 'runs playwright test without --project=mocked or --project=xbrowser';
  const other = projects.filter((p) => !ALLOWED_PROJECTS.has(p));
  if (other.length) return `runs playwright test with project(s) ${other.join(', ')}; only mocked and xbrowser may run in CI`;
  return undefined;
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
    for (const { line, text } of logicalLines(readFileSync(join(dir, file), 'utf8'))) {
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
