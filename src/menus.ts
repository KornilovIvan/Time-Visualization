import { Notice, setIcon } from "obsidian";
import { MultiSuggest } from "./settingsUi";
import type { ParsedTask } from "./parser";
import { formatDate, parseDate } from "./parser";
import { addDays, fileName } from "./dates";
import type { ViewHost } from "./viewHost";
import { startEditTask } from "./taskRow";
import { flipMove, syncActiveSection, syncTimedSection } from "./toggleAnimation";
import { mountPriorityList } from "./priorityList";
import { appendTaskLine, formatNewTaskLine, moveTask } from "./taskWriter";
import { hasGlobalPriority, sortedGroupPaths } from "./taskSort";

type MenuKind = "task" | "priority" | "notes" | "add";

/** Outside-click / wheel listeners, one set per open menu.
    They must be removed on every close path. Toggling the button used to
    leave the old listener attached, and that listener then treated a click
    inside the next menu as a click outside and closed it. */
const menuDismissers = new WeakMap<ViewHost, Map<MenuKind, () => void>>();

function clearMenuDismiss(view: ViewHost, kind: MenuKind): void {
  const dismiss = menuDismissers.get(view)?.get(kind);
  if (!dismiss) return;
  dismiss();
  menuDismissers.get(view)?.delete(kind);
}

function watchMenuDismiss(
  view: ViewHost,
  kind: MenuKind,
  popup: HTMLElement,
  anchor: HTMLElement | null,
  closeMenu: () => void,
  extra?: {
    ignore?: (target: EventTarget | null) => boolean;
    /** Replaces the default "any wheel closes the menu" listener. */
    onWheel?: (ev: WheelEvent) => void;
    /** No wheel listener. */
    wheel?: false;
  }
): void {
  clearMenuDismiss(view, kind);
  const onMouseDown = (ev: MouseEvent): void => {
    const target = ev.target;
    if (target instanceof Node && popup.contains(target)) return;
    if (anchor && target instanceof Node && anchor.contains(target)) return;
    if (extra?.ignore?.(target)) return;
    view.menuJustClosed = true;
    closeMenu();
  };
  document.addEventListener("mousedown", onMouseDown, true);

  let onWheel: ((ev: WheelEvent) => void) | null = null;
  if (extra?.onWheel) {
    onWheel = extra.onWheel;
    document.addEventListener("wheel", onWheel, { capture: true, passive: false });
  } else if (extra?.wheel !== false) {
    onWheel = () => closeMenu();
    document.addEventListener("wheel", onWheel, true);
  }

  const dismiss = (): void => {
    document.removeEventListener("mousedown", onMouseDown, true);
    if (onWheel) document.removeEventListener("wheel", onWheel, true);
  };
  let map = menuDismissers.get(view);
  if (!map) {
    map = new Map();
    menuDismissers.set(view, map);
  }
  map.set(kind, dismiss);
}

/** Day-priority row label: keep folder prefix so notes in a priority folder are distinct. */
function priorityLabel(path: string): string {
  if (!path.endsWith(".md")) return fileName(path) || path;
  const noExt = path.replace(/\.md$/i, "");
  return noExt.includes("/") ? noExt : fileName(path);
}

export function closeTaskMenu(view: ViewHost): void {
  clearMenuDismiss(view, "task");
  if (view.taskMenu) {
    view.taskMenu.remove();
    view.taskMenu = null;
  }
  view.taskMenuAnchor = null;
}

export function closePriorityMenu(view: ViewHost): void {
  clearMenuDismiss(view, "priority");
  if (view.priorityMenu) {
    view.priorityMenu.remove();
    view.priorityMenu = null;
  }
  if (view.priorityMenuAnchor) {
    view.priorityMenuAnchor.removeClass("is-open");
  }
  view.priorityMenuAnchor = null;
}

