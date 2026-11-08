// Lesson spec: Implied volatility: solve Black-Scholes backwards from the market price
import type { LessonSpecInput } from "../../../schema.ts";

export const spec: LessonSpecInput = {
  caveats: [
    "The smile panel is an illustration: a jump-diffusion market (calm volatility plus rare crashes), shifted to pass through the 24.1% of the test run. It is not market data, as the creator also notes.",
  ],
  course: "quantfinancetogo",
  formulas: ["impliedVol", "blackScholes"],
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
      default: 12,
      help: "The price the call trades at. The chart solves Black-Scholes backwards for the volatility that gives this price.",
      id: "marketPrice",
      label: "Market price of the call",
      max: 60,
      min: 0.5,
      step: 0.05,
      unit: "$",
    },
    {
      default: 15,
      help: "Volatility without crashes in the illustrative market that shapes the smile panel.",
      id: "marketVol",
      label: "Calm-day volatility (smile)",
      max: 60,
      min: 5,
      step: 1,
      unit: "%",
    },
    {
      default: 0.1,
      help: "Average number of jumps per year (0.1 = a 1 in 10 chance each year). 0 removes the crashes.",
      id: "jumpIntensity",
      label: "Crashes per year",
      max: 1,
      min: 0,
      step: 0.05,
    },
    {
      default: -25,
      help: "Median crash size as a simple return (-25% = a 25% drop). Jump sizes are lognormal, so their average is slightly above this median.",
      id: "jumpMedian",
      label: "Median jump",
      max: 20,
      min: -60,
      step: 1,
      unit: "%",
    },
    {
      default: 5,
      id: "jumpVol",
      label: "Jump size spread",
      max: 30,
      min: 0,
      step: 1,
      unit: "%",
    },
  ],
  scene: {
    mode: "smile",
    type: "quant",
  },
  slug: "implied-volatility-by-bisection",
  sourceId: "De4D23VCl2E",
  steps: [
    {
      caption:
        "Black-Scholes price of the call against volatility: stock and strike $100, 5%, one year. More volatility, higher price.",
      color: "gold",
      element: "curve",
    },
    {
      caption:
        "The market price comes from supply and demand: this call trades at $12.",
      color: "amber",
      element: "market",
    },
    {
      caption:
        "Bisection tries 50%, 25%, 12.5%... and keeps the half that brackets $12. After 10 steps the price fits to half a cent: 24.1%.",
      color: "blue",
      element: "guesses",
      time: [0, 1],
    },
    {
      caption:
        "One option gives one implied volatility. Black-Scholes would use the same 24.1% at every strike.",
      color: "gray",
      element: "flat",
    },
    {
      caption:
        "In practice each strike has its own. Crash protection at low strikes is in demand, so it implies more volatility.",
      color: "violet",
      element: "smile",
    },
  ],
  summary:
    "Part 31. Four Black-Scholes inputs can be looked up, but volatility lies in the future. Put the market price into the formula and solve backwards: that volatility is the implied volatility. Because the price always rises with volatility, a bisection search finds it; a $12 call (stock and strike 100, 5%, one year) implies 24.1%. Each strike and expiry has its own implied volatility.",
  tags: {
    instruments: ["volatility", "index-options"],
    regime: ["any"],
    risk: "none",
    timeframe: "years",
    topics: ["implied volatility", "bisection", "black-scholes", "smile"],
  },
  takeaways: [
    "Implied volatility is the volatility that makes Black-Scholes return the option's market price.",
    "There is no formula for it, but the price always rises with volatility, so bisection finds it: a $12 call implies 24.1%.",
    "When traders pay more for an option, its implied volatility rises.",
    "Every strike and expiry has its own implied volatility; together they form the implied volatility surface.",
    "Historical volatility from past returns is the comparison, and the estimate when no options trade.",
  ],
  title:
    "Implied volatility: solve Black-Scholes backwards from the market price",
};
