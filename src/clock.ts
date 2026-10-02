/**
 * Dial geometry. Midnight (24h) or 12 (12h) is at the top; minutes run clockwise.
 * A bare `HH:MM` is a short mark. `HH:MM-HH:MM` (hyphen or dash) is an arc.
 *
 * Modes:
 *   24   — one day around the rim; overlaps step inward
 *   12   — an ordinary 12-hour face; tasks share that rim
 *   rows — the same 12-hour face, morning on the inner ring and
 *          afternoon on the outer, so the whole day fits in two rows
 */

const POINT_MINUTES = 8;

const PALETTE = [
  "#5b9fd4",
  "#d4924a",
  "#6aaf7a",
  "#c47aaa",
  "#7d82d6",
  "#d47862",
  "#4eaea8",
  "#c4a84e",
];

export const CLOCK = {
  size: 400,
  cx: 200,
  cy: 200,
  tickOut: 170,
  hourIn: 154,
  quarterIn: 160,
  fiveIn: 165,
  labelR: 186,
  laneOuter: 138,
  laneInner: 114,
  laneStroke: 16,
  needleIn: 58,
  needleOut: 166,
  glowIn: 104,
  glowOut: 171,
  glowTail: 26,
} as const;

export interface ClockSpan {
  /** Minutes from midnight. May exceed 1440 when the range crosses midnight. */
  start: number;
  end: number;
  /** False when the task has a start but no end — drawn as a short mark. */
  ranged: boolean;
}

export interface ClockTask {
  time?: string;
  text: string;
  filePath: string;
  checked: boolean;
}

/** 24 = day dial, 12 = ordinary clock, rows = 12-hour face with two task rings. */
export type ClockMode = "24" | "12" | "rows";

export const CLOCK_MODES: ReadonlyArray<[ClockMode, string]> = [
  ["24", "24h"],
  ["12", "12h"],
  ["rows", "2 rows"],
];

/** One painted arc. `start`/`end` are minutes on the face (0–1440 or 0–720). */
export interface ClockDraw {
  start: number;
  end: number;
  /** 0 = outer ring, 1 = inner ring. */
  lane: 0 | 1;
}

export interface ClockEvent {
  /** Absolute minutes from midnight, used to tell past from current. */
  start: number;
  end: number;
  ranged: boolean;
  lane: 0 | 1;
  draws: ClockDraw[];
  label: string;
  timeLabel: string;
  color: string;
  done: boolean;
}

const RANGE_RE = /^(\d{1,2}):(\d{2})(?:\s*[-–—]\s*(\d{1,2}):(\d{2}))?$/;

function minutes(h: number, m: number): number | null {
  if (h > 23 || m > 59) return null;
  return h * 60 + m;
}

/** Parse a task time into a dial span. Returns null when it is not a clock time. */
export function parseClockSpan(time: string | undefined): ClockSpan | null {
  if (!time) return null;
  const match = RANGE_RE.exec(time.trim());
  if (!match) return null;
  const start = minutes(Number(match[1]), Number(match[2]));
  if (start === null) return null;
  if (!match[3]) {
    return { start, end: start + POINT_MINUTES, ranged: false };
  }
  let end = minutes(Number(match[3]), Number(match[4]));
  if (end === null || end === start) {
    return { start, end: start + POINT_MINUTES, ranged: false };
  }
  if (end < start) end += 1440;
  return { start, end, ranged: true };
}

function pieces(span: { start: number; end: number }): Array<[number, number]> {
  if (span.end <= 1440) return [[span.start, span.end]];
  const out: Array<[number, number]> = [];
  if (span.start < 1440) out.push([span.start, 1440]);
  const tail = span.end - 1440;
  if (tail > 0) out.push([0, tail]);
  return out;
}

function rangesOverlap(
  a: { start: number; end: number },
  b: { start: number; end: number }
): boolean {
  for (const pa of pieces(a)) {
    for (const pb of pieces(b)) {
      if (pa[0] < pb[1] && pb[0] < pa[1]) return true;
    }
  }
  return false;
}

/** Lane 0 is the outer ring. A span moves inward only when it overlaps one already there. */
export function assignLanes(spans: ReadonlyArray<{ start: number; end: number }>): number[] {
  const lanes = spans.map(() => 0);
  const occupied: Array<Array<{ start: number; end: number }>> = [[], []];
  const order = spans
    .map((_, i) => i)
    .sort((a, b) => spans[a].start - spans[b].start || spans[a].end - spans[b].end);
  for (const i of order) {
    const span = spans[i];
    const lane = occupied[0].some((other) => rangesOverlap(other, span)) ? 1 : 0;
    lanes[i] = lane;
    occupied[lane].push(span);
  }
  return lanes;
}

