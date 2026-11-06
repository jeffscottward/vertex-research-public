import { describe, expect, it } from "vitest";

import {
  normalizeStockSymbol,
  parseStockQuery,
  stockQueryString,
} from "./url-state.ts";

describe("stock page URL state", () => {
  it("uses defaults for missing or invalid values", () => {
    expect(parseStockQuery("")).toEqual({
      expiry: null,
      interval: "1D",
      tab: "chart",
    });
    expect(
      parseStockQuery("?interval=5m&expiry=2026-11-20&tab=options")
    ).toEqual({ expiry: "2026-11-20", interval: "5m", tab: "options" });
    for (const day of ["2026-02-31", "2026-13-01"])
      expect(parseStockQuery(`?expiry=${day}`).expiry).toBeNull();
    expect(parseStockQuery("?interval=x&expiry=soon&tab=orders")).toEqual({
      expiry: null,
      interval: "1D",
      tab: "chart",
    });
  });

  it("writes only non-default values", () => {
    expect(
      stockQueryString({ expiry: null, interval: "1D", tab: "chart" })
    ).toBe("");
    expect(
      stockQueryString({
        expiry: "2026-12-18",
        interval: "1W",
        tab: "analytics",
      })
    ).toBe("?interval=1W&expiry=2026-12-18&tab=analytics");
  });

  it("normalizes route symbols", () => {
    expect(normalizeStockSymbol("nvda")).toBe("NVDA");
    expect(normalizeStockSymbol("BRK.B")).toBe("BRK.B");
    expect(normalizeStockSymbol("bf-b")).toBe("BF-B");
    expect(normalizeStockSymbol("%E0%A4%A")).toBeNull();
    expect(normalizeStockSymbol("%3Cscript%3E")).toBeNull();
    expect(normalizeStockSymbol("1ABC")).toBeNull();
  });
});
