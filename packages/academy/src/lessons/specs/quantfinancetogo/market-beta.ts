// Lesson spec: Market beta: how strongly a stock follows the market
import type { LessonSpecInput } from "../../../schema.ts";

export const spec: LessonSpecInput = {
  caveats: [
    "The creator's simulation (betas 0.5, 1 and 2 over 10,000 simulated years) measured 0.50, 1.00 and 2.00; this chart is a separate monthly simulation.",
  ],
  course: "quantfinancetogo",
  formulas: ["beta", "regression"],
  kind: "concept",
  params: [
    {
      default: 1.5,
      id: "beta",
      label: "Market beta",
      max: 3,
      min: -1,
      step: 0.05,
      unit: "x",
    },
    {
      default: 0,
      id: "alphaPct",
      label: "True alpha per year",
      max: 10,
      min: -10,
      step: 0.5,
      unit: "%",
    },
    {
      default: 4,
      id: "noise",
      label: "Own monthly swing (noise)",
      max: 15,
      min: 0,
      step: 0.5,
      unit: "%",
    },
    {
      default: 120,
      id: "months",
      label: "Months of data",
      max: 600,
      min: 12,
      step: 12,
    },
    {
      default: 0,
      help: "Extra return of one extreme month far out on the market axis; it is included in the fit.",
      id: "outlier",
      label: "Outlier month (0 = none)",
      max: 40,
      min: -40,
      step: 1,
      unit: "%",
    },
    {
      default: 0,
      id: "sizeBeta",
      label: "Fund size (SMB) beta",
      max: 2,
      min: -1,
      step: 0.05,
      unit: "x",
    },
    {
      default: 0,
      id: "valueBeta",
      label: "Fund value (HML) beta",
      max: 2,
      min: -1,
      step: 0.05,
      unit: "x",
    },
    {
      default: 0,
      id: "momBeta",
      label: "Fund momentum beta",
      max: 2,
      min: -1,
      step: 0.05,
      unit: "x",
    },
    {
      default: 7,
      id: "seed",
      label: "Random path",
      max: 999,
      min: 1,
      step: 1,
    },
  ],
  scene: {
    mode: "regression",
    type: "quant",
  },
  slug: "market-beta",
  sourceId: "DeFCbkaiVMa",
  steps: [
    {
      caption:
        "Each month: the market's excess return across, the stock's up. Simulated data with a built-in beta of 1.5.",
      color: "gray",
      element: "axes",
    },
    {
      caption:
        "The months fill in: the cloud tilts because the stock moves with the market.",
      color: "gray",
      element: "points",
      time: [0, 1],
    },
    {
      caption: "The dashed line is the built-in relation: beta 1.5, no alpha.",
      color: "green",
      element: "truth",
    },
    {
      caption:
        "Least squares estimates the slope from the data: beta = Cov / Var, close to the true 1.5.",
      color: "blue",
      element: "fit",
    },
    {
      caption:
        "The line crosses x = 0 near zero: this stock has no extra return of its own.",
      color: "gold",
      element: "alpha",
    },
    {
      caption:
        "R² shows how much of the stock's swing the market explains; the rest is its own noise.",
      color: "violet",
      element: "r2",
    },
  ],
  summary:
    "Part 14 of Quant Finance from scratch. Beta is a stock's sensitivity to the market: the slope of its returns against the market's, Cov(stock, market) / Var(market). A beta-2 stock swings about twice as much as the market.",
  tags: {
    instruments: ["single-stock", "portfolio"],
    regime: ["any"],
    risk: "none",
    timeframe: "years",
    topics: ["beta", "market risk", "regression"],
  },
  takeaways: [
    "Beta is the slope of a stock's returns against the market's: Cov(stock, market) / Var(market).",
    "A beta of 2 means the stock tends to move about twice as much as the market, in both directions.",
    "Real betas are estimates from past returns and carry estimation error.",
  ],
  title: "Market beta: how strongly a stock follows the market",
};
