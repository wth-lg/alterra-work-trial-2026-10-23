// Task overlays (design section 2, "One shared world"): deterministic builders that patch
// chosen base patients and add each task's hand-written resources. fixtures:build applies
// every tasks/<id>/overlay.ts to the base cohort plus the setting (packages/env/world.ts).
//
// Isolation, enforced by applyOverlays so no task can break another:
//   - each task owns a fixed set of base patients (its slots) and may replace or remove only
//     those Patients and the base resources that reference them and no other patient;
//   - every resource a task adds has an id with the task's reserved tag as its second
//     segment (T1 adds obs-t1-scr-1020, never obs-scr-1020), so two tasks never collide and
//     no added id can collide with a base id (obs-00012) or a setting id (pr-okafor);
//   - every Patient an added or replaced resource references is one of the task's slots or
//     a Patient the task adds itself;
//   - each overlay reads base plus setting only, never another overlay's output, so the
//     world does not depend on the order overlays run in.
import type { Resource } from '@medplum/fhirtypes';
import type { LintSource, LintSpec } from './lint/index.ts';
import { Store } from './store.ts';

// Slots are picked so a task's patients can keep their Synthea charts with only a name and
// birth date patched: T1 an elderly man, T2 its inbox patients (one a teenager), T3 a
// 12-patient screening panel aged 46-75, T4 and T5 older men, T6 the message senders.
export const TASKS = {
  T1: { slug: 'renal-dose-review', slots: ['pt-0002', 'pt-0003'] },
  T2: { slug: 'results-inbox', slots: ['pt-0006', 'pt-0007', 'pt-0008', 'pt-0010', 'pt-0013', 'pt-0016', 'pt-0033', 'pt-0053'] },
  T3: {
    slug: 'crc-care-gap',
    slots: ['pt-0009', 'pt-0011', 'pt-0014', 'pt-0017', 'pt-0018', 'pt-0019', 'pt-0020', 'pt-0021', 'pt-0022', 'pt-0023', 'pt-0024', 'pt-0025'],
  },
  T4: { slug: 'discharge-medrec', slots: ['pt-0004', 'pt-0005'] },
  T5: { slug: 'contrast-ct-prep', slots: ['pt-0012', 'pt-0015'] },
  T6: { slug: 'message-queue', slots: ['pt-0026', 'pt-0027', 'pt-0028', 'pt-0029', 'pt-0030', 'pt-0031'] },
} as const satisfies Record<string, { slug: string; slots: readonly string[] }>;

export type TaskId = keyof typeof TASKS;

// The reserved id tag: an added resource's id is <type prefix>-<tag>-<rest>.
export const idTag = (task: TaskId): string => `t${task.slice(1)}`;

export type WorldReader = Pick<Store, 'get' | 'search' | 'resources' | 'size'>;

export interface OverlayEdits {
  // Added or replaced resources.
  put?: readonly Resource[];
  remove?: ReadonlyArray<{ resourceType: string; id: string }>;
  // The task's margins, windows, answers and prompts for the fixture lint.
  lint?: LintSpec;
}

export interface Overlay {
  task: TaskId;
  build(world: WorldReader): OverlayEdits;
}

const key = (r: { resourceType: string; id?: string }) => `${r.resourceType}/${r.id}`;

// Every Patient id a resource references, at any depth.
export function patientRefs(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) for (const v of value) patientRefs(v, out);
  else if (value !== null && typeof value === 'object') {
    const ref = (value as { reference?: unknown }).reference;
    if (typeof ref === 'string' && ref.startsWith('Patient/')) out.add(ref.slice(8));
    for (const v of Object.values(value)) patientRefs(v, out);
  }
  return out;
}

export interface World {
  resources: Resource[];
  lint: LintSource[];
}

export function applyOverlays(base: readonly Resource[], setting: readonly Resource[], settingLint: LintSpec, overlays: readonly Overlay[]): World {
  const start = new Map<string, Resource>();
  for (const r of [...base, ...setting]) {
    if (start.has(key(r))) throw new Error(`overlay: ${key(r)} is in the base cohort and the setting`);
    start.set(key(r), r);
  }
  const owner = new Map<string, TaskId>();
  for (const [task, { slots }] of Object.entries(TASKS) as Array<[TaskId, { slots: readonly string[] }]>) {
    for (const id of slots) {
      if (owner.has(id)) throw new Error(`overlay: ${id} is a slot of ${owner.get(id)} and ${task}`);
      if (!start.has(`Patient/${id}`)) throw new Error(`overlay: ${task} slot ${id} is not a base patient`);
      owner.set(id, task);
    }
  }

  // Read-only by construction, not by type: an overlay gets these four functions over a store
  // of frozen copies and never the Store itself, so no cast reaches put() and no overlay can
  // change what the next one reads.
  const snapshot = new Store(start.values());
  const reader: WorldReader = Object.freeze({
    get: snapshot.get.bind(snapshot),
    search: snapshot.search.bind(snapshot),
    resources: snapshot.resources.bind(snapshot),
    size: snapshot.size,
  });
  const world = new Map(start);
  const lint: LintSource[] = [{ source: 'world', spec: settingLint }];
  const seen = new Set<TaskId>();
  for (const overlay of [...overlays].sort((a, b) => (a.task < b.task ? -1 : a.task > b.task ? 1 : 0))) {
    const { task } = overlay;
    if (!Object.hasOwn(TASKS, task)) throw new Error(`overlay: unknown task ${task}`);
    if (seen.has(task)) throw new Error(`overlay: two overlays for ${task}`);
    seen.add(task);
    const at = (r: { resourceType: string; id?: string }) => `overlay ${task}: ${key(r)}`;
    const ownsPatients = (r: Resource) => [...patientRefs(r)].every((p) => owner.get(p) === task);
    // A base resource the task may change: one of its slot Patients, or a resource that
    // references at least one Patient, all of them its slots.
    const owns = (r: Resource) => (r.resourceType === 'Patient' ? owner.get(r.id!) === task : patientRefs(r).size > 0 && ownsPatients(r));
    const tagged = new RegExp(`^[a-z]+-${idTag(task)}-[a-z0-9-]+$`);

    const edits = overlay.build(reader);
    // A Patient the task adds is its own, like a slot.
    for (const r of edits.put ?? []) if (r.resourceType === 'Patient' && !start.has(key(r)) && tagged.test(r.id ?? '')) owner.set(r.id!, task);
    for (const r of edits.remove ?? []) {
      const existing = start.get(key(r));
      if (!existing) throw new Error(`${at(r)} removes a resource that is not in base or setting`);
      if (r.resourceType === 'Patient' || !owns(existing)) throw new Error(`${at(r)} may not be removed by ${task}`);
      world.delete(key(r));
    }
    for (const r of edits.put ?? []) {
      const existing = start.get(key(r));
      if (existing) {
        if (!owns(existing)) throw new Error(`${at(r)} is not ${task}'s to replace`);
      } else if (!tagged.test(r.id ?? '')) {
        throw new Error(`${at(r)}: an added id must look like <type>-${idTag(task)}-<rest>`);
      }
      if (!ownsPatients(r)) throw new Error(`${at(r)} references a patient that is not a ${task} slot`);
      world.set(key(r), r);
    }
    if (edits.lint) lint.push({ source: task, spec: edits.lint });
  }
  return { resources: [...world.values()], lint };
}
