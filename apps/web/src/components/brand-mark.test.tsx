import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BrandLink } from "./brand-mark.tsx";

describe("BrandLink", () =>
  it("keeps the visible wordmark text inside the accessible name (axe label-content-name-mismatch)", () => {
    const html = renderToStaticMarkup(<BrandLink />);
    const label = /aria-label="([^"]*)"/.exec(html)?.[1] ?? "";
    const visible = html
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();

    expect(visible).toBe("Vertex Research");
    expect(label).toContain(visible);
  }));
