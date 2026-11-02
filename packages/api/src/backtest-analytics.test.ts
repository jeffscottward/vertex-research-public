import { describe, expect, it } from "vitest";

import {
  benchmarkStats,
  blockResample,
  calendarReturns,
  computeBacktestAnalytics,
  createRandom,
  drawdownSummary,
  monteCarlo,
  pnlBuckets,
  pnlDistribution,
  quantileSorted,
  regimeRows,
  returnStats,
  seedFrom,
  tradeStats,
  type AnalyticsTrade,
} from "./backtest-analytics.ts";

const DAY = 24 * 60 * 60 * 1000;

const equity = [
  { t: "2024-01-01", equity: 100 },
  { t: "2024-01-02", equity: 110 },
  { t: "2024-01-03", equity: 99 },
  { t: "2024-01-04", equity: 108.9 },
  { t: "2024-01-05", equity: 120 },
];

const trades: AnalyticsTrade[] = [
  {
    entry_t: "2024-01-01T14:30:00Z",
    exit_t: "2024-01-01T15:30:00Z",
    side: "long",
    pnl: 100,
    commission: 2,
    regime: "bull",
  },
  {
    entry_t: "2024-01-02T14:30:00Z",
    exit_t: "2024-01-02T16:30:00Z",
    side: "short",
    pnl: -50,
    commission: 2,
    regime: "bear",
  },
  {
    entry_t: "2024-01-03T14:30:00Z",
    exit_t: "2024-01-03T14:30:00Z",
    side: "long",
    pnl: 0,
    regime: "bull",
  },
  {
    entry_t: "2024-01-04T14:30:00Z",
    exit_t: "2024-01-04T15:30:00Z",
    side: "short",
    pnl: 200,
    regime: "bull",
  },
  {
    entry_t: "2024-01-05T14:30:00Z",
    exit_t: "2024-01-05T15:30:00Z",
    side: "long",
    pnl: -25,
  },
];

