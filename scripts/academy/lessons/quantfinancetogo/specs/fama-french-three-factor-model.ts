// Lesson spec: The Fama-French three-factor model
import type { LessonSpecInput } from "../../../../../packages/academy/src/schema.ts";

export const spec: LessonSpecInput = {
  caveats: [
    "The creator's figures (simulated small value portfolio): market alone 7.9% alpha a year and 46% explained; three factors −0.9% alpha and 90% explained.",
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
      default: 3,
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
  slug: "fama-french-three-factor-model",
  sourceId: "Deo-i-zCdMb",
  steps: [
    {
      caption:
        "Fifty simulated years of monthly returns of a portfolio with market, size and value betas of 1 and zero true alpha.",
      color: "gray",
      element: "axes",
    },
    {
      caption:
        "Against the market alone the cloud is wide: size and value swings look like noise.",
      color: "gray",
      element: "points",
      time: [0, 1],
    },
    {
      caption: "The market-only line: slope near 1.",
      color: "blue",
      element: "fit",
    },
    {
      caption:
        "The market-only alpha is large: the size and value premiums are counted as skill.",
      color: "gold",
      element: "alpha",
    },
    {
      caption:
        "With SMB and HML in the regression, alpha falls toward zero and R² jumps.",
      color: "violet",
      element: "r2",
    },
  ],
  summary:
    "Part 27 of Quantitative Finance From Scratch. Fama and French (1993) added size (SMB) and value (HML) to the market factor. A small value portfolio looks like it has alpha against the market alone; with all three factors the alpha shrinks toward zero and R² rises.",
  tags: {
    instruments: ["portfolio"],
    regime: ["any"],
    risk: "none",
    timeframe: "years",
    topics: ["fama-french", "factor models", "alpha"],
  },
  takeaways: [
    "Each factor is a long-short return: small minus big (SMB), cheap minus expensive (HML).",
    "Alpha is what the factors cannot explain; omitted factors leak into alpha.",
    "Three factors account for much of the spread in average returns, but they do not capture momentum.",
  ],
  title: "The Fama-French three-factor model",
};
