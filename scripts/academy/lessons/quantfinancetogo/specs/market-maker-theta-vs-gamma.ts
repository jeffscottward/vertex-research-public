// Lesson spec: How a hedged market maker earns: implied vs realized volatility
import type { LessonSpecInput } from "../../../../../packages/academy/src/schema.ts";

export const spec: LessonSpecInput = {
  caveats: [
    "Simplified: one option, Black-Scholes prices, constant volatility, no fees, no dividends, no jumps and no inventory limits.",
    "The ratio curve is the exact expected P&L for these assumptions; the distribution uses a capped number of simulated paths, not the creator's 2,000.",
  ],
  course: "quantfinancetogo",
  formulas: ["gammaPnl", "theta", "gamma", "vega"],
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
      default: 16,
      help: "How much the simulated stock really moves; the call was priced at the implied volatility.",
      id: "realizedVol",
      label: "Realized volatility",
      max: 60,
      min: 5,
      step: 1,
      unit: "%",
    },
    {
      default: 0.1,
      help: "The call is sold at the ask: fair $10.45 plus this amount.",
      id: "spread",
      label: "Sold above fair (half spread)",
      max: 1,
      min: 0,
      step: 0.01,
      unit: "$",
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
      default: 35,
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
  slug: "market-maker-theta-vs-gamma",
  sourceId: "DfF_G7CRae2",
  steps: [
    {
      caption:
        "Short the call at the $10.55 ask (fair $10.45) without a hedge: the result is a bet on the stock.",
      color: "red",
      element: "unhedged",
    },
    {
      caption:
        "Delta hedged daily while the stock moves 16% against 20% implied: every path ends in profit.",
      color: "green",
      element: "hedged",
    },
    {
      caption:
        "Theta is the income, gamma the cost. Calmer than implied, theta wins; wilder, gamma wins and the hedged book loses.",
      color: "gold",
      element: "ratio",
    },
    {
      caption:
        "At 16% realized it earns about $1.67 per call at expiry ($1.59 today, the creator's figure); at 24% it loses about $1.48 at expiry (-$1.41 today).",
      color: "amber",
      element: "marker",
    },
    {
      caption:
        "Hedging more often makes the result more certain; the average still depends on realized against implied volatility.",
      color: "violet",
      element: "std",
    },
  ],
  summary:
    "Part 35. A market maker earns the bid-ask spread and, after delta hedging a call it sold, collects theta while paying gamma: buying high and selling low on every big move. If the stock moves as much as the implied volatility, they cancel. Calmer than implied, it earns; wilder, it loses. Sold at the $10.55 ask with 20% implied: about +$1.59 today ($1.67 at expiry) at 16% realized, -$1.41 at 24%.",
  tags: {
    instruments: ["hedging", "volatility"],
    regime: ["any"],
    risk: "hedged",
    timeframe: "years",
    topics: ["market making", "theta", "gamma", "vega", "bid-ask spread"],
  },
  takeaways: [
    "The first source of money is the spread: buy a little below fair at the bid, sell a little above at the ask.",
    "After delta hedging, theta is the income (the call it owes loses value daily) and gamma is the cost of re-hedging big moves.",
    "If the stock moves exactly as much as the implied volatility, income and cost cancel; calmer it earns, wilder it loses.",
    "Vega threatens this income: if implied volatility jumps, the call the market maker owes gets dearer.",
    "If a customer sells the call instead, everything flips.",
  ],
  title: "How a hedged market maker earns: implied vs realized volatility",
};
