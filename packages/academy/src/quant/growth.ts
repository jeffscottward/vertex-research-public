// What: Scene and table builders of the growth quant modes (returns, compounding and time value). Seeded, computed data only.
import { gaussian, mulberry32 } from "../math.ts";
import { num, type ParamValues } from "../position.ts";
import {
  clamp01,
  type DataTable,
  grid,
  nth,
  type Point,
  type SceneCtx,
  type SceneData,
  span,
  withZero,
} from "../scene-kit.ts";
import type { GrowthMode } from "./growth-ids.ts";

const bound = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);
const usd = (value: number): string => `$${value.toFixed(2)}`;
const pct = (value: number, digits = 1): string => `${value.toFixed(digits)}%`;

// ---------------------------------------------------------------- compound

type CompoundInputs = Readonly<{ amount: number; rate: number; years: number }>;

const compoundInputs = (values: ParamValues): CompoundInputs => ({
  amount: bound(num(values, "amount", 100), 0.01, 1e9),
  rate: bound(num(values, "rate", 5), 0, 100) / 100,
  years: Math.round(bound(num(values, "years", 10), 1, 100)),
});

const grow = ({ amount, rate }: CompoundInputs, years: number): number =>
  amount * (1 + rate) ** years;
const discount = (amount: number, rate: number, years: number): number =>
  amount / (1 + rate) ** years;

const compoundScene = (ctx: SceneCtx): SceneData => {
  const inputs = compoundInputs(ctx.values);
  const { amount, rate, years } = inputs;
  const now = years * clamp01(ctx.t);
  const xs = grid(0, years, 101);
  const curve = xs.map((x): Point => [x, grow(inputs, x)]);
  const pv = xs.map((x): Point => [x, discount(amount, rate, x)]);
  const rateMax = Math.max(20, rate * 200);
  const rates = grid(0, rateMax, 101).map(
    (x): Point => [x, discount(amount, x / 100, years)]
  );
  const pvAtRate = discount(amount, rate, years);
  return {
    horizon: years,
    layout: "stack",
    now,
    panels: [
      {
        bars: [],
        elements: ["axes", "curve", "discount", "marker"],
        id: "compound",
        markers: [
          {
            element: "marker",
            kind: "dot",
            label: `Year ${now.toFixed(1)}: grows to ${usd(grow(inputs, now))}`,
            x: now,
            y: grow(inputs, now),
          },
          {
            element: "marker",
            kind: "dot",
            label: `PV of ${usd(amount)} due in ${now.toFixed(1)}y: ${usd(discount(amount, rate, now))}`,
            x: now,
            y: discount(amount, rate, now),
          },
        ],
        series: [
          {
            element: "curve",
            label: `${usd(amount)} × (1 + r)^n`,
            points: curve,
            width: 3,
          },
          {
            dashed: true,
            element: "discount",
            label: `PV of ${usd(amount)} due in n years`,
            points: pv,
            width: 3,
          },
        ],
        title: "Compounding and its mirror, discounting",
        xDomain: [0, years],
        xFormat: "count",
        xLabel: "Years",
        yDomain: withZero(span([...curve, ...pv].map(([, y]) => y))),
        yFormat: "usd",
        yLabel: "Value ($)",
      },
      {
        bars: [],
        elements: ["rates"],
        id: "rates",
        markers: [
          {
            element: "rates",
            kind: "dot",
            label: `At ${pct(rate * 100)}: PV ${usd(pvAtRate)}`,
            x: rate * 100,
            y: pvAtRate,
          },
        ],
        series: [
          {
            element: "rates",
            label: `PV of ${usd(amount)} due in ${years}y`,
            points: rates,
            width: 3,
          },
        ],
        title: "The rate changes everything",
        xDomain: [0, rateMax],
        xFormat: "pct",
        xLabel: "Discount rate (%)",
        yDomain: withZero(span(rates.map(([, y]) => y))),
        yFormat: "usd",
        yLabel: "Present value ($)",
      },
    ],
    timeLabel: "Year",
    timeUnit: "days",
  };
};

