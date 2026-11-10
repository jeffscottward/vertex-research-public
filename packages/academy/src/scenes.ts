// What: Pure scene builders. A scene turns a lesson's scene spec, its param values and a time
// fraction (0 = entry, 1 = horizon) into panels of series, bars, markers and surfaces in data
// coordinates. The React chart draws these panels; the video renders the same panels frame by frame.
import {
  blackScholes,
  DAYS_PER_YEAR,
  expectedMove,
  gaussian,
  lognormalPdf,
  mulberry32,
  realizedVol,
} from "./math.ts";
import {
  entryCost,
  horizonOf,
  marketOf,
  num,
  type ParamValues,
  payoffSummary,
  positionAt,
  type ResolvedLeg,
  resolveLegs,
} from "./position.ts";
import { QUANT_COLORS, quantScene } from "./quant/index.ts";
import {
  clamp01,
  grid,
  type Marker,
  nth,
  type Panel,
  type SceneCtx,
  type SceneData,
  type Series,
  type Surface,
  span,
  withZero,
} from "./scene-kit.ts";
import type { ColorToken, LessonSpec, Scene } from "./schema.ts";

/** Default element colors. A lesson step that reveals an element overrides its color. */
export const DEFAULT_ELEMENT_COLORS: Readonly<Record<string, ColorToken>> = {
  ...QUANT_COLORS,
  a: "gold",
  axes: "gray",
  b: "blue",
  band1: "cyan",
  band2: "blue",
  bars: "green",
  breakeven: "amber",
  callWall: "green",
  cash: "gray",
  core: "blue",
  curve: "red",
  delta: "blue",
  diff: "violet",
  drawdown: "red",
  ev: "gold",
  events: "amber",
  expiry: "gold",
  flip: "amber",
  gamma: "violet",
  iv: "violet",
  legs: "gray",
  marker: "amber",
  maxLoss: "red",
  maxProfit: "green",
  median: "gold",
  now: "blue",
  options: "violet",
  paths: "gray",
  pdf: "violet",
  pnl: "green",
  pop: "green",
  price: "gray",
  putWall: "red",
  rv: "cyan",
  spot: "cyan",
  strikes: "violet",
  surface: "violet",
  theta: "red",
  vega: "cyan",
  vrp: "green",
  zones: "green",
};

/** Element colors for a lesson: first revealing step wins, then the defaults. */
export const elementColors = (
  lesson: Pick<LessonSpec, "steps">
): Record<string, ColorToken> => {
  const colors: Record<string, ColorToken> = { ...DEFAULT_ELEMENT_COLORS };
  const seen = new Set<string>();
  for (const step of lesson.steps) {
    if (seen.has(step.element)) continue;
    seen.add(step.element);
    colors[step.element] = step.color;
  }
  return colors;
};

/** Price range wide enough for strikes and a 2.5 sigma move over the horizon. */
const priceRange = (
  spot: number,
  vol: number,
  days: number,
  legs: readonly ResolvedLeg[]
): [number, number] => {
  const move = Math.max(expectedMove(spot, vol, days) * 2.5, spot * 0.15);
  const strikes = legs
    .filter((leg) => leg.kind !== "stock")
    .map((leg) => leg.strike);
  const low = Math.min(spot - move, ...strikes.map((strike) => strike * 0.9));
  const high = Math.max(spot + move, ...strikes.map((strike) => strike * 1.1));
  return [Math.max(low, 0.01), high];
};

type Ctx = SceneCtx;

const strikeMarkers = (legs: readonly ResolvedLeg[]): Marker[] => {
  const unique = [
    ...new Set(
      legs.filter((leg) => leg.kind !== "stock").map((leg) => leg.strike)
    ),
  ];
  return unique.map((strike) => ({
    element: "strikes",
    kind: "vline",
    label: `K ${strike.toFixed(2)}`,
    x: strike,
  }));
};

/** Days to the structure's expiry, or the lesson horizon when it has no option legs. */
export const effectiveHorizon = (
  legs: readonly ResolvedLeg[],
  values: ParamValues
): number => {
  const horizon = horizonOf(legs);
  return Number.isFinite(horizon)
    ? horizon
    : Math.max(num(values, "days", 30), 1);
};

