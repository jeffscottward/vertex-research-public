// Lesson spec: Monte Carlo simulation: many random futures read as median, bad case and loss odds
import type { LessonSpecInput } from "../../../../../packages/academy/src/schema.ts";

export const spec = {
  caveats: [
    "Its answers are only as good as its assumptions: the 8% return and 20% swings are assumed numbers, not market data.",
    "This chart runs up to 5,000 paths with its own seed (the video used 10,000), so its numbers differ slightly from the video's.",
  ],
  course: "quantfinancetogo",
  formulas: ["gbm", "sqrtTime"],
  kind: "concept",
  params: [
    {
      default: 10_000,
      id: "spot",
      label: "Starting portfolio",
      max: 100_000,
      min: 1000,
      step: 1000,
      unit: "$",
    },
    {
      default: 8,
      id: "drift",
      label: "Average return",
      max: 15,
      min: -5,
      step: 0.5,
      unit: "%",
    },
    {
      default: 20,
      id: "vol",
      label: "Swings (volatility)",
      max: 50,
      min: 1,
      step: 1,
      unit: "%",
    },
    {
      default: 30,
      id: "years",
      label: "Years",
      max: 40,
      min: 1,
      step: 1,
    },
    {
      default: 5000,
      help: "The video used 10,000 runs; this chart runs up to 5,000.",
      id: "paths",
      label: "Runs",
      max: 5000,
      min: 100,
      step: 100,
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
  slug: "monte-carlo-simulation",
  sourceId: "DeO84H5Cho0",
  steps: [
    {
      caption:
        "Assumptions: $10,000 invested for 30 years, 8% average yearly return and 20% yearly volatility.",
      color: "gray",
      element: "axes",
    },
    {
      caption:
        "Every run draws another random scenario and becomes one path. 10,000 runs give 10,000 possible futures that fan out over time.",
      color: "gray",
      element: "paths",
      time: [0, 1],
    },
    {
      caption:
        "The typical outcome, the median: about $61,000 ($60,814 in the video).",
      color: "gold",
      element: "median",
    },
    {
      caption:
        "Bad case: 1 path in 10 ends below about $15,000. Good case: 1 in 10 ends above about $250,000.",
      color: "violet",
      element: "band",
    },
    {
      caption:
        "The average, $111,469 in the video, sits above the median because a few lucky paths pull it up.",
      color: "amber",
      element: "mean",
    },
    {
      caption:
        "Chance of a loss: 1 path in 20 (5%) ends below the $10,000 it started with (red bins).",
      color: "red",
      element: "bars",
    },
    {
      caption:
        "Extra runs sharpen these numbers, though slowly under the square-root rule: 100× the runs buys 10× the precision.",
      color: "violet",
      element: "pdf",
    },
  ],
  summary:
    "A Monte Carlo simulation makes many random assumptions about an uncertain future: each run draws a scenario that becomes a path, and from all paths you read the typical outcome, bad and good cases and the chance of a loss. Example with assumed numbers: $10,000 for 30 years at 8% a year with 20% swings. More runs give more precise numbers, slowly: 100 times the runs, 10 times the precision.",
  tags: {
    instruments: ["portfolio"],
    regime: ["any"],
    risk: "none",
    timeframe: "years",
    topics: ["monte carlo", "simulation", "median", "retirement", "risk"],
  },
  takeaways: [
    "A Monte Carlo simulation turns an uncertain future into numbers: draw many random scenarios and read the typical, bad and good cases and the chance of a loss.",
    "With $10,000, 30 years, 8% a year and 20% swings: median $60,814, 1 in 10 below $14,636, 1 in 10 above $246,456, and a 5% chance of a loss.",
    "The average ($111,469) is above the median because a few lucky paths pull it up.",
    "More runs give more precise numbers by the square root rule: 100 times the runs, 10 times the precision.",
    "Banks can use it to measure how much they could lose in bad times; it also prices complex options and powers retirement planning tools.",
  ],
  title:
    "Monte Carlo simulation: many random futures read as median, bad case and loss odds",
} satisfies LessonSpecInput;
