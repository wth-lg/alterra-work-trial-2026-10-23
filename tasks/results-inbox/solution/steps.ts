// The tool calls T2's scripts are made of: the oracle (solve.ts) and the matrix's alternatives,
// mutants and agents (tests/). A write's id is its tool's prefix and the trial's write sequence
// number (packages/env/tools/write/commit.ts: sr-t0003 is the third committed write), so a
// script names what it created through a Writer, which numbers the writes in the order the
// script makes them. Calls run in order, so a script must take its writes from one Writer in
// that same order.
import type { ScriptCall, ScriptTurn } from '../../../packages/grader/matrix/types.ts';

export const PT = {
  marsh: 'pt-0013',
  otherMarsh: 'pt-0033',
  parisian: 'pt-0007',
  patel: 'pt-0006',
  brennan: 'pt-0008',
  holloway: 'pt-0010',
  ruiz: 'pt-0053',
  ondricka: 'pt-0016',
} as const;

export const ITEM = (n: number) => `Task/task-t2-inbox-${n}`;
export const SRC = {
  ct: 'DiagnosticReport/dr-t2-ct-0604',
  hp: 'DocumentReference/doc-t2-hp-lm58',
  us: 'DiagnosticReport/dr-t2-us-1020',
  fit: 'Observation/obs-t2-fit-1019',
  giReferral: 'ServiceRequest/sr-t2-gi-1020',
  bmpC: 'DiagnosticReport/dr-t2-bmp-c-1022',
  kC: 'Observation/obs-t2-c-k',
  bmpD: 'DiagnosticReport/dr-t2-bmp-d-1022',
  kD: 'Observation/obs-t2-d-k',
  xr: 'DiagnosticReport/dr-t2-xr-1022',
  tsh: 'Observation/obs-t2-tsh-1020',
  lipid: 'DiagnosticReport/dr-t2-lipid-1020',
} as const;

const split = (ref: string) => ref.split('/') as [string, string];

// Reads.
export const inbox: ScriptCall = { name: 'list_inbox', input: { queue: 'results', status: 'requested' } };
export const read = (ref: string): ScriptCall => {
  const [resource_type, id] = split(ref);
  return { name: 'fhir_read', input: { resource_type, id } };
};
export const policy = (policy_id: string): ScriptCall => ({ name: 'read_policy', input: { policy_id } });
export const policies = ['RBC-INBOX-01', 'RBC-RAD-05', 'RBC-GI-01', 'RBC-LAB-03'].map(policy);
export const searchNotes = (query: string, patient?: string): ScriptCall => ({ name: 'search_notes', input: { query, ...(patient ? { patient } : {}) } });
export const activeServiceRequests = (patient: string): ScriptCall => ({ name: 'fhir_search', input: { resource_type: 'ServiceRequest', patient, status: 'active' } });
export const finish = (summary: string): ScriptCall => ({ name: 'finish', input: { summary } });

// Every item's source, read the way the reference solution reads them (design step 2).
export const READ_ALL: ScriptTurn[] = [
  { calls: [inbox] },
  { calls: [read(SRC.ct), read(SRC.us), read(SRC.fit), read(SRC.bmpC), read(SRC.kC), read(SRC.bmpD), read(SRC.kD), read(SRC.xr), read(SRC.tsh), read(SRC.lipid)] },
  { calls: [searchNotes('pack', PT.marsh), read(SRC.hp)] },
  { calls: [activeServiceRequests(PT.patel)] },
  { calls: policies },
];

type Priority = 'routine' | 'urgent' | 'asap' | 'stat';
export interface Write {
  call: ScriptCall;
  // The resource the write created, as <Type>/<id>; '' for an update.
  ref: string;
}

// Numbers a script's writes in the order it makes them.
export function writer() {
  let seq = 0;
  const next = (type: string, prefix: string) => `${type}/${prefix}-t${String(++seq).padStart(4, '0')}`;
  return {
    order: (patient: string, code: string, priority: Priority, start: string, reason: string, more: { end?: string; supporting?: string[] } = {}): Write => ({
      ref: next('ServiceRequest', 'sr'),
      call: {
        name: 'order_service',
        input: { patient, code, priority, occurrence_start: start, ...(more.end ? { occurrence_end: more.end } : {}), reason, ...(more.supporting ? { supporting: more.supporting } : {}) },
      },
    }),
    task: (patient: string, owner: string, due: string, priority: Priority, description: string, focus?: string): Write => ({
      ref: next('Task', 'task'),
      call: { name: 'create_task', input: { patient, owner, due, priority, description, ...(focus ? { focus } : {}) } },
    }),
    message: (recipient: string, priority: Priority, subject: string, body: string, about: string[]): Write => ({
      ref: next('Communication', 'comm'),
      call: { name: 'send_message', input: { recipient, priority, subject, body, about } },
    }),
    note: (patient: string, title: string, text: string, cites: string[], cites_policies: string[]): Write => ({
      ref: next('DocumentReference', 'doc'),
      call: { name: 'write_note', input: { patient, type: 'progress_note', title, text, cites, cites_policies } },
    }),
    // Any other committed write that creates nothing a script links (a medication change).
    other: (call: ScriptCall): Write => {
      seq++;
      return { ref: '', call };
    },
    complete: (item: number, linked: string[], comment?: string): Write => {
      seq++;
      return { ref: '', call: { name: 'update_inbox_item', input: { task_id: ITEM(item), action: 'complete', ...(linked.length ? { linked } : {}), ...(comment ? { comment } : {}) } } };
    },
  };
}
export const calls = (...ws: Write[]): ScriptCall[] => ws.map((w) => w.call);

// The item 2 closure comment, and the normal results'.
export const CYST_COMMENT = 'Simple right renal cyst. The report recommends no follow-up imaging, so no follow-up is needed under RBC-RAD-05 and RBC-INBOX-01 §3.';
export const NORMAL_COMMENT = 'Normal result, reviewed and acknowledged.';

export const NOTES = {
  nodule:
    'Incidental 5 mm solid right lower lobe nodule on the CT abdomen and pelvis of 2026-06-04 (St. Brigid ED). ' +
    'Smoking history from the H&P of 2026-02-16: 35 pack-years, quit 2019, so high risk under RBC-RAD-05 §2. ' +
    'CT chest without contrast 12 months after the index study (§1), window 2027-05-04 to 2027-07-04; ordered with a tracking task, and the patient is informed.',
  fit: 'Positive FIT (collected 2026-10-16). Dr. Lin placed a GI referral for colonoscopy on 2026-10-20, which is active; linked to the result, no new referral (RBC-GI-01 §2).',
  hemolyzed:
    'Potassium 6.4 mmol/L on 2026-10-22, specimen hemolyzed and possibly falsely elevated. Under RBC-LAB-03 §2: repeat BMP ordered urgent for Monday 2026-10-26, patient asked to come in; on-call not notified.',
  critical:
    'Potassium 6.2 mmol/L on 2026-10-22, not hemolyzed, CKD stage 3b on lisinopril. Under RBC-LAB-03 §1: on-call clinician notified at stat priority and a stat BMP ordered today.',
  bone:
    'Right knee X-ray of 2026-10-22: aggressive lytic lesion of the distal femur, concerning for a primary bone tumour; the radiologist recommends urgent orthopaedic oncology referral and MRI with no interval. ' +
    'Under RBC-RAD-05 §3 both are ordered urgent within 14 days (by 2026-11-05), with a tracking task; the patient and his mother are informed.',
};

export const DONE = 'Results inbox cleared: all 8 items completed with their follow-up orders, tasks, messages and notes linked.';