const payoffPanels = (
  legs: readonly ResolvedLeg[],
  ctx: Ctx,
  view: "2d" | "3d"
): { panels: Panel[]; horizon: number } => {
  const market = marketOf(ctx.values);
  const horizon = effectiveHorizon(legs, ctx.values);
  const elapsed = horizon * ctx.t;
  const [low, high] = priceRange(market.spot, market.vol, horizon, legs);
  const xs = grid(low, high, 161);
  const expiry = xs.map(
    (x) => [x, positionAt(legs, x, horizon, market.rate).pnl] as const
  );
  const now = xs.map(
    (x) => [x, positionAt(legs, x, elapsed, market.rate).pnl] as const
  );
  const legSeries: Series[] = legs.map((leg) => ({
    dashed: true,
    element: "legs",
    label: leg.label,
    points: xs.map(
      (x) => [x, positionAt([leg], x, horizon, market.rate).pnl] as const
    ),
    width: 1.25,
  }));
  const summary = payoffSummary(legs, market.spot, market.rate);
  const yDomain = withZero(span([...expiry, ...now].map((point) => point[1])));
  const markers: Marker[] = [
    {
      element: "spot",
      kind: "vline",
      label: `Spot ${market.spot.toFixed(2)}`,
      x: market.spot,
    },
    ...strikeMarkers(legs),
    ...summary.breakevens
      .filter((value) => value >= low && value <= high)
      .map((value) => ({
        element: "breakeven",
        kind: "dot" as const,
        label: `BE ${value.toFixed(2)}`,
        x: value,
        y: 0,
      })),
    ...(summary.maxProfit === null
      ? []
      : [
          {
            element: "maxProfit",
            kind: "hline" as const,
            label: `Max profit ${usd(summary.maxProfit)}`,
            y: summary.maxProfit,
          },
        ]),
    ...(summary.maxLoss === null
      ? []
      : [
          {
            element: "maxLoss",
            kind: "hline" as const,
            label: `Max loss ${usd(summary.maxLoss)}`,
            y: summary.maxLoss,
          },
        ]),
  ];
  const panel: Panel = {
    bars: [],
    elements: [
      "axes",
      "spot",
      "strikes",
      "legs",
      "expiry",
      "now",
      "zones",
      "breakeven",
      "maxProfit",
      "maxLoss",
    ],
    id: "payoff",
    markers,
    series: [
      ...legSeries,
      {
        element: "zones",
        label: "Profit / loss zones",
        points: expiry,
        signFill: true,
        width: 0,
      },
      { element: "expiry", label: "At expiry", points: expiry, width: 3 },
      {
        dashed: true,
        element: "now",
        label: `Day ${Math.round(elapsed)} of ${Math.round(horizon)}`,
        points: now,
        width: 2.5,
      },
    ],
    title: "Profit and loss vs underlying price",
    xDomain: [low, high],
    xFormat: "price",
    xLabel: "Underlying price",
    yDomain,
    yFormat: "usd",
    yLabel: "P&L ($)",
  };
  if (view === "2d") return { horizon, panels: [panel] };
  const sx = grid(low, high, 33);
  const sy = grid(0, horizon, 17);
  const surface: Surface = {
    element: "surface",
    sliceY: elapsed,
    xLabel: "Price",
    xs: sx,
    yLabel: "Days elapsed",
    ys: sy,
    z: sy.map((day) =>
      sx.map((x) => positionAt(legs, x, day, market.rate).pnl)
    ),
    zLabel: "P&L ($)",
  };
  return {
    horizon,
    panels: [
      panel,
      {
        bars: [],
        elements: ["surface"],
        id: "surface",
        markers: [],
        series: [],
        surface,
        title: "P&L surface over price and time",
        xDomain: [low, high],
        xFormat: "price",
        xLabel: "Price",
        yDomain,
        yFormat: "usd",
        yLabel: "P&L ($)",
      },
    ],
  };
};

export const usd = (value: number): string => {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  return `${sign}$${abs >= 10_000 ? Math.round(abs).toLocaleString("en-US") : abs.toFixed(abs >= 100 ? 0 : 2)}`;
};

const compareScene = (
  scene: Extract<Scene, { type: "compare" }>,
  ctx: Ctx
): SceneData => {
  const market = marketOf(ctx.values);
  const a = resolveLegs(scene.a.legs, ctx.values);
  const b = resolveLegs(scene.b.legs, ctx.values);
  const horizon = Math.min(
    effectiveHorizon(a, ctx.values),
    effectiveHorizon(b, ctx.values)
  );
  const elapsed = horizon * ctx.t;
  const [low, high] = priceRange(market.spot, market.vol, horizon, [
    ...a,
    ...b,
  ]);
  const xs = grid(low, high, 161);
  const line = (legs: readonly ResolvedLeg[], at: number) =>
    xs.map((x) => [x, positionAt(legs, x, at, market.rate).pnl] as const);
  // Both solid lines stop at the shorter expiry; the longer side's line is labeled by its day.
  const endLabel = (legs: readonly ResolvedLeg[]) => {
    const own = effectiveHorizon(legs, ctx.values);
    return own > horizon
      ? `at day ${Math.round(horizon)} of ${Math.round(own)}`
      : "at expiry";
  };
  const aExpiry = line(a, horizon);
  const bExpiry = line(b, horizon);
  const aNow = line(a, elapsed);
  const bNow = line(b, elapsed);
  const diff = xs.map(
    (x, index) => [x, nth(aNow, index)[1] - nth(bNow, index)[1]] as const
  );
  const breakevens = [
    ...payoffSummary(a, market.spot, market.rate).breakevens.map((x) => ({
      label: `${scene.a.label} BE`,
      x,
    })),
    ...payoffSummary(b, market.spot, market.rate).breakevens.map((x) => ({
      label: `${scene.b.label} BE`,
      x,
    })),
  ].filter((entry) => entry.x >= low && entry.x <= high);
  return {
    horizon,
    layout: "stack",
    now: elapsed,
    panels: [
      {
        bars: [],
        elements: ["axes", "spot", "a", "b", "diff", "breakeven"],
        id: "compare",
        markers: [
          {
            element: "spot",
            kind: "vline",
            label: `Spot ${market.spot.toFixed(2)}`,
            x: market.spot,
          },
          ...breakevens.map((entry) => ({
            element: "breakeven",
            kind: "dot" as const,
            label: entry.label,
            x: entry.x,
            y: 0,
          })),
        ],
        series: [
          {
            element: "a",
            label: `${scene.a.label} ${endLabel(a)}`,
            points: aExpiry,
            width: 3,
          },
          {
            dashed: true,
            element: "a",
            label: `${scene.a.label} day ${Math.round(elapsed)}`,
            points: aNow,
            width: 1.75,
          },
          {
            element: "b",
            label: `${scene.b.label} ${endLabel(b)}`,
            points: bExpiry,
            width: 3,
          },
          {
            dashed: true,
            element: "b",
            label: `${scene.b.label} day ${Math.round(elapsed)}`,
            points: bNow,
            width: 1.75,
          },
          {
            element: "diff",
            label: `Difference (${scene.a.label} - ${scene.b.label})`,
            points: diff,
            width: 1.5,
          },
        ],
        title: `${scene.a.label} vs ${scene.b.label}`,
        xDomain: [low, high],
        xFormat: "price",
        xLabel: "Underlying price",
        yDomain: withZero(
          span(
            [...aExpiry, ...bExpiry, ...aNow, ...bNow, ...diff].map(
              (point) => point[1]
            )
          )
        ),
        yFormat: "usd",
        yLabel: "P&L ($)",
      },
    ],
    timeLabel: "Days elapsed",
    timeUnit: "days",
  };
};

