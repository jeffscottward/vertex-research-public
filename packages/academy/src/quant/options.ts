// What: Scene and table builders of the options quant modes (option pricing models and hedging). Seeded, computed data only.
// smile: implied volatility by bisection and the smile of a Merton jump-diffusion market.
// binomial: Cox-Ross-Rubinstein tree and its convergence to Black-Scholes.
// hedge: delta hedging a short call on seeded GBM paths (P&L spread, rebalancing, realized vs implied vol).
import {
  blackScholes,
  DAYS_PER_YEAR,
  gaussian,
  mulberry32,
  normCdf,
} from "../math.ts";
import { num, type ParamValues } from "../position.ts";
import {
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
  withZero,
} from "../scene-kit.ts";
import type { OptionsMode } from "./options-ids.ts";

const clamp = (value: number, low: number, high: number): number =>
  Math.min(Math.max(value, low), high);
const usd = (value: number): string =>
  `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(2)}`;
const pct = (value: number, digits = 1): string =>
  `${(value * 100).toFixed(digits)}%`;

/** Black-Scholes call price for one share. */
export const callPrice = (
  spot: number,
  strike: number,
  years: number,
  rate: number,
  vol: number
): number =>
  blackScholes({ kind: "call", rate, spot, strike, vol, years }).price;

/** Black-Scholes call delta N(d1) (years > 0). */
const callDelta = (
  spot: number,
  strike: number,
  years: number,
  rate: number,
  vol: number
): number =>
  normCdf(
    (Math.log(spot / strike) + (rate + 0.5 * vol * vol) * years) /
      (vol * Math.sqrt(years))
  );

const yearsOf = (values: ParamValues): number =>
  clamp(num(values, "dte", 365), 1, 1095) / DAYS_PER_YEAR;

// ---------------------------------------------------------------- smile

export type Guess = Readonly<{
  low: number;
  high: number;
  vol: number;
  price: number;
}>;

export type Bisection = Readonly<{
  /** Implied volatility (fraction); NaN when the price is outside the no-arbitrage bounds. */
  iv: number;
  guesses: readonly Guess[];
  /** Which no-arbitrage bound the price breaks, or null when an implied volatility exists. */
  outside: "below" | "above" | null;
}>;

export type CallBounds = Readonly<{ lower: number; upper: number }>;

/**
 * No-arbitrage bounds of a European call: at least max(S - Ke^(-rT), 0) (what a forward plus
 * the option to walk away is worth), and less than the stock itself. Only prices in between have
 * an implied volatility: the Black-Scholes price runs from the lower bound (σ → 0) towards S (σ → ∞).
 */
export const callBounds = (
  spot: number,
  strike: number,
  years: number,
  rate: number
): CallBounds => ({
  lower: Math.max(spot - strike * Math.exp(-rate * years), 0),
  upper: spot,
});

const BOUND_TOLERANCE = 1e-9;

/** Which no-arbitrage bound a call price breaks, or null when it is inside them. */
const outsideCallBounds = (
  price: number,
  bounds: CallBounds
): "below" | "above" | null => {
  if (price < bounds.lower - BOUND_TOLERANCE) return "below";
  if (price >= bounds.upper) return "above";
  return null;
};

/** Bisection steps the smile chart shows (the guesses element). */
export const SHOWN_GUESSES = 10;
const BISECTION_STEPS = 60;

/** Bisection on [0%, 100%] (widened by doubling up to 800%), no bounds check. */
const bisect = (
  price: number,
  spot: number,
  strike: number,
  years: number,
  rate: number
): Bisection => {
  let high = 1;
  while (high < 8 && callPrice(spot, strike, years, rate, high) < price)
    high *= 2;
  let low = 0;
  const guesses: Guess[] = [];
  for (let step = 1; step <= BISECTION_STEPS; step += 1) {
    const vol = (low + high) / 2;
    const value = callPrice(spot, strike, years, rate, vol);
    if (step <= SHOWN_GUESSES) guesses.push({ high, low, price: value, vol });
    if (value < price) low = vol;
    else high = vol;
  }
  return { guesses, iv: (low + high) / 2, outside: null };
};

/**
 * Implied volatility of a call price by bisection. The search starts on [0%, 100%] (widened by
 * doubling up to 800% when the price needs more), tries the middle and keeps the half that still
 * brackets the price, because the call price always rises with volatility. A price outside the
 * no-arbitrage bounds (below max(S - Ke^(-rT), 0) or at/above S) has no implied volatility: the
 * result is NaN with no guesses, and `outside` names the broken bound.
 */
export const impliedVol = (
  price: number,
  spot: number,
  strike: number,
  years: number,
  rate: number
): Bisection => {
  const outside = outsideCallBounds(
    price,
    callBounds(spot, strike, years, rate)
  );
  if (outside !== null) return { guesses: [], iv: Number.NaN, outside };
  return bisect(price, spot, strike, years, rate);
};

