// What: Contract of the statistics quant scenes (regression and factor models): modes, the element ids
// each mode draws (lesson steps reveal these), default element colors, model notes for the
// constants table and the formula ids this group adds. Pure constants: schema.ts imports this file.
import type { ColorToken } from "../schema.ts";

export const STATISTICS_ELEMENTS = {
  factor: ["axes", "bars", "a", "b", "mix", "crash", "publication"],
  regression: ["axes", "points", "fit", "truth", "outlier", "alpha", "r2"],
} as const;
export type StatisticsMode = keyof typeof STATISTICS_ELEMENTS;

/** Default colors of this group's element ids (options-scene defaults win on shared ids). */
export const STATISTICS_COLORS: Readonly<Record<string, ColorToken>> = {
  alpha: "gold",
  bars: "blue",
  crash: "red",
  fit: "blue",
  mix: "gold",
  outlier: "red",
  points: "gray",
  publication: "gray",
  r2: "violet",
  truth: "green",
};

/** One line per mode for the constants table (model and assumptions). */
export const STATISTICS_MODELS: Readonly<Record<StatisticsMode, string>> = {
  factor:
    "Bucket returns: assumed linear spread from the lowest to the highest score plus yearly noise. Long-short factor A: monthly normal returns with the spread as premium, one crash month and a premium cut after the publication year; factor B correlated with A at rho. Simulation, not market data.",
  regression:
    "Monthly excess returns: stock = alpha + beta x market + normal noise; least-squares fit (optionally with one outlier month). A simulated fund also loads on independent size (SMB), value (HML) and momentum factors with assumed premiums, regressed on 1, 3 and 4 factors. Simulation, not market data.",
};

export const STATISTICS_FORMULA_IDS = [
  "beta",
  "regression",
  "factorModel",
  "longShort",
] as const;
export type StatisticsFormulaId = (typeof STATISTICS_FORMULA_IDS)[number];
