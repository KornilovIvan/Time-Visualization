/** Light inline markdown renderer for task text: bold, italic, strikethrough,
    highlight, inline code, links and wiki-links. HTML is escaped first so user
    text is never executed as markup. The full MarkdownRenderer is avoided for
    performance — it is async and heavy when applied to hundreds of rows. */

/** Escape for HTML attribute values (text is already entity-escaped for &<>). */
function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;");
}

/** Obsidian internal note link — opened via openLinkText on click. */
function internalAnchor(linktext: string, label: string): string {
  const href = escapeAttr(linktext.trim());
  const text = label.trim() || linktext.trim();
  return `<a class="internal-link" data-href="${href}" href="#">${text}</a>`;
}

/** Trim trailing punctuation that is usually outside the URL. */
function splitBareUrl(matched: string): { url: string; trailing: string } {
  let url = matched;
  let trailing = "";
  while (/[.,;:!?)\]>'"]$/.test(url)) {
    trailing = url.slice(-1) + trailing;
    url = url.slice(0, -1);
  }
  return { url, trailing };
}

export function renderInlineMarkdown(text: string): string {
  let s = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  // Protect inline code so its contents are not touched by the other rules
  const codes: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_m, c: string) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });

  s = s.replace(/==([^=\n]+)==/g, "<mark>$1</mark>"); // highlight
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>"); // bold
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>"); // italic (not bold)
  s = s.replace(/~~([^~\n]+)~~/g, "<s>$1</s>"); // strikethrough

  // Wiki links: [[Note]] or [[Note|alias]]
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, note: string, alias?: string) => {
    return internalAnchor(note, alias || note);
  });

  // Markdown links: [text](url) — external schemes stay as normal anchors;
  // everything else is treated as an Obsidian linktext (note / path)
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
    const href = url.trim();
    if (/^(https?:|mailto:)/i.test(href)) return `<a href="${escapeAttr(href)}">${label}</a>`;
    if (href.startsWith("#")) return `<a href="${escapeAttr(href)}">${label}</a>`;
    return internalAnchor(href, label);
  });

  // Protect existing anchors so bare-URL linking does not nest inside them
  const anchors: string[] = [];
  s = s.replace(/<a\b[^>]*>[\s\S]*?<\/a>/gi, (m) => {
    anchors.push(m);
    return `\u0001${anchors.length - 1}\u0001`;
  });

  // Autolink bare http(s) URLs (e.g. pasted YouTube links)
  s = s.replace(/https?:\/\/[^\s<\u0001]+/gi, (m) => {
    const { url, trailing } = splitBareUrl(m);
    if (!url) return m;
    return `<a href="${url}">${url}</a>${trailing}`;
  });

  s = s.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => anchors[Number(i)] ?? "");

  // Restore inline code
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${codes[Number(i)] ?? ""}</code>`);

  return s;
}
