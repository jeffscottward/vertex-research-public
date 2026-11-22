import { describe, expect, it } from "vitest";

import {
  candleDate,
  candlesAfter,
  formatChange,
  formatContracts,
  FUTURES_OI_SERIES,
  futuresOiBars,
  futuresOiDaily,
  futuresOiFrom,
  futuresOiMarket,
  futuresOiPane,
  quarterlyExpiryBetween,
} from "./futures-oi.ts";
import type { DisplayCandle } from "./types.ts";

const candle = (date: string): DisplayCandle => {
  const timestamp = Date.parse(`${date}T00:00:00Z`);
  return {
    close: 101,
    high: 102,
    id: date,
    low: 99,
    open: 100,
    timestamp,
    volume: 1000,
  };
};
const candles = (...dates: string[]) => dates.map(candle);
const point = (date: string, value: number) => ({ date, value });

describe("futures open-interest match", () => {
  it("matches ES and NQ futures at CME", () => {
    expect(FUTURES_OI_SERIES).toEqual({ ES: "CME_ES_OI", NQ: "CME_NQ_OI" });
    for (const secType of ["CONTFUT", "FUT"]) {
      expect(futuresOiMarket({ exchange: "CME", secType, symbol: "ES" })).toBe(
        "ES"
      );
      expect(futuresOiMarket({ exchange: "CME", secType, symbol: "NQ" })).toBe(
        "NQ"
      );
    }
  });

  it("does not match a stock, another exchange or a micro contract", () => {
    expect(
      futuresOiMarket({ exchange: "SMART", secType: "STK", symbol: "SPY" })
    ).toBeNull();
    expect(
      futuresOiMarket({ exchange: "CME", secType: "STK", symbol: "ES" })
    ).toBeNull();
    expect(
      futuresOiMarket({ exchange: "QBALGO", secType: "CONTFUT", symbol: "ES" })
    ).toBeNull();
    expect(
      futuresOiMarket({ exchange: null, secType: "CONTFUT", symbol: "ES" })
    ).toBeNull();
    expect(
      futuresOiMarket({ exchange: "CME", secType: "CONTFUT", symbol: "MES" })
    ).toBeNull();
    // An inherited object key is not a market.
    expect(
      futuresOiMarket({
        exchange: "CME",
        secType: "CONTFUT",
        symbol: "toString",
      })
    ).toBeNull();
  });

  it("is daily only for unmerged 1 day bars", () => {
    expect(futuresOiDaily("1 day", false)).toBe(true);
    expect(futuresOiDaily("5 mins", false)).toBe(false);
    expect(futuresOiDaily("1 day", true)).toBe(false);
  });
});

describe("futures open-interest read start", () => {
  it("starts 10 days before the first candle", () => {
    expect(futuresOiFrom([])).toBeNull();
    expect(futuresOiFrom(candles("2026-11-02", "2026-11-03"))).toBe(
      "2026-10-23"
    );
    expect(candleDate(Date.parse("2026-11-19T00:00:00Z"))).toBe("2026-11-19");
  });
});

describe("quarterly expiry", () => {
  it("finds the third Friday of March, June, September and December", () => {
    // Third Fridays: 2025-12-19, 2026-03-20, 2026-06-19, 2026-09-18.
    expect(quarterlyExpiryBetween("2026-09-18", "2026-09-21")).toBe(true);
    expect(quarterlyExpiryBetween("2026-06-18", "2026-06-22")).toBe(true);
    expect(quarterlyExpiryBetween("2026-03-20", "2026-03-23")).toBe(true);
    expect(quarterlyExpiryBetween("2025-12-19", "2025-12-22")).toBe(true);
    // The expiry day compared with the day before it is a plain change.
    expect(quarterlyExpiryBetween("2026-09-17", "2026-09-18")).toBe(false);
    expect(quarterlyExpiryBetween("2026-09-21", "2026-09-22")).toBe(false);
    // The third Friday of a month that is not a quarter end.
    expect(quarterlyExpiryBetween("2026-10-16", "2026-10-19")).toBe(false);
    // A pair across the turn of the year checks both years.
    expect(quarterlyExpiryBetween("2025-12-31", "2026-01-02")).toBe(false);
    expect(quarterlyExpiryBetween("2025-12-18", "2026-01-02")).toBe(true);
  });
});