export type SmileInputs = Readonly<{
  spot: number;
  strike: number;
  years: number;
  rate: number;
  /** Diffusion volatility of the stock (marketVol). */
  vol: number;
  /** Expected jumps per year. */
  lambda: number;
  /**
   * Median jump as a simple return (-0.25 = a 25% crash): the jump factor 1 + J is lognormal with
   * log mean ln(1 + jumpMedian), so this is its median, not its mean (the mean is e^(δ²/2) larger).
   */
  jumpMedian: number;
  /** Standard deviation of the log jump size. */
  jumpVol: number;
  /** Quoted call price at the strike, or null to price the call in the jump model. */
  marketPrice: number | null;
}>;

export const smileInputs = (values: ParamValues): SmileInputs => {
  const quoted = num(values, "marketPrice", Number.NaN);
  return {
    jumpMedian: clamp(num(values, "jumpMedian", -25), -90, 100) / 100,
    jumpVol: clamp(num(values, "jumpVol", 10), 0, 100) / 100,
    lambda: clamp(num(values, "jumpIntensity", 0.1), 0, 2),
    marketPrice: quoted > 0 ? quoted : null,
    rate: num(values, "rate", 4) / 100,
    spot: Math.max(num(values, "spot", 100), 0.01),
    strike: Math.max(num(values, "strike", 100), 0.01),
    vol: clamp(num(values, "marketVol", 20), 1, 200) / 100,
    years: yearsOf(values),
  };
};

/**
 * Merton (1976) jump-diffusion call: a Poisson-weighted sum of Black-Scholes prices. With n jumps
 * the variance is σ² + n δ²/T and the rate r - λk + n ln(1 + k)/T, where k = E[jump] = e^(μJ + δ²/2) - 1
 * and the weights use the intensity λ(1 + k)T.
 */
export const mertonCall = (input: SmileInputs, strike: number): number => {
  const { jumpMedian, jumpVol, lambda, rate, spot, vol, years } = input;
  const muJ = Math.log(1 + jumpMedian);
  const k = Math.exp(muJ + 0.5 * jumpVol * jumpVol) - 1;
  const intensity = lambda * (1 + k) * years;
  const terms = Math.ceil(intensity + 12 * Math.sqrt(intensity) + 12);
  let weight = Math.exp(-intensity);
  let total = 0;
  for (let n = 0; n < terms; n += 1) {
    weight *= n === 0 ? 1 : intensity / n;
    const volN = Math.sqrt(vol * vol + (n * jumpVol * jumpVol) / years);
    const rateN =
      rate - lambda * k + (n * muJ + 0.5 * n * jumpVol * jumpVol) / years;
    total += weight * callPrice(spot, strike, years, rateN, volN);
  }
  return total;
};

export type SmileModel = Readonly<{
  input: SmileInputs;
  /** Price the panel-1 bisection solves for (the quote, or the jump-model price). */
  market: number;
  solved: Bisection;
  /** No-arbitrage bounds of a call at the chosen strike. */
  bounds: CallBounds;
  /** Shift that anchors the jump-model smile at the solved implied volatility (0 when none). */
  anchor: number;
  strikes: readonly number[];
  /** Implied volatility (fraction, floored at 0) per strike: jump-model smile, anchored. */
  smile: readonly number[];
}>;

export const smileModel = (values: ParamValues): SmileModel => {
  const input = smileInputs(values);
  const { rate, spot, strike, years } = input;
  // Jump-model prices are arbitrage-free by construction; bisect them without the bounds check
  // so rounding at deep strikes cannot turn a valid price into a missing volatility.
  const ivOf = (price: number, at: number): number =>
    bisect(price, spot, at, years, rate).iv;
  const model = mertonCall(input, strike);
  const market = input.marketPrice ?? model;
  const bounds = callBounds(spot, strike, years, rate);
  const solved = impliedVol(market, spot, strike, years, rate);
  const anchor = solved.outside === null ? solved.iv - ivOf(model, strike) : 0;
  const strikes = grid(0.6 * spot, 1.4 * spot, 33);
  // A downward shift can push the far wing below zero: volatility cannot be negative.
  const smile = strikes.map((at) =>
    Math.max(ivOf(mertonCall(input, at), at) + anchor, 0)
  );
  return { anchor, bounds, input, market, smile, solved, strikes };
};

const boundsText = (bounds: CallBounds): string =>
  `${usd(bounds.lower)} to below ${usd(bounds.upper)}`;

