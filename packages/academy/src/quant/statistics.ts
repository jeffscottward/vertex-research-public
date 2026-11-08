// What: Scene and table builders of the statistics quant modes (regression and factor models). Seeded, computed data only.
import { gaussian, mulberry32, round } from "../math.ts";
import { num, type ParamValues } from "../position.ts";
import {
  type Bar,
  clamp01,
  type DataTable,
  type Marker,
  type Panel,
  type Point,
  type SceneCtx,
  type SceneData,
  span,
  withZero,
} from "../scene-kit.ts";
import type { StatisticsMode } from "./statistics-ids.ts";

const clampTo = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);

const sd = (values: readonly number[]): number => {
  const m = mean(values);
  const variance =
    values.reduce((sum, value) => sum + (value - m) ** 2, 0) /
    Math.max(values.length - 1, 1);
  return Math.sqrt(variance);
};

const correlation = (a: readonly number[], b: readonly number[]): number => {
  const ma = mean(a);
  const mb = mean(b);
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (const [index, x] of a.entries()) {
    const y = b[index] as number;
    cov += (x - ma) * (y - mb);
    va += (x - ma) ** 2;
    vb += (y - mb) ** 2;
  }
  return va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : 0;
};

/** Solves A x = b by Gauss-Jordan elimination with partial pivoting (zero for a singular column). */
export const solveLinear = (
  matrix: readonly (readonly number[])[],
  rhs: readonly number[]
): number[] => {
  const size = rhs.length;
  const a = matrix.map((line, index) => [...line, rhs[index] as number]);
  for (let col = 0; col < size; col += 1) {
    let pivot = col;
    for (let r = col + 1; r < size; r += 1)
      if (
        Math.abs((a[r] as number[])[col] as number) >
        Math.abs((a[pivot] as number[])[col] as number)
      )
        pivot = r;
    [a[col], a[pivot]] = [a[pivot] as number[], a[col] as number[]];
    const head = a[col] as number[];
    const p = head[col] as number;
    if (Math.abs(p) < 1e-12) continue;
    for (let c = col; c <= size; c += 1) head[c] = (head[c] as number) / p;
    for (let r = 0; r < size; r += 1) {
      const line = a[r] as number[];
      const factor = line[col] as number;
      if (r === col || factor === 0) continue;
      for (let c = col; c <= size; c += 1)
        line[c] = (line[c] as number) - factor * (head[c] as number);
    }
  }
  return a.map((line) => line[size] as number);
};

export type OlsFit = Readonly<{
  alpha: number;
  betas: readonly number[];
  r2: number;
}>;

/** Ordinary least squares of y on the factor columns plus an intercept. */
export const ols = (
  columns: readonly (readonly number[])[],
  y: readonly number[]
): OlsFit => {
  const rows = y.map((_, index) => [
    1,
    ...columns.map((col) => col[index] as number),
  ]);
  const k = columns.length + 1;
  const xtx = Array.from({ length: k }, (_, i) =>
    Array.from({ length: k }, (__, j) =>
      rows.reduce(
        (sum, row) => sum + (row[i] as number) * (row[j] as number),
        0
      )
    )
  );
  const xty = Array.from({ length: k }, (_, i) =>
    rows.reduce(
      (sum, row, index) => sum + (row[i] as number) * (y[index] as number),
      0
    )
  );
  const coef = solveLinear(xtx, xty);
  const my = mean(y);
  let ssr = 0;
  let sst = 0;
  for (const [index, row] of rows.entries()) {
    const fitted = row.reduce(
      (sum, value, j) => sum + value * (coef[j] as number),
      0
    );
    ssr += ((y[index] as number) - fitted) ** 2;
    sst += ((y[index] as number) - my) ** 2;
  }
  return {
    alpha: coef[0] as number,
    betas: coef.slice(1),
    r2: sst > 0 ? clamp01(1 - ssr / sst) : 0,
  };
};

/* ---------------------------------- regression ---------------------------------- */

const MARKET_MEAN = 0.6; // % a month
const MARKET_VOL = 4.5;
const FACTORS = [
  { id: "SMB", mean: 0.25, vol: 3 },
  { id: "HML", mean: 0.3, vol: 3 },
  { id: "MOM", mean: 0.6, vol: 4 },
] as const;

type RegressionSim = Readonly<{
  beta: number;
  alphaM: number;
  months: number;
  shown: number;
  market: number[];
  stock: number[];
  outlier: Point | null;
  fit: OlsFit;
  fund: readonly (OlsFit & { label: string })[];
}>;