const greeksScene = (legs: readonly ResolvedLeg[], ctx: Ctx): SceneData => {
  const market = marketOf(ctx.values);
  const horizon = effectiveHorizon(legs, ctx.values);
  const elapsed = Math.min(horizon * ctx.t, horizon - 0.25);
  const [low, high] = priceRange(market.spot, market.vol, horizon, legs);
  const xs = grid(low, high, 141);
  const points = xs.map((x) => ({
    p: positionAt(legs, x, elapsed, market.rate),
    x,
  }));
  const greek = (
    key: "delta" | "gamma" | "theta" | "vega",
    title: string,
    yLabel: string
  ): Panel => {
    const series = points.map(({ x, p }) => [x, p[key]] as const);
    return {
      bars: [],
      // Spot and strike steps reveal the panels (axes and markers) before the greek curve itself.
      elements: ["spot", "strikes", key],
      id: key,
      markers: [
        { element: "spot", kind: "vline", label: "Spot", x: market.spot },
        ...strikeMarkers(legs),
      ],
      series: [
        {
          element: key,
          label: `${title} on day ${Math.round(elapsed)}`,
          points: series,
          width: 2.5,
        },
      ],
      title,
      xDomain: [low, high],
      xFormat: "price",
      xLabel: "Underlying price",
      yDomain: withZero(span(series.map((point) => point[1]))),
      yFormat: "num",
      yLabel,
    };
  };
  return {
    horizon,
    layout: "grid",
    now: elapsed,
    panels: [
      greek("delta", "Delta (share equivalents)", "Delta"),
      greek("gamma", "Gamma (delta change per $1)", "Gamma"),
      greek("theta", "Theta ($ per day)", "Theta"),
      greek("vega", "Vega ($ per IV point)", "Vega"),
    ],
    timeLabel: "Days elapsed",
    timeUnit: "days",
  };
};

const distributionScene = (
  legs: readonly ResolvedLeg[],
  ctx: Ctx
): SceneData => {
  const market = marketOf(ctx.values);
  const fullDays =
    legs.length > 0
      ? effectiveHorizon(legs, ctx.values)
      : Math.max(num(ctx.values, "dte", 30), 1);
  const days = Math.max(fullDays * Math.max(ctx.t, 0.02), 0.5);
  // Real-world drift = risk-free rate + the "drift" param (excess return). With zero excess drift the
  // distribution matches the pricing measure, so a fairly priced structure has EV (net of carry) of about zero.
  const mu = market.rate + num(ctx.values, "drift", 0) / 100;
  const [low, high] = priceRange(market.spot, market.vol, fullDays, legs);
  const xs = grid(low, high, 201);
  const pdf = xs.map(
    (x) => [x, lognormalPdf(x, market.spot, market.vol, days, mu)] as const
  );
  const move = expectedMove(market.spot, market.vol, days);
  const panels: Panel[] = [
    {
      bars: [],
      elements: ["axes", "pdf", "band1", "band2", "spot"],
      id: "pdf",
      markers: [
        {
          element: "band2",
          kind: "band",
          label: `±2σ ${(2 * move).toFixed(2)}`,
          x: market.spot - 2 * move,
          x2: market.spot + 2 * move,
        },
        {
          element: "band1",
          kind: "band",
          label: `±1σ ${move.toFixed(2)}`,
          x: market.spot - move,
          x2: market.spot + move,
        },
        {
          element: "spot",
          kind: "vline",
          label: `Spot ${market.spot.toFixed(2)}`,
          x: market.spot,
        },
      ],
      series: [
        {
          element: "pdf",
          fill: true,
          label: "Lognormal density",
          points: pdf,
          width: 2.5,
        },
      ],
      title: `Price distribution after ${Math.round(days)} days (IV ${(market.vol * 100).toFixed(0)}%)`,
      xDomain: [low, high],
      xFormat: "price",
      xLabel: "Price",
      yDomain: [0, Math.max(...pdf.map((point) => point[1])) * 1.15],
      yFormat: "num",
      yLabel: "Probability density",
    },
  ];
  if (legs.length > 0) {
    const expiry = xs.map(
      (x) => [x, positionAt(legs, x, fullDays, market.rate).pnl] as const
    );
    const summary = payoffSummary(legs, market.spot, market.rate);
    panels.push({
      bars: [],
      elements: ["pop", "breakeven", "ev"],
      id: "pop",
      markers: [
        ...summary.breakevens
          .filter((value) => value >= low && value <= high)
          .map((value) => ({
            element: "breakeven",
            kind: "vline" as const,
            label: `BE ${value.toFixed(2)}`,
            x: value,
          })),
        {
          element: "ev",
          kind: "hline",
          label: `EV ${usd(expectedPnl(legs, market.spot, market.vol, fullDays, mu, market.rate))}`,
          y: expectedPnl(
            legs,
            market.spot,
            market.vol,
            fullDays,
            mu,
            market.rate
          ),
        },
      ],
      series: [
        {
          element: "pop",
          label: "Expiry P&L",
          points: expiry,
          signFill: true,
          width: 2.5,
        },
      ],
      title: "Payoff at expiry weighted by probability",
      xDomain: [low, high],
      xFormat: "price",
      xLabel: "Price",
      yDomain: withZero(span(expiry.map((point) => point[1]))),
      yFormat: "usd",
      yLabel: "P&L ($)",
    });
  }
  return {
    horizon: fullDays,
    layout: "stack",
    now: days,
    panels,
    timeLabel: "Days ahead",
    timeUnit: "days",
  };
};

