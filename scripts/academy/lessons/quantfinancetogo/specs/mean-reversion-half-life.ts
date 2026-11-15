// Lesson spec: Mean reversion: a pull back to the average, its half-life and how to test it
import type { LessonSpecInput } from "../../../../../packages/academy/src/schema.ts";

export const spec = {
  caveats: [
    "Even pure chance often looks like a pull: in the creator's test 34% of pure random walks passed the usual -2 limit, and three months of a random walk typically showed a half-life of about 10 days.",
    "A 2016 study of 97 published return signals found returns on average 58% lower after publication (cited in the video, not verified here).",
    "The mean can move, an old pull can disappear, and a spread can widen further before it reverts.",
  ],
  course: "quantfinancetogo",
  formulas: ["ornsteinUhlenbeck", "randomWalk"],
  kind: "concept",
  params: [
    {
      default: 3,
      id: "start",
      label: "Start distance from mean",
      max: 10,
      min: -10,
      step: 0.5,
      unit: "pts",
    },
    {
      default: 10,
      help: "Days for half of the distance to disappear; shorter means a stronger pull back.",
      id: "halfLife",
      label: "Half-life",
      max: 250,
      min: 1,
      step: 1,
      unit: "days",
    },
    {
      default: 1,
      id: "vol",
      label: "Daily shock",
      max: 5,
      min: 0.1,
      step: 0.1,
      unit: "pts",
    },
    {
      default: 1008,
      help: "1,008 trading days is about four years.",
      id: "days",
      label: "Days simulated",
      max: 2000,
      min: 60,
      step: 12,
      unit: "days",
    },
    {
      default: 200,
      id: "paths",
      label: "Spreads",
      max: 2000,
      min: 1,
      step: 1,
    },
    {
      default: 5,
      help: "Same seed, same paths; change it to draw another run.",
      id: "seed",
      label: "Random seed",
      max: 999,
      min: 1,
      step: 1,
    },
  ],
  scene: {
    mode: "meanrev",
    type: "quant",
  },
  slug: "mean-reversion-half-life",
  sourceId: "DedydiLiCtv",
  steps: [
    {
      caption:
        "A simulated spread with a built-in half-life of 10 days, run for four years.",
      color: "gray",
      element: "axes",
    },
    {
      caption:
        "Each day a fixed fraction of the gap to the average closes, and a random shock is added.",
      color: "gray",
      element: "paths",
      time: [0, 1],
    },
    {
      caption: "The long-run average that the spread is pulled back toward.",
      color: "amber",
      element: "mean",
    },
    {
      caption:
        "The half-life is how long half of the gap takes to close; the shorter it is, the stronger the pull back.",
      color: "cyan",
      element: "halfLife",
    },
    {
      caption:
        "Expected distance left after t days: e^(-θt), with θ = ln 2 / half-life. Half is gone after 10 days, three quarters after 20.",
      color: "gold",
      element: "decay",
    },
    {
      caption:
        "Band: ±1 standard deviation. The z-score counts how many standard deviations the spread is from its average; a basic rule bets on a move back when it is large.",
      color: "violet",
      element: "band",
    },
  ],
  summary:
    "Mean reversion: a quantity far from its long-run average tends to drift back. Single stock prices behave like random walks, but spreads, ratios and rates often show a pull back. The simplest model shrinks the distance by a fixed share each day plus a random shock; the half-life is the time for half of it to disappear. Regressing today's change on yesterday's distance tests the pull.",
  tags: {
    instruments: [],
    regime: ["range"],
    risk: "none",
    timeframe: "days",
    topics: [
      "mean reversion",
      "half-life",
      "pairs trading",
      "z-score",
      "dickey-fuller",
    ],
  },
  takeaways: [
    "Mean reversion is a pull back toward a long-run average; it shows up more often in spreads, ratios and rates than in single stock prices.",
    "The simplest model shrinks the distance from the average by a fixed share each day plus a random shock; the half-life measures the strength of the pull.",
    "To test it, regress today's change on yesterday's distance: a negative slope means a pull back, judged against a strict t-statistic limit of about -3 rather than -2.",
    "In the video's simulation, a built-in half-life of 10 days was estimated at 9.5 days with a t-statistic of about -6, far beyond that limit.",
    "It pays only when the pull is genuine, large enough to cover costs and still present in data held out from testing.",
  ],
  title:
    "Mean reversion: a pull back to the average, its half-life and how to test it",
} satisfies LessonSpecInput;
