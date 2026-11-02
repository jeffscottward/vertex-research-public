import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  PriceAlertCreateInputSchema,
  PriceAlertStateSchema,
} from "./contracts/price-alerts.ts";
import {
  evaluatePriceAlert,
  formatPriceAlertPrice,
  PRICE_ALERT_NOTIFICATION,
  type PriceAlertQuote,
  planPriceAlertRun,
  priceAlertChartUrl,
  quoteFromYahooChart,
} from "./price-alerts.ts";

// Yahoo chart fixtures copied from day-trader-skill (MIT); see fixtures/day-trader-skill/NOTICE.md.
const fixture = (symbol: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(
        `./fixtures/day-trader-skill/trader-alerts/yahoo-${symbol}.json`,
        import.meta.url
      ),
      "utf8"
    )
  ) as unknown;

const quoteOf = (symbol: string): PriceAlertQuote => {
  const result = quoteFromYahooChart(fixture(symbol), symbol);
  if (!result.ok) throw new Error(result.reason);
  return result.quote;
};

const epoch = (seconds: number) => new Date(seconds * 1000);
const SESSION_OPEN = epoch(1_791_898_200);
const AFTER_CLOSE = epoch(1_791_921_601);

describe("quoteFromYahooChart", () => {
  it("reads the last price, its time and the bars of the upstream fixtures", () => {
    const aapl = quoteOf("AAPL");
    expect(aapl.last).toBe(341.27);
    expect(aapl.lastAt?.toISOString()).toBe("2026-10-13T20:00:01.000Z");
    expect(aapl.bars).toEqual([
      {
        high: 348.149_993_896_484_4,
        low: 340.739_990_234_375,
        start: SESSION_OPEN,
      },
    ]);
    const tsla = quoteOf("TSLA");
    expect(tsla.last).toBe(366.475);
    expect(tsla.lastAt?.toISOString()).toBe("2026-10-19T14:52:13.000Z");
    expect(tsla.bars).toHaveLength(18);
  });

  it("reports an unknown symbol, an unexpected document and a missing price", () => {
    expect(quoteFromYahooChart(fixture("ZZZZ"), "ZZZZ")).toEqual({
      ok: false,
      reason: "Yahoo has no data for this symbol",
    });
    expect(quoteFromYahooChart({ chart: { result: [] } }, "X")).toEqual({
      ok: false,
      reason: "Yahoo has no data for this symbol",
    });
    expect(quoteFromYahooChart({ nope: true }, "X")).toEqual({
      ok: false,
      reason: "Yahoo returned an unexpected document",
    });
    expect(
      quoteFromYahooChart(
        { chart: { result: [{ indicators: {}, meta: {} }] } },
        "X"
      )
    ).toEqual({ ok: false, reason: "Yahoo has no last price for this symbol" });
    expect(
      quoteFromYahooChart(
        {
          chart: {
            result: [{ indicators: {}, meta: { regularMarketPrice: 0 } }],
          },
        },
        "X"
      )
    ).toMatchObject({ ok: false });
  });

  it("drops bars without a high and low and tolerates a missing time", () => {
    const result = quoteFromYahooChart(
      {
        chart: {
          result: [
            {
              indicators: {
                quote: [{ high: [10, null, 12], low: [9, 8, -1] }],
              },
              meta: { regularMarketPrice: 11 },
              timestamp: [1, 2, 3, 4],
            },
          ],
        },
      },
      "X"
    );
    expect(result).toEqual({
      ok: true,
      quote: {
        bars: [{ high: 10, low: 9, start: epoch(1) }],
        last: 11,
        lastAt: null,
        symbol: "X",
      },
    });
    const bare = quoteFromYahooChart(
      {
        chart: {
          result: [{ indicators: {}, meta: { regularMarketPrice: 5 } }],
        },
      },
      "X"
    );
    expect(bare).toMatchObject({ ok: true, quote: { bars: [] } });
  });
});