const regressionSim = (values: ParamValues, t: number): RegressionSim => {
  const beta = num(values, "beta", 1.2);
  const alphaM = num(values, "alphaPct", 3) / 12;
  const noise = Math.max(num(values, "noise", 4), 0);
  const months = Math.round(clampTo(num(values, "months", 60), 12, 600));
  const outlierPct = num(values, "outlier", 15);
  const exposures = [
    num(values, "sizeBeta", 0.5),
    num(values, "valueBeta", 0.4),
    num(values, "momBeta", 0.3),
  ];
  const random = mulberry32(num(values, "seed", 7));
  const market: number[] = [];
  const stock: number[] = [];
  const factors: number[][] = FACTORS.map(() => []);
  const fund: number[] = [];
  for (let m = 0; m < months; m += 1) {
    const mkt = MARKET_MEAN + MARKET_VOL * gaussian(random);
    market.push(mkt);
    stock.push(alphaM + beta * mkt + noise * gaussian(random));
    let r = alphaM + beta * mkt + noise * gaussian(random);
    for (const [i, factor] of FACTORS.entries()) {
      const f = factor.mean + factor.vol * gaussian(random);
      factors[i]?.push(f);
      r += (exposures[i] as number) * f;
    }
    fund.push(r);
  }
  const shown = Math.max(3, Math.round(clamp01(t) * months));
  const xs = market.slice(0, shown);
  const ys = stock.slice(0, shown);
  const outlier: Point | null =
    outlierPct === 0
      ? null
      : [-3 * MARKET_VOL, alphaM + beta * -3 * MARKET_VOL + outlierPct];
  const fit = ols(
    [outlier ? [...xs, outlier[0]] : xs],
    outlier ? [...ys, outlier[1]] : ys
  );
  const [smb, hml, mom] = factors as [number[], number[], number[]];
  return {
    alphaM,
    beta,
    fit,
    fund: [
      { label: "Market", ...ols([market], fund) },
      { label: "3-factor", ...ols([market, smb, hml], fund) },
      { label: "4-factor", ...ols([market, smb, hml, mom], fund) },
    ],
    market,
    months,
    outlier,
    shown,
    stock,
  };
};

const pct = (value: number, digits = 1): string => `${round(value, digits)} %`;

const regressionScene = (ctx: SceneCtx): SceneData => {
  const sim = regressionSim(ctx.values, ctx.t);
  const xs = sim.market.slice(0, sim.shown);
  const ys = sim.stock.slice(0, sim.shown);
  const xDomain = withZero(
    span(sim.outlier ? [...xs, sim.outlier[0]] : xs, 0.1)
  );
  const line = (alpha: number, slope: number): Point[] =>
    xDomain.map((x) => [x, alpha + slope * x] as Point);
  const fitLine = line(sim.fit.alpha, sim.fit.betas[0] as number);
  const trueLine = line(sim.alphaM, sim.beta);
  const yDomain = withZero(
    span([
      ...ys,
      ...fitLine.map((p) => p[1]),
      ...trueLine.map((p) => p[1]),
      ...(sim.outlier ? [sim.outlier[1]] : []),
    ])
  );
  const markers: Marker[] = xs.map((x, index) => ({
    element: "points",
    kind: "dot",
    label: "",
    x,
    y: ys[index] as number,
  }));
  if (sim.outlier)
    markers.push({
      element: "outlier",
      kind: "dot",
      label: "Outlier month",
      x: sim.outlier[0],
      y: sim.outlier[1],
    });
  markers.push(
    {
      element: "alpha",
      kind: "dot",
      label: `alpha ${pct(sim.fit.alpha * 12)}/yr`,
      x: 0,
      y: sim.fit.alpha,
    },
    {
      element: "r2",
      kind: "hline",
      label: `R² ${pct(sim.fit.r2 * 100, 0)}, beta ${round(sim.fit.betas[0] as number, 2)}`,
      y: 0,
    }
  );
  const scatter: Panel = {
    bars: [],
    elements: ["axes", "points", "fit", "truth", "outlier", "alpha", "r2"],
    id: "regression",
    markers,
    series: [
      {
        element: "fit",
        label: `Fitted line (beta ${round(sim.fit.betas[0] as number, 2)})`,
        points: fitLine,
        width: 2,
      },
      {
        dashed: true,
        element: "truth",
        label: `True line (beta ${round(sim.beta, 2)})`,
        points: trueLine,
      },
    ],
    title: "Monthly excess return: stock vs market",
    xDomain,
    xFormat: "pct",
    xLabel: "Market excess return (%/month)",
    yDomain,
    yFormat: "pct",
    yLabel: "Stock excess return (%/month)",
  };
  const bars: Bar[] = sim.fund.flatMap((model, index) => [
    {
      element: "alpha",
      tone: true,
      width: 0.3,
      x: index + 1 - 0.18,
      y: model.alpha * 12,
    },
    {
      element: "r2",
      tone: true,
      width: 0.3,
      x: index + 1 + 0.18,
      y: model.r2 * 100,
    },
  ]);
  const comparison: Panel = {
    bars,
    elements: ["alpha", "r2"],
    id: "models",
    markers: sim.fund.map((model, index) => ({
      element: "r2",
      kind: "dot",
      label: model.label,
      x: index + 1,
      y: 0,
    })),
    series: [],
    title: "Fund regressions: alpha (%/yr) and R² (%) by model",
    xDomain: [0.4, 3.6],
    xFormat: "count",
    xLabel: "Model (1 market, 2 three-factor, 3 four-factor)",
    yDomain: withZero(span(bars.map((bar) => bar.y))),
    yFormat: "pct",
    yLabel: "Alpha %/yr (left bar), R² % (right bar)",
  };
  return {
    horizon: sim.months,
    layout: "stack",
    now: sim.shown,
    panels: [scatter, comparison],
    timeLabel: "Months in the sample",
    timeUnit: "trades",
  };
};

