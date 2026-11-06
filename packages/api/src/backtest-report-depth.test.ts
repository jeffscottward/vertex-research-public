import { describe, expect, it } from "vitest";

import {
  BAR_REPLAY_IDLE,
  barReplayReducer,
  dailyPnl,
  histogram,
  PROP_RULES,
  type PropRule,
  runMonteCarlo,
  simulatePropRule,
  simulatePropRules,
  tradesAnalysis,
} from "./backtest-report-depth.ts";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2024, 0, 1); // Monday

const trade = (n: number, pnl: number, day = n, holdDays = 1) => ({
  balanceAfter: 0,
  entryPrice: 100,
  entryT: T0 + (day - holdDays) * DAY,
  exitPrice: 100,
  exitReason: (pnl > 0 ? "target" : "stop") as "target" | "stop",
  exitT: T0 + day * DAY,
  n,
  netReturn: pnl / 10_000,
  pnl,
  units: 1,
});

const rule: PropRule = {
  consistencyPct: null,
  drawdown: "static",
  id: "t",
  label: "t",
  maxDailyLossPct: 5,
  maxLossPct: 10,
  minTradingDays: 2,
  profitTargetPct: 10,
};

describe("histogram", () => {
  it("bins values and handles edge cases", () => {
    expect(histogram([])).toEqual([]);
    expect(histogram([3, 3])).toEqual([{ count: 2, from: 3, to: 4 }]);
    const bins = histogram([0, 1, 2, 3, 4], 2);
    expect(bins.map((bin) => bin.count)).toEqual([2, 3]);
  });
});

describe("tradesAnalysis", () => {
  it("summarizes wins, losses, holds and groups", () => {
    const result = tradesAnalysis([
      trade(1, 200),
      trade(2, -100, 3, 2),
      trade(3, 100),
    ]);
    expect(result.wins).toBe(2);
    expect(result.losses).toBe(1);
    expect(result.avgWin).toBe(150);
    expect(result.payoffRatio).toBe(1.5);
    expect(result.largestLoss).toBe(-100);
    expect(result.avgHoldLossMs).toBe(2 * DAY);
    expect(result.byExitReason.map((row) => row.key)).toEqual([
      "stop",
      "target",
    ]);
    expect(result.byWeekday.reduce((n, row) => n + row.trades, 0)).toBe(3);
  });
  it("returns nulls for no trades", () => {
    const result = tradesAnalysis([]);
    expect(result.winRate).toBeNull();
    expect(result.pnlHistogram).toEqual([]);
  });
});

describe("runMonteCarlo", () => {
  const report = {
    seriesSha256: "abc",
    trades: [trade(1, 100), trade(2, -50), trade(3, 80), trade(4, -30)],
  };
  it("is deterministic and fills histograms with every path", () => {
    const a = runMonteCarlo(report, 10_000, "reshuffle", 200);
    const b = runMonteCarlo(report, 10_000, "reshuffle", 200);
    expect(a).toEqual(b);
    expect(a?.finalPnlHistogram.reduce((n, bin) => n + bin.count, 0)).toBe(200);
    expect(a?.maxDrawdownHistogram.reduce((n, bin) => n + bin.count, 0)).toBe(
      200
    );
    // Reshuffle keeps the sum, so every path ends at the same P&L.
    expect(a?.run.finalPnl.p5).toBeCloseTo(100);
    expect(a?.run.fan.length).toBe(4);
  });
  it("needs two trades and positive capital", () => {
    expect(
      runMonteCarlo({ seriesSha256: "x", trades: [trade(1, 1)] }, 1)
    ).toBeNull();
    expect(runMonteCarlo(report, 0)).toBeNull();
  });
});

