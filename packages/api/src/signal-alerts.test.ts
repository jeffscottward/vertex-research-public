import { describe, expect, it } from "vitest";

import type { SignalAlertCondition } from "./contracts/signal-alerts.ts";
import {
  backfillSignalAlert,
  barsFromYahooChart,
  conditionSeries,
  describeSignalCondition,
  evaluateSignalAlert,
  parseWatchRequest,
  planSignalAlertRun,
  type SignalBar,
  signalAlertChartUrl,
  sourceLine,
  yahooSymbolOf,
} from "./signal-alerts.ts";

const MINUTE = 60_000;
const START = Date.parse("2026-11-02T14:30:00.000Z"); // 09:30 New York

const bar = (index: number, close: number, width = 15): SignalBar => ({
  close,
  high: close + 1,
  low: close - 1,
  open: close,
  start: new Date(START + index * width * MINUTE),
});

const series = (closes: readonly number[], width = 15): SignalBar[] =>
  closes.map((close, index) => bar(index, close, width));

const crossValue = (
  operator: SignalAlertCondition["operator"],
  value: string
): SignalAlertCondition => ({
  left: { field: "close", type: "price" },
  operator,
  right: { type: "value", value },
});

describe("signal alert bars", () => {
  it("parses Yahoo OHLC, drops incomplete bars and sorts oldest first", () => {
    const result = barsFromYahooChart({
      chart: {
        result: [
          {
            indicators: {
              quote: [
                {
                  close: [11, null, 10],
                  high: [12, 5, 11],
                  low: [10, 4, 9],
                  open: [10, 5, 10],
                },
              ],
            },
            timestamp: [200, 300, 100],
          },
        ],
      },
    });
    expect(result).toEqual({
      bars: [
        { close: 10, high: 11, low: 9, open: 10, start: new Date(100_000) },
        { close: 11, high: 12, low: 10, open: 10, start: new Date(200_000) },
      ],
      ok: true,
    });
  });

  it("reports unexpected or empty documents", () => {
    expect(barsFromYahooChart({ nope: 1 })).toMatchObject({ ok: false });
    expect(barsFromYahooChart({ chart: { result: null } })).toEqual({
      ok: false,
      reason: "Yahoo has no data for this symbol",
    });
    expect(
      barsFromYahooChart({
        chart: { result: [{ indicators: {}, timestamp: [1] }] },
      })
    ).toEqual({ ok: false, reason: "Yahoo has no bars for this symbol" });
    expect(
      barsFromYahooChart({ chart: { result: [{ indicators: {} }] } })
    ).toEqual({ ok: false, reason: "Yahoo has no bars for this symbol" });
  });

  it("maps futures roots to Yahoo continuous contracts and builds the URL", () => {
    expect(yahooSymbolOf("NQ=F")).toBe("NQ=F");
    // CL is Colgate unless the contract is written: never guessed as crude oil.
    expect(yahooSymbolOf("CL")).toBe("CL");
    expect(yahooSymbolOf("BRK.B")).toBe("BRK-B");
    expect(signalAlertChartUrl("NQ=F", "1h")).toBe(
      "https://query1.finance.yahoo.com/v8/finance/chart/NQ%3DF?range=1y&interval=60m"
    );
    expect(signalAlertChartUrl("SPY", "15m")).toContain(
      "range=60d&interval=15m"
    );
  });
});

