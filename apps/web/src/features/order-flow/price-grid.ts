// What: price and time grids shared by the footprint, delta and TPO views: a tick size derived
// from the prices, grouping a price to a step, an automatic step that caps the level count, and
// time buckets sized so a tick window gets roughly 6 to 20 of them.
// Used by: footprint.ts, delta.ts, tpo.ts, components/portal/order-flow-panel.tsx.

const MAX_DECIMALS = 8;
/** Share of prices whose decimals must fit the tick (sub-penny prints are rare outliers). */
const DECIMAL_COVERAGE = 0.95;

/** Fewest decimals (0-8) that write `value` exactly, up to float noise. */
export const decimalsOf = (value: number): number => {
  for (let digits = 0; digits < MAX_DECIMALS; digits += 1) {
    const scaled = value * 10 ** digits;
    if (Math.abs(scaled - Math.round(scaled)) < 1e-6) return digits;
  }
  return MAX_DECIMALS;
};

const gcd = (a: number, b: number): number => {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y > 0) [x, y] = [y, x % y];
  return x;
};

/** Rounds away float noise at `digits` decimals (0.1 + 0.2 -> 0.3). */
export const roundPrice = (value: number, digits: number): number =>
  Number(value.toFixed(Math.min(Math.max(digits, 0), MAX_DECIMALS)));

/**
 * The price increment the prints trade in: the greatest common divisor of their differences
 * at the decimals 95% of prices use, so a stray sub-penny print does not shrink the grid.
 * ES at 4500.25 / 4500.50 -> 0.25; stock prints in cents -> 0.01. Null without finite prices.
 */
export const deriveTickSize = (prices: readonly number[]): number | null => {
  const finite = prices.filter((price) => Number.isFinite(price));
  if (finite.length === 0) return null;
  const decimals = finite.map(decimalsOf).sort((a, b) => a - b);
  const digits =
    decimals[Math.max(0, Math.ceil(decimals.length * DECIMAL_COVERAGE) - 1)] ??
    0;
  const scale = 10 ** digits;
  const units = [...new Set(finite.map((price) => Math.round(price * scale)))];
  units.sort((a, b) => a - b);
  let divisor = 0;
  for (let index = 1; index < units.length; index += 1)
    divisor = gcd(divisor, (units[index] ?? 0) - (units[index - 1] ?? 0));
  // One distinct price: the smallest step at its decimals.
  return roundPrice((divisor === 0 ? 1 : divisor) / scale, digits);
};

/** The level a price belongs to: the step multiple at or below it. */
export const groupPrice = (price: number, step: number): number => {
  const digits = Math.max(decimalsOf(step), 0);
  return roundPrice(Math.floor(price / step + 1e-9) * step, digits);
};

/** Step multipliers offered over the derived tick. */
export const PRICE_STEP_MULTIPLES = [
  1, 2, 5, 10, 25, 50, 100, 250, 500, 1000,
] as const;

/** Levels between low and high (inclusive) at a step. */
export const levelCount = (low: number, high: number, step: number): number =>
  Math.round((groupPrice(high, step) - groupPrice(low, step)) / step) + 1;

/** Smallest tick multiple whose grid over [low, high] has at most `maxLevels` rows. */
export const autoPriceStep = (
  tick: number,
  low: number,
  high: number,
  maxLevels: number
): number => {
  const digits = decimalsOf(tick);
  for (const multiple of PRICE_STEP_MULTIPLES) {
    const step = roundPrice(tick * multiple, digits);
    if (levelCount(low, high, step) <= maxLevels) return step;
  }
  return roundPrice(tick * (PRICE_STEP_MULTIPLES.at(-1) ?? 1), digits);
};

/** Bucket sizes (seconds) a footprint or delta view can use. */
const BUCKET_SECONDS = [
  1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600,
] as const;
const AUTO_MAX_BUCKETS = 20;
/** Largest bucket count offered at all (more columns are unreadable). */
export const MAX_BUCKETS = 120;

/** Start (unix seconds, aligned to the epoch) of the bucket holding t. */
export const bucketStart = (t: number, seconds: number): number =>
  Math.floor(t / seconds) * seconds;

export const bucketCount = (
  first: number,
  last: number,
  seconds: number
): number =>
  (bucketStart(last, seconds) - bucketStart(first, seconds)) / seconds + 1;

/** Smallest bucket size that splits [first, last] into at most 20 buckets (about 6-20). */
export const autoBucketSeconds = (first: number, last: number): number =>
  BUCKET_SECONDS.find(
    (seconds) => bucketCount(first, last, seconds) <= AUTO_MAX_BUCKETS
  ) ?? (BUCKET_SECONDS.at(-1) as number);

/** Bucket sizes giving 2 to 120 buckets over the window (always includes the auto choice). */
export const bucketOptions = (first: number, last: number): number[] => {
  const auto = autoBucketSeconds(first, last);
  return BUCKET_SECONDS.filter((seconds) => {
    const count = bucketCount(first, last, seconds);
    return seconds === auto || (count >= 2 && count <= MAX_BUCKETS);
  });
};

/** "30 s", "5 min", "1 h". */
export const formatBucketSeconds = (seconds: number): string => {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${seconds / 60} min`;
  return `${seconds / 3600} h`;
};