describe("prop rules", () => {
  it("groups closed P&L by exit day", () => {
    expect(
      dailyPnl([trade(1, 10, 1), trade(2, 5, 1), trade(3, -1, 2)])
    ).toEqual([
      { day: "2024-01-02", pnl: 15 },
      { day: "2024-01-03", pnl: -1 },
    ]);
  });
  it("passes once target and minimum days are met", () => {
    const out = simulatePropRule(
      [
        { day: "a", pnl: 600 },
        { day: "b", pnl: 500 },
      ],
      10_000,
      rule
    );
    expect(out.status).toBe("passed");
    expect(out.days).toBe(2);
  });
  it("fails on the daily loss limit and the static max loss", () => {
    expect(
      simulatePropRule([{ day: "a", pnl: -500 }], 10_000, rule).status
    ).toBe("failed");
    const out = simulatePropRule(
      [
        { day: "a", pnl: -400 },
        { day: "b", pnl: -400 },
        { day: "c", pnl: -400 },
      ],
      10_000,
      rule
    );
    expect(out.status).toBe("failed");
    expect(out.reason).toContain("Max loss");
  });
  it("trails the floor from the peak and locks at the start balance", () => {
    const trailing: PropRule = {
      ...rule,
      drawdown: "trailing",
      maxDailyLossPct: null,
      maxLossPct: 4,
      profitTargetPct: 50,
    };
    const out = simulatePropRule(
      [
        { day: "a", pnl: 300 },
        { day: "b", pnl: -350 },
      ],
      10_000,
      trailing
    );
    expect(out.status).toBe("open");
    const locked = simulatePropRule(
      [
        { day: "a", pnl: 900 },
        { day: "b", pnl: -900 },
      ],
      10_000,
      trailing
    );
    expect(locked.status).toBe("failed");
  });
  it("applies the consistency rule and minimum days", () => {
    const consistent: PropRule = {
      ...rule,
      consistencyPct: 50,
      minTradingDays: 1,
    };
    expect(
      simulatePropRule([{ day: "a", pnl: 1100 }], 10_000, consistent).reason
    ).toContain("best day");
    expect(
      simulatePropRule([{ day: "a", pnl: 1100 }], 10_000, {
        ...rule,
        minTradingDays: 3,
      }).reason
    ).toContain("trading days");
  });
  it("simulates the catalog with reshuffled pass rates", () => {
    const report = {
      seriesSha256: "s",
      trades: Array.from({ length: 10 }, (_, i) =>
        trade(i + 1, i % 3 === 0 ? -100 : 250)
      ),
    };
    const results = simulatePropRules(report, 10_000, PROP_RULES, 100);
    expect(results).toHaveLength(PROP_RULES.length);
    for (const result of results) {
      expect(result.passRate + result.failRate).toBeLessThanOrEqual(1);
      expect(result.paths).toBe(100);
    }
    expect(
      simulatePropRules({ seriesSha256: "s", trades: [] }, 10_000)[0]?.paths
    ).toBe(0);
  });
});

describe("barReplayReducer", () => {
  it("starts, steps, plays to the end and stops", () => {
    let state = barReplayReducer(BAR_REPLAY_IDLE, {
      from: 7,
      total: 10,
      type: "start",
    });
    expect(state).toMatchObject({ active: true, index: 7, playing: false });
    state = barReplayReducer(state, { by: -3, type: "step" });
    expect(state.index).toBe(4);
    state = barReplayReducer(state, { type: "play" });
    for (let i = 0; i < 20; i += 1)
      state = barReplayReducer(state, { type: "tick" });
    expect(state).toMatchObject({ index: 9, playing: false });
    state = barReplayReducer(state, { speed: 5, type: "speed" });
    state = barReplayReducer(state, { index: 99, type: "seek" });
    expect(state.index).toBe(9);
    state = barReplayReducer(state, { total: 3, type: "resize" });
    expect(state.index).toBe(2);
    state = barReplayReducer(state, { type: "stop" });
    expect(state).toEqual({ ...BAR_REPLAY_IDLE, speed: 5 });
    expect(
      barReplayReducer(BAR_REPLAY_IDLE, { total: 0, type: "start" })
    ).toEqual(BAR_REPLAY_IDLE);
  });
});
