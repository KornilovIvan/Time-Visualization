import { describe, expect, it } from "vitest";
import { TFile } from "obsidian";
import { TaskIndex } from "./taskIndex";
import type TimeVisualizationPlugin from "./main";
import { DEFAULT_SETTINGS, type TimeVisualizationSettings } from "./settings";

type VaultFile = {
  file: TFile;
  content: string;
};

function makeFile(path: string, content: string, mtime = 1): VaultFile {
  const file = new TFile();
  file.path = path;
  file.extension = "md";
  file.stat = { mtime, ctime: mtime, size: content.length };
  return { file, content };
}

function makePlugin(
  files: VaultFile[],
  settings: Partial<TimeVisualizationSettings> = {}
): TimeVisualizationPlugin {
  const byPath = new Map(files.map((f) => [f.file.path, f]));

  return {
    settings: { ...DEFAULT_SETTINGS, ...settings },
    app: {
      vault: {
        getMarkdownFiles: () => files.map((f) => f.file),
        getAbstractFileByPath: (path: string) => byPath.get(path)?.file ?? null,
        cachedRead: async (file: TFile) => byPath.get(file.path)?.content ?? "",
      },
    },
  } as unknown as TimeVisualizationPlugin;
}

describe("TaskIndex", () => {
  it("indexes tasks by date and sorts open tasks by time", async () => {
    const plugin = makePlugin([
      makeFile(
        "a.md",
        [
          "- [ ] Late |[date:: 2026-01-05] |[time:: 15:00]",
          "- [ ] Early |[date:: 2026-01-05] |[time:: 09:00]",
          "- [ ] Other day |[date:: 2026-01-06]",
        ].join("\n")
      ),
    ]);
    const index = new TaskIndex(plugin);
    await index.refresh();

    expect(index.getTasks("2026-01-05").map((t) => t.text)).toEqual(["Early", "Late"]);
    expect(index.getTasks("2026-01-06")).toHaveLength(1);
    expect(index.getTasks("2099-01-01")).toEqual([]);
  });

  it("puts open tasks before done and orders done by completion time", async () => {
    const plugin = makePlugin([
      makeFile(
        "a.md",
        [
          "- [x] Done later |[done:: 2026-01-05T18:00:00.000Z]",
          "- [ ] Open |[date:: 2026-01-05]",
          "- [x] Done earlier |[done:: 2026-01-05T10:00:00.000Z]",
        ].join("\n")
      ),
    ]);
    const index = new TaskIndex(plugin);
    await index.refresh();

    expect(index.getTasks("2026-01-05").map((t) => t.text)).toEqual([
      "Open",
      "Done earlier",
      "Done later",
    ]);
  });

  it("filters by includeTags without dropping the file cache", async () => {
    const plugin = makePlugin(
      [
        makeFile(
          "a.md",
          [
            "- [ ] Focused #focus |[date:: 2026-01-05]",
            "- [ ] Other #work |[date:: 2026-01-05]",
          ].join("\n")
        ),
      ],
      { includeTags: ["focus"] }
    );
    const index = new TaskIndex(plugin);
    await index.refresh();

    expect(index.getTasks("2026-01-05").map((t) => t.text)).toEqual(["Focused"]);
    expect(index.getFileTasks("a.md")).toHaveLength(2);

    plugin.settings.includeTags = [];
    await index.refresh();
    expect(index.getTasks("2026-01-05").map((t) => t.text)).toEqual([
      "Focused",
      "Other",
    ]);
  });

  it("respects sources for folders and exact notes", async () => {
    const plugin = makePlugin(
      [
        makeFile("Work/a.md", "- [ ] Work task |[date:: 2026-01-05]"),
        makeFile("Personal.md", "- [ ] Personal |[date:: 2026-01-05]"),
        makeFile("Other/x.md", "- [ ] Other |[date:: 2026-01-05]"),
      ],
      { sources: ["Work", "Personal.md"] }
    );
    const index = new TaskIndex(plugin);
    await index.refresh();

    expect(index.getTasks("2026-01-05").map((t) => t.text).sort()).toEqual([
      "Personal",
      "Work task",
    ]);
    expect(index.getFileTasks("Other/x.md")).toEqual([]);
  });

  it("updateFile reindexes one note and drops excluded paths", async () => {
    const files = [
      makeFile("a.md", "- [ ] One |[date:: 2026-01-05]", 1),
      makeFile("b.md", "- [ ] Two |[date:: 2026-01-05]", 1),
    ];
    const plugin = makePlugin(files);
    const index = new TaskIndex(plugin);
    await index.refresh();
    expect(index.getTasks("2026-01-05")).toHaveLength(2);

    files[0].content = "- [ ] One updated |[date:: 2026-01-05]\n- [ ] Extra |[date:: 2026-01-05]";
    files[0].file.stat.mtime = 2;
    await index.updateFile("a.md");
    expect(index.getTasks("2026-01-05").map((t) => t.text)).toEqual([
      "One updated",
      "Extra",
      "Two",
    ]);

    plugin.settings.sources = ["b.md"];
    await index.updateFile("a.md");
    expect(index.getFileTasks("a.md")).toEqual([]);
    expect(index.getTasks("2026-01-05").map((t) => t.text)).toEqual(["Two"]);
  });

  it("re-parses all files when the date format changes", async () => {
    const files = [
      makeFile("a.md", "- [ ] Ship 📅 2026-01-05", 1),
    ];
    const plugin = makePlugin(files, { dateFormat: "legacy" });
    const index = new TaskIndex(plugin);
    await index.refresh();
    expect(index.getTasks("2026-01-05")).toEqual([]);

    plugin.settings.dateFormat = "tasks";
    // mtime unchanged — format-key invalidation must still re-read
    await index.refresh();
    expect(index.getTasks("2026-01-05").map((t) => t.text)).toEqual(["Ship"]);
  });

  it("skips tasks without a date in the date index", async () => {
    const plugin = makePlugin([
      makeFile("a.md", "- [ ] No date\n- [ ] Dated |[date:: 2026-01-05]"),
    ]);
    const index = new TaskIndex(plugin);
    await index.refresh();
    expect(index.getFileTasks("a.md")).toHaveLength(2);
    expect(index.getTasks("2026-01-05")).toHaveLength(1);
  });
});
