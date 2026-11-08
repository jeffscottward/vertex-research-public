// Lesson spec: The Black-Scholes formula prices a call from five inputs
import type { LessonSpecInput } from "../../../../../packages/academy/src/schema.ts";

export const spec: LessonSpecInput = {
  caveats: [
    "The chart shows profit and loss of one contract (100 shares) bought at the Black-Scholes price; the creator's numbers are per share.",
  ],
  course: "quantfinancetogo",
  formulas: ["blackScholes", "breakevenCall"],
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
      default: 4,
      id: "rate",
      label: "Risk-free rate",
      max: 10,
      min: 0,
      step: 0.25,
      unit: "%",
    },
  ],
  scene: {
    legs: [
      {
        dte: "dte",
        kind: "call",
        qty: 1,
        side: "long",
        strike: "strike",
      },
    ],
    type: "payoff",
    view: "2d",
  },
  slug: "black-scholes-call-price",
  sourceId: "Dey6117Chzb",
  steps: [
    {
      caption:
        "Five inputs: stock $100, strike $100, one year, a 4% rate and 20% volatility.",
      color: "cyan",
      element: "spot",
    },
    {
      caption:
        "The call is the right to buy at the $100 strike on the expiry date.",
      color: "violet",
      element: "strikes",
    },
    {
      caption:
        "At expiry it pays the stock minus the strike, or nothing. Black-Scholes prices it at $9.93 today: 61.79 - 51.87.",
      color: "gold",
      element: "expiry",
    },
    {
      caption:
        "Before expiry the formula gives a smooth value at every stock price. Watch it fold into the payoff as time runs out.",
      color: "blue",
      element: "now",
      time: [0, 1],
    },
    {
      caption:
        "At expiry the buyer breaks even at the strike plus the $9.93 premium.",
      color: "amber",
      element: "breakeven",
    },
    {
      caption: "The most the buyer can lose is the premium.",
      color: "red",
      element: "maxLoss",
    },
  ],
  summary:
    "Part 30 of the series. A call pays whatever the stock ends above the strike. Black-Scholes prices it from the stock price, strike, risk-free rate, time to expiry and volatility: C = S N(d1) - K e^(-rT) N(d2). The test run (stock and strike 100, one year, 4%, 20%) gives $9.93, and a Monte Carlo check gives $9.92. The stock's expected return never appears.",
  tags: {
    instruments: ["single-stock"],
    regime: ["any"],
    risk: "defined",
    timeframe: "years",
    topics: ["black-scholes", "option pricing", "volatility"],
  },
  takeaways: [
    "C = S N(d1) - K e^(-rT) N(d2), with d1 = [ln(S/K) + (r + σ²/2)T] / (σ√T) and d2 = d1 - σ√T.",
    "The test run gives d1 = 0.3, d2 = 0.1 and a price of $9.93; one million Monte Carlo paths give $9.92.",
    "The same call costs $4.49 with three months left and $15.08 with two years left.",
    "The stock's expected return is not an input, because stock and cash can copy the option.",
    "The formula assumes constant volatility and no jumps. Solving it backwards from market prices gives a different volatility per strike (the smile).",
  ],
  title: "The Black-Scholes formula prices a call from five inputs",
};
