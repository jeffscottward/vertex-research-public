import { describe, expect, it } from "vitest";
import { validDisplayCandles } from "./kline-adapter.ts";
import type { DisplayCandle } from "./types.ts";
import {
  BAR_SECONDS,
  DISPLAY_CANDLE_LIMIT,
  barsToDisplayCandles,
  coerceDuration,
  dataWindowRows,
  displayValues,
  durationOptionsFor,
  heikinAshi,
  tradeMarkers,
} from "./market-bars.ts";

const DAY = 86_400;
const t0 = Date.parse("2024-01-02T00:00:00Z") / 1000;
const bar = (index: number, close = 100 + index) => ({
  t: t0 + index * DAY,
  o: close,
  h: close + 1,
  l: close - 1,
  c: close,
  v: 10,
});

describe("IBKR bars to display candles", () => {
  it("maps epoch seconds to millisecond candles, null volume to zero, and passes the adapter validator", () => {
    const result = barsToDisplayCandles([bar(0), { ...bar(1), v: null }]);
    expect(result.dropped).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.candles).toEqual([
      {
        id: String(t0),
        timestamp: t0 * 1000,
        open: 100,
        high: 101,
        low: 99,
        close: 100,
        volume: 10,
      },
      {
        id: String(t0 + DAY),
        timestamp: (t0 + DAY) * 1000,
        open: 101,
        high: 102,
        low: 100,
        close: 101,
        volume: 0,
      },
    ]);
    return expect(validDisplayCandles(result.candles)).toBe(true);
  });

  it("keeps only the most recent 4096 bars and reports how many were dropped", () => {
    const bars = Array.from({ length: DISPLAY_CANDLE_LIMIT + 10 }, (_, index) =>
      bar(index)
    );
    const result = barsToDisplayCandles(bars);
    expect(result.candles).toHaveLength(DISPLAY_CANDLE_LIMIT);
    expect(result.dropped).toBe(10);
    expect(result.candles[0]!.timestamp).toBe(bars[10]!.t * 1000);
    return expect(validDisplayCandles(result.candles)).toBe(true);
  });

  return it("skips non-finite, negative and duplicate bars and widens high/low to contain open and close", () => {
    const result = barsToDisplayCandles([
      bar(0),
      bar(0),
      { ...bar(1), c: Number.NaN },
      { ...bar(2), l: -1 },
      { ...bar(3), o: 110, h: 105 },
    ]);
    expect(result.skipped).toBe(3);
    expect(result.candles.map((candle) => candle.id)).toEqual([
      String(t0),
      String(t0 + 3 * DAY),
    ]);
    expect(result.candles[1]!.high).toBe(110);
    return expect(validDisplayCandles(result.candles)).toBe(true);
  });
});

describe("duration choices", () => {
  return it("offers only durations the contract allows for each bar size", () => {
    expect(durationOptionsFor("1 day")).toEqual([
      "1 W",
      "2 W",
      "1 M",
      "3 M",
      "6 M",
      "1 Y",
    ]);
    expect(durationOptionsFor("1 min")).toEqual(["1 D", "2 D"]);
    expect(durationOptionsFor("1 hour")).toEqual([
      "1 D",
      "2 D",
      "1 W",
      "2 W",
      "1 M",
    ]);
    expect(coerceDuration("1 min", "1 Y")).toBe("2 D");
    expect(coerceDuration("1 day", "3 M")).toBe("3 M");
    return expect(BAR_SECONDS["15 mins"]).toBe(900);
  });
});

describe("backtest trades as chart markers", () => {
  const candles = barsToDisplayCandles([
    bar(0),
    bar(1),
    bar(2),
    bar(3),
  ]).candles;
  const trade = (
    entry_t: string,
    exit_t: string,
    side: "long" | "short" = "long",
    symbol?: string
  ) => ({
    entry_t,
    exit_t,
    side,
    entry_px: 100.5,
    exit_px: 102.25,
    ...(symbol === undefined ? {} : { symbol }),
  });

  it("snaps entries and exits to the containing bar and counts points outside the loaded range", () => {
    const result = tradeMarkers(
      [
        trade("2024-01-02", "2024-01-03T15:30:00Z"),
        trade("2024-01-04", "2024-01-09", "short"),
        trade("2023-12-01", "2023-12-05"),
      ],
      candles,
      BAR_SECONDS["1 day"]
    );
    expect(result.markers).toEqual([
      { id: "trade-0-entry", timestamp: t0 * 1000, value: 100.5, text: "Long" },
      {
        id: "trade-0-exit",
        timestamp: (t0 + DAY) * 1000,
        value: 102.25,
        text: "Exit",
      },
      {
        id: "trade-1-entry",
        timestamp: (t0 + 2 * DAY) * 1000,
        value: 100.5,
        text: "Short",
      },
    ]);
    expect(result.shown).toBe(3);
    expect(result.outside).toBe(3);
    return expect(result.otherSymbol).toBe(0);
  });

  return it("skips trades reported for a different symbol and handles an empty bar range", () => {
    const result = tradeMarkers(
      [
        trade("2024-01-02", "2024-01-03", "long", "QQQ"),
        trade("2024-01-02", "2024-01-03", "long", "spy"),
      ],
      candles,
      BAR_SECONDS["1 day"],
      ["SPY"]
    );
    expect(result.otherSymbol).toBe(1);
    expect(result.shown).toBe(2);
    return expect(
      tradeMarkers(
        [trade("2024-01-02", "2024-01-03")],
        [],
        BAR_SECONDS["1 day"]
      )
    ).toEqual({ markers: [], shown: 0, outside: 2, otherSymbol: 0 });
  });
});

const displayBars: readonly DisplayCandle[] = [
  {
    close: 11,
    high: 12,
    id: "a",
    low: 9,
    open: 10,
    timestamp: 1000,
    volume: 5,
  },
  {
    close: 12,
    high: 13,
    id: "b",
    low: 10,
    open: 11,
    timestamp: 2000,
    volume: 7,
  },
];

describe("display bars", () => {
  it("computes Heikin Ashi bars", () => {
    const [first, second] = heikinAshi(displayBars);
    expect(first).toEqual({
      ...displayBars[0],
      close: 10.5,
      high: 12,
      low: 9,
      open: 10.5,
    });
    expect(second?.open).toBe(10.5);
    expect(second?.close).toBe(11.5);
    expect(second?.high).toBe(13);
    expect(second?.low).toBe(10);
    expect(displayValues(displayBars, "candles")).toBe(displayBars);
    return expect(displayValues(displayBars, "heikin-ashi")).toHaveLength(2);
  });
  it("builds data window rows", () => {
    expect(dataWindowRows(undefined, undefined, 2)).toEqual([]);
    const rows = dataWindowRows(displayBars[1], 11, 2);
    expect(rows.map((row) => row.label)).toEqual([
      "Time (UTC)",
      "Open",
      "High",
      "Low",
      "Close",
      "Volume",
      "Change",
    ]);
    expect(rows.at(-1)?.value).toBe("+1.00 (+9.09%)");
    expect(dataWindowRows(displayBars[0], 12, 2).at(-1)?.value).toBe(
      "-1.00 (-8.33%)"
    );
    return expect(dataWindowRows(displayBars[0], 0, 2)).toHaveLength(6);
  });
});
