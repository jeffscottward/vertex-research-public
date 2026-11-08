// Lesson spec: The bell curve: why sums of random steps always build the normal distribution
import type { LessonSpecInput } from "../../../schema.ts";

export const spec = {
  caveats: [
    "Real returns have fat tails: big crashes come far more often than the bell says.",
  ],
  course: "quantfinancetogo",
  formulas: ["normalPdf", "sqrtTime", "randomWalk"],
  kind: "concept",
  params: [
    {
      default: 400,
      id: "steps",
      label: "Steps per walk",
      max: 2000,
      min: 12,
      step: 4,
      unit: "trades",
    },
    {
      default: "coin",
      help: "Coin: +size or -size. Uniform: any amount in an even range with the same spread. The bell appears either way (central limit theorem).",
      id: "shape",
      kind: "select",
      label: "Step shape",
      options: ["coin", "uniform", "normal"],
    },
    {
      default: 1,
      id: "stepVol",
      label: "Step size (spread)",
      max: 5,
      min: 0.1,
      step: 0.1,
      unit: "$",
    },
    {
      default: 0,
      id: "drift",
      label: "Drift per step",
      max: 0.1,
      min: -0.1,
      step: 0.001,
      unit: "$",
    },
    {
      default: 1000,
      id: "paths",
      label: "Walks",
      max: 1000,
      min: 10,
      step: 10,
    },
    {
      default: 4,
      help: "Same seed, same paths; change it to draw another run.",
      id: "seed",
      label: "Random seed",
      max: 999,
      min: 1,
      step: 1,
    },
  ],
  scene: {
    mode: "walk",
    type: "quant",
  },
  slug: "bell-curve-central-limit-theorem",
  sourceId: "Ddyk2PkqdRy",
  steps: [
    {
      caption:
        "Each ball on a 12-row pin board bounces right or left like a coin flip: a random walk. 924 of the 4,096 paths go right exactly 6 times.",
      color: "gray",
      element: "axes",
    },
    {
      caption: "The 1,000 walks from part 3 take 400 coin-flip steps each.",
      color: "gray",
      element: "paths",
      time: [0, 1],
    },
    {
      caption:
        "Where they end builds the bell: far more paths lead to the middle than to the edges (red bins: below the start).",
      color: "red",
      element: "bars",
    },
    {
      caption:
        "The normal curve with spread √400 = 20 fits the counts (the video measured 19.9). Uniform steps build the same bell: the central limit theorem.",
      color: "violet",
      element: "pdf",
    },
    {
      caption:
        "About 68% of results land within one standard deviation of the middle, 95% within two and 99.7% within three.",
      color: "violet",
      element: "band",
    },
  ],
  summary:
    "Random steps always build the same bell because far more paths lead to the middle than to the edges: 924 of 4,096 twelve-row pin-board paths land in the middle bin. Coin flips, 400-step walks and sums of uniform amounts all give the bell (central limit theorem): about 68% of results within one standard deviation, 95% within two, 99.7% within three. Quants use it to size a stock's yearly move.",
  tags: {
    instruments: ["volatility"],
    regime: ["any"],
    risk: "none",
    timeframe: "years",
    topics: [
      "bell curve",
      "normal distribution",
      "central limit",
      "standard deviation",
    ],
  },
  takeaways: [
    "Random steps build the bell because far more paths lead to the middle than to the edges: 924 of 4,096 twelve-row paths land in the middle.",
    "The steps need not be coin flips: adding up 100 random amounts between -1 and +1 builds the same bell (the central limit theorem).",
    "About 68% of results land within one standard deviation, 95% within two and 99.7% within three.",
    "A stock that swings 16% a year ends within 16% in about 2 years out of 3 and within 32% in 19 out of 20; the bell puts a move beyond 48% at once in about 370 years.",
  ],
  title:
    "The bell curve: why sums of random steps always build the normal distribution",
} satisfies LessonSpecInput;
