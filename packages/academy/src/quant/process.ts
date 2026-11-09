// What: Scene and table builders of the process quant modes (random processes): an arithmetic random
// walk of repeated bets (walk), geometric Brownian motion (gbm) and an Ornstein-Uhlenbeck spread that
// is pulled back to its long-run mean (meanrev). Seeded, computed data only: the same param values
// always draw the same chart.
import { gaussian, mulberry32, normCdf, normPdf } from "../math.ts";
import { num, type ParamValues } from "../position.ts";
import {
  type Bar,
  clamp01,
  type DataTable,
  grid,
  type Marker,
  nth,
  type Point,
  type SceneCtx,
  type SceneData,
  type Series,
  span,
} from "../scene-kit.ts";
import type { ProcessMode } from "./process-ids.ts";

const TRADING_DAYS = 252;
/** Paths drawn in a fan; the statistics and histograms use every simulated path. */
const SHOWN_PATHS = 40;
/** Points per drawn path at most (longer paths are drawn every k-th step). */
const MAX_POINTS = 400;
/** Histogram bins across the plotted range (about). */
const BINS = 32;
/** z of the 90th percentile of the standard normal. */
const Z90 = 1.281_551_565_544_600_4;
/** Coin win chances stay inside this margin so a coin walk always has a spread. */
const COIN_MARGIN = 0.0005;
/** Dickey-Fuller 5% limit for the t statistic of the pull-back slope (about -2.9). */
const DF_LIMIT = -2.9;

const bounded = (
  values: ParamValues,
  key: string,
  fallback: number,
  low: number,
  high: number
): number => Math.min(Math.max(num(values, key, fallback), low), high);

const fixed = (value: number, digits = 2): string => value.toFixed(digits);
const pct = (fraction: number, digits = 1): string =>
  `${(fraction * 100).toFixed(digits)}%`;
const money = (value: number): string =>
  `${value < 0 ? "-" : ""}$${Math.abs(value).toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  })}`;

/** Linear-interpolated quantile of ascending values. */
const quantile = (sorted: Float64Array, q: number): number => {
  const position = (sorted.length - 1) * q;
  const low = Math.floor(position);
  const high = Math.min(low + 1, sorted.length - 1);
  const a = sorted.at(low) as number;
  return a + ((sorted.at(high) as number) - a) * (position - low);
};

type Values = Float64Array | readonly number[];

const average = (values: Values): number => {
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
};

const deviation = (values: Values, mean: number): number => {
  let sum = 0;
  for (const value of values) sum += (value - mean) ** 2;
  return Math.sqrt(sum / Math.max(values.length - 1, 1));
};

const share = (values: Values, test: (value: number) => boolean): number => {
  let count = 0;
  for (const value of values) if (test(value)) count += 1;
  return count / values.length;
};

/** Small per-mode cache: the video renders every frame with the same param values. */
const cached = <T>(cache: Map<string, T>, key: string, build: () => T): T => {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const value = build();
  if (cache.size >= 8) cache.clear();
  cache.set(key, value);
  return value;
};

type Histogram = Readonly<{
  centers: number[];
  counts: number[];
  width: number;
}>;

/** Counts of the values in bins of `width` centered on origin + k·width, inside [low, high]. */
const histogram = (
  values: Values,
  origin: number,
  width: number,
  low: number,
  high: number
): Histogram => {
  const first = Math.round((low - origin) / width);
  const counts: number[] = new Array(
    Math.round((high - origin) / width) - first + 1
  ).fill(0);
  for (const value of values) {
    const bin = Math.round((value - origin) / width) - first;
    if (bin >= 0 && bin < counts.length) counts[bin] = nth(counts, bin) + 1;
  }
  return {
    centers: counts.map((_, bin) => origin + (first + bin) * width),
    counts,
    width,
  };
};

/** Histogram bars: bins that end above the start draw green, bins below it in the bars color. */
const histogramBars = (hist: Histogram, start: number): Bar[] =>
  hist.counts.map((count, bin) => ({
    element: "bars",
    tone: nth(hist.centers, bin) < start,
    width: hist.width * 0.92,
    x: nth(hist.centers, bin),
    y: count,
  }));

