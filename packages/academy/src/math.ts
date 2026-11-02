// What: Options math for the Academy: normal distribution, Black-Scholes price and Greeks,
// lognormal price distribution, expected move and a seeded random generator.
// Used by: scenes.ts, tables.ts, backtest.ts, gates.ts. All functions are pure.

export const DAYS_PER_YEAR = 365;
export const CONTRACT_MULTIPLIER = 100;

/** Standard normal density. */
export const normPdf = (x: number): number =>
  Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

/** Standard normal cumulative distribution (Hart 1968 / West 2005, double precision). */
export const normCdf = (x: number): number => {
  const z = Math.abs(x);
  let c: number;
  if (z > 37) c = 0;
  else {
    const e = Math.exp(-0.5 * z * z);
    if (z < 7.071_067_811_865_47) {
      let n = 3.526_249_659_989_11e-2 * z + 0.700_383_064_443_688;
      n = n * z + 6.373_962_203_531_65;
      n = n * z + 33.912_866_078_383;
      n = n * z + 112.079_291_497_871;
      n = n * z + 221.213_596_169_931;
      n = n * z + 220.206_867_912_376;
      let d = 8.838_834_764_831_84e-2 * z + 1.755_667_163_182_64;
      d = d * z + 16.064_177_579_207;
      d = d * z + 86.780_732_202_946_1;
      d = d * z + 296.564_248_779_674;
      d = d * z + 637.333_633_378_831;
      d = d * z + 793.826_512_519_948;
      d = d * z + 440.413_735_824_752;
      c = (e * n) / d;
    } else {
      let f = z + 0.65;
      f = z + 4 / f;
      f = z + 3 / f;
      f = z + 2 / f;
      f = z + 1 / f;
      c = e / f / 2.506_628_274_631;
    }
  }
  return x <= 0 ? c : 1 - c;
};

export type OptionKind = "call" | "put";

export type BlackScholesInput = Readonly<{
  kind: OptionKind;
  spot: number;
  strike: number;
  /** Time to expiry in years; 0 or less means expiry (intrinsic value). */
  years: number;
  rate: number;
  vol: number;
}>;

/**
 * Price and Greeks for one option on one share.
 * theta is per calendar day, vega per 1 volatility point (0.01), rho per 1 rate point.
 */
export type OptionValue = Readonly<{
  price: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
}>;

const intrinsic = (kind: OptionKind, spot: number, strike: number): number =>
  kind === "call" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);

export const blackScholes = (input: BlackScholesInput): OptionValue => {
  const { kind, spot, strike, years, rate } = input;
  const vol = Math.max(input.vol, 1e-6);
  if (years <= 0 || spot <= 0) {
    const itm = kind === "call" ? spot > strike : spot < strike;
    return {
      price: intrinsic(kind, spot, strike),
      delta: itm ? (kind === "call" ? 1 : -1) : 0,
      gamma: 0,
      theta: 0,
      vega: 0,
      rho: 0,
    };
  }
  const sqrtT = Math.sqrt(years);
  const d1 =
    (Math.log(spot / strike) + (rate + 0.5 * vol * vol) * years) /
    (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;
  const discount = Math.exp(-rate * years);
  const pdf = normPdf(d1);
  const gamma = pdf / (spot * vol * sqrtT);
  const vega = (spot * pdf * sqrtT) / 100;
  const decay = -(spot * pdf * vol) / (2 * sqrtT);
  if (kind === "call") {
    return {
      price: spot * normCdf(d1) - strike * discount * normCdf(d2),
      delta: normCdf(d1),
      gamma,
      theta: (decay - rate * strike * discount * normCdf(d2)) / DAYS_PER_YEAR,
      vega,
      rho: (strike * years * discount * normCdf(d2)) / 100,
    };
  }
  return {
    price: strike * discount * normCdf(-d2) - spot * normCdf(-d1),
    delta: normCdf(d1) - 1,
    gamma,
    theta: (decay + rate * strike * discount * normCdf(-d2)) / DAYS_PER_YEAR,
    vega,
    rho: (-strike * years * discount * normCdf(-d2)) / 100,
  };
};

/** Strike whose Black-Scholes delta equals target (call: 0..1, put: -1..0). Bisection. */
export const strikeForDelta = (
  kind: OptionKind,
  target: number,
  spot: number,
  years: number,
  rate: number,
  vol: number
): number => {
  let low = spot * 0.2;
  let high = spot * 5;
  for (let index = 0; index < 80; index += 1) {
    const mid = (low + high) / 2;
    const delta = blackScholes({
      kind,
      spot,
      strike: mid,
      years,
      rate,
      vol,
    }).delta;
    // Delta falls as the strike rises, for calls and puts.
    if (delta > target) low = mid;
    else high = mid;
  }
  return (low + high) / 2;
};

/** One-standard-deviation expected move in price units over the given calendar days. */
export const expectedMove = (spot: number, vol: number, days: number): number =>
  spot * vol * Math.sqrt(Math.max(days, 0) / DAYS_PER_YEAR);

/** Lognormal density of the price after `days`, with annual drift `mu` and volatility `vol`. */
export const lognormalPdf = (
  price: number,
  spot: number,
  vol: number,
  days: number,
  mu: number
): number => {
  const t = Math.max(days, 1e-6) / DAYS_PER_YEAR;
  if (price <= 0) return 0;
  const s = vol * Math.sqrt(t);
  const m = Math.log(spot) + (mu - 0.5 * vol * vol) * t;
  const z = (Math.log(price) - m) / s;
  return normPdf(z) / (price * s);
};

/** Probability that the price after `days` ends above `level`. */
export const probabilityAbove = (
  level: number,
  spot: number,
  vol: number,
  days: number,
  mu: number
): number => {
  const t = Math.max(days, 1e-6) / DAYS_PER_YEAR;
  const s = vol * Math.sqrt(t);
  const m = Math.log(spot) + (mu - 0.5 * vol * vol) * t;
  return 1 - normCdf((Math.log(Math.max(level, 1e-9)) - m) / s);
};

/** Small deterministic PRNG (mulberry32); returns values in [0, 1). */
// biome-ignore-start lint/suspicious/noBitwiseOperators: mulberry32 is defined by 32-bit integer bit operations.
export const mulberry32 = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/** Standard normal draw from a uniform generator (Box-Muller). */
export const gaussian = (random: () => number): number => {
  const u = Math.max(random(), 1e-12);
  const v = random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

/** Annualized close-to-close realized volatility over the trailing window ending at `end` (inclusive). */
export const realizedVol = (
  closes: ArrayLike<number>,
  end: number,
  window: number,
  periodsPerYear = 252
): number | null => {
  if (end - window < 0) return null;
  let sum = 0;
  let sumSq = 0;
  for (let index = end - window + 1; index <= end; index += 1) {
    const previous = closes[index - 1] ?? 0;
    const current = closes[index] ?? 0;
    if (previous <= 0 || current <= 0) return null;
    const r = Math.log(current / previous);
    sum += r;
    sumSq += r * r;
  }
  const mean = sum / window;
  const variance =
    Math.max(sumSq / window - mean * mean, 0) *
    (window / Math.max(window - 1, 1));
  return Math.sqrt(variance * periodsPerYear);
};

export const round = (value: number, digits = 2): number => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};
