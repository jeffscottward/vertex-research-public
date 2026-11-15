// Lesson spec: Geometric Brownian motion: a fan of possible futures and a lognormal end cloud
import type { LessonSpecInput } from "../../../../../packages/academy/src/schema.ts";

export const spec = {
  caveats: [
    "The reel shows no numbers (its spoken audio is unrelated); the starting price, drift and volatility here are illustrative inputs.",
  ],
  course: "quantfinancetogo",
  formulas: ["gbm", "sqrtTime"],
  kind: "concept",
  params: [
    {
      default: 100,
      id: "spot",
      label: "Starting price",
      max: 1000,
      min: 10,
      step: 10,
      unit: "$",
    },
    {
      default: 8,
      help: "Expected growth per year: the mean path is S0·e^(μt).",
      id: "drift",
      label: "Drift",
      max: 30,
      min: -20,
      step: 0.5,
      unit: "%",
    },
    {
      default: 30,
      help: "Size of the random shocks per year.",
      id: "vol",
      label: "Volatility",
      max: 100,
      min: 1,
      step: 1,
      unit: "%",
    },
    {
      default: 2,
      id: "years",
      label: "Years",
      max: 10,
      min: 0.25,
      step: 0.25,
    },
    {
      default: 1000,
      id: "paths",
      label: "Paths",
      max: 5000,
      min: 50,
      step: 50,
    },
    {
      default: 11,
      help: "Same seed, same paths; change it to draw another run.",
      id: "seed",
      label: "Random seed",
      max: 999,
      min: 1,
      step: 1,
    },
  ],
  scene: {
    mode: "gbm",
    type: "quant",
  },
  slug: "geometric-brownian-motion-fan",
  sourceId: "Dc8aNqHKV02",
  steps: [
    {
      caption:
        "All the lines follow one rule, geometric Brownian motion: a constant drift plus compounding random shocks.",
      color: "gray",
      element: "axes",
    },
    {
      caption:
        "The highlighted path is a single member of a large fan of possible futures; no path is more likely to be the real one.",
      color: "gray",
      element: "paths",
      time: [0, 1],
    },
    {
      caption:
        "The median path: half of the futures end above it and half below.",
      color: "gold",
      element: "median",
    },
    {
      caption:
        "The expected value S0·e^(μt): compounding lifts the average above the median.",
      color: "amber",
      element: "mean",
    },
    {
      caption:
        "The 10th to 90th percentile band keeps widening as the shocks compound.",
      color: "violet",
      element: "band",
    },
    {
      caption:
        "Where they all land: a lognormal cloud, wide and skewed (green bins above the start, red below).",
      color: "red",
      element: "bars",
    },
    {
      caption:
        "Predicting one exact price cannot work, but predicting the spread of outcomes can.",
      color: "violet",
      element: "pdf",
    },
  ],
  summary:
    "Price paths that all follow one rule, geometric Brownian motion: a constant drift plus compounding random shocks. The highlighted path is a single member of a large fan of possible futures, and no path is more likely to be the real one. The end points form a lognormal cloud that is wide and skewed, so predicting one exact price cannot work, while predicting the spread of outcomes can.",
  tags: {
    instruments: ["single-stock"],
    regime: ["any"],
    risk: "none",
    timeframe: "years",
    topics: ["brownian motion", "lognormal", "simulation", "stochastics"],
  },
  takeaways: [
    "Under geometric Brownian motion, a price follows a steady drift plus random shocks that compound over time.",
    "Any single path is one possible future among many, and none is more real than the rest.",
    "The end prices form a lognormal cloud, wide and skewed, so forecasting the distribution works where forecasting one price does not.",
  ],
  title:
    "Geometric Brownian motion: a fan of possible futures and a lognormal end cloud",
} satisfies LessonSpecInput;
