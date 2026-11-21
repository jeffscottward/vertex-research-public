import { describe, expect, it } from "vitest";
import {
  normalizeSmartMoneyTicker,
  parseSmartMoneyParams,
  smartMoneySearch,
} from "./smart-money-params.ts";

describe("smart money params", () => {
  it("falls back to the defaults for missing or unknown values", () => {
    expect(parseSmartMoneyParams({})).toEqual({
      sessions: 1,
      sort: "net_bullish",
      ticker: "",
    });
    return expect(
      parseSmartMoneyParams({
        sessions: "10",
        sort: "volume",
        ticker: ["EXWD"],
      })
    ).toEqual({ sessions: 1, sort: "net_bullish", ticker: "" });
  });

  it("reads every known value and normalizes the ticker", () =>
    expect(
      parseSmartMoneyParams({
        sessions: "20",
        sort: "net_bearish",
        ticker: " exwd ",
      })
    ).toEqual({ sessions: 20, sort: "net_bearish", ticker: "EXWD" }));

  it("drops a ticker that breaks the symbol rule", () => {
    expect(normalizeSmartMoneyTicker("not a ticker")).toBe("");
    expect(normalizeSmartMoneyTicker("x".repeat(17))).toBe("");
    return expect(normalizeSmartMoneyTicker("brk.b")).toBe("BRK.B");
  });

  return it("writes only the non-default values", () => {
    expect(
      smartMoneySearch({ sessions: 1, sort: "net_bullish", ticker: "" })
    ).toBe("");
    return expect(
      smartMoneySearch({ sessions: 5, sort: "total", ticker: "EXWD" })
    ).toBe("?sessions=5&sort=total&ticker=EXWD");
  });
});