describe("signal alert lines", () => {
  const bars = series([1, 2, 3, 4, 5]);

  it("computes SMA, EMA and the N-bar high/low before each bar", () => {
    expect(sourceLine({ period: 3, type: "sma" }, bars, "15m")).toEqual([
      null,
      null,
      2,
      3,
      4,
    ]);
    const ema = sourceLine({ period: 2, type: "ema" }, bars, "15m");
    expect(ema.slice(0, 2)).toEqual([null, 1.5]);
    expect(ema[2]).toBeCloseTo(2.5);
    expect(sourceLine({ period: 2, type: "highest" }, bars, "15m")).toEqual([
      null,
      null,
      3,
      4,
      5,
    ]);
    expect(sourceLine({ period: 2, type: "lowest" }, bars, "15m")).toEqual([
      null,
      null,
      0,
      1,
      2,
    ]);
  });

  it("builds the opening range per New York session day once it is complete", () => {
    const day = series([10, 12, 11, 13]);
    const nextDay = series([20, 21], 15).map((entry, index) => ({
      ...entry,
      start: new Date(START + 24 * 60 * MINUTE + index * 15 * MINUTE),
    }));
    const line = sourceLine(
      { minutes: 30, side: "high", type: "opening-range" },
      [...day, ...nextDay],
      "15m"
    );
    expect(line).toEqual([null, null, 13, 13, null, null]);
    expect(
      sourceLine(
        { minutes: 30, side: "low", type: "opening-range" },
        day,
        "15m"
      )
    ).toEqual([null, null, 9, 9]);
    expect(
      sourceLine(
        { minutes: 30, side: "high", type: "opening-range" },
        day,
        "1d"
      )
    ).toEqual([null, null, null, null]);
  });

  it("evaluates crossing up, down, either and level conditions", () => {
    const closes = series([9, 11, 12, 9, 11]);
    expect(
      conditionSeries(crossValue("crosses-above", "10"), closes, "15m")
    ).toEqual([false, true, false, false, true]);
    expect(
      conditionSeries(crossValue("crosses-below", "10"), closes, "15m")
    ).toEqual([false, false, false, true, false]);
    expect(conditionSeries(crossValue("crosses", "10"), closes, "15m")).toEqual(
      [false, true, false, true, true]
    );
    expect(conditionSeries(crossValue("above", "10"), closes, "15m")).toEqual([
      false,
      true,
      true,
      false,
      true,
    ]);
    expect(conditionSeries(crossValue("below", "10"), closes, "15m")).toEqual([
      true,
      false,
      false,
      true,
      false,
    ]);
  });

  it("treats undefined lines as false, including the bar before a cross", () => {
    expect(
      conditionSeries(
        {
          left: { field: "close", type: "price" },
          operator: "crosses-above",
          right: { period: 2, type: "sma" },
        },
        series([5, 5, 9, 4, 9]),
        "15m"
      )
    ).toEqual([false, false, true, false, true]);
  });

  it("describes conditions in words", () => {
    expect(
      describeSignalCondition({
        left: { period: 20, type: "sma" },
        operator: "crosses-above",
        right: { period: 50, type: "ema" },
      })
    ).toBe("SMA(20) crosses above EMA(50)");
    expect(
      describeSignalCondition({
        left: { field: "close", type: "price" },
        operator: "below",
        right: { minutes: 30, side: "low", type: "opening-range" },
      })
    ).toBe("close below 30m opening range low");
    expect(
      describeSignalCondition({
        left: { period: 5, type: "highest" },
        operator: "crosses",
        right: { period: 5, type: "lowest" },
      })
    ).toBe("5-bar high crosses 5-bar low");
  });
});

describe("signal alert evaluation", () => {
  const closes = series([9, 11, 9, 11, 9, 11]);
  // Bars 0-4 are closed; bar 5 (start +75m) is forming at +80m.
  const now = new Date(START + 80 * MINUTE);
  const cursor = {
    createdAt: new Date(START - 60 * MINUTE),
    lastBarAt: null,
    lastFiredBarAt: null,
  };
  const rule = (frequency: "once" | "per-bar" | "per-bar-close") => ({
    condition: crossValue("crosses-above", "10"),
    frequency,
    timeframe: "15m" as const,
  });

  it("per bar close fires on new closed bars only (at most three per run)", () => {
    const result = evaluateSignalAlert(
      rule("per-bar-close"),
      cursor,
      closes,
      now
    );
    expect(result.fires.map((fire) => fire.barAt)).toEqual([
      closes[1]?.start,
      closes[3]?.start,
    ]);
    expect(result.lastBarAt).toEqual(closes[4]?.start);
    expect(result.done).toBe(false);
  });

  it("per bar also fires on the forming bar, once per bar", () => {
    const result = evaluateSignalAlert(rule("per-bar"), cursor, closes, now);
    expect(result.fires.map((fire) => fire.price)).toEqual([11, 11, 11]);
    const again = evaluateSignalAlert(
      rule("per-bar"),
      {
        ...cursor,
        lastBarAt: result.lastBarAt,
        lastFiredBarAt: closes[5]?.start ?? null,
      },
      closes,
      now
    );
    expect(again.fires).toEqual([]);
  });

  it("only once fires the first match and is done", () => {
    const result = evaluateSignalAlert(rule("once"), cursor, closes, now);
    expect(result.fires).toEqual([{ barAt: closes[1]?.start, price: 11 }]);
    expect(result.done).toBe(true);
  });

  it("never fires on bars from before the rule existed or already evaluated", () => {
    const late = evaluateSignalAlert(
      rule("per-bar-close"),
      { ...cursor, createdAt: new Date(START + 50 * MINUTE) },
      closes,
      now
    );
    expect(late.fires.map((fire) => fire.barAt)).toEqual([closes[3]?.start]);
    const seen = evaluateSignalAlert(
      rule("per-bar-close"),
      { ...cursor, lastBarAt: closes[4]?.start ?? null },
      closes,
      now
    );
    expect(seen.fires).toEqual([]);
    expect(seen.lastBarAt).toEqual(closes[4]?.start);
  });

  it("limits a long gap to the newest three fires", () => {
    const many = series([9, 11, 9, 11, 9, 11, 9, 11, 9, 11]);
    const result = evaluateSignalAlert(
      rule("per-bar-close"),
      cursor,
      many,
      new Date(START + 24 * 60 * MINUTE)
    );
    expect(result.fires.map((fire) => fire.barAt)).toEqual([
      many[5]?.start,
      many[7]?.start,
      many[9]?.start,
    ]);
  });

  it("backfills over closed bars with a day span and recent fires", () => {
    const backfill = backfillSignalAlert(
      crossValue("crosses-above", "10"),
      closes,
      "15m",
      now
    );
    expect(backfill).toEqual({
      bars: 5,
      count: 2,
      days: 1,
      from: closes[0]?.start,
      recent: [closes[3]?.start, closes[1]?.start],
      to: closes[4]?.start,
    });
    expect(
      backfillSignalAlert(crossValue("above", "1"), [], "1d", now)
    ).toMatchObject({ bars: 0, count: 0, days: 0, from: null });
  });

  it("plans one fetch per symbol and timeframe and defers the rest", () => {
    const plan = planSignalAlertRun(
      [
        { id: "a", symbol: "SPY", timeframe: "15m" as const },
        { id: "b", symbol: "SPY", timeframe: "15m" as const },
        { id: "c", symbol: "SPY", timeframe: "1d" as const },
        { id: "d", symbol: "QQQ", timeframe: "1d" as const },
      ],
      2
    );
    expect([...plan.series.keys()]).toEqual(["SPY|15m", "SPY|1d"]);
    expect(plan.series.get("SPY|15m")?.rules.map((rule) => rule.id)).toEqual([
      "a",
      "b",
    ]);
    expect(plan.deferred.map((rule) => rule.id)).toEqual(["d"]);
  });
});

