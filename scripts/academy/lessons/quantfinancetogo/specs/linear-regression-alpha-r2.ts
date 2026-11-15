// Lesson spec: Linear regression in finance: beta, alpha and R²
import type { LessonSpecInput } from "../../../../../packages/academy/src/schema.ts";

export const spec: LessonSpecInput = {
  caveats: [
    "The creator's figures (504 simulated days, built-in beta 1.2): estimated beta 1.26, alpha +0.05% a day, R² 52%; with a second factor R² 63%. This chart is a monthly simulation.",
  ],
  course: "quantfinancetogo",
  formulas: ["regression", "beta"],
  kind: "concept",
  params: [
    {
      default: 1.2,
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
      default: 6,
      id: "noise",
      label: "Own monthly swing (noise)",
      max: 15,
      min: 0,
      step: 0.5,
      unit: "%",
    },
    {
      default: 24,
      id: "months",
      label: "Months of data",
      max: 600,
      min: 12,
      step: 12,
    },
    {
      default: 25,
      help: "Extra return of one extreme month far out on the market axis; it is included in the fit.",
      id: "outlier",
      label: "Outlier month (0 = none)",
      max: 40,
      min: -40,
      step: 1,
      unit: "%",
    },
    {
      default: 0.6,
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
  slug: "linear-regression-alpha-r2",
  sourceId: "DeY9P8_CpfW",
  steps: [
    {
      caption:
        "Stock against market excess returns, two simulated years of months, built-in beta 1.2 and no alpha.",
      color: "gray",
      element: "axes",
    },
    {
      caption:
        "Each dot is one month. Least squares squares every miss and adds them up.",
      color: "gray",
      element: "points",
      time: [0, 1],
    },
    {
      caption:
        "The best line makes that sum as small as possible. Its slope is the estimated beta.",
      color: "blue",
      element: "fit",
    },
    {
      caption:
        "The dashed true line: with little data the estimate lands near it, not on it.",
      color: "green",
      element: "truth",
    },
    {
      caption: "One extreme month far out pulls the fitted line toward itself.",
      color: "red",
      element: "outlier",
    },
    {
      caption:
        "The intercept at x = 0 is alpha: the return when the market does not move.",
      color: "gold",
      element: "alpha",
    },
    {
      caption:
        "Adding a second factor: R² rises and alpha is what the factors cannot explain.",
      color: "violet",
      element: "r2",
    },
  ],
  summary:
    "Part 21 of Quantitative Finance From Scratch. Least squares fits the line that minimizes the squared misses: the slope is beta, the intercept is alpha and R² is the share of the variance the line explains. A few extreme points can pull the line.",
  tags: {
    instruments: ["single-stock"],
    regime: ["any"],
    risk: "none",
    timeframe: "months",
    topics: ["regression", "alpha", "r-squared"],
  },
  takeaways: [
    "Least squares minimizes the sum of squared distances from the line.",
    "Slope = beta, intercept = alpha, R² = share of the variance explained (0 to 1).",
    "Regression shows association, not cause, and a few extreme points can move it.",
  ],
  title: "Linear regression in finance: beta, alpha and R²",
};
