// pnpm cli audit-check <run> [--json]
// Checks a run's human audit, <run>/audit.jsonl, one label per line (design section 5, "Human
// audit"; packages/core/explain.ts AuditRow):
//   {trial: "<task>/<index>", outcome, taxonomy, label?, label_subtype?, model_fault: yes|no|unclear,
//    decisive_step, evidence_ids: [...], llm_auditor_agrees, adjudicated_label?, note, criteria?}
// A PASS label has taxonomy, model_fault and decisive_step null. A label without label reads its
// label from its taxonomy (explain.ts auditLabelOf). Every check reads each record's current grade
// (packages/core/summary.ts currentGrade: its last cli regrade, else its recorded outcome), and the
// label set, the fault, the criteria and their texts come from packages/core/outcomes.ts through
// explain.ts explainTrial; nothing here restates them. It exits 1, naming each violation, unless:
//   - every failure (a valid trial that is not a PASS) has exactly one label, whose outcome is the
//     current grade, whose label is one of AUDIT_LABELS and equals AUDIT_LABEL of the trial's
//     fault (a refusal: model with subtype refusal), and whose taxonomy, on a model label that is
//     not a refusal, is in packages/grader/attribution.ts TAXONOMY;
//   - no INFRA or CANCELLED trial (FAULT infra) carries a label or is in the valid set;
//   - no failure label contradicts itself: on an outcome FAULT gives model, a model label never
//     says model_fault no, and an environment or grader label never says yes;
//   - each failure label names a decisive step that is a step of the trajectory;
//   - every evidence id of every label appears in the trajectory (exposed, referenced or written);
//   - confirmation criteria M1 and M4 (outcomes.ts CONFIRMATION_CRITERIA) are met on every failure:
//     pending is a violation too, because an audited trial must show met or not met;
//   - no attempt, re-queued ones included, had an INTERNAL tool error;
//   - every record's replay_final equals its final hash, and replay.json, when present, says
//     every trial reproduced;
//   - every label with model_fault unclear or llm_auditor_agrees false carries an adjudicated_label,
//     one of AUDIT_LABELS;
//   - each task has at least 2 audited PASS trials with evidence ids (all of them when it has
//     fewer than 2 passes).
// It writes each label's criteria, explainTrial's M1-M5 for its trial, into audit.jsonl (only when
// they changed, so a second run leaves the file as it was). The context it gives explainTrial
// (explainContext): the trajectory; the run manifest's world_hash as the manifest hash; the world
// for exposability; <run>/matrix.json, {task_versions: {<task_version>: {oracle_pass,
// alternatives_pass}}}, for M4; and, on a regraded trial whose first failed check is not the one
// its recorded attribution names, that check's decisive ids (from the task's gate checks) with the
// step each was first exposed at in the trajectory (packages/grader/exposure.ts firstExposed).
// --json prints {failures, labelled, environment, grader, violations}. Exit 2 on a usage error.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { BatchRecord } from '../packages/core/batch.ts';
import { installEgressGuard } from '../packages/core/egress.ts';
import type { TrialEvent } from '../packages/core/events.ts';
import { auditLabelOf, explainTrial, formatCriterion, type AuditRow, type ExplainContext, type ExplainRecord } from '../packages/core/explain.ts';
import { AUDIT_LABEL, AUDIT_LABELS, FAULT, type Outcome } from '../packages/core/outcomes.ts';
import { parseTrajectory } from '../packages/core/trajectory.ts';
import { currentGrade } from '../packages/core/summary.ts';
import { loadStore } from '../packages/env/fixture-source.ts';
import { TAXONOMY, type Attribution } from '../packages/grader/attribution.ts';
import { firstExposed, sameId, stepsOf } from '../packages/grader/exposure.ts';
import { requeuedRecords, settledRecords, trajectoryOf } from './adapters/result-sink-node.ts';
import { trialName } from './replay.ts';
import { repoWorld, taskChecks } from './run.ts';
import { readReplay } from './summary.ts';

