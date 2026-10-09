/**
 * Task-line parser.
 *
 * Supported date formats:
 *   - legacy: inline fields `|[date:: 2026-08-05]` / `|[time:: 09:00]`
 *   - tasks:  Obsidian Tasks emoji fields `📅 2026-08-05` / `⏰ 09:00`
 *   - custom: a user-provided regex with named groups `date` and `time`
 */

export type DateFormat = "legacy" | "tasks" | "custom";

export interface ParsedTask {
  filePath: string;
  line: number;
  raw: string;
  checked: boolean;
  text: string;
  tags: string[];
  date?: string;
  time?: string;
  /** Completion timestamp (ISO) written on toggle — keeps the order of done tasks */
  done?: string;
  /** Format used to extract date/time (needed to write back in the same format) */
  format: DateFormat;
}

// Task line: optional quote/callout prefix "> " (also nested)
const TASK_RE = /^\s*(?:>\s*)*[-*]\s+\[( |x|X)\]\s+(.*)$/;

// Legacy inline fields [date:: ...] / [time:: ...]. Spaces around the name and ::
// are allowed: [date :: 2026-08-05], [ date::2026-08-05 ]
const INLINE_RE = /\[\s*(date|time)\s*::\s*([^\]]*)\]/g;

/** [date :: value]. Not global — safe to reuse with test() and replace(). */
export const LEGACY_DATE_FIELD_RE = /\[\s*date\s*::\s*[^\]]*\]/;

/** [done :: value], capture group 1 is the value. Not global. */
export const DONE_FIELD_RE = /\[\s*done\s*::\s*([^\]]*)\]/;

/** Written and recognized date field. `{date}` is the day. No leading `|` by default. */
export const DEFAULT_DATE_FIELD = "[date:: {date}]";
/** Written and recognized time field. `{time}` is the clock time. */
export const DEFAULT_TIME_FIELD = "[time:: {time}]";

export interface TaskFieldTemplates {
  dateField?: string;
  timeField?: string;
}