const smileScene = (ctx: SceneCtx): SceneData => {
  const model = smileModel(ctx.values);
  const { rate, spot, strike, years } = model.input;
  const invalid = model.solved.outside !== null;
  const shown = Math.max(1, Math.ceil(clamp01(ctx.t) * SHOWN_GUESSES));
  const xMax = invalid ? 100 : nth(model.solved.guesses, 0).high * 100;
  const curve: Point[] = grid(0.5, xMax, 80).map((vol) => [
    vol,
    callPrice(spot, strike, years, rate, vol / 100),
  ]);
  const guesses: Marker[] = model.solved.guesses
    .slice(0, shown)
    .map((guess, index) => ({
      element: "guesses",
      kind: "dot",
      // Late guesses crowd around the answer: number the first five and the newest one.
      label: index < 5 || index === shown - 1 ? String(index + 1) : "",
      x: guess.vol * 100,
      y: guess.price,
    }));
  const flat: Point[] = invalid
    ? []
    : model.strikes.map((at) => [at, model.solved.iv * 100]);
  const smile: Point[] = model.strikes.map((at, index) => [
    at,
    nth(model.smile, index) * 100,
  ]);
  return {
    horizon: SHOWN_GUESSES,
    layout: "stack",
    now: shown,
    panels: [
      {
        bars: [],
        elements: ["axes", "curve", "market", "guesses"],
        id: "bisection",
        markers: [
          {
            element: "market",
            kind: "hline",
            label: invalid
              ? `Market price ${usd(model.market)} (outside no-arbitrage bounds)`
              : `Market price ${usd(model.market)}`,
            y: model.market,
          },
          ...(invalid
            ? [
                {
                  element: "curve",
                  kind: "hline" as const,
                  label: `Lower bound ${usd(model.bounds.lower)}`,
                  y: model.bounds.lower,
                },
                {
                  element: "curve",
                  kind: "hline" as const,
                  label: `Upper bound ${usd(model.bounds.upper)} (the stock)`,
                  y: model.bounds.upper,
                },
              ]
            : []),
          ...guesses,
        ],
        series: [
          {
            element: "curve",
            label: "Black-Scholes call price",
            points: curve,
            width: 3,
          },
        ],
        title: invalid
          ? `${usd(model.market)} is outside no-arbitrage bounds (${boundsText(model.bounds)}): no implied volatility`
          : `Implied volatility ${pct(model.solved.iv)} by bisection`,
        xDomain: [0, xMax],
        xFormat: "pct",
        xLabel: "Volatility (%)",
        yDomain: withZero(
          span([
            ...curve.map((point) => point[1]),
            model.market,
            ...(invalid ? [model.bounds.lower, model.bounds.upper] : []),
          ])
        ),
        yFormat: "usd",
        yLabel: "Call price ($)",
      },
      {
        bars: [],
        elements: ["flat", "smile"],
        id: "smile",
        markers: [],
        series: [
          {
            dashed: true,
            element: "flat",
            label: "Black-Scholes: one volatility",
            points: flat,
            width: 2,
          },
          {
            element: "smile",
            label: invalid
              ? "Implied by a market with crashes (unshifted)"
              : "Implied by a market with crashes",
            points: smile,
            width: 3,
          },
        ],
        title: "Implied volatility across strikes",
        xDomain: [nth(model.strikes, 0), nth(model.strikes, -1)],
        xFormat: "price",
        xLabel: "Strike",
        yDomain: span([
          ...smile.map((point) => point[1]),
          ...(invalid ? [] : [model.solved.iv * 100]),
        ]),
        yFormat: "pct",
        yLabel: "Implied volatility (%)",
      },
    ],
    timeLabel: "Bisection step",
    timeUnit: "trades",
  };
};

const smileTables = (values: ParamValues): DataTable[] => {
  const model = smileModel(values);
  const { input } = model;
  const pick = [0, 4, 8, 12, 16, 20, 24, 28, 32];
  const invalid = model.solved.outside !== null;
  return [
    {
      columns: ["Step", "Range", "Guess", "Black-Scholes price", "Next"],
      id: "bisection",
      note: invalid
        ? `Market price ${usd(model.market)} is outside no-arbitrage bounds (${boundsText(model.bounds)}): ${model.solved.outside === "below" ? "below what the stock minus the discounted strike is worth" : "at or above the stock itself"}, so no volatility reproduces it and the implied volatility is undefined.`
        : `Market price ${usd(model.market)}: implied volatility ${pct(model.solved.iv, 2)} after ${BISECTION_STEPS} halvings.`,
      rows: model.solved.guesses.map((guess, index) => [
        String(index + 1),
        `${pct(guess.low)} - ${pct(guess.high)}`,
        pct(guess.vol, 2),
        usd(guess.price),
        guess.price < model.market ? "too low: go up" : "too high: go down",
      ]),
      title: "Bisection steps",
    },
    {
      columns: [
        "Strike",
        "Jump-model call",
        "Implied vol",
        "Flat (Black-Scholes)",
      ],
      id: "smile",
      note: invalid
        ? "Calls priced in the jump model, each turned back into an implied volatility; not shifted, because the quoted price has no implied volatility."
        : model.anchor === 0
          ? "Calls priced in the jump model, each turned back into an implied volatility."
          : `Smile shape of the jump model, shifted by ${pct(model.anchor, 2)} to pass through the quoted price's implied volatility.${model.smile.some((iv) => iv === 0) ? " Strikes the shift would push below zero are floored at 0%." : ""}`,
      rows: pick.map((index) => {
        const at = nth(model.strikes, index);
        return [
          at.toFixed(2),
          usd(mertonCall(input, at)),
          pct(nth(model.smile, index), 2),
          invalid ? "none" : pct(model.solved.iv, 2),
        ];
      }),
      title: "Implied volatility by strike",
    },
  ];
};

