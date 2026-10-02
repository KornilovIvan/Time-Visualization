import { TFile } from "obsidian";
import type TimeVisualizationPlugin from "./main";
import { DONE_FIELD_RE, LEGACY_DATE_FIELD_RE, parseTaskLine, type ParsedTask } from "./parser";

/** File writes for tasks. Kept separate from TaskIndex (read/cache only). */

/** Outcome of a task file write — silent no-ops are not used. */
export type TaskWriteResult =
  | { ok: true }
  | {
      ok: false;
      /** not-found: file gone; stale-line: line missing or no longer a matching task;
          unsupported: format cannot be rewritten (e.g. custom move). */
      reason: "not-found" | "stale-line" | "unsupported";
    };

const OK: TaskWriteResult = { ok: true };

const TIME_FIELD_RE = /\[\s*time\s*::\s*([^\]]*)\]/;
const EMOJI_RANGE_RE = /⏰\s*(\d{1,2}:\d{2}\s*[-–—]\s*\d{1,2}:\d{2})/;

function clockMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function formatHM(total: number): string {
  const h = Math.floor(total / 60) % 24;
  const min = ((total % 60) + 60) % 60;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/**
 * If `value` is a range and `nowMin` is still inside it, return the same range
 * with the end cut to `nowMin`. A point time, or a range that has already
 * ended, is left unchanged (null).
 */
export function clipRangeToNow(value: string, nowMin: number): string | null {
  const m = /^(\d{1,2}:\d{2})(\s*[-–—]\s*)(\d{1,2}:\d{2})$/.exec(value.trim());
  if (!m) return null;
  const start = clockMinutes(m[1]);
  const end = clockMinutes(m[3]);
  if (start === null || end === null || start === end) return null;
  const wraps = end < start;
  const endAbs = wraps ? end + 1440 : end;
  const nowAbs = wraps && nowMin < start ? nowMin + 1440 : nowMin;
  if (nowAbs <= start || nowAbs >= endAbs) return null;
  return `${m[1]}${m[2]}${formatHM(nowMin)}`;
}

/** Rewrite a scheduled range on the line when it is completed early. */
function clipLineTime(line: string, now: Date): string {
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const field = TIME_FIELD_RE.exec(line);
  if (field) {
    const next = clipRangeToNow(field[1], nowMin);
    if (!next) return line;
    return line.replace(TIME_FIELD_RE, `[time:: ${next}]`);
  }
  const emoji = EMOJI_RANGE_RE.exec(line);
  if (!emoji) return line;
  const next = clipRangeToNow(emoji[1], nowMin);
  if (!next) return line;
  return line.replace(emoji[1], next);
}

type ResolvedLine = {
  file: TFile;
  lines: string[];
  lineIndex: number;
  line: string;
};

function sameTags(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const left = a.map((t) => t.toLowerCase()).sort();
  const right = b.map((t) => t.toLowerCase()).sort();
  return left.every((t, i) => t === right[i]);
}

/** Identity ignores checkbox state — it changes on toggle before reindex. */
function sameTaskIdentity(candidate: ParsedTask, target: ParsedTask): boolean {
  return (
    candidate.text === target.text &&
    (candidate.date ?? "") === (target.date ?? "") &&
    (candidate.time ?? "") === (target.time ?? "") &&
    sameTags(candidate.tags, target.tags)
  );
}

function lineMatchesTask(
  raw: string,
  index: number,
  task: ParsedTask,
  plugin: TimeVisualizationPlugin
): boolean {
  if (task.raw && raw === task.raw) return true;
  const parsed = parseTaskLine(
    raw,
    task.filePath,
    index,
    task.format,
    plugin.settings.customDateRegex
  );
  return !!parsed && sameTaskIdentity(parsed, task);
}

/**
 * Resolve the live line for a task. Prefer the remembered index when it still
 * matches; otherwise search the file so inserts/deletes above do not retarget
 * a different task.
 */
async function resolveTaskLine(
  plugin: TimeVisualizationPlugin,
  task: ParsedTask
): Promise<ResolvedLine | TaskWriteResult> {
  const file = plugin.app.vault.getAbstractFileByPath(task.filePath);
  if (!(file instanceof TFile)) return { ok: false, reason: "not-found" };
  const content = await plugin.app.vault.read(file);
  const lines = content.split("\n");

  if (task.line >= 0 && task.line < lines.length && lineMatchesTask(lines[task.line], task.line, task, plugin)) {
    return { file, lines, lineIndex: task.line, line: lines[task.line] };
  }

  const matches: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lineMatchesTask(lines[i], i, task, plugin)) matches.push(i);
  }
  if (matches.length === 0) return { ok: false, reason: "stale-line" };

  matches.sort((a, b) => Math.abs(a - task.line) - Math.abs(b - task.line));
  const lineIndex = matches[0];
  task.line = lineIndex;
  return { file, lines, lineIndex, line: lines[lineIndex] };
}

