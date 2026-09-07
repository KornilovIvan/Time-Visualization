import { afterEach, describe, expect, it, vi } from "vitest";
import { TFile } from "obsidian";
import type { ParsedTask } from "./parser";
import { moveTask, toggleTask, updateTaskText } from "./taskWriter";
import type TimeVisualizationPlugin from "./main";

type FakePlugin = TimeVisualizationPlugin & {
  getContent: () => string;
};

function makePlugin(
  content: string,
  settings: { recordDoneTime?: boolean } = {}
): FakePlugin {
  const file = new TFile();
  file.path = "note.md";
  let stored = content;

  const plugin = {
    settings: {
      recordDoneTime: settings.recordDoneTime ?? false,
      sources: [],
      includeTags: [],
      dateFormat: "legacy" as const,
      customDateRegex: "",
      openOnStartup: false,
      priorities: [],
      dayOrder: {},
      timeOverPriority: false,
    },
    app: {
      vault: {
        getAbstractFileByPath: (path: string) => (path === file.path ? file : null),
        read: async () => stored,
        modify: async (_f: TFile, next: string) => {
          stored = next;
        },
      },
    },
    getContent: () => stored,
  };

  return plugin as unknown as FakePlugin;
}

function task(partial: Partial<ParsedTask> & Pick<ParsedTask, "line" | "format">): ParsedTask {
  return {
    filePath: "note.md",
    raw: "",
    checked: false,
    text: "Task",
    tags: [],
    ...partial,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("taskWriter results", () => {
  it("returns not-found when the file is missing", async () => {
    const plugin = makePlugin("- [ ] Hi");
    const t = task({ line: 0, format: "legacy", filePath: "gone.md" });
    expect(await toggleTask(plugin, t)).toEqual({ ok: false, reason: "not-found" });
    expect(await moveTask(plugin, t, "2026-02-01")).toEqual({
      ok: false,
      reason: "not-found",
    });
    expect(await updateTaskText(plugin, t, "X")).toEqual({
      ok: false,
      reason: "not-found",
    });
  });

  it("returns stale-line when the line index is out of range", async () => {
    const plugin = makePlugin("- [ ] Only line");
    expect(await toggleTask(plugin, task({ line: 5, format: "legacy" }))).toEqual({
      ok: false,
      reason: "stale-line",
    });
  });

  it("returns stale-line when the line is no longer a task", async () => {
    const plugin = makePlugin("not a task");
    expect(await toggleTask(plugin, task({ line: 0, format: "legacy" }))).toEqual({
      ok: false,
      reason: "stale-line",
    });
    expect(await updateTaskText(plugin, task({ line: 0, format: "legacy" }), "X")).toEqual({
      ok: false,
      reason: "stale-line",
    });
  });

  it("returns unsupported when moving a custom-format task", async () => {
    const plugin = makePlugin("- [ ] Custom @2026-01-01");
    expect(
      await moveTask(plugin, task({ line: 0, format: "custom", date: "2026-01-01" }), "2026-02-01")
    ).toEqual({ ok: false, reason: "unsupported" });
    expect(plugin.getContent()).toBe("- [ ] Custom @2026-01-01");
  });
});

describe("toggleTask", () => {
  it("checks and unchecks without done markers when recordDoneTime is off", async () => {
    const plugin = makePlugin("- [ ] Buy milk |[date:: 2026-01-05]");
    const t = task({ line: 0, format: "legacy", date: "2026-01-05" });

    expect(await toggleTask(plugin, t)).toEqual({ ok: true });
    expect(plugin.getContent()).toBe("- [x] Buy milk |[date:: 2026-01-05]");

    expect(await toggleTask(plugin, t)).toEqual({ ok: true });
    expect(plugin.getContent()).toBe("- [ ] Buy milk |[date:: 2026-01-05]");
  });

  it("replaces [date::] with [done::] when completing a legacy task", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T12:00:00.000Z"));
    const plugin = makePlugin("- [ ] Buy milk |[date:: 2026-01-05]", {
      recordDoneTime: true,
    });
    const t = task({ line: 0, format: "legacy", date: "2026-01-05" });

    expect(await toggleTask(plugin, t)).toEqual({ ok: true });
    expect(plugin.getContent()).toBe(
      "- [x] Buy milk |[done:: 2026-08-05T12:00:00.000Z]"
    );

    expect(await toggleTask(plugin, t)).toEqual({ ok: true });
    expect(plugin.getContent()).toBe("- [ ] Buy milk |[date:: 2026-08-05]");
  });

  it("appends [done::] for tasks-format completion", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T12:00:00.000Z"));
    const plugin = makePlugin("- [ ] Ship 📅 2026-01-05", { recordDoneTime: true });
    const t = task({ line: 0, format: "tasks", date: "2026-01-05" });

    expect(await toggleTask(plugin, t)).toEqual({ ok: true });
    expect(plugin.getContent()).toBe(
      "- [x] Ship 📅 2026-01-05 |[done:: 2026-08-05T12:00:00.000Z]"
    );
  });
});

