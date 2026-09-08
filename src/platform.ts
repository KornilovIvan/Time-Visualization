import { Platform } from "obsidian";

/** True on Obsidian mobile (phone/tablet app). Desktop stays full day/week/month. */
export function isMobileUi(): boolean {
  return Platform.isMobile;
}
