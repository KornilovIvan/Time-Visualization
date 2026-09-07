import { describe, expect, it } from "vitest";
import {
  MONTHS_EN,
  WEEKDAYS_FULL_EN,
  WEEKDAYS_SHORT_EN,
  addDays,
  fileName,
  isoWeekNumber,
  startOfWeek,
} from "./dates";

describe("calendar labels", () => {
  it("exposes 12 months and 7 weekdays starting on Monday", () => {
    expect(MONTHS_EN).toHaveLength(12);
    expect(MONTHS_EN[0]).toBe("January");
    expect(WEEKDAYS_SHORT_EN).toEqual(["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]);
    expect(WEEKDAYS_FULL_EN[0]).toBe("Monday");
    expect(WEEKDAYS_FULL_EN).toHaveLength(7);
  });
});

describe("startOfWeek", () => {
  it("returns Monday for a mid-week date", () => {
    // Wednesday 2026-01-07 -> Monday 2026-01-05
    const mon = startOfWeek(new Date(2026, 0, 7));
    expect(mon.getFullYear()).toBe(2026);
    expect(mon.getMonth()).toBe(0);
    expect(mon.getDate()).toBe(5);
    expect(mon.getDay()).toBe(1);
  });

  it("keeps Monday unchanged", () => {
    const mon = startOfWeek(new Date(2026, 0, 5));
    expect(mon.getDate()).toBe(5);
    expect(mon.getDay()).toBe(1);
  });

  it("maps Sunday back to the previous Monday", () => {
    // Sunday 2026-01-11 -> Monday 2026-01-05
    const mon = startOfWeek(new Date(2026, 0, 11));
    expect(mon.getDate()).toBe(5);
    expect(mon.getDay()).toBe(1);
  });
});

describe("fileName", () => {
  it("returns the last path segment without .md", () => {
    expect(fileName("Notes/Daily/2026-01-05.md")).toBe("2026-01-05");
    expect(fileName("solo.md")).toBe("solo");
  });

  it("is case-insensitive for the .md suffix", () => {
    expect(fileName("Folder/Note.MD")).toBe("Note");
  });

  it("leaves names without .md as-is", () => {
    expect(fileName("Folder/readme")).toBe("readme");
  });
});

describe("addDays", () => {
  it("adds and subtracts days in local calendar space", () => {
    expect(addDays(new Date(2026, 0, 5), 3).getDate()).toBe(8);
    expect(addDays(new Date(2026, 0, 5), -2).getDate()).toBe(3);
  });

  it("crosses month and year boundaries", () => {
    const nextMonth = addDays(new Date(2026, 0, 31), 1);
    expect(nextMonth.getMonth()).toBe(1);
    expect(nextMonth.getDate()).toBe(1);

    const nextYear = addDays(new Date(2026, 11, 31), 1);
    expect(nextYear.getFullYear()).toBe(2027);
    expect(nextYear.getMonth()).toBe(0);
    expect(nextYear.getDate()).toBe(1);
  });

  it("does not mutate the input date", () => {
    const d = new Date(2026, 5, 15);
    addDays(d, 10);
    expect(d.getDate()).toBe(15);
  });
});

describe("isoWeekNumber", () => {
  it("returns week 1 for early January dates in that ISO week", () => {
    // Thursday 2026-01-01 is in ISO week 1
    expect(isoWeekNumber(new Date(2026, 0, 1))).toBe(1);
  });

  it("returns a known mid-year week", () => {
    // Monday 2026-06-01 — ISO week 23
    expect(isoWeekNumber(new Date(2026, 5, 1))).toBe(23);
  });

  it("can assign late December to week 1 of the next ISO year", () => {
    // Thursday 2026-12-31 belongs to ISO week 53 of 2026
    expect(isoWeekNumber(new Date(2026, 11, 31))).toBe(53);
  });
});
