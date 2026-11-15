import { describe, expect, it } from "vitest";

import {
  type BacktestRunOptionsMetrics,
  buildBacktestRunReport,
  buildOptionsRunReport,
  type OptionsRunReportInput,
} from "./backtest-run-report.ts";
import {
  BACKTEST_RUN_TRADES_MAX,
  BacktestRunReportSchema,
} from "./contracts/backtest-runs.ts";
import type {
  BarColumns,
  InstantRunResult,
  InstantTrade,
} from "./instant-backtest-engine.ts";

const bars = (closes: readonly number[]): BarColumns => ({
  c: Float64Array.from(closes),
  h: Float64Array.from(closes),
  l: Float64Array.from(closes),
  o: Float64Array.from(closes),
  t: Float64Array.from(closes, (_, index) => index * 86_400_000),
});

const trade = (pnl: number, entryIndex = 0, exitIndex = 1): InstantTrade => ({
  entryIndex,
  entryPrice: 10,
  exitIndex,
  exitPrice: 10 + pnl * 10,
  exitReason: "signal",
  netReturn: pnl,
  pnl,
  units: 0.1,
});

const result = (
  equity: readonly number[],
  trades: readonly InstantTrade[]
): InstantRunResult => ({
  equity: Float64Array.from(equity),
  stats: {
    bars: equity.length,
    buyHoldMaxDrawdown: -0.1,
    buyHoldReturn: 0.3,
    cagr: 0.1,
    exposure: 0.5,
    maxDrawdown: -0.2,
    profitFactor: null,
    sharpe: 1.5,
    sortino: 2,
    totalReturn: (equity.at(-1) as number) - 1,
    trades: trades.length,
    winRate: null,
  },
  trades,
});