// ---------------------------------------------------------------- binomial

/** Tree levels the chart draws (later levels exist but are not drawn). */
export const DRAWN_LEVELS = 8;
const MAX_STEPS = 250;

export type Crr = Readonly<{
  dt: number;
  up: number;
  down: number;
  /** Risk-neutral probability of an up move (outside 0..1 when the tree is not arbitrage-free). */
  prob: number;
  /** d < e^(rΔt) < u, i.e. σ > |r|√Δt: without it p leaves 0..1 and the tree allows arbitrage. */
  arbitrageFree: boolean;
  price: number;
  /** Call value at each node of levels 0..min(steps, keep): levels[i][j], j = up moves. */
  levels: readonly (readonly number[])[];
}>;

/**
 * Fewest steps whose Cox-Ross-Rubinstein tree is arbitrage-free: σ√Δt > |r|Δt needs
 * Δt < σ²/r², so more than r²T/σ² steps.
 */
export const minArbitrageFreeSteps = (
  years: number,
  rate: number,
  vol: number
): number => {
  // floor(r²T/σ²) is never above the answer (valid needs steps > r²T/σ²); step up to the exact
  // test crr uses, which also settles floating point at the edge.
  let steps = Math.max(Math.floor((rate * rate * years) / (vol * vol)), 1);
  while (!treeArbitrageFree(years, rate, vol, steps)) steps += 1;
  return steps;
};

/** d < e^(rΔt) < u for a CRR tree of `steps` steps (u = e^(σ√Δt), d = 1/u). */
const treeArbitrageFree = (
  years: number,
  rate: number,
  vol: number,
  steps: number
): boolean => {
  const dt = years / steps;
  const up = Math.exp(vol * Math.sqrt(dt));
  const growth = Math.exp(rate * dt);
  return 1 / up < growth && growth < up;
};

/**
 * Cox-Ross-Rubinstein European call by backward induction. p is not clamped: when σ ≤ |r|√Δt the
 * up move does not beat the risk-free growth (or the down move does), p leaves 0..1,
 * `arbitrageFree` is false and the price is only the formal replication value.
 */
export const crr = (
  spot: number,
  strike: number,
  years: number,
  rate: number,
  vol: number,
  steps: number,
  keep = DRAWN_LEVELS
): Crr => {
  const dt = years / steps;
  const up = Math.exp(vol * Math.sqrt(dt));
  const down = 1 / up;
  const growth = Math.exp(rate * dt);
  const prob = (growth - down) / (up - down);
  const arbitrageFree = treeArbitrageFree(years, rate, vol, steps);
  const values = Array.from({ length: steps + 1 }, (_, j) =>
    Math.max(spot * up ** j * down ** (steps - j) - strike, 0)
  );
  const levels: number[][] = [];
  if (steps <= keep) levels[steps] = [...values];
  for (let level = steps - 1; level >= 0; level -= 1) {
    for (let j = 0; j <= level; j += 1)
      values[j] =
        (prob * nth(values, j + 1) + (1 - prob) * nth(values, j)) / growth;
    if (level <= keep) levels[level] = values.slice(0, level + 1);
  }
  return { arbitrageFree, down, dt, levels, price: nth(values, 0), prob, up };
};

type BinomialInputs = Readonly<{
  spot: number;
  strike: number;
  years: number;
  rate: number;
  vol: number;
  steps: number;
}>;

const binomialInputs = (values: ParamValues): BinomialInputs => ({
  rate: num(values, "rate", 4) / 100,
  spot: Math.max(num(values, "spot", 100), 0.01),
  steps: Math.round(clamp(num(values, "steps", 3), 1, MAX_STEPS)),
  strike: Math.max(num(values, "strike", 100), 0.01),
  vol: clamp(num(values, "iv", 20), 1, 200) / 100,
  years: yearsOf(values),
});

export type BinomialModel = Readonly<{
  input: BinomialInputs;
  tree: Crr;
  bs: number;
  /** Tree price for 1..maxSteps steps. */
  convergence: readonly Point[];
  /** Fewest steps with an arbitrage-free tree (earlier convergence points are invalid trees). */
  minSteps: number;
}>;

export const binomialModel = (values: ParamValues): BinomialModel => {
  const input = binomialInputs(values);
  const { rate, spot, steps, strike, vol, years } = input;
  const maxSteps = Math.max(steps, 50);
  return {
    bs: callPrice(spot, strike, years, rate, vol),
    convergence: Array.from({ length: maxSteps }, (_, index) => [
      index + 1,
      crr(spot, strike, years, rate, vol, index + 1, -1).price,
    ]),
    input,
    minSteps: minArbitrageFreeSteps(years, rate, vol),
    tree: crr(spot, strike, years, rate, vol, steps),
  };
};

