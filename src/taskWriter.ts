import { TFile } from "obsidian";
import type TimeVisualizationPlugin from "./main";
import type { ParsedTask } from "./parser";

/** File writes for tasks. Kept separate from TaskIndex (read/cache only). */

export async function toggleTask(
  plugin: TimeVisualizationPlugin,
  task: ParsedTask
): Promise<void> {
  const file = plugin.app.vault.getAbstractFileByPath(task.filePath);
  if (!(file instanceof TFile)) return;
  const content = await plugin.app.vault.read(file);
  const lines = content.split("\n");
  const line = lines[task.line];
  if (!line) return;

  const re = /^(\s*(?:>\s*)*[-*])\s+\[[ xX]\]/;
  const m = re.exec(line);
  if (!m) return;

  // Read the current status from the line itself, not from the task object
  const checked = /\[[xX]\]/.test(m[0]);
  lines[task.line] = checked
    ? line.replace(re, (mm, pre) => `${pre} [ ]`)
    : line.replace(re, (mm, pre) => `${pre} [x]`);

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
}

/** Moves a task to another date, preserving the format it was parsed with.
    Custom-format tasks are read-only — moving is not supported. */
export async function moveTask(
  plugin: TimeVisualizationPlugin,
  task: ParsedTask,
  newDate: string
): Promise<void> {
  const file = plugin.app.vault.getAbstractFileByPath(task.filePath);
  if (!(file instanceof TFile)) return;
  const content = await plugin.app.vault.read(file);
  const lines = content.split("\n");
  const line = lines[task.line];
  if (!line) return;

  if (task.format === "tasks") {
    const dateRe = /📅\s*\d{4}-\d{2}-\d{2}/;
    if (dateRe.test(line)) {
      lines[task.line] = line.replace(dateRe, `📅 ${newDate}`);
    } else {
      lines[task.line] = line.trimEnd() + ` 📅 ${newDate}`;
    }
  } else if (task.format === "custom") {
    return; // custom regex — no reliable way to rewrite the date
  } else {
    const dateRe = /\[date::\s*[^\]]*\]/;
    if (dateRe.test(line)) {
      lines[task.line] = line.replace(dateRe, `[date:: ${newDate}]`);
    } else {
      lines[task.line] = line.trimEnd() + ` |[date:: ${newDate}]`;
    }
  }

  await plugin.app.vault.modify(file, lines.join("\n"));
}

/** Rewrites the task text, preserving the quote prefix, checkbox status, tags
    and date/time in the format the task was parsed with. */
export async function updateTaskText(
  plugin: TimeVisualizationPlugin,
  task: ParsedTask,
  newText: string
): Promise<void> {
  const file = plugin.app.vault.getAbstractFileByPath(task.filePath);
  if (!(file instanceof TFile)) return;
  const content = await plugin.app.vault.read(file);
  const lines = content.split("\n");
  const line = lines[task.line];
  if (!line) return;

  const re = /^(\s*(?:>\s*)*[-*])\s+\[([ xX])\](\s+.*)?$/;
  const m = re.exec(line);
  if (!m) return;
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
}