/** A fan of drawn paths revealed up to `now` (the first one carries the legend label). */
const fan = (
  paths: readonly (readonly number[])[],
  xs: readonly number[],
  now: number
): Series[] =>
  paths.map((path, index) => ({
    element: "paths",
    label: index === 0 ? "Simulated paths" : "",
    points: path.map((value, point) => [nth(xs, point), value] as const),
    revealTo: now,
    width: 1,
  }));

/** Dashed upper and lower lines of an envelope drawn up to x = revealTo (only the upper one is labeled). */
const envelope = (
  element: string,
  label: string,
  upper: readonly Point[],
  lower: readonly Point[],
  width: number,
  revealTo: number
): Series[] => [
  { dashed: true, element, label, points: upper, revealTo, width },
  { dashed: true, element, label: "", points: lower, revealTo, width },
];

// ---------------------------------------------------------------- walk

type WalkShape = "coin" | "uniform" | "normal";

type WalkInputs = Readonly<{
  steps: number;
  drift: number;
  stepVol: number;
  paths: number;
  seed: number;
  start: number;
  shape: WalkShape;
}>;

export type WalkRun = Readonly<{
  inputs: WalkInputs;
  /** Expected value of one step (the drift or edge). */
  mean: number;
  /** Standard deviation of one step. */
  sd: number;
  /** Step numbers of the drawn points. */
  xs: number[];
  /** Drawn paths (the first SHOWN_PATHS), sampled at xs. */
  shown: number[][];
  /** Checkpoint step counts (the last one is the horizon). */
  checkpoints: number[];
  /** Values of every path at each checkpoint. */
  columns: Float64Array[];
}>;

const walkInputs = (values: ParamValues): WalkInputs => {
  const shape = values["shape"];
  return {
    drift: bounded(values, "drift", 0, -1e6, 1e6),
    paths: Math.round(bounded(values, "paths", 200, 1, 1000)),
    seed: Math.round(num(values, "seed", 7)),
    shape: shape === "uniform" || shape === "normal" ? shape : "coin",
    start: bounded(values, "start", 0, -1e9, 1e9),
    steps: Math.round(bounded(values, "steps", 1000, 1, 5000)),
    stepVol: bounded(values, "stepVol", 1, 1e-6, 1e6),
  };
};

/**
 * One step of the walk. A coin pays +stepVol or -stepVol with the win chance that gives the drift
 * as its expected value (drift -0.027 and stepVol 1: 18 in 37, a bet on red); uniform and normal
 * steps have mean drift and standard deviation stepVol.
 */
const walkStep = (
  inputs: WalkInputs,
  random: () => number
): Readonly<{ mean: number; sd: number; draw: () => number }> => {
  const { drift, stepVol, shape } = inputs;
  if (shape === "coin") {
    const win = Math.min(
      Math.max((1 + drift / stepVol) / 2, COIN_MARGIN),
      1 - COIN_MARGIN
    );
    return {
      draw: () => (random() < win ? stepVol : -stepVol),
      mean: stepVol * (2 * win - 1),
      sd: 2 * stepVol * Math.sqrt(win * (1 - win)),
    };
  }
  if (shape === "uniform") {
    const half = stepVol * Math.sqrt(3);
    return {
      draw: () => drift + half * (2 * random() - 1),
      mean: drift,
      sd: stepVol,
    };
  }
  return {
    draw: () => drift + stepVol * gaussian(random),
    mean: drift,
    sd: stepVol,
  };
};

const WALK_CHECKPOINTS = [10, 25, 100, 400, 1000, 4000];
const walkCache = new Map<string, WalkRun>();

/** Seeded random walks: drawn paths plus every path's value at the checkpoints. */
export const walkRun = (values: ParamValues): WalkRun => {
  const inputs = walkInputs(values);
  return cached(walkCache, JSON.stringify(inputs), () => {
    const step = walkStep(inputs, mulberry32(inputs.seed));
    const { steps, paths, start } = inputs;
    const every = Math.ceil(steps / MAX_POINTS);
    const xs = [0];
    for (let n = every; n < steps; n += every) xs.push(n);
    xs.push(steps);
    const checkpoints = [...WALK_CHECKPOINTS.filter((n) => n < steps), steps];
    const columns = checkpoints.map(() => new Float64Array(paths));
    const shown: number[][] = [];
    for (let path = 0; path < paths; path += 1) {
      let value = start;
      let check = 0;
      const drawn = [start];
      for (let n = 1; n <= steps; n += 1) {
        value += step.draw();
        if (n % every === 0 || n === steps) drawn.push(value);
        if (n === checkpoints[check]) {
          (columns[check] as Float64Array)[path] = value;
          check += 1;
        }
      }
      if (path < SHOWN_PATHS) shown.push(drawn);
    }
    return {
      checkpoints,
      columns,
      inputs,
      mean: step.mean,
      sd: step.sd,
      shown,
      xs,
    };
  });
};

