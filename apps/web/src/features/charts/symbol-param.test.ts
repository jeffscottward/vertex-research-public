import { describe, expect, it } from "vitest";

import {
  isLinkableSymbol,
  parseSymbolParam,
  withSymbolParam,
} from "./symbol-param.ts";

describe("parseSymbolParam", () => {
  it.each([
    ["", { type: "none" }],
    ["?symbol=%20", { type: "none" }],
    ["?symbol=aapl", { symbol: "AAPL", type: "valid" }],
    ["?symbol=BRK.B", { symbol: "BRK.B", type: "valid" }],
    ["?symbol=ABCDEFGHIJKL", { symbol: "ABCDEFGHIJKL", type: "valid" }],
    // The bars contract rejects these, so the link must too.
    ["?symbol=BF-B", { raw: "BF-B", type: "invalid" }],
    ["?symbol=1ABC", { raw: "1ABC", type: "invalid" }],
    ["?symbol=A%20B", { raw: "A B", type: "invalid" }],
    ["?symbol=ABCDEFGHIJKLM", { raw: "ABCDEFGHIJKLM", type: "invalid" }],
  ])("%s", (search, expected) => {
    expect(parseSymbolParam(search)).toEqual(expected);
  });

  it("caps the echoed raw value", () => {
    const parsed = parseSymbolParam(`?symbol=${"x".repeat(80)}`);
    expect(parsed).toEqual({ raw: "x".repeat(40), type: "invalid" });
  });
});

describe("isLinkableSymbol", () => {
  it("matches the bars request contract", () => {
    expect(isLinkableSymbol("BRK.B")).toBe(true);
    expect(isLinkableSymbol("ES")).toBe(true);
    expect(isLinkableSymbol("BF-B")).toBe(false);
    expect(isLinkableSymbol("")).toBe(false);
  });
});

describe("withSymbolParam", () => {
  it("sets the symbol and keeps other params", () => {
    expect(withSymbolParam("?a=1&symbol=X", "NVDA")).toBe("?a=1&symbol=NVDA");
    expect(withSymbolParam("", "NVDA")).toBe("?symbol=NVDA");
  });
});
