// Cross-trial grader state planted where the lint rule cannot see it (the P9 verifier's G2-G7,
// evidence/verifier-phase-P9-26/21-lint-variants.txt), each wired into one extra gate of the toy
// so the state it carries shows in a grade. Each plant is a checks module written to a temp
// directory, importing the toy's real checks by absolute path, so the repo is never changed and
// the matrix's fresh-process grade imports the same file. The extra gate is always met; only
// its evidence carries the state, so the toy's outcomes and failed gate sets do not move.
import { join } from 'node:path';
import { tempDir, write } from '../../../../scripts/test/helpers.ts';

const REPO = join(import.meta.dirname, '..', '..', '..', '..');
const CHECK = join(REPO, 'packages/grader/check.ts');
const TOY = join(REPO, 'tasks/_toy/tests/grader.ts');

// Each plant: module-level code, then the evidence expression its gate records (`t` is the
// trial's committed writes, which differ between the oracle and the read_only mutant).
export const PLANTS: Record<string, { state: string; evidence: string; helper?: string }> = {
  G2_alias: {
    state: 'const seen2 = new Set<string>(); const alias2 = seen2;',
    evidence: '{ seen: seen2.size, added: (alias2.add(t), true) }',
  },
  G3_closure_factory: {
    state: 'const counter3 = (() => { const box = { n: 0 }; return () => ++box.n; })();',
    evidence: '{ n: counter3() }',
  },
  G4_alias_inside_fn: {
    state: 'const m4 = new Map<string, number>(); const g4 = (k: string) => { const local = m4; local.set(k, 1); return m4.size; };',
    evidence: '{ size: g4(t) }',
  },
  G5_globalThis: {
    state: 'const g5 = (t: string) => { const g = globalThis as Record<string, unknown>; const was = g.__seen5; g.__seen5 = t; return was ?? null; };',
    evidence: '{ was: g5(t) as string | null }',
  },
  G6_class_static: {
    state: 'class Memo { static last: string | null = null; } const g6 = (t: string) => { const was = Memo.last; Memo.last = t; return was; };',
    evidence: '{ was: g6(t) }',
  },
  G7_helper_module: {
    state: "import { remember7, recall7 } from './state7.ts';",
    evidence: '{ n: (remember7(t), recall7()) }',
    helper: 'const box7: string[] = []; export const remember7 = (t: string) => { box7.push(t); }; export const recall7 = () => box7.length;',
  },
};

// Writes the plant's checks module and returns its path.
export function plant(name: keyof typeof PLANTS): string {
  const p = PLANTS[name]!;
  const dir = tempDir(`matrix-plant-${name}`);
  if (p.helper) write(dir, 'state7.ts', `${p.helper}\n`);
  write(
    dir,
    'grader.ts',
    [
      `import { gate, type Check } from ${JSON.stringify(CHECK)};`,
      `import { checks as toy } from ${JSON.stringify(TOY)};`,
      p.state,
      'const planted = gate({',
      `  id: 'planted', category: 'process', traces_to: 'instruction.md:4', decisive_ids: [],`,
      `  fn: (ctx) => { const t = ctx.writes().join(' '); return { met: true, evidence: ${p.evidence} }; },`,
      '});',
      'export const checks: Check[] = [...toy, planted];',
      '',
    ].join('\n'),
  );
  return join(dir, 'grader.ts');
}