const walkScene = (ctx: SceneCtx): SceneData => {
  const run = walkRun(ctx.values);
  const { steps, start, paths, shape, stepVol } = run.inputs;
  const now = Math.max(Math.round(steps * clamp01(ctx.t)), 1);
  const expected = (n: number): number => start + n * run.mean;
  const lineXs = grid(0, steps, 121);
  const band = (k: number): Point[] =>
    lineXs.map((n) => [n, expected(n) + k * run.sd * Math.sqrt(n)] as const);
  const center = expected(steps);
  const spread = run.sd * Math.sqrt(steps);
  const terminal = nth(run.columns, -1);
  const sorted = Float64Array.from(terminal).sort();
  const [low, high] = span(
    [
      sorted.at(0) as number,
      sorted.at(-1) as number,
      center - 3.5 * spread,
      center + 3.5 * spread,
    ],
    0.02
  );
  const rawWidth = (high - low) / BINS;
  // Coin walks land on a lattice 2·stepVol apart: whole lattice cells per bin avoid empty bins.
  const lattice = 2 * stepVol;
  const coin = shape === "coin";
  const width = coin
    ? lattice * Math.max(1, Math.round(rawWidth / lattice))
    : rawWidth;
  const hist = histogram(
    terminal,
    coin ? start - steps * stepVol : center,
    width,
    low,
    high
  );
  const pdf = grid(low, high, 161).map(
    (x) =>
      [x, (paths * width * normPdf((x - center) / spread)) / spread] as const
  );
  const drawn = run.shown.flat();
  return {
    horizon: steps,
    layout: "stack",
    now,
    panels: [
      {
        bars: [],
        elements: ["axes", "paths", "mean", "band"],
        id: "walk",
        markers: [{ element: "axes", kind: "hline", label: "Start", y: start }],
        series: [
          ...fan(run.shown, run.xs, now),
          {
            element: "mean",
            label: "Expected n·μ",
            points: [
              [0, expected(0)],
              [steps, center],
            ],
            width: 3,
          },
          ...envelope("band", "±1σ√n", band(1), band(-1), 2, steps),
          ...envelope("band", "±2σ√n", band(2), band(-2), 1, steps),
        ],
        title: `${paths} random walks of ${steps} steps, edge ${fixed(run.mean, 4)} per step`,
        xDomain: [0, steps],
        xFormat: "count",
        xLabel: "Step (bet)",
        yDomain: span([
          ...drawn,
          start,
          center - 2.2 * spread,
          center + 2.2 * spread,
        ]),
        yFormat: "usd",
        yLabel: "Balance",
      },
      {
        bars: histogramBars(hist, start),
        elements: ["axes", "bars", "pdf", "band", "mean"],
        id: "terminal",
        markers: [
          {
            element: "band",
            kind: "band",
            label: "±1σ√n",
            x: center - spread,
            x2: center + spread,
          },
          { element: "axes", kind: "vline", label: "Start", x: start },
          { element: "mean", kind: "vline", label: "n·μ", x: center },
        ],
        series: [
          {
            element: "pdf",
            label: "Normal N(nμ, σ√n)",
            points: pdf,
            width: 2.5,
          },
        ],
        title: `Where the ${paths} walks end after ${steps} steps`,
        xDomain: [low, high],
        xFormat: "price",
        xLabel: "Final balance",
        yDomain: [
          0,
          Math.max(...hist.counts, ...pdf.map((point) => point[1])) * 1.15,
        ],
        yFormat: "num",
        yLabel: "Paths",
      },
    ],
    timeLabel: "Step",
    timeUnit: "trades",
  };
};

