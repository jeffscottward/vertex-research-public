import { describe, expect, it } from "vitest";

import { isTickerQuery, tickerHref } from "./ticker-href.ts";

describe("tickerHref", () => {
  it("normalizes case and whitespace", () => {
    expect(tickerHref(" nvda ")).toBe("/stock/NVDA");
  });

  it("encodes characters that are not URL-safe", () => {
    expect(tickerHref("brk/b")).toBe("/stock/BRK%2FB");
    expect(tickerHref("^spx")).toBe("/stock/%5ESPX");
  });
});

describe("isTickerQuery", () => {
  it("accepts ticker-like text", () => {
    expect(isTickerQuery("nvda")).toBe(true);
    expect(isTickerQuery(" BRK.B ")).toBe(true);
  });

  it("rejects page names and long text", () => {
    expect(isTickerQuery("mission control")).toBe(false);
    expect(isTickerQuery("watchlists")).toBe(false);
    expect(isTickerQuery("")).toBe(false);
  });
});
