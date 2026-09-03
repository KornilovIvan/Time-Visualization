import type { ParsedTask } from "./parser";
import type { ViewHost } from "./viewHost";
import { createTaskGroup } from "./taskRow";

export function fadeIn(el: HTMLElement, duration: number): void {
  el.animate(
    [{ opacity: 0 }, { opacity: 1 }],
    { duration, easing: "ease-out", fill: "backwards" }
  );
}

export function ensureDoneVisible(slide: HTMLElement): void {
  const section = slide.querySelector(".be-day-done-section") as HTMLElement | null;
  const title = slide.querySelector(".be-day-done-title") as HTMLElement | null;
  if (!section || !title) return;
  const wasHidden = section.classList.contains("is-empty");
  section.removeClass("is-empty");
  if (wasHidden) {
    fadeIn(title, 300);
  }
}

export function syncActiveSection(slide: HTMLElement): void {
  const list = slide.querySelector(".be-day-list") as HTMLElement | null;
  if (!list) return;
  const doneSection = slide.querySelector(".be-day-done-section") as HTMLElement | null;
  const hasGroups = list.querySelector(".be-day-group") !== null;
  const title = list.querySelector(".be-day-active-title") as HTMLElement | null;
  if (hasGroups) {
    list.classList.remove("be-hidden");
    if (doneSection) doneSection.classList.remove("be-done-top");
    if (doneSection && !doneSection.querySelector(".be-day-done-bar")) {
      const bar = doneSection.createDiv({ cls: "be-day-done-bar" });
      doneSection.insertBefore(bar, doneSection.firstChild);
    }
    if (!title) {
      const t = list.createDiv({ cls: "be-day-active-title", text: "Open tasks" });
      list.insertBefore(t, list.firstChild);
    }
  } else {
    // Hide the list so Done moves up flush against the header: the bar above
    // Done then lands exactly on the header's line and fades out (no double
    // line, no leftover gap)
    list.classList.add("be-hidden");
    if (doneSection) doneSection.classList.add("be-done-top");
    if (title) title.remove();
  }
}

/** FLIP: when a task moves, tasks and group headers shift smoothly */
export function flipMove(slide: HTMLElement, mutate: () => void): void {
  const els = Array.from(
    slide.querySelectorAll<HTMLElement>(
      // Exclude the flying clone — it has its own animation and must not be
      // pulled by the layout shift
      ".be-task:not(.be-task-clone), .be-day-group-title, .be-day-active-title, .be-day-done-title, .be-day-done-bar"
    )
  );
  const before = new Map<HTMLElement, number>();
  for (const el of els) {
    if (!el.isConnected) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue; // hidden — skip
    before.set(el, r.top);
  }

  mutate();

  // The active-task list is hidden — Done takes its place: the divider bar
  // travels with Done and fades out at the end of the FLIP
  const list = slide.querySelector(".be-day-list") as HTMLElement | null;
  const listHidden = !!list && list.classList.contains("be-hidden");

  for (const el of els) {
    if (!el.isConnected) continue;
    const beforeTop = before.get(el);
    if (beforeTop === undefined) continue; // was hidden — appears on its own (fade)
    const after = el.getBoundingClientRect().top;
    const dy = beforeTop - after;
    const isBar = el.classList.contains("be-day-done-bar");
    if (dy === 0 && !(listHidden && isBar)) continue;
    // Constant speed: duration proportional to distance
    const duration = Math.min(1500, Math.max(220, Math.abs(dy) / 0.35));
    const anim = el.animate(
      listHidden && isBar
        ? // The bar fades out before it reaches the header's line, so the two
          // lines never overlap into a thick one
          [
            { transform: `translateY(${dy}px)`, opacity: 1, offset: 0 },
            { transform: `translateY(${dy * 0.15}px)`, opacity: 0, offset: 0.85 },
            { transform: "translateY(0px)", opacity: 0, offset: 1 },
          ]
        : [
            { transform: `translateY(${dy}px)` },
            { transform: "translateY(0px)" },
          ],
      { duration, easing: "cubic-bezier(0.25, 0.1, 0.25, 1)" }
    );
    if (listHidden && isBar) anim.onfinish = () => el.remove();
  }
}