/**
 * Expected expiry P&L under a lognormal with drift mu (numerical integration), net of the financing
 * carry: the entry cash could have earned the risk-free rate, so EV subtracts cost x (e^{rT} - 1).
 * With mu equal to the rate a fairly priced structure, stock included, then has EV of about zero.
 */
export const expectedPnl = (
  legs: readonly ResolvedLeg[],
  spot: number,
  vol: number,
  days: number,
  mu: number,
  rate: number
): number => {
  const sd = vol * Math.sqrt(days / DAYS_PER_YEAR);
  let total = 0;
  let mass = 0;
  for (let index = -400; index <= 400; index += 1) {
    const z = index / 80;
    const weight = Math.exp(-0.5 * z * z);
    const price =
      spot * Math.exp((mu - 0.5 * vol * vol) * (days / DAYS_PER_YEAR) + sd * z);
    total += weight * positionAt(legs, price, days, rate).pnl;
    mass += weight;
  }
  const carry = entryCost(legs) * (Math.exp(rate * (days / DAYS_PER_YEAR)) - 1);
  return total / mass - carry;
};

/** Probability that the expiry P&L is above zero under a lognormal with drift mu. */
export const probabilityOfProfit = (
  legs: readonly ResolvedLeg[],
  spot: number,
  vol: number,
  days: number,
  mu: number,
  rate: number
): number => {
  const sd = vol * Math.sqrt(days / DAYS_PER_YEAR);
  let win = 0;
  let mass = 0;
  for (let index = -400; index <= 400; index += 1) {
    const z = index / 80;
    const weight = Math.exp(-0.5 * z * z);
    const price =
      spot * Math.exp((mu - 0.5 * vol * vol) * (days / DAYS_PER_YEAR) + sd * z);
    if (positionAt(legs, price, days, rate).pnl > 0) win += weight;
    mass += weight;
  }
  return win / mass;
};

export type VolPath = Readonly<{
  price: number[];
  rv: number[];
  iv: number[];
  trueVol: number[];
}>;

/** Seeded price path with stochastic volatility, trailing 20-day realized vol and a modeled IV. */
export const volPath = (values: ParamValues): VolPath => {
  const days = Math.round(
    Math.min(Math.max(num(values, "days", 250), 40), 750)
  );
  const base = num(values, "rvBase", 25) / 100;
  const volOfVol = num(values, "volOfVol", 60) / 100;
  const premium = num(values, "ivPremium", 3) / 100;
  const drift = num(values, "drift", 6) / 100;
  const random = mulberry32(Math.round(num(values, "seed", 7)));
  const price = [Math.max(num(values, "spot", 100), 0.01)];
  const trueVol = [base];
  let x = 0;
  for (let day = 1; day <= days + 20; day += 1) {
    x = x * 0.94 + volOfVol * 0.25 * gaussian(random);
    const vol = base * Math.exp(x - 0.5 * volOfVol * volOfVol * 0.25);
    trueVol.push(vol);
    const last = nth(price, -1);
    price.push(
      last *
        Math.exp(
          (drift - 0.5 * vol * vol) / 252 +
            (vol / Math.sqrt(252)) * gaussian(random)
        )
    );
  }
  const rv = price.map((_, index) => realizedVol(price, index, 20) ?? base);
  const iv = price.map((_, index) => {
    const blend = Math.sqrt(0.6 * nth(rv, index) ** 2 + 0.4 * base ** 2);
    return Math.max(blend + premium + 0.01 * gaussian(random), 0.03);
  });
  return {
    iv: iv.slice(20),
    price: price.slice(20),
    rv: rv.slice(20),
    trueVol: trueVol.slice(20),
  };
};