const walkTables = (values: ParamValues): DataTable[] => {
  const run = walkRun(values);
  const { start, paths, steps } = run.inputs;
  const { mean, sd } = run;
  const checkpoints = run.checkpoints.map((n, index) => {
    const column = nth(run.columns, index);
    const luck = sd * Math.sqrt(n);
    const center = start + n * mean;
    return [
      String(n),
      money(n * mean),
      fixed(luck),
      fixed(Math.abs(n * mean) / luck),
      pct(share(column, (value) => value < start)),
      pct(normCdf((-n * mean) / luck)),
      pct(share(column, (value) => Math.abs(value - center) <= luck)),
    ];
  });
  const terminal = nth(run.columns, -1);
  const center = start + steps * mean;
  const spread = sd * Math.sqrt(steps);
  const endMean = average(terminal);
  const within = (k: number): string[] => [
    `Within ±${k}σ√n of n·μ`,
    pct(share(terminal, (value) => Math.abs(value - center) <= k * spread)),
    pct(2 * normCdf(k) - 1),
  ];
  const winners = share(terminal, (value) => value > start);
  const losers = share(terminal, (value) => value < start);
  return [
    {
      columns: [
        "Steps n",
        "Edge n·μ",
        "Luck σ√n",
        "Edge / luck",
        "Below start",
        "Below start (normal)",
        "Within ±1σ√n",
      ],
      id: "walk-checkpoints",
      note:
        mean === 0
          ? "No edge (μ = 0): the walk has no drift, and the spread grows with √n."
          : `The edge grows with n, the luck with √n: the edge passes one standard deviation of luck after (σ/μ)² = ${Math.round((sd / mean) ** 2).toLocaleString("en-US")} steps.`,
      rows: checkpoints,
      title: "Edge against luck along the walk",
    },
    {
      columns: ["Measure", "Simulated", "Theory"],
      id: "walk-terminal",
      rows: [
        ["Average end", money(endMean), money(center)],
        [
          "Standard deviation",
          fixed(deviation(terminal, endMean)),
          fixed(spread),
        ],
        within(1),
        within(2),
        within(3),
        [
          "Paths ending above start",
          `${Math.round(winners * paths)} (${pct(winners)})`,
          pct(1 - normCdf((start - center) / spread)),
        ],
        [
          "Paths ending below start",
          `${Math.round(losers * paths)} (${pct(losers)})`,
          pct(normCdf((start - center) / spread)),
        ],
      ],
      title: `After ${steps} steps (${paths} paths, step σ ${fixed(sd, 4)})`,
    },
  ];
};

// ---------------------------------------------------------------- gbm

type GbmInputs = Readonly<{
  spot: number;
  /** Annual drift (fraction). */
  mu: number;
  /** Annual volatility (fraction). */
  vol: number;
  years: number;
  paths: number;
  seed: number;
}>;

export type GbmRun = Readonly<{
  inputs: GbmInputs;
  tradingDays: number;
  /** Trading day of each time step. */
  xs: number[];
  shown: number[][];
  p10: number[];
  median: number[];
  p90: number[];
  /** Final prices, ascending. */
  terminal: Float64Array;
}>;

const gbmInputs = (values: ParamValues): GbmInputs => ({
  mu: bounded(values, "drift", 8, -100, 100) / 100,
  paths: Math.round(bounded(values, "paths", 1000, 10, 5000)),
  seed: Math.round(num(values, "seed", 11)),
  spot: bounded(values, "spot", 100, 0.01, 1e7),
  vol: bounded(values, "vol", 20, 0.1, 200) / 100,
  years: bounded(values, "years", 1, 1 / TRADING_DAYS, 50),
});

const gbmCache = new Map<string, GbmRun>();

/**
 * Seeded GBM paths on at most 252 time steps (log increments are exact for any step length, so the
 * distribution at each step does not depend on the grid), with the 10th, 50th and 90th percentile.
 */
