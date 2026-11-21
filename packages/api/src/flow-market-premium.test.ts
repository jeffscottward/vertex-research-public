import { describe, expect, it } from "vitest";

import {
  MARKET_PREMIUM_FILTER_PROFILE,
  MARKET_PREMIUM_MAX_TICKERS,
  marketPremiumRequest,
  parseMarketPremium,
} from "./flow-market-premium.ts";

const totals = (overrides: Record<string, unknown> = {}) => ({
  bullishPremium: 6_128_974.25,
  bearishPremium: 4_821_330.5,
  premium: 11_402_108.75,
  premiumRatio: 0.787,
  tradeCount: 18,
  volume: 41_208,
  ...overrides,
});

describe("marketPremiumRequest", () => {
  it("asks for one session with the per-trade premium filter", () => {
    expect(marketPremiumRequest("2026-11-19")).toEqual({
      filterExpression: {
        conjunction: "AND",
        filters: [
          { field: "premium", operation: ">=", value: 100_000 },
          { field: "isCancelled", operation: "=", value: false },
        ],
      },
      sessionDate: "2026-11-19",
    });
    expect(MARKET_PREMIUM_FILTER_PROFILE).toBe("premium-gte-100k.v1");
  });
});

describe("parseMarketPremium", () => {
  it("maps each ticker to its totals in ticker order and drops extra fields", () => {
    const parsed = parseMarketPremium({
      NVDA: totals({ tradeCount: 3 }),
      AAPL: totals(),
      "BRK.B": totals({ bearishPremium: 0 }),
    });
    expect(parsed).toEqual({
      ok: true,
      rows: [
        {
          bearishPremium: 4_821_330.5,
          bullishPremium: 6_128_974.25,
          premium: 11_402_108.75,
          ticker: "AAPL",
          tradeCount: 18,
          volume: 41_208,
        },
        {
          bearishPremium: 0,
          bullishPremium: 6_128_974.25,
          premium: 11_402_108.75,
          ticker: "BRK.B",
          tradeCount: 18,
          volume: 41_208,
        },
        {
          bearishPremium: 4_821_330.5,
          bullishPremium: 6_128_974.25,
          premium: 11_402_108.75,
          ticker: "NVDA",
          tradeCount: 3,
          volume: 41_208,
        },
      ],
      skipped: 0,
    });
  });

  it("skips and counts keys that break the ticker rule, without reading their values", () => {
    const parsed = parseMarketPremium({
      AAPL: totals(),
      "bad key": "not totals",
      "": totals(),
      TOOLONGTICKERNAME1: totals(),
    });
    expect(parsed).toMatchObject({ ok: true, skipped: 3 });
    expect(parsed.ok && parsed.rows.map((row) => row.ticker)).toEqual(["AAPL"]);
  });

  it("accepts an empty answer", () => {
    expect(parseMarketPremium({})).toEqual({ ok: true, rows: [], skipped: 0 });
  });

  it.each([
    ["negative premium", { bullishPremium: -1 }, "*.bullishPremium"],
    ["fractional trade count", { tradeCount: 1.5 }, "*.tradeCount"],
    ["text volume", { volume: "41208" }, "*.volume"],
    ["infinite premium", { premium: Number.POSITIVE_INFINITY }, "*.premium"],
  ])("refuses a %s and names only the path", (_name, override, path) => {
    expect(parseMarketPremium({ AAPL: totals(override) })).toEqual({
      message: `gainers-losers answer has an unexpected shape: ${path}`,
      ok: false,
    });
  });

  it("refuses a ticker whose value is not an object", () => {
    expect(parseMarketPremium({ AAPL: 5 })).toEqual({
      message: "gainers-losers answer has an unexpected shape: *",
      ok: false,
    });
  });

  it.each([
    ["an array", []],
    ["null", null],
    ["a number", 7],
  ])("refuses %s at the root", (_name, data) => {
    expect(parseMarketPremium(data)).toEqual({
      message: "gainers-losers answer has an unexpected shape: (root)",
      ok: false,
    });
  });

  it("refuses more tickers than the cap", () => {
    const data = Object.fromEntries(
      Array.from({ length: MARKET_PREMIUM_MAX_TICKERS + 1 }, (_, index) => [
        `T${index}`,
        totals(),
      ])
    );
    expect(parseMarketPremium(data)).toEqual({
      message: "gainers-losers answer has an unexpected shape: (root)",
      ok: false,
    });
  });
});
