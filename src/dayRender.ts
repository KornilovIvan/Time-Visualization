import { formatDate } from "./parser";
import {
  MONTHS_EN,
  WEEKDAYS_FULL_EN,
  WEEKDAYS_SHORT_EN,
  isoWeekNumber,
} from "./dates";
import type { ViewHost } from "./viewHost";
import {
  buildCollapsedGroup,
  fillGroup,
  groupTasksByFile,
  sortedGroups,
} from "./taskRow";
import { showDayPriorityMenu } from "./menus";

/** Week slide: 7 day columns with tasks */
export function fillWeekSlide(view: ViewHost, slide: HTMLElement, monday: Date): void {
  slide.dataset.key = formatDate(monday);
  slide.empty();
  const frag = document.createDocumentFragment();
  const todayKey = formatDate(new Date());

  for (let i = 0; i < 7; i++) {
    const day = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    const key = formatDate(day);
    const isToday = key === todayKey;

    const card = frag.appendChild(createDiv());
    // Only the real today gets the outline — the same weekday exists in every week
    card.className = "tv-day-card" + (isToday ? " is-today" : "");
    const head = card.createDiv({ cls: "tv-day-head" });
    head.createSpan({ cls: "tv-day-weekday", text: WEEKDAYS_SHORT_EN[i] });
    head.createSpan({ cls: "tv-day-num", text: String(day.getDate()) });
    head.createSpan({
      cls: "tv-week-month",
      text: `${MONTHS_EN[day.getMonth()].slice(0, 3)} ${day.getFullYear()}`,
    });

    fillDayBody(view, card, day, true);
    card.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).closest(".tv-task")) return;
      if (view.isSelectionClick(ev)) return;
      view.cursor = day;
      view.setLevel("day");
    });
  }

  slide.appendChild(frag);
}

/** Month slide: title + grid of day cards */
export function fillMonthSlide(view: ViewHost, slide: HTMLElement, first: Date): void {
  slide.dataset.key = `${first.getFullYear()}-${first.getMonth()}`;
  slide.empty();

  const y = first.getFullYear();
  const m = first.getMonth();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const startOffset = (first.getDay() + 6) % 7; // Monday = 0
  const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;
  const todayKey = formatDate(new Date());

  // Top row: "W" over the week column, month name over the day grid (same line)
  const top = slide.createDiv({ cls: "tv-month-top" });
  top.createDiv({ cls: "tv-month-week-label", text: "W" });
  top.createDiv({ cls: "tv-month-title", text: `${MONTHS_EN[m]} ${y}` });

  const body = slide.createDiv({ cls: "tv-month-body" });

  // Left column with ISO week numbers, one per grid row (like regular calendars)
  const weeks = body.createDiv({ cls: "tv-month-weeks" });
  const weekCount = totalCells / 7;
  for (let k = 0; k < weekCount; k++) {
    const monday = new Date(y, m, k * 7 - startOffset + 1);
    weeks.createDiv({ cls: "tv-month-week-num", text: String(isoWeekNumber(monday)) });
  }

  const grid = body.createDiv({ cls: "tv-month-grid" });

  const frag = document.createDocumentFragment();
  for (let i = 0; i < totalCells; i++) {
    const day = new Date(y, m, i - startOffset + 1);
    const inMonth = day.getMonth() === m;
    const key = formatDate(day);
    const isToday = key === todayKey;

    // Cell is a full day card, so FLIP/grouping/sections work like in day and week
    const cell = frag.appendChild(createDiv());
    cell.className =
      "tv-month-cell tv-day-card" +
      (inMonth ? "" : " is-out") +
      (isToday ? " is-today" : "");
    cell.dataset.key = key;

    const head = cell.createDiv({ cls: "tv-day-head" });
    head.createSpan({ cls: "tv-day-weekday", text: WEEKDAYS_SHORT_EN[i % 7] });
    head.createSpan({ cls: "tv-day-num", text: String(day.getDate()) });

    // Only past days are collapsed (tasks built on click); today/future stay expanded
    const isPast = key < todayKey;
    fillDayBody(view, cell, day, true, isPast);

    cell.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).closest(".tv-task")) return;
      if (view.isSelectionClick(ev)) return;
      view.cursor = day;
      view.setLevel("day");
    });
  }
  grid.appendChild(frag);
}

export function fillDayCard(view: ViewHost, card: HTMLElement, day: Date): void {
  card.dataset.key = formatDate(day);
  card.empty();

  const head = card.createDiv({ cls: "tv-day-head" });
  head.createSpan({ cls: "tv-day-weekday", text: WEEKDAYS_FULL_EN[(day.getDay() + 6) % 7] });
  const numGroup = head.createSpan({ cls: "tv-day-num-group" });
  numGroup.createSpan({ cls: "tv-day-num tv-day-num-big", text: String(day.getDate()) });
  numGroup.createSpan({
    cls: "tv-day-month",
    text: `${MONTHS_EN[day.getMonth()]} ${day.getFullYear()}`,
  });
  // Priority/reorder button in the day header (shown on hover over the header)
  const prioBtn = head.createEl("button", {
    cls: "tv-day-priority",
    attr: { "aria-label": "Reorder group priorities" },
  });
  prioBtn.setText("Priority");
  head.addEventListener("mouseenter", () => prioBtn.addClass("is-show"));
  head.addEventListener("mouseleave", () => prioBtn.removeClass("is-show"));
  prioBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    e.preventDefault();
    showDayPriorityMenu(view, prioBtn, formatDate(day));
  });

  fillDayBody(view, card, day, false);
}

/** Shared day-card body: active-task list + done section. compact — smaller
    sizes/fonts; collapsible — month mode: note groups are collapsed (lazy). */
export function fillDayBody(
  view: ViewHost,
  card: HTMLElement,
  day: Date,
  compact: boolean,
  collapsible = false
): void {
  const key = formatDate(day);
  const tasks = view.index.getTasks(key);
  const active = tasks.filter((t) => !t.checked);
  const done = tasks.filter((t) => t.checked);

  const list = card.createDiv({ cls: "tv-day-list" });
  if (active.length === 0) {
    list.classList.add("tv-hidden");
  } else {
    list.createDiv({ cls: "tv-day-active-title", text: "Open tasks" });
    for (const g of sortedGroups(view, active, key)) {
      // null timed = merged adjacent buckets — one header, no data-timed marker
      const bucket = g.timed === null ? undefined : g.timed;
      if (collapsible) buildCollapsedGroup(view, list, g.tasks, g.path, key, compact, "active", bucket);
      else fillGroup(view, list, g.tasks, g.path, key, compact, bucket);
    }
  }

  const doneSection = card.createDiv({
    cls: "tv-day-done-section" + (done.length === 0 ? " is-empty" : ""),
  });
  if (active.length > 0) doneSection.createDiv({ cls: "tv-day-done-bar" });
  doneSection.createDiv({ cls: "tv-day-done-title", text: "Done" });
  const doneList = doneSection.createDiv({ cls: "tv-day-done-list" });
  if (done.length > 0) {
    for (const [path, gt] of groupTasksByFile(done)) {
      if (collapsible) buildCollapsedGroup(view, doneList, gt, path, key, compact, "done");
      else fillGroup(view, doneList, gt, path, key, compact);
    }
  }
}
