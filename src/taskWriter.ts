import { TFile } from "obsidian";
import type TimeVisualizationPlugin from "./main";
import type { ParsedTask } from "./parser";

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

async function readTaskLines(
  plugin: TimeVisualizationPlugin,
  task: ParsedTask
): Promise<{ file: TFile; lines: string[]; line: string } | TaskWriteResult> {
  const file = plugin.app.vault.getAbstractFileByPath(task.filePath);
  if (!(file instanceof TFile)) return { ok: false, reason: "not-found" };
  const content = await plugin.app.vault.read(file);
  const lines = content.split("\n");
  const line = lines[task.line];
  if (line === undefined) return { ok: false, reason: "stale-line" };
  return { file, lines, line };
}

export async function toggleTask(
  plugin: TimeVisualizationPlugin,
  task: ParsedTask
): Promise<TaskWriteResult> {
  const loaded = await readTaskLines(plugin, task);
  if (!("file" in loaded)) return loaded;
  const { file, lines, line } = loaded;

  const re = /^(\s*(?:>\s*)*[-*])\s+\[[ xX]\]/;
  const m = re.exec(line);
  if (!m) return { ok: false, reason: "stale-line" };

  // Read the current status from the line itself, not from the task object
  const checked = /\[[xX]\]/.test(m[0]);
  lines[task.line] = checked
    ? line.replace(re, (_mm, pre: string) => `${pre} [ ]`)
    : line.replace(re, (_mm, pre: string) => `${pre} [x]`);

  // Only touch the [done::] marker if the setting is on; otherwise the line
  // is modified solely for the checkbox
  if (plugin.settings.recordDoneTime) {
    if (checked) {
      // Returning the task to open — turn [done:: ...] back into [date:: ...]
      // so the date is restored and fields never duplicate
      const doneRe = /\[done::\s*([^\]]*)\]/;
      const dm = doneRe.exec(lines[task.line]);
      if (dm) {
        const doneVal = dm[1].trim();
        const datePart = /^\d{4}-\d{2}-\d{2}/.test(doneVal) ? doneVal.slice(0, 10) : "";
        lines[task.line] = lines[task.line].replace(
          doneRe,
          datePart ? `[date:: ${datePart}]` : ""
        );
      }
      lines[task.line] = lines[task.line].replace(/(?:\s*\|)+\s*$/g, "").trimEnd();
    } else {
      // Marking done — the [date:: ...] field becomes the [done:: ...] marker
      // (single date-like field, no duplicate entries). Other formats keep the
      // old behavior and just append the marker.
      const now = new Date().toISOString();
      if (task.format === "legacy") {
        const dateRe = /\[date::\s*[^\]]*\]/;
        if (dateRe.test(lines[task.line])) {
          lines[task.line] = lines[task.line].replace(dateRe, `[done:: ${now}]`);
        } else {
          lines[task.line] = lines[task.line].trimEnd() + ` |[done:: ${now}]`;
        }
      } else {
        lines[task.line] =
          lines[task.line]
            .replace(/\[done::\s*[^\]]*\]/g, "")
            .replace(/(?:\s*\|)+\s*$/g, "")
            .trimEnd() + ` |[done:: ${now}]`;
      }
    }
  }

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

  const loaded = await readTaskLines(plugin, task);
  if (!("file" in loaded)) return loaded;
  const { file, lines, line } = loaded;

  if (task.format === "tasks") {
    const dateRe = /📅\s*\d{4}-\d{2}-\d{2}/;
    if (dateRe.test(line)) {
      lines[task.line] = line.replace(dateRe, `📅 ${newDate}`);
    } else {
      lines[task.line] = line.trimEnd() + ` 📅 ${newDate}`;
    }
  } else {
    const dateRe = /\[date::\s*[^\]]*\]/;
    if (dateRe.test(line)) {
      lines[task.line] = line.replace(dateRe, `[date:: ${newDate}]`);
    } else {
      lines[task.line] = line.trimEnd() + ` |[date:: ${newDate}]`;
    }
  }

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
  const loaded = await readTaskLines(plugin, task);
  if (!("file" in loaded)) return loaded;
  const { file, lines, line } = loaded;

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
  lines[task.line] =
    `${leading} [${checked ? "x" : " "}] ${text}${tagsPart}${datePart}${timePart}${donePart}`;

  await plugin.app.vault.modify(file, lines.join("\n"));
  return OK;
}
