import {
  type BarColumns,
  downsampleIndexes,
  type InstantRunResult,
} from "./instant-backtest-engine.ts";

// Report for one backtest run: account-currency metrics, a chart-sized equity and drawdown series,
// a chart-sized price series for trade replay and the trade list. The engine starts at equity 1;
// every money value here is that value multiplied by the initial capital. Statistics always use the
// full series; only the chart series are reduced. Research only; no order path.

const BACKTEST_RUN_CHART_MAX_POINTS = 2000;
export const BACKTEST_RUN_TRADES_MAX = 5000;

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
  exitReason: "signal" | "stop" | "target" | "end" | "sessionClose";
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
}>;

type DrawdownPass = Readonly<{
  lowest: number;
  maxDrawdownAbs: number;
  maxDrawdownPct: number;
  drawdownPct: Float64Array;
}>;

const drawdownPass = (equity: Float64Array, capital: number): DrawdownPass => {
  let peak = (equity[0] as number) * capital;
  let lowest = peak;
  let maxDrawdownAbs = 0;
  let maxDrawdownPct = 0;
  const drawdownPct = new Float64Array(equity.length);
  for (const [index, unit] of equity.entries()) {
    const value = unit * capital;
    peak = Math.max(peak, value);
    lowest = Math.min(lowest, value);
    const drop = peak - value;
    drawdownPct[index] = drop / peak;
    maxDrawdownAbs = Math.max(maxDrawdownAbs, drop);
    maxDrawdownPct = Math.max(maxDrawdownPct, drop / peak);
  }
  return { drawdownPct, lowest, maxDrawdownAbs, maxDrawdownPct };
};

type TradePass = Readonly<{
  grossProfit: number;
  grossLoss: number;
  profitTrades: number;
  lossTrades: number;
  largestProfit: number | null;
  largestLoss: number | null;
  maxConsecutiveWins: number;
  maxConsecutiveLosses: number;
  maxConsecutiveLossesMoney: number;
  maximalConsecutiveLoss: number;
  maximalConsecutiveLossCount: number;
  trades: BacktestRunReportTrade[];
}>;

const tradePass = (
  bars: BarColumns,
  result: InstantRunResult,
  capital: number
): TradePass => {
  const pass = {
    grossLoss: 0,
    grossProfit: 0,
    largestLoss: null as number | null,
    largestProfit: null as number | null,
    lossTrades: 0,
    maxConsecutiveLosses: 0,
    maxConsecutiveLossesMoney: 0,
    maxConsecutiveWins: 0,
    maximalConsecutiveLoss: 0,
    maximalConsecutiveLossCount: 0,
    profitTrades: 0,
    trades: [] as BacktestRunReportTrade[],
  };
  let winStreak = 0;
  let lossStreak = 0;
  let lossStreakMoney = 0;
  let balance = capital;
  for (const [index, trade] of result.trades.entries()) {
    const pnl = trade.pnl * capital;
    balance += pnl;
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
    if (index < BACKTEST_RUN_TRADES_MAX) {
      pass.trades.push({
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
      });
    }
  }
  return pass;
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
  const drawdown = drawdownPass(result.equity, initialCapital);
  const trades = tradePass(bars, result, initialCapital);
  const tradeCount = result.trades.length;
  const finalEquity = (result.equity[size - 1] as number) * initialCapital;
  const netProfit = finalEquity - initialCapital;
  const chartIndexes = downsampleIndexes(size, BACKTEST_RUN_CHART_MAX_POINTS);
  return {
    bars: size,
    ...(costProfile === undefined
      ? {}
      : { costs: costsOf(result, initialCapital, costProfile, netProfit) }),
    equity: chartIndexes.map((index) => ({
      drawdownPct: drawdown.drawdownPct[index] as number,
      equity: (result.equity[index] as number) * initialCapital,
      t: bars.t[index] as number,
    })),
    firstT: bars.t[0] as number,
    lastT: bars.t[size - 1] as number,
    metrics: {
      absoluteDrawdown: Math.max(0, initialCapital - drawdown.lowest),
      averageLossTrade:
        trades.lossTrades > 0 ? trades.grossLoss / trades.lossTrades : null,
      averageProfitTrade:
        trades.profitTrades > 0
          ? trades.grossProfit / trades.profitTrades
          : null,
      buyHoldReturn: result.stats.buyHoldReturn,
      cagr: result.stats.cagr,
      expectedPayoff: tradeCount > 0 ? netProfit / tradeCount : null,
      exposure: result.stats.exposure,
      finalEquity,
      grossLoss: trades.grossLoss,
      grossProfit: trades.grossProfit,
      initialDeposit: initialCapital,
      largestLossTrade: trades.largestLoss,
      largestProfitTrade: trades.largestProfit,
      lossTrades: trades.lossTrades,
      maxConsecutiveLosses: trades.maxConsecutiveLosses,
      maxConsecutiveLossesMoney: trades.maxConsecutiveLossesMoney,
      maxConsecutiveWins: trades.maxConsecutiveWins,
      maxDrawdownAbs: drawdown.maxDrawdownAbs,
      maxDrawdownPct: drawdown.maxDrawdownPct,
      maximalConsecutiveLoss: trades.maximalConsecutiveLoss,
      maximalConsecutiveLossCount: trades.maximalConsecutiveLossCount,
      netProfit,
      profitFactor:
        trades.grossLoss < 0 ? trades.grossProfit / -trades.grossLoss : null,
      profitTrades: trades.profitTrades,
      recoveryFactor:
        drawdown.maxDrawdownAbs > 0
          ? netProfit / drawdown.maxDrawdownAbs
          : null,
      sharpe: result.stats.sharpe,
      sortino: result.stats.sortino,
      totalReturn: result.stats.totalReturn,
      totalTrades: tradeCount,
      winRate: tradeCount > 0 ? trades.profitTrades / tradeCount : null,
    },
    prices: chartIndexes.map((index) => ({
      c: bars.c[index] as number,
      h: bars.h[index] as number,
      l: bars.l[index] as number,
      o: bars.o[index] as number,
      t: bars.t[index] as number,
    })),
    trades: trades.trades,
    tradesTruncated: tradeCount > BACKTEST_RUN_TRADES_MAX,
  };
};
