import {
  AbstractInputSuggest,
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  WorkspaceLeaf,
  setIcon,
} from "obsidian";
import { TimeVisualizationView, VIEW_TYPE } from "./view";
import { DateFormat } from "./parser";
import { flipReorder } from "./flip";

export interface TimeVisualizationSettings {
  /** Sources: folders (path without extension) or full note paths. Empty = whole vault */
  sources: string[];
  /** Tags (no #): only show tasks carrying any of them. Empty = all tags */
  includeTags: string[];
  /** How task dates are parsed: legacy inline fields, Tasks emoji fields, or a custom regex */
  dateFormat: DateFormat;
  /** Custom regex with named groups "date" and "time" (used when dateFormat = "custom") */
  customDateRegex: string;
  /** Write a [done:: ...] marker on completion so the done order survives reloads */
  recordDoneTime: boolean;
  /** Open the view automatically every time Obsidian starts */
  openOnStartup: boolean;
  /** Ordered list of prioritized notes or folders (first = highest priority);
      a folder covers all notes inside it; others sort last */
  priorities: string[];
  /** Per-day group order overrides, keyed by date: array of note paths (first = top) */
  dayOrder: Record<string, string[]>;
  /** When on, groups with timed tasks sort above any global-priority group */
  timeOverPriority: boolean;
}

export const DEFAULT_SETTINGS: TimeVisualizationSettings = {
  sources: [],
  includeTags: [],
  dateFormat: "legacy",
  customDateRegex: "",
  // Off by default: the plugin must not write into task lines until the user
  // explicitly enables it in Settings
  recordDoneTime: false,
  // Off by default: auto-opening the view on every start can be intrusive
  openOnStartup: false,
  priorities: [],
  dayOrder: {},
  timeOverPriority: false,
};

class MultiSuggest extends AbstractInputSuggest<string> {
  private items: string[];
  private onPick: (value: string) => void;
  private input: HTMLInputElement;
  private query = "";
  private kind: "tag" | "path";

  constructor(
    app: App,
    inputEl: HTMLInputElement,
    items: string[],
    onPick: (value: string) => void,
    kind: "tag" | "path" = "path"
  ) {
    super(app, inputEl);
    this.items = items;
    this.onPick = onPick;
    this.input = inputEl;
    this.kind = kind;
  }

  getSuggestions(query: string): string[] {
    const q = query.trim().toLowerCase();
    this.query = q;
    if (!q) return this.items.slice(0, 50);
    return this.items
      .filter((i) => {
        const lower = i.toLowerCase();
        if (lower.includes(q)) return true;
        // Match by the bare name (last segment, no ".md", leading "_" ignored)
        const base = i
          .slice(i.lastIndexOf("/") + 1)
          .replace(/\.md$/i, "")
          .replace(/^_/, "")
          .toLowerCase();
        return base.includes(q);
      })
      .sort((a, b) => {
        // Name matches rank above path-only matches
        const an = a
          .slice(a.lastIndexOf("/") + 1)
          .replace(/\.md$/i, "")
          .replace(/^_/, "")
          .toLowerCase()
          .includes(q)
          ? 0
          : 1;
        const bn = b
          .slice(b.lastIndexOf("/") + 1)
          .replace(/\.md$/i, "")
          .replace(/^_/, "")
          .toLowerCase()
          .includes(q)
          ? 0
          : 1;
        return an - bn;
      })
      .slice(0, 100);
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    const label =
      this.kind === "tag" ? "#" + value : (value.endsWith(".md") ? "📄 " : "📁 ") + value;
    const q = this.query;
    if (!q) {
      el.setText(label);
      return;
    }
    const idx = label.toLowerCase().indexOf(q);
    if (idx === -1) {
      el.setText(label);
      return;
    }
    el.createSpan({ text: label.slice(0, idx) });
    el.createSpan({ cls: "tv-suggest-highlight", text: label.slice(idx, idx + q.length) });
    el.createSpan({ text: label.slice(idx + q.length) });
  }

  selectSuggestion(value: string): void {
    this.onPick(value);
    this.input.value = "";
    this.close();
  }
}

