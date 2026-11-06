import { describe, expect, it } from "vitest";

import {
  BAR_REPLAY_IDLE,
  barReplayReducer,
  dailyFromEquity,
  dailyPnl,
  histogram,
  PROP_RULES,
  type PropRule,
  propRulesUseEquity,
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
      bars: 10,
      equity: [],
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
      simulatePropRules(
        { bars: 0, equity: [], seriesSha256: "s", trades: [] },
        10_000
      )[0]?.paths
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

describe("equity-based prop days", () => {
  const H = 60 * 60 * 1000;
  const equity = [
    { drawdownPct: 0, equity: 10_000, t: T0 + H },
    { drawdownPct: 0, equity: 9400, t: T0 + 2 * H },
    { drawdownPct: 0, equity: 10_100, t: T0 + 3 * H },
    { drawdownPct: 0, equity: 10_300, t: T0 + DAY + H },
  ];
  it("groups equity by day with the intraday low", () => {
    expect(dailyFromEquity(equity, 10_000)).toEqual([
      { day: "2024-01-01", low: -600, pnl: 100 },
      { day: "2024-01-02", low: 0, pnl: 200 },
    ]);
    expect(dailyFromEquity([], 10_000)).toEqual([]);
  });
  it("fails a daily limit on an intraday dip that closed green", () => {
    const out = simulatePropRule(dailyFromEquity(equity, 10_000), 10_000, {
      ...rule,
      maxDailyLossPct: 10,
    });
    expect(out.status).toBe("open");
    const tight = simulatePropRule(dailyFromEquity(equity, 10_000), 10_000, {
      ...rule,
      maxDailyLossPct: 5,
      maxLossPct: 5,
    });
    expect(tight.status).toBe("failed");
    expect(tight.reason).toContain("Daily loss 6.00%");
    const results = simulatePropRules(
      { bars: equity.length, equity, seriesSha256: "e", trades: [] },
      10_000,
      [{ ...rule, maxDailyLossPct: 5 }],
      10
    );
    expect(results[0]?.outcome.status).toBe("failed");
  });
  it("uses equity only when the curve has every bar", () => {
    expect(propRulesUseEquity({ bars: equity.length, equity })).toBe(true);
    expect(propRulesUseEquity({ bars: equity.length + 1, equity })).toBe(false);
    expect(propRulesUseEquity({ bars: 0, equity: [] })).toBe(false);
  });
});

describe("barReplayReducer when idle", () => {
  it("ignores play, step, seek, tick and resize", () => {
    for (const action of [
      { type: "play" },
      { by: 1, type: "step" },
      { index: 3, type: "seek" },
      { type: "tick" },
      { total: 5, type: "resize" },
    ] as const)
      expect(barReplayReducer(BAR_REPLAY_IDLE, action)).toBe(BAR_REPLAY_IDLE);
    const active = barReplayReducer(BAR_REPLAY_IDLE, {
      total: 4,
      type: "start",
    });
    expect(active.index).toBe(2);
    expect(barReplayReducer(active, { type: "tick" })).toBe(active);
    expect(barReplayReducer(active, { total: 0, type: "resize" }).active).toBe(
      false
    );
    const end = barReplayReducer(active, { index: 3, type: "seek" });
    expect(barReplayReducer(end, { type: "play" })).toBe(end);
  });
});

describe("prop rule review cases", () => {
  it("does not count flat days as trading days", () => {
    const out = simulatePropRule(
      [
        { day: "a", low: 0, pnl: 0 },
        { day: "b", low: 0, pnl: 1100 },
      ],
      10_000,
      rule
    );
    expect(out.status).toBe("open");
    expect(out.days).toBe(1);
  });
  it("falls back to trades when the equity series is thinned", () => {
    const equity = [{ drawdownPct: 0, equity: 1, t: T0 }];
    const [result] = simulatePropRules(
      {
        bars: 5,
        equity,
        seriesSha256: "x",
        trades: [trade(1, 600), trade(2, 600)],
      },
      10_000,
      [rule],
      5
    );
    expect(result?.outcome.status).toBe("passed");
  });
  it("keeps break-even trades out of losses", () => {
    expect(tradesAnalysis([trade(1, 0), trade(2, 10)]).losses).toBe(0);
  });
});
