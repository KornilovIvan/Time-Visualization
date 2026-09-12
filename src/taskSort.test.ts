import { describe, expect, it } from "vitest";
import type { ParsedTask } from "./parser";
import {
  compareGroups,
  dayOrderIndex,
  dayPriorityKey,
  dayPriorityPaths,
  findTaskInsertIndex,
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
  it("orders equal-priority timed groups by earliest time (un-toggle reinsert)", () => {
    // Completing then restoring A must not append it after B/C when A is earlier
    expect(
      compareGroups(
        { path: "A.md", timed: true, earliestTime: "09:00" },
        { path: "B.md", timed: true, earliestTime: "10:00" },
        base,
        DAY
      )
    ).toBeLessThan(0);
    expect(
      compareGroups(
        { path: "C.md", timed: true, earliestTime: "11:00" },
        { path: "A.md", timed: true, earliestTime: "09:00" },
        base,
        DAY
      )
    ).toBeGreaterThan(0);
  });

  it("prefers dayOrder over earliest time", () => {
    const settings: TaskSortSettings = {
      ...base,
      dayOrder: { [DAY]: ["B.md", "A.md"] },
    };
    expect(
      compareGroups(
        { path: "B.md", timed: true, earliestTime: "15:00" },
        { path: "A.md", timed: true, earliestTime: "08:00" },
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

  it("orders timed notes by earliest time when priorities are equal", () => {
    // Simulate: A was completed (removed), B and C remain; restoring A must
    // sort as A → B → C by time, not append after C
    const remaining = sortedGroups(
      { ...base, timeOverPriority: true },
      [task("B.md", { time: "10:00" }), task("C.md", { time: "11:00" })],
      DAY
    );
    expect(remaining.map((g) => g.path)).toEqual(["B.md", "C.md"]);

    const restored = sortedGroups(
      { ...base, timeOverPriority: true },
      [
        task("B.md", { time: "10:00" }),
        task("C.md", { time: "11:00" }),
        task("A.md", { time: "09:00" }),
      ],
      DAY
    );
    expect(restored.filter((g) => g.timed === true).map((g) => g.path)).toEqual([
      "A.md",
      "B.md",
      "C.md",
    ]);
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

  it("keeps all notes under a dayOrder folder together (not one at the bottom)", () => {
    // Bug: day list had only one note from the folder; the sibling sank below
    // everything in dayOrder despite sharing the global folder priority.
    const settings: TaskSortSettings = {
      ...base,
      priorities: ["Work"],
      dayOrder: { [DAY]: ["Work/a.md", "Solo.md"] },
    };
    const groups = sortedGroups(
      settings,
      [task("Solo.md"), task("Work/b.md"), task("Work/a.md"), task("Z.md")],
      DAY
    );
    const paths = groups.map((g) => g.path);
    expect(paths.indexOf("Work/a.md")).toBeLessThan(paths.indexOf("Solo.md"));
    expect(paths.indexOf("Work/b.md")).toBeLessThan(paths.indexOf("Solo.md"));
    expect(paths.indexOf("Solo.md")).toBeLessThan(paths.indexOf("Z.md"));
  });

  it("honors a folder entry stored in dayOrder", () => {
    const groups = sortedGroups(
      {
        ...base,
        priorities: ["Work"],
        dayOrder: { [DAY]: ["Solo.md", "Work"] },
      },
      [task("Work/a.md"), task("Work/b.md"), task("Solo.md")],
      DAY
    );
    expect(groups.map((g) => g.path)).toEqual(["Solo.md", "Work/a.md", "Work/b.md"]);
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
    // No day override — equal priority falls back to path order
    expect(groups.map((g) => g.path)).toEqual(["A.md", "B.md"]);
  });
});

describe("findTaskInsertIndex", () => {
  it("reinserts a timed task by time among siblings (complete then uncomplete)", () => {
    const siblings = [
      task("N.md", { line: 1, time: "09:00" }),
      task("N.md", { line: 3, time: "11:00" }),
    ];
    // Mid-day task was completed and returns between 09:00 and 11:00
    expect(findTaskInsertIndex(siblings, task("N.md", { line: 2, time: "10:00" }))).toBe(1);
    // Earlier than all
    expect(findTaskInsertIndex(siblings, task("N.md", { line: 0, time: "08:00" }))).toBe(0);
    // Later than all
    expect(findTaskInsertIndex(siblings, task("N.md", { line: 4, time: "12:00" }))).toBe(2);
  });

  it("ties equal times by line number", () => {
    const siblings = [task("N.md", { line: 1, time: "09:00" }), task("N.md", { line: 5, time: "09:00" })];
    expect(findTaskInsertIndex(siblings, task("N.md", { line: 3, time: "09:00" }))).toBe(1);
  });
});

describe("dayPriorityKey / dayPriorityPaths / dayOrderIndex", () => {
  it("maps notes under a global folder to that folder key", () => {
    expect(dayPriorityKey(["Work", "Other.md"], "Work/a.md")).toBe("Work");
    expect(dayPriorityKey(["Work", "Other.md"], "Other.md")).toBe("Other.md");
    expect(dayPriorityKey(["Work"], "Alone.md")).toBe("Alone.md");
  });

  it("collapses folder notes into one day-menu row", () => {
    const paths = dayPriorityPaths(
      { ...base, priorities: ["Work"] },
      [task("Work/b.md"), task("Solo.md"), task("Work/a.md")],
      DAY
    );
    expect(paths).toEqual(["Work", "Solo.md"]);
  });

  it("dayOrderIndex matches folders and inherits sibling note ranks", () => {
    const day = ["Work/a.md", "Solo.md"];
    const priorities = ["Work"];
    expect(dayOrderIndex(day, "Work/a.md", priorities)).toBe(0);
    expect(dayOrderIndex(day, "Work/b.md", priorities)).toBe(0);
    expect(dayOrderIndex(day, "Solo.md", priorities)).toBe(1);
    expect(dayOrderIndex(["Work", "Solo.md"], "Work/b.md", priorities)).toBe(0);
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