describe("buildBacktestRunReport", () => {
  it("computes money metrics, drawdowns and streaks", () => {
    const equity = [1, 1.1, 0.88, 0.9, 1.2, 1.15];
    const trades = [
      trade(0.1, 0, 1),
      trade(-0.12, 1, 2),
      trade(-0.03, 2, 3),
      trade(0, 3, 3),
      trade(0.3, 3, 4),
      trade(-0.1, 4, 5),
    ];
    const report = buildBacktestRunReport(
      bars(equity),
      result(equity, trades),
      1000
    );
    const { metrics } = report;
    expect(metrics.initialDeposit).toBe(1000);
    expect(metrics.finalEquity).toBeCloseTo(1150);
    expect(metrics.netProfit).toBeCloseTo(150);
    expect(metrics.grossProfit).toBeCloseTo(400);
    expect(metrics.grossLoss).toBeCloseTo(-250);
    expect(metrics.profitFactor).toBeCloseTo(1.6);
    expect(metrics.expectedPayoff).toBeCloseTo(25);
    expect(metrics.totalTrades).toBe(6);
    expect(metrics.profitTrades).toBe(2);
    expect(metrics.lossTrades).toBe(3);
    expect(metrics.winRate).toBeCloseTo(2 / 6);
    expect(metrics.largestProfitTrade).toBeCloseTo(300);
    expect(metrics.largestLossTrade).toBeCloseTo(-120);
    expect(metrics.averageProfitTrade).toBeCloseTo(200);
    expect(metrics.averageLossTrade).toBeCloseTo(-250 / 3);
    expect(metrics.maxConsecutiveWins).toBe(1);
    expect(metrics.maxConsecutiveLosses).toBe(2);
    expect(metrics.maxConsecutiveLossesMoney).toBeCloseTo(-150);
    expect(metrics.maximalConsecutiveLoss).toBeCloseTo(-150);
    expect(metrics.maximalConsecutiveLossCount).toBe(2);
    expect(metrics.absoluteDrawdown).toBeCloseTo(120);
    expect(metrics.maxDrawdownAbs).toBeCloseTo(220);
    expect(metrics.maxDrawdownPct).toBeCloseTo(0.2);
    expect(metrics.recoveryFactor).toBeCloseTo(150 / 220);
    expect(metrics.sharpe).toBe(1.5);
    expect(metrics.sortino).toBe(2);
    expect(metrics.buyHoldReturn).toBe(0.3);
    expect(report.equity[2]).toEqual({
      drawdownPct: expect.closeTo(0.2) as number,
      equity: 880,
      t: 2 * 86_400_000,
    });
    expect(report.prices).toHaveLength(6);
    expect(report.trades[0]).toMatchObject({
      balanceAfter: expect.closeTo(1100) as number,
      entryT: 0,
      exitT: 86_400_000,
      n: 1,
      pnl: expect.closeTo(100) as number,
      units: 100,
    });
    expect(report.trades.at(-1)?.balanceAfter).toBeCloseTo(metrics.finalEquity);
    expect(report.tradesTruncated).toBe(false);
    expect(report).toMatchObject({ bars: 6, firstT: 0, lastT: 5 * 86_400_000 });
  });

  it("reports the longest and the costliest losing streak separately", () => {
    const equity = [1, 0.97, 0.67];
    const report = buildBacktestRunReport(
      bars(equity),
      result(equity, [
        trade(-0.01),
        trade(-0.01),
        trade(-0.01),
        trade(0.1),
        trade(-0.2),
        trade(-0.2),
      ]),
      1000
    );
    expect(report.metrics).toMatchObject({
      maxConsecutiveLosses: 3,
      maxConsecutiveLossesMoney: expect.closeTo(-30) as number,
      maximalConsecutiveLoss: expect.closeTo(-400) as number,
      maximalConsecutiveLossCount: 2,
    });
  });

  it("returns null ratios without trades or losses", () => {
    const equity = [1, 1.05, 1.1];
    const empty = buildBacktestRunReport(bars(equity), result(equity, []), 1);
    expect(empty.metrics).toMatchObject({
      absoluteDrawdown: 0,
      averageLossTrade: null,
      averageProfitTrade: null,
      expectedPayoff: null,
      largestLossTrade: null,
      largestProfitTrade: null,
      maxDrawdownAbs: 0,
      profitFactor: null,
      recoveryFactor: null,
      winRate: null,
    });
  });

  it("caps the stored trade list and flags the truncation", () => {
    const equity = [1, 1.01];
    const many = Array.from({ length: BACKTEST_RUN_TRADES_MAX + 1 }, () =>
      trade(0.000_001)
    );
    const report = buildBacktestRunReport(
      bars(equity),
      result(equity, many),
      1
    );
    expect(report.trades).toHaveLength(BACKTEST_RUN_TRADES_MAX);
    expect(report.metrics.totalTrades).toBe(BACKTEST_RUN_TRADES_MAX + 1);
    expect(report.metrics.maxConsecutiveWins).toBe(BACKTEST_RUN_TRADES_MAX + 1);
    expect(report.tradesTruncated).toBe(true);
  });

  it("sums trade costs in money and reports the profit before them", () => {
    const costed: InstantTrade = {
      ...trade(-0.01, 0, 1),
      costs: {
        bps: 0.001,
        commission: 0.002,
        fees: 0.0005,
        slippage: 0.003,
        spread: 0.0015,
        total: 0.008,
      },
      grossPnl: -0.002,
    };
    const report = buildBacktestRunReport(
      bars([10, 10]),
      result([1, 0.99], [costed, trade(0, 0, 1)]),
      10_000,
      { id: "hand", label: "Hand" }
    );
    expect(report.costs).toEqual({
      bps: 10,
      commission: 20,
      fees: 5,
      netProfitBeforeCosts: -100 + 80,
      profileId: "hand",
      profileLabel: "Hand",
      slippage: 30,
      spread: 15,
      total: 80,
    });
    expect(report.trades[0]).toMatchObject({ costs: 80, grossPnl: -20 });
    expect(report.trades[1]).not.toHaveProperty("costs");
  });

  it("omits costs without a profile", () => {
    const report = buildBacktestRunReport(
      bars([10, 10]),
      result([1, 1], []),
      1
    );
    expect(report).not.toHaveProperty("costs");
  });
});

