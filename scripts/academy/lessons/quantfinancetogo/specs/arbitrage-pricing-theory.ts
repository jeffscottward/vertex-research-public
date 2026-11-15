// Lesson spec: Arbitrage pricing theory: the same risk must earn the same return
import type { LessonSpecInput } from "../../../../../packages/academy/src/schema.ts";

export const spec = {
  course: "quantfinancetogo",
  slug: "arbitrage-pricing-theory",
  sourceId: "Dfeu_BMxSc6",
  title: "Arbitrage pricing theory: the same risk must earn the same return",
  summary:
    "Part 44 of Quant Finance from scratch. Stephen Ross's APT (1976) explains expected returns with several risk factors: risk-free rate plus each beta times that factor's premium. Two stocks with the same exposures should earn the same; if not, buying one and selling the other is an arbitrage that pushes prices back.",
  kind: "concept",
  tags: {
    regime: ["any"],
    instruments: ["single-stock", "portfolio"],
    timeframe: "years",
    risk: "none",
    topics: ["apt", "factors", "arbitrage", "alpha"],
  },
  scene: { type: "quant", mode: "sml" },
  params: [
    {
      id: "rf",
      label: "Risk-free rate",
      default: 3,
      min: 0,
      max: 10,
      step: 0.25,
      unit: "%",
    },
    {
      id: "marketReturn",
      label: "Expected return at factor beta 1",
      default: 8,
      min: -10,
      max: 20,
      step: 0.25,
      unit: "%",
    },
    {
      id: "alpha",
      label: "Alpha of the mispriced stock",
      default: 2,
      min: -5,
      max: 5,
      step: 0.25,
      unit: "%",
    },
    {
      id: "gap",
      label: "Return gap of the same-beta pair",
      default: 2,
      min: 0,
      max: 5,
      step: 0.25,
      unit: "%",
    },
    {
      id: "seed",
      label: "Random averages",
      default: 15,
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
        "One factor here for a clear picture: beta to that factor across, expected return up. The APT allows several factors.",
    },
    {
      element: "line",
      color: "gold",
      caption:
        "Expected return = risk-free rate + each beta × λ, the premium per unit of that factor's risk. One factor: a straight line.",
    },
    {
      element: "assets",
      color: "blue",
      caption:
        "Stocks whose expected return comes from their betas alone sit on the line: their alpha is zero.",
    },
    {
      element: "alpha",
      color: "green",
      caption:
        "This stock earns more than its beta explains: an alpha. A factor model allows it; the APT says it should be zero.",
    },
    {
      element: "pair",
      color: "amber",
      caption:
        "X and Y have the same beta, but X is expected to earn more. Buy X, sell Y: the factor cancels out.",
    },
    {
      element: "pair",
      color: "amber",
      caption:
        "Across many such pairs the stock-specific swings cancel out, and arbitrage trading pulls mispriced stocks back to the line.",
    },
  ],
  formulas: ["apt", "capm"],
  takeaways: [
    "APT: E[R_i] = r_f + β_i1 λ_1 + … + β_iK λ_K, with β the exposure to a factor and λ the premium for its risk.",
    "Equal factor exposures mean equal risk, and equal risk should be paid the same expected return.",
    "If they do not, buying one and selling the other is an arbitrage; trading on it pushes expected returns back onto the formula.",
  ],
  caveats: [
    "Which factors belong in the model is left open; in practice they are chosen from data (Chen, Roll and Ross 1986; Fama and French).",
    "The reel gives the formula without a numeric example; the chart's single factor, alpha and gap are illustrative inputs.",
    "Expected returns line up only approximately: a single pair keeps its own risk until many pairs are combined.",
  ],
} satisfies LessonSpecInput;