const ivrvScene = (ctx: Ctx): SceneData => {
  const path = volPath(ctx.values);
  const horizon = path.price.length - 1;
  const now = Math.round(horizon * clamp01(ctx.t));
  const days = path.price.map((_, index) => index);
  const pricePoints = days.map((day) => [day, nth(path.price, day)] as const);
  const rvPoints = days.map((day) => [day, nth(path.rv, day) * 100] as const);
  const ivPoints = days.map((day) => [day, nth(path.iv, day) * 100] as const);
  const vrpPoints = days.map(
    (day) => [day, (nth(path.iv, day) - nth(path.rv, day)) * 100] as const
  );
  const reveal = Math.max(now, 1);
  return {
    horizon,
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
            label: "Price",
            points: pricePoints,
            revealTo: reveal,
            width: 2,
          },
        ],
        title: "Underlying price",
        xDomain: [0, horizon],
        xFormat: "day",
        xLabel: "Trading day",
        yDomain: span(pricePoints.map((point) => point[1])),
        yFormat: "price",
        yLabel: "Price",
      },
      {
        bars: [],
        elements: ["rv", "iv"],
        id: "vol",
        markers: [],
        series: [
          {
            element: "rv",
            label: "Realized vol (RV20)",
            points: rvPoints,
            revealTo: reveal,
            width: 2.25,
          },
          {
            element: "iv",
            label: "Implied vol (IV)",
            points: ivPoints,
            revealTo: reveal,
            width: 2.25,
          },
        ],
        title: "Implied vs realized volatility (20-day)",
        xDomain: [0, horizon],
        xFormat: "day",
        xLabel: "Trading day",
        yDomain: [
          0,
          Math.max(...ivPoints.map((p) => p[1]), ...rvPoints.map((p) => p[1])) *
            1.15,
        ],
        yFormat: "pct",
        yLabel: "Volatility (%)",
      },
      {
        bars: [],
        elements: ["vrp"],
        id: "vrp",
        markers: [],
        series: [
          {
            element: "vrp",
            label: "IV - RV",
            points: vrpPoints,
            revealTo: reveal,
            signFill: true,
            width: 1.5,
          },
        ],
        title: "Volatility risk premium (IV - RV)",
        xDomain: [0, horizon],
        xFormat: "day",
        xLabel: "Trading day",
        yDomain: withZero(span(vrpPoints.map((point) => point[1]))),
        yFormat: "num",
        yLabel: "IV - RV (pts)",
      },
    ],
    timeLabel: "Trading day",
    timeUnit: "days",
  };
};

export type GexRow = Readonly<{
  strike: number;
  callOi: number;
  putOi: number;
  callGex: number;
  putGex: number;
  net: number;
}>;

/** Modeled open interest and dealer gamma exposure per strike ($ per 1% move). */
export const gexProfile = (
  values: ParamValues,
  elapsedDays: number,
  spotOverride?: number
): GexRow[] => {
  const market = marketOf(values);
  const spot = spotOverride ?? market.spot;
  const dte = Math.max(num(values, "dte", 30) - elapsedDays, 0.25);
  const callWall = num(values, "callWall", market.spot * 1.05);
  const putWall = num(values, "putWall", market.spot * 0.95);
  const oi = num(values, "oiScale", 10_000);
  const step = market.spot >= 200 ? 5 : market.spot >= 50 ? 1 : 0.5;
  const first = Math.ceil((market.spot * 0.85) / step) * step;
  const rows: GexRow[] = [];
  for (let strike = first; strike <= market.spot * 1.15; strike += step) {
    const callOi =
      oi *
      (0.25 + Math.exp(-(((strike - callWall) / (market.spot * 0.02)) ** 2)));
    const putOi =
      oi *
      (0.25 + Math.exp(-(((strike - putWall) / (market.spot * 0.02)) ** 2)));
    const gamma = blackScholes({
      kind: "call",
      rate: market.rate,
      spot,
      strike,
      vol: market.vol,
      years: dte / DAYS_PER_YEAR,
    }).gamma;
    const scale = gamma * 100 * spot * spot * 0.01;
    const callGex = callOi * scale;
    const putGex = -putOi * scale;
    rows.push({
      callGex,
      callOi,
      net: callGex + putGex,
      putGex,
      putOi,
      strike,
    });
  }
  return rows;
};

/** Spot level where the total modeled gamma exposure changes sign; null when it never does. */
export const gammaFlip = (
  values: ParamValues,
  elapsedDays: number
): number | null => {
  const market = marketOf(values);
  let previous: { spot: number; total: number } | null = null;
  for (
    let spot = market.spot * 0.85;
    spot <= market.spot * 1.15;
    spot += market.spot * 0.0025
  ) {
    const total = gexProfile(values, elapsedDays, spot).reduce(
      (sum, row) => sum + row.net,
      0
    );
    if (previous !== null && Math.sign(previous.total) !== Math.sign(total))
      return (
        previous.spot +
        ((spot - previous.spot) * Math.abs(previous.total)) /
          (Math.abs(previous.total) + Math.abs(total))
      );
    previous = { spot, total };
  }
  return null;
};