describe("buildOptionsRunReport", () => {
  const metrics: BacktestRunOptionsMetrics = {
    cagr: 0.1,
    days: 4,
    deflatedSharpe: 0.6,
    end: "1970-01-05",
    expectedMaxSharpe: 0,
    exposure: 0.5,
    finalEquity: 1010,
    maxDrawdown: -0.02,
    maxOpenRisk: 0.02,
    nTrials: 1,
    sharpe: 1.5,
    sharpeVariance: 0.1,
    skipped: 0,
    staleIvExits: 0,
    start: "1970-01-01",
    totalReturn: 0.01,
    trades: 2,
    winRate: 0.5,
    worstMonth: "1970-01",
    worstMonthReturn: 0.01,
  };
  const spread = (
    id: number,
    entryDate: string,
    exitDate: string,
    pnl: number
  ) => ({
    contracts: 2,
    entryDate,
    entryFee: 2.6,
    entryPrice: 150,
    exitDate,
    exitFee: 2.6,
    exitPrice: 150 + pnl / 2,
    exitReason: "profitTake" as const,
    expiry: "1970-02-20",
    id,
    longStrike: 95,
    pnl,
    returnOnRisk: pnl / 700,
    shortStrike: 97,
    structure: "putCreditVertical" as const,
    symbol: "SPY",
  });
  const input = (closes: readonly number[]): OptionsRunReportInput => ({
    bars: bars(closes),
    ledger: {
      capital: 1000,
      dates: ["1970-01-01", "1970-01-02", "1970-01-05", "1970-01-06"],
      equity: [1000, 990, 1020, 1010],
      trades: [
        spread(1, "1970-01-01", "1970-01-02", -10),
        spread(2, "1970-01-02", "1970-01-05", 30),
      ],
    },
    metrics,
    nautilusGap: 1e-12,
    signals: { SPY: 3 },
    symbols: ["SPY"],
  });

  it("reports the ledger equity, its spreads as trades and the options book", () => {
    // Daily bars on every calendar day: the weekend bars are not ledger dates.
    const report = buildOptionsRunReport(input([10, 11, 12, 13, 14, 15, 16]));
    expect(report.bars).toBe(4);
    expect(report.firstT).toBe(0);
    expect(report.lastT).toBe(5 * 86_400_000);
    expect(report.equity.map((point) => point.equity)).toEqual([
      1000, 990, 1020, 1010,
    ]);
    expect(report.equity[1]?.drawdownPct).toBeCloseTo(0.01, 12);
    expect(
      report.prices.map((price) => [price.t / 86_400_000, price.c])
    ).toEqual([
      [0, 10],
      [1, 11],
      [4, 14],
      [5, 15],
    ]);
    expect(report.metrics).toMatchObject({
      buyHoldReturn: 0.5,
      cagr: 0.1,
      exposure: 0.5,
      finalEquity: 1010,
      grossLoss: -10,
      grossProfit: 30,
      maxDrawdownAbs: 10,
      netProfit: 10,
      sharpe: 1.5,
      totalReturn: 0.01,
      totalTrades: 2,
      winRate: 0.5,
    });
    expect(report.metrics.sortino).toBeGreaterThan(0);
    expect(report.trades).toEqual([
      {
        balanceAfter: 990,
        entryPrice: 150,
        entryT: 0,
        exitPrice: 145,
        exitReason: "profitTake",
        exitT: 86_400_000,
        n: 1,
        netReturn: -10 / 700,
        pnl: -10,
        units: 2,
      },
      expect.objectContaining({ balanceAfter: 1020, n: 2, pnl: 30 }),
    ]);
    expect(report.options).toMatchObject({
      capital: 1000,
      nautilusGap: 1e-12,
      signals: { SPY: 3 },
      symbols: ["SPY"],
    });
    expect(report.options?.trades).toHaveLength(2);
    expect(report.tradesTruncated).toBe(false);
    expect(report.options?.tradesTruncated).toBe(false);
  });

  it("has no buy and hold without bars on the ledger dates", () => {
    const report = buildOptionsRunReport({
      ...input([10]),
      bars: { ...bars([10]), t: Float64Array.from([-86_400_000]) },
    });
    expect(report.prices).toEqual([]);
    expect(report.metrics.buyHoldReturn).toBe(0);
    const one = buildOptionsRunReport(input([10]));
    expect(one.prices).toHaveLength(1);
    expect(one.metrics.buyHoldReturn).toBe(0);
  });

  it("caps the spreads at the trade limit", () => {
    const base = input([10, 11]);
    const many = Array.from(
      { length: BACKTEST_RUN_TRADES_MAX + 1 },
      (_, index) => spread(index + 1, "1970-01-01", "1970-01-02", 1)
    );
    const report = buildOptionsRunReport({
      ...base,
      ledger: { ...base.ledger, trades: many },
    });
    expect(report.trades).toHaveLength(BACKTEST_RUN_TRADES_MAX);
    expect(report.options?.trades).toHaveLength(BACKTEST_RUN_TRADES_MAX);
    expect(report.tradesTruncated).toBe(true);
    expect(report.options?.tradesTruncated).toBe(true);
    // Metrics come from the whole ledger, before the cap.
    expect(report.options?.metrics).toBe(base.metrics);
    expect(report.metrics.totalTrades).toBe(BACKTEST_RUN_TRADES_MAX + 1);
    // The engine adds seriesSha256 to the stored report.
    const stored = { ...report, seriesSha256: "a".repeat(64) };
    expect(BacktestRunReportSchema.safeParse(stored).error).toBeUndefined();
    const over = BacktestRunReportSchema.safeParse({
      ...stored,
      options: {
        ...report.options,
        trades: [...(report.options?.trades ?? []), report.options?.trades[0]],
      },
    });
    expect(over.success).toBe(false);
  });
});
