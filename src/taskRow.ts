import { TFile, sanitizeHTMLToDom, setIcon } from "obsidian";
import type { ParsedTask } from "./parser";
import { renderInlineMarkdown } from "./markdown";
import { fileName } from "./dates";
import type { ViewHost } from "./viewHost";
import { VIEW_TYPE } from "./viewHost";
import { showTaskMenu } from "./menus";

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
  view: ViewHost,
  tasks: ParsedTask[],
  dateKey: string
): TaskGroup[] {
  const groups = splitTimedGroups(tasks);
  const day = view.plugin.settings.dayOrder[dateKey] ?? [];
  const dayPos = new Map<string, number>();
  day.forEach((p, i) => dayPos.set(p, i));
  const priorities = view.plugin.settings.priorities;
  const timeFirst = view.plugin.settings.timeOverPriority;
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
  view: ViewHost,
  tasks: ParsedTask[],
  dateKey: string
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const g of sortedGroups(view, tasks, dateKey)) {
    if (seen.has(g.path)) continue;
    seen.add(g.path);
    paths.push(g.path);
  }
  return paths;
}


export function openNote(view: ViewHost, path: string): void {
  const file = view.app.vault.getAbstractFileByPath(path);
  if (file instanceof TFile) {
    void view.app.workspace.getLeaf("tab").openFile(file);
  }
}

export function attachNoteLink(view: ViewHost, name: HTMLElement, path: string): void {
  name.addEventListener("click", (e) => {
    e.stopPropagation();
    if (view.isSelectionClick(e)) return;
    openNote(view, path);
  });
  name.addEventListener("mouseenter", (e) => {
    const hoverParent = { hoverPopover: null, dom: view.contentEl } as unknown;
    view.app.workspace.trigger("hover-link", {
      event: e,
      source: VIEW_TYPE,
      hoverParent,
      targetEl: name,
      linktext: path.replace(/\.md$/i, ""),
    });
  });
}

export function makeGroupTitle(
  view: ViewHost,
  group: HTMLElement,
  path: string,
  dayKey?: string
): void {
  const title = group.createDiv({ cls: "tv-day-group-title" });
  const name = title.createSpan({ cls: "tv-day-group-name" });
  name.setText(fileName(path) + ":");
  // "Today" badge for the current day's daily note
  if (dayKey && fileName(path) === dayKey) {
    title.createSpan({ cls: "tv-day-group-today", text: "Today" });
  }
  attachNoteLink(view, name, path);
}

export function createTaskGroup(
  view: ViewHost,
  container: HTMLElement,
  path: string,
  dayKey?: string,
  /** When set, marks an active timed/untimed subgroup (done groups omit this). */
  timed?: boolean
): HTMLElement {
  const group = container.createDiv({ cls: "tv-day-group" });
  group.dataset.file = path;
  if (timed !== undefined) group.dataset.timed = timed ? "1" : "0";
  makeGroupTitle(view, group, path, dayKey);
  group.createDiv({ cls: "tv-day-group-tasks" });
  return group;
}

export function fillGroup(
  view: ViewHost,
  container: HTMLElement,
  tasks: ParsedTask[],
  path: string,
  key: string,
  compact: boolean,
  timed?: boolean
): void {
  const group = createTaskGroup(view, container, path, key, timed);
  const gl = group.querySelector(".tv-day-group-tasks") as HTMLElement;
  for (const t of tasks) gl.appendChild(buildTaskRow(view, t, compact));
}

/** Collapsed note group (month): header + counter + chevron. Tasks are built
    only after a click (lazy) and re-read from the index on expand. */
export function buildCollapsedGroup(
  view: ViewHost,
  container: HTMLElement,
  tasks: ParsedTask[],
  path: string,
  key: string,
  compact: boolean,
  section: "active" | "done",
  timed?: boolean
): HTMLElement {
  const group = container.createDiv({ cls: "tv-day-group is-collapsed" });
  group.dataset.file = path;
  group.dataset.day = key;
  group.dataset.section = section;
  if (timed !== undefined) group.dataset.timed = timed ? "1" : "0";

  // makeGroupTitle is not used: in the collapsed state the name must not be a
  // link (CSS sets its pointer-events to none)
  const title = group.createDiv({ cls: "tv-day-group-title" });
  const name = title.createSpan({ cls: "tv-day-group-name", text: fileName(path) + ":" });
  title.createSpan({ cls: "tv-day-group-count", text: String(tasks.length) });
  title.createSpan({ cls: "tv-day-group-chevron", text: "▸" });

  const gl = group.createDiv({ cls: "tv-day-group-tasks" });

  attachNoteLink(view, name, path);

  group.addEventListener("click", (ev) => {
    if ((ev.target as HTMLElement).closest(".tv-task")) return;
    ev.stopPropagation();
    if (view.isSelectionClick(ev)) return;
    const collapsed = group.classList.toggle("is-collapsed");
    gl.empty();
    if (!collapsed) {
      const dayKey = group.dataset.day ?? key;
      const fPath = group.dataset.file ?? path;
      const sec = (group.dataset.section as "active" | "done") ?? section;
      const wantTimed = group.dataset.timed;
      const fresh = view.index
        .getTasks(dayKey)
        .filter((t) => {
          if (t.filePath !== fPath) return false;
          if (sec === "done" ? !t.checked : t.checked) return false;
          if (wantTimed === "1") return !!t.time;
          if (wantTimed === "0") return !t.time;
          return true;
        });
      for (const t of fresh) gl.appendChild(buildTaskRow(view, t, compact));
    }
  });

  return group;
}