const compoundTables = (values: ParamValues): DataTable[] => {
  const inputs = compoundInputs(values);
  const { amount, rate, years } = inputs;
  const stride = Math.ceil(years / 12);
  const shown = [
    ...new Set([
      ...grid(0, years, years + 1).filter((y) => y % stride === 0),
      years,
    ]),
  ];
  const rateRows = [...new Set([2, 5, 10, rate * 100])]
    .sort((a, b) => a - b)
    .map((r) => [pct(r), usd(discount(amount, r / 100, years))]);
  return [
    {
      columns: [
        "Year",
        "Grows to",
        "Simple interest only",
        "PV of amount due then",
      ],
      id: "compound-years",
      note: "Grows to = amount × (1 + r)^n. The gap to simple interest is interest on interest.",
      rows: shown.map((year) => [
        String(year),
        usd(grow(inputs, year)),
        usd(amount * (1 + rate * year)),
        usd(discount(amount, rate, year)),
      ]),
      title: "Compounding and discounting by year",
    },
    {
      columns: ["Discount rate", `PV of ${usd(amount)} in ${years}y`],
      id: "compound-rates",
      note: `Check: ${usd(discount(amount, rate, years))} grows back to ${usd(amount)} at ${pct(rate * 100)} over ${years} years.`,
      rows: rateRows,
      title: "Present value by discount rate",
    },
  ];
};

// ---------------------------------------------------------------- logreturns

type LogPath = Readonly<{
  prices: number[];
  simple: number[];
  log: number[];
}>;

const logInputs = (values: ParamValues) => ({
  days: Math.round(bound(num(values, "days", 252), 5, 2520)),
  down: bound(num(values, "downPct", 50), 1, 99),
  seed: Math.round(num(values, "seed", 120)),
  up: bound(num(values, "upPct", 100), 1, 1000),
  vol: bound(num(values, "vol", 2), 0.1, 20) / 100,
});

/** Seeded price path from normal daily log returns; cumulative simple and log return sums in %. */
export const logPath = (values: ParamValues): LogPath => {
  const { days, seed, vol } = logInputs(values);
  const random = mulberry32(seed);
  const prices = [100];
  const simple = [0];
  const log = [0];
  for (let day = 1; day <= days; day += 1) {
    const step = vol * gaussian(random);
    prices.push(nth(prices, -1) * Math.exp(step));
    simple.push(nth(simple, -1) + (Math.exp(step) - 1) * 100);
    log.push(nth(log, -1) + step * 100);
  }
  return { log, prices, simple };
};

const logScene = (ctx: SceneCtx): SceneData => {
  const { days } = logInputs(ctx.values);
  const { prices, simple, log } = logPath(ctx.values);
  const now = days * clamp01(ctx.t);
  const at = (values: number[]): Point[] =>
    values.map((value, day): Point => [day, value]);
  const actual = prices.map(
    (price, day): Point => [day, Math.log(price / 100) * 100]
  );
  return {
    horizon: days,
    layout: "stack",
    now,
    panels: [
      {
        bars: [],
        elements: ["axes", "price"],
        id: "price",
        markers: [],
        series: [
          {
            element: "price",
            label: "Simulated price",
            points: at(prices),
            revealTo: now,
            width: 2,
          },
        ],
        title: "Seeded price path",
        xDomain: [0, days],
        xFormat: "day",
        xLabel: "Day",
        yDomain: span(prices),
        yFormat: "usd",
        yLabel: "Price ($)",
      },
      {
        bars: [],
        elements: ["simple", "log", "actual"],
        id: "sums",
        markers: [],
        series: [
          {
            element: "simple",
            label: "Sum of daily % returns",
            points: at(simple),
            revealTo: now,
            width: 2,
          },
          {
            element: "log",
            label: "Sum of daily log returns (×100)",
            points: at(log),
            revealTo: now,
            width: 3,
          },
          {
            dashed: true,
            element: "actual",
            label: "Actual ln(P / P0) (×100)",
            points: actual,
            revealTo: now,
            width: 2,
          },
        ],
        title: "Percent returns do not add up; log returns do",
        xDomain: [0, days],
        xFormat: "day",
        xLabel: "Day",
        yDomain: withZero(span([...simple, ...log])),
        yFormat: "pct",
        yLabel: "Cumulative return (%)",
      },
    ],
    timeLabel: "Day",
    timeUnit: "days",
  };
};

