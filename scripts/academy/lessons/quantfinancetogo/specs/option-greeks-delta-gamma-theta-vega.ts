// Lesson spec: The Greeks: what each one measures for a call option
import type { LessonSpecInput } from "../../../../../packages/academy/src/schema.ts";

export const spec: LessonSpecInput = {
  caveats: [
    "The audio says one day costs about $0.08; the caption and Black-Scholes give about 1.8 cents, which the chart uses.",
    "Each Greek measures one small change with the others held fixed; over large moves the Greeks themselves shift. Rho is not shown.",
  ],
  course: "quantfinancetogo",
  formulas: ["delta", "gamma", "theta", "vega"],
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
  ],
  scene: {
    greek: "gamma",
    legs: [
      {
        dte: "dte",
        kind: "call",
        qty: 1,
        side: "long",
        strike: "strike",
      },
    ],
    type: "greeks",
  },
  slug: "option-greeks-delta-gamma-theta-vega",
  sourceId: "DfCQKtXCuR8",
  steps: [
    {
      caption:
        "The call from Part 33: stock and strike $100, a 5% rate, one year and 20% volatility.",
      color: "cyan",
      element: "spot",
    },
    {
      caption:
        "Delta belongs to the stock price: a $1 rise lifts the call by about 64 cents.",
      color: "blue",
      element: "delta",
    },
    {
      caption:
        "Gamma is one level deeper: 0.0188, so a $1 rise lifts delta from 0.64 to about 0.66. Large gamma, the hedge ages fast.",
      color: "violet",
      element: "gamma",
    },
    {
      caption: "Theta belongs to time: one day costs the call about 1.8 cents.",
      color: "red",
      element: "theta",
      time: [0, 0.8],
    },
    {
      caption:
        "Vega belongs to volatility: one more volatility point adds about 38 cents.",
      color: "cyan",
      element: "vega",
    },
    {
      caption:
        "Gamma, theta and vega all peak near the strike, where the payoff bends.",
      color: "gold",
      element: "strikes",
    },
  ],
  summary:
    "Part 34. An option's value depends on stock price, time to expiry, volatility and the interest rate; each Greek isolates one. Delta and gamma track the stock price, theta tracks time, vega tracks volatility and rho tracks the rate. For the test call (stock and strike 100, 5%, one year, 20%): gamma 0.0188, theta about -1.8 cents a day, vega 38 cents per volatility point, rho 0.53.",
  tags: {
    instruments: ["single-stock"],
    regime: ["any"],
    risk: "defined",
    timeframe: "years",
    topics: ["greeks", "delta", "gamma", "theta", "vega", "rho"],
  },
  takeaways: [
    "Each Greek measures what happens when only one thing changes: stock price, time, volatility or the rate.",
    "Delta and gamma belong to the stock price; gamma is how fast delta changes, so a large gamma makes a delta hedge go out of date quickly.",
    "Theta belongs to time (about -1.8 cents a day here) and vega to volatility (about +38 cents per point).",
    "Rho belongs to the interest rate: about +0.53 per rate point, because a strike paid later is worth less when rates rise.",
    "A position hedged against small stock moves can still lose money through time decay, volatility or rates.",
  ],
  title: "The Greeks: what each one measures for a call option",
};