export const gbmRun = (values: ParamValues): GbmRun => {
  const inputs = gbmInputs(values);
  return cached(gbmCache, JSON.stringify(inputs), () => {
    const { spot, mu, vol, years, paths } = inputs;
    const tradingDays = Math.max(Math.round(years * TRADING_DAYS), 1);
    const count = Math.min(tradingDays, TRADING_DAYS);
    const dt = years / count;
    const driftStep = (mu - (vol * vol) / 2) * dt;
    const shock = vol * Math.sqrt(dt);
    const random = mulberry32(inputs.seed);
    const columns = Array.from(
      { length: count + 1 },
      () => new Float64Array(paths)
    );
    const shown: number[][] = [];
    for (let path = 0; path < paths; path += 1) {
      let price = spot;
      (columns[0] as Float64Array)[path] = spot;
      const drawn = [spot];
      for (let step = 1; step <= count; step += 1) {
        price *= Math.exp(driftStep + shock * gaussian(random));
        (columns[step] as Float64Array)[path] = price;
        drawn.push(price);
      }
      if (path < SHOWN_PATHS) shown.push(drawn);
    }
    const sorted = columns.map((column) => column.sort());
    return {
      inputs,
      median: sorted.map((column) => quantile(column, 0.5)),
      p10: sorted.map((column) => quantile(column, 0.1)),
      p90: sorted.map((column) => quantile(column, 0.9)),
      shown,
      terminal: nth(sorted, -1),
      tradingDays,
      xs: sorted.map((_, step) => (step * tradingDays) / count),
    };
  });
};

/** Log-mean and log-sd of the GBM price after `years`. */
const logMoments = (
  inputs: GbmInputs,
  years: number
): Readonly<{ m: number; s: number }> => ({
  m:
    Math.log(inputs.spot) + (inputs.mu - (inputs.vol * inputs.vol) / 2) * years,
  s: inputs.vol * Math.sqrt(years),
});

const gbmScene = (ctx: SceneCtx): SceneData => {
  const run = gbmRun(ctx.values);
  const { spot, mu, years, paths } = run.inputs;
  const days = run.tradingDays;
  const now = Math.max(Math.round(days * clamp01(ctx.t)), 1);
  const along = (values: readonly number[]): Point[] =>
    values.map((value, step) => [nth(run.xs, step), value] as const);
  const meanLine = grid(0, days, 121).map(
    (day) => [day, spot * Math.exp((mu * years * day) / days)] as const
  );
  const [pathLow, pathHigh] = span([
    spot,
    ...run.p10,
    ...run.p90,
    nth(meanLine, -1)[1],
  ]);
  const { terminal } = run;
  const [low, high] = span(
    [quantile(terminal, 0.005), quantile(terminal, 0.995)],
    0.02
  );
  const width = (high - low) / BINS;
  const hist = histogram(terminal, low, width, low, high);
  const { m, s } = logMoments(run.inputs, years);
  const pdf = grid(Math.max(low, 1e-9), high, 161).map(
    (x) =>
      [x, (paths * width * normPdf((Math.log(x) - m) / s)) / (x * s)] as const
  );
  const finalMedian = quantile(terminal, 0.5);
  const finalMean = average(terminal);
  return {
    horizon: days,
    layout: "stack",
    now,
    panels: [
      {
        bars: [],
        elements: ["axes", "paths", "median", "mean", "band"],
        id: "gbm",
        markers: [{ element: "axes", kind: "hline", label: "Start", y: spot }],
        series: [
          ...fan(run.shown, run.xs, now),
          ...envelope(
            "band",
            "10th-90th percentile",
            along(run.p90),
            along(run.p10),
            2,
            now
          ),
          {
            element: "median",
            label: "Median path",
            points: along(run.median),
            revealTo: now,
            width: 3,
          },
          {
            dashed: true,
            element: "mean",
            label: "Expected S0·e^(μt)",
            points: meanLine,
            width: 2.5,
          },
        ],
        title: `${paths} GBM price paths: drift ${fixed(mu * 100, 1)}%, volatility ${fixed(run.inputs.vol * 100, 1)}% a year`,
        xDomain: [0, days],
        xFormat: "day",
        xLabel: "Trading day",
        yDomain: [Math.max(pathLow, 0), pathHigh],
        yFormat: "price",
        yLabel: "Price",
      },
      {
        bars: histogramBars(hist, spot),
        elements: ["axes", "bars", "pdf", "band", "mean", "median"],
        id: "terminal",
        markers: [
          {
            element: "band",
            kind: "band",
            label: "10th-90th",
            x: quantile(terminal, 0.1),
            x2: quantile(terminal, 0.9),
          },
          { element: "axes", kind: "vline", label: "Start", x: spot },
          {
            element: "median",
            kind: "vline",
            label: `Median ${fixed(finalMedian)}`,
            x: finalMedian,
          },
          {
            element: "mean",
            kind: "vline",
            label: `Mean ${fixed(finalMean)}`,
            x: finalMean,
          },
        ],
        series: [
          {
            element: "pdf",
            label: "Lognormal density",
            points: pdf,
            width: 2.5,
          },
        ],
        title: `Where the ${paths} paths end after ${fixed(years, years < 1 ? 2 : 1)} years (middle 99%)`,
        xDomain: [low, high],
        xFormat: "price",
        xLabel: "Final price",
        yDomain: [
          0,
          Math.max(...hist.counts, ...pdf.map((point) => point[1])) * 1.15,
        ],
        yFormat: "num",
        yLabel: "Paths",
      },
    ],
    timeLabel: "Trading day",
    timeUnit: "days",
  };
};

