// pnpm cli audit-check <run> [--json]
// Checks a run's human audit, <run>/audit.jsonl, one label per line (design section 5, "Human
// audit"):
//   {trial: "<task>/<index>", outcome, taxonomy, model_fault: yes|no|unclear, decisive_step,
//    evidence_ids: [...], llm_auditor_agrees, adjudication?, note}
// A PASS label has taxonomy, model_fault and decisive_step null. Every check reads each record's
// current grade (packages/core/summary.ts currentGrade: its last cli regrade, else its recorded
// outcome). It exits 1, naming each violation, unless:
//   - every failure (a valid trial that is not a PASS) has exactly one label, whose outcome is the
//     current grade and whose taxonomy is in the label set (packages/grader/attribution.ts TAXONOMY);
//     a taxonomy of environment or grader is counted and is a violation;
//   - no failure label contradicts itself: on an outcome that is the model's fault
//     (packages/core/outcomes.ts FAULT: FAIL, LIMIT), a model taxonomy (TAXONOMY) says
//     model_fault yes or unclear, never no, and an environment or grader taxonomy never says yes;
//   - each failure label names a decisive step that is a step of the trajectory;
//   - every evidence id of every label appears in the trajectory (exposed, referenced or written);
//   - every decisive id of a failure was exposed, or is exposable: it is in the world, so the tool
//     would have returned it had the model asked;
//   - no attempt, re-queued ones included, had an INTERNAL tool error;
//   - every record's replay_final equals its final hash, and replay.json, when present, says
//     every trial reproduced;
//   - every label with model_fault unclear or llm_auditor_agrees false carries an adjudication;
//   - each task has at least 2 audited PASS trials with evidence ids (all of them when it has
//     fewer than 2 passes).
// --json prints {failures, labelled, environment, grader, violations}. Exit 2 on a usage error.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BatchRecord } from '../packages/core/batch.ts';
import { installEgressGuard } from '../packages/core/egress.ts';
import { FAULT, type Outcome } from '../packages/core/outcomes.ts';
import { parseTrajectory } from '../packages/core/trajectory.ts';
import { currentGrade } from '../packages/core/summary.ts';
import { loadStore } from '../packages/env/fixture-source.ts';
import { TAXONOMY, type Attribution } from '../packages/grader/attribution.ts';
import { sameId, stepsOf } from '../packages/grader/exposure.ts';
import { requeuedRecords, settledRecords, trajectoryOf } from './adapters/result-sink-node.ts';
import { trialName } from './replay.ts';
import { repoWorld } from './run.ts';
import { readReplay } from './summary.ts';

export interface Deps {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface AuditLabel {
  trial: string;
  outcome: string;
  taxonomy: string | null;
  model_fault: 'yes' | 'no' | 'unclear' | null;
  decisive_step: number | null;
  evidence_ids: string[];
  llm_auditor_agrees: boolean | null;
  adjudication?: string;
  note?: string;
}

const defaults: Deps = { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) };
const NOT_MODEL = new Set(['environment', 'grader']);
const MIN_AUDITED_PASSES = 2;

function readLabels(dir: string, violations: string[]): AuditLabel[] {
  const file = join(dir, 'audit.jsonl');
  if (!existsSync(file)) {
    violations.push('audit.jsonl is missing');
    return [];
  }
  return readFileSync(file, 'utf8').split('\n').flatMap((line, i) => {
    if (line.trim() === '') return [];
    try {
      const l = JSON.parse(line) as AuditLabel;
      if (typeof l.trial !== 'string' || !Array.isArray(l.evidence_ids)) throw new Error('needs trial and evidence_ids');
      return [l];
    } catch (e) {
      violations.push(`audit.jsonl line ${i + 1}: ${(e as Error).message}`);
      return [];
    }
  });
}