/** Why a tree is invalid: σ does not exceed |r|√Δt, so p leaves 0..1. */
const arbitrageText = (model: BinomialModel): string => {
  const { rate, vol } = model.input;
  return `σ ${pct(vol)} ≤ |r|√Δt ${pct(Math.abs(rate) * Math.sqrt(model.tree.dt), 2)}, so p = ${pct(model.tree.prob)} is not a probability; use at least ${model.minSteps} steps or more volatility`;
};

const binomialScene = (ctx: SceneCtx): SceneData => {
  const model = binomialModel(ctx.values);
  const { spot, steps } = model.input;
  const { down, dt, levels, up } = model.tree;
  const drawn = Math.min(steps, DRAWN_LEVELS);
  const day = (level: number): number => level * dt * DAYS_PER_YEAR;
  const node = (level: number, ups: number): number =>
    spot * up ** ups * down ** (level - ups);
  const edges: Series[] = [];
  const nodes: Marker[] = [];
  const prices: number[] = [];
  for (let level = 0; level <= drawn; level += 1) {
    for (let ups = 0; ups <= level; ups += 1) {
      const price = node(level, ups);
      prices.push(price);
      nodes.push({
        element: "tree",
        kind: "dot",
        label: usd(nth(nth(levels, level), ups)),
        x: day(level),
        y: price,
      });
      if (level < drawn)
        for (const next of [ups, ups + 1])
          edges.push({
            element: "tree",
            label: "",
            points: [
              [day(level), price],
              [day(level + 1), node(level + 1, next)],
            ],
            width: 1.5,
          });
    }
  }
  const convergence = model.convergence;
  const treeTitle = model.tree.arbitrageFree
    ? steps <= DRAWN_LEVELS
      ? `${steps}-step tree: call worth ${usd(model.tree.price)}`
      : `First ${DRAWN_LEVELS} of ${steps} steps: call worth ${usd(model.tree.price)}`
    : `Invalid ${steps}-step tree: ${arbitrageText(model)}`;
  return {
    horizon: steps,
    layout: "stack",
    now: steps,
    panels: [
      {
        bars: [],
        elements: ["axes", "tree"],
        id: "tree",
        markers: nodes,
        series: edges,
        title: treeTitle,
        xDomain: [-day(drawn) * 0.04, day(drawn) * 1.12],
        xFormat: "day",
        xLabel: "Days from today (labels: call value at the node)",
        yDomain: span(prices, 0.12),
        yFormat: "price",
        yLabel: "Stock price",
      },
      {
        bars: [],
        elements: ["price", "bs"],
        id: "convergence",
        markers: [
          {
            element: "bs",
            kind: "hline",
            label: `Black-Scholes ${usd(model.bs)}`,
            y: model.bs,
          },
          {
            element: "price",
            kind: "dot",
            label: `${steps} steps: ${usd(model.tree.price)}`,
            x: steps,
            y: model.tree.price,
          },
        ],
        series: [
          {
            element: "price",
            label: "Tree price",
            points: convergence,
            width: 2,
          },
        ],
        title:
          model.minSteps > 1
            ? `Tree price vs number of steps (under ${model.minSteps} steps the tree allows arbitrage)`
            : "Tree price vs number of steps",
        xDomain: [0, convergence.length + 1],
        xFormat: "count",
        xLabel: "Steps in the tree",
        yDomain: span([...convergence.map((point) => point[1]), model.bs]),
        yFormat: "usd",
        yLabel: "Call price ($)",
      },
    ],
    timeLabel: "Tree steps",
    timeUnit: "trades",
  };
};

const binomialTables = (values: ParamValues): DataTable[] => {
  const model = binomialModel(values);
  const { tree } = model;
  const { steps } = model.input;
  const counts = [
    ...new Set([1, 2, 3, 5, 10, 25, 50, steps].sort((a, b) => a - b)),
  ];
  return [
    {
      columns: ["Quantity", "Value"],
      id: "tree",
      rows: [
        ["Steps", String(steps)],
        ["Step length (years)", tree.dt.toFixed(4)],
        ["Up factor u = e^(σ√Δt)", tree.up.toFixed(4)],
        ["Down factor d = 1/u", tree.down.toFixed(4)],
        ["Risk-neutral p = (e^(rΔt) - d)/(u - d)", pct(tree.prob, 2)],
        ["Tree price", usd(tree.price)],
        ["Black-Scholes price", usd(model.bs)],
      ],
      ...(tree.arbitrageFree
        ? {}
        : {
            note: `Warning: this tree is not arbitrage-free. ${arbitrageText(model)}. The tree price is a formal replication value, not a fair price.`,
          }),
      title: "Cox-Ross-Rubinstein tree",
    },
    {
      columns: ["Steps", "Tree price", "Minus Black-Scholes"],
      id: "convergence",
      rows: counts.map((count) => {
        const price = nth(model.convergence, count - 1)[1];
        return [String(count), usd(price), usd(price - model.bs)];
      }),
      ...(model.minSteps > 1
        ? {
            note: `Trees with fewer than ${model.minSteps} steps break no-arbitrage (σ ≤ |r|√Δt); their prices are not fair values.`,
          }
        : {}),
      title: "Convergence to Black-Scholes",
    },
  ];
};

