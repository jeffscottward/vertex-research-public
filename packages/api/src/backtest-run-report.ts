import type { z } from "zod";

import {
  BACKTEST_RUN_TRADES_MAX,
  type BacktestRunOptionsMetricsSchema,
  type BacktestRunOptionsTradeSchema,
  type OPTIONS_EXIT_REASONS,
} from "./contracts/backtest-runs.ts";

import {
  type BarColumns,
  downsampleIndexes,
  type InstantRunResult,
  summarize,
} from "./instant-backtest-engine.ts";
import type { LedgerResult } from "./options-engine/index.ts";

// Report for one backtest run: account-currency metrics, a chart-sized equity and drawdown series,
// a chart-sized price series for trade replay and the trade list. The engine starts at equity 1;
// every money value here is that value multiplied by the initial capital. Statistics always use the
// full series; only the chart series are reduced. An options run (buildOptionsRunReport) has the
// same report from the options ledger: money equity per day, its spreads as trades and the options
// book result. Research only; no order path.

const BACKTEST_RUN_CHART_MAX_POINTS = 2000;

export type BacktestRunMetrics = Readonly<{
  initialDeposit: number;
  finalEquity: number;
  netProfit: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  expectedPayoff: number | null;
  totalTrades: number;
  profitTrades: number;
  lossTrades: number;
  winRate: number | null;
  largestProfitTrade: number | null;
  largestLossTrade: number | null;
  averageProfitTrade: number | null;
  averageLossTrade: number | null;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  /** Money of the longest losing streak. */
  maxConsecutiveLossesMoney: number;
  /** Most negative money of any losing streak, and that streak's trade count. */
  maximalConsecutiveLoss: number;
  maximalConsecutiveLossCount: number;
  absoluteDrawdown: number;
  maxDrawdownAbs: number;
  maxDrawdownPct: number;
  recoveryFactor: number | null;
  sharpe: number | null;
  sortino: number | null;
  totalReturn: number;
  cagr: number | null;
  exposure: number;
  buyHoldReturn: number;
}>;

/** Charges of all trades in money, and the net profit the same trades would have before them. */
export type BacktestRunCosts = Readonly<{
  profileId: string;
  profileLabel: string;
  commission: number;
  fees: number;
  spread: number;
  slippage: number;
  bps: number;
  total: number;
  netProfitBeforeCosts: number;
}>;

export type BacktestRunReportTrade = Readonly<{
  n: number;
  entryT: number;
  exitT: number;
  entryPrice: number;
  exitPrice: number;
  units: number;
  pnl: number;
  netReturn: number;
  exitReason:
    | "signal"
    | "stop"
    | "target"
    | "end"
    | "sessionClose"
    | (typeof OPTIONS_EXIT_REASONS)[number];
  balanceAfter: number;
  /** Only with a cost profile: charges of both legs and the P&L before them, in money. */
  costs?: number;
  grossPnl?: number;
}>;

export type BacktestRunReport = Readonly<{
  bars: number;
  costs?: BacktestRunCosts;
  firstT: number;
  lastT: number;
  metrics: BacktestRunMetrics;
  equity: readonly Readonly<{
    t: number;
    equity: number;
    drawdownPct: number;
  }>[];
  prices: readonly Readonly<{
    t: number;
    o: number;
    h: number;
    l: number;
    c: number;
  }>[];
  trades: readonly BacktestRunReportTrade[];
  tradesTruncated: boolean;
  options?: BacktestRunOptionsReport;
}>;

export type BacktestRunOptionsMetrics = z.infer<
  typeof BacktestRunOptionsMetricsSchema
>;

export type BacktestRunOptionsReport = Readonly<{
  capital: number;
  metrics: BacktestRunOptionsMetrics;
  nautilusGap: number | null;
  signals: Readonly<Record<string, number>>;
  symbols: readonly string[];
  trades: readonly z.infer<typeof BacktestRunOptionsTradeSchema>[];
  tradesTruncated: boolean;
}>;

type DrawdownPass = Readonly<{
  lowest: number;
  maxDrawdownAbs: number;
  maxDrawdownPct: number;
  drawdownPct: Float64Array;
}>;

/** Drawdown of a money equity series. */
const drawdownPass = (values: Float64Array): DrawdownPass => {
  let peak = values[0] as number;
  let lowest = peak;
  let maxDrawdownAbs = 0;
  let maxDrawdownPct = 0;
  const drawdownPct = new Float64Array(values.length);
  for (const [index, value] of values.entries()) {
    peak = Math.max(peak, value);
    lowest = Math.min(lowest, value);
    const drop = peak - value;
    drawdownPct[index] = drop / peak;
    maxDrawdownAbs = Math.max(maxDrawdownAbs, drop);
    maxDrawdownPct = Math.max(maxDrawdownPct, drop / peak);
  }
  return { drawdownPct, lowest, maxDrawdownAbs, maxDrawdownPct };
};

