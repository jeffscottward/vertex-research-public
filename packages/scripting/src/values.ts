// Runtime values. `null` is Pine's na. Colors are a distinct tagged value so they never mix
// with strings; tuples are plain arrays (function returns, ta.macd/ta.bb, options lists).

export type ColorValue = Readonly<{ color: string }>;
export type Scalar = number | boolean | string | ColorValue | null;
export type Value = Scalar | readonly Scalar[];

export const isColor = (value: unknown): value is ColorValue =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  "color" in value;

export const color = (hex: string): ColorValue => ({
  color: hex.toLowerCase(),
});

// Pine v5 palette constants.
export const PALETTE: Readonly<Record<string, string>> = {
  aqua: "#00bcd4",
  black: "#363a45",
  blue: "#2962ff",
  fuchsia: "#e040fb",
  gray: "#787b86",
  green: "#4caf50",
  lime: "#00e676",
  maroon: "#880e4f",
  navy: "#311b92",
  olive: "#808000",
  orange: "#ff9800",
  purple: "#9c27b0",
  red: "#ff5252",
  silver: "#b2b5be",
  teal: "#00897b",
  white: "#ffffff",
  yellow: "#ffeb3b",
};

export const typeOf = (value: Value | undefined): string => {
  if (value === undefined) return "nothing";
  if (value === null) return "na";
  if (Array.isArray(value)) return "tuple";
  if (isColor(value)) return "color";
  return typeof value;
};

// Finite numbers only; NaN/Infinity (e.g. x / 0) become na like Pine.
export const num = (value: number): number | null =>
  Number.isFinite(value) ? value : null;

export const scalarEquals = (a: Scalar, b: Scalar): boolean => {
  if (isColor(a) && isColor(b)) return a.color === b.color;
  return a === b;
};