describe("watch request parser", () => {
  it("turns the LuxAlgo example into a per-bar-close opening range watch", () => {
    expect(
      parseWatchRequest(
        "Watch NQ and wake me when a 15m bar closes above the opening range"
      )
    ).toEqual({
      ok: true,
      proposal: {
        condition: {
          left: { field: "close", type: "price" },
          operator: "crosses-above",
          right: { minutes: 30, side: "high", type: "opening-range" },
        },
        frequency: "per-bar-close",
        summary:
          "Watch NQ=F on 15m bars: alert when close crosses above 30m opening range high on bar close.",
        symbol: "NQ=F",
        timeframe: "15m",
      },
    });
  });

  it("reads moving averages, N-bar ranges, levels and timeframes", () => {
    expect(
      parseWatchRequest("watch spy hourly when price crosses below the 50 sma")
    ).toMatchObject({
      ok: true,
      proposal: {
        condition: {
          operator: "crosses-below",
          right: { period: 50, type: "sma" },
        },
        frequency: "once",
        symbol: "SPY",
        timeframe: "1h",
      },
    });
    expect(
      parseWatchRequest(
        "Watch AAPL daily, tell me when it breaks the 20-bar high above"
      )
    ).toMatchObject({
      proposal: { condition: { right: { period: 20, type: "highest" } } },
    });
    expect(
      parseWatchRequest(
        "Watch QQQ when it crosses below the 21 ema and the 10-bar low"
      )
    ).toMatchObject({
      proposal: { condition: { right: { period: 21, type: "ema" } } },
    });
    expect(
      parseWatchRequest("Watch QQQ daily when it breaks the 10-bar low below")
    ).toMatchObject({
      proposal: { condition: { right: { period: 10, type: "lowest" } } },
    });
    expect(
      parseWatchRequest("Watch TSLA on 5m when it is under 250.5")
    ).toMatchObject({
      proposal: {
        condition: {
          operator: "below",
          right: { type: "value", value: "250.5" },
        },
        timeframe: "5m",
      },
    });
    expect(
      parseWatchRequest(
        "Watch ES when a bar closes below the 60 minute opening range"
      )
    ).toMatchObject({
      proposal: {
        condition: { right: { minutes: 60, side: "low" } },
      },
    });
  });

  it("keeps ambiguous roots as stock symbols unless the contract is written", () => {
    expect(parseWatchRequest("Watch CL when it closes above 60")).toMatchObject(
      { proposal: { symbol: "CL" } }
    );
    expect(
      parseWatchRequest("Watch CL=F when it closes above 60")
    ).toMatchObject({ proposal: { symbol: "CL=F" } });
  });

  it("explains what is missing instead of guessing", () => {
    expect(parseWatchRequest("wake me when it goes up")).toMatchObject({
      ok: false,
    });
    expect(parseWatchRequest("watch NQ when it moves")).toEqual({
      ok: false,
      reason: 'Say "above" or "below" the level to watch',
    });
    expect(parseWatchRequest("watch NQ when it goes above")).toMatchObject({
      ok: false,
    });
  });
});
