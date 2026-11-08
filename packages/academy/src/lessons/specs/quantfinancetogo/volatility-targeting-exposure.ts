import type { LessonSpecInput } from "../../../schema.ts";

export const spec = {
  caveats: [
    "Simulated GARCH asset with an assumed drift, not market data; the outcome changes with the seed.",
    "No trading costs, no interest on borrowed money and daily rebalancing are assumed.",
    "The 2x cap and the 5% drift are illustrative inputs; the reel gives no numbers for them.",
  ],
  course: "quantfinancetogo",
  formulas: ["volTarget", "garch"],
  kind: "concept",
  params: [
    {
      default: 10,
      help: "Per year; the reel's example uses 10%.",
      id: "targetVol",
      label: "Target volatility",
      max: 40,
      min: 2,
      step: 0.5,
      unit: "%",
    },
    {
      default: 2,
      help: "Illustrative cap; the reel names no number.",
      id: "maxLeverage",
      label: "Exposure cap",
      max: 5,
      min: 0.5,
      step: 0.1,
      unit: "x",
    },
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
      label: "GARCH alpha",
      max: 0.3,
      min: 0,
      step: 0.01,
    },
    {
      default: 0.85,
      id: "beta",
      label: "GARCH beta",
      max: 0.99,
      min: 0.5,
      step: 0.01,
    },
    {
      default: 5,
      help: "Illustrative average return per year.",
      id: "drift",
      label: "Drift",
      max: 20,
      min: -20,
      step: 0.5,
      unit: "%",
    },
    {
      default: 2520,
      id: "days",
      label: "Simulated days",
      max: 2520,
      min: 252,
      step: 252,
      unit: "days",
    },
    {
      default: 1,
      id: "seed",
      label: "Random path",
      max: 999,
      min: 1,
      step: 1,
    },
  ],
  scene: {
    mode: "voltarget",
    type: "quant",
  },
  slug: "volatility-targeting-exposure",
  sourceId: "DfU7H28RDtA",
  steps: [
    {
      caption:
        "Ten simulated years of a GARCH market at about 1% a day, roughly 16% a year",
      color: "gray",
      element: "axes",
    },
    {
      caption:
        "GARCH forecast volatility: it jumps after big moves and drifts back in calm weeks",
      color: "violet",
      element: "forecast",
      seconds: 6,
      time: [0, 1],
    },
    {
      caption:
        "Your target: 10% a year. When the forecast is above it, you hold less than all your money",
      color: "amber",
      element: "target",
    },
    {
      caption:
        "Exposure = target / forecast, capped: a 20% forecast means 50% of your money in the market",
      color: "blue",
      element: "exposure",
    },
    {
      caption: "Buy and hold rides every storm at full size",
      color: "gray",
      element: "hold",
    },
    {
      caption:
        "Volatility targeted: realized volatility lands near the 10% target (see the table)",
      color: "gold",
      element: "targeted",
      seconds: 6,
      time: [0, 1],
    },
  ],
  summary:
    "Volatility targeting compares a volatility forecast with a risk target you choose. With a 10% target and a 20% forecast you hold 10 / 20 = 50% of your money in the market, so your risk stays near 10%. When the forecast is below the target the rule asks for more than 100%, which means borrowing, so exposure gets a cap. A GARCH forecast drives the rule here.",
  tags: {
    instruments: ["portfolio", "volatility"],
    regime: ["any", "high-vol"],
    risk: "none",
    timeframe: "years",
    topics: ["volatility targeting", "position sizing", "garch", "risk budget"],
  },
  takeaways: [
    "Volatility targeting sets exposure = target volatility / forecast volatility.",
    "Target 10% and forecast 20%: hold 50% of your money in the market, so your risk stays at about 10%.",
    "When the forecast is below the target the rule asks for more than 100%, which means borrowing, so exposure usually gets a cap.",
    "Every forecast looks back: a sudden crash after a calm stretch still hits a full position.",
  ],
  title:
    "Volatility targeting: exposure equals target vol divided by forecast vol",
} satisfies LessonSpecInput;
