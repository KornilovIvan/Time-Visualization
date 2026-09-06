import { describe, expect, it } from "vitest";
import type { ParsedTask } from "./parser";
import {
  compareGroups,
  globalPriorityIndex,
  hasGlobalPriority,
  mergeAdjacentSameNoteGroups,
  priorityEntryMatches,
  sortedGroupPaths,
  sortedGroups,
  splitTimedGroups,
  type TaskGroup,
  type TaskSortSettings,
} from "./taskSort";

const DAY = "2026-01-01";

const base: TaskSortSettings = {
  priorities: [],
  dayOrder: {},
  timeOverPriority: false,
};

function task(
  filePath: string,
  opts: { line?: number; time?: string; text?: string } = {}
): ParsedTask {
  return {
    filePath,
    line: opts.line ?? 0,
    raw: "",
    checked: false,
    text: opts.text ?? "task",
    tags: [],
    time: opts.time,
    format: "legacy",
  };
}

function pathsTimed(groups: TaskGroup[]): Array<{ path: string; timed: boolean | null }> {
  return groups.map((g) => ({ path: g.path, timed: g.timed }));
}

describe("priorityEntryMatches / globalPriorityIndex", () => {
  it("matches exact notes and folder prefixes", () => {
    expect(priorityEntryMatches("A.md", "A.md")).toBe(true);
    expect(priorityEntryMatches("A.md", "B.md")).toBe(false);
    expect(priorityEntryMatches("Proj", "Proj/note.md")).toBe(true);
    expect(priorityEntryMatches("Proj", "Proj")).toBe(true);
    expect(priorityEntryMatches("Proj", "Other/note.md")).toBe(false);
    expect(priorityEntryMatches("Pro", "Proj/note.md")).toBe(false);
  });

  it("picks the best (lowest) matching priority index", () => {
    const priorities = ["Other.md", "Proj", "Proj/a.md"];
    expect(globalPriorityIndex(priorities, "Proj/a.md")).toBe(1); // folder before more specific later
    expect(globalPriorityIndex(priorities, "Alone.md")).toBeUndefined();
    expect(hasGlobalPriority(priorities, "Proj/b.md")).toBe(true);
    expect(hasGlobalPriority(priorities, "Alone.md")).toBe(false);
  });
});

describe("splitTimedGroups", () => {
  it("splits each note into timed and untimed buckets", () => {
    const groups = splitTimedGroups([
      task("A.md", { line: 1, time: "09:00" }),
      task("A.md", { line: 2 }),
      task("B.md", { line: 1 }),
    ]);
    expect(pathsTimed(groups)).toEqual([
      { path: "A.md", timed: true },
      { path: "A.md", timed: false },
      { path: "B.md", timed: false },
    ]);
    expect(groups[0].tasks).toHaveLength(1);
    expect(groups[1].tasks).toHaveLength(1);
  });

  it("omits empty timed or untimed buckets", () => {
    expect(pathsTimed(splitTimedGroups([task("A.md", { time: "10:00" })]))).toEqual([
      { path: "A.md", timed: true },
    ]);
    expect(pathsTimed(splitTimedGroups([task("A.md")]))).toEqual([
      { path: "A.md", timed: false },
    ]);
  });
});

describe("mergeAdjacentSameNoteGroups", () => {
  it("merges consecutive same-note buckets and sets timed to null", () => {
    const merged = mergeAdjacentSameNoteGroups([
      { path: "A.md", tasks: [task("A.md", { time: "09:00" })], timed: true },
      { path: "A.md", tasks: [task("A.md")], timed: false },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].timed).toBeNull();
    expect(merged[0].tasks).toHaveLength(2);
  });

  it("keeps same-note buckets split when another note sits between", () => {
    const merged = mergeAdjacentSameNoteGroups([
      { path: "A.md", tasks: [task("A.md", { time: "09:00" })], timed: true },
      { path: "B.md", tasks: [task("B.md")], timed: false },
      { path: "A.md", tasks: [task("A.md")], timed: false },
    ]);
    expect(pathsTimed(merged)).toEqual([
      { path: "A.md", timed: true },
      { path: "B.md", timed: false },
      { path: "A.md", timed: false },
    ]);
  });
});

