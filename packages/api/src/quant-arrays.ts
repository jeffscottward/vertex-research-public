// Small numeric helpers shared by the backtest statistics modules.

// Milliseconds since the epoch; a bare YYYY-MM-DD date is read as UTC midnight.
export const timeMs = (value: string): number =>
  Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value);

// Bounds-checked indexed read for arrays whose length is already known.
export const at = <T>(values: readonly T[], index: number): T => {
  const value = values[index];
  if (value === undefined)
    throw new RangeError("Statistics index out of range");
  return value;
};

export const mean = (values: readonly number[]): number => {
  let total = 0;
  for (const value of values) total += value;
  return values.length === 0 ? 0 : total / values.length;
};

// Sample standard deviation (n - 1); 0 for fewer than two values.
export const stdev = (values: readonly number[]): number => {
  if (values.length < 2) return 0;
  const average = mean(values);
  let squares = 0;
  for (const value of values) squares += (value - average) ** 2;
  return Math.sqrt(squares / (values.length - 1));
};

// True when the standard deviation is more than rounding noise relative to the mean.
// A constant series such as 0.1, 0.1, 0.1 has a computed deviation near 1e-17, not 0.
export const hasSpread = (average: number, deviation: number): boolean =>
  deviation > 1e-12 * Math.abs(average);

// Linear-interpolated quantile of a sorted array (type 7, as in NumPy's default).
export const quantile = (ordered: readonly number[], q: number): number => {
  const position = (ordered.length - 1) * q;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return (
    at(ordered, lower) +
    (at(ordered, upper) - at(ordered, lower)) * (position - lower)
  );
};

export const sorted = (values: readonly number[]): number[] =>
  [...values].sort((left, right) => left - right);