describe("moveTask", () => {
  it("rewrites legacy [date::] fields", async () => {
    const plugin = makePlugin("- [ ] Meet |[date:: 2026-01-05] |[time:: 09:00]");
    const t = task({ line: 0, format: "legacy", date: "2026-01-05", time: "09:00" });
    expect(await moveTask(plugin, t, "2026-02-01")).toEqual({ ok: true });
    expect(plugin.getContent()).toBe("- [ ] Meet |[date:: 2026-02-01] |[time:: 09:00]");
  });

  it("appends a date field when the line has none", async () => {
    const plugin = makePlugin("- [ ] No date yet");
    expect(await moveTask(plugin, task({ line: 0, format: "legacy" }), "2026-03-01")).toEqual({
      ok: true,
    });
    expect(plugin.getContent()).toBe("- [ ] No date yet |[date:: 2026-03-01]");
  });

  it("rewrites tasks-format emoji dates", async () => {
    const plugin = makePlugin("- [ ] Ship 📅 2026-01-05 ⏰ 10:00");
    const t = task({ line: 0, format: "tasks", date: "2026-01-05", time: "10:00" });
    expect(await moveTask(plugin, t, "2026-04-01")).toEqual({ ok: true });
    expect(plugin.getContent()).toBe("- [ ] Ship 📅 2026-04-01 ⏰ 10:00");
  });
});

describe("updateTaskText", () => {
  it("rewrites legacy text while keeping tags, date and time", async () => {
    const plugin = makePlugin("- [ ] Old text #work |[date:: 2026-01-05] |[time:: 09:00]");
    const t = task({
      line: 0,
      format: "legacy",
      text: "Old text",
      tags: ["#work"],
      date: "2026-01-05",
      time: "09:00",
    });
    expect(await updateTaskText(plugin, t, "New text")).toEqual({ ok: true });
    expect(plugin.getContent()).toBe(
      "- [ ] New text #work |[date:: 2026-01-05] |[time:: 09:00]"
    );
  });

  it("keeps checked state and tasks-format fields", async () => {
    const plugin = makePlugin("- [x] Old 📅 2026-01-05 ⏰ 11:00");
    const t = task({
      line: 0,
      format: "tasks",
      checked: true,
      text: "Old",
      date: "2026-01-05",
      time: "11:00",
    });
    expect(await updateTaskText(plugin, t, "Renamed")).toEqual({ ok: true });
    expect(plugin.getContent()).toBe("- [x] Renamed 📅 2026-01-05 ⏰ 11:00");
  });

  it("preserves quote prefix", async () => {
    const plugin = makePlugin("> - [ ] Quoted |[date:: 2026-01-05]");
    const t = task({
      line: 0,
      format: "legacy",
      text: "Quoted",
      date: "2026-01-05",
    });
    expect(await updateTaskText(plugin, t, "Still quoted")).toEqual({ ok: true });
    expect(plugin.getContent()).toBe("> - [ ] Still quoted |[date:: 2026-01-05]");
  });
});

describe("multi-line files", () => {
  it("only modifies the targeted line", async () => {
    const plugin = makePlugin(
      ["# Heading", "- [ ] First |[date:: 2026-01-05]", "- [ ] Second |[date:: 2026-01-05]"].join(
        "\n"
      )
    );
    const t = task({ line: 2, format: "legacy", date: "2026-01-05", text: "Second" });
    expect(await toggleTask(plugin, t)).toEqual({ ok: true });
    expect(plugin.getContent()).toBe(
      ["# Heading", "- [ ] First |[date:: 2026-01-05]", "- [x] Second |[date:: 2026-01-05]"].join(
        "\n"
      )
    );
  });
});
