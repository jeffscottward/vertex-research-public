import type { LessonSpecInput } from "../../../../../packages/academy/src/schema.ts";

export const spec = {
  caveats: [
    "Simulated fat-tailed returns with assumed numbers, not market data; results change with the seed and the sample length.",
    "VaR trusts the past and the model behind it, and is meant for normal market conditions.",
    "One position over one day; real portfolio VaR also depends on correlations and the holding period.",
  ],
  course: "quantfinancetogo",
  formulas: ["valueAtRisk", "expectedShortfall"],
  kind: "concept",
  params: [
    {
      default: 1,
      help: "Typical one-day swing; both curves get this same volatility.",
      id: "dailyVol",
      label: "Daily volatility",
      max: 5,
      min: 0.2,
      step: 0.1,
      unit: "%",
    },
    {
      default: 3,
      help: "Lower = fatter tails. The reel uses 3.",
      id: "dof",
      label: "Degrees of freedom (t)",
      max: 30,
      min: 2.5,
      step: 0.5,
    },
    {
      default: 99,
      id: "confidence",
      label: "Confidence level",
      max: 99.9,
      min: 90,
      step: 0.1,
      unit: "%",
    },
    {
      default: 25_200,
      help: "25,200 trading days = 100 years.",
      id: "days",
      label: "Simulated days",
      max: 25_200,
      min: 252,
      step: 252,
      unit: "days",
    },
    {
      default: 100_000,
      id: "position",
      label: "Position size",
      max: 10_000_000,
      min: 1000,
      step: 1000,
      unit: "$",
    },
    {
      default: 36,
      id: "seed",
      label: "Random path",
      max: 999,
      min: 1,
      step: 1,
    },
  ],
  scene: {
    mode: "tail",
    type: "quant",
  },
  slug: "value-at-risk-and-expected-shortfall",
  sourceId: "DeUlwIYikQz",
  steps: [
    {
      caption:
        "A simulated market: 100 years of trading days at about 1% a day, with fat tails",
      color: "gray",
      element: "axes",
    },
    {
      caption: "Many past days, sorted from the worst loss to the best gain",
      color: "cyan",
      element: "bars",
      seconds: 6,
      time: [0, 1],
    },
    {
      caption: "VaR 99%: the line where only 1 day in 100 is worse",
      color: "amber",
      element: "var",
    },
    {
      caption:
        "Past the line lies the worst 1% of days: VaR says where it begins, not how bad it gets",
      color: "red",
      element: "tail",
    },
    {
      caption:
        "Expected shortfall: the average loss on the days beyond the VaR line",
      color: "red",
      element: "es",
    },
    {
      caption:
        "A bell curve with the same swing puts its VaR line closer to zero, so it is crossed more often",
      color: "blue",
      element: "normal",
    },
    {
      caption:
        "The fat-tailed curve behind the simulation keeps far more weight beyond both lines",
      color: "violet",
      element: "fat",
    },
  ],
  summary:
    "Value at risk is the loss a portfolio should not exceed over a chosen period at a chosen confidence: a 2% one-day VaR at 99% means 99 days in 100 lose less than 2%. You sort past days and draw the line where only 1 day in 100 is worse. VaR says nothing about how bad those days get; expected shortfall, the average loss beyond the line, adds that.",
  tags: {
    instruments: ["portfolio"],
    regime: ["any"],
    risk: "none",
    timeframe: "days",
    topics: [
      "value at risk",
      "expected shortfall",
      "risk management",
      "fat tails",
    ],
  },
  takeaways: [
    "VaR is the loss you should not exceed over a chosen period at a chosen confidence, for example 2% over one day at 99%.",
    "Historical VaR: sort many past days and draw the line where only one day in a hundred is worse.",
    "VaR tells you where the worst day in a hundred begins and nothing about how bad that day gets.",
    "Expected shortfall is the average loss beyond the VaR line; bank supervisors moved toward it for market risk after the financial crisis.",
    "In the creator's fat-tailed simulation the bell-curve 99% line was crossed on 396 days instead of the promised 252.",
  ],
  title:
    "Value at risk and expected shortfall: the line and what lies beyond it",
} satisfies LessonSpecInput;