const logTables = (values: ParamValues, t: number): DataTable[] => {
  const { days, down, up } = logInputs(values);
  const { prices, simple, log } = logPath(values);
  const day = Math.round(days * clamp01(t));
  const price = nth(prices, day);
  const afterDown = 100 * (1 - down / 100);
  const afterUp = afterDown * (1 + up / 100);
  const lnDown = Math.log(1 - down / 100);
  const lnUp = Math.log(1 + up / 100);
  return [
    {
      columns: ["Step", "Price", "% return", "Log return"],
      id: "logreturns-example",
      note: "Percent returns add to the wrong total; log returns add to ln(end / start).",
      rows: [
        ["Start", usd(100), "", ""],
        [`Down ${pct(down, 0)}`, usd(afterDown), pct(-down), lnDown.toFixed(3)],
        [`Up ${pct(up, 0)}`, usd(afterUp), pct(up), lnUp.toFixed(3)],
        [
          "Sum",
          `Actual ${pct(afterUp - 100)}`,
          pct(up - down),
          `${(lnDown + lnUp).toFixed(3)} (= ${pct((Math.exp(lnDown + lnUp) - 1) * 100)})`,
        ],
      ],
      title: "Down then up: the two ways to measure",
    },
    {
      columns: ["Measure", `Day ${day}`],
      id: "logreturns-path",
      rows: [
        ["Price", usd(price)],
        ["Sum of daily % returns", pct(nth(simple, day))],
        [
          "Sum of daily log returns, as %",
          pct((Math.exp(nth(log, day) / 100) - 1) * 100),
        ],
        ["Actual change P / P0 − 1", pct((price / 100 - 1) * 100)],
      ],
      title: "Simulated path so far",
    },
  ];
};

// ---------------------------------------------------------------- drag

const STEPS_PER_YEAR = 12;
const DRAWN_PATHS = 30;
const SIMULATED_PATHS = 400;

const dragInputs = (values: ParamValues) => ({
  mu: bound(num(values, "mu", 10), -50, 100) / 100,
  seed: Math.round(num(values, "seed", 9)),
  vol: bound(num(values, "vol", 50), 0, 150) / 100,
  years: Math.round(bound(num(values, "years", 30), 1, 100)),
});

/** Seeded GBM wealth paths (start $100) with arithmetic mean μ and volatility σ per year. */
export const dragPaths = (values: ParamValues): number[][] => {
  const { mu, seed, vol, years } = dragInputs(values);
  const random = mulberry32(seed);
  const dt = 1 / STEPS_PER_YEAR;
  const drift = (mu - (vol * vol) / 2) * dt;
  const shock = vol * Math.sqrt(dt);
  return Array.from({ length: SIMULATED_PATHS }, () => {
    const path = [100];
    for (let step = 1; step <= years * STEPS_PER_YEAR; step += 1)
      path.push(nth(path, -1) * Math.exp(drift + shock * gaussian(random)));
    return path;
  });
};

const growthRate = (mu: number, vol: number): number => mu - (vol * vol) / 2;

