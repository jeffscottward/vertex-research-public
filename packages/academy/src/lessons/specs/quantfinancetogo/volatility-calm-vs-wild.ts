// Lesson spec: Risk and volatility: two investments with the same 8% average, calm vs wild
import type { LessonSpecInput } from "../../../schema.ts";

export const spec = {
  caveats: [
    "Both investments are simulated. The quoted shares come from the creator's 100,000-year run; this chart uses its own seed and model, so its numbers differ slightly.",
  ],
  course: "quantfinancetogo",
  formulas: ["realizedVol", "sqrtTime", "gbm"],
  kind: "concept",
  params: [
    {
      default: 100,
      id: "spot",
      label: "Starting value",
      max: 1000,
      min: 10,
      step: 10,
      unit: "$",
    },
    {
      default: 8,
      id: "drift",
      label: "Average growth",
      max: 20,
      min: -10,
      step: 0.5,
      unit: "%",
    },
    {
      default: 31.6,
      help: "Wild investment: 31.6% a year (1.99% a day). Calm investment: 3.9% a year (0.25% a day).",
      id: "vol",
      label: "Volatility",
      max: 60,
      min: 1,
      step: 0.1,
      unit: "%",
    },
    {
      default: 1,
      id: "years",
      label: "Years",
      max: 10,
      min: 0.25,
      step: 0.25,
    },
    {
      default: 2000,
      id: "paths",
      label: "Simulated years",
      max: 5000,
      min: 100,
      step: 100,
    },
    {
      default: 7,
      help: "Same seed, same paths; change it to draw another run.",
      id: "seed",
      label: "Random seed",
      max: 999,
      min: 1,
      step: 1,
    },
  ],
  scene: {
    mode: "gbm",
    type: "quant",
  },
  slug: "volatility-calm-vs-wild",
  sourceId: "Dd31O8FCqsi",
  steps: [
    {
      caption:
        "Two simulated investments, both built to grow 8% a year on average. This is the wild one; set volatility to 3.9% for the calm one.",
      color: "gray",
      element: "axes",
    },
    {
      caption:
        "Risk is how far the returns jump around their average, up as well as down: 1.99% a day for the wild one, 0.25% for the calm one.",
      color: "gray",
      element: "paths",
      time: [0, 1],
    },
    {
      caption: "Both share the same expected growth of 8% a year.",
      color: "green",
      element: "mean",
    },
    {
      caption:
        "The 10th-90th percentile band shows the swing. Volatility = daily standard deviation x √252 (about 15.87): 31.6% a year wild, 3.9% calm.",
      color: "violet",
      element: "band",
    },
    {
      caption:
        "Loss years: in 100,000 simulated years the wild one lost money in 46.8% of them and the calm one in only 2.7%.",
      color: "red",
      element: "bars",
    },
    {
      caption:
        "The bell curve turns volatility into a feeling: in about two years out of three, the result ends within one volatility of the 8% average.",
      color: "violet",
      element: "pdf",
    },
  ],
  summary:
    "Two simulated investments both grow 8% a year on average, one calm and one wild. Risk is how far returns jump around their average; volatility is the standard deviation of daily returns made yearly with the square root rule (x √252 ≈ 15.87): 0.25% a day is 3.9% a year, 1.99% a day is 31.6%. The calm one lost money in 2.7% of simulated years, the wild one in 46.8%.",
  tags: {
    instruments: ["volatility", "portfolio"],
    regime: ["high-vol", "low-vol"],
    risk: "none",
    timeframe: "years",
    topics: ["volatility", "risk", "standard deviation", "square root rule"],
  },
  takeaways: [
    "In quantitative finance, risk is how far the returns jump around their average, up as well as down.",
    "Volatility is the standard deviation of daily returns quoted per year: multiply by √252, about 15.87.",
    "The calm investment has a volatility of 3.9% a year and the wild one 31.6%, with the same 8% average return.",
    "Same average, very different risk: the calm one lost money in 2.7% of 100,000 simulated years, the wild one in 46.8%.",
    "Volatility is everywhere in quantitative finance, from comparing investments to pricing options.",
  ],
  title:
    "Risk and volatility: two investments with the same 8% average, calm vs wild",
} satisfies LessonSpecInput;
