// An Academy modelled options backtest in the engine result shape of a backtest run (dual run, switch
// plan step 6). The research worker returns every run as an InstantRunResult (unit equity per bar,
// trades, statistics), which the API validates and compares. This maps the TypeScript Academy result
// to that shape; services/research/nautilus_backtest/academy/result.py does the same mapping for the
// Nautilus result, so the stored differences compare like with like. Pure; research only.
//
// - equity: 1 on the warm-up bars (no position), then the dollar equity / capital.
// - one trade per closed role (position, cycle or core): entry and exit bar; entryPrice and exitPrice
//   are the underlying closes at entry and exit (a structure has no single price); units and pnl are
//   per unit of capital; netReturn is the P&L over the absolute entry cash.
// - exit reason: profit-target -> target, stop -> stop, end -> end; exit-dte, expiry and core-roll ->
//   signal (the engine result has no finer reason).
// - statistics: summarize() on that equity and those trades. exposure counts the bars of every trade,
//   so a structure with a core and a cycle counts its bars twice.
import type { BacktestResult, BacktestTrade } from "@darkfactory/academy";

import {
  type BarColumns,
  barsInPositionOf,
  type InstantRunResult,
  type InstantTrade,
  summarize,
} from "./instant-backtest-engine.ts";

export const ACADEMY_EXIT_REASONS: Readonly<
  Record<BacktestTrade["reason"], InstantTrade["exitReason"]>
> = {
  "core-roll": "signal",
  end: "end",
  "exit-dte": "signal",
  expiry: "signal",
  "profit-target": "target",
  stop: "stop",
};

const barDate = (t: number): string => new Date(t).toISOString().slice(0, 10);

/**
 * The engine result of an Academy run on `bars` (the bars the run read, warm-up included), or null
 * when it cannot be held: an equity at or below 0 (the engine result needs positive unit equity).
 */
export const academyEngineResult = (
  result: Pick<BacktestResult, "equity" | "trades">,
  bars: BarColumns,
  capital: number
): InstantRunResult | null => {
  const size = bars.t.length;
  const indexOf = new Map<string, number>();
  for (let index = 0; index < size; index += 1)
    indexOf.set(barDate(bars.t[index] as number), index);
  const equity = new Float64Array(size).fill(1);
  const first = size - result.equity.length;
  for (const [offset, point] of result.equity.entries()) {
    if (!(point.equity > 0)) return null;
    equity[first + offset] = point.equity / capital;
  }
  const trades: InstantTrade[] = result.trades.map((trade) => {
    const basis = Math.abs(trade.entryNet);
    return {
      entryIndex: indexOf.get(trade.entryT) as number,
      entryPrice: trade.spotEntry,
      exitIndex: indexOf.get(trade.exitT) as number,
      exitPrice: trade.spotExit,
      exitReason: ACADEMY_EXIT_REASONS[trade.reason],
      netReturn: basis > 0 ? trade.pnl / basis : 0,
      pnl: trade.pnl / capital,
      units: trade.units / capital,
    };
  });
  return {
    equity,
    stats: summarize(bars, equity, trades, barsInPositionOf(trades)),
    trades,
  };
};
