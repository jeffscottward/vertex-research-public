// Lesson spec: Hypothesis testing a strategy: t-statistic and p-value
import type { LessonSpecInput } from "../../../schema.ts";

export const spec = {
  caveats: [
    "Assumes normally distributed Sharpe estimates with standard error 1/√years (no fat tails or autocorrelation).",
    "Two-sided test; a p-value says nothing about the size of the edge.",
    "Not significant does not mean no edge: the video run had a real edge.",
  ],
  course: "quantfinancetogo",
  formulas: ["tStat"],
  kind: "concept",
  params: [
    {
      default: 0.67,
      help: "Annualized Sharpe ratio the strategy showed.",
      id: "sharpe",
      label: "Observed Sharpe ratio",
      max: 3,
      min: -3,
      step: 0.01,
    },
    {
      default: 5,
      help: "Years of data behind the estimate.",
      id: "years",
      label: "Years of data",
      max: 30,
      min: 1,
      step: 0.5,
    },
    {
      default: 5,
      help: "Two-sided significance level (5 means 95% confidence).",
      id: "alpha",
      label: "Significance level",
      max: 10,
      min: 1,
      step: 1,
      unit: "%",
    },
  ],
  scene: { mode: "significance", type: "quant" },
  slug: "sharpe-ratio-hypothesis-test",
  sourceId: "Debex7eiZZu",
  steps: [
    {
      caption:
        "t-statistic ≈ Sharpe × √years: more data makes the same Sharpe more convincing.",
      color: "gold",
      element: "curve",
    },
    {
      caption: "The significance threshold (about t = 2 at the 5% level).",
      color: "amber",
      element: "threshold",
    },
    {
      caption: "The run so far: its t-statistic after this many years of data.",
      color: "blue",
      element: "marker",
      time: [0, 1],
    },
    {
      caption:
        "What estimated Sharpe ratios look like when the true edge is zero.",
      color: "gray",
      element: "pdf",
    },
    {
      caption: "The Sharpe ratio the strategy showed.",
      color: "blue",
      element: "observed",
    },
    {
      caption:
        "p-value: chance under no edge of a result at least this far from zero.",
      color: "red",
      element: "pvalue",
    },
  ],
  summary:
    "Hypothesis testing asks whether a strategy’s profit could be luck. Under the null of no edge, the t-statistic is about the yearly Sharpe ratio times the square root of years, and the p-value is the chance of a result at least that extreme.",
  tags: {
    instruments: ["portfolio"],
    regime: ["any"],
    risk: "none",
    timeframe: "years",
    topics: ["hypothesis testing", "t-statistic", "p-value"],
  },
  takeaways: [
    "t-statistic ≈ yearly Sharpe ratio × √years; with Sharpe 1 you need about four years to reach t = 2.",
    "In the video a real edge showed Sharpe 0.67 over five years: t of 1.5 and p-value 13.3%, not significant at 5%.",
    "Test 100 strategies with no edge and about five pass at the 5% level by luck.",
  ],
  title: "Hypothesis testing a strategy: t-statistic and p-value",
} satisfies LessonSpecInput;