describe("primitives", () => {
  it("computes type-7 quantiles", () => {
    expect(quantileSorted([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantileSorted([1, 2, 3, 4], 0)).toBe(1);
    expect(quantileSorted([], 0.5)).toBeNaN();
    return expect(quantileSorted([1, 2, 3, 4], 1)).toBe(4);
  });

  it("is deterministic for a seed", () => {
    const left = createRandom(seedFrom("abc"));
    const right = createRandom(seedFrom("abc"));
    expect([left(), left(), left()]).toEqual([right(), right(), right()]);
    return expect(seedFrom("abc")).not.toBe(seedFrom("abd"));
  });

  it("keeps the series length in a block resample", () =>
    expect(
      blockResample([1, 2, 3, 4, 5, 6, 7], 3, createRandom(1))
    ).toHaveLength(7));
});

describe("returnStats", () => {
  it("derives return, drawdown and annualized ratios from the observed frequency", () => {
    const stats = returnStats(equity)!;
    const returns = [0.1, -0.1, 0.1, 120 / 108.9 - 1];
    const average = returns.reduce((a, b) => a + b, 0) / 4;
    const deviation = Math.sqrt(
      returns.reduce((a, b) => a + (b - average) ** 2, 0) / 3
    );
    const periodsPerYear = 4 / ((4 * DAY) / (365.25 * DAY));
    expect(stats.periods).toBe(4);
    expect(stats.periodsPerYear).toBeCloseTo(periodsPerYear, 9);
    expect(stats.totalReturn).toBeCloseTo(0.2, 12);
    expect(stats.maxDrawdown).toBeCloseTo(-0.1, 12);
    expect(stats.sharpe!).toBeCloseTo(
      (average / deviation) * Math.sqrt(periodsPerYear),
      9
    );
    const downside = Math.sqrt(0.01 / 4);
    expect(stats.sortino!).toBeCloseTo(
      (average / downside) * Math.sqrt(periodsPerYear),
      9
    );
    expect(stats.calmar! / (stats.cagr / 0.1)).toBeCloseTo(1, 12);
    expect(stats.psr!).toBeGreaterThan(0.5);
    return expect(stats.psr!).toBeLessThanOrEqual(1);
  });

  it("returns null for fewer than three points", () =>
    expect(returnStats(equity.slice(0, 2))).toBeNull());
});

describe("drawdownSummary", () => {
  it("measures peak, trough, recovery and time underwater", () => {
    const summary = drawdownSummary(equity)!;
    expect(summary.count).toBe(1);
    expect(summary.ongoing).toBe(false);
    expect(summary.periods[0]).toMatchObject({
      peakT: "2024-01-02",
      troughT: "2024-01-03",
      recoveryT: "2024-01-05",
      declineMs: DAY,
      recoveryMs: 2 * DAY,
      underwaterMs: 3 * DAY,
    });
    expect(summary.periods[0]?.depth).toBeCloseTo(-0.1, 12);
    return expect(summary.avgRecoveryMs).toBe(2 * DAY);
  });

  it("marks an unrecovered drawdown as ongoing", () => {
    const summary = drawdownSummary([
      { t: "2024-01-01", equity: 100 },
      { t: "2024-01-02", equity: 90 },
    ])!;
    expect(summary.ongoing).toBe(true);
    return expect(summary.periods[0]?.recoveryT).toBeNull();
  });
});

describe("calendarReturns", () =>
  it("chains month-end and year-end equity", () => {
    const series = [
      { t: "2024-01-15", equity: 100 },
      { t: "2024-01-31", equity: 110 },
      { t: "2024-02-10", equity: 99 },
      { t: "2024-02-29", equity: 121 },
    ];
    const months = calendarReturns(series, "month");
    expect(months.map((row) => [row.year, row.month])).toEqual([
      [2024, 1],
      [2024, 2],
    ]);
    expect(months[0]?.return).toBeCloseTo(0.1, 12);
    expect(months[1]?.return).toBeCloseTo(0.1, 12);
    return expect(calendarReturns(series, "year")[0]?.return).toBeCloseTo(
      0.21,
      12
    );
  }));

describe("tradeStats", () => {
  it("summarizes wins, losses, streaks and payoff", () => {
    const stats = tradeStats(trades)!;
    expect(stats).toMatchObject({
      count: 5,
      wins: 2,
      losses: 2,
      breakeven: 1,
      grossProfit: 300,
      grossLoss: -75,
      netPnl: 225,
      profitFactor: 4,
      expectancy: 45,
      avgWin: 150,
      avgLoss: -37.5,
      payoffRatio: 4,
      largestWin: 200,
      largestLoss: -50,
      maxConsecutiveWins: 1,
      maxConsecutiveLosses: 1,
      longCount: 3,
      shortCount: 2,
      longNetPnl: 75,
      shortNetPnl: 150,
      totalCommission: 4,
    });
    expect(stats.winRate).toBeCloseTo(0.4, 12);
    expect(stats.kelly!).toBeCloseTo(0.25, 12);
    return expect(stats.avgHoldMinutes).toBeCloseTo(
      (60 + 120 + 0 + 60 + 60) / 5,
      9
    );
  });

  it("reports no profit factor without losses", () =>
    expect(tradeStats([trades[0]!])?.profitFactor).toBeNull());
});

describe("trade breakdowns", () => {
  it("groups net P&L by exit weekday in UTC", () => {
    const rows = pnlBuckets(trades, "weekday");
    expect(rows.map((row) => row.key)).toEqual([
      "Mon",
      "Tue",
      "Wed",
      "Thu",
      "Fri",
    ]);
    return expect(rows[3]).toMatchObject({
      key: "Thu",
      trades: 1,
      netPnl: 200,
      winRate: 1,
    });
  });

  it("bins the P&L distribution over its full range", () => {
    const distribution = pnlDistribution(trades)!;
    expect(distribution.bins).toHaveLength(20);
    expect(distribution.bins.reduce((total, bin) => total + bin.count, 0)).toBe(
      5
    );
    expect(distribution.bins[0]?.from).toBe(-50);
    expect(distribution.bins.at(-1)?.to).toBeCloseTo(200, 9);
    return expect(distribution.median).toBe(0);
  });

  it("aggregates labeled trades by regime only", () =>
    expect(regimeRows(trades)).toEqual([
      {
        regime: "bear",
        trades: 1,
        winRate: 0,
        netPnl: -50,
        avgPnl: -50,
        profitFactor: 0,
      },
      {
        regime: "bull",
        trades: 3,
        winRate: 2 / 3,
        netPnl: 300,
        avgPnl: 100,
        profitFactor: null,
      },
    ]));
});

describe("monteCarlo", () => {
  it("keeps the final P&L fixed when trades are only reordered", () => {
    const run = monteCarlo(
      trades.map((trade) => trade.pnl),
      10_000,
      "reshuffle",
      createRandom(7)
    );
    expect(run.finalPnl).toEqual({
      p5: 225,
      p25: 225,
      p50: 225,
      p75: 225,
      p95: 225,
    });
    expect(run.probabilityOfProfit).toBe(1);
    expect(run.riskOfRuin).toBe(0);
    return expect(run.fan.at(-1)?.step).toBe(5);
  });

  it("reports ruin when losses can take equity below the threshold", () => {
    const run = monteCarlo(
      [-600, -600, 100],
      1000,
      "bootstrap",
      createRandom(3)
    );
    expect(run.riskOfRuin).toBeGreaterThan(0.5);
    return expect(run.maxDrawdown.p50).toBeLessThan(0);
  });
});

describe("benchmarkStats", () => {
  it("finds beta 1 and zero alpha against a proportional benchmark", () => {
    const benchmark = equity.map((point) => ({
      t: point.t,
      equity: point.equity * 2,
    }));
    const stats = benchmarkStats(equity, benchmark, 252)!;
    expect(stats.n).toBe(4);
    expect(stats.beta).toBeCloseTo(1, 12);
    expect(stats.correlation).toBeCloseTo(1, 12);
    return expect(stats.alphaAnnual).toBeCloseTo(0, 12);
  });

  it("needs at least three shared timestamps", () =>
    expect(
      benchmarkStats(equity, [{ t: "2024-01-01", equity: 1 }], 252)
    ).toBeNull());
});

describe("computeBacktestAnalytics", () => {
  it("is deterministic for one backtest id and reports its method", () => {
    const input = { id: "bt-1", equity, trades, initialCapital: 10_000 };
    const first = computeBacktestAnalytics(input);
    expect(computeBacktestAnalytics(input)).toEqual(first);
    expect(first.method).toMatchObject({
      version: "vertex-backtest-analytics-v2",
      seed: seedFrom("bt-1"),
      initialCapital: 10_000,
      blockLength: 2,
    });
    expect(first.bootstrap.winRate!.p2_5).toBeLessThanOrEqual(
      first.bootstrap.winRate!.p97_5
    );
    expect(first.significance.tTest?.n).toBe(4);
    expect(first.significance.stationaryBootstrap).toMatchObject({
      expectedBlockLength: 2,
      resamples: 1000,
    });
    return expect(first.monteCarlo?.reshuffle.finalPnl.p50).toBe(225);
  });

  it("adds multiple-testing results only when a trial ledger is supplied", () => {
    const ledger = {
      scope: "strategy" as const,
      key: "strategy-1",
      total: 2,
      others: [
        {
          id: "bt-0",
          returns: 3,
          meanReturn: 0.01,
          stdReturn: 0.05,
          firstT: "2024-01-01",
          lastT: "2024-01-04",
        },
      ],
    };
    const withLedger = computeBacktestAnalytics({
      id: "bt-1",
      equity,
      trades,
      ledger,
    });
    expect(withLedger.multipleTesting?.ledger.trials).toBe(2);
    expect(withLedger.multipleTesting?.deflatedSharpe?.trials).toBe(2);
    expect(
      computeBacktestAnalytics({ id: "bt-1", equity: [], trades: [], ledger })
        .multipleTesting?.deflatedSharpeReason
    ).toContain("three equity returns");
    return expect(
      computeBacktestAnalytics({ id: "bt-1", equity, trades }).multipleTesting
    ).toBeNull();
  });

  it("degrades to nulls without series", () => {
    const empty = computeBacktestAnalytics({
      id: "bt-2",
      equity: [],
      trades: [],
    });
    expect(empty.returns).toBeNull();
    expect(empty.trades).toBeNull();
    expect(empty.monteCarlo).toBeNull();
    expect(empty.bootstrap.sharpe).toBeNull();
    expect(empty.volatility.garch).toBeNull();
    expect(empty.significance).toEqual({
      tTest: null,
      stationaryBootstrap: null,
    });
    return expect(empty.monthlyReturns).toEqual([]);
  });
});
