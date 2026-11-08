// What: Contract of the portfolio quant scenes (portfolio construction and asset pricing): modes, the element ids each mode
// draws (lesson steps reveal these), default element colors, model notes for the constants table
// and the formula ids this group adds. Pure constants: schema.ts imports this file.
import type { ColorToken } from "../schema.ts";

/**
 * Param ids each mode reads (all optional; defaults reproduce the reels' examples):
 * - frontier: retA, volA, retB, volB, retC, volC (% a year), rho (all pairs) or rhoAB, rhoAC, rhoBC,
 *   rf (%), mixes (random mixes in the cloud, 10-300, default 150), seed. t reveals the cloud.
 * - diversify: rho, vol (%), assets (largest N), seed. t reveals the scatter days.
 * - sml: rf (%), marketReturn (%), alpha or mispricing (%), gap (same-beta pair spread, %), seed.
 * - riskparity: stockVol, bondVol (%), rho, stockWeight (%).
 * - blend: stockVol, bondVol (%), rho, stockWeight (% market weight), riskAversion (δ), tau (τ),
 *   view (% stock excess return), confidence (% weight on the view).
 */
export const PORTFOLIO_ELEMENTS = {
  blend: ["axes", "prior", "view", "posterior", "curve", "marker"],
  diversify: ["axes", "points", "mix", "marker", "count", "floor"],
  frontier: [
    "axes",
    "assets",
    "rf",
    "lines",
    "cloud",
    "frontier",
    "cml",
    "tangency",
    "minVar",
  ],
  riskparity: ["axes", "capital", "risk"],
  sml: ["axes", "line", "assets", "alpha", "pair"],
} as const;
export type PortfolioMode = keyof typeof PORTFOLIO_ELEMENTS;

/** Default colors of this group's element ids (options-scene defaults win on shared ids). */
export const PORTFOLIO_COLORS: Readonly<Record<string, ColorToken>> = {
  alpha: "green",
  assets: "blue",
  capital: "blue",
  cloud: "cyan",
  cml: "amber",
  count: "blue",
  floor: "red",
  frontier: "violet",
  line: "violet",
  lines: "gray",
  minVar: "red",
  mix: "violet",
  pair: "amber",
  points: "cyan",
  posterior: "green",
  prior: "gray",
  rf: "gold",
  risk: "red",
  tangency: "green",
  view: "gold",
};

/** One line per mode for the constants table (model and assumptions). */
export const PORTFOLIO_MODELS: Readonly<Record<PortfolioMode, string>> = {
  blend:
    "Black-Litterman, one absolute view on stocks: implied returns Π = δΣw from market weights; view variance Ω = τσ²(1 − c)/c, so the confidence c is the weight the posterior gives the view",
  diversify:
    "One-factor model: each asset is a shared market push plus its own push, all with the same volatility and pairwise correlation ρ; equal weights; ρ below 0 is floored at 0 for many assets",
  frontier:
    "Markowitz mean-variance: three assets with assumed returns, volatilities and correlations; long-only weights; frontier and optimal mixes from a fine weight grid; lend or borrow at the risk-free rate on the CML",
  riskparity:
    "Two assets (stocks, bonds) with assumed volatilities and one correlation; risk contribution of asset i = w_i(Σw)_i / σ_p²; risk parity by inverse volatility",
  sml: "CAPM: E[R] = rf + β(E[Rm] − rf); measured stock averages scatter around the line by sampling noise; APT: equal factor exposures must earn equal expected returns",
};

export const PORTFOLIO_FORMULA_IDS = [
  "sharpe",
  "portfolioVariance",
  "correlation",
  "diversification",
  "capm",
  "apt",
  "riskParity",
  "blackLitterman",
] as const;
export type PortfolioFormulaId = (typeof PORTFOLIO_FORMULA_IDS)[number];
