// Lesson spec: Diversification: less risk, down to the market's floor
import type { LessonSpecInput } from "../../../../../packages/academy/src/schema.ts";

export const spec = {
  course: "quantfinancetogo",
  slug: "diversification-systematic-risk-floor",
  sourceId: "Dd_T9C6CP7I",
  title: "Diversification: less risk, down to the market's floor",
  summary:
    "Part 11 of Quant Finance from scratch. Spreading money evenly across assets that earn about the same lowers risk at no cost in expected return, the free lunch. The gain flattens out at the risk of the shared market, s × √c, which no number of assets removes.",
  kind: "concept",
  tags: {
    regime: ["any"],
    instruments: ["portfolio"],
    timeframe: "years",
    risk: "none",
    topics: ["diversification", "systematic risk", "correlation"],
  },
  scene: { type: "quant", mode: "diversify" },
  params: [
    {
      id: "rho",
      label: "Correlation of any two assets",
      default: 0.3,
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
      id: "assets",
      label: "Most assets in the mix",
      default: 100,
      min: 2,
      max: 1000,
      step: 1,
    },
    {
      id: "seed",
      label: "Random days",
      default: 11,
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
        "Simulated assets that each swing 20% a year; any two of them have a correlation of 0.30.",
    },
    {
      element: "points",
      color: "cyan",
      caption:
        "As in Part 10, every asset shares a hidden market push and gets its own push on top: two of them, day by day.",
      time: [0, 1],
    },
    {
      element: "count",
      color: "blue",
      caption:
        "A single-asset holding swings 20.0% a year. Spread equally over ten assets, the risk drops to 12.2%.",
    },
    {
      element: "count",
      color: "blue",
      caption:
        "With 20 assets the swing is 11.6%, with 50 it is 11.2%, with 100 it is 11.1%. The own pushes partly cancel, the market push does not.",
    },
    {
      element: "floor",
      color: "red",
      caption:
        "The curve flattens toward 11.0%, s × √c: the shared market risk. The part that averages away is firm-specific risk.",
    },
    {
      element: "mix",
      color: "violet",
      caption:
        "With two assets, half in each, the same rule holds: the lower the correlation, the lower the risk of the mix.",
    },
  ],
  formulas: ["diversification", "sharpe"],
  takeaways: [
    "N equal assets with volatility s and pair correlation c swing s × √(c + (1 − c)/N), never below s × √c.",
    "Spreading across ten assets cut the risk from 20.0% to 12.2% while the return stayed about 8%.",
    "With a safe rate of 3%, one asset scored a Sharpe ratio of 0.26 and the mix of ten 0.42.",
    "Market (systematic) risk stays; firm-specific (idiosyncratic) risk averages away.",
  ],
  caveats: [
    "The effect is this strong only because the assets here have similar expected returns; adding lower-returning assets gives up return.",
    "Every asset here has the same volatility and every pair the same correlation; real assets differ.",
    "Simulated returns from one hidden market factor; the figures in the captions are the formula's values for the reel's inputs.",
  ],
} satisfies LessonSpecInput;
