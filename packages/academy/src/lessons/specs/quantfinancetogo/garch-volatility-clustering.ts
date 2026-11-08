import type { LessonSpecInput } from "../../../schema.ts";

export const spec = {
  caveats: [
    "All data is simulated with the GARCH model itself, so the clustering is built in by design.",
    "Plain GARCH is symmetric; in real markets volatility usually reacts more strongly to falls than to rises.",
    "Parameter values are the typical sizes used in the reel, not estimates from real data.",
  ],
  course: "quantfinancetogo",
  formulas: ["garch"],
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
      default: 0.1,
      id: "alpha",
      label: "Alpha (reaction to today's move)",
      max: 0.3,
      min: 0,
      step: 0.01,
    },
    {
      default: 0.85,
      id: "beta",
      label: "Beta (memory)",
      max: 0.99,
      min: 0.5,
      step: 0.01,
    },
    {
      default: 0,
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
  slug: "garch-volatility-clustering",
  sourceId: "DfPHPULRYE7",
  steps: [
    {
      caption:
        "A simulated GARCH market: three years of trading days at about 1% a day on average",
      color: "gray",
      element: "axes",
    },
    {
      caption:
        "Daily returns: calm stretches and stormy stretches arrive in clusters",
      color: "cyan",
      element: "bars",
      seconds: 6,
      time: [0, 1],
    },
    {
      caption:
        "A band of ±2 forecast standard deviations widens after big moves and narrows in calm weeks",
      color: "violet",
      element: "band",
    },
    {
      caption:
        "GARCH forecast (annualized): omega + alpha × today's move squared + beta × today's variance",
      color: "gold",
      element: "garch",
    },
    {
      caption:
        "Long-run level: the constant omega pulls the forecast back toward about 1% a day",
      color: "gray",
      element: "longRun",
    },
    {
      caption:
        "A 4% drop on day 250: tomorrow's forecast jumps to about 1.58% a day, then the extra risk fades",
      color: "red",
      element: "shock",
      seconds: 6,
      time: [0.3, 0.45],
    },
  ],
  summary:
    "Calm weeks follow calm weeks and high-volatility days arrive in groups. GARCH(1,1) builds tomorrow's variance from a constant that pulls toward a normal level, today's move squared times alpha and today's variance times beta. With omega 0.05, alpha 0.10 and beta 0.85, a 4% drop at 1% a day lifts the forecast to about 1.58%; the extra variance halves in about 13.5 days.",
  tags: {
    instruments: ["volatility", "portfolio"],
    regime: ["any", "high-vol"],
    risk: "none",
    timeframe: "days",
    topics: [
      "garch",
      "volatility clustering",
      "forecasting",
      "risk management",
    ],
  },
  takeaways: [
    "Volatility clusters: high-volatility days arrive in groups, so tomorrow's risk depends on today.",
    "GARCH(1,1): tomorrow's variance = omega + alpha × today's move squared + beta × today's variance.",
    "With omega 0.05, alpha 0.10 and beta 0.85, a 4% drop on a calm day lifts tomorrow's forecast from 1% to about 1.58%.",
    "The extra variance halves about every 13.5 trading days; a move above 2.5% was about 6 times as likely right after one in the creator's simulation.",
    "Risk managers update value at risk with GARCH forecasts, and some funds shrink positions when the forecast rises.",
  ],
  title: "GARCH: forecasting tomorrow's volatility from today's move",
} satisfies LessonSpecInput;
