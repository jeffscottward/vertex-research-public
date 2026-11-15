// Lesson spec: The random walk and its drift: coin flips that look like a stock chart
import type { LessonSpecInput } from "../../../../../packages/academy/src/schema.ts";

export const spec = {
  caveats: [
    "This is just a starting model: real prices move in percentages, go through calm and volatile periods and can jump.",
    "The drift is an expectation; over any stretch of time the random part can still win.",
  ],
  course: "quantfinancetogo",
  formulas: ["randomWalk", "expectedValue", "sqrtTime"],
  kind: "concept",
  params: [
    {
      default: 4000,
      id: "steps",
      label: "Steps",
      max: 5000,
      min: 25,
      step: 25,
      unit: "trades",
    },
    {
      default: 0.027,
      help: "A coin that wins 19 of 37 flips: (19 - 18) / 37 = +0.027 per $1 step. Set 0 for a fair coin.",
      id: "drift",
      label: "Drift per step",
      max: 0.2,
      min: -0.2,
      step: 0.001,
      unit: "$",
    },
    {
      default: 1,
      id: "stepVol",
      label: "Step size",
      max: 10,
      min: 1,
      step: 1,
      unit: "$",
    },
    {
      default: 100,
      id: "start",
      label: "Starting price",
      max: 1000,
      min: 0,
      step: 10,
      unit: "$",
    },
    {
      default: 1000,
      id: "paths",
      label: "Prices",
      max: 1000,
      min: 10,
      step: 10,
    },
    {
      default: 7,
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
  slug: "random-walk-and-drift",
  sourceId: "DdtZ1ILiKRv",
  steps: [
    {
      caption:
        "Each flip is 50-50: heads adds $1 to the price, tails takes $1 away. All walks begin at $100.",
      color: "gray",
      element: "axes",
    },
    {
      caption:
        "1,000 prices walk 4,000 steps each and spread out wildly. In the video a fair walk rallied to $125, crashed to $86 and climbed to $131.",
      color: "gray",
      element: "paths",
      time: [0, 1],
    },
    {
      caption:
        "Give the coin the casino's edge, 19 of 37: +2.7 cents per step. The drift line ends $108 higher after 4,000 steps.",
      color: "green",
      element: "mean",
    },
    {
      caption:
        "Randomness grows only with the square root of the steps, so after about 1,400 steps the drift is bigger than one standard deviation.",
      color: "violet",
      element: "band",
    },
    {
      caption:
        "Where the prices end: 43% were below their start after 25 steps, 20% after 1,000 and only 4% after 4,000 (red bins: below start).",
      color: "red",
      element: "bars",
    },
    {
      caption:
        "The bell around the drift line: the drift decides where prices end up in the long run, while chance wins the short run.",
      color: "violet",
      element: "pdf",
    },
  ],
  summary:
    "A random walk is a sum of coin flips (+$1 heads, -$1 tails) from $100; a fair walk can rally, crash and recover with no memory. A coin with the casino's edge (19 of 37) adds a drift of +2.7 cents per step. Chance wins the short run (43% of prices below their start after 25 steps), but after 4,000 steps only 4% are below: the drift grows with every step, randomness with the square root.",
  tags: {
    instruments: ["single-stock"],
    regime: ["any"],
    risk: "none",
    timeframe: "days",
    topics: ["random walk", "drift", "equity risk premium", "square root rule"],
  },
  takeaways: [
    "Adding up coin flips gives a random walk that can pass for a stock chart; people see trends and crashes even in pure chance.",
    "The drift is the expected value of one step; a coin that wins 19 of 37 flips drifts +2.7 cents per step.",
    "In the short run chance wins: 43% of prices were below their start after 25 steps, 20% after 1,000 and 4% after 4,000.",
    "Drift adds up linearly with the steps, but the randomness grows only with their square root, so the drift takes the lead after about 1,400 steps.",
    "In the simplest stock model the drift is the average return (partly the equity risk premium) and the random steps are the risk.",
  ],
  title:
    "The random walk and its drift: coin flips that look like a stock chart",
} satisfies LessonSpecInput;
