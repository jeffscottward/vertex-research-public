// What: Contract of the growth quant scenes (returns, compounding and time value): modes, the element ids
// each mode draws (lesson steps reveal these), default element colors, model notes for the
// constants table and the formula ids this group adds. Pure constants: schema.ts imports this file.
import type { ColorToken } from "../schema.ts";

export const GROWTH_ELEMENTS = {
  compound: ["axes", "curve", "discount", "marker", "rates"],
  drag: ["axes", "mean", "curve", "marker", "paths", "median"],
  logreturns: ["axes", "price", "simple", "log", "actual"],
} as const;
export type GrowthMode = keyof typeof GROWTH_ELEMENTS;

/** Default colors of this group's element ids (options-scene defaults win on shared ids). */
export const GROWTH_COLORS: Readonly<Record<string, ColorToken>> = {
  actual: "gold",
  curve: "green",
  discount: "violet",
  log: "green",
  mean: "amber",
  median: "gold",
  paths: "blue",
  price: "blue",
  rates: "cyan",
  simple: "red",
};

/** One line per mode for the constants table (model and assumptions). */
export const GROWTH_MODELS: Readonly<Record<GrowthMode, string>> = {
  compound:
    "Discrete annual compounding at a fixed rate r: FV = A(1 + r)^n, PV = A / (1 + r)^n. No taxes, fees or default risk.",
  drag: "Geometric Brownian motion with arithmetic mean return μ and volatility σ per year: expected wealth grows at μ, the median at μ − σ²/2 (monthly steps, seeded).",
  logreturns:
    "Seeded random walk: daily log returns drawn from a normal distribution with the chosen daily volatility and zero drift; price starts at $100.",
};

export const GROWTH_FORMULA_IDS = [
  "presentValue",
  "logReturn",
  "volDrag",
] as const;
export type GrowthFormulaId = (typeof GROWTH_FORMULA_IDS)[number];
