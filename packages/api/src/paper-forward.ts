import {
  type BarColumns,
  type InstantRunParams,
  type InstantTrade,
  runInstantBacktest,
} from "./instant-backtest-engine.ts";

// Paper forward step (pure). Runs the same engine as a backtest over every stored bar from the
// baseline start to the newest bar and returns only the settled paper results after a cursor.
// Fills are simulated by the engine with the run's cost settings. This module has no broker,
// order or network access; it imports only the backtest engine (a guard test checks this).

/** A bar result is settled when one later bar exists, so a new bar cannot change it. */
const SETTLE_LAG = 1;

export type PaperForwardPoint = Readonly<{ t: number; equity: number }>;
export type PaperForwardTrade = Readonly<{ t: number; pnl: number }>;

export type PaperForwardCursor = Readonly<{
  /** First bar time of the forward period (epoch ms); earlier bars only warm up the strategy. */
  forwardStartT: number;
  /** Starting capital; engine equity starts at 1 and is scaled by this value. */
  capital: number;
  /** Only points later than this time are returned. */
  afterPointT: number;
  /** Only trades later than this time are returned. */
  afterTradeT: number;
}>;

export type PaperForwardStep = Readonly<{
  points: PaperForwardPoint[];
  trades: PaperForwardTrade[];
  /** Index of the newest settled bar, or -1 when no bar is settled yet. */
  settledIndex: number;
}>;

/** Closed trades that a backtest over the same bars reports and a paper run can also report. */
export const settledForwardTrades = (
  bars: BarColumns,
  trades: readonly InstantTrade[],
  forwardStartT: number
): InstantTrade[] => {
  const settledIndex = bars.t.length - 1 - SETTLE_LAG;
  return trades.filter(
    (trade) =>
      trade.exitReason !== "end" &&
      trade.exitIndex <= settledIndex &&
      (bars.t[trade.entryIndex] as number) >= forwardStartT
  );
};

/** Returns the settled forward points and closed trades after the cursor. */
export const paperForwardStep = (
  bars: BarColumns,
  params: InstantRunParams,
  cursor: PaperForwardCursor
): PaperForwardStep => {
  const size = bars.t.length;
  const settledIndex = size - 1 - SETTLE_LAG;
  if (size < 2) return { points: [], settledIndex: -1, trades: [] };
  const result = runInstantBacktest(bars, params);
  const points: PaperForwardPoint[] = [];
  for (let index = 0; index <= settledIndex; index += 1) {
    const t = bars.t[index] as number;
    if (t >= cursor.forwardStartT && t > cursor.afterPointT)
      points.push({
        equity: cursor.capital * (result.equity[index] as number),
        t,
      });
  }
  const trades = settledForwardTrades(bars, result.trades, cursor.forwardStartT)
    .map((trade) => ({
      pnl: cursor.capital * trade.pnl,
      t: bars.t[trade.exitIndex] as number,
    }))
    .filter((trade) => trade.t > cursor.afterTradeT);
  return { points, settledIndex, trades };
};
