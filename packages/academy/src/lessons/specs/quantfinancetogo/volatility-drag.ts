// Lesson spec: Volatility drag: why your average return is lying to you
import type { LessonSpecInput } from "../../../schema.ts";

export const spec: LessonSpecInput = {
  caveats: [
    "The rule is approximate: for ±50% the exact loss per step is 13.4% against 12.5%.",
    "The video's simulated wild investment shrank 1.5% a year; this model with exact μ = 10% gives −2.5%.",
  ],
  course: "quantfinancetogo",
  formulas: ["volDrag", "logReturn"],
  kind: "concept",
  params: [
    {
      default: 10,
      id: "mu",
      label: "Average return per year",
      max: 30,
      min: -10,
      step: 0.5,
      unit: "%",
    },
    {
      default: 50,
      id: "vol",
      label: "Volatility per year",
      max: 100,
      min: 0,
      step: 1,
      unit: "%",
    },
    {
      default: 30,
      id: "years",
      label: "Years",
      max: 50,
      min: 1,
      step: 1,
    },
    {
      default: 9,
      id: "seed",
      label: "Random path",
      max: 999,
      min: 1,
      step: 1,
    },
  ],
  scene: {
    mode: "drag",
    type: "quant",
  },
  slug: "volatility-drag",
  sourceId: "Dd6N64VCrUl",
  steps: [
    {
      caption:
        "Return per year against volatility. Both investments in the video are built for a 10% average.",
      color: "gray",
      element: "axes",
    },
    {
      caption: "The average return stays at 10% however wild the swings get.",
      color: "amber",
      element: "mean",
    },
    {
      caption:
        "The growth rate is the average minus half the volatility squared: 9.5% at σ = 10%.",
      color: "green",
      element: "curve",
    },
    {
      caption:
        "At 50% volatility the drag is 12.5% a year, more than the whole average: the money shrinks.",
      color: "red",
      element: "marker",
    },
    {
      caption:
        "Simulated wealth paths at that volatility from $100. The dashed line is the expected (mean) wealth, growing at 10%.",
      color: "blue",
      element: "paths",
      time: [0, 1],
    },
    {
      caption:
        "The typical (median) path follows the growth rate and sinks, while the mean is pulled up by a few huge winners.",
      color: "gold",
      element: "median",
    },
  ],
  summary:
    "Part 9 of Quant Finance from scratch. +50% then −50% averages 0% yet leaves $75 of $100. Money compounds at about the average return minus half the volatility squared: at 10% average and 50% volatility it shrinks about 1.5% to 2.5% a year.",
  tags: {
    instruments: ["portfolio", "volatility"],
    regime: ["high-vol"],
    risk: "none",
    timeframe: "years",
    topics: ["volatility drag", "compounding", "log returns"],
  },
  takeaways: [
    "+50% then −50% leaves (1 + 0.5)(1 − 0.5) = 0.75 of your money though the average is 0%.",
    "Money compounds at about μ − σ²/2: five times the swing means 25 times the drag.",
    "The average return leaves out the drag; the growth rate is what your money actually earns.",
  ],
  title: "Volatility drag: why your average return is lying to you",
};