const gbmTables = (values: ParamValues): DataTable[] => {
  const run = gbmRun(values);
  const { spot, mu, vol, years, paths } = run.inputs;
  const { terminal } = run;
  const { m, s } = logMoments(run.inputs, years);
  const median = quantile(terminal, 0.5);
  const mean = average(terminal);
  const loss = share(terminal, (value) => value < spot);
  return [
    {
      columns: ["Measure", "Simulated", "Model"],
      id: "gbm-terminal",
      note: "The mean sits above the median: a few lucky paths pull the average up, while the typical path compounds at μ - σ²/2. More paths make the simulated numbers more precise with the square root rule (100 times the paths, 10 times the precision).",
      rows: [
        ["Median final price", money(median), money(Math.exp(m))],
        ["Mean final price", money(mean), money(spot * Math.exp(mu * years))],
        [
          "Mean above median",
          pct(mean / median - 1),
          pct(Math.exp((s * s) / 2) - 1),
        ],
        [
          "10th percentile (bad case)",
          money(quantile(terminal, 0.1)),
          money(Math.exp(m - Z90 * s)),
        ],
        [
          "90th percentile (good case)",
          money(quantile(terminal, 0.9)),
          money(Math.exp(m + Z90 * s)),
        ],
        [
          "Paths ending below start (loss share)",
          `${Math.round(loss * paths)} of ${paths} (${pct(loss)})`,
          pct(normCdf((Math.log(spot) - m) / s)),
        ],
        [
          "Standard error of the mean",
          money(deviation(terminal, mean) / Math.sqrt(paths)),
          "sd / √paths",
        ],
        [
          "Volatility per trading day",
          "",
          pct(vol / Math.sqrt(TRADING_DAYS), 2),
        ],
      ],
      title: `${paths} paths after ${run.tradingDays} trading days (${fixed(years, 2)} years)`,
    },
  ];
};

// ---------------------------------------------------------------- meanrev

type MeanrevInputs = Readonly<{
  start: number;
  halfLife: number;
  vol: number;
  days: number;
  paths: number;
  seed: number;
}>;

export type MeanrevRun = Readonly<{
  inputs: MeanrevInputs;
  /** Share of the distance kept per day: 2^(-1/halfLife). */
  phi: number;
  /** Continuous pull per day: ln 2 / halfLife. */
  theta: number;
  /** Stationary standard deviation: vol / √(1 - phi²). */
  stationary: number;
  xs: number[];
  shown: number[][];
  /** Average deviation of all paths on each day. */
  averages: number[];
  /** First path, every day (the regression test input). */
  first: number[];
}>;

const meanrevInputs = (values: ParamValues): MeanrevInputs => ({
  days: Math.round(bounded(values, "days", 250, 5, 2000)),
  halfLife: bounded(values, "halfLife", 10, 0.5, 1000),
  paths: Math.round(bounded(values, "paths", 200, 1, 2000)),
  seed: Math.round(num(values, "seed", 5)),
  start: bounded(values, "start", 3, -1e6, 1e6),
  vol: bounded(values, "vol", 1, 1e-6, 1e6),
});

const meanrevCache = new Map<string, MeanrevRun>();

