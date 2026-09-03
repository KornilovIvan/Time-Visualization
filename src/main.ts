import {
  Plugin,
  TFile,
  TFolder,
  WorkspaceLeaf,
} from "obsidian";
import { TimeVisualizationView, VIEW_TYPE } from "./view";
import {
  DEFAULT_SETTINGS,
  TimeVisualizationSettingTab,
  type TimeVisualizationSettings,
} from "./settings";

export type { TimeVisualizationSettings } from "./settings";
export { DEFAULT_SETTINGS } from "./settings";

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
