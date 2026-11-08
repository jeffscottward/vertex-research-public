// Lesson spec: Pairs trading: trade the spread between two stocks that share a common trend
import type { LessonSpecInput } from "../../../../../packages/academy/src/schema.ts";

export const spec = {
  caveats: [
    "Simulated pair: the hedge ratio is known and the spread is built to snap back. In real pairs the ratio has to be estimated and the common trend can break for good.",
    "Costs are a flat charge in bps of both legs' notional at every entry and exit; borrow fees on the short leg, financing and slippage are left out.",
    "The reel shows no numbers; the chart's P&L comes from illustrative inputs and one seeded path, not market data.",
  ],
  course: "quantfinancetogo",
  formulas: ["zScore", "ornsteinUhlenbeck"],
  kind: "concept",
  params: [
    {
      default: 10,
      help: "Days for half of a gap in the spread to close; shorter means a stronger snap back.",
      id: "halfLife",
      label: "Spread half-life",
      max: 250,
      min: 1,
      step: 1,
      unit: "days",
    },
    {
      default: 2,
      help: "How stretched the spread must be (in standard deviations) before the rule trades.",
      id: "entryZ",
      label: "Entry z-score",
      max: 5,
      min: 0.25,
      step: 0.25,
    },
    {
      default: 0.5,
      help: "Both legs are closed once the z-score is back inside this level.",
      id: "exitZ",
      label: "Exit z-score",
      max: 3,
      min: 0,
      step: 0.25,
    },
    {
      default: 30,
      help: "Days of spread history behind the average and standard deviation of the z-score.",
      id: "lookback",
      label: "Lookback",
      max: 120,
      min: 5,
      step: 1,
      unit: "days",
    },
    {
      default: 5,
      help: "Trading costs in basis points of the notional of both legs, charged at entry and exit.",
      id: "costBps",
      label: "Costs (bps)",
      max: 200,
      min: 0,
      step: 1,
    },
    {
      default: 250,
      id: "days",
      label: "Days simulated",
      max: 1000,
      min: 60,
      step: 10,
      unit: "days",
    },
    {
      default: 7,
      help: "Same seed, same prices; change it to draw another pair.",
      id: "seed",
      label: "Random seed",
      max: 999,
      min: 1,
      step: 1,
    },
  ],
  scene: {
    mode: "pairs",
    type: "quant",
  },
  slug: "pairs-trading-spread-z-score",
  sourceId: "Dc9OSjTRNlf",
  steps: [
    {
      caption:
        "Two simulated stocks over 250 trading days. You do not need to know where the market goes to trade them.",
      color: "gray",
      element: "axes",
    },
    {
      caption: "Stock a wanders like any stock price.",
      color: "cyan",
      element: "a",
    },
    {
      caption:
        "Stock b shares its trend: here b is 1.2 times a plus a spread that keeps getting pulled back.",
      color: "blue",
      element: "b",
    },
    {
      caption:
        "The spread behaves like a rubber band. Its z-score shows how far it is stretched compared with the last 30 days.",
      color: "violet",
      element: "zscore",
    },
    {
      caption:
        "When the gap is extreme (beyond ±2), short the expensive stock and buy the cheap one.",
      color: "amber",
      element: "entry",
    },
    {
      caption: "Close both when the spread returns to normal, inside ±0.5.",
      color: "cyan",
      element: "exit",
    },
    {
      caption:
        "The shaded bands are open positions; the dots mark each entry and exit.",
      color: "gold",
      element: "trades",
      time: [0, 1],
    },
    {
      caption:
        "The curve below is the profit adding up trade by trade, after trading costs.",
      color: "green",
      element: "pnl",
    },
  ],
  summary:
    "Pairs trading needs no view on where the market goes. Two stocks that share a common trend form a spread that behaves like a rubber band: stretch it far enough and it snaps back. The strategy shorts the expensive stock and buys the cheap one when the gap is extreme, and closes both when it returns to normal.",
  tags: {
    instruments: ["single-stock"],
    regime: ["range"],
    risk: "none",
    timeframe: "days",
    topics: [
      "pairs trading",
      "mean reversion",
      "z-score",
      "statistical arbitrage",
      "spread",
    ],
  },
  takeaways: [
    "Two stocks with a common trend form a spread that tends to snap back like a rubber band.",
    "The rule is that and nothing more: short the expensive one and buy the cheap one when the gap is extreme, close both when it is back to normal.",
    "The trade does not depend on the market's direction, only on the gap between the two stocks closing.",
    "Profit adds up trade by trade, and every entry and exit pays costs, so a rule that trades too often can give the edge away.",
  ],
  title:
    "Pairs trading: trade the spread between two stocks that share a trend",
} satisfies LessonSpecInput;