// A task's checks as far as audit-check reads them: a gate's decisive ids.
export type TaskChecks = (task: string) => Promise<ReadonlyArray<{ id: string; decisive_ids?: readonly string[] }>>;

export interface Deps {
  out: (line: string) => void;
  err: (line: string) => void;
  // Default cli/run.ts taskChecks.
  checks?: TaskChecks;
}

export type AuditLabel = AuditRow;

const defaults: Deps = { out: (l) => process.stdout.write(`${l}\n`), err: (l) => process.stderr.write(`${l}\n`) };
const MIN_AUDITED_PASSES = 2;
const isLabel = (l: string | null | undefined): boolean => (AUDIT_LABELS as readonly (string | null | undefined)[]).includes(l);

// audit.jsonl's lines, each with its label when it parses.
function readLabels(dir: string, violations: string[]): Array<{ raw: string; label: AuditLabel | null }> | null {
  const file = join(dir, 'audit.jsonl');
  if (!existsSync(file)) {
    violations.push('audit.jsonl is missing');
    return null;
  }
  return readFileSync(file, 'utf8').split('\n').flatMap((raw, i): Array<{ raw: string; label: AuditLabel | null }> => {
    if (raw.trim() === '') return [];
    try {
      const l = JSON.parse(raw) as AuditLabel;
      if (typeof l.trial !== 'string' || !Array.isArray(l.evidence_ids)) throw new Error('needs trial and evidence_ids');
      return [{ raw, label: l }];
    } catch (e) {
      violations.push(`audit.jsonl line ${i + 1}: ${(e as Error).message}`);
      return [{ raw, label: null }];
    }
  });
}

type Matrix = NonNullable<ExplainContext['matrix']>;

// <run>/matrix.json's verdict per task_version, or an empty map when there is none.
function readMatrix(dir: string): Map<string, Matrix> {
  const file = join(dir, 'matrix.json');
  if (!existsSync(file)) return new Map();
  const { task_versions } = JSON.parse(readFileSync(file, 'utf8')) as { task_versions?: Record<string, { oracle_pass?: unknown; alternatives_pass?: unknown }> };
  return new Map(Object.entries(task_versions ?? {}).flatMap(([task_version, m]) =>
    typeof m.oracle_pass === 'boolean' && typeof m.alternatives_pass === 'boolean' ? [[task_version, { task_version, oracle_pass: m.oracle_pass, alternatives_pass: m.alternatives_pass }] as const] : []));
}

