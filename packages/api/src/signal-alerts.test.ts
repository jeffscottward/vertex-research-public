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
  barCloseTime,
  closedBars,
  isRegularSession,
  newYorkClock,
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
  const doc = (
    timestamps: readonly number[],
    closes: readonly (number | null)[]
  ) => ({
    chart: {
      result: [
        {
          indicators: {
            quote: [
              {
                close: closes,
                high: closes.map((close) =>
                  close === null ? null : close + 1
                ),
                low: closes.map((close) => (close === null ? null : close - 1)),
                open: closes,
              },
            ],
          },
          timestamp: timestamps,
        },
      ],
    },
  });

  it("parses Yahoo OHLC, drops incomplete rows, sorts and merges a live row into its bar", () => {
    const t0 = START / 1000;
    const result = barsFromYahooChart(
      doc([t0 + 900, t0 + 1800, t0, t0 + 1000], [11, null, 10, 12]),
      "15m"
    );
    expect(result).toEqual({
      bars: [
        { close: 10, high: 11, low: 9, open: 10, start: new Date(START) },
        {
          close: 12,
          high: 13,
          low: 10,
          open: 11,
          start: new Date(START + 15 * MINUTE),
        },
      ],
      ok: true,
    });
  });

  it("merges two daily rows of one New York day", () => {
    const t0 = START / 1000;
    const result = barsFromYahooChart(
      doc([t0, t0 + 3600, t0 + 86_400], [10, 12, 13]),
      "1d"
    );
    expect(result.ok && result.bars.map((entry) => entry.close)).toEqual([
      12, 13,
    ]);
  });

  it("reports unexpected or empty documents", () => {
    expect(barsFromYahooChart({ nope: 1 }, "15m")).toMatchObject({
      ok: false,
    });
    expect(barsFromYahooChart({ chart: { result: null } }, "15m")).toEqual({
      ok: false,
      reason: "Yahoo has no data for this symbol",
    });
    expect(
      barsFromYahooChart(
        { chart: { result: [{ indicators: {}, timestamp: [1] }] } },
        "15m"
      )
    ).toEqual({ ok: false, reason: "Yahoo has no bars for this symbol" });
    expect(
      barsFromYahooChart({ chart: { result: [{ indicators: {} }] } }, "1h")
    ).toEqual({ ok: false, reason: "Yahoo has no bars for this symbol" });
  });

  it("reads the New York clock", () => {
    expect(newYorkClock(new Date(START))).toEqual({
      day: "2026-11-02",
      minute: 570,
    });
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

  it("anchors the opening range at 09:30 New York, ignoring overnight bars", () => {
    const overnight = [
      { ...bar(0, 50), start: new Date(START - 9 * 60 * MINUTE) },
      ...series([10, 12, 11]),
    ];
    expect(
      sourceLine(
        { minutes: 30, side: "high", type: "opening-range" },
        overnight,
        "15m"
      )
    ).toEqual([null, null, null, 13]);
  });

  it("fires the opening range breakout on the first bar after the range", () => {
    const orb: SignalAlertCondition = {
      left: { field: "close", type: "price" },
      operator: "crosses-above",
      right: { minutes: 30, side: "high", type: "opening-range" },
    };
    expect(conditionSeries(orb, series([10, 11, 13, 14]), "15m")).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(
      conditionSeries(
        {
          ...orb,
          operator: "crosses-below",
          right: { minutes: 30, side: "low", type: "opening-range" },
        },
        series([10, 11, 8, 7]),
        "15m"
      )
    ).toEqual([false, false, true, false]);
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
  // 09:30-10:45 New York, 15m bars; bar 5 (10:45) is forming at 10:50.
  const closes = series([9, 11, 9, 11, 9, 11]);
  const now = new Date(START + 80 * MINUTE);
  const cursor = {
    activeSince: new Date(START - 60 * MINUTE),
    lastBarAt: null,
    lastFiredBarAt: null,
  };
  const rule = (
    frequency: "once" | "per-bar" | "per-bar-close",
    regularSession = true
  ) => ({
    condition: crossValue("crosses-above", "10"),
    frequency,
    regularSession,
    timeframe: "15m" as const,
  });

  it("per bar close fires fresh closed bars only; stale ones just move the cursor", () => {
    const result = evaluateSignalAlert(
      rule("per-bar-close"),
      cursor,
      closes,
      now
    );
    // Bar 1 (09:45) ended at 10:00, more than two bars before 10:50: stale.
    expect(result.fires).toEqual([{ barAt: closes[3]?.start, price: 11 }]);
    expect(result.lastBarAt).toEqual(closes[4]?.start);
    expect(result.done).toBe(false);
  });

  it("per bar also fires on the forming bar, once per bar", () => {
    const result = evaluateSignalAlert(rule("per-bar"), cursor, closes, now);
    expect(result.fires.map((fire) => fire.barAt)).toEqual([
      closes[3]?.start,
      closes[5]?.start,
    ]);
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

  it("only once fires the first fresh match and is done", () => {
    const result = evaluateSignalAlert(rule("once"), cursor, closes, now);
    expect(result.fires).toEqual([{ barAt: closes[3]?.start, price: 11 }]);
    expect(result.done).toBe(true);
  });

  it("never fires on bars from before the rule was active or already evaluated", () => {
    const late = evaluateSignalAlert(
      rule("per-bar"),
      { ...cursor, activeSince: new Date(START + 65 * MINUTE) },
      closes,
      now
    );
    expect(late.fires.map((fire) => fire.barAt)).toEqual([closes[5]?.start]);
    const seen = evaluateSignalAlert(
      rule("per-bar-close"),
      { ...cursor, lastBarAt: closes[4]?.start ?? null },
      closes,
      now
    );
    expect(seen.fires).toEqual([]);
    expect(seen.lastBarAt).toEqual(closes[4]?.start);
  });

  it("limits a run to the newest three fires", () => {
    const many = series([11, 11, 11, 11, 11, 11, 11, 11, 11, 11]);
    const result = evaluateSignalAlert(
      { ...rule("per-bar", false), condition: crossValue("above", "10") },
      cursor,
      many,
      new Date(START + 145 * MINUTE)
    );
    expect(result.fires.map((fire) => fire.barAt)).toEqual([
      many[7]?.start,
      many[8]?.start,
      many[9]?.start,
    ]);
  });

  it("never fires a bar that closed before the rule was active, even after the close", () => {
    const hourly = [bar(0, 9, 60), bar(6, 11, 60)]; // 09:30 and 15:30 New York
    const created = new Date(START + 6 * 60 * MINUTE + 40 * MINUTE); // 16:10
    const result = evaluateSignalAlert(
      {
        ...rule("per-bar-close"),
        condition: crossValue("above", "10"),
        timeframe: "1h",
      },
      { ...cursor, activeSince: created },
      hourly,
      new Date(created.getTime() + 5 * MINUTE)
    );
    expect(result.fires).toEqual([]);
    expect(result.lastBarAt).toEqual(hourly[1]?.start);
    // The 15:30 bar closes at 16:00, so a rule active at 15:55 fires it at 16:05.
    const early = evaluateSignalAlert(
      {
        ...rule("per-bar-close"),
        condition: crossValue("above", "10"),
        timeframe: "1h",
      },
      {
        ...cursor,
        activeSince: new Date(START + 6 * 60 * MINUTE + 25 * MINUTE),
      },
      hourly,
      new Date(START + 6 * 60 * MINUTE + 35 * MINUTE)
    );
    expect(early.fires).toEqual([{ barAt: hourly[1]?.start, price: 11 }]);
    expect(barCloseTime(hourly, 1, "1h", true)).toBe(
      START + 6 * 60 * MINUTE + 30 * MINUTE
    );
    expect(barCloseTime(hourly, 1, "1h", false)).toBe(START + 7 * 60 * MINUTE);
    expect(barCloseTime(hourly, 0, "1h", true)).toBe(START + 60 * MINUTE);
    expect(barCloseTime(hourly, 9, "1h", true)).toBe(Number.POSITIVE_INFINITY);
    const evening = {
      ...bar(0, 9, 60),
      start: new Date(START + 9 * 60 * MINUTE),
    };
    expect(barCloseTime([evening], 0, "1h", true)).toBe(
      START + 10 * 60 * MINUTE
    );
  });

  it("closes bars by a later bar, the interval, or the 16:00 New York close", () => {
    const daily = [bar(0, 10, 24 * 60), bar(1, 11, 24 * 60)];
    // Day 2 09:30 bar at 15:59 New York: open; at 16:00: closed for stocks, open for futures.
    const beforeClose = new Date(START + 24 * 60 * MINUTE + 389 * MINUTE);
    const atClose = new Date(START + 24 * 60 * MINUTE + 390 * MINUTE);
    expect(closedBars(daily, "1d", beforeClose, true)).toEqual([true, false]);
    expect(closedBars(daily, "1d", atClose, true)).toEqual([true, true]);
    expect(closedBars(daily, "1d", atClose, false)).toEqual([true, false]);
    // The next New York day closes it too.
    expect(
      closedBars(
        [bar(0, 10, 60)],
        "1h",
        new Date(START + 20 * 60 * MINUTE),
        true
      )
    ).toEqual([true]);
    expect(
      closedBars([bar(0, 10)], "15m", new Date(START + 15 * MINUTE), false)
    ).toEqual([true]);
    expect(isRegularSession("NQ=F")).toBe(false);
    expect(isRegularSession("SPY")).toBe(true);
  });

  it("backfills over closed bars with a day span and recent fires", () => {
    const backfill = backfillSignalAlert(
      crossValue("crosses-above", "10"),
      closes,
      "15m",
      now,
      true
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
      backfillSignalAlert(crossValue("above", "1"), [], "1d", now, true)
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

  it("handles the reviewed edge cases without guessing", () => {
    expect(
      parseWatchRequest(
        "Watch NQ and wake me up when a 15m bar closes below 21,500"
      )
    ).toMatchObject({
      proposal: {
        condition: {
          operator: "crosses-below",
          right: { type: "value", value: "21500" },
        },
        symbol: "NQ=F",
      },
    });
    expect(
      parseWatchRequest("watch for TSLA crossing above 300.25")
    ).toMatchObject({
      proposal: {
        condition: { right: { value: "300.25" } },
        symbol: "TSLA",
      },
    });
    expect(
      parseWatchRequest("Watch the SPY when it closes above 500")
    ).toMatchObject({ proposal: { symbol: "SPY" } });
    expect(
      parseWatchRequest(
        "Watch SPY hourly when it closes above the opening range"
      )
    ).toMatchObject({ proposal: { condition: { right: { minutes: 60 } } } });
    expect(
      parseWatchRequest(
        "Watch SPY when it crosses above the 50 day moving average"
      )
    ).toMatchObject({ ok: false });
    expect(
      parseWatchRequest(
        "Watch SPY daily when it crosses above the 50 day moving average"
      )
    ).toMatchObject({ ok: true, proposal: { timeframe: "1d" } });
    expect(
      parseWatchRequest("Watch SPY when it goes above 5 or below 4")
    ).toEqual({ ok: false, reason: 'Say either "above" or "below", not both' });
    expect(
      parseWatchRequest(
        "Watch SPY daily when it closes above the opening range"
      )
    ).toEqual({ ok: false, reason: "An opening range needs intraday bars" });
    expect(
      parseWatchRequest(
        "Watch SPY when it closes above the 0 minute opening range"
      )
    ).toMatchObject({ proposal: { condition: { right: { minutes: 15 } } } });
  });

  it("never takes keywords as symbols and refuses futures hourly opening ranges", () => {
    expect(
      parseWatchRequest("Watch the opening range on SPY, wake me above it")
    ).toMatchObject({ ok: true, proposal: { symbol: "SPY" } });
    expect(parseWatchRequest("watch price on QQQ above 400")).toMatchObject({
      proposal: { symbol: "QQQ" },
    });
    expect(
      parseWatchRequest("Watch my NQ=F when price crosses above 21000")
    ).toMatchObject({ proposal: { symbol: "NQ=F" } });
    expect(parseWatchRequest("watch price above 400")).toMatchObject({
      ok: false,
    });
    expect(
      parseWatchRequest(
        "Watch NQ hourly when a bar closes above the opening range"
      )
    ).toMatchObject({ ok: false });
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