export function applyTaskToggled(
  view: ViewHost,
  row: HTMLElement,
  box: HTMLElement | null,
  t: ParsedTask
): void {
  t.checked = !t.checked;
  row.classList.toggle("is-done", t.checked);
  if (box) box.classList.toggle("is-checked", t.checked);
  const slide = row.closest(".be-day-slide, .be-day-card") as HTMLElement | null;

  const mutate = (): void => {
    const esc = t.filePath.replace(/"/g, '\\"');
    if (slide && t.checked) {
      const activeGroup = row.closest(".be-day-group") as HTMLElement | null;
      const doneList = slide.querySelector(".be-day-done-list") as HTMLElement | null;
      if (doneList) {
        let doneGroup = doneList.querySelector<HTMLElement>(".be-day-group[data-file=\"" + esc + "\"]");
        const isLastInGroup =
          !!activeGroup &&
          activeGroup.querySelector(".be-day-group-tasks")?.childElementCount === 1;

        if (!doneGroup && activeGroup && isLastInGroup) {
          // The whole group (header + task) moves to Done as one block
          doneList.appendChild(activeGroup);
          ensureDoneVisible(slide);
        } else {
          if (!doneGroup) {
            doneGroup = createTaskGroup(view, doneList, t.filePath, slide?.dataset.key);
            const createdTitle = doneGroup.querySelector(".be-day-group-title") as HTMLElement | null;
            if (createdTitle) {
              fadeIn(createdTitle, 260);
            }
          }
          const dTasksEl = doneGroup.querySelector(".be-day-group-tasks") as HTMLElement | null;
          if (activeGroup && isLastInGroup) {
            // Last task of the group: merging the header separately and then
            // lifting the list in a second FLIP caused a visible double step
            // (the group rose part-way, paused, then jumped). Move the whole
            // group into Done and remove the empty active group inside this
            // single FLIP, so the list lifts once, smoothly.
            const aTasksEl = activeGroup.querySelector(".be-day-group-tasks") as HTMLElement | null;
            if (aTasksEl) {
              for (const child of Array.from(aTasksEl.children)) dTasksEl?.appendChild(child);
            }
            activeGroup.remove();
          } else {
            dTasksEl?.appendChild(row);
          }
          ensureDoneVisible(slide);
        }
      } else {
        row.parentElement?.appendChild(row);
      }
      syncActiveSection(slide);
    } else if (slide && !t.checked) {
      // Return to active: into its note's group at the original position
      const doneGroup = row.closest(".be-day-group") as HTMLElement | null;
      const doneGroupTop = doneGroup ? doneGroup.getBoundingClientRect().top : 0;
      const activeList = slide.querySelector(".be-day-list") as HTMLElement | null;
      if (activeList) {
        let group = activeList.querySelector<HTMLElement>(".be-day-group[data-file=\"" + esc + "\"]");
        let createdGroup = false;
        if (!group) {
          group = createTaskGroup(view, activeList, t.filePath, slide?.dataset.key);
          // Insert the group alphabetically by note name
          const groups = Array.from(activeList.querySelectorAll<HTMLElement>(".be-day-group"));
          let before: HTMLElement | null = null;
          for (const g of groups) {
            if ((g.dataset.file || "").localeCompare(t.filePath) > 0) {
              before = g;
              break;
            }
          }
          activeList.insertBefore(group, before);
          createdGroup = true;
        }
        const tasksEl = group.querySelector(".be-day-group-tasks") as HTMLElement | null;
        if (tasksEl) {
          let insertBefore: HTMLElement | null = null;
          for (const child of Array.from(tasksEl.children) as HTMLElement[]) {
            const line = parseInt(child.dataset.taskKey?.split(":")[1] ?? "999999", 10);
            if (line > t.line) {
              insertBefore = child;
              break;
            }
          }
          tasksEl.insertBefore(row, insertBefore);
        }
        // Remove the note's Done group if it became empty (first, so the layout
        // stabilizes and the header "arrival" is precise)
        if (doneGroup) {
          const dgTasks = doneGroup.querySelector(".be-day-group-tasks");
          if (dgTasks && dgTasks.childElementCount === 0) doneGroup.remove();
        }
        const doneSection = slide.querySelector(".be-day-done-section") as HTMLElement | null;
        const doneList = slide.querySelector(".be-day-done-list") as HTMLElement | null;
        if (doneSection && doneList && doneList.childElementCount === 0) {
          doneSection.addClass("is-empty");
        }
        // The new group's header "flies in" from the Done group's position
        if (createdGroup) {
          const title = group.querySelector(".be-day-group-title") as HTMLElement | null;
          const to = group.getBoundingClientRect().top;
          const from = doneGroupTop || to + 40;
          const dy = to - from;
          if (title && dy !== 0) {
            // Constant speed: duration proportional to distance
            const duration = Math.min(1500, Math.max(220, Math.abs(dy) / 0.35));
            title.style.transform = `translateY(${-dy}px)`;
            void title.offsetWidth; // reflow
            title.animate(
              [
                { transform: `translateY(${-dy}px)`, opacity: 0 },
                { transform: "translateY(0)", opacity: 1 },
              ],
              { duration, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "both" }
            ).onfinish = () => {
              title.style.removeProperty("opacity");
              title.style.removeProperty("transform");
            };
          }
        }
      } else {
        row.parentElement?.appendChild(row);
      }
      syncActiveSection(slide);
    } else {
      row.parentElement?.appendChild(row);
    }
  };

  if (slide) {
    if (t.checked) {
      // First a visible strikethrough, then a pause, then the flight to Done
      window.setTimeout(() => flipMove(slide, mutate), 600);
    } else {
      flipMove(slide, mutate);
    }
  } else {
    mutate();
  }
}
