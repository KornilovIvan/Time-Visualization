/** Minimal Obsidian stubs for unit tests (vitest alias). */

export class TFile {
  path = "";
  extension = "md";
  stat = { mtime: 0, ctime: 0, size: 0 };
}

export class Plugin {}
export class ItemView {}
export class PluginSettingTab {}
export class Notice {
  constructor(_message?: string) {}
}
export class Setting {
  setName() {
    return this;
  }
  setDesc() {
    return this;
  }
  addToggle() {
    return this;
  }
  addText() {
    return this;
  }
  addDropdown() {
    return this;
  }
  addButton() {
    return this;
  }
  addExtraButton() {
    return this;
  }
}

export abstract class AbstractInputSuggest<T> {
  constructor(_app: unknown, _input: unknown) {}
  abstract getSuggestions(_query: string): T[] | Promise<T[]>;
}

export function setIcon(_el: HTMLElement, _id: string): void {}
export function sanitizeHTMLToDom(_html: string): DocumentFragment {
  return document.createDocumentFragment();
}

export const Platform = {
  isMobile: false,
};
