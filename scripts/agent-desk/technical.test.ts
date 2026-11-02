import { describe, expect, it } from "vitest";
import {
  bars,
  dateAt,
  points,
  resetCloses,
  signalCloses,
} from "./fixtures.test-support.ts";
import {
  type Bar,
  backtestAgent,
  backtestParameters,
  completedBars,
  DEFAULT_BACKTEST,
  DEFAULT_RULE,
  dayOf,
  daysBetween,
  firstEvaluableIndex,
  isCalendarDay,
  ruleParameters,
  ruleSeries,
  simulateTrade,
  technicalAgent,
} from "./technical.ts";

const evaluate = (history: Bar[], asOf: string, rule = DEFAULT_RULE) =>
  technicalAgent(history, ruleSeries(history, rule), { asOf, rule });

describe("dates and parameters", () => {
  it("accepts only real calendar days", () => {
    expect(isCalendarDay("2026-02-28")).toBe(true);
    expect(isCalendarDay("2026-02-31")).toBe(false);
    expect(isCalendarDay("2026-13-01")).toBe(false);
    expect(isCalendarDay("2026-00-10")).toBe(false);
    expect(isCalendarDay("10/16/2026")).toBe(false);
    expect(isCalendarDay(20_261_016)).toBe(false);
    expect(dayOf("2026-09-10T20:00:01.000Z")).toBe("2026-09-10");
    expect(dayOf("bad")).toBeNull();
    expect(dayOf(null)).toBeNull();
    expect(daysBetween("2026-07-30", "2026-09-10")).toBe(42);
  });

  it("validates rule and backtest parameters", () => {
    expect(() => ruleParameters({ smaPeriod: 1.5 })).toThrow(
      "smaPeriod must be a positive integer"
    );
    expect(() => ruleParameters({ resetBandPct: -1 })).toThrow(
      "resetBandPct must be a non-negative number"
    );
    expect(() => backtestParameters({ holdSessions: 0 })).toThrow(
      "holdSessions must be a positive integer"
    );
    expect(backtestParameters()).toEqual(DEFAULT_BACKTEST);
    expect(firstEvaluableIndex(DEFAULT_RULE)).toBe(219);
  });
});

describe("completedBars", () => {
  it("drops malformed, partial, duplicate and out-of-order records", () => {
    const kept = completedBars([
      null,
      [1],
      7,
      { close: 1, date: "2024-01-02", open: 0.5 },
      { close: 2, date: "2024-01-02" },
      { close: 3, date: "2024-01-01" },
      { close: 0, date: "2024-01-03" },
      { close: 4, date: "2024-01-04", isPartial: true },
      { close: 5, date: "bad" },
      { close: 6, date: "2024-01-05", open: -1 },
    ]);
    expect(kept).toEqual([
      { close: 1, date: "2024-01-02", open: 0.5 },
      { close: 6, date: "2024-01-05", open: null },
    ]);
  });
});

describe("technicalAgent", () => {
  it("detects a ROC reset above a rising 200-session SMA", () => {
    const history = bars(resetCloses());
    const result = evaluate(history, dateAt(399));
    expect(result.status).toBe("evaluated");
    expect(result.reason).toBeNull();
    expect(result.requiredSamples).toBe(220);
    expect(result.rocPct).toBe(0);
    expect(result.priorRocPeakPct).toBeGreaterThanOrEqual(10);
    expect(result.checks).toEqual({
      closeAboveSma: true,
      priorRocHigh: true,
      rocNearZero: true,
      smaRising: true,
    });
    expect(result.signal).toBe(true);
    expect(result.stale).toBe(false);
  });

  it("reports missing, insufficient and stale data instead of guessing", () => {
    const short = bars(Array.from({ length: 150 }, (_, index) => 100 + index));
    const insufficient = evaluate(short, dateAt(149));
    expect(insufficient.status).toBe("insufficient-data");
    expect(insufficient.reason).toBe(
      "Rule needs 220 completed bars; 150 observed."
    );
    expect(insufficient.signal).toBe(false);
    const empty = evaluate([], "2024-01-01");
    expect(empty).toMatchObject({
      barDate: null,
      signal: false,
      stale: true,
      status: "unavailable",
    });
    const later = evaluate(bars(resetCloses()), "2025-03-01");
    expect(later.stale).toBe(true);
    expect(later.staleDays).toBeGreaterThan(5);
  });

  it("marks a close equal to a flat SMA as neither above nor rising", () => {
    const rule = ruleParameters({
      peakLookback: 1,
      rocPeriod: 1,
      slopeLookback: 1,
      smaPeriod: 2,
    });
    const [point] = ruleSeries(bars([100, 100, 100]), rule).slice(-1);
    expect(point?.checks).toEqual({
      closeAboveSma: false,
      priorRocHigh: false,
      rocNearZero: true,
      smaRising: false,
    });
    expect(point?.known).toBe(true);
  });

  it("never uses bars after the evaluated bar", () => {
    const history = bars(resetCloses());
    const full = ruleSeries(history, DEFAULT_RULE);
    const prefix = ruleSeries(history.slice(0, 361), DEFAULT_RULE);
    expect(full.slice(0, 361)).toEqual(prefix);
  });
});

