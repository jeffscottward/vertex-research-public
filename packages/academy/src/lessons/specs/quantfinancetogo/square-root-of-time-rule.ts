// Lesson spec: The square-root-of-time rule: risk grows with the square root of the steps
import type { LessonSpecInput } from "../../../schema.ts";

export const spec = {
  caveats: [
    "The rule assumes independent steps; real markets have calm and wild phases, so it is a first estimate.",
  ],
  course: "quantfinancetogo",
  formulas: ["sqrtTime", "randomWalk", "expectedMove"],
  kind: "concept",
  params: [
    {
      default: 400,
      id: "steps",
      label: "Steps",
      max: 4000,
      min: 25,
      step: 25,
      unit: "trades",
    },
    {
      default: 0,
      help: "0 is the pure square root rule; part 2's drift was +0.027 per step.",
      id: "drift",
      label: "Drift per step",
      max: 0.1,
      min: -0.1,
      step: 0.001,
      unit: "$",
    },
    {
      default: 1,
      id: "stepVol",
      label: "Step size",
      max: 10,
      min: 1,
      step: 1,
      unit: "$",
    },
    {
      default: 1000,
      id: "paths",
      label: "Prices",
      max: 1000,
      min: 10,
      step: 10,
    },
    {
      default: 3,
      help: "Same seed, same paths; change it to draw another run.",
      id: "seed",
      label: "Random seed",
      max: 999,
      min: 1,
      step: 1,
    },
  ],
  scene: {
    mode: "walk",
    type: "quant",
  },
  slug: "square-root-of-time-rule",
  sourceId: "Ddw733pRWc1",
  steps: [
    {
      caption:
        "Every step moves the price $1 up or $1 down, like a coin flip, with no drift.",
      color: "gray",
      element: "axes",
    },
    {
      caption:
        "1,000 prices walk 400 steps each. A few end up far away, and most stay surprisingly close to where they started.",
      color: "gray",
      element: "paths",
      time: [0, 1],
    },
    {
      caption:
        "The spread is σ√n: about $5 after 25 steps, $10 after 100 and $20 after 400. Four times the steps give only twice the spread.",
      color: "violet",
      element: "band",
    },
    {
      caption:
        "Where the 400-step walks end: ups and downs cancel, while their squares add up. Variance 100 after 100 steps, and its square root is 10.",
      color: "red",
      element: "bars",
    },
    {
      caption:
        "The bell of the end points has spread √400 = 20. In the video, 73% of the prices ended within $10 after 100 steps.",
      color: "violet",
      element: "pdf",
    },
    {
      caption:
        "Set a drift: it grows in a straight line, randomness with √n. From 25 to 4,000 steps the drift grew 160 times, the randomness about 13 times.",
      color: "gold",
      element: "mean",
    },
  ],
  summary:
    "A hundred random $1 steps usually leave you within about $10 of the start: the spread grows with the square root of time. Ups and downs cancel while their squares (the variance) add up, so four times the steps give twice the spread. The rule turns daily risk into yearly risk (1% a day x √252 = 15.9% a year), sits inside every option price, and shows why a positive drift wins over time.",
  tags: {
    instruments: ["volatility"],
    regime: ["any"],
    risk: "none",
    timeframe: "years",
    topics: [
      "square root rule",
      "variance",
      "standard deviation",
      "random walk",
      "volatility",
    ],
  },
  takeaways: [
    "Risk grows with the square root of time: 100 random $1 steps usually leave you within about $10 of the start.",
    "Ups and downs cancel, but their squares (the variance) add up: variance 100 after 100 steps, and its square root is 10.",
    "The rule turns daily risk into yearly risk: 1% up or down a day becomes about 1% x √252 = 15.9% a year.",
    "With a positive drift, ending above the start gets more likely the longer you wait: 64% after one year and 91% after ten for a 6.8% drift, in this simple model.",
    "It sits inside every option price, because a later deadline leaves the price more room to move.",
  ],
  title:
    "The square-root-of-time rule: risk grows with the square root of the steps",
} satisfies LessonSpecInput;