export function colorForPath(path: string): string {
  let hash = 0;
  for (let i = 0; i < path.length; i++) {
    hash = (Math.imul(hash, 31) + path.charCodeAt(i)) | 0;
  }
  return PALETTE[(hash >>> 0) % PALETTE.length];
}

export function faceCycle(mode: ClockMode): number {
  return mode === "24" ? 1440 : 720;
}

/** Map a span onto one turn of `cycle`. A full turn becomes two semicircles. */
export function facePieces(start: number, end: number, cycle: number): Array<[number, number]> {
  if (!(end > start)) return [];
  if (cycle === 1440) return arcPieces(start, end);
  const out: Array<[number, number]> = [];
  let cursor = start;
  let guard = 0;
  while (cursor < end && guard++ < 8) {
    const periodEnd = (Math.floor(cursor / cycle) + 1) * cycle;
    const stop = Math.min(end, periodEnd);
    const origin = periodEnd - cycle;
    const a = cursor - origin;
    const b = stop - origin;
    if (b - a >= cycle - 0.5) out.push([0, cycle / 2], [cycle / 2, cycle]);
    else if (b > a) out.push([a, b]);
    cursor = stop;
  }
  return out;
}

function pushDraw(out: ClockDraw[], start: number, end: number, lane: 0 | 1, cycle: number): void {
  if (end - start >= cycle - 0.5) {
    out.push({ start: 0, end: cycle / 2, lane }, { start: cycle / 2, end: cycle, lane });
    return;
  }
  if (end > start) out.push({ start, end, lane });
}

/** Morning (00–12) on the inner ring, afternoon (12–24) on the outer. */
function drawsForRows(span: ClockSpan): ClockDraw[] {
  const out: ClockDraw[] = [];
  let cursor = span.start;
  let guard = 0;
  while (cursor < span.end && guard++ < 8) {
    const origin = Math.floor(cursor / 720) * 720;
    const stop = Math.min(span.end, origin + 720);
    const morning = Math.floor(origin / 720) % 2 === 0;
    pushDraw(out, cursor - origin, stop - origin, morning ? 1 : 0, 720);
    cursor = stop;
  }
  return out;
}

function assignFaceLanes(spans: ClockSpan[], cycle: number): number[] {
  const faces = spans.map((span) => facePieces(span.start, span.end, cycle));
  const lanes = spans.map(() => 0);
  const occupied: Array<Array<[number, number]>> = [[], []];
  const order = spans
    .map((_, i) => i)
    .sort((a, b) => spans[a].start - spans[b].start || spans[a].end - spans[b].end);
  for (const i of order) {
    const pieces = faces[i];
    const hit = occupied[0].some((other) =>
      pieces.some((piece) => piece[0] < other[1] && other[0] < piece[1])
    );
    const lane: 0 | 1 = hit ? 1 : 0;
    lanes[i] = lane;
    occupied[lane].push(...pieces);
  }
  return lanes;
}

function eventFrom(
  task: ClockTask,
  span: ClockSpan,
  lane: 0 | 1,
  draws: ClockDraw[]
): ClockEvent {
  return {
    start: span.start,
    end: span.end,
    ranged: span.ranged,
    lane,
    draws,
    label: task.text,
    timeLabel: task.time ?? "",
    color: colorForPath(task.filePath),
    done: task.checked,
  };
}

export function eventsForMode(tasks: readonly ClockTask[], mode: ClockMode): ClockEvent[] {
  const parsed: Array<{ task: ClockTask; span: ClockSpan }> = [];
  for (const task of tasks) {
    const span = parseClockSpan(task.time);
    if (span) parsed.push({ task, span });
  }
  if (mode === "rows") {
    return parsed.map((item) => {
      const draws = drawsForRows(item.span);
      const lane = draws[0]?.lane === 1 ? 1 : 0;
      return eventFrom(item.task, item.span, lane, draws);
    });
  }
  const cycle = faceCycle(mode);
  const lanes =
    mode === "24"
      ? assignLanes(parsed.map((item) => item.span))
      : assignFaceLanes(parsed.map((item) => item.span), cycle);
  return parsed.map((item, i) => {
    const lane: 0 | 1 = lanes[i] === 1 ? 1 : 0;
    const draws: ClockDraw[] = [];
    for (const [start, end] of facePieces(item.span.start, item.span.end, cycle)) {
      pushDraw(draws, start, end, lane, cycle);
    }
    return eventFrom(item.task, item.span, lane, draws);
  });
}