describe("simulateTrade", () => {
  const settings = backtestParameters({ costBpsPerSide: 0, holdSessions: 3 });

  it("waits for the session after the signal", () => {
    expect(simulateTrade(bars([10, 11]), points([1, 1]), 1, settings)).toEqual({
      signalDate: dateAt(1),
      state: "pending-entry",
    });
  });

  it("exits at the next open when the entry bar closes below the SMA", () => {
    const trade = simulateTrade(
      bars([10, 10, 8, 9], [10, 10, 9.5, 8.5]),
      points([5, 5, 9, 9]),
      1,
      settings
    );
    expect(trade).toMatchObject({
      entry: { basis: "open", date: dateAt(2), price: 9.5 },
      exit: {
        basis: "open",
        date: dateAt(3),
        price: 8.5,
        reason: "close-below-sma",
      },
      exitIndex: 3,
      heldSessions: 1,
      state: "closed",
    });
  });

  it("fills at the close when the open is missing and marks a pending exit", () => {
    const trade = simulateTrade(
      bars([10, 10, 12, 8], [10, 10, null, null]),
      points([5, 5, 9, 9]),
      1,
      settings
    );
    expect(trade).toEqual({
      entry: { basis: "close", date: dateAt(2), price: 12 },
      exitSignalDate: dateAt(3),
      heldSessions: 2,
      mark: { close: 8, date: dateAt(3), returnPct: -33.3333 },
      signalDate: dateAt(1),
      state: "pending-exit",
    });
  });

  it("exits at the close of the last hold session, the entry bar counted as one", () => {
    const once = simulateTrade(
      bars([10, 10, 12]),
      points([5, 5, null]),
      1,
      backtestParameters({ costBpsPerSide: 0, holdSessions: 1 })
    );
    expect(once).toMatchObject({
      exit: { basis: "close", date: dateAt(2), reason: "hold-period" },
      heldSessions: 1,
      returnPct: 0,
    });
    const open = simulateTrade(
      bars([10, 10, 12, 13], [10, 10, 10, 13]),
      points([5, 5, 5, 5]),
      1,
      settings
    );
    expect(open).toMatchObject({
      heldSessions: 2,
      mark: { close: 13, returnPct: 30 },
      state: "open",
    });
  });

  it("charges the cost on both sides", () => {
    const trade = simulateTrade(
      bars([100, 100, 100, 110], [100, 100, 100, 110]),
      points([1, 1, 1, 1]),
      1,
      backtestParameters({ holdSessions: 2 })
    );
    expect(trade).toMatchObject({ returnPct: 9.8901, state: "closed" });
  });
});

describe("backtestAgent", () => {
  it("resumes after the exit bar and keeps the final open trade out of the statistics", () => {
    const history = bars([10, 10, 11, 12, 10, 9, 10, 14, 10]);
    const series = points([1, 1, 1, 1, 1, 1, 1, 1, 1], [0, 2, 3, 4, 7]);
    const result = backtestAgent(
      history,
      series,
      backtestParameters({
        costBpsPerSide: 0,
        holdSessions: 2,
        minClosedTrades: 1,
      })
    );
    expect(
      result.trades.map((trade) => [trade.signalDate, trade.exit.date])
    ).toEqual([
      [dateAt(0), dateAt(2)],
      [dateAt(3), dateAt(5)],
    ]);
    expect(result.openTrade).toMatchObject({
      signalDate: dateAt(7),
      state: "open",
    });
    expect(result).toMatchObject({
      closedTrades: 2,
      compoundedReturnPct: -1,
      maxClosedTradeDrawdownPct: -10,
      meanReturnPct: 0,
      medianReturnPct: 0,
      positiveExpectancy: false,
      sampleSufficient: true,
      status: "evaluated",
      window: { end: dateAt(8), start: dateAt(0) },
      winRatePct: 50,
    });
  });

  it("reports an odd-sized median, positive expectancy and small samples", () => {
    const history = bars([10, 10, 11, 10, 10, 12, 10, 10, 13]);
    const series = points([1, 1, 1, 1, 1, 1, 1, 1, 1], [0, 3, 6]);
    const settings = backtestParameters({
      costBpsPerSide: 0,
      holdSessions: 2,
      minClosedTrades: 3,
    });
    expect(backtestAgent(history, series, settings)).toMatchObject({
      closedTrades: 3,
      medianReturnPct: 20,
      positiveExpectancy: true,
    });
    expect(
      backtestAgent(
        history,
        series,
        backtestParameters({
          costBpsPerSide: 0,
          holdSessions: 2,
          minClosedTrades: 4,
        })
      )
    ).toMatchObject({ positiveExpectancy: null, sampleSufficient: false });
  });

  it("returns insufficient data when no bar is evaluable", () => {
    const result = backtestAgent(
      bars([10, 11]),
      points([null, null], [], false),
      DEFAULT_BACKTEST
    );
    expect(result).toMatchObject({
      buyHoldSameWindowPct: null,
      closedTrades: 0,
      meanReturnPct: null,
      status: "insufficient-data",
      window: null,
    });
  });

  it("enters at the next open and exits on the hold period on real rule output", () => {
    const closes = signalCloses();
    const opens = closes.map((close, index) =>
      index === 0 ? close : (closes[index - 1] as number)
    );
    const history = bars(closes, opens);
    const result = backtestAgent(
      history,
      ruleSeries(history, DEFAULT_RULE),
      backtestParameters({
        costBpsPerSide: 0,
        holdSessions: 10,
        minClosedTrades: 1,
      })
    );
    const first = result.trades[0];
    const signalIndex = history.findIndex(
      (bar) => bar.date === first?.signalDate
    );
    expect(first).toMatchObject({
      entry: { basis: "open", date: history[signalIndex + 1]?.date },
      exit: { reason: "hold-period" },
      heldSessions: 10,
    });
    expect(result.buyHoldSameWindowPct).not.toBeNull();
  });
});
