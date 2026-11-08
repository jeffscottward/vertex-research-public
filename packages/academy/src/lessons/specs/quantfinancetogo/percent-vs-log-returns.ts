// Lesson spec: Percent vs log returns: why a fall hurts more than the same rise helps
import type { LessonSpecInput } from "../../../schema.ts";

export const spec: LessonSpecInput = {
  caveats: [
    "The path is simulated with a fixed seed, as in the video; it is not a real stock.",
    "The red line is the sum of percent moves, the misleading total the video warns about.",
  ],
  course: "quantfinancetogo",
  formulas: ["logReturn"],
  kind: "concept",
  params: [
    {
      default: 120,
      id: "seed",
      label: "Random path",
      max: 999,
      min: 1,
      step: 1,
    },
    {
      default: 2,
      id: "vol",
      label: "Daily volatility",
      max: 5,
      min: 0.5,
      step: 0.1,
      unit: "%",
    },
    {
      default: 252,
      id: "days",
      label: "Trading days",
      max: 1260,
      min: 20,
      step: 1,
      unit: "days",
    },
    {
      default: 50,
      id: "downPct",
      label: "Example fall",
      max: 90,
      min: 1,
      step: 1,
      unit: "%",
    },
    {
      default: 100,
      id: "upPct",
      label: "Example rise",
      max: 900,
      min: 1,
      step: 1,
      unit: "%",
    },
  ],
  scene: {
    mode: "logreturns",
    type: "quant",
  },
  slug: "percent-vs-log-returns",
  sourceId: "Dd1PeNiCtkl",
  steps: [
    {
      caption:
        "A simulated stock that moves randomly about 2% a day for one year of 252 trading days.",
      color: "gray",
      element: "axes",
    },
    {
      caption:
        "The seeded price path. Each day's move multiplies the price; it never adds to it.",
      color: "blue",
      element: "price",
      time: [0, 1],
    },
    {
      caption:
        "Adding up the 252 daily percent moves gives about −24%, yet the stock really lost about 25%.",
      color: "red",
      element: "simple",
    },
    {
      caption:
        "Adding up the daily log returns instead tracks the real change, step for step.",
      color: "green",
      element: "log",
    },
    {
      caption:
        "The actual change ln(P/P0) lies on the log sum: log returns add up, percent returns do not.",
      color: "gold",
      element: "actual",
    },
  ],
  summary:
    "Part 5 of Quant Finance from scratch. From $100, minus 50% then plus 100% adds to +50% on paper, yet you are back at $100. Log returns, ln(new / old), turn the fall into −0.69 and the rise into +0.69, so they add up to the true change.",
  tags: {
    instruments: ["single-stock"],
    regime: ["any"],
    risk: "none",
    timeframe: "days",
    topics: ["log returns", "returns", "compounding"],
  },
  takeaways: [
    "A return is measured from where you start, so −50% needs +100% to get back.",
    "Log returns, ln(new / old), add up over time: ln(0.5) + ln(2) = 0.",
    "For one small day both are almost the same; the gap grows with big moves and over time.",
  ],
  title:
    "Percent vs log returns: why a fall hurts more than the same rise helps",
};
