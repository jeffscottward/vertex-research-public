// What: Contract of the process quant scenes (random processes): modes, the element ids
// each mode draws (lesson steps reveal these), default element colors, model notes for the
// constants table and the formula ids this group adds. Pure constants: schema.ts imports this file.
import type { ColorToken } from "../schema.ts";

export const PROCESS_ELEMENTS = {
  gbm: ["axes", "paths", "median", "mean", "band", "bars", "pdf"],
  meanrev: ["axes", "paths", "mean", "band", "halfLife", "decay"],
  walk: ["axes", "paths", "mean", "band", "bars", "pdf"],
} as const;
export type ProcessMode = keyof typeof PROCESS_ELEMENTS;

/**
 * Default colors of this group's element ids (options-scene defaults win on shared ids: paths gray,
 * median gold, bars green, pdf violet). A histogram's losing bins draw in the bars color, so lessons
 * color bars red (winning bins are always green).
 */
export const PROCESS_COLORS: Readonly<Record<string, ColorToken>> = {
  band: "violet",
  decay: "gold",
  halfLife: "cyan",
  mean: "amber",
};

/** One line per mode for the constants table (model and assumptions). */
export const PROCESS_MODELS: Readonly<Record<ProcessMode, string>> = {
  gbm: "Geometric Brownian motion: constant drift μ and volatility σ, normal log returns, no jumps; mean S0·e^(μt), median S0·e^((μ - σ²/2)t); paths are simulated on at most 252 time steps",
  meanrev:
    "Ornstein-Uhlenbeck (daily AR(1)): each day the distance from the long-run mean shrinks by the share 1 - 2^(-1/half-life), plus a normal shock; constant mean, pull and volatility",
  walk: "Arithmetic random walk: independent steps (coin ±a, uniform or normal) with mean μ (drift, the edge) and standard deviation σ; after n steps the sum has mean n·μ and spread σ√n",
};

export const PROCESS_FORMULA_IDS = [
  "randomWalk",
  "sqrtTime",
  "normalPdf",
  "gbm",
  "ornsteinUhlenbeck",
] as const;
export type ProcessFormulaId = (typeof PROCESS_FORMULA_IDS)[number];