interface StreakPass {
  grossLoss: number;
  grossProfit: number;
  largestLoss: number | null;
  largestProfit: number | null;
  lossTrades: number;
  maxConsecutiveLosses: number;
  maxConsecutiveLossesMoney: number;
  maxConsecutiveWins: number;
  maximalConsecutiveLoss: number;
  maximalConsecutiveLossCount: number;
  profitTrades: number;
}

/**
 * Profit, loss and streaks of the trades' money P&L in trade order. A loss streak counts
 * consecutive trades with pnl < 0; a zero-pnl trade ends both streaks.
 */
const streakPass = (pnls: readonly number[]): StreakPass => {
  const pass: StreakPass = {
    grossLoss: 0,
    grossProfit: 0,
    largestLoss: null,
    largestProfit: null,
    lossTrades: 0,
    maxConsecutiveLosses: 0,
    maxConsecutiveLossesMoney: 0,
    maxConsecutiveWins: 0,
    maximalConsecutiveLoss: 0,
    maximalConsecutiveLossCount: 0,
    profitTrades: 0,
  };
  let winStreak = 0;
  let lossStreak = 0;
  let lossStreakMoney = 0;
  for (const pnl of pnls) {
    winStreak = pnl > 0 ? winStreak + 1 : 0;
    lossStreak = pnl < 0 ? lossStreak + 1 : 0;
    lossStreakMoney = pnl < 0 ? lossStreakMoney + pnl : 0;
    if (pnl > 0) {
      pass.grossProfit += pnl;
      pass.profitTrades += 1;
      pass.largestProfit = Math.max(pass.largestProfit ?? pnl, pnl);
    } else if (pnl < 0) {
      pass.grossLoss += pnl;
      pass.lossTrades += 1;
      pass.largestLoss = Math.min(pass.largestLoss ?? pnl, pnl);
    }
    pass.maxConsecutiveWins = Math.max(pass.maxConsecutiveWins, winStreak);
    if (lossStreak > pass.maxConsecutiveLosses) {
      pass.maxConsecutiveLosses = lossStreak;
      pass.maxConsecutiveLossesMoney = lossStreakMoney;
    }
    if (lossStreakMoney < pass.maximalConsecutiveLoss) {
      pass.maximalConsecutiveLoss = lossStreakMoney;
      pass.maximalConsecutiveLossCount = lossStreak;
    }
  }
  return pass;
};

/** The report trades of an engine run, at most BACKTEST_RUN_TRADES_MAX. */
const reportTrades = (
  bars: BarColumns,
  result: InstantRunResult,
  capital: number
): BacktestRunReportTrade[] => {
  let balance = capital;
  return result.trades.flatMap((trade, index) => {
    const pnl = trade.pnl * capital;
    balance += pnl;
    if (index >= BACKTEST_RUN_TRADES_MAX) return [];
    return [
      {
        balanceAfter: balance,
        entryPrice: trade.entryPrice,
        entryT: bars.t[trade.entryIndex] as number,
        exitPrice: trade.exitPrice,
        exitReason: trade.exitReason,
        exitT: bars.t[trade.exitIndex] as number,
        n: index + 1,
        netReturn: trade.netReturn,
        pnl,
        units: trade.units * capital,
        ...(trade.costs === undefined
          ? {}
          : {
              costs: trade.costs.total * capital,
              grossPnl: (trade.pnl + trade.costs.total) * capital,
            }),
      },
    ];
  });
};

type MetricsInput = Readonly<{
  capital: number;
  equity: Float64Array;
  drawdown: DrawdownPass;
  streaks: StreakPass;
  tradeCount: number;
  stats: Pick<
    BacktestRunMetrics,
    "buyHoldReturn" | "cagr" | "exposure" | "sharpe" | "sortino" | "totalReturn"
  >;
}>;