export async function toggleTask(
  plugin: TimeVisualizationPlugin,
  task: ParsedTask
): Promise<TaskWriteResult> {
  const loaded = await resolveTaskLine(plugin, task);
  if (!("file" in loaded)) return loaded;
  const { file, lines, lineIndex, line } = loaded;

  const re = /^(\s*(?:>\s*)*[-*])\s+\[[ xX]\]/;
  const m = re.exec(line);
  if (!m) return { ok: false, reason: "stale-line" };

  // Read the current status from the line itself, not from the task object
  const checked = /\[[xX]\]/.test(m[0]);
  lines[lineIndex] = checked
    ? line.replace(re, (_mm, pre: string) => `${pre} [ ]`)
    : line.replace(re, (_mm, pre: string) => `${pre} [x]`);

  // Only touch the [done::] marker if the setting is on; otherwise the line
  // is modified solely for the checkbox
  if (plugin.settings.recordDoneTime) {
    if (checked) {
      // Returning the task to open — turn [done:: ...] back into [date:: ...]
      // so the date is restored and fields never duplicate
      const doneRe = DONE_FIELD_RE;
      const dm = doneRe.exec(lines[lineIndex]);
      if (dm) {
        const doneVal = dm[1].trim();
        const datePart = /^\d{4}-\d{2}-\d{2}/.test(doneVal) ? doneVal.slice(0, 10) : "";
        lines[lineIndex] = lines[lineIndex].replace(
          doneRe,
          datePart ? `[date:: ${datePart}]` : ""
        );
      }
      lines[lineIndex] = lines[lineIndex].replace(/(?:\s*\|)+\s*$/g, "").trimEnd();
    } else {
      // Marking done — the [date:: ...] field becomes the [done:: ...] marker
      // (single date-like field, no duplicate entries). Other formats keep the
      // old behavior and just append the marker.
      const now = new Date().toISOString();
      if (task.format === "legacy") {
        const dateRe = LEGACY_DATE_FIELD_RE;
        if (dateRe.test(lines[lineIndex])) {
          lines[lineIndex] = lines[lineIndex].replace(dateRe, `[done:: ${now}]`);
        } else {
          lines[lineIndex] = lines[lineIndex].trimEnd() + ` |[done:: ${now}]`;
        }
      } else {
        lines[lineIndex] =
          lines[lineIndex]
            .replace(new RegExp(DONE_FIELD_RE.source, "g"), "")
            .replace(/(?:\s*\|)+\s*$/g, "")
            .trimEnd() + ` |[done:: ${now}]`;
      }
    }
  }

  // Independent of the done marker: only when completing, and only while the
  // scheduled range is still open. Unchecking leaves the written time as it is.
  if (!checked && plugin.settings.trimEndOnComplete) {
    const clipped = clipLineTime(lines[lineIndex], new Date());
    if (clipped !== lines[lineIndex]) {
      lines[lineIndex] = clipped;
      const field = TIME_FIELD_RE.exec(clipped);
      const emoji = EMOJI_RANGE_RE.exec(clipped);
      const nextTime = field?.[1]?.trim() ?? emoji?.[1];
      if (nextTime) task.time = nextTime;
    }
  }

  task.line = lineIndex;
  task.raw = lines[lineIndex];
  await plugin.app.vault.modify(file, lines.join("\n"));
  return OK;
}