function buildMultiSelect(
  containerEl: HTMLElement,
  options: string[],
  selected: string[],
  onChange: (next: string[]) => void,
  app: App,
  kind: "tag" | "path" = "path"
): void {
  let current = [...selected];

  const wrap = containerEl.createDiv({ cls: "tv-multi" });
  const chips = wrap.createDiv({ cls: "tv-multi-chips" });
  const input = wrap.createEl("input", {
    cls: "tv-multi-input",
    type: "text",
    placeholder: "Start typing…",
  });

  const commit = (next: string[]): void => {
    current = next;
    onChange(next);
    renderChips();
  };

  const renderChips = (): void => {
    chips.empty();
    for (const v of current) {
      const chip = chips.createSpan({ cls: "tv-multi-chip", text: v });
      const x = chip.createSpan({ cls: "tv-multi-chip-x", text: "×" });
      x.addEventListener("click", () => commit(current.filter((s) => s !== v)));
    }
  };

  new MultiSuggest(app, input, options, (v) => {
    if (v && !current.includes(v)) commit([...current, v]);
  }, kind);

  renderChips();
}

export default class TimeVisualizationPlugin extends Plugin {
  settings: TimeVisualizationSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();

    // Open the view automatically on every start if the setting is enabled.
    // onLayoutReady fires after the workspace layout is fully loaded, so a new
    // leaf can be created safely; activateView reuses an existing leaf, so a
    // restored panel is never duplicated.
    this.app.workspace.onLayoutReady(() => {
      if (this.settings.openOnStartup) void this.activateView();
    });

    this.registerView(VIEW_TYPE, (leaf: WorkspaceLeaf) => new TimeVisualizationView(leaf, this));

    // Keep priorities bound to a note when it is moved to another folder or
    // renamed — the stored path would otherwise stop matching the new path
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!(file instanceof TFile) || oldPath === file.path) return;
        const next = file.path;
        let changed = false;
        if (this.settings.priorities.includes(oldPath)) {
          this.settings.priorities = this.settings.priorities.map((p) => (p === oldPath ? next : p));
          changed = true;
        }
        for (const date of Object.keys(this.settings.dayOrder)) {
          const arr = this.settings.dayOrder[date];
          if (arr.includes(oldPath)) {
            this.settings.dayOrder[date] = arr.map((p) => (p === oldPath ? next : p));
            changed = true;
          }
        }
        if (changed) void this.saveSettings();
        this.getView()?.refresh();
      })
    );

    this.addCommand({
      id: "open",
      name: "Open",
      callback: () => {
        void this.activateView();
      },
    });

    this.addRibbonIcon("calendar-days", "Time Visualization", () => {
      void this.activateView();
    });

    this.addSettingTab(new TimeVisualizationSettingTab(this.app, this));

    this.registerDomEvent(document, "keydown", (evt: KeyboardEvent) => {
      const view = this.getView();
      if (view) view.handleKey(evt);
    });

    this.registerDomEvent(document, "mousedown", (evt: MouseEvent) => {
      const view = this.getView();
      if (view) view.onMouseDown(evt);
    });

    this.registerDomEvent(document, "click", (evt: MouseEvent) => {
      const view = this.getView();
      if (view) view.onDocumentClick(evt);
    });
  }

  onunload(): void {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => leaf.detach());
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData() as Partial<TimeVisualizationSettings> | null;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    // Migration: prior versions stored priorities as Record<path, number>;
    // now it is an ordered array. Any invalid value falls back to an empty
    // list so the view does not crash on render.
    if (!Array.isArray(this.settings.priorities)) {
      this.settings.priorities = [];
    }
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async reload(): Promise<void> {
    const view = this.getView();
    if (view) await view.refresh();
  }

  collectFolders(): string[] {
    const folders: string[] = [];
    for (const f of this.app.vault.getAllLoadedFiles()) {
      if (f instanceof TFolder && f.path) folders.push(f.path);
    }
    return folders.sort((a, b) => a.localeCompare(b));
  }

  collectFiles(): string[] {
    return this.app.vault
      .getMarkdownFiles()
      .map((f) => f.path)
      .sort((a, b) => a.localeCompare(b));
  }

  collectSources(): string[] {
    const set = new Set<string>([...this.collectFolders(), ...this.collectFiles()]);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }

  collectTags(): string[] {
    // getTags() is missing from the obsidian.d.ts types but exists at runtime
    const cache = this.app.metadataCache as unknown as {
      getTags?: () => Record<string, number>;
    };
    const tags = cache.getTags?.() ?? {};
    const out: string[] = [];
    for (const key of Object.keys(tags)) {
      const t = key.replace(/^#/, "").toLowerCase();
      if (t) out.push(t);
    }
    return out.sort((a, b) => a.localeCompare(b));
  }

  getView(): TimeVisualizationView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    for (const leaf of leaves) {
      if (leaf.view instanceof TimeVisualizationView) return leaf.view;
    }
    return null;
  }

  async activateView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.setActiveLeaf(existing[0], { focus: true });
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }
}

