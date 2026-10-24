// pnpm cli trace-check (plan phase P9t) on fixtures/trace/clean, a small source and trace with
// a plan, repo paths and P25c-style evidence. Each case copies the clean fixture to a temp dir,
// breaks one thing, and expects exit 1 with the row id in the output; the clean copy exits 0 in
// the default mode and under --final.
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../scripts/test/helpers.ts';
import { main, type TraceRow } from '../trace-check.ts';

const CLEAN = fileURLToPath(new URL('./fixtures/trace/clean/', import.meta.url));
const SOURCE = 'docs/requirements/source.md';
const TRACE = 'docs/requirements/trace.json';

function copy(): string {
  const dir = tempDir('trace-check');
  cpSync(CLEAN, dir, { recursive: true });
  return dir;
}

function editRows(dir: string, fn: (rows: TraceRow[]) => void): void {
  const path = join(dir, TRACE);
  const trace = JSON.parse(readFileSync(path, 'utf8')) as { rows: TraceRow[] };
  fn(trace.rows);
  writeFileSync(path, `${JSON.stringify(trace, null, 2)}\n`);
}

function editSource(dir: string, from: string, to: string): void {
  const path = join(dir, SOURCE);
  const text = readFileSync(path, 'utf8');
  if (!text.includes(from)) throw new Error(`fixture source has no ${JSON.stringify(from)}`);
  writeFileSync(path, text.replace(from, to));
}

const row = (rows: TraceRow[], id: string): TraceRow => {
  const r = rows.find((x) => x.id === id);
  if (!r) throw new Error(`fixture has no row ${id}`);
  return r;
};

async function check(dir: string, ...args: string[]) {
  const lines: string[] = [];
  const code = await main(['--root', dir, ...args], { out: (l) => lines.push(l) });
  return { code, text: lines.join('\n') };
}

const final = (dir: string) => ['--final', '--evidence-root', join(dir, 'evidence')];

