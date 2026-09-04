import { TFile } from "obsidian";
import type TimeVisualizationPlugin from "./main";
import { ParsedTask, parseTaskLine } from "./parser";

/** Task index by date. Caches parsed tasks per file; on a file change only its
    contribution and the date index are rebuilt. File writes live in taskWriter. */
export class TaskIndex {
  private plugin: TimeVisualizationPlugin;
  private fileCache = new Map<string, ParsedTask[]>();
  private mtimes = new Map<string, number>();
  private byDate = new Map<string, ParsedTask[]>();
  /** Date-format key used for the last parse; on change the whole cache is rebuilt */
  private lastFormatKey = "";

  constructor(plugin: TimeVisualizationPlugin) {
    this.plugin = plugin;
  }

  private formatKey(): string {
    return `${this.plugin.settings.dateFormat}|${this.plugin.settings.customDateRegex}`;
  }

  async refresh(): Promise<void> {
    // When the date format changes, cached tasks were parsed differently — drop
    // the cache so files are re-read with the new parser (mtime is unchanged)
    const fmtKey = this.formatKey();
    if (this.lastFormatKey && this.lastFormatKey !== fmtKey) {
      this.fileCache.clear();
      this.mtimes.clear();
    }
    this.lastFormatKey = fmtKey;

    const files = this.plugin.app.vault.getMarkdownFiles();
    const seen = new Set<string>();
    const changed: TFile[] = [];
    for (const file of files) {
      seen.add(file.path);
      if (!this.matchesFile(file.path)) {
        this.fileCache.delete(file.path);
        this.mtimes.delete(file.path);
        continue;
      }
      if (this.mtimes.get(file.path) !== file.stat.mtime) {
        changed.push(file);
      }
    }
    for (const path of this.fileCache.keys()) {
      if (!seen.has(path)) {
        this.fileCache.delete(path);
        this.mtimes.delete(path);
      }
    }
    const concurrency = 20;
    for (let i = 0; i < changed.length; i += concurrency) {
      const batch = changed.slice(i, i + concurrency);
      await Promise.all(
        batch.map(async (file) => {
          const content = await this.plugin.app.vault.cachedRead(file);
          // Cache ALL tasks; the tag filter is applied when building the date
          // index — otherwise changing includeTags wouldn't update the view
          // without re-reading files (mtime is unchanged)
          this.fileCache.set(file.path, this.parseContent(content, file.path));
          this.mtimes.set(file.path, file.stat.mtime);
        })
      );
    }
    this.rebuildDateIndex();
  }

  async updateFile(filePath: string): Promise<void> {
    const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
    if (!this.matchesFile(filePath)) {
      this.fileCache.delete(filePath);
      this.mtimes.delete(filePath);
      this.rebuildDateIndex();
      return;
    }
    if (file instanceof TFile && file.extension === "md") {
      const content = await this.plugin.app.vault.cachedRead(file);
      this.fileCache.set(filePath, this.parseContent(content, filePath));
      this.mtimes.set(filePath, file.stat.mtime);
    } else {
      this.fileCache.delete(filePath);
      this.mtimes.delete(filePath);
    }
    this.rebuildDateIndex();
  }

  private parseContent(content: string, filePath: string): ParsedTask[] {
    const tasks: ParsedTask[] = [];
    const lines = content.split("\n");
    const format = this.plugin.settings.dateFormat;
    const custom = this.plugin.settings.customDateRegex;
    for (let i = 0; i < lines.length; i++) {
      const t = parseTaskLine(lines[i], filePath, i, format, custom);
      if (t) tasks.push(t);
    }
    return tasks;
  }

  getFileTasks(filePath: string): ParsedTask[] {
    return this.fileCache.get(filePath) ?? [];
  }

  private rebuildDateIndex(): void {
    const byDate = new Map<string, ParsedTask[]>();
    const seen = new Set<string>();
    for (const tasks of this.fileCache.values()) {
      for (const t of tasks) {
        if (!this.matchesTags(t)) continue;
        if (!t.date) continue;
        const dedupKey = `${t.filePath}:${t.line}`;
        if (seen.has(dedupKey)) continue;
        seen.add(dedupKey);
        let list = byDate.get(t.date);
        if (!list) {
          list = [];
          byDate.set(t.date, list);
        }
        list.push(t);
      }
    }
    for (const list of byDate.values()) {
      list.sort((a, b) => {
        if (a.checked !== b.checked) return a.checked ? 1 : -1;
        if (!a.checked) {
          // Open tasks: by time, then by file/line
          if (a.time && b.time) return a.time.localeCompare(b.time);
          if (a.time) return -1;
          if (b.time) return 1;
          return a.filePath.localeCompare(b.filePath) || a.line - b.line;
        }
        // Done tasks: by completion order (oldest first), then by file/line.
        // This keeps the order in which tasks were completed across reloads.
        // Missing or invalid marker sorts last.
        const da = a.done ? Date.parse(a.done) || Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
        const db = b.done ? Date.parse(b.done) || Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
        if (da !== db) return da - db;
        return a.filePath.localeCompare(b.filePath) || a.line - b.line;
      });
    }
    this.byDate = byDate;
  }

  getTasks(date: string): ParsedTask[] {
    return this.byDate.get(date) ?? [];
  }

  private matchesFile(path: string): boolean {
    const s = this.plugin.settings;
    const sources = s.sources ?? [];
    if (sources.length === 0) return true;
    return sources.some((src) => {
      if (src.endsWith(".md")) return path === src;
      return path === src || path.startsWith(src + "/");
    });
  }

  private matchesTags(t: ParsedTask): boolean {
    const s = this.plugin.settings;
    const tags = t.tags.map((tag) => tag.replace(/^#/, "").toLowerCase());
    if (s.includeTags.length > 0 && !tags.some((tag) => s.includeTags.includes(tag))) {
      return false;
    }
    return true;
  }

}
