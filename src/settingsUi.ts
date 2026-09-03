import { AbstractInputSuggest, App, setIcon } from "obsidian";
import { flipReorder } from "./flip";

export class MultiSuggest extends AbstractInputSuggest<string> {
  private items: string[];
  private onPick: (value: string) => void;
  private input: HTMLInputElement;
  private query = "";
  private kind: "tag" | "path";

  constructor(
    app: App,
    inputEl: HTMLInputElement,
    items: string[],
    onPick: (value: string) => void,
    kind: "tag" | "path" = "path"
  ) {
    super(app, inputEl);
    this.items = items;
    this.onPick = onPick;
    this.input = inputEl;
    this.kind = kind;
  }

  getSuggestions(query: string): string[] {
    const q = query.trim().toLowerCase();
    this.query = q;
    if (!q) return this.items.slice(0, 50);
    return this.items
      .filter((i) => {
        const lower = i.toLowerCase();
        if (lower.includes(q)) return true;
        // Match by the bare name (last segment, no ".md", leading "_" ignored)
        const base = i
          .slice(i.lastIndexOf("/") + 1)
          .replace(/\.md$/i, "")
          .replace(/^_/, "")
          .toLowerCase();
        return base.includes(q);
      })
      .sort((a, b) => {
        // Name matches rank above path-only matches
        const an = a
          .slice(a.lastIndexOf("/") + 1)
          .replace(/\.md$/i, "")
          .replace(/^_/, "")
          .toLowerCase()
          .includes(q)
          ? 0
          : 1;
        const bn = b
          .slice(b.lastIndexOf("/") + 1)
          .replace(/\.md$/i, "")
          .replace(/^_/, "")
          .toLowerCase()
          .includes(q)
          ? 0
          : 1;
        return an - bn;
      })
      .slice(0, 100);
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    const label =
      this.kind === "tag" ? "#" + value : (value.endsWith(".md") ? "📄 " : "📁 ") + value;
    const q = this.query;
    if (!q) {
      el.setText(label);
      return;
    }
    const idx = label.toLowerCase().indexOf(q);
    if (idx === -1) {
      el.setText(label);
      return;
    }
    el.createSpan({ text: label.slice(0, idx) });
    el.createSpan({ cls: "tv-suggest-highlight", text: label.slice(idx, idx + q.length) });
    el.createSpan({ text: label.slice(idx + q.length) });
  }

  selectSuggestion(value: string): void {
    this.onPick(value);
    this.input.value = "";
    this.close();
  }
}

export function buildMultiSelect(
  containerEl: HTMLElement,
  options: string[],
  selected: string[],
  onChange: (next: string[]) => void,
  app: App,
  kind: "tag" | "path" = "path"
): void {
  let current = [...selected];

  const wrap = containerEl.createDiv({ cls: "tv-multi" });
  const chips = wrap.createDiv({ cls: "tv-multi-chips" });
  const input = wrap.createEl("input", {
    cls: "tv-multi-input",
    type: "text",
    placeholder: "Start typing…",
  });

  const commit = (next: string[]): void => {
    current = next;
    onChange(next);
    renderChips();
  };

  const renderChips = (): void => {
    chips.empty();
    for (const v of current) {
      const chip = chips.createSpan({ cls: "tv-multi-chip", text: v });
      const x = chip.createSpan({ cls: "tv-multi-chip-x", text: "×" });
      x.addEventListener("click", () => commit(current.filter((s) => s !== v)));
    }
  };

  new MultiSuggest(app, input, options, (v) => {
    if (v && !current.includes(v)) commit([...current, v]);
  }, kind);

  renderChips();
}

/** Editable ordered priority list (notes/folders) used in the settings tab. */
export function buildPriorityList(
  containerEl: HTMLElement,
  app: App,
  options: {
    getList: () => string[];
    setList: (next: string[]) => void;
    suggestItems: string[];
    onChange: () => void;
  }
): void {
  const render = (): void => {
    containerEl.empty();
    containerEl.createDiv({ cls: "be-priority-tip", text: "Use the arrows to reorder priority." });
    const list = options.getList();
    let rows: HTMLElement[] = [];
    // The "add note" field must always stay below the list rows
    let addRow: HTMLElement | null = null;
    const renumber = (): void => {
      rows.forEach((r, j) => {
        const num = r.querySelector(".be-priority-num");
        if (num) num.setText(String(j + 1));
      });
    };
    const persist = (): void => {
      options.setList(rows.map((r) => r.dataset.path ?? "").filter(Boolean));
      options.onChange();
    };
    const moveOne = (row: HTMLElement, dir: 1 | -1): void => {
      const from = rows.indexOf(row);
      const to = from + dir;
      if (from < 0 || to < 0 || to >= rows.length) return;
      const prev = rows.map((r) => r.getBoundingClientRect().top);
      containerEl.insertBefore(row, dir === 1 ? (rows[to + 1] ?? addRow) : rows[to]);
      rows = Array.from(containerEl.querySelectorAll<HTMLElement>(".be-priority-row"));
      flipReorder(rows, prev);
      renumber();
      persist();
    };
    list.forEach((path, i) => {
      const row = containerEl.createDiv({ cls: "tv-priority-row be-priority-row" });
      rows.push(row);
      row.dataset.path = path;
      row.createSpan({ cls: "be-priority-num", text: String(i + 1) });
      row.createSpan({ cls: "be-priority-name", text: path });
      const upBtn = row.createEl("button", { cls: "be-priority-arrow", attr: { "aria-label": "Move up" } });
      setIcon(upBtn, "chevron-up");
      upBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        moveOne(row, -1);
      });
      const downBtn = row.createEl("button", { cls: "be-priority-arrow", attr: { "aria-label": "Move down" } });
      setIcon(downBtn, "chevron-down");
      downBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        moveOne(row, 1);
      });
      const del = row.createEl("button", { cls: "tv-priority-del", text: "×" });
      del.addEventListener("click", () => {
        options.setList(list.filter((_, j) => j !== i));
        options.onChange();
        render();
      });
    });
    // Add a note or folder to the priority list
    addRow = containerEl.createDiv({ cls: "tv-priority-row tv-priority-add" });
    const pick = addRow.createEl("input", {
      cls: "tv-priority-pick",
      type: "text",
      attr: { placeholder: "Note or folder path…" },
    });
    const addBtn = addRow.createEl("button", { cls: "tv-priority-add-btn", text: "Add" });
    const doAdd = (): void => {
      const path = pick.value.trim();
      if (!path || list.includes(path)) return;
      options.setList([...list, path]);
      options.onChange();
      render();
    };
    addBtn.addEventListener("click", doAdd);
    addRow.addEventListener("keydown", (e) => {
      if (e.key === "Enter") doAdd();
    });
    new MultiSuggest(app, pick, options.suggestItems, (v) => {
      if (v) {
        pick.value = v;
        doAdd();
      }
    }, "path");
  };
  render();
}
