/**
 * Task-line parser for the user's format:
 *   - [ ] #math ... |[date:: 2026-08-05]
 *   - [x] #sql ... |[date:: 2026-08-05] |[time:: 09:00]
 */

export interface ParsedTask {
  filePath: string;
  line: number;
  raw: string;
  checked: boolean;
  text: string;
  tags: string[];
  date?: string;
  time?: string;
}

// Task line: optional quote/callout prefix "> " (also nested)
const TASK_RE = /^\s*(?:>\s*)*[-*]\s+\[( |x|X)\]\s+(.*)$/;

// Inline fields [date:: ...] / [time:: ...]
const INLINE_RE = /\[(date|time)::\s*([^\]]*)\]/g;

// Calendar/time icon left at the end of the text after inline-field removal (u-flag for emoji)
const ICON_TAIL_RE = /(?:\s*\|)*\s*(?:🗓️|🕐|⏰|📅|⌛)\s*$/u;

// Obsidian tag: (?<![\w]) rejects heading links (note#heading) and glued words,
// (?!\d) — a tag can't start with a digit
const TAG_RE = /(?<![\w])#(?!\d)([\p{L}][\p{L}\p{N}_\/\-]*)/gu;

/** Parses one line. Returns null if it's not a task. */
export function parseTaskLine(
  raw: string,
  filePath: string,
  line: number
): ParsedTask | null {
  const m = TASK_RE.exec(raw);
  if (!m) return null;

  const checked = m[1].toLowerCase() === "x";

  let text = m[2];
  let date: string | undefined;
  let time: string | undefined;

  // Extract trailing inline fields [date:: ...] / [time:: ...]
  text = text.replace(INLINE_RE, (full, key: string, value: string) => {
    const v = value.trim();
    if (v) {
      if (key === "date") date = v;
      else if (key === "time") time = v;
    }
    return "";
  });

  // Drop leftover "|" separators and the calendar icon left by removed fields
  text = text.replace(/(?:\s*\|)+\s*$/g, "").replace(ICON_TAIL_RE, "").trim();

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