/** Account-currency metrics of a money equity series and its trades' streaks. */
const reportMetrics = (input: MetricsInput): BacktestRunMetrics => {
  const { capital, drawdown, stats, streaks, tradeCount } = input;
  const finalEquity = input.equity.at(-1) as number;
  const netProfit = finalEquity - capital;
  return {
    absoluteDrawdown: Math.max(0, capital - drawdown.lowest),
    averageLossTrade:
      streaks.lossTrades > 0 ? streaks.grossLoss / streaks.lossTrades : null,
    averageProfitTrade:
      streaks.profitTrades > 0
        ? streaks.grossProfit / streaks.profitTrades
        : null,
    buyHoldReturn: stats.buyHoldReturn,
    cagr: stats.cagr,
    expectedPayoff: tradeCount > 0 ? netProfit / tradeCount : null,
    exposure: stats.exposure,
    finalEquity,
    grossLoss: streaks.grossLoss,
    grossProfit: streaks.grossProfit,
    initialDeposit: capital,
    largestLossTrade: streaks.largestLoss,
    largestProfitTrade: streaks.largestProfit,
    lossTrades: streaks.lossTrades,
    maxConsecutiveLosses: streaks.maxConsecutiveLosses,
    maxConsecutiveLossesMoney: streaks.maxConsecutiveLossesMoney,
    maxConsecutiveWins: streaks.maxConsecutiveWins,
    maxDrawdownAbs: drawdown.maxDrawdownAbs,
    maxDrawdownPct: drawdown.maxDrawdownPct,
    maximalConsecutiveLoss: streaks.maximalConsecutiveLoss,
    maximalConsecutiveLossCount: streaks.maximalConsecutiveLossCount,
    netProfit,
    profitFactor:
      streaks.grossLoss < 0 ? streaks.grossProfit / -streaks.grossLoss : null,
    profitTrades: streaks.profitTrades,
    recoveryFactor:
      drawdown.maxDrawdownAbs > 0 ? netProfit / drawdown.maxDrawdownAbs : null,
    sharpe: stats.sharpe,
    sortino: stats.sortino,
    totalReturn: stats.totalReturn,
    totalTrades: tradeCount,
    winRate: tradeCount > 0 ? streaks.profitTrades / tradeCount : null,
  };
};

const costsOf = (
  result: InstantRunResult,
  capital: number,
  profile: Readonly<{ id: string; label: string }>,
  netProfit: number
): BacktestRunCosts => {
  const sums = {
    bps: 0,
    commission: 0,
    fees: 0,
    slippage: 0,
    spread: 0,
    total: 0,
  };
  for (const trade of result.trades) {
    const costs = trade.costs;
    if (costs === undefined) continue;
    sums.bps += costs.bps;
    sums.commission += costs.commission;
    sums.fees += costs.fees;
    sums.slippage += costs.slippage;
    sums.spread += costs.spread;
    sums.total += costs.total;
  }
  return {
    bps: sums.bps * capital,
    commission: sums.commission * capital,
    fees: sums.fees * capital,
    netProfitBeforeCosts: netProfit + sums.total * capital,
    profileId: profile.id,
    profileLabel: profile.label,
    slippage: sums.slippage * capital,
    spread: sums.spread * capital,
    total: sums.total * capital,
  };
};

/**
 * Builds the report from one engine run over `bars`. `initialCapital` scales the unit equity.
 * A loss streak counts consecutive trades with pnl < 0; a zero-pnl trade ends both streaks.
 */
export const buildBacktestRunReport = (
  bars: BarColumns,
  result: InstantRunResult,
  initialCapital: number,
  costProfile?: Readonly<{ id: string; label: string }>
): BacktestRunReport => {
  const size = result.equity.length;
  const equity = result.equity.map((unit) => unit * initialCapital);
  const drawdown = drawdownPass(equity);
  const tradeCount = result.trades.length;
  const metrics = reportMetrics({
    capital: initialCapital,
    drawdown,
    equity,
    stats: result.stats,
    streaks: streakPass(
      result.trades.map((trade) => trade.pnl * initialCapital)
    ),
    tradeCount,
  });
  const chartIndexes = downsampleIndexes(size, BACKTEST_RUN_CHART_MAX_POINTS);
  return {
    bars: size,
    ...(costProfile === undefined
      ? {}
      : {
          costs: costsOf(
            result,
            initialCapital,
            costProfile,
            metrics.netProfit
          ),
        }),
    equity: chartIndexes.map((index) => ({
      drawdownPct: drawdown.drawdownPct[index] as number,
      equity: equity[index] as number,
      t: bars.t[index] as number,
    })),
    firstT: bars.t[0] as number,
    lastT: bars.t[size - 1] as number,
    metrics,
    prices: chartIndexes.map((index) => ({
      c: bars.c[index] as number,
      h: bars.h[index] as number,
      l: bars.l[index] as number,
      o: bars.o[index] as number,
      t: bars.t[index] as number,
    })),
    trades: reportTrades(bars, result, initialCapital),
    tradesTruncated: tradeCount > BACKTEST_RUN_TRADES_MAX,
  };
};

