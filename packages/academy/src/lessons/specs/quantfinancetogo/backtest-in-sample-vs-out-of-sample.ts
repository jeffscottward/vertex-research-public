// Lesson spec: Backtesting: in-sample winners fail out of sample
import type { LessonSpecInput } from "../../../schema.ts";

export const spec = {
  caveats: [
    "Simulated data with no edge; Sharpe estimates are drawn from a normal sampling distribution, not full backtests.",
    "The video reports returns (+11%, −28%); this chart shows Sharpe ratios, so its numbers differ.",
    "Costs, look-ahead and survivorship bias are not modeled.",
  ],
  course: "quantfinancetogo",
  formulas: ["dataSnooping", "tStat"],
  kind: "concept",
  params: [
    {
      default: 498,
      help: "How many zero-edge rules are tried.",
      id: "rules",
      label: "Rules tested",
      max: 2000,
      min: 1,
      step: 1,
    },
    {
      default: 5,
      help: "Length of each in-sample and out-of-sample period.",
      id: "years",
      label: "Years per sample",
      max: 30,
      min: 1,
      step: 1,
    },
    {
      default: 7,
      help: "Changes the simulated random rules.",
      id: "seed",
      label: "Random seed",
      max: 999,
      min: 1,
      step: 1,
    },
  ],
  scene: { mode: "snooping", type: "quant" },
  slug: "backtest-in-sample-vs-out-of-sample",
  sourceId: "DeWlPe2id2c",
  steps: [
    {
      caption: "Axes: the chart frame for this lesson.",
      color: "gray",
      element: "axes",
    },
    {
      caption: "Zero-edge market: every one of the rules is pure noise.",
      color: "gray",
      element: "axes",
    },
    {
      caption:
        "Expected best Sharpe grows like √(2 ln N) as more rules are tried.",
      color: "gold",
      element: "curve",
    },
    {
      caption: "Best simulated result after each batch of rules tested.",
      color: "amber",
      element: "best",
      time: [0, 1],
    },
    {
      caption: "The best rule found so far among the rules tested.",
      color: "red",
      element: "marker",
    },
    {
      caption: "Each dot: one rule, in-sample vs out-of-sample Sharpe.",
      color: "blue",
      element: "points",
    },
    {
      caption: "No relation: out-of-sample results scatter around zero.",
      color: "gray",
      element: "zero",
    },
  ],
  summary:
    "A backtest builds a rule on in-sample data and judges it on later out-of-sample data. Searching many rules finds patterns even in pure noise, so the best in-sample rule tends to fail out of sample.",
  tags: {
    instruments: ["portfolio"],
    regime: ["any"],
    risk: "none",
    timeframe: "years",
    topics: ["backtesting", "data mining", "overfitting"],
  },
  takeaways: [
    "Build a rule in sample, then judge it on data it has never seen.",
    "Trying rule after rule finds patterns even in noise: in the video the best of 498 rules made 11% in sample and lost 28% out of sample.",
    "A backtest only tells the truth without look-ahead bias, with survivorship-free data and with costs.",
  ],
  title: "Backtesting: in-sample winners fail out of sample",
} satisfies LessonSpecInput;
