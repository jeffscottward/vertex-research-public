// Lesson spec: The efficient frontier: the best mixes for each level of risk
import type { LessonSpecInput } from "../../../../../packages/academy/src/schema.ts";

export const spec = {
  course: "quantfinancetogo",
  slug: "efficient-frontier-markowitz",
  sourceId: "DeD3ruoCXGg",
  title: "The efficient frontier: the best mixes for each level of risk",
  summary:
    "Part 13 of Quant Finance from scratch. Three assumed assets are mixed in many random ways and each mix becomes a dot on a risk/return map. The upper edge of the cloud, where every mix earns more than all mixes with less risk, is Markowitz's efficient frontier.",
  kind: "concept",
  tags: {
    regime: ["any"],
    instruments: ["portfolio"],
    timeframe: "years",
    risk: "none",
    topics: ["efficient frontier", "markowitz", "diversification"],
  },
  scene: { type: "quant", mode: "frontier" },
  params: [
    {
      id: "retA",
      label: "A (like bonds): return",
      default: 4,
      min: -20,
      max: 40,
      step: 0.5,
      unit: "%",
    },
    {
      id: "volA",
      label: "A: volatility",
      default: 6,
      min: 0.5,
      max: 60,
      step: 0.5,
      unit: "%",
    },
    {
      id: "retB",
      label: "B (like stocks): return",
      default: 7,
      min: -20,
      max: 40,
      step: 0.5,
      unit: "%",
    },
    {
      id: "volB",
      label: "B: volatility",
      default: 18,
      min: 0.5,
      max: 60,
      step: 0.5,
      unit: "%",
    },
    {
      id: "retC",
      label: "C (riskier stock): return",
      default: 11,
      min: -20,
      max: 40,
      step: 0.5,
      unit: "%",
    },
    {
      id: "volC",
      label: "C: volatility",
      default: 25,
      min: 0.5,
      max: 60,
      step: 0.5,
      unit: "%",
    },
    {
      id: "rhoAB",
      label: "Correlation A-B",
      default: 0,
      min: -1,
      max: 1,
      step: 0.05,
    },
    {
      id: "rhoAC",
      label: "Correlation A-C",
      default: 0,
      min: -1,
      max: 1,
      step: 0.05,
    },
    {
      id: "rhoBC",
      label: "Correlation B-C",
      default: 0.5,
      min: -1,
      max: 1,
      step: 0.05,
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
      id: "mixes",
      label: "Random mixes in the cloud",
      default: 150,
      min: 10,
      max: 300,
      step: 10,
    },
    {
      id: "seed",
      label: "Random mixes draw",
      default: 13,
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
        "Risk across, expected return up. The three assets use assumed numbers; for real assets they must be estimated.",
    },
    {
      element: "assets",
      color: "blue",
      caption:
        "A, like bonds, earns 4% at 6% risk. B, like stocks, 7% at 18%. C, a riskier stock, 11% at 25%. B and C correlate 0.5.",
    },
    {
      element: "cloud",
      color: "cyan",
      caption:
        "Random mixes of the three, weights from 0 to 100% adding up to 100%, each become a dot and fill a cloud.",
      time: [0, 1],
    },
    {
      element: "frontier",
      color: "gold",
      caption:
        "The upper edge earns the most at every level of risk: keep a mix only if it beats every mix with less risk.",
    },
    {
      element: "minVar",
      color: "amber",
      caption:
        "The first mix on the edge has the lowest risk, about 5.7%: a little less than A alone, because mixing lowers risk.",
    },
    {
      element: "lines",
      color: "gray",
      caption:
        "B sits below the edge: at 18% risk the edge earns about 9.1% instead of 7%, a Sharpe ratio of 0.34 instead of 0.22.",
    },
    {
      element: "frontier",
      color: "gold",
      caption:
        "On the frontier, extra return always comes with extra risk; the right point depends on how much risk the investor accepts.",
    },
  ],
  formulas: ["portfolioVariance", "sharpe"],
  takeaways: [
    "Every mix of assets is a point on the risk/return map; the upper edge of all mixes is the efficient frontier.",
    "Mixing can lower risk below the calmest asset, because the risk of a mix depends on how its assets move together.",
    "An asset below the edge is beaten by a mix with the same risk and more return.",
    "Markowitz (1952) introduced the idea; the exact frontier can be computed directly by quadratic programming.",
  ],
  caveats: [
    "The reel mixed 5,000 random portfolios (825 on the edge); this chart draws up to 300 and finds the edge on a fine grid of weights.",
    "Returns, volatilities and correlations are assumptions, not forecasts; for real assets they have to be estimated from data.",
    "Long-only weights: no borrowing and no short selling.",
    "Not every three correlations can hold at once (e.g. all −0.9): such a set is flagged and scaled toward 0 until it is possible.",
  ],
} satisfies LessonSpecInput;