describe("evaluatePriceAlert", () => {
  it("rings an at-or-above target on the last price, like upstream (AAPL 341.27 >= 340)", () => {
    const aapl = quoteOf("AAPL");
    expect(
      evaluatePriceAlert(
        {
          createdAt: AFTER_CLOSE,
          kind: "above",
          lastCheckedAt: null,
          level: "340",
        },
        aapl
      )
    ).toEqual({ hit: true, price: 341.27 });
    expect(
      evaluatePriceAlert(
        {
          createdAt: AFTER_CLOSE,
          kind: "above",
          lastCheckedAt: null,
          level: "345",
        },
        aapl
      )
    ).toEqual({ hit: false });
  });

  it("counts a touch between checks: a bar high above the level rings even when the last price is below", () => {
    const aapl = quoteOf("AAPL");
    expect(
      evaluatePriceAlert(
        {
          createdAt: SESSION_OPEN,
          kind: "above",
          lastCheckedAt: null,
          level: "345",
        },
        aapl
      )
    ).toEqual({ hit: true, price: 348.149_993_896_484_4 });
  });

  it("rings an at-or-below stop on a bar low (BAC low 53.64 <= 54)", () => {
    const bac = quoteOf("BAC");
    expect(
      evaluatePriceAlert(
        {
          createdAt: SESSION_OPEN,
          kind: "below",
          lastCheckedAt: null,
          level: "54",
        },
        bac
      )
    ).toEqual({ hit: true, price: 53.639_999_389_648_44 });
    expect(
      evaluatePriceAlert(
        {
          createdAt: SESSION_OPEN,
          kind: "below",
          lastCheckedAt: null,
          level: "53",
        },
        bac
      )
    ).toEqual({ hit: false });
  });

  it("ignores 5-minute bars that ended before the window started (TSLA)", () => {
    const tsla = quoteOf("TSLA");
    const firstBar = epoch(1_792_416_600);
    expect(
      evaluatePriceAlert(
        {
          createdAt: firstBar,
          kind: "above",
          lastCheckedAt: null,
          level: "367",
        },
        tsla
      )
    ).toEqual({ hit: true, price: 367.598_785_400_390_6 });
    expect(
      evaluatePriceAlert(
        {
          createdAt: epoch(1_792_421_400),
          kind: "above",
          lastCheckedAt: null,
          level: "367",
        },
        tsla
      )
    ).toEqual({ hit: false });
    expect(
      evaluatePriceAlert(
        {
          createdAt: firstBar,
          kind: "below",
          lastCheckedAt: null,
          level: "355",
        },
        tsla
      )
    ).toEqual({ hit: true, price: 354.470_001_220_703_1 });
    // A window opening after a bar started skips that bar.
    expect(
      evaluatePriceAlert(
        {
          createdAt: epoch(1_792_416_900),
          kind: "below",
          lastCheckedAt: null,
          level: "355",
        },
        tsla
      )
    ).toEqual({ hit: false });
  });

  it("never counts a bar that started before the rule existed (created 10:03, 10:00 bar high 101)", () => {
    const quote: PriceAlertQuote = {
      bars: [
        { high: 101, low: 98, start: new Date("2026-10-13T14:00:00.000Z") },
        { high: 99.5, low: 98.5, start: new Date("2026-10-13T14:05:00.000Z") },
      ],
      last: 99,
      lastAt: new Date("2026-10-13T14:06:00.000Z"),
      symbol: "X",
    };
    const createdAt = new Date("2026-10-13T14:03:00.000Z");
    expect(
      evaluatePriceAlert(
        { createdAt, kind: "above", lastCheckedAt: null, level: "100" },
        quote
      )
    ).toEqual({ hit: false });
    expect(
      evaluatePriceAlert(
        { createdAt, kind: "above", lastCheckedAt: null, level: "99.5" },
        quote
      )
    ).toEqual({ hit: true, price: 99.5 });
  });

  it("keeps the bar that straddles the last check (checks 10:05:17 and 10:10:20, touch at 10:07)", () => {
    const quote: PriceAlertQuote = {
      bars: [
        { high: 99, low: 98, start: new Date("2026-10-13T14:00:00.000Z") },
        { high: 101, low: 98.5, start: new Date("2026-10-13T14:05:00.000Z") },
        { high: 99.2, low: 98.7, start: new Date("2026-10-13T14:10:00.000Z") },
      ],
      last: 99,
      lastAt: new Date("2026-10-13T14:10:20.000Z"),
      symbol: "X",
    };
    const condition = {
      createdAt: new Date("2026-10-13T13:00:00.000Z"),
      kind: "above",
      lastCheckedAt: new Date("2026-10-13T14:05:17.000Z"),
      level: "100",
    } as const;
    expect(evaluatePriceAlert(condition, quote)).toEqual({
      hit: true,
      price: 101,
    });
    // A bar that ended at or before the last check is not evaluated again.
    expect(
      evaluatePriceAlert(
        { ...condition, lastCheckedAt: new Date("2026-10-13T14:10:00.000Z") },
        quote
      )
    ).toEqual({ hit: false });
  });

  it("rings a below rule on the last price when no bar touched", () => {
    const ko = quoteOf("KO");
    expect(
      evaluatePriceAlert(
        {
          createdAt: AFTER_CLOSE,
          kind: "below",
          lastCheckedAt: null,
          level: "90.5",
        },
        ko
      )
    ).toEqual({ hit: true, price: 90.11 });
  });
});

