// What: Scene and table builders of the testing quant modes (backtest overfitting and significance testing). Seeded, computed data only.
// Sharpe estimates are drawn from their sampling distribution (an annual Sharpe estimated from T years
// of data has standard error ≈ 1/√T), so no daily backtests are run.
import { gaussian, mulberry32, normCdf, normPdf } from "../math.ts";
import { num, type ParamValues } from "../position.ts";
import {
  type DataTable,
  grid,
  type Marker,
  type Panel,
  type SceneCtx,
  type SceneData,
  span,
} from "../scene-kit.ts";
import type { TestingMode } from "./testing-ids.ts";

const fixed = (value: number, digits = 2): string => value.toFixed(digits);
const pct = (value: number, digits = 1): string =>
  `${(value * 100).toFixed(digits)}%`;

/** Most rule dots drawn in the in-sample vs out-of-sample panel (keeps the chart light). */
const MAX_DOTS = 300;

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

/** Standard error of an annual Sharpe ratio estimated from `years` of data (true Sharpe near 0). */
const sharpeError = (years: number): number => 1 / Math.sqrt(years);

/**
 * Expected best Sharpe among n zero-edge rules: σ_SR · Φ⁻¹((n − 0.375)/(n + 0.25)), Blom's
 * approximation of the expected maximum of n standard normals (within about 0.03 of exact for
 * every n; Φ⁻¹(1 − 1/n) would be 0.18 too low at n = 100). 0 for a single rule.
 * Declared after normInv is defined below; arrow functions resolve it at call time.
 */
export const expectedMaxSharpe = (n: number, sigma: number): number =>
  n <= 1 ? 0 : sigma * normInv((n - 0.375) / (n + 0.25));

/** Large-N upper bound on the best of n zero-edge rules: σ_SR · √(2 ln n). */
export const maxSharpeUpperBound = (n: number, sigma: number): number =>
  sigma * Math.sqrt(2 * Math.log(Math.max(n, 1)));

/** Two-sided p-value of a t-statistic under a normal null. */
export const pValue = (t: number): number => 2 * (1 - normCdf(Math.abs(t)));