const gexScene = (
  scene: Extract<Scene, { type: "gex" }>,
  ctx: Ctx
): SceneData => {
  const market = marketOf(ctx.values);
  const dte = Math.max(num(ctx.values, "dte", 30), 1);
  const elapsed = Math.min(dte * ctx.t, dte - 0.25);
  const rows = gexProfile(ctx.values, elapsed);
  const width =
    rows.length > 1
      ? Math.abs(nth(rows, 1).strike - nth(rows, 0).strike) * 0.8
      : 1;
  const flip = gammaFlip(ctx.values, elapsed);
  const values = rows.map((row) => row.net / 1e6);
  const panel: Panel = {
    bars: rows.map((row) => ({
      element: "bars",
      width,
      x: row.strike,
      y: row.net / 1e6,
    })),
    elements: ["axes", "bars", "spot", "flip", "callWall", "putWall"],
    id: "gex",
    markers: [
      {
        element: "spot",
        kind: "vline",
        label: `Spot ${market.spot.toFixed(2)}`,
        x: market.spot,
      },
      ...(flip === null
        ? []
        : [
            {
              element: "flip",
              kind: "vline" as const,
              label: `Gamma flip ${flip.toFixed(2)}`,
              x: flip,
            },
          ]),
      {
        element: "callWall",
        kind: "vline",
        label: `Call wall ${num(ctx.values, "callWall", 0).toFixed(0)}`,
        x: num(ctx.values, "callWall", market.spot * 1.05),
      },
      {
        element: "putWall",
        kind: "vline",
        label: `Put wall ${num(ctx.values, "putWall", 0).toFixed(0)}`,
        x: num(ctx.values, "putWall", market.spot * 0.95),
      },
    ],
    series: [],
    title: `Dealer gamma exposure by strike (${Math.round(dte - elapsed)} DTE)`,
    xDomain: [market.spot * 0.85, market.spot * 1.15],
    xFormat: "price",
    xLabel: "Strike",
    yDomain: withZero(span(values)),
    yFormat: "num",
    yLabel: "GEX ($M per 1% move)",
  };
  if (scene.view === "2d")
    return {
      horizon: dte,
      layout: "stack",
      now: elapsed,
      panels: [panel],
      timeLabel: "Days elapsed",
      timeUnit: "days",
    };
  const ys = grid(0, dte - 0.5, 12);
  const xs = rows.map((row) => row.strike);
  return {
    horizon: dte,
    layout: "grid",
    now: elapsed,
    panels: [
      panel,
      {
        ...panel,
        bars: [],
        elements: ["surface"],
        id: "gex-surface",
        markers: [],
        surface: {
          element: "surface",
          sliceY: elapsed,
          xLabel: "Strike",
          xs,
          yLabel: "Days elapsed",
          ys,
          z: ys.map((day) =>
            gexProfile(ctx.values, day).map((row) => row.net / 1e6)
          ),
          zLabel: "GEX $M",
        },
        title: "GEX over strike and time",
      },
    ],
    timeLabel: "Days elapsed",
    timeUnit: "days",
  };
};

export type SizingPaths = Readonly<{
  paths: number[][];
  median: number[];
  drawdown: number[];
  kelly: number;
}>;

/** Monte Carlo equity paths for fixed-fractional sizing. */
export const sizingPaths = (values: ParamValues): SizingPaths => {
  const capital = Math.max(num(values, "capital", 100_000), 1);
  const risk = Math.min(Math.max(num(values, "riskPct", 2), 0), 100) / 100;
  const win = Math.min(Math.max(num(values, "winRate", 50), 0), 100) / 100;
  const payoff = Math.max(num(values, "payoffRatio", 2), 0.01);
  const trades = Math.round(
    Math.min(Math.max(num(values, "trades", 100), 5), 500)
  );
  const random = mulberry32(Math.round(num(values, "seed", 11)));
  const paths: number[][] = [];
  for (let path = 0; path < 24; path += 1) {
    const equity = [capital];
    for (let trade = 1; trade <= trades; trade += 1) {
      const last = nth(equity, -1);
      equity.push(
        Math.max(last * (1 + (random() < win ? risk * payoff : -risk)), 0)
      );
    }
    paths.push(equity);
  }
  const median = Array.from({ length: trades + 1 }, (_, index) => {
    const column = paths.map((path) => nth(path, index)).sort((a, b) => a - b);
    return nth(column, Math.floor(column.length / 2));
  });
  let peak = capital;
  const drawdown = median.map((value) => {
    peak = Math.max(peak, value);
    return (value / peak - 1) * 100;
  });
  return { drawdown, kelly: win - (1 - win) / payoff, median, paths };
};

