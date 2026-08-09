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

// Legacy inline fields [date:: ...] / [time:: ...]
const INLINE_RE = /\[(date|time)::\s*([^\]]*)\]/g;

// Completion marker [done:: <ISO>] — written on toggle, read in any format
const DONE_RE = /\[done::\s*([^\]]*)\]/;

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
  customDateRegex = ""
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
    // legacy inline fields
    text = text.replace(INLINE_RE, (full, key: string, value: string) => {
      const v = value.trim();
      if (v) {
        if (key === "date") date = v;
        else if (key === "time") time = v;
      }
      return "";
    });
  }

  // Completion marker is format-independent — read it for all formats
  text = text.replace(DONE_RE, (full, d: string) => {
    const v = d.trim();
    if (v) done = v;
    return "";
  });

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
