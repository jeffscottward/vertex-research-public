// What: Scene and table builders of the volatility quant modes (volatility models, tail risk and filtering). Seeded, computed data only.
// Modes: tail (fat tails, VaR, expected shortfall), volcluster (GARCH / GJR-GARCH clustering and news impact),
// voltarget (volatility targeting on a GARCH asset), filter (local-level Kalman filter with fade signals).
import { gaussian, mulberry32, normCdf, normPdf } from "../math.ts";
import { num, type ParamValues } from "../position.ts";
import {
  type Bar,
  clamp01,
  type DataTable,
  grid,
  type Marker,
  type Point,
  type SceneCtx,
  type SceneData,
  span,
} from "../scene-kit.ts";
import type { VolatilityMode } from "./volatility-ids.ts";

const TRADING_DAYS = 252;
const ROOT_YEAR = Math.sqrt(TRADING_DAYS);
/** Highest stationarity weight sum (alpha + beta + gamma/2) the GARCH modes allow. */
const MAX_PERSISTENCE = 0.995;
/** Most dot markers one panel may draw. */
const MAX_DOTS = 400;

/** Numeric param clamped to [low, high]; non-numeric input falls back. */
const param = (
  values: ParamValues,
  id: string,
  fallback: number,
  low: number,
  high: number
): number => Math.min(Math.max(num(values, id, fallback), low), high);

const seedOf = (values: ParamValues): number =>
  Math.round(param(values, "seed", 7, 1, 1e9));

/** Scrubber position in days: at least day 1, so every scene shows something. */
const dayAt = (days: number, t: number): number =>
  Math.max(Math.round(days * (Number.isFinite(t) ? clamp01(t) : 1)), 1);

/** Largest value of a list without spreading it into Math.max (lists can be long). */
const maxOf = (values: readonly number[]): number =>
  values.reduce((high, value) => (value > high ? value : high), 0);

const minOf = (values: readonly number[]): number =>
  values.reduce(
    (low, value) => (value < low ? value : low),
    Number.POSITIVE_INFINITY
  );

const meanOf = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1);

/** Sample standard deviation (0 for fewer than two values). */
const stdevOf = (values: readonly number[]): number => {
  if (values.length < 2) return 0;
  const mean = meanOf(values);
  const squares = values.reduce((sum, value) => sum + (value - mean) ** 2, 0);
  return Math.sqrt(squares / (values.length - 1));
};

/** Largest peak-to-trough fall of an equity curve that starts above zero, as a positive fraction. */
const maxDrawdown = (equity: readonly number[]): number => {
  let peak = 0;
  let worst = 0;
  for (const value of equity) {
    peak = Math.max(peak, value);
    worst = Math.max(worst, 1 - value / peak);
  }
  return worst;
};

const pct = (value: number, digits = 2): string => `${value.toFixed(digits)}%`;

const usd = (value: number): string =>
  `${value < 0 ? "-" : ""}$${Math.round(Math.abs(value)).toLocaleString("en-US")}`;

/** Day count that may be tiny (expected counts under a bell curve). */
const count = (value: number): string => {
  if (value < 0.1) return value.toExponential(1);
  return value < 10 ? value.toFixed(1) : value.toFixed(0);
};

// ---------------------------------------------------------------------------
// Distributions: Student t (log-gamma, incomplete beta) and quantiles by bisection.

const LANCZOS = [
  0.999_999_999_999_809_9, 676.520_368_121_885_1, -1259.139_216_722_402_8,
  771.323_428_777_653_1, -176.615_029_162_140_6, 12.507_343_278_686_905,
  -0.138_571_095_265_720_12, 9.984_369_578_019_572e-6,
  1.505_632_735_149_311_6e-7,
];

/** ln Γ(x) for x ≥ 0.5 (Lanczos, g = 7). */
const logGamma = (x: number): number => {
  const y = x - 1;
  let sum = LANCZOS[0] as number;
  for (let index = 1; index < LANCZOS.length; index += 1)
    sum += (LANCZOS[index] as number) / (y + index);
  const base = y + 7.5;
  return (
    0.5 * Math.log(2 * Math.PI) +
    (y + 0.5) * Math.log(base) -
    base +
    Math.log(sum)
  );
};

/** Continued fraction of the incomplete beta function (Lentz). */
const betaFraction = (a: number, b: number, x: number): number => {
  let c = 1;
  let d = 1 / (1 - ((a + b) * x) / (a + 1));
  let result = d;
  for (let m = 1; m <= 300; m += 1) {
    const even = (m * (b - m) * x) / ((a + 2 * m - 1) * (a + 2 * m));
    d = 1 / (1 + even * d);
    c = 1 + even / c;
    result *= d * c;
    const odd = -((a + m) * (a + b + m) * x) / ((a + 2 * m) * (a + 2 * m + 1));
    d = 1 / (1 + odd * d);
    c = 1 + odd / c;
    const step = d * c;
    result *= step;
    if (Math.abs(step - 1) < 1e-14) break;
  }
  return result;
};

