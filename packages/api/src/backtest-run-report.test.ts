import { describe, expect, it } from "vitest";

import {
  BACKTEST_RUN_TRADES_MAX,
  buildBacktestRunReport,
} from "./backtest-run-report.ts";
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
