// Lesson spec: Chart-trading rules and data snooping
import type { LessonSpecInput } from "../../../../../packages/academy/src/schema.ts";

export const spec = {
  caveats: [
    "Rules here are simulated noise, not the actual chart rules or Dow data from the study.",
    "Sharpe estimates are drawn from a normal sampling distribution; trading costs are not modeled.",
    "The study and review numbers come from the video and were not verified here.",
  ],
  course: "quantfinancetogo",
  formulas: ["dataSnooping", "tStat"],
  kind: "concept",
  params: [
    {
      default: 2000,
      help: "How many zero-edge rules are tried.",
      id: "rules",
      label: "Rules tested",
      max: 2000,
      min: 1,
      step: 1,
    },
    {
      default: 10,
      help: "Length of each in-sample and out-of-sample period.",
      id: "years",
      label: "Years per sample",
      max: 30,
      min: 1,
      step: 1,
    },
    {
      default: 7,
      help: "Changes the simulated random rules.",
      id: "seed",
      label: "Random seed",
      max: 999,
      min: 1,
      step: 1,
    },
  ],
  scene: { mode: "snooping", type: "quant" },
  slug: "chart-rules-data-snooping",
  sourceId: "DdRP_zWCn6b",
  steps: [
    {
      caption: "One price history, many chart rules with no real edge.",
      color: "gray",
      element: "axes",
    },
    {
      caption: "The luckiest rule looks better the more rules you test.",
      color: "gold",
      element: "curve",
    },
    {
      caption: "Simulated best rule after each batch tested.",
      color: "amber",
      element: "best",
      time: [0, 1],
    },
    {
      caption: "The luckiest rule so far: looks brilliant by pure luck.",
      color: "red",
      element: "marker",
    },
    {
      caption: "Each dot: a rule in one stretch of history vs the next.",
      color: "blue",
      element: "points",
    },
    {
      caption: "Winners in one stretch do not stay winners in the next.",
      color: "gray",
      element: "zero",
    },
  ],
  summary:
    "Testing thousands of chart rules on one price history makes a few look brilliant by luck. A study on the Dow from 1897 to 2011 corrected for that: winners in one period stopped working in the next, and costs wiped out the rest.",
  tags: {
    instruments: ["portfolio"],
    regime: ["any"],
    risk: "none",
    timeframe: "years",
    topics: ["chart patterns", "data snooping", "technical analysis"],
  },
  takeaways: [
    "Test thousands of rules on one history and a few will look brilliant by pure luck.",
    "A rule that did well in one period failed in the following one, so nobody could have known the winners ahead of time.",
    "Patterns on charts are real; what has not survived honest tests is that they predict what comes next.",
  ],
  title: "Chart-trading rules and data snooping",
} satisfies LessonSpecInput;
