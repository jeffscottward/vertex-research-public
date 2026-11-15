// Lesson spec: Black-Litterman: blend the market's implied returns with your view
import type { LessonSpecInput } from "../../../../../packages/academy/src/schema.ts";

export const spec = {
  course: "quantfinancetogo",
  slug: "black-litterman-market-and-views",
  sourceId: "DfchQKCRSx7",
  title: "Black-Litterman: blend the market's implied returns with your view",
  summary:
    "Part 43 of Quant Finance from scratch. Instead of guessing expected returns, Black-Litterman (1992) works backwards from the market portfolio: π = δΣw gives the returns that make it optimal. Your own view is then mixed in like a weighted average, weighted by how sure you are.",
  kind: "concept",
  tags: {
    regime: ["any"],
    instruments: ["portfolio"],
    timeframe: "years",
    risk: "none",
    topics: ["black-litterman", "implied returns", "views"],
  },
  scene: { type: "quant", mode: "blend" },
  params: [
    {
      id: "view",
      label: "Your view: stocks above risk-free",
      default: 6,
      min: -10,
      max: 20,
      step: 0.25,
      unit: "%",
    },
    {
      id: "confidence",
      label: "Confidence in the view",
      default: 50,
      min: 0,
      max: 100,
      step: 5,
      unit: "%",
      help: "Weight the posterior gives the view. 50% means as sure as the market: view uncertainty Ω = τσ².",
    },
    {
      id: "riskAversion",
      label: "Risk aversion δ",
      default: 2.5,
      min: 0.5,
      max: 10,
      step: 0.1,
    },
    {
      id: "tau",
      label: "Uncertainty scale τ",
      default: 0.05,
      min: 0.01,
      max: 1,
      step: 0.01,
    },
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
      label: "Stocks in the market portfolio",
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
        "A market of 60% stocks and 40% bonds. Assumed: stocks swing 15%, bonds 5%, correlation 0.2, risk aversion δ = 2.5.",
    },
    {
      element: "prior",
      color: "gray",
      caption:
        "Work backwards from the market weights, π = δΣw: stocks imply about 3.5% above the risk-free rate, bonds 0.475%.",
    },
    {
      element: "view",
      color: "gold",
      caption:
        "Now add your own view: stocks earn 6% above the risk-free rate.",
    },
    {
      element: "posterior",
      color: "green",
      caption:
        "The model mixes market and view like a weighted average. As sure as the market, stocks land at 4.7625%, exactly halfway.",
    },
    {
      element: "curve",
      color: "violet",
      caption:
        "More confidence moves the result toward the view. With no view at all you get back the market's implied returns.",
    },
    {
      element: "marker",
      color: "amber",
      caption:
        "The dot marks the chosen confidence: 50%, where the view's uncertainty equals the market's, Ω = τσ² with τ = 0.05.",
    },
  ],
  formulas: ["blackLitterman"],
  takeaways: [
    "Expected returns are very hard to estimate, and small errors push Markowitz weights to extremes.",
    "Black-Litterman starts from the market portfolio and backs out its implied returns: π = δΣw.",
    "A view is blended in like a weighted average; equally sure as the market, it lands halfway (3.525% → 4.7625% for a 6% view).",
  ],
  caveats: [
    "Returns are above the risk-free rate. The inputs (volatilities, correlation, δ, τ) are assumptions, not estimates.",
    "Confidence here is the weight on the view, Ω = τσ²(1 − c)/c; other ways to set Ω exist.",
    "The reel shows the stock result only; the bond bar follows from the same formula through the stock-bond covariance.",
  ],
} satisfies LessonSpecInput;
