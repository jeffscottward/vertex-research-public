// What: Contract of the options quant scenes (option pricing models, hedging and Monte Carlo variance reduction): modes, the element ids each mode
// draws (lesson steps reveal these), default element colors, model notes for the constants table
// and the formula ids this group adds. Pure constants: schema.ts imports this file.
import type { ColorToken } from "../schema.ts";

export const OPTIONS_ELEMENTS = {
  binomial: ["axes", "tree", "price", "bs"],
  hedge: ["axes", "unhedged", "hedged", "std", "ratio", "marker"],
  smile: ["axes", "curve", "market", "guesses", "flat", "smile"],
  varreduce: ["axes", "plain", "mirrored", "control", "bs", "equal"],
} as const;
export type OptionsMode = keyof typeof OPTIONS_ELEMENTS;

/** Default colors of this group's element ids (options-scene defaults win on shared ids). */
export const OPTIONS_COLORS: Readonly<Record<string, ColorToken>> = {
  bs: "amber",
  control: "green",
  equal: "gold",
  flat: "gray",
  guesses: "blue",
  hedged: "green",
  market: "amber",
  mirrored: "violet",
  plain: "blue",
  ratio: "gold",
  smile: "violet",
  std: "violet",
  tree: "blue",
  unhedged: "red",
};

/** One line per mode for the constants table (model and assumptions). */
export const OPTIONS_MODELS: Readonly<Record<OptionsMode, string>> = {
  binomial:
    "Cox-Ross-Rubinstein tree: u = e^(σ√Δt), d = 1/u, risk-neutral p = (e^(rΔt) - d)/(u - d); European call by backward induction, compared with Black-Scholes; constant volatility and rate, no dividends",
  hedge:
    "One call sold at its Black-Scholes price (implied vol) plus an optional spread, delta hedged at implied vol on seeded GBM paths (realized vol, drift = risk-free rate); cash earns the rate; no costs, no dividends; at most about 60,000 Black-Scholes evaluations, so the path count is capped as rebalances rise",
  smile:
    "Black-Scholes call (European, no dividends); implied vol by bisection starting on [0%, 100%]; smile from a Merton (1976) jump-diffusion: Poisson-weighted Black-Scholes prices turned back into implied vols, shifted to pass through the quoted price's implied vol when one is given",
  varreduce:
    "Monte Carlo price of a European call: risk-neutral lognormal terminal price, one draw per simulated price, constant volatility and rate, no dividends. Each method uses the same N simulated prices (200 to 20,000, even). Mirrored paths: the first N/2 draws and their negatives, error bar from the pair averages. Control variate: the discounted terminal stock price, whose true mean is today's price; the coefficient comes from the same sample, which biases the estimate and understates its error bar when N is small. Equal-error count = N × (plain error bar / method error bar)², capped at 1,000 × N and not defined when the plain or the mirrored sample has no payoff variation",
};

export const OPTIONS_FORMULA_IDS = [
  "impliedVol",
  "binomialTree",
  "gammaPnl",
  "antithetic",
  "controlVariate",
] as const;
export type OptionsFormulaId = (typeof OPTIONS_FORMULA_IDS)[number];
