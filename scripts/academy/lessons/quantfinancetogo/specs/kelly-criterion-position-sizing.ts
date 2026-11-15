// Lesson spec: The Kelly criterion: how much to bet when the odds are on your side
import type { LessonSpecInput } from "../../../../../packages/academy/src/schema.ts";

export const spec: LessonSpecInput = {
  caveats: [
    "The chart simulates 24 players over at most 500 flips; the video used 1,000 players and 1,000 flips.",
    "Kelly maximizes long-run growth, not safety; many traders bet a fraction of it.",
  ],
  course: "quantfinancetogo",
  formulas: ["kelly", "positionSize"],
  kind: "concept",
  params: [
    {
      default: 100,
      id: "capital",
      label: "Starting capital",
      max: 1_000_000,
      min: 10,
      step: 10,
      unit: "$",
    },
    {
      default: 10,
      id: "riskPct",
      label: "Share bet per flip",
      max: 50,
      min: 0.5,
      step: 0.5,
      unit: "%",
    },
    {
      default: 55,
      id: "winRate",
      label: "Win rate",
      max: 95,
      min: 5,
      step: 1,
      unit: "%",
    },
    {
      default: 1,
      id: "payoffRatio",
      label: "Win / loss (even money = 1)",
      max: 5,
      min: 0.2,
      step: 0.1,
      unit: "x",
    },
    {
      default: 500,
      id: "trades",
      label: "Number of flips",
      max: 500,
      min: 10,
      step: 10,
      unit: "trades",
    },
    {
      default: 11,
      id: "seed",
      label: "Random path",
      max: 999,
      min: 1,
      step: 1,
    },
  ],
  scene: {
    mode: "equity",
    type: "portfolio",
  },
  slug: "kelly-criterion-position-sizing",
  sourceId: "DeMicsbCEBe",
  steps: [
    {
      caption:
        "Players start with $100 and bet the same share of their money on every flip of a coin that wins 55%.",
      color: "gray",
      element: "axes",
    },
    {
      caption:
        "Each path is one player. At the Kelly bet of 10% most paths climb, but the swings are wild.",
      color: "blue",
      element: "paths",
      time: [0, 1],
    },
    {
      caption:
        "The median path is the typical player. Kelly picks the share that makes this grow fastest.",
      color: "gold",
      element: "median",
    },
    {
      caption:
        "Set the share to 20%: drawdowns deepen and the median sinks. Losses weigh more than gains.",
      color: "red",
      element: "drawdown",
    },
  ],
  summary:
    "Part 16 of Quant Finance from scratch. A coin wins 55% of the time at even money. Betting 10% of your money, the Kelly fraction (55% minus 45%), grows the typical player fastest; 20% leaves them below the start and 40% wipes almost everyone out.",
  tags: {
    instruments: ["portfolio"],
    regime: ["any"],
    risk: "none",
    timeframe: "years",
    topics: ["kelly criterion", "position sizing", "volatility drag"],
  },
  takeaways: [
    "For an even-money bet the Kelly fraction is your edge: 55% − 45% = 10%.",
    "Betting twice Kelly grows nothing: the typical player at 20% ended below $100.",
    "Even at Kelly the ride is wild, and real edges are never known exactly, so overestimating means overbetting.",
  ],
  title: "The Kelly criterion: how much to bet when the odds are on your side",
};
