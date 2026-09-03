import {
  App,
  Notice,
  PluginSettingTab,
  Setting,
} from "obsidian";
import type TimeVisualizationPlugin from "./main";
import { DateFormat } from "./parser";
import { buildMultiSelect, buildPriorityList } from "./settingsUi";

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

export class TimeVisualizationSettingTab extends PluginSettingTab {
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
        buildPriorityList(pContainer, this.app, {
          getList: () => this.plugin.settings.priorities,
          setList: (next) => {
            this.plugin.settings.priorities = next;
          },
          suggestItems: this.plugin.collectSources(),
          onChange: () => {
            void this.plugin.saveSettings();
            this.plugin.getView()?.redraw();
          },
        });
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