export function eventsForClock(tasks: readonly ClockTask[]): ClockEvent[] {
  return eventsForMode(tasks, "24");
}

/** True when this span has already finished on a today-dial. */
export function spanIsPast(start: number, end: number, nowMin: number): boolean {
  if (end <= 1440) return nowMin >= end;
  const tail = end - 1440;
  return nowMin >= tail && nowMin < start;
}

export function spanContains(start: number, end: number, nowMin: number): boolean {
  if (end <= 1440) return nowMin >= start && nowMin < end;
  return nowMin >= start || nowMin < end - 1440;
}

/** Split a span into drawable arcs. A full turn is two semicircles. */
export function arcPieces(start: number, end: number): Array<[number, number]> {
  if (!(end > start)) return [];
  if (end - start >= 1439) return [[0, 720], [720, 1440]];
  if (end <= 1440) return [[start, end]];
  const out: Array<[number, number]> = [];
  if (start < 1440) out.push([start, 1440]);
  const tail = end - 1440;
  if (tail > 0) out.push([0, tail]);
  return out;
}

export function polar(
  cx: number,
  cy: number,
  r: number,
  minutes: number,
  cycle = 1440
): [number, number] {
  const angle = (minutes / cycle) * Math.PI * 2 - Math.PI / 2;
  return [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
}

function fmt(n: number): string {
  return n.toFixed(2);
}

export function arcPath(
  cx: number,
  cy: number,
  r: number,
  startMin: number,
  endMin: number,
  cycle = 1440
): string {
  const sweep = endMin - startMin;
  if (sweep <= 0.05) return "";
  const [x0, y0] = polar(cx, cy, r, startMin, cycle);
  const [x1, y1] = polar(cx, cy, r, endMin, cycle);
  const large = sweep > cycle / 2 ? 1 : 0;
  return `M ${fmt(x0)} ${fmt(y0)} A ${r} ${r} 0 ${large} 1 ${fmt(x1)} ${fmt(y1)}`;
}

/** Ring sector from startMin to endMin, between two radii. Angles may be negative. */
export function sectorPath(
  cx: number,
  cy: number,
  rInner: number,
  rOuter: number,
  startMin: number,
  endMin: number,
  cycle = 1440
): string {
  const sweep = endMin - startMin;
  if (sweep <= 0.05) return "";
  const [x0, y0] = polar(cx, cy, rOuter, startMin, cycle);
  const [x1, y1] = polar(cx, cy, rOuter, endMin, cycle);
  const [x2, y2] = polar(cx, cy, rInner, endMin, cycle);
  const [x3, y3] = polar(cx, cy, rInner, startMin, cycle);
  const large = sweep > cycle / 2 ? 1 : 0;
  return `M ${fmt(x0)} ${fmt(y0)} A ${rOuter} ${rOuter} 0 ${large} 1 ${fmt(x1)} ${fmt(y1)} L ${fmt(x2)} ${fmt(y2)} A ${rInner} ${rInner} 0 ${large} 0 ${fmt(x3)} ${fmt(y3)} Z`;
}

/**
 * Hand angles for a 12-hour face, in degrees clockwise from 12.
 * The hour hand creeps as minutes pass, the minute hand creeps as seconds pass,
 * and the second hand sweeps with the millisecond — the same motion as a clock.
 */
export function handAngles(now: Date): { hour: number; minute: number; second: number } {
  const second = now.getSeconds() + now.getMilliseconds() / 1000;
  const minute = now.getMinutes() + second / 60;
  const hour = (now.getHours() % 12) + minute / 60;
  return {
    hour: (hour / 12) * 360,
    minute: (minute / 60) * 360,
    second: (second / 60) * 360,
  };
}

export function minutesOf(now: Date): number {
  return (
    now.getHours() * 60 +
    now.getMinutes() +
    now.getSeconds() / 60 +
    now.getMilliseconds() / 60000
  );
}

export function formatHM(now: Date): string {
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  return `${h}:${m}`;
}

export function formatHMS(now: Date): string {
  const s = String(now.getSeconds()).padStart(2, "0");
  return `${formatHM(now)}:${s}`;
}

export function shortLabel(text: string, max = 22): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1) + "…";
}
