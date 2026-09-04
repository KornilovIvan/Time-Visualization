import {
  ItemView,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import type TimeVisualizationPlugin from "./main";
import { TaskIndex } from "./taskIndex";
import { ParsedTask, formatDate, startOfDay } from "./parser";
import { addDays, startOfWeek } from "./dates";
import { VIEW_TYPE, type Level } from "./viewHost";
import {
  carouselStep,
  getCarouselMeta,
  renderCarousel,
} from "./carousel";
import { applyTaskToggled } from "./toggleAnimation";
import { showDayPriorityMenu, showTaskMenu } from "./menus";
import { toggleTask } from "./taskWriter";

export { VIEW_TYPE, type Level } from "./viewHost";

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
  track: HTMLElement | null = null;
  resizeObserver: ResizeObserver | null = null;
  carouselAnim: Animation | null = null;
  /** Suppress re-render after our own task toggle (avoids flicker) */
  private suppressRender = false;
  private suppressTimer: number | null = null;
  taskRefs = new Map<string, ParsedTask>();
  editingTaskKey: string | null = null;
  taskMenu: HTMLElement | null = null;
  /** Button that opened the current menu (to toggle it closed on re-click) */
  taskMenuAnchor: HTMLElement | null = null;
  /** A click that just closed the task menu must not toggle a task */
  menuJustClosed = false;
  /** Pointer position at the last mousedown — to tell a click from a drag-select */
  private mouseDownX = 0;
  private mouseDownY = 0;
  /** Text was selected when the current click started — that click must only clear it */
  private hadSelection = false;
  /** Priority picker popup for a group header */
  priorityMenu: HTMLElement | null = null;
  /** Button that opened the priority menu (to toggle it closed on re-click) */
  priorityMenuAnchor: HTMLElement | null = null;

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

  /** Re-render the current level without rescanning (e.g. after priority edits) */
  redraw(): void {
    this.render();
  }

  /** Refill the visible slides in place — no track/header recreation, so the
      day stays on screen while the group order updates */
  refillCurrent(): void {
    if (!this.track) return;
    const meta = getCarouselMeta(this, this.level);
    for (const slide of Array.from(this.track.querySelectorAll<HTMLElement>("." + meta.slideCls))) {
      const key = slide.dataset.key;
      if (key) meta.fill(slide, key);
    }
  }

  openTaskMenu(anchor: HTMLElement, row: HTMLElement, t: ParsedTask): void {
    showTaskMenu(this, anchor, row, t);
  }

  openDayPriorityMenu(anchor: HTMLElement, dateKey: string): void {
    showDayPriorityMenu(this, anchor, dateKey);
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
        const meta = getCarouselMeta(this, this.level);
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
    carouselStep(this, dir, getCarouselMeta(this, this.level));
  }

  goToday(): void {
    const now = startOfDay(new Date());
    if (formatDate(this.cursor) === formatDate(now)) return;
    this.cursor = now;
    this.render();
  }

  private buildUI(): void {
    this.root = this.contentEl.createDiv({ cls: "tv-root" });
    this.root.tabIndex = -1;
    this.headerEl = this.root.createDiv({ cls: "tv-header" });
    this.buildHeader(this.headerEl);
    this.stageEl = this.root.createDiv({ cls: "tv-stage" });
    this.render();
  }

  /** Records the pointer position and clears any text selection on click, so a
      click always dismisses the selection instead of toggling a task. */
  onMouseDown(e: MouseEvent): void {
    this.mouseDownX = e.clientX;
    this.mouseDownY = e.clientY;
    // Only inside our view: remember whether text was selected, then clear it —
    // the click that clears the selection must not also toggle a task
    if ((e.target as HTMLElement).closest(".tv-root")) {
      const sel = window.getSelection();
      this.hadSelection = !!sel && !sel.isCollapsed;
      if (sel) sel.removeAllRanges();
    } else {
      this.hadSelection = false;
    }
  }

  /** True when this click followed a drag or just cleared a text selection —
      such a click must not navigate, open a note or expand a group */
  isSelectionClick(e: MouseEvent): boolean {
    const dx = e.clientX - this.mouseDownX;
    const dy = e.clientY - this.mouseDownY;
    if (dx * dx + dy * dy > 25) return true;
    return this.hadSelection;
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
    // A click that followed a drag-select (the mouse moved) must not toggle a
    // task or cancel the text selection — only a real click acts on the task
    const dx = e.clientX - this.mouseDownX;
    const dy = e.clientY - this.mouseDownY;
    if (dx * dx + dy * dy > 25) return;
    // The click that just cleared a text selection (set in onMouseDown) must
    // only dismiss the selection — it must not toggle a task either
    if (this.hadSelection) {
      this.hadSelection = false;
      return;
    }
    const taskEl = (e.target as HTMLElement).closest(".tv-task") as HTMLElement | null;
    if (!taskEl) return;
    if (taskEl.classList.contains("is-editing")) return;
    const key = taskEl.dataset.taskKey;
    if (!key) return;
    const t = this.taskRefs.get(key);
    if (!t) return;
    // Clicking a rendered markdown link inside a task must not toggle it
    const link = (e.target as HTMLElement).closest("a");
    if (link) {
      e.stopPropagation();
      e.preventDefault();
      const href = link.getAttribute("href");
      if (href) window.open(href, "_blank", "noopener");
      return;
    }
    e.stopPropagation();
    e.preventDefault();
    const box = taskEl.querySelector(".tv-task-box") as HTMLElement | null;
    applyTaskToggled(this, taskEl, box, t);
    // The file write runs in parallel; the modify event must not re-render mid-animation
    this.suppressRerender(3000);
    void toggleTask(this.plugin, t).catch(() => {
      applyTaskToggled(this, taskEl, box, t);
    });
  }

  /** Suppress re-render from file changes (own toggle/move); the timer restarts
      on each call, so rapid clicks never trigger a full render mid-animation */
  suppressRerender(ms: number): void {
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
    this.headerEl?.querySelectorAll<HTMLElement>(".tv-level").forEach((b) => {
      b.classList.toggle("is-active", b.dataset.level === this.level);
    });

    this.stageEl.empty();
    const body = this.stageEl.createDiv({ cls: "tv-body" });
    renderCarousel(this, body, getCarouselMeta(this, this.level));

    body.animate(
      [{ opacity: 0.3 }, { opacity: 1 }],
      { duration: 160, easing: "ease-out" }
    );
  }

  private buildHeader(header: HTMLElement): void {
    const controls = header.createDiv({ cls: "tv-controls" });

    const nav = controls.createDiv({ cls: "tv-nav" });
    const btnPrev = nav.createEl("button", { cls: "tv-btn", attr: { "aria-label": "Previous" } });
    setIcon(btnPrev, "chevron-left");
    btnPrev.addEventListener("click", () => this.navigate(-1));

    const btnToday = nav.createEl("button", { cls: "tv-btn tv-today", text: "Today" });
    btnToday.addEventListener("click", () => this.goToday());

    const btnNext = nav.createEl("button", { cls: "tv-btn", attr: { "aria-label": "Next" } });
    setIcon(btnNext, "chevron-right");
    btnNext.addEventListener("click", () => this.navigate(1));

    const levels = controls.createDiv({ cls: "tv-levels" });
    const defs: Array<[Level, string]> = [
      ["day", "Day"],
      ["week", "Week"],
      ["month", "Month"],
    ];
    for (const [lv, label] of defs) {
      const b = levels.createEl("button", {
        cls: "tv-level" + (this.level === lv ? " is-active" : ""),
        text: label,
        attr: { "data-level": lv },
      });
      b.addEventListener("click", () => this.setLevel(lv, true));
    }

    const settingsBtn = controls.createEl("button", {
      cls: "tv-btn tv-settings",
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
}
