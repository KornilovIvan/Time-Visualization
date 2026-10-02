import { describe, expect, it } from "vitest";
import {
  arcPieces,
  assignLanes,
  eventsForClock,
  eventsForMode,
  facePieces,
  formatHMS,
  handAngles,
  parseClockSpan,
  polar,
  spanContains,
  spanIsPast,
} from "../clock";

describe("parseClockSpan", () => {
  it("reads a bare time as a short mark", () => {
    expect(parseClockSpan("09:30")).toEqual({ start: 570, end: 578, ranged: false });
  });

  it("reads a range with a hyphen, dash, or spaces", () => {
    expect(parseClockSpan("09:30-10:00")).toEqual({ start: 570, end: 600, ranged: true });
    expect(parseClockSpan("09:30–10:00")).toEqual({ start: 570, end: 600, ranged: true });
    expect(parseClockSpan("09:30 - 10:00")).toEqual({ start: 570, end: 600, ranged: true });
  });

  it("wraps a range that crosses midnight", () => {
    expect(parseClockSpan("23:00-01:00")).toEqual({ start: 1380, end: 1500, ranged: true });
  });

  it("rejects a clock time that is not a time", () => {
    expect(parseClockSpan(undefined)).toBeNull();
    expect(parseClockSpan("")).toBeNull();
    expect(parseClockSpan("24:00")).toBeNull();
    expect(parseClockSpan("morning")).toBeNull();
  });
});

describe("assignLanes", () => {
  it("keeps back-to-back spans on the outer ring", () => {
    expect(
      assignLanes([
        { start: 540, end: 600 },
        { start: 600, end: 660 },
      ])
    ).toEqual([0, 0]);
  });

  it("moves an overlap onto the inner ring", () => {
    expect(
      assignLanes([
        { start: 540, end: 660 },
        { start: 600, end: 720 },
      ])
    ).toEqual([0, 1]);
  });

  it("treats a midnight wrap as overlapping the early morning", () => {
    const lanes = assignLanes([
      { start: 1380, end: 1500 },
      { start: 30, end: 90 },
    ]);
    expect(lanes).toEqual([1, 0]);
  });
});

describe("span timing", () => {
  it("marks a finished span as past and a wrapping span after its tail as past", () => {
    expect(spanIsPast(540, 600, 600)).toBe(true);
    expect(spanIsPast(540, 600, 570)).toBe(false);
    expect(spanIsPast(1380, 1500, 120)).toBe(true);
    expect(spanIsPast(1380, 1500, 30)).toBe(false);
    expect(spanContains(1380, 1500, 30)).toBe(true);
    expect(spanContains(540, 600, 540)).toBe(true);
    expect(spanContains(540, 600, 600)).toBe(false);
  });
});

describe("formatHMS", () => {
  it("writes hours, minutes and seconds", () => {
    expect(formatHMS(new Date(2026, 9, 2, 15, 4, 7))).toBe("15:04:07");
  });
});

describe("handAngles", () => {
  it("puts 3:00 on the hour, with the minute and second hands at 12", () => {
    const angles = handAngles(new Date(2026, 9, 2, 15, 0, 0, 0));
    expect(angles.hour).toBeCloseTo(90);
    expect(angles.minute).toBeCloseTo(0);
    expect(angles.second).toBeCloseTo(0);
  });

  it("creeps the hour hand with the minutes and the minute hand with the seconds", () => {
    const angles = handAngles(new Date(2026, 9, 2, 15, 30, 30, 0));
    expect(angles.hour).toBeCloseTo(105.25);
    expect(angles.minute).toBeCloseTo(183);
    expect(angles.second).toBeCloseTo(180);
  });
});

describe("arc geometry", () => {
  it("puts midnight at the top", () => {
    const [x, y] = polar(200, 200, 100, 0);
    expect(x).toBeCloseTo(200);
    expect(y).toBeCloseTo(100);
  });

  it("splits a full-day span and a midnight wrap", () => {
    expect(arcPieces(0, 1440)).toEqual([
      [0, 720],
      [720, 1440],
    ]);
    expect(arcPieces(1380, 1500)).toEqual([
      [1380, 1440],
      [0, 60],
    ]);
  });

  it("puts 3 o'clock on the right of a 12-hour face", () => {
    const [x, y] = polar(200, 200, 100, 180, 720);
    expect(x).toBeCloseTo(300);
    expect(y).toBeCloseTo(200);
  });

  it("splits a noon crossing onto the 12-hour face", () => {
    expect(facePieces(660, 780, 720)).toEqual([
      [660, 720],
      [0, 60],
    ]);
  });

  it("lays morning on the inner row and afternoon on the outer", () => {
    const events = eventsForMode(
      [
        { time: "09:00-10:00", text: "Morning", filePath: "A.md", checked: false },
        { time: "15:00-16:00", text: "Afternoon", filePath: "B.md", checked: false },
        { time: "11:30-12:30", text: "Noon", filePath: "C.md", checked: false },
      ],
      "rows"
    );
    expect(events[0].draws).toEqual([{ start: 540, end: 600, lane: 1 }]);
    expect(events[1].draws).toEqual([{ start: 180, end: 240, lane: 0 }]);
    expect(events[2].draws).toEqual([
      { start: 690, end: 720, lane: 1 },
      { start: 0, end: 30, lane: 0 },
    ]);
  });

  it("stacks 9am and 9pm on the two rings of a 12-hour clock", () => {
    const events = eventsForMode(
      [
        { time: "09:00-10:00", text: "Morning", filePath: "A.md", checked: false },
        { time: "21:00-22:00", text: "Night", filePath: "B.md", checked: false },
      ],
      "12"
    );
    expect(events.map((event) => event.lane)).toEqual([0, 1]);
    expect(events[0].draws[0]).toMatchObject({ start: 540, end: 600 });
    expect(events[1].draws[0]).toMatchObject({ start: 540, end: 600, lane: 1 });
  });

  it("builds one event per timed task and parks the overlap inside", () => {
    const events = eventsForClock([
      { time: "09:00-11:00", text: "Write", filePath: "A.md", checked: false },
      { time: "10:00-12:00", text: "Call", filePath: "B.md", checked: false },
      { time: undefined, text: "Anytime", filePath: "A.md", checked: false },
    ]);
    expect(events.map((event) => event.label)).toEqual(["Write", "Call"]);
    expect(events.map((event) => event.lane)).toEqual([0, 1]);
  });
});
