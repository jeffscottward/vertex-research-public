import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TickerLink } from "./ticker-link.tsx";

describe("TickerLink", () => {
  it("links the normalized symbol to its stock page", () => {
    const html = renderToStaticMarkup(<TickerLink symbol=" aapl " />);
    expect(html).toContain('href="/stock/AAPL"');
    expect(html).toContain(">AAPL</a>");
    expect(html).toContain('data-slot="ticker-link"');
  });

  it("renders custom children and classes", () => {
    const html = renderToStaticMarkup(
      <TickerLink className="extra" symbol="msft">
        Microsoft
      </TickerLink>
    );
    expect(html).toContain('href="/stock/MSFT"');
    expect(html).toContain("extra");
    expect(html).toContain(">Microsoft</a>");
  });
});