/** Custom task menu popup (plugin-styled, no system Menu) */
export function showTaskMenu(
  view: ViewHost,
  anchor: HTMLElement,
  row: HTMLElement,
  t: ParsedTask
): void {
  // Re-click on the same button toggles the menu closed
  if (view.taskMenu && view.taskMenuAnchor === anchor) {
    closeTaskMenu(view);
    return;
  }
  closeTaskMenu(view);
  closeAddTaskMenu(view);
  // Opening a fresh menu — clear the "just closed" guard so the next click
  // on a task is not swallowed
  view.menuJustClosed = false;
  view.taskMenuAnchor = anchor;

  const popup = createDiv();
  popup.className = "tv-task-menu-popup";
  const item = popup.createDiv({ cls: "tv-task-menu-item" });
  setIcon(item, "pencil");
  item.createSpan({ text: "Edit" });
  item.addEventListener("click", (ev) => {
    ev.stopPropagation();
    closeTaskMenu(view);
    startEditTask(view, row, t);
  });

  const itemMove = popup.createDiv({ cls: "tv-task-menu-item" });
  setIcon(itemMove, "arrow-right");
  itemMove.createSpan({ text: "Move to next day" });
  itemMove.addEventListener("click", (ev) => {
    ev.stopPropagation();
    closeTaskMenu(view);
    moveTaskToNextDay(view, row, t);
  });

  document.body.appendChild(popup);
  view.taskMenu = popup;

  const rect = anchor.getBoundingClientRect();
  const popupW = popup.offsetWidth || 150;
  popup.style.left = `${Math.max(4, rect.right - popupW)}px`;
  popup.style.top = `${rect.bottom + 4}px`;

  // Clicks on the anchor are ignored — its click handler toggles the menu.
  // A click outside sets menuJustClosed so the same click does not toggle a task.
  watchMenuDismiss(view, "task", popup, anchor, () => closeTaskMenu(view));
}

/** Moves a task to the next day: the row flies right while staying in the
    layout (no reflow mid-flight, so it never stutters). Near the end, when it
    is already transparent, it is removed and the rest lift smoothly via FLIP
    — the flight and the lift never share a frame, and FLIP removes the row's
    space completely (no leftover padding/gap jumps). */