describe("compareGroups", () => {
  it("puts timed groups above untimed when timeOverPriority is on", () => {
    const settings: TaskSortSettings = { ...base, timeOverPriority: true };
    expect(
      compareGroups(
        { path: "B.md", timed: true },
        { path: "A.md", timed: false },
        settings,
        DAY
      )
    ).toBeLessThan(0);
    expect(
      compareGroups(
        { path: "A.md", timed: false },
        { path: "B.md", timed: true },
        settings,
        DAY
      )
    ).toBeGreaterThan(0);
  });

  it("respects dayOrder before path when time class matches", () => {
    const settings: TaskSortSettings = {
      ...base,
      timeOverPriority: true,
      dayOrder: { [DAY]: ["Z.md", "A.md"] },
    };
    expect(
      compareGroups(
        { path: "Z.md", timed: true },
        { path: "A.md", timed: true },
        settings,
        DAY
      )
    ).toBeLessThan(0);
  });

  it("puts same-note timed bucket above untimed", () => {
    expect(
      compareGroups(
        { path: "N.md", timed: true },
        { path: "N.md", timed: false },
        base,
        DAY
      )
    ).toBeLessThan(0);
  });

  it("orders by global priority when neither is in dayOrder", () => {
    const settings: TaskSortSettings = {
      ...base,
      priorities: ["B.md", "A.md"],
    };
    expect(
      compareGroups(
        { path: "B.md", timed: false },
        { path: "A.md", timed: false },
        settings,
        DAY
      )
    ).toBeLessThan(0);
  });

  it("prefers dayOrder over global priority", () => {
    const settings: TaskSortSettings = {
      ...base,
      priorities: ["A.md", "B.md"],
      dayOrder: { [DAY]: ["B.md", "A.md"] },
    };
    expect(
      compareGroups(
        { path: "B.md", timed: false },
        { path: "A.md", timed: false },
        settings,
        DAY
      )
    ).toBeLessThan(0);
  });
});

describe("sortedGroups", () => {
  it("merges adjacent same-note buckets when timeOverPriority is off", () => {
    const groups = sortedGroups(
      base,
      [task("A.md", { line: 1, time: "09:00" }), task("A.md", { line: 2 })],
      DAY
    );
    expect(pathsTimed(groups)).toEqual([{ path: "A.md", timed: null }]);
  });

  it("keeps timed above all untimed across notes when timeOverPriority is on", () => {
    const groups = sortedGroups(
      { ...base, timeOverPriority: true },
      [
        task("A.md", { line: 1 }),
        task("B.md", { line: 1, time: "10:00" }),
        task("A.md", { line: 2, time: "09:00" }),
      ],
      DAY
    );
    const timedFlags = groups.map((g) => g.timed === true);
    // All timed buckets before any untimed (stable order within each class)
    expect(timedFlags.indexOf(false)).toBeGreaterThan(timedFlags.lastIndexOf(true));
    expect(groups.filter((g) => g.timed === true).map((g) => g.path).sort()).toEqual([
      "A.md",
      "B.md",
    ]);
    expect(groups.filter((g) => g.timed === false).map((g) => g.path)).toEqual(["A.md"]);
  });

  it("applies dayOrder within the timed section", () => {
    const groups = sortedGroups(
      {
        ...base,
        timeOverPriority: true,
        dayOrder: { [DAY]: ["Z.md", "A.md"] },
      },
      [
        task("A.md", { time: "09:00" }),
        task("Z.md", { time: "10:00" }),
        task("M.md"),
      ],
      DAY
    );
    expect(pathsTimed(groups)).toEqual([
      { path: "Z.md", timed: true },
      { path: "A.md", timed: true },
      { path: "M.md", timed: false },
    ]);
  });

  it("applies global priority including folder entries", () => {
    const groups = sortedGroups(
      { ...base, priorities: ["Work", "Personal.md"] },
      [task("Personal.md"), task("Work/a.md"), task("Other.md")],
      DAY
    );
    expect(groups.map((g) => g.path)).toEqual([
      "Work/a.md",
      "Personal.md",
      "Other.md",
    ]);
  });

  it("lets dayOrder override global priority for that day", () => {
    const groups = sortedGroups(
      {
        ...base,
        priorities: ["A.md", "B.md"],
        dayOrder: { [DAY]: ["B.md", "A.md"] },
      },
      [task("A.md"), task("B.md")],
      DAY
    );
    expect(groups.map((g) => g.path)).toEqual(["B.md", "A.md"]);
  });

  it("ignores dayOrder keys for other dates", () => {
    const groups = sortedGroups(
      {
        ...base,
        dayOrder: { "2099-01-01": ["B.md", "A.md"] },
      },
      [task("A.md"), task("B.md")],
      DAY
    );
    // No day override — stable relative order from split (Map insertion by file)
    expect(groups.map((g) => g.path)).toEqual(["A.md", "B.md"]);
  });
});

describe("sortedGroupPaths", () => {
  it("returns unique note paths in display order", () => {
    const paths = sortedGroupPaths(
      { ...base, timeOverPriority: true, dayOrder: { [DAY]: ["B.md", "A.md"] } },
      [
        task("A.md"),
        task("B.md", { time: "09:00" }),
        task("A.md", { line: 2, time: "10:00" }),
      ],
      DAY
    );
    // Timed section first (B then A by dayOrder), then A untimed is not duplicated
    expect(paths).toEqual(["B.md", "A.md"]);
  });
});
