import { sanitizeHTMLToDom, setIcon } from "obsidian";
import type { ParsedTask } from "./parser";
import { renderInlineMarkdown } from "./markdown";
import { fileName } from "./dates";
import type { ViewHost } from "./viewHost";
import { attachNoteLink, createTaskGroup } from "./taskGroup";
import { updateTaskText } from "./taskWriter";

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
      view.openTaskMenu(menuBtn, row, t);
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
      void updateTaskText(view.plugin, t, v).then((r) => {
        if (!r.ok && inner) {
          inner.empty();
          inner.appendChild(sanitizeHTMLToDom(renderInlineMarkdown(t.text)));
        }
      }).catch(() => {
        if (inner) {
          inner.empty();
          inner.appendChild(sanitizeHTMLToDom(renderInlineMarkdown(t.text)));
        }
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