describe('trace-check: the 13 gate cases', () => {
  it('exits 1 on a source id with no row', async () => {
    const dir = copy();
    editRows(dir, (rows) => rows.splice(rows.indexOf(row(rows, 'W1')), 1));
    const { code, text } = await check(dir);
    expect(code).toBe(1);
    expect(text).toMatch(/^W1: no row in trace\.json; fix: /m);
  });

  it('exits 1 on a need row without ui.action', async () => {
    const dir = copy();
    editRows(dir, (rows) => {
      row(rows, 'N1').ui = { route: '/?view=environment', action: '' };
    });
    const { code, text } = await check(dir);
    expect(code).toBe(1);
    expect(text).toMatch(/^N1: ui\.action is missing; fix: /m);
  });

  it('exits 1 on a ui_required W row without ui.route', async () => {
    const dir = copy();
    editRows(dir, (rows) => {
      row(rows, 'W1').ui = { action: 'read the pass rate' } as NonNullable<TraceRow['ui']>;
    });
    const { code, text } = await check(dir);
    expect(code).toBe(1);
    expect(text).toMatch(/^W1: ui\.route is missing; fix: /m);
  });

  it('exits 1 on an N row with ui_required false', async () => {
    const dir = copy();
    editRows(dir, (rows) => {
      row(rows, 'N2').ui_required = false;
    });
    const { code, text } = await check(dir);
    expect(code).toBe(1);
    expect(text).toMatch(/^N2: ui_required must be true for every N and W row; fix: /m);
  });

  it('exits 1 on an edited source line (text_sha256 mismatch)', async () => {
    const dir = copy();
    editSource(dir, '- **N1** Something to act on.', '- **N1** Something to act upon.');
    const { code, text } = await check(dir);
    expect(code).toBe(1);
    expect(text).toMatch(/^N1: text_sha256 [0-9a-f]{12}\S* does not match the source line \(sha256 [0-9a-f]{12}/m);
  });

  it('exits 1 on a source line holding two sentences', async () => {
    const dir = copy();
    editSource(dir, '- **N1** Something to act on.\n- **N2** State the agent can read and change.\n', '- **N1** Something to act on. State the agent can read and change.\n');
    const { code, text } = await check(dir);
    expect(code).toBe(1);
    expect(text).toMatch(/^N1: the source line holds 2 sentences; fix: /m);
  });

  it('exits 1 on a phase that is not a heading in the given plan', async () => {
    const dir = copy();
    editRows(dir, (rows) => {
      row(rows, 'H1').phase = 'P7';
    });
    expect((await check(dir)).code).toBe(0);
    const { code, text } = await check(dir, '--plan', join(dir, 'plan.md'));
    expect(code).toBe(1);
    expect(text).toMatch(/^H1: phase P7 is not a "### P7:" heading in .*plan\.md; fix: /m);
  });

  it('exits 1 on a missing code path whose phase is in --done', async () => {
    const dir = copy();
    rmSync(join(dir, 'src/ui.txt'));
    const { code, text } = await check(dir, '--done', 'P1,P2');
    expect(code).toBe(1);
    expect(text).toMatch(/^N1: code path src\/ui\.txt does not exist and phase P2 is done; fix: /m);
  });

  it('--final exits 1 on a missing code path', async () => {
    const dir = copy();
    rmSync(join(dir, 'src/store.txt'));
    const { code, text } = await check(dir, ...final(dir));
    expect(code).toBe(1);
    expect(text).toMatch(/^A1: code path src\/store\.txt does not exist; fix: /m);
  });

  it('--final exits 1 on a missing evidence file', async () => {
    const dir = copy();
    rmSync(join(dir, 'evidence/verifier-phase-P25c-1/H1-writeup.txt'));
    const { code, text } = await check(dir, ...final(dir));
    expect(code).toBe(1);
    expect(text).toMatch(/^H1: evidence file verifier-phase-P25c-1\/H1-writeup\.txt does not exist under .*; fix: /m);
  });

  it('--final exits 1 on an ax_text expect whose text is absent from its snapshot', async () => {
    const dir = copy();
    writeFileSync(join(dir, 'evidence/verifier-phase-P25c-1/W1-runs-pass-rate.ax.txt'), 'heading "Runs"\ntext "No runs yet"\n');
    const { code, text } = await check(dir, ...final(dir));
    expect(code).toBe(1);
    expect(text).toMatch(/^W1: expect ax_text not met: expected "\/20" in verifier-phase-P25c-1\/W1-runs-pass-rate\.ax\.txt, observed /m);
  });

  it('--final exits 1 on a command expect whose exit code differs', async () => {
    const dir = copy();
    editRows(dir, (rows) => {
      row(rows, 'N2').expect = { command: { cmd: 'node -e "process.exit(4)"', exit: 3 } };
    });
    const { code, text } = await check(dir, ...final(dir));
    expect(code).toBe(1);
    expect(text).toMatch(/^N2: expect command not met: `node -e "process\.exit\(4\)"` expected exit 3, observed exit 4; fix: /m);
  });

  it('the clean fixture exits 0 in the default mode and under --final; a missing path of a phase not in --done passes', async () => {
    const dir = copy();
    expect(await check(dir, '--plan', join(dir, 'plan.md'), '--done', 'P1,P2')).toMatchObject({ code: 0 });
    const f = await check(dir, ...final(dir), '--plan', join(dir, 'plan.md'));
    expect(f.text).toMatch(/^trace-check: OK/m);
    expect(f.code).toBe(0);
    rmSync(join(dir, 'src/ui.txt'));
    const d = await check(dir, '--done', 'P1');
    expect(d.text).toMatch(/^trace-check: OK/m);
    expect(d.code).toBe(0);
  });
});

describe('trace-check: further rules', () => {
  it('exits 1 when ids in a section are not contiguous', async () => {
    const dir = copy();
    editSource(dir, '- **N2** State', '- **N3** State');
    const { code, text } = await check(dir);
    expect(code).toBe(1);
    expect(text).toMatch(/^N3: ids in section N must run N1\.\.Nn in order; expected N2 here; fix: /m);
  });

  it('exits 1 on a row whose id is not in the source', async () => {
    const dir = copy();
    editRows(dir, (rows) => rows.push({ ...row(rows, 'H1'), id: 'H2' }));
    const { code, text } = await check(dir);
    expect(code).toBe(1);
    expect(text).toMatch(/^H2: row has no source line; fix: /m);
  });

  it('exits 1 on a row with no tests, no evidence or no expect', async () => {
    const dir = copy();
    editRows(dir, (rows) => {
      row(rows, 'A1').tests = [];
      row(rows, 'H1').evidence = [];
      delete (row(rows, 'U1') as Partial<TraceRow>).expect;
    });
    const { code, text } = await check(dir);
    expect(code).toBe(1);
    expect(text).toMatch(/^A1: tests is empty; fix: /m);
    expect(text).toMatch(/^H1: evidence is empty; fix: /m);
    expect(text).toMatch(/^U1: expect is missing; fix: /m);
  });

  it('exits 1 on an ax_text expect whose file is not in the row evidence list', async () => {
    const dir = copy();
    editRows(dir, (rows) => {
      row(rows, 'U1').expect = { ax_text: { file: 'verifier-phase-P25c-1/other.ax.txt', text: 'x' } };
    });
    const { code, text } = await check(dir);
    expect(code).toBe(1);
    expect(text).toMatch(/^U1: expect ax_text file verifier-phase-P25c-1\/other\.ax\.txt is not in evidence; fix: /m);
  });

  it('exits 2 on --final without --evidence-root', async () => {
    const dir = copy();
    expect((await check(dir, '--final')).code).toBe(2);
  });
});
