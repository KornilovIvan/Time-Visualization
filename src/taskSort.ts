import type { ParsedTask } from "./parser";
import type { TimeVisualizationSettings } from "./settings";

/** Settings fields used for group ordering (no plugin / ViewHost). */
export type TaskSortSettings = Pick<
  TimeVisualizationSettings,
  "priorities" | "dayOrder" | "timeOverPriority"
>;

export function groupTasksByFile(tasks: ParsedTask[]): Map<string, ParsedTask[]> {
  const groups = new Map<string, ParsedTask[]>();
  for (const t of tasks) {
    let arr = groups.get(t.filePath);
    if (!arr) {
      arr = [];
      groups.set(t.filePath, arr);
    }
    arr.push(t);
  }
  return groups;
}

/** One display group: tasks from a note, optionally split into timed / untimed. */
export interface TaskGroup {
  path: string;
  tasks: ParsedTask[];
  /**
   * true = timed-only bucket, false = untimed-only,
   * null = merged adjacent buckets from the same note (no data-timed marker).
   */
  timed: boolean | null;
}

/** Split each note into timed and untimed subgroups (a note may yield 0–2 groups). */
export function splitTimedGroups(tasks: ParsedTask[]): TaskGroup[] {
  const out: TaskGroup[] = [];
  for (const [path, list] of groupTasksByFile(tasks)) {
    const timed = list.filter((t) => !!t.time);
    const untimed = list.filter((t) => !t.time);
    if (timed.length > 0) out.push({ path, tasks: timed, timed: true });
    if (untimed.length > 0) out.push({ path, tasks: untimed, timed: false });
  }
  return out;
}

/** Merge consecutive subgroups of the same note into one visual group.
    Keeps them split when another note sits between (e.g. after time-first sort). */
export function mergeAdjacentSameNoteGroups(groups: TaskGroup[]): TaskGroup[] {
  if (groups.length === 0) return groups;
  const out: TaskGroup[] = [];
  for (const g of groups) {
    const prev = out[out.length - 1];
    if (prev && prev.path === g.path) {
      prev.tasks = prev.tasks.concat(g.tasks);
      prev.timed = null;
    } else {
      out.push({ path: g.path, tasks: g.tasks.slice(), timed: g.timed });
    }
  }
  return out;
}

/** Whether a priority entry (note or folder) covers this note path.
    Folders match themselves and any path under them (same rule as Sources). */
export function priorityEntryMatches(entry: string, notePath: string): boolean {
  if (entry.endsWith(".md")) return notePath === entry;
  return notePath === entry || notePath.startsWith(entry + "/");
}

/** Best (lowest) global priority index for a note, or undefined if none match.
    A folder entry applies to every note inside it. */
export function globalPriorityIndex(priorities: string[], notePath: string): number | undefined {
  let best: number | undefined;
  for (let i = 0; i < priorities.length; i++) {
    if (!priorityEntryMatches(priorities[i], notePath)) continue;
    if (best === undefined || i < best) best = i;
  }
  return best;
}

/** True if any global priority entry covers this note (exact note or parent folder). */
export function hasGlobalPriority(priorities: string[], notePath: string): boolean {
  return globalPriorityIndex(priorities, notePath) !== undefined;
}

/** Groups sorted by priority: per-day order first, then the global priority
    list, then unprioritized groups in their by-time order. Timed and untimed
    tasks from the same note are separate buckets for sorting; adjacent buckets
    of the same note are merged for display. When "time over priority" is on,
    every timed subgroup sorts above every untimed one. */
export function sortedGroups(
  settings: TaskSortSettings,
  tasks: ParsedTask[],
  dateKey: string
): TaskGroup[] {
  const groups = splitTimedGroups(tasks);
  const day = settings.dayOrder[dateKey] ?? [];
  const dayPos = new Map<string, number>();
  day.forEach((p, i) => dayPos.set(p, i));
  const priorities = settings.priorities;
  const timeFirst = settings.timeOverPriority;
  groups.sort((a, b) => {
    const aTimed = a.timed === true;
    const bTimed = b.timed === true;
    if (timeFirst && aTimed !== bTimed) return aTimed ? -1 : 1;
    const ad = dayPos.get(a.path);
    const bd = dayPos.get(b.path);
    if (ad !== undefined && bd !== undefined && ad !== bd) return ad - bd;
    if (ad !== undefined && bd === undefined) return -1;
    if (bd !== undefined && ad === undefined) return 1;
    const ag = globalPriorityIndex(priorities, a.path);
    const bg = globalPriorityIndex(priorities, b.path);
    if (ag !== undefined && bg !== undefined && ag !== bg) return ag - bg;
    if (ag !== undefined && bg === undefined) return -1;
    if (bg !== undefined && ag === undefined) return 1;
    // Same note: timed subgroup above untimed
    if (a.path === b.path && a.timed !== b.timed) return aTimed ? -1 : 1;
    return 0; // stable sort keeps the existing by-time order
  });
  return mergeAdjacentSameNoteGroups(groups);
}

/** Unique note paths in display order (for the day priority menu). */
export function sortedGroupPaths(
  settings: TaskSortSettings,
  tasks: ParsedTask[],
  dateKey: string
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const g of sortedGroups(settings, tasks, dateKey)) {
    if (seen.has(g.path)) continue;
    seen.add(g.path);
    paths.push(g.path);
  }
  return paths;
}