/** Keep a template only when it still contains its value placeholder. */
export function fieldTemplate(value: string | undefined, token: "date" | "time"): string {
  const fallback = token === "date" ? DEFAULT_DATE_FIELD : DEFAULT_TIME_FIELD;
  const v = (value ?? "").trim();
  return v.includes(`{${token}}`) ? v : fallback;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Regex whose capture 1 is the value inside a field template. */
export function fieldValueRegExp(
  template: string,
  token: "date" | "time" | "done"
): RegExp | null {
  const key = `{${token}}`;
  const at = template.indexOf(key);
  if (at < 0) return null;
  const before = escapeRegExp(template.slice(0, at));
  const rest = template.slice(at + key.length);
  const after = escapeRegExp(rest);
  const value = rest.startsWith("]")
    ? "([^\\]\\n]*)"
    : token === "time"
      ? "(\\d{1,2}:\\d{2}(?:\\s*[-–—]\\s*\\d{1,2}:\\d{2})?)"
      : "(\\d{4}-\\d{2}-\\d{2}(?:T[^\\s|]*)?)";
  return new RegExp(before + value + after);
}

function takeField(
  text: string,
  template: string,
  token: "date" | "time"
): { text: string; value?: string } {
  const re = fieldValueRegExp(template, token);
  if (!re) return { text };
  const global = new RegExp(re.source, "g");
  let value: string | undefined;
  const next = text.replace(global, (_full, v: string) => {
    const trimmed = v.trim();
    if (trimmed) value = trimmed;
    return "";
  });
  return { text: next, value };
}

/** Fill a template and separate it from the task text with a space. */
export function renderField(
  template: string,
  token: "date" | "time" | "done",
  value: string
): string {
  const key = `{${token}}`;
  if (!value || !template.includes(key)) return "";
  const filled = template.split(key).join(value);
  if (filled.startsWith("|")) return ` ${filled}`;
  if (/^\s/.test(filled)) return filled;
  return ` ${filled}`;
}

/** Same wrapping as the date field, with the name and placeholder switched to done. */
export function doneFieldTemplate(dateField: string): string {
  return dateField.split("{date}").join("{done}").replace(/\bdate\b/g, "done");
}

// Tasks plugin fields: 📅 due date, ⏰ time
const TASKS_DATE_RE = /📅\s*(\d{4}-\d{2}-\d{2})/;
const TASKS_TIME_RE = /⏰\s*(\d{1,2}:\d{2})/;

// Calendar/time icon left at the end of the text after field removal (u-flag for emoji)
const ICON_TAIL_RE = /(?:\s*\|)*\s*(?:🗓️|🕐|⏰|📅|⌛)\s*$/u;

// Obsidian tag: (?<![\w]) rejects heading links (note#heading) and glued words,
// (?!\d) — a tag can't start with a digit
const TAG_RE = /(?<![\w])#(?!\d)([\p{L}][\p{L}\p{N}_/-]*)/gu;

/** Parses one line. Returns null if it's not a task. */
export function parseTaskLine(
  raw: string,
  filePath: string,
  line: number,
  dateFormat: DateFormat = "legacy",
  customDateRegex = "",
  fields?: TaskFieldTemplates
): ParsedTask | null {
  const m = TASK_RE.exec(raw);
  if (!m) return null;

  const checked = m[1].toLowerCase() === "x";

  let text = m[2];
  let date: string | undefined;
  let time: string | undefined;
  let done: string | undefined;

  if (dateFormat === "tasks") {
    text = text.replace(TASKS_DATE_RE, (full, d: string) => {
      date = d;
      return "";
    });
    text = text.replace(TASKS_TIME_RE, (full, t: string) => {
      time = t;
      return "";
    });
  } else if (dateFormat === "custom" && customDateRegex) {
    try {
      const re = new RegExp(customDateRegex);
      const cm = re.exec(text);
      if (cm?.groups) {
        if (cm.groups.date) date = cm.groups.date.trim();
        if (cm.groups.time) time = cm.groups.time.trim();
        // Only strip the matched fields if something was actually extracted —
        // otherwise a regex without named groups would eat text for nothing
        if ((date || time) && cm[0]) text = text.replace(re, "");
      }
    } catch {
      // invalid regex — just skip date extraction
    }
  } else {
    // Inline fields. The user's templates are tried first; the plain
    // [date::] / [time::] form still matches, with or without a leading |.
    const dateHit = takeField(text, fieldTemplate(fields?.dateField, "date"), "date");
    text = dateHit.text;
    if (dateHit.value) date = dateHit.value;
    const timeHit = takeField(text, fieldTemplate(fields?.timeField, "time"), "time");
    text = timeHit.text;
    if (timeHit.value) time = timeHit.value;
    text = text.replace(INLINE_RE, (_full, key: string, value: string) => {
      const v = value.trim();
      if (v) {
        if (key === "date") date = v;
        else if (key === "time") time = v;
      }
      return "";
    });
  }

  // Completion marker is format-independent — read it for all formats
  text = text.replace(DONE_FIELD_RE, (full, d: string) => {
    const v = d.trim();
    if (v) done = v;
    return "";
  });

  // A completed task may carry only a [done:: ...] marker instead of a date
  // field (the marker replaces [date:: ...] on completion). Fall back to the
  // date embedded in the completion timestamp (YYYY-MM-DD) so the task stays
  // attached to its day.
  if (!date && done) {
    const d = done.trim().slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(d)) date = d;
  }

  // Drop leftover "|" separators, trailing calendar icons and double spaces
  text = text
    .replace(/(?:\s*\|)+\s*$/g, "")
    .replace(ICON_TAIL_RE, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Collect tags
  const tags: string[] = [];
  let tm: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((tm = TAG_RE.exec(text)) !== null) {
    tags.push("#" + tm[1]);
  }

  // Tags render as separate chips — strip them from the text to avoid duplication
  text = text.replace(TAG_RE, " ").replace(/\s{2,}/g, " ").trim();

  return {
    filePath,
    line,
    raw,
    checked,
    text,
    tags,
    date,
    time,
    done,
    format: dateFormat,
  };
}

/** Completion stamp for `[done::]`. Another day's task keeps that day:
    the stamp is the end of it, so the date read back from the marker stays put. */
export function completionStamp(taskDate: string | undefined, now = new Date()): string {
  if (taskDate && /^\d{4}-\d{2}-\d{2}$/.test(taskDate) && taskDate !== formatDate(now)) {
    return `${taskDate}T23:59:59`;
  }
  return now.toISOString();
}

export function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseDate(s: string): Date {
  const [y, m, d] = s.split("-").map((x) => parseInt(x, 10));
  return new Date(y, (m || 1) - 1, d || 1);
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
