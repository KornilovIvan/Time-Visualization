import {
  ItemView,
  WorkspaceLeaf,
  TFile,
  setIcon,
} from "obsidian";
import type TimeVisualizationPlugin from "./main";
import { TaskIndex } from "./taskIndex";
import { ParsedTask, formatDate, parseDate, startOfDay } from "./parser";

export const VIEW_TYPE = "time-visualization-view";

export type Level = "day" | "week" | "month";

const MONTHS_EN = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const WEEKDAYS_SHORT_EN = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAYS_FULL_EN = [
  "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday",
];

/** Per-level carousel metadata: DOM classes, movement axis, sizes, cursor shift, slide filling */
interface CarouselMeta {
  paneCls: string;
  focusCls: string;
  trackCls: string;
  slideCls: string;
  axis: "x" | "y";
  slideRatio: number;
  duration: number;
  lazyNeighbors: boolean;
  keyOf: (d: Date) => string;
  advance: (d: Date, dir: 1 | -1) => Date;
  fill: (slide: HTMLElement, key: string) => void;
}

export class TimeVisualizationView extends ItemView {
  plugin: TimeVisualizationPlugin;
  index: TaskIndex;

  level: Level = "day";
  /** Selected date (local start of day) */
  cursor: Date = startOfDay(new Date());

  private root: HTMLElement | null = null;
  private headerEl: HTMLElement | null = null;
  private stageEl: HTMLElement | null = null;
  private debounceTimer: number | null = null;
  private track: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private carouselAnim: Animation | null = null;
  /** Suppress re-render after our own task toggle (avoids flicker) */
  private suppressRender = false;
  private suppressTimer: number | null = null;
  private taskRefs = new Map<string, ParsedTask>();
  private editingTaskKey: string | null = null;
  private taskMenu: HTMLElement | null = null;
  /** Button that opened the current menu (to toggle it closed on re-click) */
  private taskMenuAnchor: HTMLElement | null = null;
  /** A click that just closed the task menu must not toggle a task */
  private menuJustClosed = false;

  constructor(leaf: WorkspaceLeaf, plugin: TimeVisualizationPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.index = new TaskIndex(plugin);
  }

  getViewType(): string {
    return VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Time Visualization";
  }

  getIcon(): string {
    return "calendar-days";
  }

