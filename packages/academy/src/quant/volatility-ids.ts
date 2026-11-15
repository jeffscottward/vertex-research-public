// What: Contract of the volatility quant scenes (volatility models, tail risk and filtering): modes, the element ids each mode
// draws (lesson steps reveal these), default element colors, model notes for the constants table
// and the formula ids this group adds. Pure constants: schema.ts imports this file.
//
// Params each mode reads (lesson spec param ids; anything else is ignored):
// - tail: dailyVol (% a day), dof (Student t degrees of freedom), confidence (%), days, position ($), seed
// - volcluster: longRunVol (% a year), alpha, beta, gamma, shockDay, shockPct (% move, signed), days, seed
// - voltarget: targetVol (% a year), maxLeverage (x), longRunVol (% a year), alpha, beta, drift (% a year), days, seed
// - filter: processNoise ($ a day), measurementNoise ($), threshold (standard deviations), days, seed
import type { ColorToken } from "../schema.ts";

export const VOLATILITY_ELEMENTS = {
  filter: ["axes", "truth", "observed", "filtered", "fades", "gain"],
  tail: ["axes", "bars", "normal", "fat", "var", "es", "tail"],
  volcluster: ["axes", "bars", "band", "garch", "gjr", "longRun", "shock"],
  voltarget: ["axes", "forecast", "target", "exposure", "hold", "targeted"],
} as const;
export type VolatilityMode = keyof typeof VOLATILITY_ELEMENTS;

/** Default colors of this group's element ids (options-scene defaults win on shared ids). */
export const VOLATILITY_COLORS: Readonly<Record<string, ColorToken>> = {
  band: "violet",
  es: "red",
  exposure: "blue",
  fades: "red",
  fat: "red",
  filtered: "gold",
  forecast: "violet",
  gain: "violet",
  garch: "violet",
  gjr: "red",
  hold: "gray",
  longRun: "gray",
  normal: "blue",
  observed: "cyan",
  shock: "red",
  tail: "red",
  target: "amber",
  targeted: "gold",
  truth: "gray",
  var: "amber",
};

/** One line per mode for the constants table (model and assumptions). */
export const VOLATILITY_MODELS: Readonly<Record<VolatilityMode, string>> = {
  filter:
    "Local-level Kalman filter: the hidden price is a random walk (process noise Q) and every observation adds independent normal noise (R); a fade signal fires when an observation lands more than k innovation standard deviations from the prediction",
  tail: "Daily returns drawn from a Student t scaled to the chosen daily volatility, compared with a bell curve at the same volatility; VaR and expected shortfall read from the simulated days (historical method) and from both curves",
  volcluster:
    "GJR-GARCH(1,1) with normal shocks (gamma = 0 is plain GARCH); omega is set from the long-run volatility, alpha + beta + gamma/2 is kept below 1, and one shock day is forced; the GARCH line uses alpha + gamma/2 on the same returns",
  voltarget:
    "GARCH(1,1) simulated asset with a constant drift; exposure = target volatility / GARCH forecast, capped at the max leverage, set before each day; no trading costs, no borrowing rate, daily rebalancing",
};

export const VOLATILITY_FORMULA_IDS = [
  "valueAtRisk",
  "expectedShortfall",
  "studentT",
  "garch",
  "gjrGarch",
  "volTarget",
  "kalman",
] as const;
export type VolatilityFormulaId = (typeof VOLATILITY_FORMULA_IDS)[number];