export function moveTaskToNextDay(view: ViewHost, row: HTMLElement, t: ParsedTask): void {
  if (!t.date) return;
  const next = addDays(parseDate(t.date), 1);
  const nextKey = formatDate(next);

  const group = row.closest(".tv-day-group") as HTMLElement | null;
  const groupTasks = group?.querySelector(".tv-day-group-tasks");
  const isLast = !!groupTasks && groupTasks.childElementCount === 1;
  const slide = row.closest(".tv-day-slide") as HTMLElement | null;

  // Flight first: the row keeps its place in the layout, so no synchronous
  // reflow happens while it flies (a mid-flight layout change was what caused
  // the visible stutter)
  row.animate(
    [
      { transform: "translateX(0)", opacity: 1 },
      { transform: "translateX(120%)", opacity: 0 },
    ],
    { duration: 1800, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" }
  );

  // Near the end of the flight the row is already transparent — remove it and
  // lift the rest with FLIP in a separate moment (no animation conflict)
  const lift = (): void => {
    if (slide) {
      flipMove(slide, () => {
        row.remove();
        if (group && isLast) group.remove();
        syncActiveSection(slide);
        syncTimedSection(slide);
      });
    } else {
      row.remove();
    }
    void moveTask(view.plugin, t, nextKey).then((r) => {
      if (!r.ok) view.refillCurrent();
    }).catch(() => {
      view.refillCurrent();
    });
  };
  window.setTimeout(lift, 750);

  // Suppress re-render from the file change — otherwise it would cut the animation
  view.suppressRerender(2500);
}

/** Day-header priority menu: lists the groups of this day and lets you drag
    them into the desired order (per-day order). Same look and behavior as
    the task menu. */
export function showDayPriorityMenu(view: ViewHost, anchor: HTMLElement, dateKey: string): void {
  // Re-click on the same button toggles the menu closed
  if (view.priorityMenu && view.priorityMenuAnchor === anchor) {
    closePriorityMenu(view);
    return;
  }
  closePriorityMenu(view);
  closeAddTaskMenu(view);
  // Opening a fresh menu — clear the "just closed" guard so the next click
  // is not swallowed
  view.menuJustClosed = false;
  view.priorityMenuAnchor = anchor;
  // Keep the header button visible while the menu is open
  anchor.addClass("is-open");

  const popup = createDiv();
  popup.className = "tv-task-menu-popup tv-priority-popup";

  // One row per note so you can reorder within a priority folder or move a
  // note out of the folder band. Folder-aware dayOrder still applies when
  // sorting (and for notes not yet listed after a local reorder).
  const tasks = view.index.getTasks(dateKey);
  const active = tasks.filter((t) => !t.checked);
  const order = sortedGroupPaths(view.plugin.settings, active, dateKey);
  const priorities = view.plugin.settings.priorities;

  mountPriorityList(popup, {
    items: order.map((p) => ({
      path: p,
      label: priorityLabel(p),
      isGlobal: hasGlobalPriority(priorities, p),
    })),
    rowClass: "tv-task-menu-item",
    tipText: order.length > 0 ? "Reorder notes for this day" : undefined,
    emptyText: order.length === 0 ? "No open groups in this day" : undefined,
    setIndexAttr: true,
    onOrderChange: (paths) => {
      view.plugin.settings.dayOrder[dateKey] = paths;
      void view.plugin.saveSettings();
      view.refillCurrent();
    },
  });

  document.body.appendChild(popup);
  view.priorityMenu = popup;

  const rect = anchor.getBoundingClientRect();
  const popupW = popup.offsetWidth || 220;
  popup.style.left = `${Math.max(4, rect.right - popupW)}px`;
  popup.style.top = `${rect.bottom + 4}px`;

  watchMenuDismiss(view, "priority", popup, anchor, () => closePriorityMenu(view));
}

export function closeNoteFilterMenu(view: ViewHost): void {
  clearMenuDismiss(view, "notes");
  if (view.noteFilterMenu) {
    view.noteFilterMenu.remove();
    view.noteFilterMenu = null;
  }
  if (view.noteFilterAnchor) {
    view.noteFilterAnchor.removeClass("is-open");
  }
  view.noteFilterAnchor = null;
}

/** Header filter: show tasks from the checked notes. Empty selection shows all. */
export function showNoteFilterMenu(view: ViewHost, anchor: HTMLElement): void {
  if (view.noteFilterMenu && view.noteFilterAnchor === anchor) {
    closeNoteFilterMenu(view);
    return;
  }
  closeNoteFilterMenu(view);
  closeTaskMenu(view);
  closePriorityMenu(view);
  closeAddTaskMenu(view);
  view.menuJustClosed = false;
  view.noteFilterAnchor = anchor;
  anchor.addClass("is-open");

  const popup = createDiv();
  popup.className = "tv-task-menu-popup tv-note-filter-popup";

  const all = popup.createDiv({ cls: "tv-task-menu-item tv-note-filter-item" });
  const allMark = all.createSpan({ cls: "tv-note-filter-mark" });
  all.createSpan({ text: "All notes" });

  const rows: Array<{ path: string; row: HTMLElement; mark: HTMLElement }> = [];
  const sync = (): void => {
    const selected = view.noteFilter;
    const showAll = selected.length === 0;
    all.classList.toggle("is-on", showAll);
    allMark.setText(showAll ? "✓" : "");
    for (const { path, row, mark } of rows) {
      const on = selected.includes(path);
      row.classList.toggle("is-on", on);
      mark.setText(on ? "✓" : "");
    }
  };

  all.addEventListener("click", (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    view.clearNoteFilter();
    sync();
  });

  for (const path of view.index.notePaths()) {
    const row = popup.createDiv({ cls: "tv-task-menu-item tv-note-filter-item" });
    const mark = row.createSpan({ cls: "tv-note-filter-mark" });
    const label = path.includes("/") ? path.replace(/\.md$/i, "") : fileName(path);
    row.createSpan({ cls: "tv-note-filter-name", text: label });
    row.addEventListener("click", (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      view.toggleNoteFilter(path);
      sync();
    });
    rows.push({ path, row, mark });
  }
  sync();

  document.body.appendChild(popup);
  view.noteFilterMenu = popup;

  const rect = anchor.getBoundingClientRect();
  const popupW = popup.offsetWidth || 220;
  popup.style.left = `${Math.max(4, rect.right - popupW)}px`;
  popup.style.top = `${rect.bottom + 4}px`;

  // Wheel inside the list scrolls the list. Closing here used to remove the
  // popup mid-event, so the same wheel then scrolled the day underneath.
  watchMenuDismiss(view, "notes", popup, anchor, () => closeNoteFilterMenu(view), {
    onWheel: (ev) => {
      if (popup.contains(ev.target as Node)) {
        ev.preventDefault();
        ev.stopPropagation();
        popup.scrollTop += ev.deltaY;
        return;
      }
      closeNoteFilterMenu(view);
    },
  });
}

const addTaskPathSuggest = new WeakMap<ViewHost, MultiSuggest>();

export function closeAddTaskMenu(view: ViewHost): void {
  clearMenuDismiss(view, "add");
  const suggest = addTaskPathSuggest.get(view);
  if (suggest) {
    suggest.close();
    addTaskPathSuggest.delete(view);
  }
  if (view.addTaskMenu) {
    view.addTaskMenu.remove();
    view.addTaskMenu = null;
  }
  if (view.addTaskAnchor) view.addTaskAnchor.removeClass("is-open");
  view.addTaskAnchor = null;
}

/** `YYYY-MM-DD` that is a real calendar day. */
function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d;
}

