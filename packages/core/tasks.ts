// Tasks (plan phase P7): each tasks/<id>/ directory with a task.toml is a task, found by glob,
// with no registry file. An adapter lists the directories and their files (fs in
// cli/adapters/tasks-node.ts, import.meta.glob in apps/web/src/adapters/tasks-browser.ts); the
// parsing and the selection rules live here so both runtimes agree. Directories whose name
// starts with '_' (tasks/_toy) are plumbing, not tasks: `all` skips them outside test mode,
// and `get` resolves them by explicit id.
//
// task.toml:
//   [task]
//   id = "<directory name>"
//   title = "..."
//   max_turns = 80                  # optional, default DEFAULT_MAX_TURNS
//   tools = ["get_context", ...]    # optional: the tools the model sees, default all
//   [[policy]]                      # optional, any number: text from policy/<file>
//   id = "RBC-X-01"; title = "..."; version = "1"; effective = "2026-01-01"; source = "..."; file = "x.md"
//   [[catalog]]                     # optional, any number: an orderable (read/context.ts)
//   kind = "lab"; code = "..."; system = "..."; display = "..."
//   [judge]                         # optional
//   effort = "medium"               # the judge's effort: low | medium | high, default medium;
//                                   # calibrated per task by the pilot
// instruction.md is the user turn the trial starts with.
//
// A task's versions (taskVersions) split what the agent works in from what grades it:
//   env_version          sha256(the env files + the world's state hash + TOOLS_VERSION): every
//                        file that shapes what the agent sees or the state it starts from
//                        (ENV_FILES: task.toml, instruction.md, policy/**, overlay.ts), the world,
//                        and the tool code (packages/env/tools/registry.ts TOOLS_VERSION);
//   grader_task_version  sha256(every other file of the task + GRADER_VERSION): tests/**, expected.ts,
//                        policy.ts, solution/**, *.test.ts, which the agent never sees, and the
//                        grader code (packages/grader/grade.ts GRADER_VERSION);
//   task_version         sha256 of the two: any change to the task is a new task_version.
// replay compares env_version only (the trajectory must reach the record's state); regrade
// records the grader_task_version it graded at; a batch resumes by env_version, so a grader fix
// regrades a run instead of discarding it; cost projections and the freeze read task_version.
import { parse } from 'smol-toml';
import { CATALOG_KINDS, type CatalogEntry, type Policy } from '../env/tools/read/context.ts';
import { TOOLS_VERSION } from '../env/tools/registry.ts';
import { TOOLS } from '../env/tools/write/index.ts';
import { GRADER_VERSION } from '../grader/grade.ts';

export const DEFAULT_MAX_TURNS = 80;
export const JUDGE_EFFORTS = ['low', 'medium', 'high'] as const;
export type JudgeEffort = (typeof JUDGE_EFFORTS)[number];
export const DEFAULT_JUDGE_EFFORT: JudgeEffort = 'medium';

// One task directory as an adapter read it: its name and every file in it, by path relative
// to the directory with '/' separators.
export interface TaskFiles {
  id: string;
  files: Readonly<Record<string, string>>;
}

export interface Task {
  id: string;
  title: string;
  instruction: string;
  maxTurns: number;
  // The tool names the model sees, in registry order; null for all of them.
  tools: string[] | null;
  policies: Policy[];
  catalog: CatalogEntry[];
  // The effort the judge answers this task's judge and hybrid items at ([judge] effort).
  judgeEffort: JudgeEffort;
  // sha256 over the task's files, path and content, in path order.
  filesHash: string;
  // The same over the env files (isEnvFile) and over the rest, the grader-side files.
  envFilesHash: string;
  graderFilesHash: string;
}

// The files that shape what the agent sees or the state it starts from; every other file of a
// task is grader-side.
export const isEnvFile = (path: string): boolean => path === 'task.toml' || path === 'instruction.md' || path === 'overlay.ts' || path.startsWith('policy/');

export interface TaskVersions {
  env_version: string;
  grader_task_version: string;
  task_version: string;
}

export interface TaskSource {
  // Every task, by id; '_' directories only in test mode.
  all(): Promise<Task[]>;
  // One task by explicit id, '_' directories included.
  get(id: string): Promise<Task>;
}

const TOOL_NAMES = TOOLS.map((t) => t.name);

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

const byPath = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function field(where: string, table: Record<string, unknown>, key: string, kind: 'string' | 'turns' | 'names', required: boolean): unknown {
  const v = table[key];
  if (v === undefined) {
    if (required) throw new Error(`${where}: ${key} is required`);
    return undefined;
  }
  const ok = kind === 'string' ? typeof v === 'string' && v !== '' : kind === 'turns' ? Number.isSafeInteger(v) && (v as number) >= 1 : Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (!ok) throw new Error(`${where}: ${key} must be ${kind === 'string' ? 'a non-empty string' : kind === 'turns' ? 'a whole number >= 1' : 'a list of strings'}, got ${JSON.stringify(v)}`);
  return v;
}

