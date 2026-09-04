import { setIcon } from "obsidian";
import { flipReorder } from "./flip";

export interface PriorityListItem {
  path: string;
  label: string;
  isGlobal?: boolean;
}

export interface MountPriorityListOptions {
  items: PriorityListItem[];
  /** Extra classes on each row (always also gets tv-priority-row) */
  rowClass?: string;
  tipText?: string;
  emptyText?: string;
  /** If set, new rows are inserted before this node (e.g. the settings "Add" row) */
  insertBefore?: HTMLElement | null;
  /** Sentinel for move-down past the last row (usually the same as insertBefore) */
  trailingEl?: HTMLElement | null;
  showDelete?: boolean;
  /** Day menu stores dataset.index on each row */
  setIndexAttr?: boolean;
  onOrderChange: (paths: string[]) => void;
  onDelete?: (path: string, index: number) => void;
}

/** Shared reorderable priority rows (settings list + day-header menu). */
export function mountPriorityList(
  container: HTMLElement,
  options: MountPriorityListOptions
): void {
  const {
    items,
    rowClass = "",
    tipText,
    emptyText,
    insertBefore = null,
    trailingEl = null,
    showDelete = false,
    setIndexAttr = false,
    onOrderChange,
    onDelete,
  } = options;

  if (items.length === 0) {
    if (emptyText) {
      const hint = container.createDiv({ cls: "tv-task-menu-item tv-priority-hint" });
      if (insertBefore) container.insertBefore(hint, insertBefore);
      hint.createSpan({ text: emptyText });
    } else if (tipText) {
      const tip = container.createDiv({ cls: "tv-priority-tip", text: tipText });
      if (insertBefore) container.insertBefore(tip, insertBefore);
    }
    return;
  }

  if (tipText) {
    const tip = container.createDiv({ cls: "tv-priority-tip", text: tipText });
    if (insertBefore) container.insertBefore(tip, insertBefore);
  }

  let rows: HTMLElement[] = [];
  const renumber = (): void => {
    rows.forEach((r, j) => {
      if (setIndexAttr) r.dataset.index = String(j);
      const num = r.querySelector(".tv-priority-num");
      if (num) num.setText(String(j + 1));
    });
  };
  const commit = (): void => {
    onOrderChange(rows.map((r) => r.dataset.path ?? "").filter(Boolean));
  };
  const moveOne = (row: HTMLElement, dir: 1 | -1): void => {
    const from = rows.indexOf(row);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= rows.length) return;
    const prev = rows.map((r) => r.getBoundingClientRect().top);
    container.insertBefore(row, dir === 1 ? (rows[to + 1] ?? trailingEl) : rows[to]);
    rows = Array.from(container.querySelectorAll<HTMLElement>(".tv-priority-row"));
    flipReorder(rows, prev);
    renumber();
    commit();
  };

  items.forEach((item, i) => {
    const cls = [...new Set([rowClass, "tv-priority-row"].filter(Boolean))].join(" ");
    const row = container.createDiv({ cls });
    if (insertBefore) container.insertBefore(row, insertBefore);
    rows.push(row);
    if (setIndexAttr) row.dataset.index = String(i);
    row.dataset.path = item.path;
    row.createSpan({ cls: "tv-priority-num", text: String(i + 1) });
    row.createSpan({ cls: "tv-priority-name", text: item.label });
    if (item.isGlobal) {
      row.addClass("is-global");
      row.createSpan({ cls: "tv-priority-tag", text: "Global" });
    }
    const upBtn = row.createEl("button", { cls: "tv-priority-arrow", attr: { "aria-label": "Move up" } });
    setIcon(upBtn, "chevron-up");
    upBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      moveOne(row, -1);
    });
    const downBtn = row.createEl("button", { cls: "tv-priority-arrow", attr: { "aria-label": "Move down" } });
    setIcon(downBtn, "chevron-down");
    downBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      moveOne(row, 1);
    });
    if (showDelete && onDelete) {
      const del = row.createEl("button", { cls: "tv-priority-del", text: "×" });
      del.addEventListener("click", () => onDelete(item.path, i));
    }
  });
}