const portfolioScene = (
  scene: Extract<Scene, { type: "portfolio" }>,
  ctx: Ctx
): SceneData => {
  if (scene.mode === "recovery") {
    const loss = Math.min(Math.max(num(ctx.values, "lossPct", 50), 0), 95);
    // Domains grow with the chosen loss so a 95% loss (+1900% to recover) stays on the chart.
    const xMax = Math.max(90, loss);
    const yMax = Math.max(900, (1 / (1 - loss / 100) - 1) * 100) * 1.05;
    const xs = grid(0, xMax, 91);
    const curve = xs.map((x) => [x, (1 / (1 - x / 100) - 1) * 100] as const);
    const current = loss * clamp01(ctx.t);
    const need = (1 / (1 - current / 100) - 1) * 100;
    return {
      horizon: loss,
      layout: "stack",
      now: current,
      panels: [
        {
          bars: [],
          elements: ["axes", "curve", "marker"],
          id: "recovery",
          markers: [
            {
              element: "marker",
              kind: "dot",
              label: `Lose ${current.toFixed(0)}% -> need +${need.toFixed(0)}%`,
              x: current,
              y: need,
            },
          ],
          series: [
            {
              element: "curve",
              label: "Required gain = 1/(1-L) - 1",
              points: curve,
              width: 3,
            },
          ],
          title: "Gain needed to recover from a loss",
          xDomain: [0, xMax],
          xFormat: "pct",
          xLabel: "Loss (%)",
          yDomain: [0, yMax],
          yFormat: "pct",
          yLabel: "Gain needed (%)",
        },
      ],
      timeLabel: "Loss",
      timeUnit: "pct",
    };
  }
  if (scene.mode === "allocation") {
    const core = num(ctx.values, "corePct", 70) / 100;
    const options = num(ctx.values, "optionsPct", 10) / 100;
    const leverage = Math.max(num(ctx.values, "leverage", 5), 1);
    const cash = Math.max(1 - core - options, 0);
    const xs = grid(-50, 50, 101);
    const optionLine = (marketPct: number) =>
      options *
      Math.max(
        -1,
        leverage * (marketPct / 100) -
          1 +
          Math.max(0, 1 - Math.abs(Math.min(marketPct, 0)) / 100)
      );
    const coreLine = xs.map((x) => [x, core * x] as const);
    const optLine = xs.map((x) => [x, optionLine(x) * 100] as const);
    const total = xs.map(
      (x, index) =>
        [x, nth(coreLine, index)[1] + nth(optLine, index)[1]] as const
    );
    const move = -50 + 100 * clamp01(ctx.t);
    return {
      horizon: 100,
      layout: "stack",
      now: move,
      panels: [
        {
          bars: [],
          elements: ["axes", "core", "options", "cash", "maxLoss", "marker"],
          id: "allocation",
          markers: [
            {
              element: "maxLoss",
              kind: "hline",
              label: `Options max loss ${(options * 100).toFixed(1)}% of portfolio`,
              y: -options * 100,
            },
            {
              element: "marker",
              kind: "vline",
              label: `Move ${move.toFixed(0)}%`,
              x: move,
            },
          ],
          series: [
            {
              element: "core",
              label: "Core holdings",
              points: coreLine,
              width: 2,
            },
            {
              element: "options",
              label: "Options sleeve (max loss = premium)",
              points: optLine,
              width: 2,
            },
            {
              element: "cash",
              label: "Total portfolio",
              points: total,
              signFill: true,
              width: 3,
            },
          ],
          title: `Portfolio P&L by market move (core ${(core * 100).toFixed(0)}%, options ${(options * 100).toFixed(0)}%, cash ${(cash * 100).toFixed(0)}%)`,
          xDomain: [-50, 50],
          xFormat: "pct",
          xLabel: "Market move (%)",
          yDomain: withZero(
            span([...coreLine, ...optLine, ...total].map((point) => point[1]))
          ),
          yFormat: "pct",
          yLabel: "Portfolio P&L (%)",
        },
      ],
      timeLabel: "Market move",
      timeUnit: "pct",
    };
  }
  const result = sizingPaths(ctx.values);
  const trades = result.median.length - 1;
  const now = Math.max(Math.round(trades * clamp01(ctx.t)), 1);
  const capital = nth(result.median, 0);
  const all = result.paths.flat();
  return {
    horizon: trades,
    layout: "stack",
    now,
    panels: [
      {
        bars: [],
        elements: ["axes", "paths", "median"],
        id: "equity",
        markers: [],
        series: [
          ...result.paths.map((path, index) => ({
            element: "paths",
            label: index === 0 ? "Simulated paths" : "",
            points: path.map((value, trade) => [trade, value] as const),
            revealTo: now,
            width: 1,
          })),
          {
            element: "median",
            label: "Median path",
            points: result.median.map(
              (value, trade) => [trade, value] as const
            ),
            revealTo: now,
            width: 3,
          },
        ],
        title: "Equity paths with fixed-fraction sizing",
        xDomain: [0, trades],
        xFormat: "count",
        xLabel: "Trade",
        yDomain: [0, Math.min(Math.max(...all), capital * 20) * 1.05],
        yFormat: "usd",
        yLabel: "Equity ($)",
      },
      {
        bars: [],
        elements: ["drawdown"],
        id: "drawdown",
        markers: [],
        series: [
          {
            element: "drawdown",
            fill: true,
            label: "Drawdown",
            points: result.drawdown.map(
              (value, trade) => [trade, value] as const
            ),
            revealTo: now,
            width: 2,
          },
        ],
        title: "Median-path drawdown",
        xDomain: [0, trades],
        xFormat: "count",
        xLabel: "Trade",
        yDomain: [Math.min(...result.drawdown, -1) * 1.1, 0],
        yFormat: "pct",
        yLabel: "Drawdown (%)",
      },
    ],
    timeLabel: "Trade",
    timeUnit: "trades",
  };
};