/** Typed path, with `.md` added when it was left off. */
function notePathFromInput(raw: string): string {
  const path = raw.trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!path) return "";
  return path.toLowerCase().endsWith(".md") ? path : `${path}.md`;
}

/** Add a task on a chosen day. The line is appended to the note at the typed path. */
export function showAddTaskMenu(view: ViewHost, anchor: HTMLElement): void {
  if (view.addTaskMenu && view.addTaskAnchor === anchor) {
    closeAddTaskMenu(view);
    return;
  }
  closeAddTaskMenu(view);
  closeNoteFilterMenu(view);
  closeTaskMenu(view);
  closePriorityMenu(view);
  view.menuJustClosed = false;

  if (view.plugin.settings.dateFormat === "custom") {
    new Notice("Adding a task needs the inline-field or Tasks date format.");
    return;
  }

  view.addTaskAnchor = anchor;
  anchor.addClass("is-open");

  const popup = createDiv();
  popup.className = "tv-task-menu-popup tv-add-task-popup";

  const textInput = popup.createEl("textarea", {
    cls: "tv-add-task-input tv-add-task-text",
    attr: { rows: "3", placeholder: "Task" },
  });
  const dateInput = popup.createEl("input", {
    cls: "tv-add-task-input",
    attr: { type: "date", value: formatDate(view.cursor) },
  });
  const timeInput = popup.createEl("input", {
    cls: "tv-add-task-input",
    attr: { type: "text", placeholder: "Time, optional (09:00 or 09:00-10:30)" },
  });
  const pathInput = popup.createEl("input", {
    cls: "tv-add-task-input",
    attr: { type: "text", placeholder: "Note path (Folder/Note.md)", value: view.lastAddNote ?? "" },
  });
  const notes = view.app.vault
    .getMarkdownFiles()
    .map((f) => f.path)
    .filter((p) => view.index.acceptsPath(p))
    .sort((a, b) => a.localeCompare(b));
  const pathSuggest = new MultiSuggest(view.app, pathInput, notes, () => {}, "path", true);
  addTaskPathSuggest.set(view, pathSuggest);
  const error = popup.createDiv({ cls: "tv-add-task-error" });

  const add = popup.createEl("button", { cls: "tv-btn tv-add-task-submit", text: "Add" });
  const submit = async (): Promise<void> => {
    const date = dateInput.value.trim();
    if (!textInput.value.trim()) {
      error.setText("Enter a task.");
      return;
    }
    if (!isCalendarDate(date)) {
      error.setText("Pick a date.");
      return;
    }
    const line = formatNewTaskLine(textInput.value, date, timeInput.value, view.plugin.settings.dateFormat);
    if (!line) {
      error.setText("Time should look like 09:00 or 09:00-10:30.");
      return;
    }
    const path = notePathFromInput(pathInput.value);
    if (!path || !view.app.vault.getAbstractFileByPath(path)) {
      error.setText("No note at that path.");
      return;
    }
    if (!view.index.acceptsPath(path)) {
      error.setText("That note is outside the calendar sources.");
      return;
    }
    error.setText("");
    const wrote = await appendTaskLine(view.plugin, path, line);
    if (!wrote.ok) {
      new Notice("Could not write the task.");
      return;
    }
    view.lastAddNote = path;
    closeAddTaskMenu(view);
  };
  add.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    void submit();
  });
  textInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault();
      void submit();
    }
  });
  for (const input of [dateInput, timeInput]) {
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        void submit();
      }
    });
  }
  pathInput.addEventListener(
    "keydown",
    (ev) => {
      if (ev.key !== "Enter") return;
      const open = (pathSuggest as unknown as { isOpen?: boolean }).isOpen === true;
      if (open) return;
      ev.preventDefault();
      void submit();
    },
    true
  );

  document.body.appendChild(popup);
  view.addTaskMenu = popup;
  const rect = anchor.getBoundingClientRect();
  const popupW = popup.offsetWidth || 440;
  const popupH = popup.offsetHeight;
  let top = rect.bottom + 4;
  if (top + popupH > window.innerHeight - 8) top = Math.max(8, rect.top - popupH - 4);
  popup.style.left = `${Math.max(4, rect.right - popupW)}px`;
  popup.style.top = `${top}px`;
  textInput.focus();

  watchMenuDismiss(view, "add", popup, anchor, () => closeAddTaskMenu(view), {
    wheel: false,
    ignore: (target) => target instanceof Element && !!target.closest(".suggestion-container"),
  });
}
