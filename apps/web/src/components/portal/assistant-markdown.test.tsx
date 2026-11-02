// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  AssistantMarkdown,
  parseMarkdownBlocks,
} from "./assistant-markdown.tsx";

const html = (source: string) =>
  renderToStaticMarkup(<AssistantMarkdown source={source} />);

describe("assistant Markdown subset", () => {
  it("splits headings, lists, fenced code and paragraphs", () => {
    expect(
      parseMarkdownBlocks(
        "# Title\r\nFirst line\nsecond line\n\n- a\n* b\n1. one\n2) two\n```\nconst x = 1;\n```\n### Small"
      )
    ).toEqual([
      { kind: "heading", level: 1, text: "Title" },
      { kind: "paragraph", text: "First line\nsecond line" },
      { kind: "list", ordered: false, items: ["a", "b"] },
      { kind: "list", ordered: true, items: ["one", "two"] },
      { kind: "code", text: "const x = 1;" },
      { kind: "heading", level: 3, text: "Small" },
    ]);
    expect(parseMarkdownBlocks("```\nunclosed")).toEqual([
      { kind: "code", text: "unclosed" },
    ]);
  });

  it("renders bold, inline code and https links as elements", () => {
    const markup = html(
      "See **ES** and `SPY` at [docs](https://example.test/a) now."
    );
    expect(markup).toContain("<strong>ES</strong>");
    expect(markup).toContain(">SPY</code>");
    expect(markup).toContain(
      '<a class="underline underline-offset-2" href="https://example.test/a" rel="noopener noreferrer" target="_blank">docs</a>'
    );
    expect(markup).toContain(" now.</p>");
    expect(html("**only**")).toContain(
      '<p class="whitespace-pre-wrap"><strong>only</strong></p>'
    );
  });

  it("never turns model text into markup or unsafe links", () => {
    const markup = html(
      '<img src=x onerror="alert(1)"> [x](javascript:alert(1)) **'
    );
    expect(markup).not.toContain("<img");
    expect(markup).not.toContain('href="javascript');
    expect(markup).toContain("&lt;img");
  });

  it("styles headings as text and renders both list kinds and code", () => {
    const markup = html("# A\n## B\n### C\n- x\n1. y\n```\nz\n```");
    expect(markup).not.toMatch(/<h[1-6]/u);
    expect(markup).toContain('data-md-heading="1"');
    expect(markup).toContain('data-md-heading="3"');
    expect(markup).toContain('<ul class="list-disc');
    expect(markup).toContain('<ol class="list-decimal');
    expect(markup).toContain("<pre");
  });
});
