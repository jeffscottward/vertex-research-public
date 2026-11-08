// Lesson spec: Correlation: how two assets move together and what it does to risk
import type { LessonSpecInput } from "../../../schema.ts";

export const spec = {
  course: "quantfinancetogo",
  slug: "correlation-and-portfolio-risk",
  sourceId: "Dd8m63oq2-c",
  title: "Correlation: how two assets move together and what it does to risk",
  summary:
    "Part 10 of Quant Finance from scratch. Correlation is one number between −1 and +1 for how two assets move together: the average product of their moves measured in typical swings. It does not show cause, and it sets how risky a mix of the two is.",
  kind: "concept",
  tags: {
    regime: ["any"],
    instruments: ["portfolio"],
    timeframe: "years",
    risk: "none",
    topics: ["correlation", "diversification", "risk"],
  },
  scene: { type: "quant", mode: "diversify" },
  params: [
    {
      id: "rho",
      label: "Correlation",
      default: 0.8,
      min: -1,
      max: 1,
      step: 0.05,
    },
    {
      id: "vol",
      label: "Volatility of each asset",
      default: 20,
      min: 1,
      max: 80,
      step: 1,
      unit: "%",
    },
    {
      id: "seed",
      label: "Random days",
      default: 10,
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
        "Each dot will be one simulated day: asset A's move across, asset B's move up. Each asset swings 20% a year.",
    },
    {
      element: "points",
      color: "cyan",
      caption:
        "A hidden market gives both the same push each day, and each gets its own push. The cloud stretches along a rising line.",
      time: [0, 1],
    },
    {
      element: "points",
      color: "cyan",
      caption:
        "Put each move in typical swings, multiply the two moves of each day and average: same way counts plus, apart minus.",
    },
    {
      element: "mix",
      color: "violet",
      caption:
        "Half the money in each: the mix swings 19.0% at +0.80, 14.1% at 0 and 10.0% at −0.50, while each asset swings 20%.",
    },
    {
      element: "marker",
      color: "amber",
      caption:
        "The dot marks the chosen correlation. At +1 the points sit on a rising line, at −1 on a falling line, at 0 the cloud is round.",
    },
  ],
  formulas: ["correlation", "portfolioVariance"],
  takeaways: [
    "Correlation always lands between −1 and +1: the average product of two assets' standardized moves.",
    "Correlation never tells you which one causes the other; here a hidden market moves both.",
    "The lower the correlation, the less a 50/50 mix swings: 19.0% at +0.80, 14.1% at 0, 10.0% at −0.50.",
  ],
  caveats: [
    "Correlations measured in calm times can rise when markets fall (Longin and Solnik, 2001).",
    "Simulated normal daily returns from one hidden market factor; each run's measured correlation differs a little from the built-in value.",
    "Both assets have the same volatility; the 50/50 numbers in the captions are the formula's values for the reel's inputs.",
  ],
} satisfies LessonSpecInput;
