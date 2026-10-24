// pnpm cli trace-check (plan phase P9t) on fixtures/trace/clean, a small source and trace with
// a plan, a UI contract, repo paths and P25c-style evidence. Each case copies the clean fixture to a temp dir,
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
      row(rows, 'N1').ui = { route: '/?view=environment', action: '', surface: 'any' };
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
    expect(text).toMatch(/^W1: expect\[1\] ax_text not met: expected "1 of 1 tasks in band" in verifier-phase-P25c-1\/W1-runs-pass-rate\.ax\.txt, observed /m);
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

describe('trace-check: expects that test outcomes (builder-43)', () => {
  it('--final exits 1 when one element of an expect list fails and the others hold', async () => {
    const dir = copy();
    writeFileSync(join(dir, 'evidence/verifier-phase-P25c-1/W1-runs-pass-rate.ax.txt'), 'heading "Runs"\ntext "1 of 1 tasks in band"\n');
    const { code, text } = await check(dir, ...final(dir));
    expect(code).toBe(1);
    expect(text).toMatch(/^W1: expect\[2\] ax_match not met: expected at least 1 match of \/.*\/ in verifier-phase-P25c-1\/W1-runs-pass-rate\.ax\.txt, observed 0; fix: /m);
    expect(text).not.toMatch(/^W1: expect\[[01]\]/m);
  });

  it('--final exits 1 when a command element of an expect list fails', async () => {
    const dir = copy();
    editRows(dir, (rows) => {
      (row(rows, 'W1').expect as unknown as object[])[0] = { command: { cmd: 'node -e "process.exit(1)"', exit: 0 } };
    });
    const { code, text } = await check(dir, ...final(dir));
    expect(code).toBe(1);
    expect(text).toMatch(/^W1: expect\[0\] command not met: .* expected exit 0, observed exit 1; fix: /m);
  });

  it('exits 1 on an empty expect list, a bad element and a bad pattern', async () => {
    const dir = copy();
    editRows(dir, (rows) => {
      row(rows, 'N1').expect = [] as unknown as TraceRow['expect'];
      row(rows, 'U1').expect = [{ ax_text: { file: 'verifier-phase-P25c-1/U1-overview-surface.ax.txt', text: 'local runner' } }, { shell: 'x' }] as unknown as TraceRow['expect'];
      (row(rows, 'W1').expect as unknown as { ax_match?: { pattern: string } }[])[2]!.ax_match!.pattern = '([0-9';
    });
    const { code, text } = await check(dir);
    expect(code).toBe(1);
    expect(text).toMatch(/^N1: expect is an empty list; fix: /m);
    expect(text).toMatch(/^U1: expect\[1\] must hold exactly one of ax_text, ax_match or command; fix: /m);
    expect(text).toMatch(/^W1: expect\[2\] ax_match pattern is not a valid regular expression/m);
  });

  it('--final exits 1 when an ax_match pattern matches fewer times than min_matches ("20/20" does not satisfy a k/20 count of 2)', async () => {
    const dir = copy();
    editRows(dir, (rows) => {
      (row(rows, 'W1').expect as unknown as { ax_match?: { min_matches: number } }[])[2]!.ax_match!.min_matches = 2;
    });
    const { code, text } = await check(dir, ...final(dir));
    expect(code).toBe(1);
    expect(text).toMatch(/^W1: expect\[2\] ax_match not met: expected at least 2 matches of .*, observed 1; fix: /m);
  });

  it('exits 1 when the last sentence of a section and its row are deleted together (block pin)', async () => {
    const dir = copy();
    editSource(dir, '- **H1** Plus a writeup, in whatever form suits you.\n', '');
    editRows(dir, (rows) => rows.splice(rows.indexOf(row(rows, 'H1')), 1));
    const { code, text } = await check(dir);
    expect(code).toBe(1);
    expect(text).toMatch(/^source: the A\/N\/W\/H block has sha256 [0-9a-f]{12}\S*, but pdf_block_sha256 is [0-9a-f]{12}\S*; fix: /m);
  });

  it('exits 1 when trace.json has no pdf_block_sha256', async () => {
    const dir = copy();
    const path = join(dir, TRACE);
    const trace = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    delete trace.pdf_block_sha256;
    writeFileSync(path, JSON.stringify(trace));
    const { code, text } = await check(dir);
    expect(code).toBe(1);
    expect(text).toMatch(/^source: trace\.json has no pdf_block_sha256; fix: /m);
  });

  it('--final exits 1 on a placeholder in a route; the default mode reports only the contract gap', async () => {
    const dir = copy();
    editRows(dir, (rows) => {
      row(rows, 'W1').ui!.route = '/?view=runs&trial=<first non-pass trial>';
    });
    writeFileSync(join(dir, 'docs/requirements/ui-contract.md'), `${readFileSync(join(dir, 'docs/requirements/ui-contract.md'), 'utf8')}- \`/?view=runs&trial=<first non-pass trial>\`\n`);
    expect((await check(dir)).code).toBe(0);
    const { code, text } = await check(dir, ...final(dir));
    expect(code).toBe(1);
    expect(text).toMatch(/^W1: ui\.route .* holds a placeholder \(<\); fix: /m);
  });

  it('exits 1 on an ax_text, an ax_match pattern or a route that ui-contract.md does not list', async () => {
    const dir = copy();
    writeFileSync(join(dir, 'docs/requirements/ui-contract.md'), '# UI contract\n\n- `/`\n- `/?view=runs`\n- `local runner`\n');
    const { code, text } = await check(dir);
    expect(code).toBe(1);
    expect(text).toMatch(/^N1: ui\.route \/\?view=environment is not listed in ui-contract\.md; fix: /m);
    expect(text).toMatch(/^N1: expect ax_text "hash unchanged" is not listed in ui-contract\.md; fix: /m);
    expect(text).toMatch(/^W1: expect\[1\] ax_text "1 of 1 tasks in band" is not listed in ui-contract\.md; fix: /m);
    expect(text).toMatch(/^W1: expect\[2\] ax_match pattern .* is not listed in ui-contract\.md; fix: /m);
    expect(text).not.toMatch(/^U1: /m);
  });

  it('exits 2 when ui-contract.md is missing', async () => {
    const dir = copy();
    rmSync(join(dir, 'docs/requirements/ui-contract.md'));
    const { code, text } = await check(dir);
    expect(code).toBe(2);
    expect(text).toMatch(/ui-contract\.md/);
  });

  it('exits 1 on a ui without surface, a bad surface, and a UI snapshot on a row with no route', async () => {
    const dir = copy();
    editRows(dir, (rows) => {
      delete (row(rows, 'N1').ui as Partial<NonNullable<TraceRow['ui']>>).surface;
      (row(rows, 'U1').ui as { surface: string }).surface = 'web';
      row(rows, 'A1').evidence.push('verifier-phase-P25c-1/A1-screen.ax.txt');
    });
    const { code, text } = await check(dir);
    expect(code).toBe(1);
    expect(text).toMatch(/^N1: ui\.surface is missing; fix: /m);
    expect(text).toMatch(/^U1: ui\.surface "web" is not local, hosted or any; fix: /m);
    expect(text).toMatch(/^A1: evidence verifier-phase-P25c-1\/A1-screen\.ax\.txt is a UI snapshot, but the row has no ui\.route; fix: /m);
  });

  it('exits 1 when a done-when clause has no row, or a row names a clause that does not exist', async () => {
    const dir = copy();
    editRows(dir, (rows) => {
      row(rows, 'W1').done_when = [3];
    });
    const { code, text } = await check(dir);
    expect(code).toBe(1);
    expect(text).toMatch(/^W1: done_when names 3, but done-when has clauses 1\.\.2; fix: /m);
    expect(text).toMatch(/^done-when \(2\): no row names it in done_when; fix: /m);
  });
});
