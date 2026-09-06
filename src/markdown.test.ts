import { describe, expect, it } from "vitest";
import { renderInlineMarkdown } from "./markdown";

describe("renderInlineMarkdown links", () => {
  it("renders wiki links as internal anchors", () => {
    const html = renderInlineMarkdown("See [[My Note]] and [[Path/Note|alias]]");
    expect(html).toContain('class="internal-link"');
    expect(html).toContain('data-href="My Note"');
    expect(html).toContain(">My Note</a>");
    expect(html).toContain('data-href="Path/Note"');
    expect(html).toContain(">alias</a>");
  });

  it("keeps external markdown links as http anchors", () => {
    const html = renderInlineMarkdown("Go [here](https://example.com)");
    expect(html).toContain('<a href="https://example.com">here</a>');
    expect(html).not.toContain("internal-link");
  });

  it("treats non-http markdown targets as internal links", () => {
    const html = renderInlineMarkdown("Open [x](Other Note)");
    expect(html).toContain('class="internal-link"');
    expect(html).toContain('data-href="Other Note"');
    expect(html).toContain(">x</a>");
  });

  it("autolinks bare https URLs including query strings", () => {
    const raw =
      "Watch https://www.youtube.com/watch?app=desktop&v=kedW1xO3Zbo please";
    const html = renderInlineMarkdown(raw);
    expect(html).toContain(
      '<a href="https://www.youtube.com/watch?app=desktop&amp;v=kedW1xO3Zbo">https://www.youtube.com/watch?app=desktop&amp;v=kedW1xO3Zbo</a>'
    );
    expect(html.startsWith("Watch ")).toBe(true);
    expect(html.endsWith(" please")).toBe(true);
  });

  it("does not double-wrap markdown http links", () => {
    const html = renderInlineMarkdown("Go [here](https://example.com/path?x=1&y=2)");
    expect(html).toBe('Go <a href="https://example.com/path?x=1&amp;y=2">here</a>');
  });
});
