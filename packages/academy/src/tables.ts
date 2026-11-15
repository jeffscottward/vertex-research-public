// What: Data tables for the interactive example: inputs, constants, legs and Greeks, risk summary,
// timeline, GEX, IV/RV and sizing. Values are display-ready strings so the web page and tests agree.
import { CONTRACT_MULTIPLIER, DAYS_PER_YEAR, expectedMove } from "./math.ts";
import {
  entryCost,
  legBreakdown,
  marketOf,
  num,
  type ParamValues,
  payoffSummary,
  positionAt,
  type ResolvedLeg,
  resolveLegs,
} from "./position.ts";
import { quantModel, quantTables } from "./quant/index.ts";
import { type DataTable, nth } from "./scene-kit.ts";
import {
  buildScene,
  effectiveHorizon,
  expectedPnl,
  gammaFlip,
  gexProfile,
  probabilityOfProfit,
  sizingPaths,
  usd,
  volPath,
} from "./scenes.ts";
import type { LessonSpec, Scene } from "./schema.ts";

const fixed = (value: number, digits = 2): string =>
  Number.isFinite(value) ? value.toFixed(digits) : "∞";
const pct = (value: number, digits = 1): string =>
  `${(value * 100).toFixed(digits)}%`;

const inputsTable = (
  lesson: Pick<LessonSpec, "params">,
  values: ParamValues
): DataTable => ({
  columns: ["Parameter", "Value", "Unit"],
  id: "inputs",
  rows: lesson.params.map((param) => [
    param.label,
    String(values[param.id] ?? param.default),
    param.unit ?? "",
  ]),
  title: "Inputs",
});

const quantConstantsTable = (
  scene: Extract<Scene, { type: "quant" }>
): DataTable => ({
  columns: ["Constant", "Value"],
  id: "constants",
  rows: [
    ["Model", quantModel(scene.mode)],
    ["Trading days per year", "252"],
    [
      "Random numbers",
      "Seeded generator (mulberry32): the same inputs and seed draw the same chart",
    ],
    ["Data", "Illustrative values. Not market data and not a forecast."],
  ],
  title: "Constants and model",
});

const constantsTable = (scene: Scene): DataTable =>
  scene.type === "quant"
    ? quantConstantsTable(scene)
    : optionConstantsTable(scene);

const optionConstantsTable = (scene: Scene): DataTable => ({
  columns: ["Constant", "Value"],
  id: "constants",
  rows: [
    ["Contract multiplier", String(CONTRACT_MULTIPLIER)],
    ["Days per year (time to expiry)", String(DAYS_PER_YEAR)],
    ["Trading days per year (realized vol)", "252"],
    [
      "Pricing model",
      scene.type === "portfolio"
        ? "Monte Carlo, fixed-fraction sizing"
        : "Black-Scholes, European exercise, no dividends",
    ],
    [
      "Volatility surface",
      "Flat implied volatility per leg (no skew unless a leg sets its own IV)",
    ],
    ["Data", "Illustrative values. Not market data and not a forecast."],
  ],
  title: "Constants and model",
});

const legsTable = (
  legs: readonly ResolvedLeg[],
  values: ParamValues,
  elapsed: number,
  title: string,
  id: string
): DataTable => {
  const market = marketOf(values);
  const rows = legBreakdown(legs, market.spot, elapsed, market.rate);
  const total = positionAt(legs, market.spot, elapsed, market.rate);
  return {
    columns: [
      "Leg",
      "Strike",
      "DTE left",
      "IV",
      "Entry",
      "Now",
      "P&L",
      "Delta",
      "Gamma",
      "Theta/day",
      "Vega/pt",
    ],
    id,
    note: "Option rows are per position (contracts x 100). Entry and Now are per share. Delta is in share equivalents.",
    rows: [
      ...rows.map((leg) => [
        leg.label,
        leg.strike === null ? "-" : fixed(leg.strike),
        leg.dte === null ? "-" : fixed(Math.max(leg.dte - elapsed, 0), 0),
        leg.vol === null ? "-" : pct(leg.vol, 0),
        fixed(leg.entry),
        fixed(leg.price),
        usd(leg.pnl),
        fixed(leg.delta, 1),
        fixed(leg.gamma, 3),
        fixed(leg.theta, 2),
        fixed(leg.vega, 2),
      ]),
      [
        "Net position",
        "",
        "",
        "",
        usd(entryCost(legs)),
        usd(total.value),
        usd(total.pnl),
        fixed(total.delta, 1),
        fixed(total.gamma, 3),
        fixed(total.theta, 2),
        fixed(total.vega, 2),
      ],
    ],
    title,
  };
};

