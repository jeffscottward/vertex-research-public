// Lesson spec: The volatility smile and skew: why implied volatility bends by strike
import type { LessonSpecInput } from "../../../schema.ts";

export const spec: LessonSpecInput = {
  caveats: [
    "The chart prices the crash market with Merton's jump-diffusion formula instead of the creator's 100,000 simulated years, so the low-strike value differs (about 22% against the creator's 19.9%).",
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
      default: 15,
      help: "Volatility of the stock without crashes.",
      id: "marketVol",
      label: "Calm-day volatility",
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
  slug: "volatility-smile-and-skew",
  sourceId: "DfNAhn7iHRa",
  steps: [
    {
      caption:
        "Black-Scholes call price against volatility at the $100 strike (5%, one year).",
      color: "gold",
      element: "curve",
    },
    {
      caption:
        "Price of that call in a market with 15% volatility and a 1 in 10 yearly chance of a crash of about a quarter.",
      color: "amber",
      element: "market",
    },
    {
      caption:
        "The bisection search from Part 31 turns that price into an implied volatility: about 17.2%.",
      color: "blue",
      element: "guesses",
      time: [0, 1],
    },
    {
      caption:
        "Black-Scholes uses one volatility for every strike: a flat line.",
      color: "gray",
      element: "flat",
    },
    {
      caption:
        "Repeat at every strike from 60 to 140: about 22% at 60 and 15.9% at 140. Crashes make big falls likelier: a skew.",
      color: "violet",
      element: "smile",
    },
  ],
  summary:
    "Part 38. Black-Scholes says implied volatility should be one flat line across strikes. Real markets bend it into a smile, and for index options the low strikes sit much higher: the skew, priced in since the 1987 crash. The test market (15% volatility plus a 1 in 10 yearly chance of a crash of about a quarter) gives about 20% at strike 60, 17.3% at 100 and 15.9% at 140.",
  tags: {
    instruments: ["volatility", "index-options"],
    regime: ["any", "event"],
    risk: "none",
    timeframe: "years",
    topics: [
      "volatility smile",
      "skew",
      "jumps",
      "crash risk",
      "implied volatility",
    ],
  },
  takeaways: [
    "Black-Scholes implies one flat volatility across strikes and expiries; real markets bend it.",
    "Implied volatility often rises at both ends (a smile); for stock indexes the low-strike end is much higher (the skew).",
    "Low-strike puts work as crash insurance, and since the 1987 crash that insurance has cost more than one volatility says.",
    "A model market with rare crashes reproduces the skew; without the crashes the same run gives a flat line near 15%.",
  ],
  title:
    "The volatility smile and skew: why implied volatility bends by strike",
};