export async function main(args: string[], deps: Deps = defaults): Promise<number> {
  const json = args.includes('--json');
  const rest = args.filter((a) => a !== '--json');
  if (rest.length !== 1 || rest[0]!.startsWith('--')) {
    deps.err('usage: pnpm cli audit-check <run> [--json]');
    return 2;
  }
  const dir = rest[0] as string;
  if (!existsSync(join(dir, 'trials'))) {
    deps.err(`audit-check: ${dir} has no trials/ directory`);
    return 1;
  }
  const v: string[] = [];
  const records = new Map(settledRecords(dir).map((s) => [trialName(s.record), s.record]));
  const labels = readLabels(dir, v);
  const byTrial = new Map<string, AuditLabel>();
  for (const l of labels) {
    if (byTrial.has(l.trial)) v.push(`${l.trial}: more than one audit label`);
    byTrial.set(l.trial, l);
  }
  const steps = new Map<string, ReturnType<typeof stepsOf>>();
  const stepsFor = (r: BatchRecord) => {
    const name = trialName(r);
    if (!steps.has(name)) {
      const file = trajectoryOf(dir, r);
      steps.set(name, existsSync(file) ? stepsOf(parseTrajectory(readFileSync(file, 'utf8'))) : []);
    }
    return steps.get(name) as ReturnType<typeof stepsOf>;
  };
  let world: Promise<Set<string>> | undefined;
  const inWorld = async (id: string) => {
    world ??= (async () => {
      const store = await loadStore(repoWorld().world);
      return new Set([...store.resources()].map((r) => `${r.resourceType}/${r.id}`));
    })();
    const keys = await world;
    return id.includes('/') ? keys.has(id) : [...keys].some((k) => sameId(k, id));
  };

  const failures = [...records.values()].filter((r) => currentGrade(r).valid && currentGrade(r).outcome !== 'PASS');
  let environment = 0;
  let grader = 0;
  for (const l of labels) {
    const r = records.get(l.trial);
    if (r === undefined) {
      v.push(`${l.trial}: audit label for a trial the run has not settled`);
      continue;
    }
    const { outcome, regraded } = currentGrade(r);
    if (l.outcome !== outcome) v.push(`${l.trial}: labelled ${l.outcome}, ${regraded ? 'the current grade is' : 'the record says'} ${outcome}`);
    const ids = new Set(stepsFor(r).flatMap((s) => [...s.exposed_ids, ...s.referenced_ids, ...s.written_ids]));
    for (const id of l.evidence_ids) if (![...ids].some((k) => sameId(k, id))) v.push(`${l.trial}: evidence id ${id} is not in the trajectory`);
    if (l.model_fault === 'unclear' || l.llm_auditor_agrees === false) {
      if (typeof l.adjudication !== 'string' || l.adjudication.trim() === '') {
        v.push(`${l.trial}: ${l.model_fault === 'unclear' ? 'model_fault unclear' : 'the LLM auditor disagrees'}, and no adjudication is recorded`);
      }
    }
    if (outcome === 'PASS') continue;
    if (l.taxonomy === 'environment') environment++;
    if (l.taxonomy === 'grader') grader++;
    if (l.taxonomy !== null && NOT_MODEL.has(l.taxonomy)) v.push(`${l.trial}: labelled ${l.taxonomy}: a failure that is the ${l.taxonomy}'s fault, not the model's`);
    else if (!(TAXONOMY as readonly (string | null)[]).includes(l.taxonomy)) v.push(`${l.trial}: taxonomy ${l.taxonomy} is not in the label set (${TAXONOMY.join(', ')})`);
    if (!['yes', 'no', 'unclear'].includes(l.model_fault as string)) v.push(`${l.trial}: model_fault must be yes, no or unclear`);
    else if (FAULT[outcome as Outcome] === 'model') {
      const modelLabel = (TAXONOMY as readonly (string | null)[]).includes(l.taxonomy);
      if (modelLabel && l.model_fault === 'no') v.push(`${l.trial}: labelled ${l.taxonomy}, a model failure, with model_fault no`);
      if (l.taxonomy !== null && NOT_MODEL.has(l.taxonomy) && l.model_fault === 'yes') v.push(`${l.trial}: labelled ${l.taxonomy}, not the model's fault, with model_fault yes`);
    }
    const n = stepsFor(r).length;
    if (!Number.isSafeInteger(l.decisive_step) || (l.decisive_step as number) < 1 || (l.decisive_step as number) > n) {
      v.push(`${l.trial}: decisive step ${l.decisive_step} is not a step of the trajectory (1-${n})`);
    }
    if (l.evidence_ids.length === 0) v.push(`${l.trial}: no evidence ids`);
  }
  for (const r of failures) {
    const name = trialName(r);
    if (!byTrial.has(name)) v.push(`${name}: ${currentGrade(r).outcome}, no audit label`);
    for (const e of (r.attribution as Attribution | null)?.exposure ?? []) {
      if (e.first_exposed_step === null && !(await inWorld(e.id))) v.push(`${name}: decisive id ${e.id} was never exposed and is not exposable (not in the world)`);
    }
  }
  const internal = [...records.values(), ...requeuedRecords(dir).map((s) => s.record)].filter((r) => (r.tool_errors?.INTERNAL ?? 0) > 0);
  if (internal.length > 0) v.push(`INTERNAL tool errors in ${internal.map((r) => `${trialName(r)} (${r.attempt})`).join(', ')}; the run must have 0`);
  const replay = readReplay(dir);
  for (const [name, r] of records) {
    if (r.state_hash.final === null || r.state_hash.replay_final !== r.state_hash.final) v.push(`${name}: replay_final ${r.state_hash.replay_final} is not final ${r.state_hash.final}`);
    if (replay !== null && replay[name] !== true) v.push(`${name}: replay.json says it did not reproduce`);
  }
  for (const task of [...new Set([...records.values()].map((r) => r.task_id))].sort()) {
    const passes = [...records.values()].filter((r) => r.task_id === task && currentGrade(r).outcome === 'PASS');
    const audited = passes.filter((r) => (byTrial.get(trialName(r))?.evidence_ids.length ?? 0) > 0).length;
    const need = Math.min(MIN_AUDITED_PASSES, passes.length);
    if (audited < need) v.push(`${task}: ${audited} audited PASS with evidence ids, need ${need}`);
  }

  const labelled = failures.filter((r) => byTrial.has(trialName(r))).length;
  const say = json ? deps.err : deps.out;
  for (const line of v) say(`violation: ${line}`);
  say(`audit-check: ${labelled}/${failures.length} failures labelled, environment ${environment}, grader ${grader}; ${v.length === 0 ? 'every check holds' : `${v.length} violation(s)`}`);
  if (json) deps.out(JSON.stringify({ failures: failures.length, labelled, environment, grader, violations: v }));
  return v.length === 0 ? 0 : 1;
}

export default (args: string[]) => {
  installEgressGuard(globalThis);
  return main(args);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  installEgressGuard(globalThis);
  process.exitCode = await main(process.argv.slice(2));
}