/** Seeded daily AR(1) paths of the distance from the long-run mean. */
export const meanrevRun = (values: ParamValues): MeanrevRun => {
  const inputs = meanrevInputs(values);
  return cached(meanrevCache, JSON.stringify(inputs), () => {
    const { start, halfLife, vol, days, paths } = inputs;
    const phi = 2 ** (-1 / halfLife);
    const random = mulberry32(inputs.seed);
    const every = Math.ceil(days / MAX_POINTS);
    const xs = [0];
    for (let day = every; day < days; day += every) xs.push(day);
    xs.push(days);
    const sums = new Float64Array(days + 1);
    const shown: number[][] = [];
    const first = [start];
    for (let path = 0; path < paths; path += 1) {
      let value = start;
      sums[0] = (sums[0] as number) + value;
      const drawn = [start];
      for (let day = 1; day <= days; day += 1) {
        value = phi * value + vol * gaussian(random);
        sums[day] = (sums[day] as number) + value;
        if (day % every === 0 || day === days) drawn.push(value);
        if (path === 0) first.push(value);
      }
      if (path < SHOWN_PATHS) shown.push(drawn);
    }
    return {
      averages: Array.from(sums, (sum) => sum / paths),
      first,
      inputs,
      phi,
      shown,
      stationary: vol / Math.sqrt(1 - phi * phi),
      theta: Math.LN2 / halfLife,
      xs,
    };
  });
};

export type PullTest = Readonly<{
  slope: number;
  tStat: number;
  /** Half-life implied by the slope; Infinity when the slope shows no pull back. */
  halfLife: number;
}>;