const riskTable = (
  legs: readonly ResolvedLeg[],
  values: ParamValues,
  horizon: number
): DataTable => {
  const market = marketOf(values);
  const summary = payoffSummary(legs, market.spot, market.rate);
  const cost = entryCost(legs);
  const mu = market.rate + num(values, "drift", 0) / 100;
  const days = horizon;
  const pop = probabilityOfProfit(
    legs,
    market.spot,
    market.vol,
    days,
    mu,
    market.rate
  );
  const ev = expectedPnl(legs, market.spot, market.vol, days, mu, market.rate);
  const move = expectedMove(market.spot, market.vol, days);
  const rr =
    summary.maxProfit !== null &&
    summary.maxLoss !== null &&
    summary.maxLoss < 0
      ? summary.maxProfit / -summary.maxLoss
      : null;
  return {
    columns: ["Measure", "Value"],
    id: "risk",
    note: `POP and EV use a lognormal price with IV ${pct(market.vol, 0)} and drift ${pct(mu, 1)} (risk-free rate plus the excess-drift input). EV is net of the risk-free carry on the entry cash, so with zero excess drift a fairly priced structure (stock included) has EV of about zero; an edge needs a view that differs from the market.`,
    rows: [
      ["Entry", cost >= 0 ? `Debit ${usd(cost)}` : `Credit ${usd(-cost)}`],
      [
        "Max profit at expiry",
        summary.maxProfit === null ? "Unlimited" : usd(summary.maxProfit),
      ],
      [
        "Max loss at expiry",
        summary.maxLoss === null ? "Unlimited" : usd(summary.maxLoss),
      ],
      ["Reward : risk", rr === null ? "n/a" : `${fixed(rr)} : 1`],
      [
        "Breakevens",
        summary.breakevens.length === 0
          ? "None"
          : summary.breakevens.map((value) => fixed(value)).join(", "),
      ],
      [
        "Expected move (1σ) to expiry",
        `±${fixed(move)} (${pct(move / market.spot)})`,
      ],
      ["Probability of profit (model)", pct(pop)],
      ["Expected value (model)", usd(ev)],
    ],
    title: "Risk, reward and expected value",
  };
};

const timelineTable = (
  legs: readonly ResolvedLeg[],
  values: ParamValues,
  horizon: number
): DataTable => {
  const market = marketOf(values);
  const days = horizon;
  const checkpoints = [0, 0.25, 0.5, 0.75, 0.9, 1].map(
    (fraction) => fraction * days
  );
  return {
    columns: [
      "Day",
      "DTE left",
      "P&L if flat",
      "P&L at +1σ",
      "P&L at -1σ",
      "Theta/day",
      "Delta",
    ],
    id: "timeline",
    note: "±1σ uses the expected move from entry to that day at the input IV.",
    rows: checkpoints.map((day) => {
      const move = expectedMove(market.spot, market.vol, Math.max(day, 1));
      const flat = positionAt(legs, market.spot, day, market.rate);
      return [
        fixed(day, 0),
        fixed(days - day, 0),
        usd(flat.pnl),
        usd(positionAt(legs, market.spot + move, day, market.rate).pnl),
        usd(positionAt(legs, market.spot - move, day, market.rate).pnl),
        fixed(flat.theta, 2),
        fixed(flat.delta, 1),
      ];
    }),
    title: "Timeline: P&L by day and price",
  };
};

