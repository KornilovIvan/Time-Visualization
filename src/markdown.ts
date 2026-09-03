/** Light inline markdown renderer for task text: bold, italic, strikethrough,
    highlight, inline code, links and wiki-links. HTML is escaped first so user
    text is never executed as markup. The full MarkdownRenderer is avoided for
    performance — it is async and heavy when applied to hundreds of rows. */
export function renderInlineMarkdown(text: string): string {
  let s = text
    .replace(/&/g, "&")
    .replace(/</g, "<")
    .replace(/>/g, ">");

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

  // Wiki links: [[Note]] or [[Note|alias]] -> alias / note name (plain text)
  s = s.replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, note: string, alias?: string) => {
    return (alias || note).trim();
  });

  // Markdown links: [text](url) — only safe schemes become clickable links
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) => {
    const href = url.trim();
    if (/^(https?:|mailto:|#|\/)/.test(href)) return `<a href="${href}">${label}</a>`;
    return label;
  });

  // Restore inline code
  s = s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${codes[Number(i)] ?? ""}</code>`);

  return s;
}
