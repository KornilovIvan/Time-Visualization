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

/** Groups sorted by priority: per-day order first, then the global priority
    list, then unprioritized groups in their by-time order. When the
    "time over priority" setting is on, groups with timed tasks always come
    first regardless of the global priority list. */
export function sortedGroups(
  view: ViewHost,
  tasks: ParsedTask[],
  dateKey: string
): Array<[string, ParsedTask[]]> {
  const groups = groupTasksByFile(tasks);
  const day = view.plugin.settings.dayOrder[dateKey] ?? [];
  const dayPos = new Map<string, number>();
  day.forEach((p, i) => {
    if (groups.has(p)) dayPos.set(p, i);
  });
  const globalPos = new Map<string, number>();
  view.plugin.settings.priorities.forEach((p, i) => globalPos.set(p, i));
  const hasTime = (path: string): boolean => {
    const arr = groups.get(path);
    return !!arr && arr.some((t) => !!t.time);
  };
  const timeFirst = view.plugin.settings.timeOverPriority;
  return Array.from(groups.entries()).sort((a, b) => {
    if (timeFirst) {
      const at = hasTime(a[0]);
      const bt = hasTime(b[0]);
      if (at !== bt) return at ? -1 : 1;
    }
    const ad = dayPos.get(a[0]);
    const bd = dayPos.get(b[0]);
    if (ad !== undefined && bd !== undefined) return ad - bd;
    if (ad !== undefined) return -1;
    if (bd !== undefined) return 1;
    const ag = globalPos.get(a[0]);
    const bg = globalPos.get(b[0]);
    if (ag !== undefined && bg !== undefined) return ag - bg;
    if (ag !== undefined) return -1;
    if (bg !== undefined) return 1;
    return 0; // stable sort keeps the existing by-time order
  });
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
  const title = group.createDiv({ cls: "be-day-group-title" });
  const name = title.createSpan({ cls: "be-day-group-name" });
  name.setText(fileName(path) + ":");
  // "Today" badge for the current day's daily note
  if (dayKey && fileName(path) === dayKey) {
    title.createSpan({ cls: "be-day-group-today", text: "Today" });
  }
  attachNoteLink(view, name, path);
}

export function createTaskGroup(
  view: ViewHost,
  container: HTMLElement,
  path: string,
  dayKey?: string
): HTMLElement {
  const group = container.createDiv({ cls: "be-day-group" });
  group.dataset.file = path;
  makeGroupTitle(view, group, path, dayKey);
  group.createDiv({ cls: "be-day-group-tasks" });
  return group;
}

export function fillGroup(
  view: ViewHost,
  container: HTMLElement,
  tasks: ParsedTask[],
  path: string,
  key: string,
  compact: boolean
): void {
  const group = createTaskGroup(view, container, path, key);
  const gl = group.querySelector(".be-day-group-tasks") as HTMLElement;
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
  section: "active" | "done"
): HTMLElement {
  const group = container.createDiv({ cls: "be-day-group is-collapsed" });
  group.dataset.file = path;
  group.dataset.day = key;
  group.dataset.section = section;

  // makeGroupTitle is not used: in the collapsed state the name must not be a
  // link (CSS sets its pointer-events to none)
  const title = group.createDiv({ cls: "be-day-group-title" });
  const name = title.createSpan({ cls: "be-day-group-name", text: fileName(path) + ":" });
  title.createSpan({ cls: "be-day-group-count", text: String(tasks.length) });
  title.createSpan({ cls: "be-day-group-chevron", text: "▸" });

  const gl = group.createDiv({ cls: "be-day-group-tasks" });

  attachNoteLink(view, name, path);

  group.addEventListener("click", (ev) => {
    if ((ev.target as HTMLElement).closest(".be-task")) return;
    ev.stopPropagation();
    if (view.isSelectionClick(ev)) return;
    const collapsed = group.classList.toggle("is-collapsed");
    gl.empty();
    if (!collapsed) {
      const dayKey = group.dataset.day ?? key;
      const fPath = group.dataset.file ?? path;
      const sec = (group.dataset.section as "active" | "done") ?? section;
      const fresh = view.index
        .getTasks(dayKey)
        .filter((t) => t.filePath === fPath && (sec === "done" ? t.checked : !t.checked));
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
  svg.setAttribute("class", "be-check-svg");
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
  path.setAttribute("class", "be-check-mark");
  svg.appendChild(path);
  box.empty();
  box.appendChild(svg);
}

export function buildTaskRow(view: ViewHost, t: ParsedTask, compact: boolean): HTMLElement {
  const row = createDiv();
  row.className = "be-task" + (t.checked ? " is-done" : "");

  const box = row.createEl("button", {
    cls: "be-task-box" + (t.checked ? " is-checked" : ""),
  });
  renderCheckbox(box, compact);

  const taskKey = `${t.filePath}:${t.line}`;
  row.dataset.taskKey = taskKey;
  view.taskRefs.set(taskKey, t);

  const text = row.createDiv({ cls: "be-task-text" });
  const textInner = text.createSpan({ cls: "be-task-inner" });
  textInner.appendChild(sanitizeHTMLToDom(renderInlineMarkdown(t.text)));

  if (t.time) {
    text.createSpan({ cls: "be-task-time", text: " " + t.time });
  }

  if (t.tags.length > 0) {
    const tags = text.createDiv({ cls: "be-task-tags" });
    for (const tag of t.tags) {
      tags.createSpan({ cls: "be-tag", text: tag });
    }
  }

  // Task menu: only visible in the day card on hover (hidden elsewhere via CSS).
  // Custom-format tasks are read-only, so the menu is omitted.
  if (t.format !== "custom") {
    const menuBtn = row.createEl("button", {
      cls: "be-task-menu",
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
  const textEl = row.querySelector(".be-task-text") as HTMLElement | null;
  if (!textEl) return;
  const inner = textEl.querySelector(".be-task-inner") as HTMLElement | null;

  row.classList.add("is-editing");
  const taskKey = `${t.filePath}:${t.line}`;
  view.editingTaskKey = taskKey;

  const input = createEl("textarea");
  input.className = "be-task-edit";
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
