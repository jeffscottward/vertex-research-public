// Lesson spec: Put-call parity: a call minus a put equals the stock minus the strike's present value
import type { LessonSpecInput } from "../../../../../packages/academy/src/schema.ts";

export const spec: LessonSpecInput = {
  caveats: [
    "The video explains the pricing identity, not a trade to place, so this lesson has no backtest. The chart shows one contract (100 shares).",
  ],
  course: "quantfinancetogo",
  formulas: ["putCallParity", "blackScholes"],
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
      default: 365,
      help: "How long the stock side is held on the chart; keep it equal to the days to expiry.",
      id: "days",
      label: "Stock holding period",
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
  ],
  scene: {
    a: {
      label: "Long call + short put",
      legs: [
        {
          dte: "dte",
          kind: "call",
          qty: 1,
          side: "long",
          strike: "strike",
        },
        {
          dte: "dte",
          kind: "put",
          qty: 1,
          side: "short",
          strike: "strike",
        },
      ],
    },
    b: {
      label: "Long 100 shares",
      legs: [
        {
          kind: "stock",
          qty: 1,
          side: "long",
        },
      ],
    },
    type: "compare",
  },
  slug: "put-call-parity-call-minus-put",
  sourceId: "De6k6pexwag",
  steps: [
    {
      caption:
        "Inputs: a $100 stock, a $100 strike, 20% volatility, a 5% rate and one year to expiry.",
      color: "cyan",
      element: "spot",
    },
    {
      caption:
        "Buy the $100 call ($10.45) and sell the $100 put ($5.57). Above the strike you use the call; below it the put is used against you.",
      color: "gold",
      element: "a",
    },
    {
      caption:
        "Either way you end up buying the stock at $100. The P&L is a straight line, like owning the stock.",
      color: "blue",
      element: "b",
    },
    {
      caption:
        "The gap is the same at every price and reaches $4.88 a share at expiry: 100 - 95.12, the interest on a strike paid later.",
      color: "violet",
      element: "diff",
      time: [0, 1],
    },
    {
      caption:
        "The pair breaks even at the strike plus the $4.88 net premium; the stock at its $100 entry.",
      color: "amber",
      element: "breakeven",
    },
  ],
  summary:
    "Part 32. A long call and a short put at the same strike and expiry together guarantee buying the stock at the strike. That certain purchase is worth today's stock price less the present value of the strike, so C - P = S - K e^(-rT). With stock and strike at 100, 5% and one year, the call is $10.45, the put $5.57, and their $4.88 difference matches 100 - 95.12. Traders use it to check quotes.",
  tags: {
    instruments: ["synthetics", "single-stock"],
    regime: ["any"],
    risk: "stock-like",
    timeframe: "years",
    topics: [
      "put-call parity",
      "synthetic stock",
      "arbitrage",
      "black-scholes",
    ],
  },
  takeaways: [
    "A long call plus a short put with the same strike and expiry buys the stock at the strike on that date, whatever happens.",
    "Call minus put equals the stock minus the present value of the strike: 10.45 - 5.57 = 100 - 95.12 = 4.88.",
    "No stock model is needed, which is why traders use the identity to check quotes and to convert a call price into a put price.",
    "When quotes violate it, traders can earn a riskless profit until prices line up again.",
    "It holds exactly for European options on stocks without dividends; American options and dividends change it.",
  ],
  title:
    "Put-call parity: a call minus a put equals the stock minus the strike's present value",
};