describe("futuresOiBars", () => {
  it("gives the change of adjacent days and marks the first stored date", () => {
    const bars = futuresOiBars(
      candles("2026-11-17", "2026-11-18", "2026-11-19"),
      [
        point("2026-11-17", 2_119_067),
        point("2026-11-18", 2_115_253),
        point("2026-11-19", 2_127_055),
      ]
    );
    expect(bars).toEqual([
      {
        change: null,
        date: "2026-11-17",
        figure: 2_119_067,
        noChange: "first",
        previousDate: null,
        timestamp: Date.parse("2026-11-17T00:00:00Z"),
      },
      {
        change: -3814,
        date: "2026-11-18",
        figure: 2_115_253,
        noChange: null,
        previousDate: "2026-11-17",
        timestamp: Date.parse("2026-11-18T00:00:00Z"),
      },
      {
        change: 11_802,
        date: "2026-11-19",
        figure: 2_127_055,
        noChange: null,
        previousDate: "2026-11-18",
        timestamp: Date.parse("2026-11-19T00:00:00Z"),
      },
    ]);
  });

  it("gives a zero change and sorts the stored points by date", () => {
    const bars = futuresOiBars(candles("2026-11-18", "2026-11-19"), [
      point("2026-11-19", 500),
      point("2026-11-18", 500),
    ]);
    expect(bars.map((bar) => [bar.date, bar.change, bar.noChange])).toEqual([
      ["2026-11-18", null, "first"],
      ["2026-11-19", 0, null],
    ]);
  });

  it("draws nothing for a candle without a figure and marks the next stored day as a gap", () => {
    const bars = futuresOiBars(
      candles("2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"),
      [
        point("2026-11-13", 90),
        point("2026-11-16", 100),
        point("2026-11-18", 130),
        point("2026-11-19", 125),
      ]
    );
    expect(bars.map((bar) => [bar.date, bar.change, bar.noChange])).toEqual([
      // The stored day before the first candle is the day to compare with.
      ["2026-11-16", 10, null],
      ["2026-11-18", null, "gap"],
      ["2026-11-19", -5, null],
    ]);
    expect(bars[1]?.previousDate).toBe("2026-11-16");
  });

  it("skips a stored date without a candle and compares the next day with it", () => {
    // 2026-04-03 (Good Friday) has a file and no regular-hours candle.
    const bars = futuresOiBars(candles("2026-04-02", "2026-04-06"), [
      point("2026-04-01", 1000),
      point("2026-04-02", 1010),
      point("2026-04-03", 1025),
      point("2026-04-06", 1005),
    ]);
    expect(bars.map((bar) => [bar.date, bar.change, bar.previousDate])).toEqual(
      [
        ["2026-04-02", 10, "2026-04-01"],
        ["2026-04-06", -20, "2026-04-03"],
      ]
    );
  });

  it("draws no change for the first figure after a quarterly expiry", () => {
    const september = futuresOiBars(
      candles("2026-09-17", "2026-09-18", "2026-09-21"),
      [
        point("2026-09-17", 2_600_000),
        point("2026-09-18", 2_610_000),
        point("2026-09-21", 2_108_198),
      ]
    );
    expect(
      september.map((bar) => [bar.date, bar.change, bar.noChange])
    ).toEqual([
      ["2026-09-17", null, "first"],
      // The third Friday itself has a change.
      ["2026-09-18", 10_000, null],
      ["2026-09-21", null, "expiry"],
    ]);
    // 2026-06-19 (third Friday) is a holiday without a file and without a candle.
    const june = futuresOiBars(candles("2026-06-18", "2026-06-22"), [
      point("2026-06-17", 2_590_000),
      point("2026-06-18", 2_600_000),
      point("2026-06-22", 2_064_159),
    ]);
    expect(june.map((bar) => [bar.date, bar.change, bar.noChange])).toEqual([
      ["2026-06-18", 10_000, null],
      ["2026-06-22", null, "expiry"],
    ]);
  });

  it("puts the expiry rule before the gap rule", () => {
    const bars = futuresOiBars(
      candles("2026-09-17", "2026-09-18", "2026-09-21"),
      [point("2026-09-17", 10), point("2026-09-21", 5)]
    );
    expect(bars.at(-1)?.noChange).toBe("expiry");
  });
});

describe("futuresOiPane", () => {
  it("returns null without a change", () => {
    expect(futuresOiPane([])).toBeNull();
    expect(
      futuresOiPane(
        futuresOiBars(candles("2026-11-18"), [point("2026-11-18", 5)])
      )
    ).toBeNull();
  });

  it("holds one point per drawn change", () => {
    const bars = futuresOiBars(
      candles("2026-11-17", "2026-11-18", "2026-11-19"),
      [
        point("2026-11-17", 100),
        point("2026-11-18", 90),
        point("2026-11-19", 120),
      ]
    );
    expect(futuresOiPane(bars)).toEqual({
      points: [
        { timestamp: Date.parse("2026-11-18T00:00:00Z"), value: -10 },
        { timestamp: Date.parse("2026-11-19T00:00:00Z"), value: 30 },
      ],
      precision: 0,
      title: "OI change",
    });
  });
});

describe("candlesAfter", () => {
  it("counts the candles after the newest stored date", () => {
    const shown = candles(
      "2026-11-18",
      "2026-11-19",
      "2026-11-20",
      "2026-11-23",
      "2026-11-24"
    );
    expect(candlesAfter(shown, "2026-11-24")).toBe(0);
    expect(candlesAfter(shown, "2026-11-23")).toBe(1);
    expect(candlesAfter(shown, "2026-11-19")).toBe(3);
  });
});

describe("number formats", () => {
  it("groups a figure and signs a change", () => {
    expect(formatContracts(2_127_055)).toBe("2,127,055");
    expect(formatChange(11_802)).toBe("+11,802");
    expect(formatChange(-3814)).toBe("-3,814");
    expect(formatChange(0)).toBe("0");
  });
});