/** Seeded daily price path for a price-path lesson (GBM). */
export const pricePathOf = (
  values: ParamValues,
  days: number,
  waypoints: readonly Readonly<{ day: number; movePct: number }>[] = []
): number[] => {
  const market = marketOf(values);
  const vol = Math.max(num(values, "realizedVol", market.vol * 100), 1) / 100;
  // Same convention as the risk table: real-world drift = risk-free rate + the excess-drift input.
  const drift = market.rate + num(values, "drift", 0) / 100;
  const random = mulberry32(Math.round(num(values, "seed", 3)));
  if (waypoints.length === 0) {
    const path = [market.spot];
    for (let day = 1; day <= days; day += 1) {
      const last = nth(path, -1);
      path.push(
        last *
          Math.exp(
            (drift - 0.5 * vol * vol) / DAYS_PER_YEAR +
              (vol / Math.sqrt(DAYS_PER_YEAR)) * gaussian(random)
          )
      );
    }
    return path;
  }
  // Story path: log-linear between waypoints plus a Brownian bridge so every waypoint is hit exactly.
  const anchors = [
    { day: 0, movePct: 0 },
    ...[...waypoints]
      .sort((a, b) => a.day - b.day)
      .filter((point) => point.day > 0 && point.day <= days),
  ];
  const last = nth(anchors, -1);
  if (last.day < days) anchors.push({ day: days, movePct: last.movePct });
  const path: number[] = [market.spot];
  const step = vol / Math.sqrt(DAYS_PER_YEAR);
  for (let index = 1; index < anchors.length; index += 1) {
    const from = nth(anchors, index - 1);
    const to = nth(anchors, index);
    const segmentDays = Math.max(to.day - from.day, 1);
    const a = Math.log(1 + from.movePct / 100);
    const b = Math.log(1 + to.movePct / 100);
    const noise: number[] = [0];
    for (let day = 1; day <= segmentDays; day += 1)
      noise.push(nth(noise, -1) + step * gaussian(random));
    const end = nth(noise, -1);
    for (let day = 1; day <= segmentDays; day += 1) {
      const fraction = day / segmentDays;
      const bridge = nth(noise, day) - fraction * end;
      path.push(market.spot * Math.exp(a + (b - a) * fraction + bridge));
    }
  }
  return path.slice(0, days + 1);
};

const pricepathScene = (
  scene: Extract<Scene, { type: "pricepath" }>,
  ctx: Ctx
): SceneData => {
  const market = marketOf(ctx.values);
  const legs = resolveLegs(scene.legs, ctx.values);
  const horizon = Math.round(effectiveHorizon(legs, ctx.values));
  const path = pricePathOf(ctx.values, horizon, scene.waypoints);
  const now = Math.max(Math.round(horizon * clamp01(ctx.t)), 1);
  const pnl = path.map(
    (price, day) =>
      [day, positionAt(legs, price, day, market.rate).pnl] as const
  );
  const pricePoints = path.map((price, day) => [day, price] as const);
  const strikes = [
    ...new Set(
      legs.filter((leg) => leg.kind !== "stock").map((leg) => leg.strike)
    ),
  ];
  return {
    horizon,
    layout: "stack",
    now,
    panels: [
      {
        bars: [],
        elements: ["axes", "price", "strikes", "events", "spot"],
        id: "price",
        markers: [
          {
            element: "spot",
            kind: "hline",
            label: `Entry ${market.spot.toFixed(2)}`,
            y: market.spot,
          },
          ...strikes.map((strike) => ({
            element: "strikes",
            kind: "hline" as const,
            label: `K ${strike.toFixed(2)}`,
            y: strike,
          })),
          ...scene.events
            .filter((event) => event.day <= horizon)
            .map((event) => ({
              element: "events",
              kind: "vline" as const,
              label: event.label,
              x: event.day,
            })),
        ],
        series: [
          {
            element: "price",
            label: "Price",
            points: pricePoints,
            revealTo: now,
            width: 2.25,
          },
        ],
        title: "Underlying price path",
        xDomain: [0, horizon],
        xFormat: "day",
        xLabel: "Day",
        yDomain: span([...pricePoints.map((point) => point[1]), ...strikes]),
        yFormat: "price",
        yLabel: "Price",
      },
      {
        bars: [],
        elements: ["pnl"],
        id: "pnl",
        markers: scene.events
          .filter((event) => event.day <= horizon)
          .map((event) => ({
            element: "events",
            kind: "vline" as const,
            label: "",
            x: event.day,
          })),
        series: [
          {
            element: "pnl",
            label: "Position P&L",
            points: pnl,
            revealTo: now,
            signFill: true,
            width: 2.5,
          },
        ],
        title: "Position P&L over time",
        xDomain: [0, horizon],
        xFormat: "day",
        xLabel: "Day",
        yDomain: withZero(span(pnl.map((point) => point[1]))),
        yFormat: "usd",
        yLabel: "P&L ($)",
      },
    ],
    timeLabel: "Day",
    timeUnit: "days",
  };
};

/** Build the scene for a lesson at param values and a time fraction t in [0, 1]. */
export const buildScene = (
  lesson: Pick<LessonSpec, "scene">,
  values: ParamValues,
  t: number,
  azimuth = 0.6
): SceneData => {
  const ctx: Ctx = { azimuth, t: clamp01(t), values };
  const scene = lesson.scene;
  switch (scene.type) {
    case "payoff": {
      const legs = resolveLegs(scene.legs, values);
      const { panels, horizon } = payoffPanels(legs, ctx, scene.view);
      return {
        horizon,
        layout: scene.view === "3d" ? "grid" : "stack",
        now: horizon * ctx.t,
        panels,
        timeLabel: "Days elapsed",
        timeUnit: "days",
      };
    }
    case "compare":
      return compareScene(scene, ctx);
    case "greeks":
      return greeksScene(resolveLegs(scene.legs, values), ctx);
    case "distribution":
      return distributionScene(resolveLegs(scene.legs, values), ctx);
    case "ivrv":
      return ivrvScene(ctx);
    case "gex":
      return gexScene(scene, ctx);
    case "portfolio":
      return portfolioScene(scene, ctx);
    case "pricepath":
      return pricepathScene(scene, ctx);
    case "quant":
      return quantScene(scene.mode, ctx);
  }
};
