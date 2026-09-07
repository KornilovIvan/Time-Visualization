import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  normalizeLoadedSettings,
} from "./settings";

describe("normalizeLoadedSettings", () => {
  it("returns defaults when data is null or undefined", () => {
    expect(normalizeLoadedSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeLoadedSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it("merges saved fields over defaults", () => {
    const settings = normalizeLoadedSettings({
      recordDoneTime: true,
      timeOverPriority: true,
      dateFormat: "tasks",
      sources: ["Work"],
      includeTags: ["focus"],
      priorities: ["A.md"],
      dayOrder: { "2026-01-01": ["A.md"] },
    });
    expect(settings.recordDoneTime).toBe(true);
    expect(settings.timeOverPriority).toBe(true);
    expect(settings.dateFormat).toBe("tasks");
    expect(settings.sources).toEqual(["Work"]);
    expect(settings.includeTags).toEqual(["focus"]);
    expect(settings.priorities).toEqual(["A.md"]);
    expect(settings.dayOrder).toEqual({ "2026-01-01": ["A.md"] });
    expect(settings.openOnStartup).toBe(false);
    expect(settings.customDateRegex).toBe("");
  });

  it("migrates legacy priorities object to an empty array", () => {
    const settings = normalizeLoadedSettings({
      priorities: { "A.md": 1, "B.md": 2 } as unknown as string[],
    });
    expect(settings.priorities).toEqual([]);
  });

  it("resets invalid dayOrder shapes", () => {
    expect(
      normalizeLoadedSettings({
        dayOrder: ["A.md"] as unknown as Record<string, string[]>,
      }).dayOrder
    ).toEqual({});
    expect(
      normalizeLoadedSettings({
        dayOrder: null as unknown as Record<string, string[]>,
      }).dayOrder
    ).toEqual({});
  });

  it("resets invalid sources and includeTags arrays", () => {
    expect(
      normalizeLoadedSettings({
        sources: "Work" as unknown as string[],
        includeTags: { tag: true } as unknown as string[],
      })
    ).toMatchObject({
      sources: [],
      includeTags: [],
    });
  });

  it("keeps a valid priorities array", () => {
    expect(
      normalizeLoadedSettings({ priorities: ["Folder", "Note.md"] }).priorities
    ).toEqual(["Folder", "Note.md"]);
  });
});
