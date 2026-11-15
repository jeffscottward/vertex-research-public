// Lesson spec: Delta hedging: hold delta shares against a short call and rebalance
import type { LessonSpecInput } from "../../../../../packages/academy/src/schema.ts";

export const spec: LessonSpecInput = {
  caveats: [
    "Constant volatility, no trading costs, no dividends and no jumps; real hedging adds costs and jumps the model does not see.",
    "The chart caps its simulation for speed (118 paths when hedging daily), so its spreads differ slightly from the creator's 2,000 paths.",
  ],
  course: "quantfinancetogo",
  formulas: ["delta", "blackScholes"],
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
      default: 5,
      id: "rate",
      label: "Risk-free rate",
      max: 10,
      min: 0,
      step: 0.25,
      unit: "%",
    },
    {
      default: 20,
      id: "iv",
      label: "Implied volatility",
      max: 100,
      min: 5,
      step: 1,
      unit: "%",
    },
    {
      default: 20,
      help: "How much the simulated stock really moves.",
      id: "realizedVol",
      label: "Realized volatility",
      max: 60,
      min: 5,
      step: 1,
      unit: "%",
    },
    {
      default: 252,
      help: "252 = once per trading day.",
      id: "rebalances",
      label: "Rebalances over the year",
      max: 252,
      min: 1,
      step: 1,
      unit: "trades",
    },
    {
      default: 2000,
      help: "Capped so the chart spends at most about 60,000 Black-Scholes evaluations (118 paths when hedging daily).",
      id: "paths",
      label: "Simulated paths",
      max: 5000,
      min: 20,
      step: 10,
    },
    {
      default: 33,
      id: "seed",
      label: "Random seed",
      max: 999,
      min: 1,
      step: 1,
    },
  ],
  scene: {
    mode: "hedge",
    type: "quant",
  },
  slug: "delta-hedging-a-short-call",
  sourceId: "De9QTG2iGeJ",
  steps: [
    {
      caption:
        "Sell the call and do nothing: the P&L at expiry spreads over tens of dollars (creator: $15.39 standard deviation).",
      color: "red",
      element: "unhedged",
    },
    {
      caption:
        "Hold delta shares (0.64 at the start) and rebalance daily: the spread collapses to about $0.4 (creator: $0.44).",
      color: "green",
      element: "hedged",
    },
    {
      caption:
        "Delta changes whenever the stock moves, so a hedge left alone goes out of date. More rebalances, smaller spread.",
      color: "violet",
      element: "std",
    },
    {
      caption: "Daily rebalancing, 252 times a year, is the creator's setup.",
      color: "amber",
      element: "marker",
    },
  ],
  summary:
    "Part 33. Delta is how much an option moves when the stock moves $1; for the test call (stock and strike 100, 5%, one year, 20%) it is 0.64. A market maker who sold the call buys 0.64 shares, so small moves cancel (delta neutral). Delta changes as the stock moves, so the shares are rebalanced again and again. Daily hedging shrinks the P&L spread from about $15 to about $0.44.",
  tags: {
    instruments: ["hedging"],
    regime: ["any"],
    risk: "hedged",
    timeframe: "years",
    topics: ["delta", "delta hedging", "market making", "rebalancing"],
  },
  takeaways: [
    "Delta is how much the option moves when the stock moves $1; for a call it is N(d1), between 0 and 1.",
    "The test call (stock and strike 100, 5%, one year, 20%) costs $10.45 and has a delta of 0.64.",
    "A market maker short the call holds 0.64 shares, so small moves cancel: delta neutral.",
    "Delta changes as the stock moves, so the hedge is rebalanced again and again.",
    "Daily hedging over 2,000 simulated years: spread about $0.44 hedged against $15.39 unhedged (creator's run).",
  ],
  title: "Delta hedging: hold delta shares against a short call and rebalance",
};