const regressionTables = (values: ParamValues, t: number): DataTable[] => {
  const sim = regressionSim(values, t);
  return [
    {
      columns: ["Quantity", "True", "Estimated"],
      id: "regression",
      note: `Fitted on ${sim.shown} simulated months${sim.outlier ? " plus the outlier month" : ""}.`,
      rows: [
        [
          "Beta",
          String(round(sim.beta, 2)),
          String(round(sim.fit.betas[0] as number, 2)),
        ],
        [
          "Alpha (%/yr)",
          String(round(sim.alphaM * 12, 2)),
          String(round(sim.fit.alpha * 12, 2)),
        ],
        ["R²", "", pct(sim.fit.r2 * 100)],
      ],
      title: "Single-stock regression",
    },
    {
      columns: ["Model", "Alpha (%/yr)", "Betas", "R²"],
      id: "models",
      note: "The simulated fund loads on size, value and momentum; omitted factors leak into alpha.",
      rows: sim.fund.map((model) => [
        model.label,
        String(round(model.alpha * 12, 2)),
        model.betas.map((b) => round(b, 2)).join(", "),
        pct(model.r2 * 100),
      ]),
      title: "Factor model comparison",
    },
  ];
};

/* ------------------------------------ factor ------------------------------------ */

type FactorSim = Readonly<{
  years: number;
  buckets: number[];
  a: number[];
  b: number[];
  mix: number[];
  crashMonth: number | null;
  pubYear: number;
  monthlyA: number[];
  monthlyB: number[];
}>;

const cumulative = (returns: readonly number[]): number[] => {
  let value = 1;
  return [
    0,
    ...returns.map((r) => {
      value *= 1 + r / 100;
      return (value - 1) * 100;
    }),
  ];
};

const factorSim = (values: ParamValues): FactorSim => {
  const random = mulberry32(num(values, "seed", 11));
  const years = Math.round(clampTo(num(values, "years", 30), 2, 100));
  const count = Math.round(clampTo(num(values, "buckets", 5), 2, 20));
  const spread = num(values, "spread", 6);
  const bucketReturns = Array.from({ length: count }, (_, i) => {
    const target = 8 + spread * (i / (count - 1) - 0.5);
    return mean(
      Array.from({ length: years }, () => target + 4 * gaussian(random))
    );
  });
  const volA = Math.max(num(values, "factorVol", 12), 0) / Math.sqrt(12);
  const volB = Math.max(num(values, "bVol", 10), 0) / Math.sqrt(12);
  const rho = clampTo(num(values, "rho", -0.4), -1, 1);
  const crashPct = Math.max(num(values, "crashPct", 30), 0);
  const crashYear = num(values, "crashYear", 15);
  const pubYear = num(values, "pubYear", 20);
  const keep = 1 - clamp01(num(values, "decayPct", 50) / 100);
  const bMean = num(values, "bSpread", 4) / 12;
  const months = years * 12;
  const crashIndex = Math.round(crashYear * 12);
  const crashMonth =
    crashPct > 0 && crashIndex >= 0 && crashIndex < months ? crashIndex : null;
  const monthlyA: number[] = [];
  const monthlyB: number[] = [];
  for (let m = 0; m < months; m += 1) {
    const za = gaussian(random);
    const zb = rho * za + Math.sqrt(1 - rho * rho) * gaussian(random);
    const premium = (spread / 12) * (m >= pubYear * 12 ? keep : 1);
    monthlyA.push(m === crashMonth ? -crashPct : premium + volA * za);
    monthlyB.push(bMean + volB * zb);
  }
  const mixed = monthlyA.map((r, i) => (r + (monthlyB[i] as number)) / 2);
  return {
    a: cumulative(monthlyA),
    b: cumulative(monthlyB),
    buckets: bucketReturns,
    crashMonth,
    mix: cumulative(mixed),
    monthlyA,
    monthlyB,
    pubYear,
    years,
  };
};

