// Black-Scholes-Merton prices and Greeks for European options with a continuous dividend
// yield. Pure math, no I/O. Used by optionsChain.* (server) and the web lab fake.
// Units: delta and gamma per $1 of the underlying; theta per calendar day (365); vega per
// 1 volatility point (0.01); rho per 1 rate point (0.01). Display values, not trading inputs.

export type OptionRight = "call" | "put";

export type BlackScholesInput = Readonly<{
  right: OptionRight;
  spot: number;
  strike: number;
  // Years to expiry (ACT/365).
  years: number;
  // Annual decimals: 0.25 = 25 % volatility, 0.04 = 4 % rate.
  volatility: number;
  rate: number;
  dividendYield: number;
}>;

export type BlackScholesResult = Readonly<{
  price: number;
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
}>;

const SQRT_2PI = Math.sqrt(2 * Math.PI);
const DAYS_PER_YEAR = 365;

/** Standard normal density. */
export const normalPdf = (x: number): number =>
  Math.exp(-0.5 * x * x) / SQRT_2PI;

// Abramowitz and Stegun 7.1.26 erf, absolute error below 1.5e-7.
const erf = (x: number): number => {
  const sign = x < 0 ? -1 : 1;
  const a = Math.abs(x);
  const t = 1 / (1 + 0.327_591_1 * a);
  const poly =
    t *
    (0.254_829_592 +
      t *
        (-0.284_496_736 +
          t * (1.421_413_741 + t * (-1.453_152_027 + t * 1.061_405_429))));
  return sign * (1 - poly * Math.exp(-a * a));
};

/** Standard normal cumulative distribution. */
export const normalCdf = (x: number): number => 0.5 * (1 + erf(x / Math.SQRT2));

const positive = (value: number): boolean =>
  Number.isFinite(value) && value > 0;

/** Null when an input is outside the model's domain (non-positive or non-finite). */
export const blackScholes = (
  input: BlackScholesInput
): BlackScholesResult | null => {
  const { right, spot, strike, years, volatility, rate, dividendYield } = input;
  if (
    !(
      [spot, strike, years, volatility].every(positive) &&
      Number.isFinite(rate) &&
      Number.isFinite(dividendYield) &&
      dividendYield >= 0
    )
  )
    return null;
  const sqrtT = Math.sqrt(years);
  const volT = volatility * sqrtT;
  const d1 =
    (Math.log(spot / strike) +
      (rate - dividendYield + 0.5 * volatility * volatility) * years) /
    volT;
  const d2 = d1 - volT;
  const carry = Math.exp(-dividendYield * years);
  const discount = Math.exp(-rate * years);
  const density = normalPdf(d1);
  const gamma = (carry * density) / (spot * volT);
  const vega = (spot * carry * density * sqrtT) / 100;
  const decay = -(spot * carry * density * volatility) / (2 * sqrtT);
  if (right === "call") {
    const nd1 = normalCdf(d1);
    const nd2 = normalCdf(d2);
    return {
      price: spot * carry * nd1 - strike * discount * nd2,
      delta: carry * nd1,
      gamma,
      theta:
        (decay -
          rate * strike * discount * nd2 +
          dividendYield * spot * carry * nd1) /
        DAYS_PER_YEAR,
      vega,
      rho: (strike * years * discount * nd2) / 100,
    };
  }
  const nNegD1 = normalCdf(-d1);
  const nNegD2 = normalCdf(-d2);
  return {
    price: strike * discount * nNegD2 - spot * carry * nNegD1,
    delta: -carry * nNegD1,
    gamma,
    theta:
      (decay +
        rate * strike * discount * nNegD2 -
        dividendYield * spot * carry * nNegD1) /
      DAYS_PER_YEAR,
    vega,
    rho: -(strike * years * discount * nNegD2) / 100,
  };
};

const MS_PER_YEAR = DAYS_PER_YEAR * 86_400_000;

// Day of month of the nth Sunday in a UTC month (month is 0-based).
const nthSunday = (year: number, month: number, nth: number): number =>
  1 +
  ((7 - new Date(Date.UTC(year, month, 1)).getUTCDay()) % 7) +
  7 * (nth - 1);

// US daylight saving time (since 2007): second Sunday in March to first Sunday in November.
const usDaylightTime = (expiry: string): boolean => {
  const year = Number(expiry.slice(0, 4));
  const month = Number(expiry.slice(5, 7));
  const day = Number(expiry.slice(8, 10));
  if (month === 3) return day >= nthSunday(year, 2, 2);
  if (month === 11) return day < nthSunday(year, 10, 1);
  return month > 3 && month < 11;
};

/** 16:00 New York on an ISO expiry date (YYYY-MM-DD), as epoch milliseconds. */
export const expiryCloseMs = (expiry: string): number => {
  // 16:00 New York is 20:00 UTC in daylight time and 21:00 UTC in standard time.
  const closeUtc = usDaylightTime(expiry) ? "20:00" : "21:00";
  return Date.parse(`${expiry}T${closeUtc}:00Z`);
};

/** Years (ACT/365) from `now` to the expiry close; zero or less once it has passed. */
export const yearsToExpiry = (expiry: string, now: Date): number =>
  (expiryCloseMs(expiry) - now.getTime()) / MS_PER_YEAR;

/** Whole calendar days from `today` (YYYY-MM-DD) to the expiry date, never negative. */
export const daysToExpiry = (expiry: string, today: string): number =>
  Math.max(
    0,
    Math.round(
      (Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
        86_400_000
    )
  );