// What explainTrial gets for each record of the run in dir (see the header).
export async function explainContext(dir: string, checks: TaskChecks = taskChecks): Promise<(r: BatchRecord) => Promise<ExplainContext & { events: TrialEvent[] }>> {
  const manifestFile = join(dir, 'manifest.json');
  const manifest = existsSync(manifestFile) ? (JSON.parse(readFileSync(manifestFile, 'utf8')) as { world_hash?: unknown }) : null;
  const world_state_hash = typeof manifest?.world_hash === 'string' ? manifest.world_hash : null;
  const matrix = readMatrix(dir);
  const events = new Map<string, TrialEvent[]>();
  let world: Promise<Set<string>> | undefined;
  const inWorld = async (id: string) => {
    world ??= (async () => {
      const store = await loadStore(repoWorld().world);
      return new Set([...store.resources()].map((r) => `${r.resourceType}/${r.id}`));
    })();
    const keys = await world;
    return id.includes('/') ? keys.has(id) : [...keys].some((k) => sameId(k, id));
  };
  const gates = new Map<string, Promise<ReadonlyArray<{ id: string; decisive_ids?: readonly string[] }>>>();
  // The decisive ids of the check a regrade failed first, when it is not the recorded attribution's.
  const regradedDecisive = async (r: BatchRecord): Promise<{ check: string; ids: string[] } | null> => {
    const failed = (currentGrade(r).checks ?? []).find((c) => (c as { kind?: string }).kind !== 'rubric' && c.met === false);
    if (failed === undefined || (r.attribution as Attribution | null)?.first_failed === failed.id) return null;
    if (!gates.has(r.task_id)) gates.set(r.task_id, checks(r.task_id).catch(() => []));
    const ids = (await gates.get(r.task_id)!).find((g) => g.id === failed.id)?.decisive_ids;
    return ids === undefined ? null : { check: failed.id, ids: [...ids] };
  };
  return async (r) => {
    const name = trialName(r);
    if (!events.has(name)) {
      const file = trajectoryOf(dir, r);
      events.set(name, existsSync(file) ? parseTrajectory(readFileSync(file, 'utf8')) : []);
    }
    const trajectory = events.get(name) as TrialEvent[];
    const moved = await regradedDecisive(r);
    const exposure = moved === null ? null : { check: moved.check, ids: moved.ids.map((id) => ({ id, first_exposed_step: firstExposed(stepsOf(trajectory), id) })) };
    const exposable = new Set<string>();
    for (const e of [...((r.attribution as Attribution | null)?.exposure ?? []), ...(exposure?.ids ?? [])]) if (e.first_exposed_step === null && (await inWorld(e.id))) exposable.add(e.id);
    return { events: trajectory, world_state_hash, exposable: (id) => exposable.has(id), matrix: matrix.get(r.task_version ?? '') ?? null, exposure };
  };
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
  const requeued = requeuedRecords(dir).map((s) => s.record);
  const lines = readLabels(dir, v);
  const labels = (lines ?? []).flatMap((l) => (l.label === null ? [] : [l.label]));
  const byTrial = new Map<string, AuditLabel>();
  for (const l of labels) {
    if (byTrial.has(l.trial)) v.push(`${l.trial}: more than one audit label`);
    byTrial.set(l.trial, l);
  }
  const ctxOf = await explainContext(dir, deps.checks);
  const explain = async (r: BatchRecord, row?: AuditLabel) => {
    const { criteria: _criteria, ...audit } = row ?? ({} as AuditLabel);
    return explainTrial(r as ExplainRecord, row === undefined ? undefined : audit, await ctxOf(r));
  };
  const stepsFor = async (r: BatchRecord) => stepsOf((await ctxOf(r)).events);

  const failures = [...records.values()].filter((r) => currentGrade(r).valid && currentGrade(r).outcome !== 'PASS');
  let environment = 0;
  let grader = 0;
  for (const l of labels) {
    const r = records.get(l.trial);
    if (r === undefined) {
      const infra = requeued.find((a) => trialName(a) === l.trial && FAULT[currentGrade(a).outcome as Outcome] === 'infra');
      v.push(infra === undefined ? `${l.trial}: audit label for a trial the run has not settled` : `${l.trial}: ${currentGrade(infra).outcome} carries a label, and an INFRA trial gets none (it is rerun); the run has not settled the trial`);
      continue;
    }
    const { outcome, regraded } = currentGrade(r);
    if (l.outcome !== outcome) v.push(`${l.trial}: labelled ${l.outcome}, ${regraded ? 'the current grade is' : 'the record says'} ${outcome}`);
    const steps = await stepsFor(r);
    const ids = new Set(steps.flatMap((s) => [...s.exposed_ids, ...s.referenced_ids, ...s.written_ids]));
    for (const id of l.evidence_ids) if (![...ids].some((k) => sameId(k, id))) v.push(`${l.trial}: evidence id ${id} is not in the trajectory`);
    if (l.adjudicated_label !== undefined && l.adjudicated_label !== null && !isLabel(l.adjudicated_label)) v.push(`${l.trial}: adjudicated_label ${l.adjudicated_label} is not one of ${AUDIT_LABELS.join(', ')}`);
    else if ((l.model_fault === 'unclear' || l.llm_auditor_agrees === false) && !isLabel(l.adjudicated_label)) {
      v.push(`${l.trial}: ${l.model_fault === 'unclear' ? 'model_fault unclear' : 'the LLM auditor disagrees'}, and no adjudicated_label is recorded`);
    }
    if (outcome === 'PASS') continue;
    // The trial's fault without the audit: the label must agree with it, not define it.
    const { fault } = await explain(r);
    const want = fault === null ? null : AUDIT_LABEL[fault];
    const label = auditLabelOf(l);
    if (label === 'environment') environment++;
    if (label === 'grader') grader++;
    if (want === null) {
      v.push(`${l.trial}: ${outcome} carries the label ${label ?? 'none'}, and an INFRA trial gets none (it is rerun)`);
      continue;
    }
    if (label === null) v.push(`${l.trial}: taxonomy ${l.taxonomy} is not in the label set (${TAXONOMY.join(', ')})`);
    else if (!isLabel(label)) v.push(`${l.trial}: label ${label} is not one of ${AUDIT_LABELS.join(', ')}`);
    else if (label !== want.label) v.push(`${l.trial}: labelled ${label}, and its fault ${fault} has the label ${want.label}`);
    else if (l.label_subtype !== undefined && (l.label_subtype ?? null) !== want.subtype) v.push(`${l.trial}: label subtype ${l.label_subtype ?? 'none'}, and its fault ${fault} has the subtype ${want.subtype ?? 'none'}`);
    else if (label === 'model' && want.subtype === null && !(TAXONOMY as readonly (string | null)[]).includes(l.taxonomy)) v.push(`${l.trial}: taxonomy ${l.taxonomy} is not in the label set (${TAXONOMY.join(', ')})`);
    if (!['yes', 'no', 'unclear'].includes(l.model_fault as string)) v.push(`${l.trial}: model_fault must be yes, no or unclear`);
    else if (FAULT[outcome as Outcome] === 'model') {
      if (label === 'model' && l.model_fault === 'no') v.push(`${l.trial}: labelled ${l.taxonomy ?? label}, a model failure, with model_fault no`);
      if (label !== 'model' && isLabel(label) && l.model_fault === 'yes') v.push(`${l.trial}: labelled ${label}, not the model's fault, with model_fault yes`);
    }
    const n = steps.length;
    if (!Number.isSafeInteger(l.decisive_step) || (l.decisive_step as number) < 1 || (l.decisive_step as number) > n) {
      v.push(`${l.trial}: decisive step ${l.decisive_step} is not a step of the trajectory (1-${n})`);
    }
    if (l.evidence_ids.length === 0) v.push(`${l.trial}: no evidence ids`);
  }
  for (const r of failures) {
    const name = trialName(r);
    if (!byTrial.has(name)) v.push(`${name}: ${currentGrade(r).outcome}, no audit label`);
    for (const c of (await explain(r, byTrial.get(name))).criteria) {
      if ((c.id === 'M1' || c.id === 'M4') && (c.met === false || c.met === 'pending')) v.push(`${name}: ${formatCriterion(c).replace(': ', ' ')}: ${c.evidence}`);
    }
  }
  for (const r of [...records.values(), ...requeued]) {
    const g = currentGrade(r);
    if (FAULT[g.outcome as Outcome] === 'infra' && (g.valid || (!g.regraded && r.valid === true))) v.push(`${trialName(r)}: ${g.outcome} is in the valid set; an INFRA or CANCELLED trial is excluded from it`);
  }
  const internal = [...records.values(), ...requeued].filter((r) => (r.tool_errors?.INTERNAL ?? 0) > 0);
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

  // Each label's criteria, as explainTrial gives them, written back when they changed.
  if (lines !== null) {
    const out: string[] = [];
    for (const { raw, label } of lines) {
      const r = label === null ? undefined : records.get(label.trial);
      out.push(label === null || r === undefined ? raw : JSON.stringify({ ...label, criteria: (await explain(r, label)).criteria }));
    }
    const text = `${out.join('\n')}\n`;
    const file = join(dir, 'audit.jsonl');
    if (readFileSync(file, 'utf8') !== text) writeFileSync(file, text);
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
