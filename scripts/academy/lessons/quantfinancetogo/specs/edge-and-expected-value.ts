// Lesson spec: Edge: a small expected value that turns into near certainty over many bets
import type { LessonSpecInput } from "../../../../../packages/academy/src/schema.ts";

export const spec = {
  caveats: [
    "The video's numbers come from the creator's seeded roulette simulation; this chart reruns the model with its own seed, so its counts differ.",
    "Education only: for the player the edge is negative, which is why gambling loses over time.",
  ],
  course: "quantfinancetogo",
  formulas: ["expectedValue", "randomWalk", "sqrtTime"],
  kind: "concept",
  params: [
    {
      default: 1000,
      id: "steps",
      label: "Spins per player",
      max: 5000,
      min: 10,
      step: 10,
      unit: "trades",
    },
    {
      default: -0.027,
      help: "Red wins 18 of 37 pockets: (18 - 19) / 37 = -0.027 per $1 for the player, +0.027 for the casino.",
      id: "drift",
      label: "Edge per $1 bet (EV)",
      max: 0.2,
      min: -0.2,
      step: 0.001,
      unit: "$",
    },
    {
      default: 1,
      help: "Each spin pays +bet or -bet.",
      id: "stepVol",
      label: "Bet size",
      max: 10,
      min: 1,
      step: 1,
      unit: "$",
    },
    {
      default: 1000,
      id: "paths",
      label: "Players",
      max: 1000,
      min: 10,
      step: 10,
    },
    {
      default: 7,
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
  slug: "edge-and-expected-value",
  sourceId: "Ddqpd2CCPjW",
  steps: [
    {
      caption:
        "A bet on red wins 18 of 37 spins and pays +$1 or -$1: the expected value is -2.7 cents per bet.",
      color: "gray",
      element: "axes",
    },
    {
      caption:
        "1,000 players spin 1,000 times each. A balance jumps around, and the balances spread out like stock charts.",
      color: "gray",
      element: "paths",
      time: [0, 1],
    },
    {
      caption:
        "The expected line falls 2.7 cents per spin: -$27 after 1,000 spins. That small edge is the casino's.",
      color: "gold",
      element: "mean",
    },
    {
      caption:
        "Luck scales with the square root of the bet count: ±$31.6 after 1,000 spins. Past roughly 1,400 bets, edge outweighs luck.",
      color: "violet",
      element: "band",
    },
    {
      caption:
        "Final balances: in the video 181 of 1,000 players walked away with a profit (green bins); the rest lost (red bins).",
      color: "red",
      element: "bars",
    },
    {
      caption:
        "The bell N(nμ, σ√n) fits the results. Across 1 million bets the casino earned $27,288, within 1% of the expected $27,027.",
      color: "violet",
      element: "pdf",
    },
  ],
  summary:
    "Roulette as the first quant lesson: a bet on red wins 18 of 37 spins, so its expected value is -2.7 cents per $1. Single players swing widely (181 of 1,000 ended ahead after 1,000 spins), but the casino's profit on a million bets lands within 1% of the expected $27,027, because the edge grows with every bet while luck grows only with the square root of the number of bets.",
  tags: {
    instruments: [],
    regime: ["any"],
    risk: "none",
    timeframe: "days",
    topics: [
      "expected value",
      "edge",
      "law of large numbers",
      "random walk",
      "square root rule",
    ],
  },
  takeaways: [
    "An edge is a small positive expected value: a bet on red loses 2.7 cents per $1 on average, which is the casino's 2.7-cent edge.",
    "One outcome proves almost nothing: a player who was up $11 after 47 spins still finished $22 behind.",
    "Edge adds up bet by bet, while luck scales only with the square root of the bet count; past roughly 1,400 bets, edge wins.",
    "Insurers, market makers and quant funds all hunt for a small edge and then apply it thousands of times over.",
    "An edge only pays if you survive the swings: even the casino was $44 down after its first 2,000 bets.",
  ],
  title:
    "Edge: a small expected value that turns into near certainty over many bets",
} satisfies LessonSpecInput;