/** OLS of today's change on yesterday's distance (with an intercept), as in a Dickey-Fuller test. */
export const pullTest = (path: readonly number[]): PullTest => {
  const xs = path.slice(0, -1);
  const ys = xs.map((x, index) => nth(path, index + 1) - x);
  const mx = average(xs);
  const my = average(ys);
  let sxx = 0;
  let sxy = 0;
  for (const [index, x] of xs.entries()) {
    sxx += (x - mx) ** 2;
    sxy += (x - mx) * (nth(ys, index) - my);
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let rss = 0;
  for (const [index, x] of xs.entries())
    rss += (nth(ys, index) - intercept - slope * x) ** 2;
  const se = Math.sqrt(rss / Math.max(xs.length - 2, 1) / sxx);
  return {
    halfLife:
      slope < 0
        ? -Math.LN2 / Math.log(Math.max(1 + slope, 1e-12))
        : Number.POSITIVE_INFINITY,
    slope,
    tStat: slope / se,
  };
};

const meanrevScene = (ctx: SceneCtx): SceneData => {
  const run = meanrevRun(ctx.values);
  const { start, halfLife, days } = run.inputs;
  const now = Math.max(days * clamp01(ctx.t), 0.5);
  const flat = (y: number): Point[] => [
    [0, y],
    [days, y],
  ];
  const decay = grid(0, days, 201).map(
    (day) => [day, 100 * Math.exp(-run.theta * day)] as const
  );
  const simulated: Series[] =
    start === 0
      ? []
      : [
          {
            dashed: true,
            element: "decay",
            label: "Average of simulated paths",
            points: run.averages.map(
              (value, day) => [day, (100 * value) / start] as const
            ),
            revealTo: now,
            width: 1.5,
          },
        ];
  const halfLifeLine: Marker = {
    element: "halfLife",
    kind: "vline",
    label: `Half-life ${fixed(halfLife, 1)} days`,
    x: halfLife,
  };
  return {
    horizon: days,
    layout: "stack",
    now,
    panels: [
      {
        bars: [],
        elements: ["axes", "paths", "mean", "band", "halfLife"],
        id: "meanrev",
        markers: [halfLifeLine],
        series: [
          ...fan(run.shown, run.xs, now),
          {
            element: "mean",
            label: "Long-run mean",
            points: flat(0),
            width: 2.5,
          },
          ...envelope(
            "band",
            "Stationary ±1σ",
            flat(run.stationary),
            flat(-run.stationary),
            2,
            days
          ),
        ],
        title: `${run.inputs.paths} spreads pulled back to their mean (half-life ${fixed(halfLife, 1)} days)`,
        xDomain: [0, days],
        xFormat: "day",
        xLabel: "Day",
        yDomain: span([
          ...run.shown.flat(),
          start,
          1.3 * run.stationary,
          -1.3 * run.stationary,
        ]),
        yFormat: "num",
        yLabel: "Distance from mean",
      },
      {
        bars: [],
        elements: ["decay", "halfLife"],
        id: "decay",
        markers: [
          halfLifeLine,
          {
            element: "halfLife",
            kind: "dot",
            label: "Half the distance gone",
            x: halfLife,
            y: 50,
          },
        ],
        series: [
          {
            element: "decay",
            label: "Expected distance left e^(-θt)",
            points: decay,
            width: 3,
          },
          ...simulated,
        ],
        title: `Expected distance left: e^(-θt), θ = ln 2 / ${fixed(halfLife, 1)} = ${fixed(run.theta, 4)} per day`,
        xDomain: [0, days],
        xFormat: "day",
        xLabel: "Day",
        yDomain: span(
          [
            0,
            100,
            ...simulated.flatMap((series) => series.points.map((p) => p[1])),
          ],
          0.05
        ),
        yFormat: "pct",
        yLabel: "Distance left (% of start)",
      },
    ],
    timeLabel: "Day",
    timeUnit: "days",
  };
};

const meanrevTables = (values: ParamValues): DataTable[] => {
  const run = meanrevRun(values);
  const { start, halfLife, vol, days } = run.inputs;
  const checkDays = [
    ...new Set(
      [0, halfLife, 2 * halfLife, 3 * halfLife]
        .map((day) => Math.round(day))
        .filter((day) => day < days)
    ),
    days,
  ];
  const test = pullTest(run.first);
  return [
    {
      columns: ["Measure", "Value"],
      id: "meanrev-model",
      rows: [
        ["Half-life", `${fixed(halfLife, 1)} days`],
        ["Pull θ = ln 2 / half-life", `${fixed(run.theta, 4)} per day`],
        ["Share of the distance kept per day φ = e^(-θ)", pct(run.phi, 2)],
        ["Share of the distance removed per day", pct(1 - run.phi, 2)],
        ["Daily shock σ", fixed(vol, 3)],
        ["Long-run sd = σ / √(1 - φ²)", fixed(run.stationary, 3)],
      ],
      title: "Pull-back model",
    },
    {
      columns: ["Day", "Expected X0·e^(-θt)", "Average of the paths"],
      id: "meanrev-decay",
      rows: checkDays.map((day) => [
        String(day),
        fixed(start * Math.exp(-run.theta * day), 3),
        fixed(nth(run.averages, day), 3),
      ]),
      title: `Distance from the mean, starting ${fixed(start, 2)} away`,
    },
    {
      columns: ["Measure", "Value"],
      id: "meanrev-test",
      note: "Even pure chance often looks like a pull back in this regression, so quants use a stricter limit than -2 for the t statistic (the Dickey-Fuller limit, about -2.9).",
      rows: [
        [
          "Slope (today's change on yesterday's distance)",
          fixed(test.slope, 4),
        ],
        ["t statistic", fixed(test.tStat, 2)],
        [
          "Estimated half-life",
          Number.isFinite(test.halfLife)
            ? `${fixed(test.halfLife, 1)} days`
            : "none (no pull back)",
        ],
        ["Built-in half-life", `${fixed(halfLife, 1)} days`],
        [
          "Verdict at the -2.9 limit",
          test.tStat < DF_LIMIT
            ? "Pull back detected"
            : "No reliable pull back",
        ],
      ],
      title: `Regression test on one simulated spread (${days} days)`,
    },
  ];
};

// ---------------------------------------------------------------- dispatch

/** Scene of one process mode at param values and time fraction ctx.t. */
export const processScene = (mode: ProcessMode, ctx: SceneCtx): SceneData => {
  if (mode === "walk") return walkScene(ctx);
  if (mode === "gbm") return gbmScene(ctx);
  return meanrevScene(ctx);
};

/** Mode-specific data tables (the inputs and constants tables are added by tables.ts). */
export const processTables = (
  mode: ProcessMode,
  values: ParamValues,
  _t: number
): DataTable[] => {
  if (mode === "walk") return walkTables(values);
  if (mode === "gbm") return gbmTables(values);
  return meanrevTables(values);
};
