// What: Contract of the trading quant scenes (trading rules and market microstructure): modes, the element ids each mode
// draws (lesson steps reveal these), default element colors, model notes for the constants table
// and the formula ids this group adds. Pure constants: schema.ts imports this file.
// Params each mode reads (trading-models.ts clamps every one):
// - pairs: halfLife (days), entryZ, exitZ, lookback (days), costBps, days, seed
// - landscape: window (days), costBps, regimeShift (0-2), seed
// - orderbook: orderSize (shares), levelSize (shares), levels, tickSize ($), spreadTicks, depthGrowth (%), mid ($)
import type { ColorToken } from "../schema.ts";

export const TRADING_ELEMENTS = {
  landscape: ["axes", "surface", "optimum", "model"],
  orderbook: ["axes", "bids", "asks", "sweep", "avg", "curve", "marker"],
  pairs: ["axes", "a", "b", "zscore", "entry", "exit", "trades", "pnl"],
} as const;
export type TradingMode = keyof typeof TRADING_ELEMENTS;

/** Default colors of this group's element ids (options-scene defaults win on shared ids). */
export const TRADING_COLORS: Readonly<Record<string, ColorToken>> = {
  asks: "red",
  avg: "gold",
  bids: "green",
  entry: "amber",
  exit: "cyan",
  model: "gold",
  optimum: "cyan",
  sweep: "amber",
  trades: "gold",
  zscore: "violet",
};

/** One line per mode for the constants table (model and assumptions). */
export const TRADING_MODELS: Readonly<Record<TradingMode, string>> = {
  landscape:
    "Walk-forward optimization: a seeded spread (mean-reverting part plus slow drift) whose half-life drifts with the regime-shift input; 16 rolling windows, each refit 1/4 window later; on each window the z-score rule (enter at |z| ≥ threshold, exit at the mean) is backtested on an 8×8 grid of lookback × threshold; Sharpe is annualized after costs on $200 traded per position change; the model trades the previous window's best cell.",
  orderbook:
    "Static limit order book on a tick grid: best bid and ask spread-ticks apart around mid, sizes growing by the depth-growth input per level; a market buy fills against the asks in price priority (no fees, hidden orders, cancellations or replenishment).",
  pairs:
    "Cointegrated pair: a is a seeded lognormal random walk (1.5% daily vol), b = 1.2·a + an Ornstein-Uhlenbeck spread (sd $2.50) with the half-life input; z-score of the spread over the lookback, one unit = 100 shares of b against 120 of a, decided at the close and held to the next close; costs in bps of both legs' notional at every entry and exit.",
};

export const TRADING_FORMULA_IDS = [
  "zScore",
  "walkForward",
  "slippage",
] as const;
export type TradingFormulaId = (typeof TRADING_FORMULA_IDS)[number];
