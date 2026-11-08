// Lesson spec: Binomial tree pricing: walk back through up and down steps
import type { LessonSpecInput } from "../../../schema.ts";

export const spec: LessonSpecInput = {
  caveats: [
    "Constant volatility and rate, no fees, trading at every step; real prices do not move in fixed steps. The chart prices European calls only.",
  ],
  course: "quantfinancetogo",
  formulas: ["binomialTree", "blackScholes"],
  kind: "concept",
  params: [
    {
      default: 100,
      id: "spot",
      label: "Stock price",
      max: 1000,
      min: 10,
      step: 1,
      unit: "$",
    },
    {
      default: 100,
      id: "strike",
      label: "Strike",
      max: 1000,
      min: 10,
      step: 1,
      unit: "$",
    },
    {
      default: 365,
      id: "dte",
      label: "Days to expiry",
      max: 1095,
      min: 7,
      step: 1,
      unit: "days",
    },
    {
      default: 20,
      id: "iv",
      label: "Volatility",
      max: 100,
      min: 5,
      step: 1,
      unit: "%",
    },
    {
      default: 5,
      id: "rate",
      label: "Risk-free rate",
      max: 10,
      min: 0,
      step: 0.25,
      unit: "%",
    },
    {
      default: 1,
      help: "Start with one step, then add more. The chart draws the first 8 steps; the price uses all of them.",
      id: "steps",
      label: "Steps in the tree",
      max: 250,
      min: 1,
      step: 1,
    },
  ],
  scene: {
    mode: "binomial",
    type: "quant",
  },
  slug: "binomial-tree-option-pricing",
  sourceId: "DfK1oP4IkLF",
  steps: [
    {
      caption:
        "Each step moves the stock up or down by e^(±σ√Δt). One yearly step: $100 goes to $122.14 or $81.87.",
      color: "blue",
      element: "tree",
    },
    {
      caption:
        "Weights of 58% up and 42% down make the stock grow like cash at 5%. They price the call too: one step gives $12.16.",
      color: "blue",
      element: "tree",
    },
    {
      caption:
        "Walk back through bigger trees: $12.16 with 1 step, $9.54 with 2, $11.04 with 3, $10.25 with 10.",
      color: "gold",
      element: "price",
    },
    {
      caption:
        "The price zigzags toward Black-Scholes, $10.45; 1,000 steps give $10.45 too.",
      color: "amber",
      element: "bs",
    },
  ],
  summary:
    "Part 37. In the Cox-Ross-Rubinstein model the stock steps up or down by a factor set by volatility. Risk-neutral weights make the stock grow like money in the bank (58% up, 42% down for one yearly step at 5% and 20%), and they also price the call: $12.16 with one step. With more steps the price zigzags to the Black-Scholes $10.45. The tree can also price American options.",
  tags: {
    instruments: ["single-stock"],
    regime: ["any"],
    risk: "none",
    timeframe: "years",
    topics: [
      "binomial model",
      "risk-neutral",
      "cox-ross-rubinstein",
      "black-scholes",
    ],
  },
  takeaways: [
    "The stock moves in steps, each up or down by a fixed factor that comes from the volatility.",
    "Risk-neutral weights make the stock grow like money in the bank; the real chance of an up move never matters.",
    "Each node is worth the discounted weighted average of the two nodes after it; walking back gives today's price.",
    "With more steps the tree price converges to Black-Scholes: $12.16, $9.54, $11.04, then $10.25 with 10 and $10.45 with 1,000 steps.",
    "The tree can price American options (a put: $6.09 against $5.57 European), which the formula cannot.",
  ],
  title: "Binomial tree pricing: walk back through up and down steps",
};