const ivrvTables = (values: ParamValues, now: number): DataTable[] => {
  const path = volPath(values);
  const index = Math.min(Math.max(Math.round(now), 0), path.price.length - 1);
  const iv = nth(path.iv, index);
  const rv = nth(path.rv, index);
  const price = nth(path.price, index);
  const richDays = path.iv.filter(
    (value, day) => value > nth(path.rv, day)
  ).length;
  return [
    {
      columns: ["Measure", "Value"],
      id: "ivrv",
      note: "Simulated path with stochastic volatility. IV is modeled as a blend of recent and long-run volatility plus the premium input.",
      rows: [
        ["Price", fixed(price)],
        ["Implied vol (IV)", pct(iv)],
        ["Realized vol (RV20)", pct(rv)],
        ["IV - RV", `${fixed((iv - rv) * 100, 1)} pts`],
        ["IV / RV", fixed(rv > 0 ? iv / rv : 0)],
        ["30-day move priced by IV", `±${fixed(expectedMove(price, iv, 30))}`],
        ["30-day move at RV", `±${fixed(expectedMove(price, rv, 30))}`],
        [
          "Days with IV > RV",
          `${richDays} of ${path.iv.length} (${pct(richDays / path.iv.length, 0)})`,
        ],
      ],
      title: `Volatility on day ${index}`,
    },
  ];
};

const gexTables = (values: ParamValues, elapsed: number): DataTable[] => {
  const market = marketOf(values);
  const rows = gexProfile(values, elapsed);
  const near = rows.filter(
    (row) => Math.abs(row.strike - market.spot) <= market.spot * 0.08
  );
  const total = rows.reduce((sum, row) => sum + row.net, 0);
  const flip = gammaFlip(values, elapsed);
  return [
    {
      columns: ["Measure", "Value"],
      id: "gex-summary",
      note: "Open interest is modeled from the call-wall and put-wall inputs. Convention (as in the chart): dealers long calls (+GEX) and short puts (-GEX), the usual customers-sell-calls, buy-puts positioning.",
      rows: [
        ["Spot", fixed(market.spot)],
        ["Total net GEX ($M per 1%)", fixed(total / 1e6, 1)],
        ["Gamma flip level", flip === null ? "None in range" : fixed(flip)],
        [
          "Regime",
          total >= 0
            ? "Positive gamma: dealer hedging dampens moves"
            : "Negative gamma: dealer hedging amplifies moves",
        ],
        ["DTE left", fixed(Math.max(num(values, "dte", 30) - elapsed, 0), 0)],
      ],
      title: "Gamma exposure summary",
    },
    {
      columns: [
        "Strike",
        "Call OI",
        "Put OI",
        "Call GEX $M",
        "Put GEX $M",
        "Net $M",
      ],
      id: "gex",
      rows: near.map((row) => [
        fixed(row.strike),
        fixed(row.callOi, 0),
        fixed(row.putOi, 0),
        fixed(row.callGex / 1e6, 2),
        fixed(row.putGex / 1e6, 2),
        fixed(row.net / 1e6, 2),
      ]),
      title: "GEX by strike (near spot)",
    },
  ];
};

