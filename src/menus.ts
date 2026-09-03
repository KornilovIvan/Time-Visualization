import { setIcon } from "obsidian";
import type { ParsedTask } from "./parser";
import { formatDate, parseDate } from "./parser";
import { addDays, fileName } from "./dates";
import type { ViewHost } from "./viewHost";
import { sortedGroups, startEditTask, hasGlobalPriority } from "./taskRow";
import { flipMove, syncActiveSection } from "./toggleAnimation";
import { mountPriorityList } from "./priorityList";

export function closeTaskMenu(view: ViewHost): void {
  if (view.taskMenu) {
    view.taskMenu.remove();
    view.taskMenu = null;
  }
  view.taskMenuAnchor = null;
}

export function closePriorityMenu(view: ViewHost): void {
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
  // Opening a fresh menu — clear the "just closed" guard so the next click
  // on a task is not swallowed
  view.menuJustClosed = false;
  view.taskMenuAnchor = anchor;

  const popup = createDiv();
  popup.className = "be-task-menu-popup";
  const item = popup.createDiv({ cls: "be-task-menu-item" });
  setIcon(item, "pencil");
  item.createSpan({ text: "Edit" });
  item.addEventListener("click", (ev) => {
    ev.stopPropagation();
    closeTaskMenu(view);
    startEditTask(view, row, t);
  });

  const itemMove = popup.createDiv({ cls: "be-task-menu-item" });
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

  // Close on a click outside the popup; the following click event must not
  // toggle a task (the user just wanted to dismiss the menu). Clicks on the
  // anchor button are ignored here — its click handler toggles the menu.
  const close = (ev: MouseEvent): void => {
    if (popup.contains(ev.target as Node)) return;
    if (anchor.contains(ev.target as Node)) return;
    view.menuJustClosed = true;
    closeTaskMenu(view);
    document.removeEventListener("mousedown", close, true);
    document.removeEventListener("wheel", onScroll, true);
  };
  document.addEventListener("mousedown", close, true);

  // Close when the user starts scrolling the task list — the menu must not
  // stay floating over the content
  const onScroll = (): void => {
    closeTaskMenu(view);
    document.removeEventListener("mousedown", close, true);
    document.removeEventListener("wheel", onScroll, true);
  };
  document.addEventListener("wheel", onScroll, true);
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

  const group = row.closest(".be-day-group") as HTMLElement | null;
  const groupTasks = group?.querySelector(".be-day-group-tasks");
  const isLast = !!groupTasks && groupTasks.childElementCount === 1;
  const slide = row.closest(".be-day-slide") as HTMLElement | null;

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
      });
    } else {
      row.remove();
    }
    void view.index.moveTask(t, nextKey).catch(() => {
      /* on error the index/render will show the actual state */
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
  // Opening a fresh menu — clear the "just closed" guard so the next click
  // is not swallowed
  view.menuJustClosed = false;
  view.priorityMenuAnchor = anchor;
  // Keep the header button visible while the menu is open
  anchor.addClass("is-open");

  const popup = createDiv();
  popup.className = "be-task-menu-popup be-priority-popup";

  // Groups currently in this day, in their displayed (sorted) order
  const tasks = view.index.getTasks(dateKey);
  const active = tasks.filter((t) => !t.checked);
  const order = sortedGroups(view, active, dateKey).map(([p]) => p);
  const priorities = view.plugin.settings.priorities;

  mountPriorityList(popup, {
    items: order.map((p) => ({
      path: p,
      label: fileName(p),
      isGlobal: hasGlobalPriority(priorities, p),
    })),
    rowClass: "be-task-menu-item",
    tipText: order.length > 0 ? "Use the arrows to reorder priority" : undefined,
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

  // Close on a click outside the popup; the following click event must not
  // toggle a task (the user just wanted to dismiss the menu). Clicks on the
  // anchor button are ignored here — its click handler toggles the menu.
  const close = (ev: MouseEvent): void => {
    if (popup.contains(ev.target as Node)) return;
    if (anchor.contains(ev.target as Node)) return;
    view.menuJustClosed = true;
    closePriorityMenu(view);
    document.removeEventListener("mousedown", close, true);
    document.removeEventListener("wheel", onScroll, true);
  };
  document.addEventListener("mousedown", close, true);
  const onScroll = (): void => {
    closePriorityMenu(view);
    document.removeEventListener("mousedown", close, true);
    document.removeEventListener("wheel", onScroll, true);
  };
  document.addEventListener("wheel", onScroll, true);
}