describe("price alert helpers", () => {
  it("builds the intraday chart URL with Yahoo's class-share spelling", () => {
    expect(priceAlertChartUrl("BRK.B")).toBe(
      "https://query1.finance.yahoo.com/v8/finance/chart/BRK-B?range=1d&interval=5m"
    );
  });

  it("formats prices as plain decimals with at most four fractional digits", () => {
    expect(formatPriceAlertPrice(348.149_993_896_484_4)).toBe("348.15");
    expect(formatPriceAlertPrice(367.598_785_400_390_6)).toBe("367.5988");
    expect(formatPriceAlertPrice(1000)).toBe("1000");
    expect(formatPriceAlertPrice(10.5)).toBe("10.5");
  });

  it("plans a run over the first distinct symbols and keeps only their rules", () => {
    const rules = [
      { id: "1", symbol: "AAA" },
      { id: "2", symbol: "BBB" },
      { id: "3", symbol: "AAA" },
      { id: "4", symbol: "CCC" },
    ];
    expect(planPriceAlertRun(rules, 2)).toEqual({
      rules: [rules[0], rules[1], rules[2]],
      symbols: ["AAA", "BBB"],
    });
    expect(planPriceAlertRun([], 2)).toEqual({ rules: [], symbols: [] });
    expect(planPriceAlertRun(rules, 5).symbols).toEqual(["AAA", "BBB", "CCC"]);
  });

  it("keeps the notification text fixed and free of trading instructions", () => {
    expect(PRICE_ALERT_NOTIFICATION).toEqual({
      body: "A price alert rule triggered. Open Vertex to review it. This is not an instruction to trade.",
      title: "Vertex price alert",
    });
  });
});

describe("price alert contract schemas", () => {
  it("normalizes the symbol, keeps the level a decimal string and blanks an empty note", () => {
    expect(
      PriceAlertCreateInputSchema.parse({
        kind: "below",
        level: 54,
        note: "  ",
        role: "stop",
        symbol: " bac ",
      })
    ).toEqual({
      kind: "below",
      level: "54",
      note: null,
      role: "stop",
      symbol: "BAC",
    });
    expect(
      PriceAlertCreateInputSchema.parse({
        kind: "above",
        level: "345.5",
        note: " breakout ",
        role: "target",
        symbol: "AAPL",
      }).note
    ).toBe("breakout");
    for (const bad of [
      { kind: "above", level: "0", role: "price", symbol: "AAPL" },
      { kind: "above", level: "1e3", role: "price", symbol: "AAPL" },
      { kind: "up", level: "1", role: "price", symbol: "AAPL" },
      { kind: "above", level: "1", role: "price", symbol: "1AB" },
    ]) {
      expect(PriceAlertCreateInputSchema.safeParse(bad).success).toBe(false);
    }
  });

  it("models a rule state as active or triggered, never both", () => {
    expect(
      PriceAlertStateSchema.safeParse({ lastCheckedAt: null, status: "active" })
        .success
    ).toBe(true);
    expect(
      PriceAlertStateSchema.safeParse({
        lastCheckedAt: null,
        status: "triggered",
      }).success
    ).toBe(false);
  });
});
