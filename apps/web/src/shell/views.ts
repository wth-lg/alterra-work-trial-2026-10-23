// The rail's views. P14-P16 fill them; until then each shows what it will hold.
import { Database, FileText, History, LayoutDashboard, ListChecks, type LucideIcon } from 'lucide-react';

export interface View {
  id: string;
  label: string;
  icon: LucideIcon;
  empty: string;
}

export const VIEWS: readonly View[] = [
  { id: 'overview', label: 'Overview', icon: LayoutDashboard, empty: 'One row per task for the committed final run: pass k of 10 with its 95% interval, ten trial swatches, mean score, cost and duration.' },
  { id: 'tasks', label: 'Tasks', icon: ListChecks, empty: 'The six tasks, each with its prompt, policy, required end state, rubric, reference solution and grader validation, and Run trial.' },
  { id: 'runs', label: 'Runs', icon: History, empty: 'The official, pilot and exploit runs, and the runs you start in this session, with status, cost and pass rate.' },
  { id: 'findings', label: 'Findings', icon: FileText, empty: 'The write-up: pass rates with intervals, the failure taxonomy, and links from each claim to example trajectories.' },
  { id: 'environment', label: 'Environment', icon: Database, empty: 'The pinned clock, world hash, resource counts, tool catalogue, patient browser and policy library.' },
];

export const DEFAULT_VIEW = VIEWS[0]!;

export const viewFromUrl = (href: string): View => VIEWS.find((v) => v.id === new URL(href).searchParams.get('view')) ?? DEFAULT_VIEW;

export function viewHref(href: string, id: string): string {
  const url = new URL(href);
  url.searchParams.set('view', id);
  return `${url.pathname}${url.search}${url.hash}`;
}
