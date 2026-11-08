// Lesson spec: Risk parity: spread the risk, not the money
import type { LessonSpecInput } from "../../../schema.ts";

export const spec = {
  course: "quantfinancetogo",
  slug: "risk-parity-inverse-volatility",
  sourceId: "DfZSXlgxRCt",
  title: "Risk parity: spread the risk, not the money",
  summary:
    "Part 42 of Quant Finance from scratch. In a classic 60/40 portfolio stocks hold 60% of the money but carry about 90% of the risk. Risk parity sets weights so each asset contributes the same share of risk; the simplest version weights by inverse volatility, here 25% stocks and 75% bonds.",
  kind: "concept",
  tags: {
    regime: ["any"],
    instruments: ["portfolio"],
    timeframe: "years",
    risk: "none",
    topics: ["risk parity", "all weather", "asset allocation"],
  },
  scene: { type: "quant", mode: "riskparity" },
  params: [
    {
      id: "stockVol",
      label: "Stock volatility",
      default: 15,
      min: 1,
      max: 60,
      step: 0.5,
      unit: "%",
    },
    {
      id: "bondVol",
      label: "Bond volatility",
      default: 5,
      min: 1,
      max: 60,
      step: 0.5,
      unit: "%",
    },
    {
      id: "rho",
      label: "Stock-bond correlation",
      default: 0.2,
      min: -0.95,
      max: 0.95,
      step: 0.05,
    },
    {
      id: "stockWeight",
      label: "Stocks in the classic mix",
      default: 60,
      min: 0,
      max: 100,
      step: 5,
      unit: "%",
    },
  ],
  steps: [
    {
      element: "axes",
      color: "gray",
      caption:
        "Stocks (1) and bonds (2). Assumed: stocks swing 15% a year, bonds 5%, with a correlation of 0.2.",
    },
    {
      element: "capital",
      color: "blue",
      caption:
        "Blue bars: share of the money. Left, the classic 60/40 mix; right, risk parity with 25% stocks and 75% bonds.",
    },
    {
      element: "risk",
      color: "red",
      caption:
        "Red bars: share of the risk, w_i(Σw)_i / σ². In 60/40, stocks carry about 91.8% of the risk with 60% of the money.",
    },
    {
      element: "risk",
      color: "red",
      caption:
        "Inverse volatility: w_i = (1/σ_i) / Σ(1/σ_j). Since 0.25 × 15 = 0.75 × 5, each asset causes half of the ups and downs.",
    },
    {
      element: "capital",
      color: "blue",
      caption:
        "With a correlation anywhere from 0 to 0.3, stocks in 60/40 keep 90% to 95% of the risk. For two assets the parity split holds at any correlation.",
    },
  ],
  formulas: ["riskParity", "portfolioVariance"],
  takeaways: [
    "Every dollar in stocks brings three times the risk of a dollar in bonds here, so 60/40 is mostly a stock bet.",
    "Risk parity sets the weights so each asset contributes the same share of the portfolio's risk.",
    "Inverse-volatility weights, w_i = (1/σ_i) / Σ_j (1/σ_j), give equal risk shares for two assets at any correlation.",
  ],
  caveats: [
    "The calmer mix usually earns less, so many risk parity funds borrow money to scale it up.",
    "When stocks and bonds fall at the same time, the balance does not protect you.",
    "Volatilities and correlation are fixed assumptions; with more assets, full risk parity has to solve for equal contributions.",
  ],
} satisfies LessonSpecInput;