  async onOpen(): Promise<void> {
    await this.index.refresh();
    this.buildUI();
    this.registerEvent(
      this.app.vault.on("modify", (file) => this.onFileChanged(file.path))
    );
    this.registerEvent(
      this.app.vault.on("create", (file) => this.onFileChanged(file.path))
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => this.onFileChanged(file.path))
    );
  }

  onClose(): Promise<void> {
    if (this.suppressTimer !== null) window.clearTimeout(this.suppressTimer);
    if (this.carouselAnim) {
      this.carouselAnim.cancel();
      this.carouselAnim = null;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    return Promise.resolve();
  }

  /** Rebuild the index with new settings and re-render (from the settings tab) */
  async refresh(): Promise<void> {
    try {
      await this.index.refresh();
    } catch (e) {
      console.error("Time Visualization: index refresh failed", e);
    }
    this.render();
  }

  private onFileChanged(path: string): void {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(async () => {
      try {
        await this.index.updateFile(path);
      } catch (e) {
        console.error("Time Visualization: file update failed:", path, e);
        return;
      }
      if (this.suppressRender) return;
      if (!this.fileAffectsView(path)) return;
      // Refill the active level's slides in place (without recreating the track)
      if (this.track) {
        const meta = this.currentMeta;
        const slides = Array.from(this.track.querySelectorAll<HTMLElement>("." + meta.slideCls));
        for (const slide of slides) {
          const key = slide.dataset.key;
          if (key) meta.fill(slide, key);
        }
      } else {
        this.render();
      }
    }, 150);
  }

  /** Dates (YYYY-MM-DD) visible on the current level */
  private visibleDates(): Set<string> {
    const set = new Set<string>();
    if (this.level === "day") {
      set.add(formatDate(this.cursor));
    } else if (this.level === "week") {
      const monday = startOfWeek(this.cursor);
      for (let i = 0; i < 7; i++) {
        set.add(formatDate(addDays(monday, i)));
      }
    } else {
      // Whole visible month slide, incl. neighbor-month tails
      const y = this.cursor.getFullYear();
      const m = this.cursor.getMonth();
      const first = new Date(y, m, 1);
      const daysInMonth = new Date(y, m + 1, 0).getDate();
      const startOffset = (first.getDay() + 6) % 7;
      const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;
      for (let i = 0; i < totalCells; i++) {
        set.add(formatDate(new Date(y, m, i - startOffset + 1)));
      }
    }
    return set;
  }

  private fileAffectsView(filePath: string): boolean {
    const dates = this.visibleDates();
    const tasks = this.index.getFileTasks(filePath);
    return tasks.some((t) => !!t.date && dates.has(t.date));
  }

  /** Is this view currently active */
  isActive(): boolean {
    return this.app.workspace.getActiveViewOfType(TimeVisualizationView) === this;
  }

  /** Focus is inside an editable field — do not intercept keys */
  isTypingTarget(evt: KeyboardEvent): boolean {
    const t = evt.target as HTMLElement | null;
    if (!t) return false;
    if (
      t.tagName === "TEXTAREA" ||
      t.tagName === "INPUT" ||
      t.tagName === "SELECT" ||
      t.isContentEditable
    ) {
      return true;
    }
    if (t.closest(".cm-content, .cm-editor, .cm-line, .markdown-source-view")) {
      return true;
    }
    return false;
  }

  /** Navigation key handling, called from the plugin */
  handleKey(evt: KeyboardEvent): void {
    if (!this.isActive() || this.isTypingTarget(evt)) return;
    switch (evt.key) {
      case "ArrowLeft":
        evt.preventDefault();
        this.navigate(-1);
        break;
      case "ArrowRight":
        evt.preventDefault();
        this.navigate(1);
        break;
      case "ArrowUp":
        evt.preventDefault();
        this.navigate(-1);
        break;
      case "ArrowDown":
        evt.preventDefault();
        this.navigate(1);
        break;
    }
  }

  setLevel(level: Level, resetToToday = false): void {
    if (this.level === level) return;
    if (resetToToday) this.cursor = startOfDay(new Date());
    this.level = level;
    this.render();
  }

  navigate(dir: 1 | -1): void {
    this.carouselStep(dir, this.currentMeta);
  }

  goToday(): void {
    const now = startOfDay(new Date());
    if (formatDate(this.cursor) === formatDate(now)) return;
    this.cursor = now;
    this.render();
  }

  private buildUI(): void {
    this.root = this.contentEl.createDiv({ cls: "be-root" });
    this.root.tabIndex = -1;
    this.headerEl = this.root.createDiv({ cls: "be-header" });
    this.buildHeader(this.headerEl);
    this.stageEl = this.root.createDiv({ cls: "be-stage" });
    this.render();
  }

  /** Task click handler at document level (the most reliable way) */
  onDocumentClick(e: MouseEvent): void {
    if (this.editingTaskKey) return;
    // The click that just closed the task menu should only close it — it must
    // not toggle a task underneath
    if (this.menuJustClosed) {
      this.menuJustClosed = false;
      return;
    }
    const taskEl = (e.target as HTMLElement).closest(".be-task") as HTMLElement | null;
    if (!taskEl) return;
    if (taskEl.classList.contains("is-editing")) return;
    const key = taskEl.dataset.taskKey;
    if (!key) return;
    const t = this.taskRefs.get(key);
    if (!t) return;
    e.stopPropagation();
    e.preventDefault();
    const box = taskEl.querySelector(".be-task-box") as HTMLElement | null;
    this.applyTaskToggled(taskEl, box, t);
    // The file write runs in parallel; the modify event must not re-render mid-animation
    this.suppressRerender(3000);
    void this.index.toggleTask(t).catch(() => {
      this.applyTaskToggled(taskEl, box, t);
    });
  }

  /** Suppress re-render from file changes (own toggle/move); the timer restarts
      on each call, so rapid clicks never trigger a full render mid-animation */
  private suppressRerender(ms: number): void {
    this.suppressRender = true;
    if (this.suppressTimer !== null) window.clearTimeout(this.suppressTimer);
    this.suppressTimer = window.setTimeout(() => {
      this.suppressRender = false;
      this.suppressTimer = null;
    }, ms);
  }

  private render(): void {
    if (!this.root || !this.stageEl) return;
    this.taskRefs.clear();

    // Update the active level button without recreating the header
    this.headerEl?.querySelectorAll<HTMLElement>(".be-level").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.level === this.level);
    });

    this.stageEl.empty();
    const body = this.stageEl.createDiv({ cls: "be-body" });
    this.renderCarousel(body, this.currentMeta);

    body.animate(
      [{ opacity: 0.3 }, { opacity: 1 }],
      { duration: 160, easing: "ease-out" }
    );
  }

  private buildHeader(header: HTMLElement): void {
    const controls = header.createDiv({ cls: "be-controls" });

    const nav = controls.createDiv({ cls: "be-nav" });
    const btnPrev = nav.createEl("button", { cls: "be-btn", attr: { "aria-label": "Previous" } });
    setIcon(btnPrev, "chevron-left");
    btnPrev.addEventListener("click", () => this.navigate(-1));

    const btnToday = nav.createEl("button", { cls: "be-btn be-today", text: "Today" });
    btnToday.addEventListener("click", () => this.goToday());

    const btnNext = nav.createEl("button", { cls: "be-btn", attr: { "aria-label": "Next" } });
    setIcon(btnNext, "chevron-right");
    btnNext.addEventListener("click", () => this.navigate(1));

    const levels = controls.createDiv({ cls: "be-levels" });
    const defs: Array<[Level, string]> = [
      ["day", "Day"],
      ["week", "Week"],
      ["month", "Month"],
    ];
    for (const [lv, label] of defs) {
      const b = levels.createEl("button", {
        cls: "be-level" + (this.level === lv ? " is-active" : ""),
        text: label,
        attr: { "data-level": lv },
      });
      b.addEventListener("click", () => this.setLevel(lv, true));
    }

    const settingsBtn = controls.createEl("button", {
      cls: "be-btn be-settings",
      attr: { "aria-label": "Settings" },
    });
    setIcon(settingsBtn, "settings");
    settingsBtn.addEventListener("click", () => {
      // app.setting is missing from the obsidian.d.ts types but exists at runtime
      const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
      setting?.open();
      setting?.openTabById(this.plugin.manifest.id);
    });
  }

  /** Metadata of the active level: classes, axis, sizes, cursor shift, slide filling */
  private get currentMeta(): CarouselMeta {
    if (this.level === "day") {
      return {
        paneCls: "be-day",
        focusCls: "be-day-focus",
        trackCls: "be-day-track",
        slideCls: "be-day-slide",
        axis: "x",
        slideRatio: 0.93,
        duration: 240,
        lazyNeighbors: false,
        keyOf: (d) => formatDate(d),
        advance: (d, dir) => addDays(d, dir),
        fill: (slide, key) => this.fillDayCard(slide, parseDate(key)),
      };
    }
    if (this.level === "week") {
      return {
        paneCls: "be-week",
        focusCls: "be-week-focus",
        trackCls: "be-week-track",
        slideCls: "be-week-slide",
        axis: "y",
        slideRatio: 0.9,
        duration: 380,
        lazyNeighbors: false,
        keyOf: (d) => formatDate(startOfWeek(d)),
        advance: (d, dir) => addDays(d, dir * 7),
        fill: (slide, key) => this.fillWeekSlide(slide, parseDate(key)),
      };
    }
    return {
      paneCls: "be-month",
      focusCls: "be-month-focus",
      trackCls: "be-month-track",
      slideCls: "be-month-slide",
      axis: "y",
      slideRatio: 1,
      duration: 380,
      // Month fills neighbor slides lazily in rAF — faster opening
      lazyNeighbors: true,
      keyOf: (d) => `${d.getFullYear()}-${d.getMonth()}`,
      advance: (d, dir) => new Date(d.getFullYear(), d.getMonth() + dir, 1),
      fill: (slide, key) => {
        const [yy, mm] = key.split("-").map(Number);
        if (Number.isFinite(yy) && Number.isFinite(mm)) this.fillMonthSlide(slide, new Date(yy, mm, 1));
      },
    };
  }

  private buildSlide(d: Date, meta: CarouselMeta): HTMLElement {
    const slide = createDiv();
    slide.className = meta.slideCls;
    meta.fill(slide, meta.keyOf(d));
    return slide;
  }

  /** Shared level frame: pane > focus > track + three slides (prev/current/next).
      Weeks/months scroll vertically, days horizontally. */
  private renderCarousel(body: HTMLElement, meta: CarouselMeta): void {
    const pane = body.createDiv({ cls: meta.paneCls });
    const focus = pane.createDiv({ cls: meta.focusCls });
    const track = focus.createDiv({ cls: meta.trackCls });
    this.track = track;

    const cur = this.cursor;
    const slidePrev = createDiv();
    slidePrev.className = meta.slideCls;
    const slideCur = this.buildSlide(cur, meta);
    const slideNext = createDiv();
    slideNext.className = meta.slideCls;
    track.appendChild(slidePrev);
    track.appendChild(slideCur);
    track.appendChild(slideNext);

    const fillNeighbors = (): void => {
      meta.fill(slidePrev, meta.keyOf(meta.advance(cur, -1)));
      meta.fill(slideNext, meta.keyOf(meta.advance(cur, 1)));
    };
    if (!meta.lazyNeighbors) fillNeighbors();

    window.requestAnimationFrame(() => {
      if (!track.isConnected) return;
      if (meta.lazyNeighbors) fillNeighbors();
      this.resetTrack(track, meta);
    });

    this.resizeObserver?.disconnect();
    this.resizeObserver = new ResizeObserver(() => {
      if (this.track && this.track.isConnected) this.resetTrack(this.track, meta);
    });
    this.resizeObserver.observe(focus);
  }

  /** Week slide: 7 day columns with tasks */
  private fillWeekSlide(slide: HTMLElement, monday: Date): void {
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
      card.className = "be-day-card" + (isToday ? " is-today" : "");
      const head = card.createDiv({ cls: "be-day-head" });
      head.createSpan({ cls: "be-day-weekday", text: WEEKDAYS_SHORT_EN[i] });
      head.createSpan({ cls: "be-day-num", text: String(day.getDate()) });
      head.createSpan({
        cls: "be-week-month",
        text: `${MONTHS_EN[day.getMonth()].slice(0, 3)} ${day.getFullYear()}`,
      });

      this.fillDayBody(card, day, true);
      card.addEventListener("click", (ev) => {
        if ((ev.target as HTMLElement).closest(".be-task")) return;
        this.cursor = day;
        this.setLevel("day");
      });
    }

    slide.appendChild(frag);
  }

  /** Month slide: title + grid of day cards */
  private fillMonthSlide(slide: HTMLElement, first: Date): void {
    slide.dataset.key = `${first.getFullYear()}-${first.getMonth()}`;
    slide.empty();

    const y = first.getFullYear();
    const m = first.getMonth();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const startOffset = (first.getDay() + 6) % 7; // Monday = 0
    const totalCells = Math.ceil((startOffset + daysInMonth) / 7) * 7;
    const todayKey = formatDate(new Date());

    slide.createDiv({ cls: "be-month-title", text: `${MONTHS_EN[m]} ${y}` });

    const grid = slide.createDiv({ cls: "be-month-grid" });

    const frag = document.createDocumentFragment();
    for (let i = 0; i < totalCells; i++) {
      const day = new Date(y, m, i - startOffset + 1);
      const inMonth = day.getMonth() === m;
      const key = formatDate(day);
      const isToday = key === todayKey;

      // Cell is a full day card, so FLIP/grouping/sections work like in day and week
      const cell = frag.appendChild(createDiv());
      cell.className =
        "be-month-cell be-day-card" +
        (inMonth ? "" : " is-out") +
        (isToday ? " is-today" : "");
      cell.dataset.key = key;

      const head = cell.createDiv({ cls: "be-day-head" });
      head.createSpan({ cls: "be-day-weekday", text: WEEKDAYS_SHORT_EN[i % 7] });
      head.createSpan({ cls: "be-day-num", text: String(day.getDate()) });

      // Only past days are collapsed (tasks built on click); today/future stay expanded
      const isPast = key < todayKey;
      this.fillDayBody(cell, day, true, isPast);

      cell.addEventListener("click", (ev) => {
        if ((ev.target as HTMLElement).closest(".be-task")) return;
        this.cursor = day;
        this.setLevel("day");
      });
    }
    grid.appendChild(frag);
  }

  private fillDayCard(card: HTMLElement, day: Date): void {
    card.dataset.key = formatDate(day);
    card.empty();

    const head = card.createDiv({ cls: "be-day-head" });
    head.createSpan({ cls: "be-day-weekday", text: WEEKDAYS_FULL_EN[(day.getDay() + 6) % 7] });
    const numGroup = head.createSpan({ cls: "be-day-num-group" });
    numGroup.createSpan({ cls: "be-day-num be-day-num-big", text: String(day.getDate()) });
    numGroup.createSpan({
      cls: "be-day-month",
      text: `${MONTHS_EN[day.getMonth()]} ${day.getFullYear()}`,
    });

    this.fillDayBody(card, day, false);
  }

  /** Shared day-card body: active-task list + done section. compact — smaller
      sizes/fonts; collapsible — month mode: note groups are collapsed (lazy). */
  private fillDayBody(card: HTMLElement, day: Date, compact: boolean, collapsible = false): void {
    const key = formatDate(day);
    const tasks = this.index.getTasks(key);
    const active = tasks.filter((t) => !t.checked);
    const done = tasks.filter((t) => t.checked);

    const list = card.createDiv({ cls: "be-day-list" });
    if (active.length === 0) {
      list.classList.add("be-hidden");
    } else {
      list.createDiv({ cls: "be-day-active-title", text: "Open tasks" });
      for (const [path, gt] of this.groupTasksByFile(active)) {
        if (collapsible) this.buildCollapsedGroup(list, gt, path, key, compact, "active");
        else this.fillGroup(list, gt, path, key, compact);
      }
    }

    const doneSection = card.createDiv({
      cls: "be-day-done-section" + (done.length === 0 ? " is-empty" : ""),
    });
    if (active.length > 0) doneSection.createDiv({ cls: "be-day-done-bar" });
    doneSection.createDiv({ cls: "be-day-done-title", text: "Done" });
    const doneList = doneSection.createDiv({ cls: "be-day-done-list" });
    if (done.length > 0) {
      for (const [path, gt] of this.groupTasksByFile(done)) {
        if (collapsible) this.buildCollapsedGroup(doneList, gt, path, key, compact, "done");
        else this.fillGroup(doneList, gt, path, key, compact);
      }
    }
  }

  private groupTasksByFile(tasks: ParsedTask[]): Map<string, ParsedTask[]> {
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

  private createTaskGroup(container: HTMLElement, path: string, dayKey?: string): HTMLElement {
    const group = container.createDiv({ cls: "be-day-group" });
    group.dataset.file = path;
    this.makeGroupTitle(group, path, dayKey);
    group.createDiv({ cls: "be-day-group-tasks" });
    return group;
  }

  private fillGroup(
    container: HTMLElement,
    tasks: ParsedTask[],
    path: string,
    key: string,
    compact: boolean
  ): void {
    const group = this.createTaskGroup(container, path, key);
    const gl = group.querySelector(".be-day-group-tasks") as HTMLElement;
    for (const t of tasks) gl.appendChild(this.buildTaskRow(t, compact));
  }

  /** Collapsed note group (month): header + counter + chevron. Tasks are built
      only after a click (lazy) and re-read from the index on expand. */
  private buildCollapsedGroup(
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

    this.attachNoteLink(name, path);

    group.addEventListener("click", (ev) => {
      if ((ev.target as HTMLElement).closest(".be-task")) return;
      ev.stopPropagation();
      const collapsed = group.classList.toggle("is-collapsed");
      gl.empty();
      if (!collapsed) {
        const dayKey = group.dataset.day ?? key;
        const fPath = group.dataset.file ?? path;
        const sec = (group.dataset.section as "active" | "done") ?? section;
        const fresh = this.index
          .getTasks(dayKey)
          .filter((t) => t.filePath === fPath && (sec === "done" ? t.checked : !t.checked));
        for (const t of fresh) gl.appendChild(this.buildTaskRow(t, compact));
      }
    });

    return group;
  }

  /** Centers the track. The base is the same for all levels — the second
      slide's center (1.5×slide) meets the focus center (0.5×focus):
      −0.895w for day, −0.85h for week, −h for month. */
  private resetTrack(track: HTMLElement, meta: CarouselMeta): void {
    if (this.carouselAnim) {
      this.carouselAnim.cancel();
      this.carouselAnim = null;
    }
    const focus = track.parentElement;
    if (!focus) return;
    const focusSize = meta.axis === "x" ? focus.clientWidth : focus.clientHeight;
    if (!focusSize) return;
    const slideSize = meta.slideRatio * focusSize;
    for (const slide of Array.from(track.children) as HTMLElement[]) {
      slide.classList.add("be-no-grow");
      if (meta.axis === "x") slide.style.width = `${slideSize}px`;
      else slide.style.height = `${slideSize}px`;
    }
    const base = -(1.5 * slideSize - 0.5 * focusSize);
    track.style.transform = meta.axis === "x" ? `translateX(${base}px)` : `translateY(${base}px)`;
    void (meta.axis === "x" ? track.offsetWidth : track.offsetHeight); // reflow
  }

  /** Carousel step with a scroll animation. On cancel (fast paging) the track
      returns to the base — it never sticks or overlaps. */
  private carouselStep(dir: 1 | -1, meta: CarouselMeta): void {
    const track = this.track;
    if (!track) return;
    const focus = track.parentElement;
    if (!focus) return;
    const focusSize = meta.axis === "x" ? focus.clientWidth : focus.clientHeight;
    if (!focusSize) return;

    this.cursor = meta.advance(this.cursor, dir);

    // Reuse the slides, updating their content
    const slides = Array.from(track.children) as HTMLElement[];
    if (slides.length === 3) {
      meta.fill(slides[0], meta.keyOf(meta.advance(this.cursor, -1)));
      meta.fill(slides[1], meta.keyOf(this.cursor));
      meta.fill(slides[2], meta.keyOf(meta.advance(this.cursor, 1)));
    } else {
      track.replaceChildren(
        this.buildSlide(meta.advance(this.cursor, -1), meta),
        this.buildSlide(this.cursor, meta),
        this.buildSlide(meta.advance(this.cursor, 1), meta)
      );
    }

    const slideSize = meta.slideRatio * focusSize;
    for (const slide of Array.from(track.children) as HTMLElement[]) {
      slide.classList.add("be-no-grow");
      if (meta.axis === "x") slide.style.width = `${slideSize}px`;
      else slide.style.height = `${slideSize}px`;
    }
    const base = -(1.5 * slideSize - 0.5 * focusSize);
    const start = base + (dir === 1 ? slideSize : -slideSize);
    const translate = meta.axis === "x" ? "translateX" : "translateY";

    if (this.carouselAnim) {
      this.carouselAnim.cancel();
      this.carouselAnim = null;
      track.style.transform = `${translate}(${base}px)`;
    }

    track.style.transform = `${translate}(${start}px)`;
    void (meta.axis === "x" ? track.offsetWidth : track.offsetHeight); // reflow

    const anim = track.animate(
      [
        { transform: `${translate}(${start}px)` },
        { transform: `${translate}(${base}px)` },
      ],
      { duration: meta.duration, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }
    );
    anim.onfinish = () => {
      track.style.transform = `${translate}(${base}px)`;
    };
    this.carouselAnim = anim;
  }

  private buildTaskRow(t: ParsedTask, compact: boolean): HTMLElement {
    const row = createDiv();
    row.className = "be-task" + (t.checked ? " is-done" : "");

    const box = row.createEl("button", {
      cls: "be-task-box" + (t.checked ? " is-checked" : ""),
    });
    this.renderCheckbox(box, compact);

    const taskKey = `${t.filePath}:${t.line}`;
    row.dataset.taskKey = taskKey;
    this.taskRefs.set(taskKey, t);

    const text = row.createDiv({ cls: "be-task-text" });
    const textInner = text.createSpan({ cls: "be-task-inner" });
    textInner.setText(t.text);

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
        this.showTaskMenu(menuBtn, row, t);
      });
    }

    return row;
  }

  /** Custom task menu popup (plugin-styled, no system Menu) */
  private showTaskMenu(anchor: HTMLElement, row: HTMLElement, t: ParsedTask): void {
    // Re-click on the same button toggles the menu closed
    if (this.taskMenu && this.taskMenuAnchor === anchor) {
      this.closeTaskMenu();
      return;
    }
    this.closeTaskMenu();
    // Opening a fresh menu — clear the "just closed" guard so the next click
    // on a task is not swallowed
    this.menuJustClosed = false;
    this.taskMenuAnchor = anchor;

    const popup = createDiv();
    popup.className = "be-task-menu-popup";
    const item = popup.createDiv({ cls: "be-task-menu-item" });
    setIcon(item, "pencil");
    item.createSpan({ text: "Edit" });
    item.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.closeTaskMenu();
      this.startEditTask(row, t);
    });

    const itemMove = popup.createDiv({ cls: "be-task-menu-item" });
    setIcon(itemMove, "arrow-right");
    itemMove.createSpan({ text: "Move to next day" });
    itemMove.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this.closeTaskMenu();
      this.moveTaskToNextDay(row, t);
    });

    document.body.appendChild(popup);
    this.taskMenu = popup;

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
      this.menuJustClosed = true;
      this.closeTaskMenu();
      document.removeEventListener("mousedown", close, true);
      document.removeEventListener("wheel", onScroll, true);
    };
    document.addEventListener("mousedown", close, true);

    // Close when the user starts scrolling the task list — the menu must not
    // stay floating over the content
    const onScroll = (): void => {
      this.closeTaskMenu();
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
  private moveTaskToNextDay(row: HTMLElement, t: ParsedTask): void {
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
        this.flipMove(slide, () => {
          row.remove();
          if (group && isLast) group.remove();
          this.syncActiveSection(slide);
        });
      } else {
        row.remove();
      }
      void this.index.moveTask(t, nextKey).catch(() => {
        /* on error the index/render will show the actual state */
      });
    };
    window.setTimeout(lift, 750);

    // Suppress re-render from the file change — otherwise it would cut the animation
    this.suppressRerender(2500);
  }

  private closeTaskMenu(): void {
    if (this.taskMenu) {
      this.taskMenu.remove();
      this.taskMenu = null;
    }
    this.taskMenuAnchor = null;
  }

  /** Inline editing of the task text (day card only).
      Enter — save, Escape — cancel, blur — save. */
  private startEditTask(row: HTMLElement, t: ParsedTask): void {
    const textEl = row.querySelector(".be-task-text") as HTMLElement | null;
    if (!textEl) return;
    const inner = textEl.querySelector(".be-task-inner") as HTMLElement | null;

    row.classList.add("is-editing");
    const taskKey = `${t.filePath}:${t.line}`;
    this.editingTaskKey = taskKey;

    const input = createEl("input");
    input.className = "be-task-edit";
    input.value = t.text;
    row.insertBefore(input, textEl);
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
      this.editingTaskKey = null;
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
        if (inner) inner.setText(v);
        void this.index.updateTaskText(t, v).catch(() => {
          if (inner) inner.setText(t.text); // rollback on error
        });
      }
    };

    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(true, true);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(false, true);
      }
    });
    input.addEventListener("blur", () => finish(true, false));
  }

  private openNote(path: string): void {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      void this.app.workspace.getLeaf("tab").openFile(file);
    }
  }

  private makeGroupTitle(group: HTMLElement, path: string, dayKey?: string): void {
    const title = group.createDiv({ cls: "be-day-group-title" });
    const name = title.createSpan({ cls: "be-day-group-name" });
    name.setText(fileName(path) + ":");
    // "Today" badge for the current day's daily note
    if (dayKey && fileName(path) === dayKey) {
      title.createSpan({ cls: "be-day-group-today", text: "Today" });
    }
    this.attachNoteLink(name, path);
  }

  private attachNoteLink(name: HTMLElement, path: string): void {
    name.addEventListener("click", (e) => {
      e.stopPropagation();
      this.openNote(path);
    });
    name.addEventListener("mouseenter", (e) => {
      const hoverParent = { hoverPopover: null, dom: this.contentEl } as unknown;
      this.app.workspace.trigger("hover-link", {
        event: e,
        source: VIEW_TYPE,
        hoverParent,
        targetEl: name,
        linktext: path.replace(/\.md$/i, ""),
      });
    });
  }

  /** Custom checkbox: the check mark is drawn via a stroke animation */
  private renderCheckbox(box: HTMLElement, compact: boolean): void {
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

  private fadeIn(el: HTMLElement, duration: number): void {
    el.animate(
      [{ opacity: 0 }, { opacity: 1 }],
      { duration, easing: "ease-out", fill: "backwards" }
    );
  }

  private applyTaskToggled(row: HTMLElement, box: HTMLElement | null, t: ParsedTask): void {
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
            this.ensureDoneVisible(slide);
          } else {
            if (!doneGroup) {
              doneGroup = this.createTaskGroup(doneList, t.filePath, slide?.dataset.key);
              const createdTitle = doneGroup.querySelector(".be-day-group-title") as HTMLElement | null;
              if (createdTitle) {
                this.fadeIn(createdTitle, 260);
              }
            }
            const dTasksEl = doneGroup.querySelector(".be-day-group-tasks") as HTMLElement | null;
            dTasksEl?.appendChild(row);
            this.ensureDoneVisible(slide);
            // Last task of the group: the active header flies down and merges
            // with its "twin" in Done
            if (activeGroup && isLastInGroup) {
              const title = activeGroup.querySelector(".be-day-group-title") as HTMLElement | null;
              const doneTitle = doneGroup?.querySelector(".be-day-group-title") as HTMLElement | null;
              const start = title ? title.getBoundingClientRect().top : activeGroup.getBoundingClientRect().top;
              const target = doneTitle ? doneTitle.getBoundingClientRect().top : start + 100;
              const dy = target - start;
              const animEl = title || activeGroup;
              animEl.animate(
                [
                  { transform: "translateY(0) scale(1)", opacity: 1 },
                  { transform: `translateY(${dy}px) scale(1)`, opacity: 1, offset: 0.85 },
                  { transform: `translateY(${dy}px) scale(1)`, opacity: 0 },
                ],
                { duration: 520, easing: "cubic-bezier(0.3, 0, 0.9, 0.4)", fill: "forwards" }
              ).onfinish = () => {
                // Reset the merge animation's final state, otherwise a repeated
                // FLIP would capture wrong positions
                animEl.style.removeProperty("transform");
                animEl.style.removeProperty("opacity");
                // Remove the group asynchronously and run FLIP again to lift Done
                this.flipMove(slide, () => {
                  activeGroup.remove();
                  this.syncActiveSection(slide);
                });
              };
            }
          }
        } else {
          row.parentElement?.appendChild(row);
        }
        this.syncActiveSection(slide);
      } else if (slide && !t.checked) {
        // Return to active: into its note's group at the original position
        const doneGroup = row.closest(".be-day-group") as HTMLElement | null;
        const doneGroupTop = doneGroup ? doneGroup.getBoundingClientRect().top : 0;
        const activeList = slide.querySelector(".be-day-list") as HTMLElement | null;
        if (activeList) {
          let group = activeList.querySelector<HTMLElement>(".be-day-group[data-file=\"" + esc + "\"]");
          let createdGroup = false;
          if (!group) {
            group = this.createTaskGroup(activeList, t.filePath, slide?.dataset.key);
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
        this.syncActiveSection(slide);
      } else {
        row.parentElement?.appendChild(row);
      }
    };

    if (slide) {
      if (t.checked) {
        // First a visible strikethrough, then a pause, then the flight to Done
        window.setTimeout(() => this.flipMove(slide, mutate), 600);
      } else {
        this.flipMove(slide, mutate);
      }
    } else {
      mutate();
    }
  }

  private ensureDoneVisible(slide: HTMLElement): void {
    const section = slide.querySelector(".be-day-done-section") as HTMLElement | null;
    const title = slide.querySelector(".be-day-done-title") as HTMLElement | null;
    if (!section || !title) return;
    const wasHidden = section.classList.contains("is-empty");
    section.removeClass("is-empty");
    if (wasHidden) {
      this.fadeIn(title, 300);
    }
  }

  private syncActiveSection(slide: HTMLElement): void {
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
  private flipMove(slide: HTMLElement, mutate: () => void): void {
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

}

function startOfWeek(d: Date): Date {
  const day = d.getDay();
  const diff = (day + 6) % 7; // Monday = 0
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff);
}

function fileName(path: string): string {
  const parts = path.split("/");
  const name = parts[parts.length - 1];
  return name.replace(/\.md$/i, "");
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}