/** Moves a task to another date, preserving the format it was parsed with.
    Custom-format tasks are read-only — moving is not supported. */
export async function moveTask(
  plugin: TimeVisualizationPlugin,
  task: ParsedTask,
  newDate: string
): Promise<TaskWriteResult> {
  if (task.format === "custom") {
    return { ok: false, reason: "unsupported" };
  }

  const loaded = await resolveTaskLine(plugin, task);
  if (!("file" in loaded)) return loaded;
  const { file, lines, lineIndex, line } = loaded;

  if (task.format === "tasks") {
    const dateRe = /📅\s*\d{4}-\d{2}-\d{2}/;
    if (dateRe.test(line)) {
      lines[lineIndex] = line.replace(dateRe, `📅 ${newDate}`);
    } else {
      lines[lineIndex] = line.trimEnd() + ` 📅 ${newDate}`;
    }
  } else {
    const dateRe = LEGACY_DATE_FIELD_RE;
    if (dateRe.test(line)) {
      lines[lineIndex] = line.replace(dateRe, `[date:: ${newDate}]`);
    } else {
      lines[lineIndex] = line.trimEnd() + ` |[date:: ${newDate}]`;
    }
  }

  task.line = lineIndex;
  task.raw = lines[lineIndex];
  task.date = newDate;
  await plugin.app.vault.modify(file, lines.join("\n"));
  return OK;
}

/** Rewrites the task text, preserving the quote prefix, checkbox status, tags
    and date/time in the format the task was parsed with. */
export async function updateTaskText(
  plugin: TimeVisualizationPlugin,
  task: ParsedTask,
  newText: string
): Promise<TaskWriteResult> {
  const loaded = await resolveTaskLine(plugin, task);
  if (!("file" in loaded)) return loaded;
  const { file, lines, lineIndex, line } = loaded;

  const re = /^(\s*(?:>\s*)*[-*])\s+\[([ xX])\](\s+.*)?$/;
  const m = re.exec(line);
  if (!m) return { ok: false, reason: "stale-line" };
  const leading = m[1];
  const checked = m[2].toLowerCase() === "x";

  const tags = task.tags.join(" ");
  const text = newText.trim();
  const tagsPart = text && tags ? " " + tags : tags;
  // Re-append date/time in the format the task was parsed with; custom format
  // is read-only, so its date/time fields are dropped on edit
  let datePart = "";
  let timePart = "";
  if (task.format === "tasks") {
    datePart = task.date ? ` 📅 ${task.date}` : "";
    timePart = task.time ? ` ⏰ ${task.time}` : "";
  } else if (task.format === "legacy") {
    timePart = task.time ? ` |[time:: ${task.time}]` : "";
    if (checked && task.done) {
      // A done task carries the completion marker as its date field —
      // writing [date::] and [done::] together would duplicate the entry
      datePart = ` |[done:: ${task.done}]`;
    } else {
      datePart = task.date ? ` |[date:: ${task.date}]` : "";
    }
  }
  // Non-legacy formats keep the completion marker appended after the date
  const donePart = task.format !== "legacy" && task.done ? ` |[done:: ${task.done}]` : "";
  // The space between marker and checkbox is required, otherwise the line
  // stops being recognized as a task
  lines[lineIndex] =
    `${leading} [${checked ? "x" : " "}] ${text}${tagsPart}${datePart}${timePart}${donePart}`;

  task.line = lineIndex;
  task.raw = lines[lineIndex];
  task.text = text;
  await plugin.app.vault.modify(file, lines.join("\n"));
  return OK;
}
