import type { App } from "obsidian";
import type TimeVisualizationPlugin from "./main";
import type { TaskIndex } from "./taskIndex";
import type { ParsedTask } from "./parser";

export type Level = "day" | "week" | "month";

export const VIEW_TYPE = "time-visualization-view";

/**
 * Shared surface for view submodules. Keeps modules free of importing the
 * concrete ItemView class (avoids circular runtime imports).
 */
export interface ViewHost {
  app: App;
  plugin: TimeVisualizationPlugin;
  index: TaskIndex;
  contentEl: HTMLElement;
  level: Level;
  cursor: Date;
  track: HTMLElement | null;
  carouselAnim: Animation | null;
  resizeObserver: ResizeObserver | null;
  taskRefs: Map<string, ParsedTask>;
  editingTaskKey: string | null;
  taskMenu: HTMLElement | null;
  taskMenuAnchor: HTMLElement | null;
  menuJustClosed: boolean;
  priorityMenu: HTMLElement | null;
  priorityMenuAnchor: HTMLElement | null;

  setLevel(level: Level, resetToToday?: boolean): void;
  isSelectionClick(e: MouseEvent): boolean;
  suppressRerender(ms: number): void;
  refillCurrent(): void;
  /** Open the ⋯ task menu (wired by the view to avoid taskRow → menus imports). */
  openTaskMenu(anchor: HTMLElement, row: HTMLElement, t: ParsedTask): void;
  /** Open the day-header priority menu (wired by the view). */
  openDayPriorityMenu(anchor: HTMLElement, dateKey: string): void;
}