/** Custom checkbox: the check mark is drawn via a stroke animation */
export function renderCheckbox(box: HTMLElement, compact: boolean): void {
  void compact; // visually identical; compactness comes from the CSS size
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "tv-check-svg");
  const rect = document.createElementNS(ns, "rect");
  rect.setAttribute("x", "3");
  rect.setAttribute("y", "3");
  rect.setAttribute("width", "18");
  rect.setAttribute("height", "18");
  rect.setAttribute("rx", "4");
  rect.setAttribute("fill", "none");
  rect.setAttribute("stroke", "currentColor");
  rect.setAttribute("stroke-width", "2");
  svg.appendChild(rect);
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M6.5 12.5 l3.5 3.5 l7 -7");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "2.5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  path.setAttribute("stroke-dasharray", "30");
  path.setAttribute("stroke-dashoffset", "30");
  path.setAttribute("class", "tv-check-mark");
  svg.appendChild(path);
  box.empty();
  box.appendChild(svg);
}

export function buildTaskRow(view: ViewHost, t: ParsedTask, compact: boolean): HTMLElement {
  const row = createDiv();
  row.className = "tv-task" + (t.checked ? " is-done" : "");

  const box = row.createEl("button", {
    cls: "tv-task-box" + (t.checked ? " is-checked" : ""),
  });
  renderCheckbox(box, compact);

  const taskKey = `${t.filePath}:${t.line}`;
  row.dataset.taskKey = taskKey;
  view.taskRefs.set(taskKey, t);

  const text = row.createDiv({ cls: "tv-task-text" });
  const textInner = text.createSpan({ cls: "tv-task-inner" });
  textInner.appendChild(sanitizeHTMLToDom(renderInlineMarkdown(t.text)));

  if (t.time) {
    text.createSpan({ cls: "tv-task-time", text: " " + t.time });
  }

  if (t.tags.length > 0) {
    const tags = text.createDiv({ cls: "tv-task-tags" });
    for (const tag of t.tags) {
      tags.createSpan({ cls: "tv-tag", text: tag });
    }
  }

  // Task menu: only visible in the day card on hover (hidden elsewhere via CSS).
  // Custom-format tasks are read-only, so the menu is omitted.
  if (t.format !== "custom") {
    const menuBtn = row.createEl("button", {
      cls: "tv-task-menu",
      attr: { "aria-label": "Task menu" },
    });
    setIcon(menuBtn, "more-horizontal");
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      showTaskMenu(view, menuBtn, row, t);
    });
  }

  return row;
}

/** Inline editing of the task text (day card only).
    Enter — save, Escape — cancel, blur — save. */
export function startEditTask(view: ViewHost, row: HTMLElement, t: ParsedTask): void {
  const textEl = row.querySelector(".tv-task-text") as HTMLElement | null;
  if (!textEl) return;
  const inner = textEl.querySelector(".tv-task-inner") as HTMLElement | null;

  row.classList.add("is-editing");
  const taskKey = `${t.filePath}:${t.line}`;
  view.editingTaskKey = taskKey;

  const input = createEl("textarea");
  input.className = "tv-task-edit";
  input.value = t.text;
  row.insertBefore(input, textEl);
  // Auto-grow so the full multi-line content stays editable in place (the
  // task must not collapse to a single line while editing)
  const autosize = (): void => {
    input.style.removeProperty("height");
    input.style.height = `${input.scrollHeight}px`;
  };
  autosize();
  input.addEventListener("input", autosize);
  input.focus();
  input.select();

  // Intercept clicks on the row in the capture phase so they can't toggle the
  // task; clicks inside the input itself pass through
  const blockClick = (e: MouseEvent): void => {
    if (input.contains(e.target as Node)) return;
    e.stopImmediatePropagation();
    e.preventDefault();
  };
  row.addEventListener("click", blockClick, true);

  let finished = false;
  const release = (): void => {
    row.classList.remove("is-editing");
    row.removeEventListener("click", blockClick, true);
    view.editingTaskKey = null;
  };
  const finish = (save: boolean, explicit: boolean): void => {
    if (finished) return;
    finished = true;
    const v = input.value.trim();
    input.remove();
    if (explicit) {
      release();
    } else {
      // On blur, release with a delay so the click that caused the blur is
      // caught before the flag is cleared
      window.setTimeout(release, 0);
    }
    if (save && v && v !== t.text) {
      if (inner) inner.appendChild(sanitizeHTMLToDom(renderInlineMarkdown(v)));
      void view.index.updateTaskText(t, v).catch(() => {
        if (inner) inner.appendChild(sanitizeHTMLToDom(renderInlineMarkdown(t.text))); // rollback on error
      });
    }
  };

  input.addEventListener("keydown", (e) => {
    // Enter saves; Shift+Enter inserts a new line
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      finish(true, true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      finish(false, true);
    }
  });
  input.addEventListener("blur", () => finish(true, false));
}