// ---------------------------------------------------------------- hedge

/** Rebalance counts of the std curve (each divides 252, the fine grid of that simulation). */
const STD_COUNTS = [1, 2, 4, 7, 14, 28, 63, 126, 252] as const;
const FINE = 252;
const MAX_REBALANCES = 252;
/** Black-Scholes evaluations each simulation may spend (about 60k in total). */
export const HEDGE_BUDGET = { main: 30_000, std: 30_000 } as const;
const BINS = 40;

export type HedgeInputs = Readonly<{
  spot: number;
  strike: number;
  years: number;
  rate: number;
  iv: number;
  realized: number;
  rebalances: number;
  paths: number;
  seed: number;
  /** Premium above the fair price the call is sold at (half the bid-ask spread). */
  spread: number;
}>;

export const hedgeInputs = (values: ParamValues): HedgeInputs => ({
  iv: clamp(num(values, "iv", 20), 1, 200) / 100,
  paths: Math.round(clamp(num(values, "paths", 500), 20, 5000)),
  rate: num(values, "rate", 4) / 100,
  realized: clamp(num(values, "realizedVol", 20), 1, 200) / 100,
  rebalances: Math.round(
    clamp(num(values, "rebalances", 52), 1, MAX_REBALANCES)
  ),
  seed: Math.round(num(values, "seed", 33)),
  spot: Math.max(num(values, "spot", 100), 0.01),
  spread: Math.max(num(values, "spread", 0), 0),
  strike: Math.max(num(values, "strike", 100), 0.01),
  years: yearsOf(values),
});

/** Brownian motion values W at fine + 1 grid points over the option's life (W0 = 0). */
const brownian = (
  random: () => number,
  fine: number,
  years: number
): number[] => {
  const step = Math.sqrt(years / fine);
  const path = [0];
  for (let index = 1; index <= fine; index += 1)
    path.push(nth(path, -1) + step * gaussian(random));
  return path;
};

type Outcome = Readonly<{ hedged: number; unhedged: number }>;

/**
 * Short one call sold at the Black-Scholes price (implied vol) plus the spread, delta hedged at
 * implied vol at `count` evenly spaced times along a GBM path (drift = rate, realized volatility)
 * sampled from the Brownian values `path` on `fine` steps. Cash earns the risk-free rate.
 */
const hedgeOutcome = (
  input: HedgeInputs,
  path: readonly number[],
  fine: number,
  count: number
): Outcome => {
  const { iv, rate, realized, spot, spread, strike, years } = input;
  const timeOf = (k: number): number =>
    (Math.round((k * fine) / count) / fine) * years;
  const stockAt = (k: number): number =>
    spot *
    Math.exp(
      (rate - 0.5 * realized * realized) * timeOf(k) +
        realized * nth(path, Math.round((k * fine) / count))
    );
  const premium = callPrice(spot, strike, years, rate, iv) + spread;
  let delta = callDelta(spot, strike, years, rate, iv);
  let cash = premium - delta * spot;
  for (let k = 1; k < count; k += 1) {
    cash *= Math.exp(rate * (timeOf(k) - timeOf(k - 1)));
    const stock = stockAt(k);
    const next = callDelta(stock, strike, years - timeOf(k), rate, iv);
    cash -= (next - delta) * stock;
    delta = next;
  }
  cash *= Math.exp(rate * (years - timeOf(count - 1)));
  const final = stockAt(count);
  const payoff = Math.max(final - strike, 0);
  return {
    hedged: cash + delta * final - payoff,
    unhedged: premium * Math.exp(rate * years) - payoff,
  };
};

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;
const stdev = (values: readonly number[]): number => {
  const center = mean(values);
  return Math.sqrt(
    values.reduce((sum, value) => sum + (value - center) ** 2, 0) /
      Math.max(values.length - 1, 1)
  );
};

/**
 * Expected P&L of the short call at expiry, hedged or not and for any rebalancing schedule: the
 * stock drifts at the risk-free rate, so the hedge's trading gains average zero and what is left is
 * the premium received minus the option's value at the realized volatility, both grown at the rate.
 */
export const expectedHedgePnl = (
  input: HedgeInputs,
  realized: number
): number => {
  const { iv, rate, spot, spread, strike, years } = input;
  return (
    (callPrice(spot, strike, years, rate, iv) +
      spread -
      callPrice(spot, strike, years, rate, realized)) *
    Math.exp(rate * years)
  );
};