const portfolioTables = (
  scene: Extract<Scene, { type: "portfolio" }>,
  values: ParamValues
): DataTable[] => {
  if (scene.mode === "recovery")
    return [
      {
        columns: ["Loss", "Gain needed"],
        id: "recovery",
        rows: [10, 20, 25, 33, 40, 50, 60, 75, 90].map((loss) => [
          `${loss}%`,
          `${fixed((1 / (1 - loss / 100) - 1) * 100, 1)}%`,
        ]),
        title: "Loss and the gain needed to recover",
      },
    ];
  if (scene.mode === "allocation") {
    const core = num(values, "corePct", 70);
    const options = num(values, "optionsPct", 10);
    return [
      {
        columns: ["Sleeve", "Weight", "Worst case"],
        id: "allocation",
        rows: [
          ["Core holdings", `${core}%`, `Market loss x ${core}%`],
          [
            "Options sleeve",
            `${options}%`,
            `-${options}% of portfolio (premium lost)`,
          ],
          ["Cash", `${Math.max(100 - core - options, 0)}%`, "0%"],
        ],
        title: "Allocation and maximum loss",
      },
    ];
  }
  const result = sizingPaths(values);
  const finals = result.paths
    .map((path) => nth(path, -1))
    .sort((a, b) => a - b);
  const capital = nth(result.median, 0);
  const ruined = result.paths.filter((path) =>
    path.some((value) => value < capital * 0.5)
  ).length;
  return [
    {
      columns: ["Measure", "Value"],
      id: "sizing",
      note: "Fixed-fraction sizing: each trade risks the input percent of current equity.",
      rows: [
        ["Kelly fraction f*", pct(result.kelly)],
        ["Risk per trade", `${num(values, "riskPct", 2)}%`],
        ["Median final equity", usd(nth(result.median, -1))],
        ["Worst final equity", usd(nth(finals, 0))],
        ["Best final equity", usd(nth(finals, -1))],
        ["Median max drawdown", `${fixed(Math.min(...result.drawdown), 1)}%`],
        [
          "Paths that fell below 50% of capital",
          `${ruined} of ${result.paths.length}`,
        ],
      ],
      title: "Sizing outcome (24 simulated paths)",
    },
  ];
};

const moveTable = (values: ParamValues): DataTable => {
  const market = marketOf(values);
  return {
    columns: ["Days", "1σ move", "1σ move %", "2σ range"],
    id: "expected-move",
    note: `IV ${pct(market.vol, 0)}. Four times the days gives two times the move.`,
    rows: [1, 7, 30, 60, 90, 180, 365].map((days) => {
      const move = expectedMove(market.spot, market.vol, days);
      return [
        String(days),
        `±${fixed(move)}`,
        `±${pct(move / market.spot)}`,
        `${fixed(market.spot - 2 * move)} - ${fixed(market.spot + 2 * move)}`,
      ];
    }),
    title: "Expected move grows with the square root of time",
  };
};

/** All data tables for a lesson at param values and time fraction t. */
export const buildTables = (
  lesson: Pick<LessonSpec, "params" | "scene">,
  values: ParamValues,
  t: number
): DataTable[] => {
  const scene = buildScene(lesson, values, t);
  const tables: DataTable[] = [
    inputsTable(lesson, values),
    constantsTable(lesson.scene),
  ];
  const spec = lesson.scene;
  if (spec.type === "quant")
    return [...tables, ...quantTables(spec.mode, values, t)];
  if (spec.type === "ivrv")
    return [...tables, ...ivrvTables(values, scene.now)];
  if (spec.type === "gex") return [...tables, ...gexTables(values, scene.now)];
  if (spec.type === "portfolio")
    return [...tables, ...portfolioTables(spec, values)];
  if (spec.type === "compare") {
    const a = resolveLegs(spec.a.legs, values);
    const b = resolveLegs(spec.b.legs, values);
    return [
      ...tables,
      legsTable(
        a,
        values,
        scene.now,
        `${spec.a.label}: legs and Greeks`,
        "legs-a"
      ),
      legsTable(
        b,
        values,
        scene.now,
        `${spec.b.label}: legs and Greeks`,
        "legs-b"
      ),
      {
        // Each side at its own expiry: a shared (shorter) horizon would mislabel POP/EV/move.
        ...riskTable(a, values, effectiveHorizon(a, values)),
        id: "risk-a",
        title: `${spec.a.label}: risk and EV`,
      },
      {
        ...riskTable(b, values, effectiveHorizon(b, values)),
        id: "risk-b",
        title: `${spec.b.label}: risk and EV`,
      },
    ];
  }
  const legs = resolveLegs(spec.legs, values);
  if (legs.length === 0)
    return spec.type === "distribution"
      ? [...tables, moveTable(values)]
      : tables;
  return [
    ...tables,
    legsTable(legs, values, scene.now, "Legs and Greeks", "legs"),
    riskTable(legs, values, scene.horizon),
    timelineTable(legs, values, scene.horizon),
  ];
};
