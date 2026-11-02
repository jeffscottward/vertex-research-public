import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResearchTableHeading } from "./research-table-heading.tsx";

describe("research table heading help", () => {
  it("keeps the table title visible and provides named non-submit native help", () => {
    const html = renderToStaticMarkup(
      <ResearchTableHeading id="positions-heading" title="Positions">
        <p>Exact source observations.</p>
      </ResearchTableHeading>
    );
    expect(html).toContain('<h2 id="positions-heading">Positions</h2>');
    expect(html).toMatch(/<button[^>]*aria-label="About Positions"/);
    expect(html).toMatch(/<button[^>]*type="button"/);
    expect(html).toContain('title="About Positions"');
    expect(html).toMatch(/popovertarget="positions-heading-help"/i);
    expect(html).toMatch(/popovertargetaction="toggle"/i);
    expect(html).toContain("min-h-11 min-w-11");
    expect(html).toContain("group-focus-visible/button:ring-[3px]");
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    return expect(html).toMatch(
      /<aside[^>]*id="positions-heading-help"[^>]*popover="auto"[^>]*aria-labelledby="positions-heading"[^>]*><p>Exact source observations\.<\/p><\/aside>/
    );
  });

  it("keeps caller IDs stable and associates separate headings with separate help", () => {
    const html = renderToStaticMarkup(
      <div>
        <ResearchTableHeading id="positions-heading" title="Positions">
          Position help
        </ResearchTableHeading>
        <ResearchTableHeading id="lots-heading" title="Lots">
          Lot help
        </ResearchTableHeading>
        <table aria-labelledby="positions-heading">
          <caption>Source positions</caption>
        </table>
      </div>
    );
    expect(html).toMatch(/popovertarget="positions-heading-help"/i);
    expect(html).toMatch(/popovertarget="lots-heading-help"/i);
    expect(html).toContain('<h2 id="lots-heading">Lots</h2>');
    expect(html).toContain(
      '<table aria-labelledby="positions-heading"><caption>Source positions</caption>'
    );
    expect(html.match(/id="positions-heading"/g)).toHaveLength(1);
    return expect(html.match(/id="positions-heading-help"/g)).toHaveLength(1);
  });

  return it("renders rich help as React children and escapes untrusted text", () => {
    const html = renderToStaticMarkup(
      <ResearchTableHeading
        id="source-heading"
        title={'Source <script>alert("title")</script>'}
      >
        <p>
          <strong>Provenance</strong>
          {'<img src=x onerror="alert(1)">'}
        </p>
      </ResearchTableHeading>
    );
    expect(html).toContain("<strong>Provenance</strong>");
    expect(html).toContain("&lt;img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    return expect(html).not.toContain("<img");
  });
});