export type HedgeModel = Readonly<{
  input: HedgeInputs;
  /** Paths actually simulated for the distribution (paths, capped by the evaluation budget). */
  mainPaths: number;
  hedged: readonly number[];
  unhedged: readonly number[];
  stdPaths: number;
  std: readonly Point[];
  /** Expected hedged P&L by realized/implied volatility ratio (x in percent). */
  ratio: readonly Point[];
  /** Expected hedged P&L at the chosen realized volatility. */
  ratioNow: number;
  /** Black-Scholes evaluations spent (prices and deltas). */
  evaluations: number;
}>;

export const hedgeModel = (values: ParamValues): HedgeModel => {
  const input = hedgeInputs(values);
  const { iv, realized, rebalances, seed, years } = input;
  let evaluations = 0;
  const run = (path: readonly number[], fine: number, count: number) => {
    evaluations += count + 1;
    return hedgeOutcome(input, path, fine, count);
  };

  const mainPaths = Math.min(
    input.paths,
    Math.floor(HEDGE_BUDGET.main / (rebalances + 1))
  );
  const mainRandom = mulberry32(seed);
  const outcomes = Array.from({ length: mainPaths }, () =>
    run(brownian(mainRandom, rebalances, years), rebalances, rebalances)
  );

  // The same 252-step paths for every count keep the curve smooth.
  const counts = [...new Set([...STD_COUNTS, rebalances])].sort(
    (a, b) => a - b
  );
  const perPath = counts.reduce((sum, count) => sum + count + 1, 0);
  const stdPaths = Math.floor(HEDGE_BUDGET.std / perPath);
  const stdRandom = mulberry32(seed + 1);
  const finePaths = Array.from({ length: stdPaths }, () =>
    brownian(stdRandom, FINE, years)
  );
  const std: Point[] = counts.map((count) => [
    count,
    stdev(finePaths.map((path) => run(path, FINE, count).hedged)),
  ]);

  const now = realized / iv;
  const ratio: Point[] = grid(Math.min(0.5, now), Math.max(1.5, now), 41).map(
    (value) => [value * 100, expectedHedgePnl(input, value * iv)]
  );
  evaluations += 2 * (ratio.length + 1);

  return {
    evaluations,
    hedged: outcomes.map((outcome) => outcome.hedged),
    input,
    mainPaths,
    ratio,
    ratioNow: expectedHedgePnl(input, realized),
    std,
    stdPaths,
    unhedged: outcomes.map((outcome) => outcome.unhedged),
  };
};

/** Step outline of a histogram: share of values (%) in each of BINS equal bins over [low, high]. */
export const histogram = (
  values: readonly number[],
  low: number,
  high: number
): Point[] => {
  const width = Math.max(high - low, 1e-9) / BINS;
  const counts = Array.from({ length: BINS }, () => 0);
  for (const value of values) {
    const bin = clamp(Math.floor((value - low) / width), 0, BINS - 1);
    counts[bin] = nth(counts, bin) + 1;
  }
  return counts.flatMap((count, bin): Point[] => {
    const share = (count / values.length) * 100;
    return [
      [low + bin * width, share],
      [low + (bin + 1) * width, share],
    ];
  });
};

