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

/** Minimal identity of a display group for ordering (matches data-timed on DOM). */
export interface GroupSortKey {
  path: string;
  /** true = timed bucket, false = untimed, null = merged (no data-timed). */
  timed: boolean | null;
}

/** Same ordering rules as sortedGroups — used for DOM reinsert on un-toggle. */
export function compareGroups(
  a: GroupSortKey,
  b: GroupSortKey,
  settings: TaskSortSettings,
  dateKey: string
): number {
  const aTimed = a.timed === true;
  const bTimed = b.timed === true;
  if (settings.timeOverPriority && aTimed !== bTimed) return aTimed ? -1 : 1;
  const day = settings.dayOrder[dateKey] ?? [];
  const ad = day.indexOf(a.path);
  const bd = day.indexOf(b.path);
  if (ad !== -1 && bd !== -1 && ad !== bd) return ad - bd;
  if (ad !== -1 && bd === -1) return -1;
  if (bd !== -1 && ad === -1) return 1;
  const ag = globalPriorityIndex(settings.priorities, a.path);
  const bg = globalPriorityIndex(settings.priorities, b.path);
  if (ag !== undefined && bg !== undefined && ag !== bg) return ag - bg;
  if (ag !== undefined && bg === undefined) return -1;
  if (bg !== undefined && ag === undefined) return 1;
  // Same note: timed subgroup above untimed (null counts as neither exclusive)
  if (a.path === b.path && a.timed !== b.timed) {
    if (a.timed === true) return -1;
    if (b.timed === true) return 1;
    if (a.timed === false) return 1;
    if (b.timed === false) return -1;
  }
  return 0;
}

function groupTimedFlag(g: TaskGroup): boolean | null {
  return g.timed;
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
  groups.sort((a, b) =>
    compareGroups(
      { path: a.path, timed: groupTimedFlag(a) },
      { path: b.path, timed: groupTimedFlag(b) },
      settings,
      dateKey
    )
  );
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

/** Read timed flag from a rendered .tv-day-group element. */
export function groupTimedFromEl(el: HTMLElement): boolean | null {
  if (el.dataset.timed === "1") return true;
  if (el.dataset.timed === "0") return false;
  return null;
}

/** First sibling group that should come after `key`, or null to append. */
export function findGroupInsertBefore(
  siblings: HTMLElement[],
  key: GroupSortKey,
  settings: TaskSortSettings,
  dateKey: string,
  skip?: HTMLElement
): HTMLElement | null {
  for (const g of siblings) {
    if (g === skip) continue;
    const other: GroupSortKey = {
      path: g.dataset.file || "",
      timed: groupTimedFromEl(g),
    };
    if (compareGroups(key, other, settings, dateKey) < 0) return g;
  }
  return null;
}
