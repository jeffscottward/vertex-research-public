// Lesson spec: The Carhart four-factor model
import type { LessonSpecInput } from "../../../../../packages/academy/src/schema.ts";

export const spec: LessonSpecInput = {
  caveats: [
    "The creator's figures for his all-exposure simulated stock: market alone explains 40% of its swings, three factors 69%, all four 94%.",
  ],
  course: "quantfinancetogo",
  formulas: ["factorModel", "regression"],
  kind: "concept",
  params: [
    {
      default: 1,
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
      default: 2,
      id: "noise",
      label: "Own monthly swing (noise)",
      max: 15,
      min: 0,
      step: 0.5,
      unit: "%",
    },
    {
      default: 600,
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
      default: 1,
      id: "sizeBeta",
      label: "Fund size (SMB) beta",
      max: 2,
      min: -1,
      step: 0.05,
      unit: "x",
    },
    {
      default: 1,
      id: "valueBeta",
      label: "Fund value (HML) beta",
      max: 2,
      min: -1,
      step: 0.05,
      unit: "x",
    },
    {
      default: 1,
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
  slug: "carhart-four-factor-model",
  sourceId: "Dewi5Z1CDEU",
  steps: [
    {
      caption:
        "A simulated fund with betas of 1 to market, size, value and momentum, true alpha zero, fifty years of months.",
      color: "gray",
      element: "axes",
    },
    {
      caption:
        "Against the market alone, much of the fund's swing is unexplained.",
      color: "gray",
      element: "points",
      time: [0, 1],
    },
    {
      caption: "The market-only fit: beta near 1 but a wide cloud.",
      color: "blue",
      element: "fit",
    },
    {
      caption:
        "Alpha by model: market only shows a big alpha, four factors bring it near zero.",
      color: "gold",
      element: "alpha",
    },
    {
      caption: "R² climbs from the market model to three factors to four.",
      color: "violet",
      element: "r2",
    },
  ],
  summary:
    "Part 29 of Quantitative Finance From Scratch. Carhart (1997) added momentum to the Fama-French factors. For a fund with market, size, value and momentum exposures, each added factor lowers the apparent alpha and raises R².",
  tags: {
    instruments: ["portfolio"],
    regime: ["any"],
    risk: "none",
    timeframe: "years",
    topics: ["carhart", "momentum", "factor models"],
  },
  takeaways: [
    "Carhart's model: market, size, value and momentum, one beta per factor.",
    "In his fund study, four factors and costs explained most persistent fund winners.",
    "Hundreds of factors have been proposed; many are likely false discoveries.",
  ],
  title: "The Carhart four-factor model",
};