/** Regularized incomplete beta I_x(a, b) for x in [0, 1]. */
const incompleteBeta = (x: number, a: number, b: number): number => {
  const front = Math.exp(
    logGamma(a + b) -
      logGamma(a) -
      logGamma(b) +
      a * Math.log(x) +
      b * Math.log1p(-x)
  );
  return x < (a + 1) / (a + b + 2)
    ? (front * betaFraction(a, b, x)) / a
    : 1 - (front * betaFraction(b, a, 1 - x)) / b;
};

/** P(T ≤ x) of a standard Student t with nu degrees of freedom, for x ≤ 0. */
const tLowerTail = (x: number, nu: number): number =>
  0.5 * incompleteBeta(nu / (nu + x * x), nu / 2, 0.5);

/** Standard Student t density. */
const tPdf = (x: number, nu: number): number =>
  Math.exp(
    logGamma((nu + 1) / 2) -
      logGamma(nu / 2) -
      0.5 * Math.log(nu * Math.PI) -
      ((nu + 1) / 2) * Math.log1p((x * x) / nu)
  );

/** Lower-tail quantile (x ≤ 0 with cdf(x) = p, p ≤ 0.5) by bisection. */
const lowerQuantile = (cdf: (x: number) => number, p: number): number => {
  let low = -1e6;
  let high = 0;
  for (let iteration = 0; iteration < 90; iteration += 1) {
    const mid = (low + high) / 2;
    if (cdf(mid) < p) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
};

/** Standard Student t draw (Bailey's polar method). */
const studentDraw = (random: () => number, nu: number): number => {
  for (;;) {
    const u = 2 * random() - 1;
    const v = 2 * random() - 1;
    const w = u * u + v * v;
    if (w < 1 && w > 0) return u * Math.sqrt((nu * (w ** (-2 / nu) - 1)) / w);
  }
};

// ---------------------------------------------------------------------------
// tail: fat tails, value at risk and expected shortfall.

const tailModel = (values: ParamValues, t: number) => {
  const vol = param(values, "dailyVol", 1, 0.05, 20);
  const nu = param(values, "dof", 3, 2.1, 100);
  const confidence = param(values, "confidence", 99, 80, 99.9) / 100;
  const days = Math.round(param(values, "days", 25_200, 100, 25_200));
  const position = param(values, "position", 100_000, 0, 1e12);
  const random = mulberry32(seedOf(values));
  /** Scale that gives the t draws a standard deviation of vol. */
  const scale = vol * Math.sqrt((nu - 2) / nu);
  const returns = Array.from(
    { length: days },
    () => scale * studentDraw(random, nu)
  );
  const now = dayAt(days, t);
  const sample = returns.slice(0, now);
  const sorted = [...sample].sort((left, right) => left - right);
  const tailDays = Math.min(
    Math.max(Math.floor((1 - confidence) * now), 1),
    now
  );
  const histVar = -(sorted[tailDays - 1] as number);
  const histEs = -meanOf(sorted.slice(0, tailDays));
  const z = -lowerQuantile(normCdf, 1 - confidence);
  const q = -lowerQuantile((x) => tLowerTail(x, nu), 1 - confidence);
  return {
    confidence,
    days,
    fatEs:
      (((scale * tPdf(q, nu)) / (1 - confidence)) * (nu + q * q)) / (nu - 1),
    fatVar: q * scale,
    histEs,
    histVar,
    normalEs: (vol * normPdf(z)) / (1 - confidence),
    normalVar: z * vol,
    now,
    nu,
    position,
    sample,
    scale,
    tailDays,
    vol,
    worst: minOf(sample),
  };
};

const tailScene = (values: ParamValues, t: number): SceneData => {
  const model = tailModel(values, t);
  const { scale, vol, nu, now, sample } = model;
  const edge = 8 * vol;
  const bins = 64;
  const width = (2 * edge) / bins;
  const counts = new Array<number>(bins).fill(0);
  for (const value of sample) {
    const index = Math.floor((value + edge) / width);
    if (index >= 0 && index < bins)
      counts[index] = (counts[index] as number) + 1;
  }
  const bars: Bar[] = counts.flatMap((hits, index) =>
    hits > 0
      ? [
          {
            element: "bars",
            tone: true,
            width,
            x: -edge + (index + 0.5) * width,
            y: hits / (now * width),
          },
        ]
      : []
  );
  const xs = grid(-edge, edge, 241);
  const normal = xs.map((x) => [x, normPdf(x / vol) / vol] as const);
  const fat = xs.map((x) => [x, tPdf(x / scale, nu) / scale] as const);
  const peak = Math.max(
    maxOf(bars.map((bar) => bar.y)),
    maxOf(normal.map((point) => point[1])),
    maxOf(fat.map((point) => point[1]))
  );
  const inside = (x: number): number => Math.min(Math.max(x, -edge), edge);
  const level = (model.confidence * 100).toFixed(1);
  const markers: Marker[] = [
    {
      element: "tail",
      kind: "band",
      label: `Worst ${(100 - model.confidence * 100).toFixed(1)}% of days`,
      x: -edge,
      x2: inside(-model.histVar),
    },
    {
      element: "var",
      kind: "vline",
      label: `VaR ${level}%: ${pct(model.histVar)} (simulated days)`,
      x: inside(-model.histVar),
    },
    {
      element: "var",
      kind: "vline",
      label: `Bell-curve VaR: ${pct(model.normalVar)}`,
      x: inside(-model.normalVar),
    },
    {
      element: "es",
      kind: "vline",
      label: `Expected shortfall: ${pct(model.histEs)}`,
      x: inside(-model.histEs),
    },
  ];
  const logOf = (points: readonly Point[]): Point[] =>
    points.map(([x, y]) => [x, Math.max(Math.log10(y), -30)]);
  const logNormal = logOf(normal);
  const logFat = logOf(fat);
  return {
    horizon: model.days,
    layout: "stack",
    now,
    panels: [
      {
        bars,
        elements: ["axes", "bars", "normal", "fat", "var", "es", "tail"],
        id: "histogram",
        markers,
        series: [
          {
            element: "normal",
            label: `Bell curve (σ ${pct(vol)} a day)`,
            points: normal,
            width: 2,
          },
          {
            element: "fat",
            label: `Student t, ${nu.toFixed(1)} degrees of freedom (same σ)`,
            points: fat,
            width: 2,
          },
        ],
        title: `Daily returns: ${now.toLocaleString("en-US")} simulated days (fat-tailed draws)`,
        xDomain: [-edge, edge],
        xFormat: "pct",
        xLabel: "Daily return (%)",
        yDomain: [0, peak * 1.1],
        yFormat: "num",
        yLabel: "Density (share of days per 1%)",
      },
      {
        bars: [],
        elements: ["axes", "normal", "fat"],
        id: "log-tails",
        markers: [],
        series: [
          {
            element: "normal",
            label: "Bell curve (log10)",
            points: logNormal,
            width: 2,
          },
          {
            element: "fat",
            label: "Student t (log10)",
            points: logFat,
            width: 2,
          },
        ],
        title: "Same densities on a log10 scale: the bell curve's tails vanish",
        xDomain: [-edge, edge],
        xFormat: "pct",
        xLabel: "Daily return (%)",
        yDomain: span([...logNormal, ...logFat].map((point) => point[1])),
        yFormat: "num",
        yLabel: "log10 density",
      },
    ],
    timeLabel: "Simulated trading days",
    timeUnit: "days",
  };
};

const tailTables = (values: ParamValues, t: number): DataTable[] => {
  const model = tailModel(values, t);
  const { confidence, now, nu, position, sample, scale, vol } = model;
  const level = `${(confidence * 100).toFixed(1)}%`;
  const threshold = 5 * vol;
  const beyond = sample.filter((value) => Math.abs(value) > threshold).length;
  const pastBellVar = sample.filter((value) => value < -model.normalVar).length;
  const calm = sample.filter((value) => Math.abs(value) <= vol).length;
  return [
    {
      columns: ["Measure", "Bell curve", "Student t", "Simulated days"],
      id: "var-es",
      note: `Simulated: historical method on ${now.toLocaleString("en-US")} days (the ${model.tailDays} worst days form the tail). Position ${usd(position)}.`,
      rows: [
        [
          `VaR ${level}, one day (%)`,
          pct(model.normalVar),
          pct(model.fatVar),
          pct(model.histVar),
        ],
        [
          `VaR ${level}, one day ($)`,
          usd((model.normalVar / 100) * position),
          usd((model.fatVar / 100) * position),
          usd((model.histVar / 100) * position),
        ],
        [
          "Expected shortfall (%)",
          pct(model.normalEs),
          pct(model.fatEs),
          pct(model.histEs),
        ],
        [
          "Expected shortfall ($)",
          usd((model.normalEs / 100) * position),
          usd((model.fatEs / 100) * position),
          usd((model.histEs / 100) * position),
        ],
      ],
      title: `Value at risk and expected shortfall at ${level}`,
    },
    {
      columns: [
        `Over ${now.toLocaleString("en-US")} days`,
        "Bell curve (expected)",
        "Student t (expected)",
        "Simulated",
      ],
      id: "tail-counts",
      note: `Worst simulated day: ${pct(model.worst)}. Both curves have the same daily volatility ${pct(vol)}.`,
      rows: [
        [
          `Days moving more than ${pct(threshold, 1)} (5σ) either way`,
          count(now * 2 * normCdf(-5)),
          count(now * 2 * tLowerTail(-threshold / scale, nu)),
          String(beyond),
        ],
        [
          `Days losing more than the bell-curve VaR (${pct(model.normalVar)})`,
          count(now * (1 - confidence)),
          count(now * tLowerTail(-model.normalVar / scale, nu)),
          String(pastBellVar),
        ],
        [
          `Calm days (within ±${pct(vol, 1)})`,
          pct(100 * (1 - 2 * normCdf(-1)), 1),
          pct(100 * (1 - 2 * tLowerTail(-vol / scale, nu)), 1),
          pct((100 * calm) / now, 1),
        ],
      ],
      title: "How often big days happen: expected vs simulated",
    },
  ];
};

// ---------------------------------------------------------------------------
// GARCH weights shared by volcluster and voltarget.

const garchWeights = (values: ParamValues, withGamma: boolean) => {
  const longRunVol = param(values, "longRunVol", 15.9, 1, 150);
  const dailyVar = (longRunVol / ROOT_YEAR) ** 2;
  const alpha = param(values, "alpha", 0.1, 0, 0.5);
  const gamma = withGamma ? param(values, "gamma", 0, 0, 0.5) : 0;
  const asked = param(values, "beta", 0.85, 0, 0.999);
  const beta = Math.min(asked, MAX_PERSISTENCE - alpha - gamma / 2);
  const persistence = alpha + beta + gamma / 2;
  return {
    alpha,
    beta,
    betaCapped: beta < asked,
    dailyVar,
    gamma,
    longRunVol,
    omega: dailyVar * (1 - persistence),
    persistence,
  };
};

// ---------------------------------------------------------------------------
// volcluster: GARCH / GJR-GARCH clustering, shock decay and news impact.

const clusterModel = (values: ParamValues, t: number) => {
  const weights = garchWeights(values, true);
  const { alpha, beta, gamma, omega, dailyVar } = weights;
  const days = Math.round(param(values, "days", 750, 50, 2520));
  const shockDay = Math.round(param(values, "shockDay", 250, 0, days - 1));
  const shockPct = param(values, "shockPct", -4, -50, 50);
  const symmetric = alpha + gamma / 2;
  const random = mulberry32(seedOf(values));
  const returns: number[] = [];
  const gjrVol: number[] = [];
  const garchVol: number[] = [];
  let gjrVar = dailyVar;
  let garchVar = dailyVar;
  for (let day = 0; day < days; day += 1) {
    const draw = Math.sqrt(gjrVar) * gaussian(random);
    const move = day === shockDay ? shockPct : draw;
    returns.push(move);
    gjrVol.push(Math.sqrt(gjrVar));
    garchVol.push(Math.sqrt(garchVar));
    gjrVar =
      omega + (alpha + (move < 0 ? gamma : 0)) * move * move + beta * gjrVar;
    garchVar = omega + symmetric * move * move + beta * garchVar;
  }
  /** Tomorrow's variance after today's move, starting from a calm (long-run) day. */
  const impact = (move: number, asymmetric: boolean): number =>
    omega +
    (asymmetric ? alpha + (move < 0 ? gamma : 0) : symmetric) * move * move +
    beta * dailyVar;
  return {
    ...weights,
    days,
    garchVol,
    gjrVol,
    impact,
    now: dayAt(days, t),
    returns,
    shockDay,
    shockPct,
  };
};

const clusterScene = (values: ParamValues, t: number): SceneData => {
  const model = clusterModel(values, t);
  const { days, now, returns, gjrVol, garchVol, shockDay, shockPct } = model;
  const bars: Bar[] = returns
    .slice(0, now)
    .map((move, day) => ({ element: "bars", width: 1, x: day, y: move }));
  const upper = gjrVol.map((vol, day) => [day, 2 * vol] as const);
  const lower = gjrVol.map((vol, day) => [day, -2 * vol] as const);
  const reach =
    Math.max(maxOf(returns.map((move) => Math.abs(move))), 2 * maxOf(gjrVol)) *
    1.1;
  const annual = (vols: readonly number[]): Point[] =>
    vols.map((vol, day) => [day, vol * ROOT_YEAR]);
  const garchLine = annual(garchVol);
  const gjrLine = annual(gjrVol);
  const top =
    Math.max(
      maxOf(garchLine.map((point) => point[1])),
      maxOf(gjrLine.map((point) => point[1])),
      model.longRunVol
    ) * 1.1;
  const shock: Marker = {
    element: "shock",
    kind: "vline",
    label: `Shock day: ${shockPct > 0 ? "+" : ""}${pct(shockPct, 1)}`,
    x: shockDay,
  };
  const reachNews = Math.max(
    1.5 * Math.abs(shockPct),
    4 * Math.sqrt(model.dailyVar),
    1
  );
  const moves = grid(-reachNews, reachNews, 201);
  const garchNews = moves.map(
    (move) => [move, model.impact(move, false)] as const
  );
  const gjrNews = moves.map(
    (move) => [move, model.impact(move, true)] as const
  );
  const newsTop =
    Math.max(
      maxOf(garchNews.map((point) => point[1])),
      maxOf(gjrNews.map((point) => point[1]))
    ) * 1.1;
  return {
    horizon: days,
    layout: "stack",
    now,
    panels: [
      {
        bars,
        elements: ["axes", "bars", "band", "shock"],
        id: "returns",
        markers: [shock],
        series: [
          {
            element: "band",
            fill: true,
            label: "±2σ_t band",
            points: upper,
            revealTo: now,
            width: 1,
          },
          {
            element: "band",
            fill: true,
            label: "",
            points: lower,
            revealTo: now,
            width: 1,
          },
        ],
        title:
          "Simulated daily returns with a ±2σ_t band: calm and stormy stretches",
        xDomain: [0, days],
        xFormat: "day",
        xLabel: "Trading day",
        yDomain: [-reach, reach],
        yFormat: "pct",
        yLabel: "Daily return (%)",
      },
      {
        bars: [],
        elements: ["axes", "garch", "gjr", "longRun", "shock"],
        id: "vol",
        markers: [
          {
            element: "longRun",
            kind: "hline",
            label: `Long-run level ${pct(model.longRunVol, 1)}`,
            y: model.longRunVol,
          },
          shock,
        ],
        series: [
          {
            element: "garch",
            label: "GARCH(1,1) forecast σ_t",
            points: garchLine,
            revealTo: now,
            width: 2,
          },
          {
            element: "gjr",
            label: "GJR-GARCH forecast σ_t",
            points: gjrLine,
            revealTo: now,
            width: 2,
          },
        ],
        title:
          "Conditional volatility (annualized): jumps after big moves, then decays",
        xDomain: [0, days],
        xFormat: "day",
        xLabel: "Trading day",
        yDomain: [0, top],
        yFormat: "pct",
        yLabel: "Volatility (% a year)",
      },
      {
        bars: [],
        elements: ["axes", "garch", "gjr", "shock"],
        id: "news-impact",
        markers: [{ ...shock, label: "Shock size" }],
        series: [
          {
            element: "garch",
            label: "GARCH: same reaction to drops and rises",
            points: garchNews,
            width: 2,
          },
          {
            element: "gjr",
            label: "GJR: drops count with α + γ",
            points: gjrNews,
            width: 2,
          },
        ],
        title:
          "News impact: tomorrow's variance after today's move (from a calm day)",
        xDomain: [-reachNews, reachNews],
        xFormat: "pct",
        xLabel: "Today's move (%)",
        yDomain: [0, newsTop],
        yFormat: "num",
        yLabel: "Tomorrow's variance (%² a day)",
      },
    ],
    timeLabel: "Trading day",
    timeUnit: "days",
  };
};

/** Days in the separate long run that measures clustering. */
const LONG_RUN_DAYS = 40_000;

/** Share of big days, overall and right after a big day, in one long run of the model (no forced shock). */
const clusteringOf = (values: ParamValues) => {
  const { alpha, beta, gamma, omega, dailyVar } = garchWeights(values, true);
  const limit = 2.5 * Math.sqrt(dailyVar);
  const random = mulberry32(seedOf(values) + 1);
  let variance = dailyVar;
  let wasBig = false;
  let big = 0;
  let afterBig = 0;
  let bigAfterBig = 0;
  for (let day = 0; day < LONG_RUN_DAYS; day += 1) {
    const move = Math.sqrt(variance) * gaussian(random);
    const isBig = Math.abs(move) > limit;
    if (wasBig) afterBig += 1;
    if (wasBig && isBig) bigAfterBig += 1;
    if (isBig) big += 1;
    wasBig = isBig;
    variance =
      omega + (alpha + (move < 0 ? gamma : 0)) * move * move + beta * variance;
  }
  return {
    after: bigAfterBig / Math.max(afterBig, 1),
    base: big / LONG_RUN_DAYS,
    limit,
  };
};

const clusterTables = (values: ParamValues, t: number): DataTable[] => {
  const model = clusterModel(values, t);
  const { dailyVar, persistence, shockPct } = model;
  const size = Math.abs(shockPct);
  const both = (variance: number): string =>
    `${pct(Math.sqrt(variance))} a day (${pct(Math.sqrt(variance) * ROOT_YEAR, 1)} a year)`;
  const first = model.impact(shockPct, true);
  const halfLife = Math.log(0.5) / Math.log(persistence);
  const clustering = clusteringOf(values);
  return [
    {
      columns: ["Today's move", "GARCH forecast", "GJR-GARCH forecast"],
      id: "news-impact",
      note: `Weights: ω ${model.omega.toFixed(4)}, α ${model.alpha.toFixed(3)}, β ${model.beta.toFixed(3)}${model.betaCapped ? " (lowered so α + β + γ/2 stays below 1)" : ""}, γ ${model.gamma.toFixed(3)} (%² a day). The GARCH line uses α + γ/2, the same average reaction.`,
      rows: [
        [
          `Rise of ${pct(size, 1)}`,
          both(model.impact(size, false)),
          both(model.impact(size, true)),
        ],
        [
          `Drop of ${pct(size, 1)}`,
          both(model.impact(-size, false)),
          both(model.impact(-size, true)),
        ],
        ["No move", both(model.impact(0, false)), both(model.impact(0, true))],
      ],
      title: "Tomorrow's volatility after one move on a calm day",
    },
    {
      columns: [
        "Days after the shock",
        "Forecast volatility",
        "Extra variance left",
      ],
      id: "decay",
      note: `Persistence α + β + γ/2 = ${persistence.toFixed(3)}: the extra variance halves about every ${halfLife.toFixed(1)} trading days.`,
      rows: [1, 5, 10, 30].map((ahead) => {
        const left = persistence ** (ahead - 1);
        return [
          String(ahead),
          both(dailyVar + left * (first - dailyVar)),
          pct(100 * left, 1),
        ];
      }),
      title: `Decay of a ${pct(shockPct, 1)} shock on a calm day (expected forecast)`,
    },
    {
      columns: ["Simulated days", "Share of days"],
      id: "clustering",
      note: `One separate run of ${LONG_RUN_DAYS.toLocaleString("en-US")} days of the same model, without the forced shock. Clustering is built into the model, so this shows the model, not a market.`,
      rows: [
        [
          `Move bigger than ${pct(clustering.limit)} (2.5 × long-run daily vol)`,
          pct(100 * clustering.base),
        ],
        [
          "Same, on the day right after such a move",
          pct(100 * clustering.after),
        ],
        [
          "How many times as often",
          `${(clustering.after / Math.max(clustering.base, 1e-12)).toFixed(1)}x`,
        ],
      ],
      title: "Volatility clustering: big days follow big days",
    },
  ];
};

// ---------------------------------------------------------------------------
// voltarget: exposure = target / forecast on a GARCH asset.

const targetModel = (values: ParamValues, t: number) => {
  const weights = garchWeights(values, false);
  const { alpha, beta, omega, dailyVar } = weights;
  const target = param(values, "targetVol", 10, 0.5, 100);
  const cap = param(values, "maxLeverage", 2, 0.1, 10);
  const drift = param(values, "drift", 5, -50, 50);
  const days = Math.round(param(values, "days", 2520, 50, 2520));
  const random = mulberry32(seedOf(values));
  const forecast: number[] = [];
  const exposure: number[] = [];
  const holdReturns: number[] = [];
  const targetedReturns: number[] = [];
  const hold = [100];
  const targeted = [100];
  let variance = dailyVar;
  for (let day = 0; day < days; day += 1) {
    const annualVol = Math.sqrt(variance) * ROOT_YEAR;
    const weight = Math.min(target / annualVol, cap);
    const shock = Math.sqrt(variance) * gaussian(random);
    const move = drift / TRADING_DAYS + shock;
    forecast.push(annualVol);
    exposure.push(weight);
    holdReturns.push(move);
    targetedReturns.push(weight * move);
    hold.push(Math.max((hold[day] as number) * (1 + move / 100), 0));
    targeted.push(
      Math.max((targeted[day] as number) * (1 + (weight * move) / 100), 0)
    );
    variance = omega + alpha * shock * shock + beta * variance;
  }
  return {
    ...weights,
    cap,
    days,
    exposure,
    forecast,
    hold,
    holdReturns,
    now: dayAt(days, t),
    target,
    targeted,
    targetedReturns,
  };
};

const targetScene = (values: ParamValues, t: number): SceneData => {
  const model = targetModel(values, t);
  const { cap, days, now, target } = model;
  const byDay = (list: readonly number[], scale = 1): Point[] =>
    list.map((value, day) => [day, value * scale]);
  const forecast = byDay(model.forecast);
  const exposure = byDay(model.exposure, 100);
  const hold = byDay(model.hold);
  const targeted = byDay(model.targeted);
  const equity = [...model.hold, ...model.targeted];
  return {
    horizon: days,
    layout: "stack",
    now,
    panels: [
      {
        bars: [],
        elements: ["axes", "forecast", "target"],
        id: "forecast",
        markers: [
          {
            element: "target",
            kind: "hline",
            label: `Target ${pct(target, 1)} a year`,
            y: target,
          },
        ],
        series: [
          {
            element: "forecast",
            label: "GARCH forecast volatility (annualized)",
            points: forecast,
            revealTo: now,
            width: 2,
          },
        ],
        title: "Forecast volatility vs your target",
        xDomain: [0, days],
        xFormat: "day",
        xLabel: "Trading day",
        yDomain: [0, Math.max(maxOf(model.forecast), target) * 1.1],
        yFormat: "pct",
        yLabel: "Volatility (% a year)",
      },
      {
        bars: [],
        elements: ["axes", "exposure"],
        id: "exposure",
        markers: [],
        series: [
          {
            element: "exposure",
            fill: true,
            label: `Exposure = target / forecast (cap ${cap.toFixed(1)}x)`,
            points: exposure,
            revealTo: now,
            width: 2,
          },
        ],
        title: "Exposure: share of your money in the market",
        xDomain: [0, days],
        xFormat: "day",
        xLabel: "Trading day",
        yDomain: [0, cap * 110],
        yFormat: "pct",
        yLabel: "Exposure (%)",
      },
      {
        bars: [],
        elements: ["axes", "hold", "targeted"],
        id: "equity",
        markers: [],
        series: [
          {
            element: "hold",
            label: "Buy and hold",
            points: hold,
            revealTo: now,
            width: 2,
          },
          {
            element: "targeted",
            label: "Volatility targeted",
            points: targeted,
            revealTo: now,
            width: 3,
          },
        ],
        title: "Growth of $100: buy and hold vs volatility targeting",
        xDomain: [0, days],
        xFormat: "day",
        xLabel: "Trading day",
        yDomain: [Math.min(minOf(equity), 100) * 0.95, maxOf(equity) * 1.05],
        yFormat: "usd",
        yLabel: "Value ($)",
      },
    ],
    timeLabel: "Trading day",
    timeUnit: "days",
  };
};

const targetTables = (values: ParamValues, t: number): DataTable[] => {
  const model = targetModel(values, t);
  const { now } = model;
  const stats = (returns: readonly number[], equity: readonly number[]) => ({
    drawdown: maxDrawdown(equity.slice(0, now + 1)),
    final: equity[now] as number,
    vol: stdevOf(returns.slice(0, now)) * ROOT_YEAR,
  });
  const hold = stats(model.holdReturns, model.hold);
  const targeted = stats(model.targetedReturns, model.targeted);
  return [
    {
      columns: ["Measure", "Buy and hold", "Volatility targeted"],
      id: "vol-target",
      note: `First ${now.toLocaleString("en-US")} simulated days; target ${pct(model.target, 1)} a year, cap ${model.cap.toFixed(1)}x. No costs and no interest on borrowed money.`,
      rows: [
        [
          "Realized volatility (a year)",
          pct(hold.vol, 1),
          pct(targeted.vol, 1),
        ],
        [
          "Max drawdown",
          pct(100 * hold.drawdown, 1),
          pct(100 * targeted.drawdown, 1),
        ],
        ["Value of $100", usd(hold.final), usd(targeted.final)],
        [
          "Average exposure",
          "100.0%",
          pct(100 * meanOf(model.exposure.slice(0, now)), 1),
        ],
      ],
      title: "Buy and hold vs volatility targeting",
    },
  ];
};

// ---------------------------------------------------------------------------
// filter: local-level Kalman filter with fade signals.

const filterModel = (values: ParamValues, t: number) => {
  const processNoise = param(values, "processNoise", 0.5, 0.001, 100);
  const measurementNoise = param(values, "measurementNoise", 2, 0.001, 100);
  const threshold = param(values, "threshold", 2, 0.1, 20);
  const days = Math.round(param(values, "days", 250, 20, 2000));
  const q = processNoise ** 2;
  const r = measurementNoise ** 2;
  const random = mulberry32(seedOf(values));
  const truth: number[] = [];
  const observed: number[] = [];
  const filtered: number[] = [];
  const predicted: number[] = [];
  const reach: number[] = [];
  const gain: number[] = [];
  const fades: number[] = [];
  let price = 100;
  let estimate = 100;
  let uncertainty = r;
  for (let day = 0; day < days; day += 1) {
    price += processNoise * gaussian(random);
    const seen = price + measurementNoise * gaussian(random);
    const prior = uncertainty + q;
    const spread = Math.sqrt(prior + r);
    const k = prior / (prior + r);
    truth.push(price);
    observed.push(seen);
    predicted.push(estimate);
    reach.push(threshold * spread);
    if (Math.abs(seen - estimate) > threshold * spread) fades.push(day);
    estimate += k * (seen - estimate);
    uncertainty = (1 - k) * prior;
    filtered.push(estimate);
    gain.push(k);
  }
  const steadyPrior = (q + Math.sqrt(q * q + 4 * q * r)) / 2;
  return {
    days,
    fades,
    filtered,
    gain,
    now: dayAt(days, t),
    observed,
    predicted,
    reach,
    steadyGain: steadyPrior / (steadyPrior + r),
    threshold,
    truth,
  };
};

const filterScene = (values: ParamValues, t: number): SceneData => {
  const model = filterModel(values, t);
  const { days, now, observed, truth } = model;
  const byDay = (list: readonly number[]): Point[] =>
    list.map((value, day) => [day, value]);
  const asDots = days <= 250;
  const observedDots: Marker[] = asDots
    ? observed.slice(0, now).map((value, day) => ({
        element: "observed",
        kind: "dot",
        label: "",
        x: day,
        y: value,
      }))
    : [];
  const fadeDots: Marker[] = model.fades
    .filter((day) => day < now)
    .slice(0, MAX_DOTS - observedDots.length)
    .map((day) => ({
      element: "fades",
      kind: "dot",
      label: "",
      x: day,
      y: observed[day] as number,
    }));
  const observedLine = asDots
    ? []
    : [
        {
          element: "observed",
          label: "Observed price (truth + noise)",
          points: byDay(observed),
          revealTo: now,
          width: 1,
        },
      ];
  return {
    horizon: days,
    layout: "stack",
    now,
    panels: [
      {
        bars: [],
        elements: ["axes", "truth", "observed", "filtered", "fades"],
        id: "prices",
        markers: [...observedDots, ...fadeDots],
        series: [
          {
            element: "truth",
            label: "Hidden true price",
            points: byDay(truth),
            revealTo: now,
            width: 1,
          },
          ...observedLine,
          {
            element: "filtered",
            label: "Kalman estimate",
            points: byDay(model.filtered),
            revealTo: now,
            width: 3,
          },
          {
            element: "fades",
            dashed: true,
            label: `Fade line: prediction ± ${model.threshold.toFixed(1)}σ`,
            points: model.predicted.map(
              (value, day) =>
                [day, value + (model.reach[day] as number)] as const
            ),
            revealTo: now,
            width: 1,
          },
          {
            element: "fades",
            dashed: true,
            label: "",
            points: model.predicted.map(
              (value, day) =>
                [day, value - (model.reach[day] as number)] as const
            ),
            revealTo: now,
            width: 1,
          },
        ],
        title: "Noisy observations, hidden truth and the Kalman estimate",
        xDomain: [0, days],
        xFormat: "day",
        xLabel: "Day",
        yDomain: span([...truth, ...observed]),
        yFormat: "price",
        yLabel: "Price ($)",
      },
      {
        bars: [],
        elements: ["axes", "gain"],
        id: "gain",
        markers: [],
        series: [
          {
            element: "gain",
            label: "Kalman gain K_t (weight on the new observation)",
            points: byDay(model.gain),
            revealTo: now,
            width: 2,
          },
        ],
        title: "Kalman gain: how much each new observation moves the estimate",
        xDomain: [0, days],
        xFormat: "day",
        xLabel: "Day",
        yDomain: [0, 1],
        yFormat: "num",
        yLabel: "Gain (0 to 1)",
      },
    ],
    timeLabel: "Day",
    timeUnit: "days",
  };
};

const filterTables = (values: ParamValues, t: number): DataTable[] => {
  const model = filterModel(values, t);
  const { now, observed, truth, threshold } = model;
  const rmse = (list: readonly number[]): number =>
    Math.sqrt(
      meanOf(
        list
          .slice(0, now)
          .map((value, day) => (value - (truth[day] as number)) ** 2)
      )
    );
  const fades = model.fades.filter((day) => day < now);
  const reversions = fades
    .filter((day) => day + 1 < now)
    .map((day) => {
      const side = Math.sign(
        (observed[day] as number) - (model.predicted[day] as number)
      );
      return (
        -side * ((observed[day + 1] as number) - (observed[day] as number))
      );
    });
  return [
    {
      columns: ["Measure", "Value"],
      id: "kalman",
      note: `First ${now.toLocaleString("en-US")} simulated days. Noise is normal and independent by construction, so far-off observations snap back here; real prices need not.`,
      rows: [
        [
          "Kalman gain on the last shown day",
          (model.gain[now - 1] as number).toFixed(3),
        ],
        ["Steady-state Kalman gain", model.steadyGain.toFixed(3)],
        [
          "Typical error of the observations (RMSE vs truth)",
          `$${rmse(observed).toFixed(2)}`,
        ],
        [
          "Typical error of the Kalman estimate (RMSE vs truth)",
          `$${rmse(model.filtered).toFixed(2)}`,
        ],
        [
          `Fade signals (more than ${threshold.toFixed(1)}σ from the prediction)`,
          `${fades.length} (about ${count(now * 2 * normCdf(-threshold))} expected from noise alone)`,
        ],
        [
          "Average next-day move back toward the estimate after a fade",
          reversions.length > 0 ? `$${meanOf(reversions).toFixed(2)}` : "n/a",
        ],
      ],
      title: "Kalman filter accuracy and fade signals",
    },
  ];
};

// ---------------------------------------------------------------------------

type Builder<T> = (values: ParamValues, t: number) => T;

const SCENES: Readonly<Record<VolatilityMode, Builder<SceneData>>> = {
  filter: filterScene,
  tail: tailScene,
  volcluster: clusterScene,
  voltarget: targetScene,
};

const TABLES: Readonly<Record<VolatilityMode, Builder<DataTable[]>>> = {
  filter: filterTables,
  tail: tailTables,
  volcluster: clusterTables,
  voltarget: targetTables,
};

/** Scene of one volatility mode at param values and time fraction ctx.t. */
export const volatilityScene = (
  mode: VolatilityMode,
  ctx: SceneCtx
): SceneData => SCENES[mode](ctx.values, ctx.t);

/** Mode-specific data tables (the inputs and constants tables are added by tables.ts). */
export const volatilityTables = (
  mode: VolatilityMode,
  values: ParamValues,
  t: number
): DataTable[] => TABLES[mode](values, t);