class TimeVisualizationSettingTab extends PluginSettingTab {
  plugin: TimeVisualizationPlugin;

  constructor(app: App, plugin: TimeVisualizationPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    const sources = this.plugin.collectSources();
    const tags = this.plugin.collectTags();

    new Setting(containerEl)
      .setName("Sources (folders and notes)")
      .setDesc("Folders (path without extension) and full note paths. Empty = whole vault.")
      .then((setting) => {
        // Inline the multi-select into the setting row so the field clearly
        // belongs to its title/description
        const holder = setting.infoEl.createDiv({ cls: "tv-setting-control" });
        buildMultiSelect(
          holder,
          sources,
          this.plugin.settings.sources,
          (next) => {
            this.plugin.settings.sources = next;
            void this.plugin.saveSettings();
          },
          this.app
        );
      });

    new Setting(containerEl)
      .setName("Only parse tags")
      .setDesc("Show only tasks carrying these tags. Empty = all tags.")
      .then((setting) => {
        const holder = setting.infoEl.createDiv({ cls: "tv-setting-control" });
        buildMultiSelect(
          holder,
          tags,
          this.plugin.settings.includeTags,
          (next) => {
            this.plugin.settings.includeTags = next;
            void this.plugin.saveSettings();
          },
          this.app,
          "tag"
        );
      });

    new Setting(containerEl)
      .setName("Date format")
      .setDesc("How task dates are read: legacy inline fields ([date:: ...]), Obsidian Tasks emoji fields (📅 ...), or a custom regex.")
      .addDropdown((dd) =>
        dd
          .addOption("legacy", "Inline fields ([date:: ...])")
          .addOption("tasks", "Tasks plugin (📅 YYYY-MM-DD)")
          .addOption("custom", "Custom regex")
          .setValue(this.plugin.settings.dateFormat)
          .onChange(async (v) => {
            this.plugin.settings.dateFormat = v as DateFormat;
            await this.plugin.saveSettings();
            await this.plugin.reload();
          })
      );

    new Setting(containerEl)
      .setName("Custom date regex")
      .setDesc("Used with the 'Custom regex' format. A regex with named groups 'date' and 'time', e.g. 📅 (?<date>\\d{4}-\\d{2}-\\d{2}).")
      .addText((t) => {
        t.setValue(this.plugin.settings.customDateRegex);
        t.inputEl.placeholder = "📅 (?<date>\\d{4}-\\d{2}-\\d{2})";
        // Save on every keystroke, but re-parse only when editing finishes
        // (blur/Enter) — a full rescan per keystroke would lag on big vaults
        t.onChange(async (v) => {
          this.plugin.settings.customDateRegex = v;
          await this.plugin.saveSettings();
        });
        t.inputEl.addEventListener("blur", () => {
          void this.plugin.reload();
        });
        t.inputEl.addEventListener("keydown", (e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        });
      });

    new Setting(containerEl)
      .setName("Record completion time")
      .setDesc("On completion the [date:: ...] field is replaced with a [done:: <time>] marker (one field, no duplicates) and done tasks keep their completion order. If you return a task to open outside this view (in the editor), the [done:: ...] marker stays in the line — the plugin restores [date:: ...] only when you toggle the task here. Turn off if you don't want the plugin to modify your task lines.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.recordDoneTime).onChange(async (v) => {
          this.plugin.settings.recordDoneTime = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Open view on startup")
      .setDesc("Open the time visualization view automatically every time Obsidian starts.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.openOnStartup).onChange(async (v) => {
          this.plugin.settings.openOnStartup = v;
          await this.plugin.saveSettings();
        })
      );

