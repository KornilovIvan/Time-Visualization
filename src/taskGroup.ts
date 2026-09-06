import { TFile } from "obsidian";
import { fileName } from "./dates";
import type { ViewHost } from "./viewHost";
import { VIEW_TYPE } from "./viewHost";

export function openNote(view: ViewHost, path: string): void {
  const file = view.app.vault.getAbstractFileByPath(path);
  if (file instanceof TFile) {
    void view.app.workspace.getLeaf("tab").openFile(file);
  }
}

/** Same Page Preview trigger Obsidian uses for internal links / group titles. */
export function triggerHoverLink(
  view: ViewHost,
  targetEl: HTMLElement,
  linktext: string,
  event: MouseEvent
): void {
  const hoverParent = { hoverPopover: null, dom: view.contentEl } as unknown;
  view.app.workspace.trigger("hover-link", {
    event,
    source: VIEW_TYPE,
    hoverParent,
    targetEl,
    linktext,
  });
}

/** Wire Ctrl/Cmd+hover (Page Preview) for rendered internal links in task text. */
export function attachInternalLinkHovers(view: ViewHost, root: HTMLElement): void {
  root.querySelectorAll("a.internal-link").forEach((node) => {
    const a = node as HTMLElement;
    a.addEventListener("mouseenter", (e) => {
      const linktext = a.getAttribute("data-href");
      if (!linktext) return;
      triggerHoverLink(view, a, linktext, e);
    });
  });
}

export function attachNoteLink(view: ViewHost, name: HTMLElement, path: string): void {
  name.addEventListener("click", (e) => {
    e.stopPropagation();
    if (view.isSelectionClick(e)) return;
    openNote(view, path);
  });
  name.addEventListener("mouseenter", (e) => {
    triggerHoverLink(view, name, path.replace(/\.md$/i, ""), e);
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
