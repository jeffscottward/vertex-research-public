import type { LessonSpecInput } from "../../../../../packages/academy/src/schema.ts";

export const spec = {
  caveats: [
    "The reel has no spoken explanation and gives no numbers; this lesson follows its caption with illustrative inputs.",
    "Simulated local-level model with normal, independent noise: far-off observations snap back here by construction; real prices need not.",
  ],
  course: "quantfinancetogo",
  formulas: ["kalman"],
  kind: "concept",
  params: [
    {
      default: 0.5,
      help: "Standard deviation of the hidden price's daily step.",
      id: "processNoise",
      label: "True price change per day",
      max: 5,
      min: 0.05,
      step: 0.05,
      unit: "$",
    },
    {
      default: 2,
      help: "Standard deviation of the noise on each observed price.",
      id: "measurementNoise",
      label: "Observation noise",
      max: 10,
      min: 0.1,
      step: 0.1,
      unit: "$",
    },
    {
      default: 2,
      help: "Fade when an observation is this many standard deviations from the prediction.",
      id: "threshold",
      label: "Fade threshold (std devs)",
      max: 5,
      min: 1,
      step: 0.1,
    },
    {
      default: 250,
      id: "days",
      label: "Days",
      max: 1000,
      min: 50,
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
    mode: "filter",
    type: "quant",
  },
  slug: "kalman-filter-noise-fade",
  sourceId: "Dc7IyDbiITE",
  steps: [
    {
      caption:
        "A simulated price: a hidden true value, and every observation adds noise",
      color: "gray",
      element: "axes",
    },
    {
      caption:
        "The faint line: the hidden true price, which you never see directly",
      color: "gray",
      element: "truth",
      seconds: 6,
      time: [0, 1],
    },
    {
      caption: "The jagged dots: what you observe, the truth plus noise",
      color: "cyan",
      element: "observed",
    },
    {
      caption:
        "The Kalman estimate tracks the truth: each observation moves the belief by how much it can be trusted",
      color: "gold",
      element: "filtered",
      seconds: 6,
      time: [0, 1],
    },
    {
      caption:
        "Kalman gain: the weight on each new observation, high while the belief is uncertain, then steady",
      color: "violet",
      element: "gain",
    },
    {
      caption:
        "Fade signals: observations that land outside the dashed band are bet against as noise",
      color: "red",
      element: "fades",
    },
  ],
  summary:
    "The price you see is truth plus noise. A Kalman filter carries a belief about the hidden price and updates it with every new observation in proportion to how trustworthy that observation is. When an observation lands far from the belief, the strategy in the reel fades it, betting on the noise rather than the trend.",
  tags: {
    instruments: ["single-stock"],
    regime: ["any", "range"],
    risk: "none",
    timeframe: "days",
    topics: ["kalman filter", "signal processing", "mean reversion", "noise"],
  },
  takeaways: [
    "The price you see is the hidden truth plus noise.",
    "A Kalman filter updates its belief with every observation in proportion to how trustworthy that observation is.",
    "When an observation lands absurdly far from the belief, the reel's strategy fades it, betting on the noise rather than the trend.",
  ],
  title: "Kalman filter: separating the true price from noise",
} satisfies LessonSpecInput;
