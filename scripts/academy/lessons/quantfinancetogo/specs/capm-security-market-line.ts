// Lesson spec: CAPM: expected return rises in a straight line with beta
import type { LessonSpecInput } from "../../../../../packages/academy/src/schema.ts";

export const spec = {
  course: "quantfinancetogo",
  slug: "capm-security-market-line",
  sourceId: "DeG3qGCirGO",
  title: "CAPM: expected return rises in a straight line with beta",
  summary:
    "Part 15 of Quant Finance from scratch. In a simulated market, stocks' average returns line up against their beta to the market. That line is the CAPM: expected return = risk-free rate + beta × (market's expected return − risk-free rate). A stock's own swings earn nothing extra because they average out in a mix.",
  kind: "concept",
  tags: {
    regime: ["any"],
    instruments: ["single-stock", "portfolio"],
    timeframe: "years",
    risk: "none",
    topics: ["capm", "beta", "expected return"],
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
      label: "Market's expected return",
      default: 8,
      min: -10,
      max: 20,
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
        "Beta across, average return up. Assumed market: the risk-free asset pays 3% a year and the market 5% more on average.",
    },
    {
      element: "assets",
      color: "blue",
      caption:
        "Eight simulated stocks with betas from 0 to 1.4. Each also has swings of its own, unrelated to the market.",
    },
    {
      element: "line",
      color: "gold",
      caption:
        "Their averages lie on a straight line: risk-free rate + beta × (market return − risk-free rate). That is the CAPM.",
    },
    {
      element: "line",
      color: "gold",
      caption:
        "Beta 1.2 gives 3% + 1.2 × 5% = 9%. The reel's beta-1.2 stock measured 9.3%, close to the line.",
    },
    {
      element: "assets",
      color: "blue",
      caption:
        "A stock's own swings average out in a mix, the market's swing stays. So beta, not total swing, sets the expected return.",
    },
  ],
  formulas: ["capm", "beta"],
  takeaways: [
    "CAPM: expected return = risk-free rate + beta × (market's expected return − risk-free rate).",
    "Two stocks with about the same total swing (21%) earned 5.3% and 9.3%: only the market part of risk is paid.",
    "A mix of 100 stocks like the low-beta one still earned 5.1% but swung only 6.7%.",
  ],
  caveats: [
    "Researchers still debate whether one factor, the market, is enough to estimate expected returns.",
    "Numbers are assumed, not forecasts. The dots scatter around the line by illustrative noise, like averages measured from data.",
  ],
} satisfies LessonSpecInput;