    new Setting(containerEl)
      .setName("Priority")
      .setDesc("The order of the list is the priority: the first entry is highest. You can add a note or a folder — a folder applies to all notes inside it. Notes not covered by the list stay at the bottom of the day view. You can also reorder from the day header in the view.")
      .then((setting) => {
        const pContainer = setting.infoEl.createDiv({ cls: "tv-priority-list" });
    const renderPriorityList = (): void => {
      pContainer.empty();
      pContainer.createDiv({ cls: "be-priority-tip", text: "Use the arrows to reorder priority." });
      const list = this.plugin.settings.priorities;
      let rows: HTMLElement[] = [];
      // The "add note" field must always stay below the list rows
      let addRow: HTMLElement | null = null;
      const renumber = (): void => {
        rows.forEach((r, j) => {
          const num = r.querySelector(".be-priority-num");
          if (num) num.setText(String(j + 1));
        });
      };
      const persist = (): void => {
        this.plugin.settings.priorities = rows.map((r) => r.dataset.path ?? "").filter(Boolean);
        void this.plugin.saveSettings();
        this.plugin.getView()?.redraw();
      };
      const moveOne = (row: HTMLElement, dir: 1 | -1): void => {
        const from = rows.indexOf(row);
        const to = from + dir;
        if (from < 0 || to < 0 || to >= rows.length) return;
        const prev = rows.map((r) => r.getBoundingClientRect().top);
        pContainer.insertBefore(row, dir === 1 ? (rows[to + 1] ?? addRow) : rows[to]);
        rows = Array.from(pContainer.querySelectorAll<HTMLElement>(".be-priority-row"));
        flipReorder(rows, prev);
        renumber();
        persist();
      };
      list.forEach((path, i) => {
        const row = pContainer.createDiv({ cls: "tv-priority-row be-priority-row" });
        rows.push(row);
        row.dataset.path = path;
        row.createSpan({ cls: "be-priority-num", text: String(i + 1) });
        row.createSpan({ cls: "be-priority-name", text: path });
        const upBtn = row.createEl("button", { cls: "be-priority-arrow", attr: { "aria-label": "Move up" } });
        setIcon(upBtn, "chevron-up");
        upBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          moveOne(row, -1);
        });
        const downBtn = row.createEl("button", { cls: "be-priority-arrow", attr: { "aria-label": "Move down" } });
        setIcon(downBtn, "chevron-down");
        downBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          moveOne(row, 1);
        });
        const del = row.createEl("button", { cls: "tv-priority-del", text: "×" });
        del.addEventListener("click", () => {
          this.plugin.settings.priorities = list.filter((_, j) => j !== i);
          void this.plugin.saveSettings();
          renderPriorityList();
          this.plugin.getView()?.redraw();
        });
      });
      // Add a note or folder to the priority list
      addRow = pContainer.createDiv({ cls: "tv-priority-row tv-priority-add" });
      const pick = addRow.createEl("input", {
        cls: "tv-priority-pick",
        type: "text",
        attr: { placeholder: "Note or folder path…" },
      });
      const addBtn = addRow.createEl("button", { cls: "tv-priority-add-btn", text: "Add" });
      const doAdd = (): void => {
        const path = pick.value.trim();
        if (!path || list.includes(path)) return;
        this.plugin.settings.priorities = [...list, path];
        void this.plugin.saveSettings();
        renderPriorityList();
        this.plugin.getView()?.redraw();
      };
      addBtn.addEventListener("click", doAdd);
      addRow.addEventListener("keydown", (e) => {
        if (e.key === "Enter") doAdd();
      });
      new MultiSuggest(this.app, pick, this.plugin.collectSources(), (v) => {
        if (v) {
          pick.value = v;
          doAdd();
        }
      }, "path");
    };
      renderPriorityList();
    });

    new Setting(containerEl)
      .setName("Time above global priority")
      .setDesc("When enabled, groups that have timed tasks always sort above groups without time, no matter the global priority list.")
      .addToggle((tg) =>
        tg.setValue(this.plugin.settings.timeOverPriority).onChange(async (v) => {
          this.plugin.settings.timeOverPriority = v;
          await this.plugin.saveSettings();
          this.plugin.getView()?.redraw();
        })
      );

    new Setting(containerEl)
      .setName("Apply")
      .setDesc("Rescan notes with the new filters.")
      .addButton((b) => {
        b.setButtonText("Rescan").setCta();
        b.onClick(async () => {
          b.setButtonText("Scanning…");
          b.setDisabled(true);
          try {
            new Notice("Rescanning…");
            await this.plugin.reload();
            new Notice("Done: view updated");
          } finally {
            b.setButtonText("Rescan");
            b.setDisabled(false);
          }
        });
      });
  }
}
