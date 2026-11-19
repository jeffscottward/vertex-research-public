// Lesson spec: Faster Monte Carlo: mirrored paths and a control variate shrink the error bar
import type { LessonSpecInput } from "../../../../../packages/academy/src/schema.ts";

export const spec = {
  caveats: [
    "The model holds volatility and the rate fixed, pays no dividends and prices a European call only.",
    "This chart uses its own seed, so its numbers differ by a cent or two from the video's (13 cents, 6 cents, almost 50,000).",
    "The control coefficient comes from the same sample. With few simulated prices this biases the estimate and makes its error bar too small.",
  ],
  course: "quantfinancetogo",
  formulas: ["antithetic", "controlVariate", "blackScholes"],
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
      default: 0,
      id: "rate",
      label: "Risk-free rate",
      max: 10,
      min: 0,
      step: 0.25,
      unit: "%",
    },
    {
      default: 10_000,
      help: "Every method gets the same number of simulated prices, so only the method differs.",
      id: "paths",
      label: "Simulated prices per method",
      max: 20_000,
      min: 200,
      step: 200,
    },
    {
      default: 54,
      id: "seed",
      label: "Random seed",
      max: 999,
      min: 1,
      step: 1,
    },
  ],
  scene: {
    mode: "varreduce",
    type: "quant",
  },
  slug: "faster-monte-carlo",
  sourceId: "Df4ReEaxOlJ",
  steps: [
    {
      caption:
        "10,000 random prices give a call estimate of $7.91. Its error bar is $0.13: a rerun with new random numbers typically lands that far away.",
      color: "blue",
      element: "plain",
    },
    {
      caption:
        "Mirrored paths: use each draw again with the opposite sign. Same 10,000 prices, but the errors of a pair partly cancel: error bar $0.10.",
      color: "violet",
      element: "mirrored",
    },
    {
      caption:
        "Control variate: the simulated stock averages $99.91, but it must be $100.00. That known miss corrects the call: $7.97, error bar $0.06.",
      color: "green",
      element: "control",
    },
    {
      caption:
        "The exact Black-Scholes price is $7.97. Here each estimate is within one error bar of it; the control variate has the narrowest band.",
      color: "amber",
      element: "bs",
    },
    {
      caption:
        "A plain simulation needs about 48,716 prices for a $0.06 error bar. The control variate has it with 10,000: about a fifth of the work.",
      color: "gold",
      element: "equal",
    },
  ],
  summary:
    "Part 54. A Monte Carlo price is an average of simulated payoffs; halving its error bar takes four times the simulations. Two methods cut the error at equal work: mirrored paths reuse each draw with the opposite sign, and a control variate corrects the estimate with the known average of the stock price. Example: call, stock and strike $100, 20% volatility, one year.",
  tags: {
    instruments: ["single-stock"],
    regime: ["any"],
    risk: "none",
    timeframe: "years",
    topics: [
      "monte carlo",
      "variance reduction",
      "antithetic variates",
      "control variate",
      "black-scholes",
    ],
  },
  takeaways: [
    "The error bar of a Monte Carlo estimate is its standard error. Four times the simulations give only half the error.",
    "Mirrored paths pair each draw with its opposite, so part of a pair's errors cancel: $0.13 becomes $0.10 with the same 10,000 prices.",
    "A control variate is a quantity from the same simulation with a known average. Its miss corrects the option estimate: $0.13 becomes $0.06.",
    "At $0.06 the 10,000 prices are as precise as about 48,716 plain ones, and the estimate of $7.97 matches Black-Scholes.",
    "Both methods help most when the payoff moves closely with the stock price, as it does for a call in the money.",
  ],
  title:
    "Faster Monte Carlo: mirrored paths and a control variate shrink the error bar",
} satisfies LessonSpecInput;
