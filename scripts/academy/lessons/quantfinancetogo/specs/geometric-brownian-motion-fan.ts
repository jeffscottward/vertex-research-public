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
        "Every line obeys the same law, geometric Brownian motion: a steady drift plus random shocks that compound over time.",
      color: "gray",
      element: "axes",
    },
    {
      caption:
        "One path is just one of a whole fan of possible futures, and none of them is more real than the others.",
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
        "Forecasting a single price is hopeless, while forecasting the distribution actually works.",
      color: "violet",
      element: "pdf",
    },
  ],
  summary:
    "An animation in which every price path obeys the same law, geometric Brownian motion: a steady drift plus random shocks that compound over time. The highlighted path is just one of a whole fan of possible futures, none more real than the others. Where they all land is a lognormal cloud, wide and skewed, which is why forecasting a single price is hopeless while forecasting the distribution works.",
  tags: {
    instruments: ["single-stock"],
    regime: ["any"],
    risk: "none",
    timeframe: "years",
    topics: ["brownian motion", "lognormal", "simulation", "stochastics"],
  },
  takeaways: [
    "Under geometric Brownian motion, a price follows a steady drift plus random shocks that compound over time.",
    "A highlighted path is only one of a whole fan of possible futures, and none of them is more real than the others.",
    "The end prices form a lognormal cloud, wide and skewed, so forecasting the distribution works where forecasting one price does not.",
  ],
  title:
    "Geometric Brownian motion: a fan of possible futures and a lognormal end cloud",
} satisfies LessonSpecInput;
