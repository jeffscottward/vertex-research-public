// Lesson spec: Walk-forward optimization: a Sharpe landscape whose peaks move as regimes shift
import type { LessonSpecInput } from "../../../schema.ts";

export const spec = {
  caveats: [
    "The creator's landscape is described as more than two million real backtests; that claim is not checked here. This chart runs 64 backtests per window on a simulated spread.",
    "The spread's mean-reversion speed is made to drift on purpose; real regimes change in less regular ways.",
    "A Sharpe ratio over a few months is noisy, so part of each window's best cell is luck.",
    "Costs are a flat charge in bps per position change; no slippage, borrow fees or capacity limits.",
  ],
  course: "quantfinancetogo",
  formulas: ["walkForward", "sharpe", "zScore"],
  kind: "concept",
  params: [
    {
      default: 120,
      help: "Days of history each landscape is computed on; the window moves forward a quarter of its length per refit.",
      id: "window",
      label: "Rolling window",
      max: 250,
      min: 40,
      step: 10,
      unit: "days",
    },
    {
      default: 5,
      help: "Trading costs in basis points of the notional traded at every entry and exit.",
      id: "costBps",
      label: "Costs (bps)",
      max: 100,
      min: 0,
      step: 1,
    },
    {
      default: 1,
      help: "How far the spread's mean-reversion speed drifts over time; 0 keeps it constant.",
      id: "regimeShift",
      label: "Regime shift",
      max: 2,
      min: 0,
      step: 0.1,
      unit: "x",
    },
    {
      default: 11,
      help: "Same seed, same spread; change it to draw another history.",
      id: "seed",
      label: "Random seed",
      max: 999,
      min: 1,
      step: 1,
    },
  ],
  scene: {
    mode: "landscape",
    type: "quant",
  },
  slug: "walk-forward-sharpe-landscape",
  sourceId: "Dc-5trhCw-I",
  steps: [
    {
      caption:
        "Each point of the landscape is a full backtest of a mean-reversion rule on a simulated spread.",
      color: "gray",
      element: "axes",
    },
    {
      caption:
        "Height is the Sharpe ratio after costs, over the rule's two knobs: how far back it looks and how stretched the spread must be before it trades.",
      color: "violet",
      element: "surface",
    },
    {
      caption:
        "Red is every parameter choice that loses money once costs bite. The landscape is computed on a rolling window of history.",
      color: "violet",
      element: "surface",
      time: [0, 1],
    },
    {
      caption:
        "As regimes shift, old peaks sink and new ones surface: the best lookback keeps migrating.",
      color: "cyan",
      element: "optimum",
    },
    {
      caption:
        "The model trades the previous window's best choice, chasing the moving optimum and always slightly behind it.",
      color: "gold",
      element: "model",
      time: [0, 1],
    },
  ],
  summary:
    "A Sharpe landscape of a mean-reversion strategy over its two knobs, lookback and entry threshold. Most choices lose once costs bite, and the landscape keeps moving: it is computed on a rolling window, so peaks sink and new ones appear as regimes shift. Walk-forward optimization refits on recent history and trades the result, always slightly behind the optimum.",
  tags: {
    instruments: [],
    regime: ["regime-change"],
    risk: "none",
    timeframe: "months",
    topics: [
      "walk-forward",
      "backtesting",
      "sharpe ratio",
      "mean reversion",
      "overfitting",
    ],
  },
  takeaways: [
    "A strategy's parameters span a landscape of Sharpe ratios; once costs are counted, much of it loses money.",
    "The landscape is not fixed: on a rolling window of history, peaks sink and new ones surface as regimes shift.",
    "Walk-forward optimization refits on recent data and trades the result, so it always follows the optimum one step behind.",
    "Finding alpha looks like this honest, lagging search on moving ground, not a secret signal.",
  ],
  title:
    "Walk-forward optimization: a Sharpe landscape that moves with the regime",
} satisfies LessonSpecInput;