const dragScene = (ctx: SceneCtx): SceneData => {
  const { mu, vol, years } = dragInputs(ctx.values);
  const now = years * clamp01(ctx.t);
  const volMax = Math.max(80, vol * 100);
  const sigmas = grid(0, volMax, 81);
  const curve = sigmas.map((s): Point => [s, growthRate(mu, s / 100) * 100]);
  const g = growthRate(mu, vol);
  const times = grid(0, years, years * STEPS_PER_YEAR + 1);
  const drawn = dragPaths(ctx.values).slice(0, DRAWN_PATHS);
  const expected = times.map((x): Point => [x, 100 * Math.exp(mu * x)]);
  const median = times.map((x): Point => [x, 100 * Math.exp(g * x)]);
  return {
    horizon: years,
    layout: "stack",
    now,
    panels: [
      {
        bars: [],
        elements: ["axes", "mean", "curve", "marker"],
        id: "drag",
        markers: [
          {
            element: "marker",
            kind: "vline",
            label: `σ = ${pct(vol * 100, 0)}`,
            x: vol * 100,
          },
          {
            element: "marker",
            kind: "dot",
            label: `Growth ${pct(g * 100)} vs mean ${pct(mu * 100)}: drag ${pct((vol * vol * 100) / 2)}`,
            x: vol * 100,
            y: g * 100,
          },
        ],
        series: [
          {
            element: "mean",
            label: "Average return μ",
            points: [
              [0, mu * 100],
              [volMax, mu * 100],
            ],
            width: 3,
          },
          {
            element: "curve",
            label: "Growth rate μ − σ²/2",
            points: curve,
            width: 3,
          },
        ],
        title: "Average return vs the rate money compounds at",
        xDomain: [0, volMax],
        xFormat: "pct",
        xLabel: "Volatility σ (%)",
        yDomain: withZero(span([mu * 100, ...curve.map(([, y]) => y)])),
        yFormat: "pct",
        yLabel: "Return per year (%)",
      },
      {
        bars: [],
        elements: ["paths", "median"],
        id: "wealth",
        markers: [],
        series: [
          ...drawn.map((path, index) => ({
            element: "paths",
            label: index === 0 ? "Simulated wealth paths" : "",
            points: path.map((value, step): Point => [nth(times, step), value]),
            revealTo: now,
            width: 1,
          })),
          {
            dashed: true,
            element: "paths",
            label: "Expected (mean) wealth",
            points: expected,
            revealTo: now,
            width: 3,
          },
          {
            element: "median",
            label: "Median wealth",
            points: median,
            revealTo: now,
            width: 3,
          },
        ],
        title: `Wealth paths at σ = ${pct(vol * 100, 0)}`,
        xDomain: [0, years],
        xFormat: "count",
        xLabel: "Years",
        yDomain: withZero(
          span([nth(expected, -1)[1], nth(median, -1)[1], 100])
        ),
        yFormat: "usd",
        yLabel: "Wealth ($)",
      },
    ],
    timeLabel: "Year",
    timeUnit: "days",
  };
};

const dragTables = (values: ParamValues, t: number): DataTable[] => {
  const { mu, vol, years } = dragInputs(values);
  const step = Math.round(years * STEPS_PER_YEAR * clamp01(t));
  const year = step / STEPS_PER_YEAR;
  const column = dragPaths(values)
    .map((path) => nth(path, step))
    .sort((a, b) => a - b);
  const mean = column.reduce((sum, value) => sum + value, 0) / column.length;
  const below = column.filter((value) => value < 100).length;
  const g = growthRate(mu, vol);
  const comparisons = [...new Set([10, 50, vol * 100])].sort((a, b) => a - b);
  return [
    {
      columns: ["Volatility σ", "Average μ", "Drag σ²/2", "Growth μ − σ²/2"],
      id: "drag-rule",
      note: "+50% then −50% leaves (1 + s)(1 − s) = 1 − s²: $75 of $100.",
      rows: comparisons.map((s) => [
        pct(s, 0),
        pct(mu * 100),
        pct((s * s) / 200),
        pct(growthRate(mu, s / 100) * 100),
      ]),
      title: "The drag rule",
    },
    {
      columns: ["Measure", `Year ${year.toFixed(1)}`],
      id: "drag-wealth",
      note: `${SIMULATED_PATHS} seeded paths starting at $100.`,
      rows: [
        ["Expected wealth 100·e^(μt)", usd(100 * Math.exp(mu * year))],
        ["Simulated mean", usd(mean)],
        ["Median wealth 100·e^((μ − σ²/2)t)", usd(100 * Math.exp(g * year))],
        ["Simulated median", usd(nth(column, Math.floor(column.length / 2)))],
        ["Paths below $100", `${below} of ${column.length}`],
      ],
      title: "Mean vs median wealth",
    },
  ];
};

// ---------------------------------------------------------------- dispatch

/** Scene of one growth mode at param values and time fraction ctx.t. */
export const growthScene = (mode: GrowthMode, ctx: SceneCtx): SceneData =>
  mode === "compound"
    ? compoundScene(ctx)
    : mode === "logreturns"
      ? logScene(ctx)
      : dragScene(ctx);

/** Mode-specific data tables (the inputs and constants tables are added by tables.ts). */
export const growthTables = (
  mode: GrowthMode,
  values: ParamValues,
  t: number
): DataTable[] =>
  mode === "compound"
    ? compoundTables(values)
    : mode === "logreturns"
      ? logTables(values, t)
      : dragTables(values, t);
