// Lesson spec: Sharpe ratio: extra return per unit of risk
import type { LessonSpecInput } from "../../../schema.ts";

export const spec = {
  course: "quantfinancetogo",
  slug: "sharpe-ratio-return-per-unit-of-risk",
  sourceId: "Dd4puohxGZj",
  title: "Sharpe ratio: extra return per unit of risk",
  summary:
    "Part 8 of Quant Finance from scratch. Subtract the safe rate from an investment's return and divide by its volatility: the Sharpe ratio. A wild investment (12% at 24% risk) against a calm one (6% at 3%) shows that twice the return for eight times the risk is a bad deal here.",
  kind: "concept",
  tags: {
    regime: ["any"],
    instruments: ["portfolio"],
    timeframe: "years",
    risk: "none",
    topics: ["sharpe ratio", "risk", "volatility"],
  },
  scene: { type: "quant", mode: "frontier" },
  params: [
    {
      id: "retA",
      label: "Calm one: return a year",
      default: 6,
      min: -20,
      max: 40,
      step: 0.5,
      unit: "%",
    },
    {
      id: "volA",
      label: "Calm one: volatility",
      default: 3,
      min: 0.5,
      max: 60,
      step: 0.5,
      unit: "%",
    },
    {
      id: "retB",
      label: "Wild one: return a year",
      default: 12,
      min: -20,
      max: 40,
      step: 0.5,
      unit: "%",
    },
    {
      id: "volB",
      label: "Wild one: volatility",
      default: 24,
      min: 0.5,
      max: 60,
      step: 0.5,
      unit: "%",
    },
    {
      id: "retC",
      label: "Return the wild one would need",
      default: 27,
      min: -20,
      max: 60,
      step: 0.5,
      unit: "%",
    },
    {
      id: "volC",
      label: "Its volatility",
      default: 24,
      min: 0.5,
      max: 60,
      step: 0.5,
      unit: "%",
    },
    {
      id: "rf",
      label: "Safe rate",
      default: 3,
      min: 0,
      max: 10,
      step: 0.25,
      unit: "%",
    },
    {
      id: "rho",
      label: "Correlation between them",
      default: 0,
      min: -1,
      max: 1,
      step: 0.05,
    },
    {
      id: "seed",
      label: "Random mixes",
      default: 8,
      min: 1,
      max: 999,
      step: 1,
    },
  ],
  steps: [
    {
      element: "axes",
      color: "gray",
      caption:
        "Risk across (volatility, % a year), expected return up. Assumed numbers from the reel, not forecasts.",
    },
    {
      element: "rf",
      color: "amber",
      caption:
        "A safe account pays 3% a year without any risk. Only the return above it is the reward for taking risk.",
    },
    {
      element: "assets",
      color: "blue",
      caption:
        "A is the calm one, 6% at 3% risk. B is the wild one, 12% at 24%: twice the return for eight times the risk.",
    },
    {
      element: "lines",
      color: "gold",
      caption:
        "Each line runs from the safe rate through an asset. Its slope is the Sharpe ratio: (return − safe rate) / volatility.",
    },
    {
      element: "lines",
      color: "gold",
      caption:
        "One eighth in B, the rest in cash, swings 3% like A but earns only about 4%. Mixing with cash just slides along B's line.",
    },
    {
      element: "assets",
      color: "blue",
      caption:
        "C sits on A's line at 24% risk: the wild one would need about 27% a year to be as good a deal as the calm one.",
    },
  ],
  formulas: ["sharpe"],
  takeaways: [
    "Sharpe ratio = (return − safe rate) / volatility: the extra return you get for every unit of risk.",
    "Mixing an investment with cash never changes its Sharpe ratio, so the ratio measures the investment itself.",
    "In the reel the calm one pays almost three times as much per unit of risk as the wild one.",
  ],
  caveats: [
    "The chart uses the assumed inputs (Sharpe 1.00 and 0.38); the creator's 10,000 simulated years measured 0.99 and 0.36.",
    "The Sharpe ratio treats swings up and down the same; a strategy with rare big crashes can look better than it is until the crash comes.",
    "Returns and volatilities are fixed assumptions here; real ones have to be estimated and change over time.",
  ],
} satisfies LessonSpecInput;