// Parses and checks one task directory. Throws naming the directory and the field.
export async function parseTask({ id, files }: TaskFiles): Promise<Task> {
  const where = `tasks/${id}`;
  const raw = files['task.toml'];
  if (raw === undefined) throw new Error(`${where}: no task.toml`);
  const instruction = files['instruction.md'];
  if (instruction === undefined || instruction.trim() === '') throw new Error(`${where}: no instruction.md, or it is empty`);
  let doc: Record<string, unknown>;
  try {
    doc = parse(raw) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`${where}/task.toml: ${(e as Error).message}`, { cause: e });
  }
  const task = doc.task;
  if (!isRecord(task)) throw new Error(`${where}/task.toml: no [task] table`);
  const t = `${where}/task.toml [task]`;
  const declared = field(t, task, 'id', 'string', true);
  if (declared !== id) throw new Error(`${t}: id ${JSON.stringify(declared)} does not match its directory ${id}`);
  const tools = field(t, task, 'tools', 'names', false) as string[] | undefined;
  for (const name of tools ?? []) if (!TOOL_NAMES.includes(name)) throw new Error(`${t}: unknown tool ${name}; tools: ${TOOL_NAMES.join(', ')}`);
  if (tools !== undefined && !tools.includes('finish')) throw new Error(`${t}: tools must include finish`);

  const tables = (key: string) => {
    const v = doc[key] ?? [];
    if (!Array.isArray(v) || !v.every(isRecord)) throw new Error(`${where}/task.toml: [[${key}]] must be tables`);
    return v as Array<Record<string, unknown>>;
  };
  const policies = tables('policy').map((p, i): Policy => {
    const w = `${where}/task.toml [[policy]] ${i + 1}`;
    const s = (k: string) => field(w, p, k, 'string', true) as string;
    const file = `policy/${s('file')}`;
    const text = files[file];
    if (text === undefined) throw new Error(`${w}: no file ${file}`);
    return { id: s('id'), title: s('title'), version: s('version'), effective: s('effective'), source: s('source'), text };
  });
  const catalog = tables('catalog').map((c, i): CatalogEntry => {
    const w = `${where}/task.toml [[catalog]] ${i + 1}`;
    const s = (k: string) => field(w, c, k, 'string', true) as string;
    const kind = s('kind');
    if (!(CATALOG_KINDS as readonly string[]).includes(kind)) throw new Error(`${w}: kind must be one of ${CATALOG_KINDS.join(', ')}`);
    const strengths = field(w, c, 'strengths', 'names', false) as string[] | undefined;
    return { kind: kind as CatalogEntry['kind'], code: s('code'), system: s('system'), display: s('display'), ...(strengths ? { strengths } : {}) };
  });

  const judge = doc.judge ?? {};
  if (!isRecord(judge)) throw new Error(`${where}/task.toml: [judge] must be a table`);
  const effort = field(`${where}/task.toml [judge]`, judge, 'effort', 'string', false) ?? DEFAULT_JUDGE_EFFORT;
  if (!(JUDGE_EFFORTS as readonly unknown[]).includes(effort)) throw new Error(`${where}/task.toml [judge]: effort must be one of ${JUDGE_EFFORTS.join(', ')}`);

  const paths = Object.keys(files).sort(byPath);
  const hashOf = (ps: string[]) => sha256Hex(JSON.stringify(ps.map((p) => [p, files[p]])));
  const filesHash = await hashOf(paths);
  const envFilesHash = await hashOf(paths.filter(isEnvFile));
  const graderFilesHash = await hashOf(paths.filter((p) => !isEnvFile(p)));
  return {
    id,
    title: field(t, task, 'title', 'string', true) as string,
    instruction,
    maxTurns: (field(t, task, 'max_turns', 'turns', false) as number | undefined) ?? DEFAULT_MAX_TURNS,
    tools: tools === undefined ? null : TOOL_NAMES.filter((n) => tools.includes(n)),
    policies,
    catalog,
    judgeEffort: effort as JudgeEffort,
    filesHash,
    envFilesHash,
    graderFilesHash,
  };
}

// A task's env_version, grader_task_version and task_version (the header says what each covers).
export async function taskVersions(task: Task, worldHash: string): Promise<TaskVersions> {
  const env_version = await sha256Hex(`env\n${task.envFilesHash}\n${worldHash}\ntools ${TOOLS_VERSION}`);
  const grader_task_version = await sha256Hex(`grader\n${task.graderFilesHash}\ngrader ${GRADER_VERSION}`);
  return { env_version, grader_task_version, task_version: await sha256Hex(`${env_version}\n${grader_task_version}`) };
}

// A TaskSource over the directories `list` returns (each one holding a task.toml). It calls
// `list` once, on first use, and answers every later get and all from that read: a run of many
// trials (the matrix, a batch) resolves its task once per trial, and a file changed under
// tasks/<id>/ while it runs must not give two of its trials two task versions. A failed read
// is not kept; the next call reads again.
export function taskSource(list: () => Promise<TaskFiles[]>, opts: { testMode: boolean }): TaskSource {
  let read: Promise<TaskFiles[]> | undefined;
  const load = () =>
    (read ??= list()
      .then((dirs) => dirs.filter((d) => d.files['task.toml'] !== undefined).sort((a, b) => byPath(a.id, b.id)))
      .catch((e: unknown) => {
        read = undefined;
        throw e;
      }));
  return {
    async all() {
      const dirs = (await load()).filter((d) => opts.testMode || !d.id.startsWith('_'));
      return Promise.all(dirs.map(parseTask));
    },
    async get(id) {
      const dirs = await load();
      const dir = dirs.find((d) => d.id === id);
      if (dir === undefined) throw new Error(`no task '${id}'; tasks: ${dirs.map((d) => d.id).join(', ') || '(none)'}`);
      return parseTask(dir);
    },
  };
}
