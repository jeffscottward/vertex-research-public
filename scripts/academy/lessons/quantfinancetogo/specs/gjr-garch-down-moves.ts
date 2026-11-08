import type { LessonSpecInput } from "../../../../../packages/academy/src/schema.ts";

export const spec = {
  caveats: [
    "Parameter values are typical textbook sizes, not estimates from real data; all market data is simulated.",
    "The chart's GARCH line uses alpha + gamma/2 (the same average reaction), not the part 39 values the creator compares with.",
    "Leverage (debt weighing more after a fall) is one reason given for the asymmetry; the model only describes it.",
  ],
  course: "quantfinancetogo",
  formulas: ["gjrGarch", "garch"],
  kind: "concept",
  params: [
    {
      default: 15.9,
      help: "Per year; 15.9% a year is about 1% a day.",
      id: "longRunVol",
      label: "Long-run volatility",
      max: 60,
      min: 5,
      step: 0.1,
      unit: "%",
    },
    {
      default: 0.02,
      id: "alpha",
      label: "Alpha (reaction to today's move)",
      max: 0.3,
      min: 0,
      step: 0.01,
    },
    {
      default: 0.9,
      id: "beta",
      label: "Beta (memory)",
      max: 0.99,
      min: 0.5,
      step: 0.01,
    },
    {
      default: 0.12,
      help: "0 = plain GARCH. Alpha + beta + gamma/2 is kept below 1.",
      id: "gamma",
      label: "Gamma (extra weight after a drop)",
      max: 0.3,
      min: 0,
      step: 0.01,
    },
    {
      default: 250,
      id: "shockDay",
      label: "Shock day",
      max: 740,
      min: 10,
      step: 10,
      unit: "days",
    },
    {
      default: -4,
      help: "Size of the forced move on the shock day; negative = drop.",
      id: "shockPct",
      label: "Shock move",
      max: 15,
      min: -15,
      step: 0.5,
      unit: "%",
    },
    {
      default: 750,
      id: "days",
      label: "Simulated days",
      max: 2520,
      min: 250,
      step: 10,
      unit: "days",
    },
    {
      default: 7,
      id: "seed",
      label: "Random path",
      max: 999,
      min: 1,
      step: 1,
    },
  ],
  scene: {
    mode: "volcluster",
    type: "quant",
  },
  slug: "gjr-garch-down-moves",
  sourceId: "DfRnjfGRKH-",
  steps: [
    {
      caption:
        "A simulated GJR-GARCH market at about 1% a day: down days count with alpha + gamma",
      color: "gray",
      element: "axes",
    },
    {
      caption:
        "Plain GARCH: tomorrow's variance is symmetric in today's move, drops and rises count the same",
      color: "violet",
      element: "garch",
    },
    {
      caption:
        "GJR-GARCH: the curve is steeper on the left, so a drop lifts tomorrow's variance far more",
      color: "red",
      element: "gjr",
    },
    {
      caption:
        "A 4% drop: GJR's forecast jumps to about 1.78% a day; a 4% rise would give about 1.11%",
      color: "amber",
      element: "shock",
      seconds: 6,
      time: [0.3, 0.45],
    },
    {
      caption:
        "Daily returns of the simulated market, with the forced drop on day 250",
      color: "cyan",
      element: "bars",
      seconds: 6,
      time: [0, 1],
    },
    {
      caption: "The ±2σ band of the GJR model widens most after sell-offs",
      color: "blue",
      element: "band",
    },
    {
      caption:
        "Both models pull the forecast back toward the same long-run level of about 1% a day",
      color: "gray",
      element: "longRun",
    },
  ],
  summary:
    "Plain GARCH squares today's move, so a 4% drop and a 4% rise raise tomorrow's forecast by the same amount. GJR-GARCH (Glosten, Jagannathan and Runkle, 1993) adds a weight gamma that only switches on after a down day. With omega 0.02, alpha 0.02, gamma 0.12 and beta 0.90 at 1% a day, a 4% rise lifts the forecast to about 1.11% and a 4% drop to about 1.78%.",
  tags: {
    instruments: ["volatility", "portfolio"],
    regime: ["any", "high-vol"],
    risk: "none",
    timeframe: "days",
    topics: ["gjr garch", "garch", "asymmetry", "leverage effect"],
  },
  takeaways: [
    "Squaring wipes out the sign: plain GARCH reacts the same to a 4% drop and a 4% rise.",
    "GJR-GARCH: tomorrow's variance = omega + (alpha + gamma × I) × today's move squared + beta × today's variance, with I = 1 after a down day.",
    "With the reel's values a 4% rise gives about 1.11% and a 4% drop about 1.78%: about 7 times as much extra volatility.",
    "Right after a sell-off, plain GARCH underestimates the risk.",
  ],
  title: "GJR-GARCH: why drops raise volatility more than rallies",
} satisfies LessonSpecInput;