const factorScene = (ctx: SceneCtx): SceneData => {
  const sim = factorSim(ctx.values);
  const now = clamp01(ctx.t) * sim.years;
  const pts = (curve: readonly number[]): Point[] =>
    curve.map((y, m) => [m / 12, y] as Point);
  const markers: Marker[] = [];
  if (sim.crashMonth !== null) {
    const x = sim.crashMonth / 12;
    markers.push(
      { element: "crash", kind: "vline", label: "Factor crash", x },
      {
        element: "crash",
        kind: "dot",
        label: `${round(sim.monthlyA[sim.crashMonth] as number, 1)} % in one month`,
        x: x + 1 / 12,
        y: sim.a[sim.crashMonth + 1] as number,
      }
    );
  }
  if (sim.pubYear > 0 && sim.pubYear < sim.years)
    markers.push({
      element: "publication",
      kind: "vline",
      label: "Published: premium shrinks",
      x: sim.pubYear,
    });
  const count = sim.buckets.length;
  return {
    horizon: sim.years,
    layout: "stack",
    now,
    panels: [
      {
        bars: sim.buckets.map((y, i) => ({
          element: "bars",
          width: 0.7,
          x: i + 1,
          y,
        })),
        elements: ["axes", "bars"],
        id: "buckets",
        markers: [],
        series: [],
        title: `Average annual return by ${count === 5 ? "quintile" : count === 10 ? "decile" : "bucket"} (1 = lowest score)`,
        xDomain: [0.4, count + 0.6],
        xFormat: "count",
        xLabel: "Bucket",
        yDomain: withZero(span(sim.buckets)),
        yFormat: "pct",
        yLabel: "Average annual return (%)",
      },
      {
        bars: [],
        elements: ["axes", "a", "b", "mix", "crash", "publication"],
        id: "factors",
        markers,
        series: [
          {
            element: "a",
            label: "Factor A (long-short)",
            points: pts(sim.a),
            revealTo: now,
            width: 2,
          },
          {
            element: "b",
            label: "Factor B",
            points: pts(sim.b),
            revealTo: now,
          },
          {
            dashed: true,
            element: "mix",
            label: "50/50 mix",
            points: pts(sim.mix),
            revealTo: now,
          },
        ],
        title: "Cumulative long-short return",
        xDomain: [0, sim.years],
        xFormat: "count",
        xLabel: "Year",
        yDomain: withZero(span([...sim.a, ...sim.b, ...sim.mix])),
        yFormat: "pct",
        yLabel: "Cumulative return (%)",
      },
    ],
    timeLabel: "Years",
    timeUnit: "pct",
  };
};

const stats = (label: string, monthly: readonly number[]): string[] => {
  const m = mean(monthly);
  const s = sd(monthly);
  return [
    label,
    String(round(m * 12, 2)),
    String(round(s * Math.sqrt(12), 2)),
    String(round(s > 0 ? (m / s) * Math.sqrt(monthly.length) : 0, 2)),
  ];
};

const factorTables = (values: ParamValues): DataTable[] => {
  const sim = factorSim(values);
  const mixed = sim.monthlyA.map(
    (r, i) => (r + (sim.monthlyB[i] as number)) / 2
  );
  return [
    {
      columns: ["Bucket", "Average annual return (%)"],
      id: "buckets",
      rows: sim.buckets.map((y, i) => [String(i + 1), String(round(y, 2))]),
      title: "Portfolio sorts",
    },
    {
      columns: [
        "Portfolio",
        "Return (%/yr)",
        "Volatility (%/yr)",
        "t statistic",
      ],
      id: "factors",
      note: `Correlation of A and B: ${round(correlation(sim.monthlyA, sim.monthlyB), 2)}.`,
      rows: [
        stats("Factor A", sim.monthlyA),
        stats("Factor B", sim.monthlyB),
        stats("50/50 mix", mixed),
      ],
      title: "Long-short factors",
    },
  ];
};

/** Scene of one statistics mode at param values and time fraction ctx.t. */
export const statisticsScene = (
  mode: StatisticsMode,
  ctx: SceneCtx
): SceneData =>
  mode === "regression" ? regressionScene(ctx) : factorScene(ctx);

/** Mode-specific data tables (the inputs and constants tables are added by tables.ts). */
export const statisticsTables = (
  mode: StatisticsMode,
  values: ParamValues,
  t: number
): DataTable[] =>
  mode === "regression" ? regressionTables(values, t) : factorTables(values);