const hedgeScene = (ctx: SceneCtx): SceneData => {
  const model = hedgeModel(ctx.values);
  const { iv, realized, rebalances } = model.input;
  const all = [...model.hedged, ...model.unhedged];
  const low = Math.min(...all);
  const high = Math.max(...all);
  const unhedged = histogram(model.unhedged, low, high);
  const hedged = histogram(model.hedged, low, high);
  const stdNow = nth(
    model.std.filter((point) => point[0] === rebalances),
    0
  )[1];
  return {
    horizon: rebalances,
    layout: "stack",
    now: rebalances,
    panels: [
      {
        bars: [],
        elements: ["axes", "unhedged", "hedged"],
        id: "distribution",
        markers: [],
        series: [
          {
            element: "unhedged",
            fill: true,
            label: `Unhedged (sd ${usd(stdev(model.unhedged))})`,
            points: unhedged,
            width: 2,
          },
          {
            element: "hedged",
            fill: true,
            label: `Delta hedged (sd ${usd(stdev(model.hedged))})`,
            points: hedged,
            width: 2,
          },
        ],
        title: `Short call P&L at expiry over ${model.mainPaths} paths`,
        xDomain: [low - (high - low) * 0.02, high + (high - low) * 0.02],
        xFormat: "price",
        xLabel: "P&L per share at expiry ($)",
        yDomain: [0, Math.max(...hedged.map((point) => point[1]), 1) * 1.08],
        yFormat: "pct",
        yLabel: "Share of paths (%)",
      },
      {
        bars: [],
        elements: ["std", "marker"],
        id: "rebalancing",
        markers: [
          {
            element: "marker",
            kind: "dot",
            label: `${rebalances} rebalances: sd ${usd(stdNow)}`,
            x: rebalances,
            y: stdNow,
          },
        ],
        series: [
          {
            element: "std",
            label: "Hedged P&L standard deviation",
            points: model.std,
            width: 3,
          },
        ],
        title: "Hedging more often shrinks the spread",
        xDomain: [0, MAX_REBALANCES * 1.15],
        xFormat: "count",
        xLabel: "Rebalances over the option's life",
        yDomain: withZero(span(model.std.map((point) => point[1]))),
        yFormat: "usd",
        yLabel: "P&L standard deviation ($)",
      },
      {
        bars: [],
        elements: ["ratio", "marker"],
        id: "ratio",
        markers: [
          {
            element: "ratio",
            kind: "hline",
            label: "Break-even",
            y: 0,
          },
          {
            element: "marker",
            kind: "dot",
            label: `Realized ${pct(realized, 0)} vs implied ${pct(iv, 0)}: ${usd(model.ratioNow)} at expiry`,
            x: (realized / iv) * 100,
            y: model.ratioNow,
          },
        ],
        series: [
          {
            element: "ratio",
            label: "Expected hedged P&L",
            points: model.ratio,
            width: 3,
          },
        ],
        title: "Market maker earns when realized vol stays below implied",
        xDomain: [nth(model.ratio, 0)[0], nth(model.ratio, -1)[0]],
        xFormat: "pct",
        xLabel: "Realized / implied volatility (%)",
        yDomain: span([
          ...model.ratio.map((point) => point[1]),
          model.ratioNow,
          0,
        ]),
        yFormat: "usd",
        yLabel: "Mean P&L per share at expiry ($)",
      },
    ],
    timeLabel: "Rebalances",
    timeUnit: "trades",
  };
};

const hedgeTables = (values: ParamValues): DataTable[] => {
  const model = hedgeModel(values);
  const { iv, rate, realized, rebalances, spot, spread, strike, years } =
    model.input;
  const share = (list: readonly number[]): string =>
    pct(list.filter((value) => value > 0).length / list.length);
  const summary = (label: string, list: readonly number[]): string[] => [
    label,
    usd(mean(list)),
    usd(stdev(list)),
    usd(Math.min(...list)),
    share(list),
  ];
  return [
    {
      columns: [
        "Position",
        "Mean P&L",
        "Std dev",
        "Worst path",
        "Paths in profit",
      ],
      id: "hedge",
      note: `Call sold at ${usd(callPrice(spot, strike, years, rate, iv) + spread)} (Black-Scholes at ${pct(iv, 0)} implied${spread > 0 ? ` plus ${usd(spread)} spread` : ""}); stock simulated at ${pct(realized, 0)} realized volatility; ${rebalances} rebalances; ${model.mainPaths} paths. ${model.evaluations} Black-Scholes evaluations.`,
      rows: [
        summary("Unhedged short call", model.unhedged),
        summary("Delta-hedged short call", model.hedged),
      ],
      title: "P&L per share at expiry",
    },
    {
      columns: ["Rebalances", "Hedged std dev"],
      id: "rebalancing",
      note: `${model.stdPaths} paths on a 252-step grid, the same paths for every count.`,
      rows: model.std.map((point) => [String(point[0]), usd(point[1])]),
      title: "Spread vs rebalancing",
    },
    {
      columns: ["Realized / implied", "Realized vol", "Expected hedged P&L"],
      id: "ratio",
      note: `P&L at expiry: e^(rT) x (call at implied${spread > 0 ? " + spread" : ""} - call at realized volatility); the simulated paths above average ${usd(mean(model.hedged))} against ${usd(model.ratioNow)} expected (${usd(model.ratioNow * Math.exp(-rate * years))} in today's dollars).`,
      rows: model.ratio
        .filter((_, index) => index % 5 === 0)
        .map((point) => [
          `${point[0].toFixed(0)}%`,
          pct((point[0] / 100) * iv),
          usd(point[1]),
        ]),
      title: "Expected P&L vs realized volatility",
    },
  ];
};

// ---------------------------------------------------------------- dispatch

const SCENES: Readonly<Record<OptionsMode, (ctx: SceneCtx) => SceneData>> = {
  binomial: binomialScene,
  hedge: hedgeScene,
  smile: smileScene,
};

const TABLES: Readonly<
  Record<OptionsMode, (values: ParamValues) => DataTable[]>
> = {
  binomial: binomialTables,
  hedge: hedgeTables,
  smile: smileTables,
};

/** Scene of one options mode at param values and time fraction ctx.t. */
export const optionsScene = (mode: OptionsMode, ctx: SceneCtx): SceneData =>
  SCENES[mode](ctx);

/** Mode-specific data tables (the inputs and constants tables are added by tables.ts). */
export const optionsTables = (
  mode: OptionsMode,
  values: ParamValues,
  _t: number
): DataTable[] => TABLES[mode](values);
