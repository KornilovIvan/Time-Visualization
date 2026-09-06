import { describe, expect, it } from "vitest";
import {
  formatDate,
  parseDate,
  parseTaskLine,
  startOfDay,
} from "./parser";

const FILE = "Notes/day.md";

function parse(
  raw: string,
  format: "legacy" | "tasks" | "custom" = "legacy",
  custom = ""
) {
  return parseTaskLine(raw, FILE, 3, format, custom);
}

describe("parseTaskLine", () => {
  it("returns null for non-task lines", () => {
    expect(parse("just text")).toBeNull();
    expect(parse("- not a checkbox")).toBeNull();
    expect(parse("")).toBeNull();
  });

  it("parses open and checked tasks with - or *", () => {
    const open = parse("- [ ] Buy milk");
    expect(open).toMatchObject({
      filePath: FILE,
      line: 3,
      checked: false,
      text: "Buy milk",
      tags: [],
      format: "legacy",
    });
    expect(open?.raw).toBe("- [ ] Buy milk");

    expect(parse("- [x] Done")?.checked).toBe(true);
    expect(parse("- [X] Done")?.checked).toBe(true);
    expect(parse("* [ ] Star")?.text).toBe("Star");
  });

  it("allows quote / callout prefixes", () => {
    expect(parse("> - [ ] Quoted")?.text).toBe("Quoted");
    expect(parse("> > - [ ] Nested")?.text).toBe("Nested");
  });

  describe("legacy format", () => {
    it("extracts date and time inline fields", () => {
      const t = parse("- [ ] Meet |[date:: 2026-08-05] |[time:: 09:30]");
      expect(t).toMatchObject({
        text: "Meet",
        date: "2026-08-05",
        time: "09:30",
        format: "legacy",
      });
    });

    it("keeps the last date/time when fields are duplicated", () => {
      const t = parse(
        "- [ ] Task |[date:: 2026-01-01] |[date:: 2026-02-02] |[time:: 08:00] |[time:: 10:00]"
      );
      expect(t?.date).toBe("2026-02-02");
      expect(t?.time).toBe("10:00");
    });

    it("ignores empty inline field values", () => {
      const t = parse("- [ ] Empty |[date:: ] |[time::  ]");
      expect(t?.date).toBeUndefined();
      expect(t?.time).toBeUndefined();
      expect(t?.text).toBe("Empty");
    });
  });

  describe("tasks format", () => {
    it("extracts emoji date and time", () => {
      const t = parse("- [ ] Ship 📅 2026-09-01 ⏰ 14:05", "tasks");
      expect(t).toMatchObject({
        text: "Ship",
        date: "2026-09-01",
        time: "14:05",
        format: "tasks",
      });
    });

    it("leaves other Tasks emoji fields in the text", () => {
      const t = parse("- [ ] Review ⏫ 📅 2026-09-01", "tasks");
      expect(t?.date).toBe("2026-09-01");
      expect(t?.text).toContain("⏫");
    });
  });

  describe("custom format", () => {
    const re = String.raw`@(?<date>\d{4}-\d{2}-\d{2})(?: T(?<time>\d{2}:\d{2}))?`;

    it("extracts named date/time groups and strips the match", () => {
      const t = parse("- [ ] Call @2026-03-15 T11:00", "custom", re);
      expect(t).toMatchObject({
        text: "Call",
        date: "2026-03-15",
        time: "11:00",
        format: "custom",
      });
    });

    it("skips extraction on invalid regex", () => {
      const t = parse("- [ ] Broken (", "custom", "(unclosed");
      expect(t).toMatchObject({ text: "Broken (", date: undefined, time: undefined });
    });

    it("does not strip text when regex has no named groups", () => {
      const t = parse("- [ ] Keep @2026-03-15", "custom", String.raw`@\d{4}-\d{2}-\d{2}`);
      expect(t?.text).toContain("@2026-03-15");
      expect(t?.date).toBeUndefined();
    });
  });

  describe("done marker", () => {
    it("reads [done::] in any format and falls back to its date", () => {
      const t = parse("- [x] Finished |[done:: 2026-08-05T12:00:00.000Z]");
      expect(t).toMatchObject({
        checked: true,
        text: "Finished",
        done: "2026-08-05T12:00:00.000Z",
        date: "2026-08-05",
      });
    });

    it("does not override an explicit date with done fallback", () => {
      const t = parse(
        "- [x] Both |[date:: 2026-01-01] |[done:: 2026-08-05T12:00:00.000Z]"
      );
      expect(t?.date).toBe("2026-01-01");
      expect(t?.done).toBe("2026-08-05T12:00:00.000Z");
    });
  });

  describe("tags", () => {
    it("collects tags and strips them from text", () => {
      const t = parse("- [ ] Write docs #work #focus");
      expect(t?.tags).toEqual(["#work", "#focus"]);
      expect(t?.text).toBe("Write docs");
    });

    it("rejects heading links and tags starting with a digit", () => {
      const t = parse("- [ ] See note#heading and #1bad #ok");
      expect(t?.tags).toEqual(["#ok"]);
      expect(t?.text).toContain("note#heading");
      expect(t?.text).toContain("#1bad");
    });
  });

  it("strips trailing pipes and calendar icons", () => {
    const t = parse("- [ ] Cleanup | 📅");
    expect(t?.text).toBe("Cleanup");
  });
});

describe("date helpers", () => {
  it("formatDate uses local YYYY-MM-DD", () => {
    expect(formatDate(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(formatDate(new Date(2026, 11, 31))).toBe("2026-12-31");
  });

  it("parseDate builds a local date from YYYY-MM-DD", () => {
    const d = parseDate("2026-08-05");
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7);
    expect(d.getDate()).toBe(5);
  });

  it("startOfDay zeroes the clock", () => {
    const d = startOfDay(new Date(2026, 5, 10, 15, 45, 30));
    expect(d.getHours()).toBe(0);
    expect(d.getMinutes()).toBe(0);
    expect(d.getSeconds()).toBe(0);
    expect(d.getDate()).toBe(10);
  });
});