/** Inverse standard normal CDF by bisection (p in (0, 1)). */
export const normInv = (p: number): number => {
  let low = -10;
  let high = 10;
  for (let step = 0; step < 80; step += 1) {
    const mid = (low + high) / 2;
    if (normCdf(mid) < p) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
};

/** Significance level: the `alpha` param is in percent (5 → 0.05). */
const alphaOf = (values: ParamValues): number =>
  clamp(num(values, "alpha", 5), 0.1, 50) / 100;

type SnoopInputs = Readonly<{ rules: number; years: number; seed: number }>;

const snoopInputs = (values: ParamValues): SnoopInputs => ({
  rules: Math.round(clamp(num(values, "rules", 100), 1, 2000)),
  seed: Math.round(num(values, "seed", 7)),
  years: clamp(num(values, "years", 5), 0.25, 50),
});

type Rule = Readonly<{ inSample: number; outSample: number }>;

export type Snooping = Readonly<{
  sigma: number;
  rules: readonly Rule[];
  /** Index of the rule with the best in-sample Sharpe. */
  bestIndex: number;
  /** Running best in-sample Sharpe after n rules (index n - 1). */
  runningBest: readonly number[];
}>;

/** Seeded zero-edge rules: in-sample and out-of-sample Sharpe estimates are independent N(0, σ_SR). */
export const snoopingModel = (inputs: SnoopInputs): Snooping => {
  const random = mulberry32(inputs.seed);
  const sigma = sharpeError(inputs.years);
  const rules: Rule[] = [];
  const runningBest: number[] = [];
  let bestIndex = 0;
  for (let index = 0; index < inputs.rules; index += 1) {
    const rule = {
      inSample: sigma * gaussian(random),
      outSample: sigma * gaussian(random),
    };
    rules.push(rule);
    if (rule.inSample > (rules[bestIndex] as Rule).inSample) bestIndex = index;
    runningBest.push((rules[bestIndex] as Rule).inSample);
  }
  return { bestIndex, rules, runningBest, sigma };
};

/** Log-spaced rule counts 1..n (unique integers, always ending at n). */
const countGrid = (n: number): number[] => {
  const counts = grid(0, Math.log(n), 14).map((x) => Math.round(Math.exp(x)));
  return [...new Set([...counts, n])].sort((a, b) => a - b);
};

const correlation = (rules: readonly Rule[]): number => {
  const n = rules.length;
  if (n < 2) return 0;
  const mx = rules.reduce((sum, rule) => sum + rule.inSample, 0) / n;
  const my = rules.reduce((sum, rule) => sum + rule.outSample, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const rule of rules) {
    sxy += (rule.inSample - mx) * (rule.outSample - my);
    sxx += (rule.inSample - mx) ** 2;
    syy += (rule.outSample - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
};

const snoopingScene = (ctx: SceneCtx): SceneData => {
  const inputs = snoopInputs(ctx.values);
  const model = snoopingModel(inputs);
  // Time sweeps the rules tested so far on a log scale: 1 rule at t = 0, all N at t = 1.
  const tested = Math.max(1, Math.round(inputs.rules ** clamp(ctx.t, 0, 1)));
  const bestNow = model.runningBest[tested - 1] as number;
  const counts = countGrid(inputs.rules).filter((n) => n <= tested);
  const xMax = Math.max(inputs.rules, 2);
  const curve = grid(1, xMax, 60).map(
    (n) => [n, expectedMaxSharpe(n, model.sigma)] as const
  );
  const bestDots: Marker[] = counts.map((n) => ({
    element: "best",
    kind: "dot",
    label: `best of ${n}`,
    x: n,
    y: model.runningBest[n - 1] as number,
  }));
  const growth: Panel = {
    bars: [],
    elements: ["axes", "curve", "best", "marker"],
    id: "best-vs-n",
    markers: [
      ...bestDots,
      {
        element: "marker",
        kind: "dot",
        label: `N = ${tested}: best ${fixed(bestNow)}`,
        x: tested,
        y: bestNow,
      },
    ],
    series: [
      {
        element: "curve",
        label: "Expected best ≈ σ·Φ⁻¹((N − 0.375)/(N + 0.25))",
        points: curve,
        revealTo: tested,
      },
    ],
    title: "Best in-sample Sharpe vs rules tested (no true edge)",
    xDomain: [1, xMax],
    xFormat: "count",
    xLabel: "Rules tested N",
    yDomain: span([0, ...curve.map((p) => p[1]), ...model.runningBest]),
    yFormat: "num",
    yLabel: "Best in-sample Sharpe",
  };
  const sofar = model.rules.slice(0, tested);
  const shown = sofar.slice(0, MAX_DOTS);
  let bestSoFar = 0;
  sofar.forEach((rule, index) => {
    if (rule.inSample > (sofar[bestSoFar] as Rule).inSample) bestSoFar = index;
  });
  const best = sofar[bestSoFar] as Rule;
  const all = model.rules.flatMap((rule) => [rule.inSample, rule.outSample]);
  const domain = span([...all, 0]);
  const scatter: Panel = {
    bars: [],
    elements: ["axes", "points", "zero", "marker"],
    id: "in-vs-out",
    markers: [
      ...shown.map(
        (rule): Marker => ({
          element: "points",
          kind: "dot",
          label: "",
          x: rule.inSample,
          y: rule.outSample,
        })
      ),
      {
        element: "zero",
        kind: "hline",
        label: "zero: no edge out of sample",
        y: 0,
      },
      {
        element: "marker",
        kind: "dot",
        label: `best rule out of sample ${fixed(best.outSample)}`,
        x: best.inSample,
        y: best.outSample,
      },
    ],
    series: [],
    title: "In-sample vs out-of-sample Sharpe of every rule",
    xDomain: domain,
    xFormat: "num",
    xLabel: "In-sample Sharpe",
    yDomain: domain,
    yFormat: "num",
    yLabel: "Out-of-sample Sharpe",
  };
  return {
    horizon: inputs.rules,
    layout: "stack",
    now: tested,
    panels: [growth, scatter],
    timeLabel: "Rules tested",
    timeUnit: "trades",
  };
};

type SigInputs = Readonly<{ sharpe: number; years: number; alpha: number }>;

const sigInputs = (values: ParamValues): SigInputs => ({
  alpha: alphaOf(values),
  sharpe: clamp(num(values, "sharpe", 1), -5, 5),
  years: clamp(num(values, "years", 5), 0.25, 50),
});

export type Significance = Readonly<{
  t: number;
  p: number;
  critical: number;
  se: number;
  yearsNeeded: number;
}>;

export const significanceModel = (inputs: SigInputs): Significance => {
  const t = inputs.sharpe * Math.sqrt(inputs.years);
  const critical = normInv(1 - inputs.alpha / 2);
  return {
    critical,
    p: pValue(t),
    se: sharpeError(inputs.years),
    t,
    yearsNeeded:
      inputs.sharpe === 0
        ? Number.POSITIVE_INFINITY
        : (critical / inputs.sharpe) ** 2,
  };
};

/** Years of data used at time t: sweeps from near 0 to the chosen years. */
const yearsAt = (inputs: SigInputs, t: number): SigInputs => ({
  ...inputs,
  years: Math.max(inputs.years * clamp(t, 0, 1), 0.05),
});

const significanceScene = (ctx: SceneCtx): SceneData => {
  const chosen = sigInputs(ctx.values);
  const inputs = yearsAt(chosen, ctx.t);
  const model = significanceModel(inputs);
  const yMax = Math.max(chosen.years * 2, 10);
  const curve = grid(0, yMax, 80).map(
    (y) => [y, inputs.sharpe * Math.sqrt(y)] as const
  );
  const tPanel: Panel = {
    bars: [],
    elements: ["axes", "curve", "threshold", "marker"],
    id: "t-vs-years",
    markers: [
      {
        element: "threshold",
        kind: "hline",
        label: `t = ${fixed(model.critical)} (α = ${pct(inputs.alpha)})`,
        y: model.critical,
      },
      {
        element: "marker",
        kind: "dot",
        label: `${fixed(inputs.years, 1)} years: t = ${fixed(model.t)}`,
        x: inputs.years,
        y: model.t,
      },
    ],
    series: [{ element: "curve", label: "t = SR·√years", points: curve }],
    title: "t-statistic grows with the square root of years",
    xDomain: [0, yMax],
    xFormat: "count",
    xLabel: "Years of data",
    yDomain: span([0, model.critical, ...curve.map((p) => p[1])]),
    yFormat: "num",
    yLabel: "t-statistic",
  };
  const reach = Math.max(4 * model.se, Math.abs(inputs.sharpe) * 1.2);
  const pdf = grid(-reach, reach, 121).map(
    (x) => [x, normPdf(x / model.se) / model.se] as const
  );
  const edge = Math.abs(inputs.sharpe);
  const nullPanel: Panel = {
    bars: [],
    elements: ["axes", "pdf", "observed", "pvalue"],
    id: "null-distribution",
    markers: [
      {
        element: "pvalue",
        kind: "band",
        label: `p = ${pct(model.p)}`,
        x: edge,
        x2: reach,
      },
      {
        element: "pvalue",
        kind: "band",
        label: "lower tail",
        x: -reach,
        x2: -edge,
      },
      {
        element: "observed",
        kind: "vline",
        label: `observed SR ${fixed(inputs.sharpe)}`,
        x: inputs.sharpe,
      },
    ],
    series: [
      {
        element: "pdf",
        fill: true,
        label: "Estimated Sharpe if true Sharpe = 0",
        points: pdf,
      },
    ],
    title: "Sampling distribution of the Sharpe estimate under the null",
    xDomain: [-reach, reach],
    xFormat: "num",
    xLabel: "Estimated annual Sharpe",
    yDomain: [0, (normPdf(0) / model.se) * 1.1],
    yFormat: "num",
    yLabel: "Density",
  };
  return {
    horizon: 100,
    layout: "stack",
    now: clamp(ctx.t, 0, 1) * 100,
    panels: [tPanel, nullPanel],
    timeLabel: `Share of ${fixed(chosen.years, 1)} years used`,
    timeUnit: "pct",
  };
};

/** Scene of one testing mode at param values and time fraction ctx.t. */
export const testingScene = (mode: TestingMode, ctx: SceneCtx): SceneData =>
  mode === "snooping" ? snoopingScene(ctx) : significanceScene(ctx);

const snoopingTables = (values: ParamValues): DataTable[] => {
  const inputs = snoopInputs(values);
  const model = snoopingModel(inputs);
  const best = model.rules[model.bestIndex] as Rule;
  const n = model.rules.length;
  const meanOut =
    model.rules.reduce((sum, rule) => sum + rule.outSample, 0) / n;
  const passing = model.rules.filter(
    (rule) => rule.inSample * Math.sqrt(inputs.years) > 1.96
  ).length;
  return [
    {
      columns: ["Quantity", "Value"],
      id: "snooping",
      note: "Every rule has a true Sharpe of 0; any in-sample winner is luck.",
      rows: [
        ["Rules tested N", String(n)],
        ["Sharpe standard error σ_SR = 1/√years", fixed(model.sigma, 3)],
        [
          "Expected best ≈ σ·Φ⁻¹((N − 0.375)/(N + 0.25))",
          fixed(expectedMaxSharpe(n, model.sigma)),
        ],
        [
          "Upper bound (large N) σ·√(2 ln N)",
          fixed(maxSharpeUpperBound(n, model.sigma)),
        ],
        ["Simulated best in-sample Sharpe", fixed(best.inSample)],
        ["That rule out of sample", fixed(best.outSample)],
        ["Mean out-of-sample Sharpe", fixed(meanOut)],
        ["Correlation in vs out of sample", fixed(correlation(model.rules))],
        ["Rules 'significant' at 5% in sample", String(passing)],
        ["Expected by luck (N × 2.5% one-sided)", fixed(n * 0.025, 1)],
      ],
      title: "Data snooping",
    },
  ];
};

const significanceTables = (values: ParamValues, t: number): DataTable[] => {
  const inputs = yearsAt(sigInputs(values), t);
  const model = significanceModel(inputs);
  const half = model.critical * model.se;
  return [
    {
      columns: ["Quantity", "Value"],
      id: "significance",
      note: "Null hypothesis: true Sharpe = 0. Two-sided normal test.",
      rows: [
        ["Years of data used", fixed(inputs.years, 2)],
        ["t-statistic = SR·√years", fixed(model.t)],
        ["p-value", pct(model.p)],
        ["Critical t", fixed(model.critical)],
        ["Significant", model.p < inputs.alpha ? "yes" : "no"],
        ["Standard error of SR", fixed(model.se, 3)],
        [
          `${pct(1 - inputs.alpha, 0)} interval for SR`,
          `${fixed(inputs.sharpe - half)} to ${fixed(inputs.sharpe + half)}`,
        ],
        [
          "Years needed to reach critical t",
          Number.isFinite(model.yearsNeeded)
            ? fixed(model.yearsNeeded, 1)
            : "∞",
        ],
      ],
      title: "Hypothesis test",
    },
  ];
};

/** Mode-specific data tables (the inputs and constants tables are added by tables.ts). */
export const testingTables = (
  mode: TestingMode,
  values: ParamValues,
  t: number
): DataTable[] =>
  mode === "snooping" ? snoopingTables(values) : significanceTables(values, t);
