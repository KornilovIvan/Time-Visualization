import {
  AbstractInputSuggest,
  App,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFolder,
  WorkspaceLeaf,
} from "obsidian";
import { TimeVisualizationView, VIEW_TYPE } from "./view";
import { DateFormat } from "./parser";

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
    return this.items.filter((i) => i.toLowerCase().includes(q)).slice(0, 20);
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
    this.settings = Object.assign(
      {},
      DEFAULT_SETTINGS,
      await this.loadData() as Partial<TimeVisualizationSettings>
    );
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

    new Setting(containerEl).setName("Task parsing").setHeading();

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
      .setDesc("Write a [done:: ...] marker into tasks when you complete them, so the order of completion is kept across reloads. Turn off if you don't want the plugin to modify your task lines.")
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
