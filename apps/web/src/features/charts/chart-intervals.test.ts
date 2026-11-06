import { marketDurationAllowed } from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  aggregateCandles,
  CHART_INTERVALS,
  INTERVAL_BARS,
  intervalForBars,
  isChartInterval,
  parseIntervalParam,
} from "./chart-intervals.ts";
import type { DisplayCandle } from "./types.ts";

const day = (iso: string, close: number, volume = 10): DisplayCandle => ({
  close,
  high: close + 1,
  id: iso,
  low: close - 1,
  open: close - 0.5,
  timestamp: Date.parse(`${iso}T00:00:00Z`),
  volume,
});

describe("chart intervals", () => {
  it("maps every interval to an allowed bars request", () => {
    for (const interval of CHART_INTERVALS) {
      const { barSize, duration } = INTERVAL_BARS[interval];
      expect(marketDurationAllowed(barSize, duration)).toBe(true);
    }
    expect(INTERVAL_BARS["1W"].aggregate).toBe("week");
    expect(INTERVAL_BARS["1M"].aggregate).toBe("month");
  });

  it("reads ?interval= case-sensitively with a 1D default", () => {
    expect(parseIntervalParam("?interval=1m")).toBe("1m");
    expect(parseIntervalParam("?interval=1M")).toBe("1M");
    expect(parseIntervalParam("?interval=2h")).toBe("1D");
    expect(parseIntervalParam("")).toBe("1D");
    expect(isChartInterval("1h")).toBe(true);
    expect(isChartInterval("1H")).toBe(false);
  });

  it("finds the interval for a plain bars request", () => {
    expect(intervalForBars("1 hour", "1 M")).toBe("1h");
    expect(intervalForBars("1 day", "1 Y")).toBe("1D");
    expect(intervalForBars("1 day", "6 M")).toBeNull();
  });

  it("merges daily candles into weeks and months", () => {
    const days = [
      day("2026-01-01", 10, 1),
      day("2026-01-02", 12, 2),
      day("2026-01-05", 9, 3),
      day("2026-02-02", 20, 4),
    ];
    const weeks = aggregateCandles(days, "week");
    expect(weeks.map((bar) => bar.id)).toEqual([
      "week-2025-12-29",
      "week-2026-01-05",
      "week-2026-02-02",
    ]);
    expect(weeks[0]).toMatchObject({
      close: 12,
      high: 13,
      low: 9,
      open: 9.5,
      volume: 3,
    });
    const months = aggregateCandles(days, "month");
    expect(months.map((bar) => [bar.id, bar.close, bar.volume])).toEqual([
      ["month-2026-01", 9, 6],
      ["month-2026-02", 20, 4],
    ]);
    expect(aggregateCandles([], "week")).toEqual([]);
  });
});