/** UTC midnight in ms of a YYYY-MM-DD date. */
const dateMs = (date: string): number => Date.parse(`${date}T00:00:00.000Z`);

export type OptionsRunReportInput = Readonly<{
  /**
   * Daily bars of the run symbol; the report prices are the bars on the ledger dates (by UTC
   * date) and buy and hold compares their first and last close.
   */
  bars: BarColumns;
  /** The options ledger in money (dates, equity, trades); `capital` is its starting cash. */
  ledger: Pick<LedgerResult, "capital" | "dates" | "equity" | "trades">;
  metrics: BacktestRunOptionsMetrics;
  nautilusGap: number | null;
  signals: Readonly<Record<string, number>>;
  symbols: readonly string[];
}>;

/**
 * Builds the report of an options run from its ledger: daily money equity and drawdown, the
 * account metrics (total return, CAGR, Sharpe and exposure as the options metrics compute them;
 * Sortino from the daily equity), the spreads as trades (units = contracts, prices per contract,
 * netReturn = return on risk, balanceAfter = the ledger equity at the exit date) and `options`,
 * the options book result.
 */
export const buildOptionsRunReport = (
  input: OptionsRunReportInput
): BacktestRunReport => {
  const { ledger, metrics } = input;
  const capital = ledger.capital;
  const times = Float64Array.from(ledger.dates, dateMs);
  const size = times.length;
  const equity = Float64Array.from(ledger.equity);
  const drawdown = drawdownPass(equity);
  const unit = equity.map((value) => value / capital);
  const ratios = summarize(
    { c: unit, h: unit, l: unit, o: unit, t: times },
    unit,
    [],
    0
  );
  const days = new Set(ledger.dates);
  const { bars } = input;
  // Bars on the ledger dates: [bar index, UTC midnight of its date].
  const priced = Array.from(bars.t, (t, index): [number, number] => {
    const day = new Date(t).toISOString().slice(0, 10);
    return [days.has(day) ? index : -1, dateMs(day)];
  }).filter(([index]) => index >= 0);
  const firstClose = bars.c[priced[0]?.[0] ?? 0] as number;
  const lastClose = bars.c[priced.at(-1)?.[0] ?? 0] as number;
  const equityAt = new Map(
    ledger.dates.map((date, index) => [date, ledger.equity[index] as number])
  );
  const tradeCount = ledger.trades.length;
  const chartIndexes = downsampleIndexes(size, BACKTEST_RUN_CHART_MAX_POINTS);
  return {
    bars: size,
    equity: chartIndexes.map((index) => ({
      drawdownPct: drawdown.drawdownPct[index] as number,
      equity: equity[index] as number,
      t: times[index] as number,
    })),
    firstT: times[0] as number,
    lastT: times[size - 1] as number,
    metrics: reportMetrics({
      capital,
      drawdown,
      equity,
      stats: {
        buyHoldReturn: priced.length > 1 ? lastClose / firstClose - 1 : 0,
        cagr: metrics.cagr,
        exposure: metrics.exposure,
        sharpe: metrics.sharpe,
        sortino: ratios.sortino,
        totalReturn: metrics.totalReturn,
      },
      streaks: streakPass(ledger.trades.map((trade) => trade.pnl)),
      tradeCount,
    }),
    options: {
      capital,
      metrics,
      nautilusGap: input.nautilusGap,
      signals: input.signals,
      symbols: input.symbols,
      trades: ledger.trades.slice(0, BACKTEST_RUN_TRADES_MAX),
      tradesTruncated: tradeCount > BACKTEST_RUN_TRADES_MAX,
    },
    prices: downsampleIndexes(priced.length, BACKTEST_RUN_CHART_MAX_POINTS).map(
      (position) => {
        const [index, t] = priced[position] as [number, number];
        return {
          c: bars.c[index] as number,
          h: bars.h[index] as number,
          l: bars.l[index] as number,
          o: bars.o[index] as number,
          t,
        };
      }
    ),
    trades: ledger.trades
      .slice(0, BACKTEST_RUN_TRADES_MAX)
      .map((trade, index) => ({
        balanceAfter: equityAt.get(trade.exitDate) as number,
        entryPrice: trade.entryPrice,
        entryT: dateMs(trade.entryDate),
        exitPrice: trade.exitPrice,
        exitReason: trade.exitReason,
        exitT: dateMs(trade.exitDate),
        n: index + 1,
        netReturn: trade.returnOnRisk,
        pnl: trade.pnl,
        units: trade.contracts,
      })),
    tradesTruncated: tradeCount > BACKTEST_RUN_TRADES_MAX,
  };
};
