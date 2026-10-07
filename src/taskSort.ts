import { parseClockSpan } from "./clock";
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

/**
 * Done section: keep completion order, but only merge consecutive tasks from
 * the same note. Completing note A, then B, then A again yields three groups
 * (A | B | A), not one merged A group.
 * `tasks` must already be sorted by completion time (see TaskIndex).
 */
export function groupDoneByCompletionRuns(tasks: ParsedTask[]): TaskGroup[] {
  const out: TaskGroup[] = [];
  for (const t of tasks) {
    const prev = out[out.length - 1];
    if (prev && prev.path === t.filePath) {
      prev.tasks.push(t);
    } else {
      out.push({ path: t.filePath, tasks: [t], timed: null });
    }
  }
  return out;
}

/** Format a [done::] ISO timestamp for the Done list (local clock time). */
export function formatDoneAt(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso.trim();
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
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
      if (prev.timed !== g.timed) prev.timed = null;
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

/**
 * Global priority entry used as the day-menu row for this note: a covering
 * folder stays a folder (one unit for all notes inside); otherwise the note.
 */
export function dayPriorityKey(priorities: string[], notePath: string): string {
  const idx = globalPriorityIndex(priorities, notePath);
  if (idx === undefined) return notePath;
  const entry = priorities[idx];
  if (!entry.endsWith(".md")) return entry;
  return notePath;
}

/**
 * Day-order rank for a note. Entries may be notes or folders (same matching
 * rules as global priority).
 *
 * Direct matches win (so a note can be pulled out of the folder band). Notes
 * not listed still inherit from a folder entry or from sibling notes under the
 * same global folder, so they do not sink below unrelated dayOrder rows.
 */
export function dayOrderIndex(
  day: string[],
  notePath: string,
  priorities: string[] = []
): number | undefined {
  let best: number | undefined;
  for (let i = 0; i < day.length; i++) {
    if (!priorityEntryMatches(day[i], notePath)) continue;
    if (best === undefined || i < best) best = i;
  }
  if (best !== undefined) return best;

  const folder = (() => {
    const idx = globalPriorityIndex(priorities, notePath);
    if (idx === undefined) return undefined;
    const entry = priorities[idx];
    return entry.endsWith(".md") ? undefined : entry;
  })();
  if (!folder) return undefined;

  for (let i = 0; i < day.length; i++) {
    const e = day[i];
    if (e === folder || (e.endsWith(".md") && priorityEntryMatches(folder, e))) {
      if (best === undefined || i < best) best = i;
    }
  }
  return best;
}

/** Minimal identity of a display group for ordering (matches data-timed on DOM). */
export interface GroupSortKey {
  path: string;
  /** true = timed bucket, false = untimed, null = merged (no data-timed). */
  timed: boolean | null;
  /** Earliest HH:MM in the group — tie-breaks equal priority (matches index order). */
  earliestTime?: string | null;
}

/** Minutes from midnight for a point or the start of a range, or null. */
export function timeStartMinutes(time: string | null | undefined): number | null {
  if (!time) return null;
  const span = parseClockSpan(time);
  return span ? span.start : null;
}

/** Order two time strings by when they start. Equal starts fall through to the text. */
export function compareTimeStrings(
  a: string | null | undefined,
  b: string | null | undefined
): number {
  const am = timeStartMinutes(a);
  const bm = timeStartMinutes(b);
  if (am !== null && bm !== null && am !== bm) return am - bm;
  if (am !== null && bm === null && b) return -1;
  if (bm !== null && am === null && a) return 1;
  if (a && b) return a.localeCompare(b);
  if (a && !b) return -1;
  if (!a && b) return 1;
  return 0;
}

/** Earliest time string among tasks, or null if none are timed. */
export function earliestTaskTime(tasks: readonly ParsedTask[]): string | null {
  let best: string | null = null;
  for (const t of tasks) {
    if (!t.time) continue;
    if (best === null || compareTimeStrings(t.time, best) < 0) best = t.time;
  }
  return best;
}

function compareTasksByStart(a: ParsedTask, b: ParsedTask): number {
  const tc = compareTimeStrings(a.time, b.time);
  if (tc !== 0) return tc;
  const pc = a.filePath.localeCompare(b.filePath);
  if (pc !== 0) return pc;
  return a.line - b.line;
}

function groupSortKey(g: TaskGroup): GroupSortKey {
  return { path: g.path, timed: g.timed, earliestTime: earliestTaskTime(g.tasks) };
}

/** Note priority only. Timed groups do not jump ahead of each other by time. */
function compareByNotePriority(
  a: GroupSortKey,
  b: GroupSortKey,
  settings: TaskSortSettings,
  dateKey: string
): number {
  const day = settings.dayOrder[dateKey] ?? [];
  const ad = dayOrderIndex(day, a.path, settings.priorities);
  const bd = dayOrderIndex(day, b.path, settings.priorities);
  if (ad !== undefined && bd !== undefined && ad !== bd) return ad - bd;
  if (ad !== undefined && bd === undefined) return -1;
  if (bd !== undefined && ad === undefined) return 1;
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
  // Equal priority: match TaskIndex open-task order (time, then path)
  const at = a.earliestTime ?? null;
  const bt = b.earliestTime ?? null;
  if (at && bt) {
    const tc = at.localeCompare(bt);
    if (tc !== 0) return tc;
  } else if (at && !bt) return -1;
  else if (!at && bt) return 1;
  return a.path.localeCompare(b.path);
}

/** Same ordering rules as sortedGroups — used for DOM reinsert on un-toggle.
    Two timed groups are ordered by start time, never by note priority. */
export function compareGroups(
  a: GroupSortKey,
  b: GroupSortKey,
  settings: TaskSortSettings,
  dateKey: string
): number {
  const aTimed = a.timed === true;
  const bTimed = b.timed === true;
  if (aTimed && bTimed && (a.earliestTime || b.earliestTime)) {
    const tc = compareTimeStrings(a.earliestTime, b.earliestTime);
    if (tc !== 0) return tc;
    return a.path.localeCompare(b.path);
  }
  if (settings.timeOverPriority && aTimed !== bTimed) return aTimed ? -1 : 1;
  return compareByNotePriority(a, b, settings, dateKey);
}

/** Timed groups stay in start-time order. Untimed notes follow priority.
    With "time over priority" the timed block is first. Otherwise it sits where
    the highest-priority timed note would, so an earlier task is not pushed
    below a later one just because its note ranks lower. */
function arrangeGroups(
  groups: TaskGroup[],
  settings: TaskSortSettings,
  dateKey: string
): TaskGroup[] {
  const timed = groups.filter((g) => g.timed === true);
  const untimed = groups.filter((g) => g.timed !== true);
  const byPriority = (a: TaskGroup, b: TaskGroup) =>
    compareByNotePriority(groupSortKey(a), groupSortKey(b), settings, dateKey);
  timed.sort((a, b) => compareGroups(groupSortKey(a), groupSortKey(b), settings, dateKey));
  untimed.sort(byPriority);
  if (timed.length === 0 || untimed.length === 0 || settings.timeOverPriority) {
    return [...timed, ...untimed];
  }
  const anchor = [...timed].sort(byPriority)[0];
  let at = untimed.findIndex((u) => byPriority(anchor, u) < 0);
  if (at < 0) at = untimed.length;
  return [...untimed.slice(0, at), ...timed, ...untimed.slice(at)];
}

/** One group per timed task, so another note can sit between two tasks of the same note. */
function expandTimedTasks(groups: TaskGroup[]): TaskGroup[] {
  const out: TaskGroup[] = [];
  for (const g of groups) {
    if (g.timed !== true || g.tasks.length <= 1) {
      out.push(g);
      continue;
    }
    for (const t of g.tasks) out.push({ path: g.path, tasks: [t], timed: true });
  }
  return out;
}

function taskIdentity(t: Pick<ParsedTask, "filePath" | "line">): string {
  return t.filePath + "\0" + t.line;
}

/** True when `task` and `groupTasks` are one same-note run: no other note starts between them. */
export function sharesTimedRun(
  others: readonly ParsedTask[],
  task: ParsedTask,
  groupTasks: readonly ParsedTask[]
): boolean {
  if (!task.time || groupTasks.length === 0) return false;
  if (groupTasks.some((t) => t.filePath !== task.filePath || !t.time)) return false;
  const byId = new Map<string, ParsedTask>();
  for (const t of [...others, ...groupTasks, task]) {
    if (t.time) byId.set(taskIdentity(t), t);
  }
  const pool = Array.from(byId.values()).sort(compareTasksByStart);
  const idx = pool.findIndex((t) => taskIdentity(t) === taskIdentity(task));
  if (idx < 0) return false;
  let lo = idx;
  while (lo > 0 && pool[lo - 1].filePath === task.filePath) lo--;
  let hi = idx;
  while (hi < pool.length - 1 && pool[hi + 1].filePath === task.filePath) hi++;
  const run = new Set(pool.slice(lo, hi + 1).map(taskIdentity));
  return groupTasks.some((t) => run.has(taskIdentity(t)));
}

/** Groups sorted for the day list. Tasks with a time are ordered by when they
    start, not by note priority. Two timed tasks from one note stay apart when
    another note starts between them. Untimed notes still follow the day order
    and the global priority list. When "time over priority" is on, every timed
    subgroup sorts above every untimed one. Adjacent buckets of the same note
    are merged for display. */
export function sortedGroups(
  settings: TaskSortSettings,
  tasks: ParsedTask[],
  dateKey: string
): TaskGroup[] {
  const groups = splitTimedGroups(tasks);
  for (const g of groups) {
    if (g.timed === true) g.tasks.sort(compareTasksByStart);
  }
  return mergeAdjacentSameNoteGroups(arrangeGroups(expandTimedTasks(groups), settings, dateKey));
}

/** Unique note paths in display order. */
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

/**
 * Day-priority menu rows: notes covered by a global folder priority collapse
 * into that folder (same unit as Settings); other notes stay as themselves.
 */
export function dayPriorityPaths(
  settings: TaskSortSettings,
  tasks: ParsedTask[],
  dateKey: string
): string[] {
  const notePaths = sortedGroupPaths(settings, tasks, dateKey);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const note of notePaths) {
    const key = dayPriorityKey(settings.priorities, note);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/** Read timed flag from a rendered .tv-day-group element. */
export function groupTimedFromEl(el: HTMLElement): boolean | null {
  if (el.dataset.timed === "1") return true;
  if (el.dataset.timed === "0") return false;
  return null;
}

/** Earliest timed task in a rendered group (via taskRefs). */
export function earliestTimeFromGroupEl(
  el: HTMLElement,
  taskRefs: Map<string, ParsedTask>
): string | null {
  const tasksRoot = el.querySelector(".tv-day-group-tasks") ?? el;
  const tasks: ParsedTask[] = [];
  for (const child of Array.from(tasksRoot.children) as HTMLElement[]) {
    const key = child.dataset.taskKey;
    if (!key) continue;
    const t = taskRefs.get(key);
    if (t) tasks.push(t);
  }
  return earliestTaskTime(tasks);
}

/**
 * Where to insert `task` among siblings in one group.
 * Returns the sibling index to insert before, or siblings.length to append.
 * Matches TaskIndex open-task order within a timed/untimed bucket.
 */
export function findTaskInsertIndex(
  siblings: ReadonlyArray<Pick<ParsedTask, "time" | "line" | "filePath">>,
  task: Pick<ParsedTask, "time" | "line" | "filePath">
): number {
  for (let i = 0; i < siblings.length; i++) {
    const other = siblings[i];
    if (task.time && other.time) {
      const tc = compareTimeStrings(task.time, other.time);
      if (tc < 0) return i;
      if (tc > 0) continue;
      if (task.line < other.line) return i;
      continue;
    }
    if (task.time && !other.time) return i;
    if (!task.time && other.time) continue;
    const pc = task.filePath.localeCompare(other.filePath);
    if (pc < 0) return i;
    if (pc > 0) continue;
    if (task.line < other.line) return i;
  }
  return siblings.length;
}

/** First sibling group that should come after `key`, or null to append. */
export function findGroupInsertBefore(
  siblings: HTMLElement[],
  key: GroupSortKey,
  settings: TaskSortSettings,
  dateKey: string,
  skip?: HTMLElement,
  taskRefs?: Map<string, ParsedTask>
): HTMLElement | null {
  const present: TaskGroup[] = [];
  for (const g of siblings) {
    if (g === skip) continue;
    present.push({
      path: g.dataset.file || "",
      tasks: [],
      timed: groupTimedFromEl(g),
    });
    const last = present[present.length - 1];
    const earliest = taskRefs ? earliestTimeFromGroupEl(g, taskRefs) : null;
    if (earliest) {
      last.tasks = [
        {
          filePath: last.path,
          line: 0,
          raw: "",
          checked: false,
          text: "",
          tags: [],
          time: earliest,
          format: "legacy",
        },
      ];
    }
  }
  present.push({
    path: key.path,
    tasks: key.earliestTime
      ? [
          {
            filePath: key.path,
            line: 0,
            raw: "",
            checked: false,
            text: "",
            tags: [],
            time: key.earliestTime,
            format: "legacy",
          },
        ]
      : [],
    timed: key.timed,
  });
  const ordered = arrangeGroups(present, settings, dateKey);
  const at = ordered.findIndex((g) => g === present[present.length - 1]);
  const next = at >= 0 ? ordered[at + 1] : undefined;
  if (!next) return null;
  const nextIndex = present.indexOf(next);
  return siblings.filter((g) => g !== skip)[nextIndex] ?? null;
}
