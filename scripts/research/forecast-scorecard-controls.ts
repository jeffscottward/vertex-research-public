// Control forecasts for the forecast scorecard, with an independent check value (pure).
//
// Spec: docs/specs/research/forecast-scorecard.md ("Controls and the independent check").
// This file computes the prior, the direction and the Brier arithmetic on its own, from the
// prices, and does not call the scorer. The command compares the scorer's result with the
// check value of each control. Two controls read the outcome on purpose (perfect, planted),
// so these forecasts exist only here and their source starts with "control:".
//
// Research only. Nothing here creates, sizes, sends or blocks an order.

import type {
  ForecastRecord,
  SymbolBars,
} from "../../packages/api/src/forecast-scorecard.ts";
import { at } from "../../packages/api/src/quant-arrays.ts";

export type GridPoint = Readonly<{
  symbol: string;
  date: string;
  // Share of up moves among the earlier windows that ended on or before this bar.
  prior: number;
  up: boolean;
}>;

/**
 * Per symbol (sorted): one decision bar every `horizonBars` bars, from the first bar whose
 * prior has `priorMinWindows` windows, while `horizonBars` later bars exist. Grid bars with a
 * flat outcome are left out.
 */
export const controlGrid = (
  barsBySymbol: ReadonlyMap<string, SymbolBars>,
  horizonBars: number,
  priorMinWindows: number
): GridPoint[] => {
  const grid: GridPoint[] = [];
  const symbols = [...barsBySymbol.entries()].sort(([left], [right]) =>
    left < right ? -1 : 1
  );
  for (const [symbol, { dates, prices }] of symbols) {
    let ups = 0;
    let moved = 0;
    let first = -1;
    for (let bar = horizonBars; bar + horizonBars < prices.length; bar += 1) {
      // The window that ends at this bar joins the earlier windows.
      const before = at(prices, bar - horizonBars);
      const now = at(prices, bar);
      ups += Number(now > before);
      moved += Number(now !== before);
      if (moved < priorMinWindows) continue;
      if (first < 0) first = bar;
      const later = at(prices, bar + horizonBars);
      if ((bar - first) % horizonBars !== 0 || later === now) continue;
      grid.push({
        date: at(dates, bar),
        prior: (ups + 1) / (moved + 2),
        symbol,
        up: later > now,
      });
    }
  }
  return grid;
};

export type Control = Readonly<{
  id: string;
  records: ForecastRecord[];
  // Computed here, without the scorer: record count and skill against 0.5 and against the prior.
  check: Readonly<{ records: number; skillHalf: number; skillPrior: number }>;
}>;

const control = (
  id: string,
  source: string,
  sourceVersion: string | null,
  grid: readonly GridPoint[],
  bullishOf: (point: GridPoint) => number
): Control => {
  let forecast = 0;
  let prior = 0;
  const records = grid.map((point): ForecastRecord => {
    const bullish = bullishOf(point);
    const bearish = 1 - bullish;
    const outcome = Number(point.up);
    forecast += (bullish / (bullish + bearish) - outcome) ** 2;
    prior += (point.prior - outcome) ** 2;
    return {
      dataAsOf: point.date,
      decidedAt: null,
      model: null,
      probabilities: { BEARISH: bearish, BULLISH: bullish, NEUTRAL: 0 },
      schemaVersion: 1,
      source,
      sourceVersion,
      symbol: point.symbol,
    };
  });
  const empty = grid.length === 0;
  return {
    check: {
      records: grid.length,
      skillHalf: empty ? 0 : 1 - forecast / (0.25 * grid.length),
      skillPrior: empty ? 0 : 1 - forecast / prior,
    },
    id,
    records,
  };
};

/** The forecast equals the prior: skill against the prior is 0. */
export const baselineCopyControl = (grid: readonly GridPoint[]): Control =>
  control(
    "baseline-copy",
    "control:baseline-copy",
    null,
    grid,
    (point) => point.prior
  );

/** The forecast is the outcome: Brier 0, skill 1. */
export const perfectControl = (grid: readonly GridPoint[]): Control =>
  control("perfect", "control:perfect", null, grid, (point) =>
    Number(point.up)
  );

/**
 * One `random()` call per grid point decides whether the forecaster points to the true direction
 * (probability 0.5 + strength). pUp = prior + strength when it points up, prior - strength when
 * it points down, limited to 0.01..0.99.
 */
export const plantedControl = (
  grid: readonly GridPoint[],
  strength: number,
  random: () => number
): Control => {
  const text = strength.toFixed(2);
  return control(`planted-${text}`, "control:planted", text, grid, (point) => {
    const pointsUp = random() < 0.5 + strength === point.up;
    return Math.min(
      0.99,
      Math.max(0.01, point.prior + (pointsUp ? strength : -strength))
    );
  });
};
