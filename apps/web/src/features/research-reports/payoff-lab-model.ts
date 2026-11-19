// Pure rules of the dossier payoff lab (merge plan P1-6): the first set of lines, labels, the price
// axis, input parsing, number formats and the fixed texts. Every function is a pure function of the
// parsed lines and of one UTC date string; nothing here reads stored JSON or a clock except
// `utcDate`. The first-set, size and axis defaults are knowledge-base defaults that the owner chose
// on 2026-11-18; they are model reasoning, not a published method. Research only.
import type { AvailablePayoff, PayoffKind } from "./payoff.ts";
import type { LabLine, RowReason } from "./payoff-strategies.ts";

export const MAX_SELECTED_LINES = 5;

/** The order in which the first set takes one line per kind. */
export const KIND_ORDER: readonly PayoffKind[] = [
  "stock",
  "long-call",
  "bull-call-spread",
  "cash-secured-put",
  "put-credit-spread",
];

const KIND_LABEL: Readonly<Record<PayoffKind, string>> = {
  "bull-call-spread": "Bull call spread",
  "cash-secured-put": "Cash-secured put",
  "long-call": "Long call",
  "put-credit-spread": "Put credit spread",
  stock: "Stock, hypothetical",
};

/** The fixed mark of a line whose expiry date is before the UTC date of the lab. */
export const EXPIRED_MARK = "expired (UTC date)";

/** The UTC calendar date of `now` as `YYYY-MM-DD`. */
export const utcDate = (now: Date): string => now.toISOString().slice(0, 10);

/** A line is expired when its expiry date is before `today`; the expiry day itself is open. */
export const isExpired = (line: LabLine, today: string): boolean =>
  line.expiry !== null && line.expiry < today;

/**
 * The one expiry date of the first set: the earliest stored date on or after `today`, else the
 * latest stored date. `null` without an option line.
 */
export const firstSetDate = (
  lines: readonly LabLine[],
  today: string
): string | null => {
  const dates = [
    ...new Set(
      lines.flatMap((line) => (line.expiry === null ? [] : [line.expiry]))
    ),
  ].sort();
  return dates.find((date) => date >= today) ?? dates.at(-1) ?? null;
};

/** Keys of the first set: one line per kind in `KIND_ORDER`; the option lines share one expiry date. */
export const firstSet = (
  lines: readonly LabLine[],
  today: string
): readonly string[] => {
  const date = firstSetDate(lines, today);
  return KIND_ORDER.flatMap((kind) => {
    const line = lines.find(
      (entry) =>
        entry.kind === kind && (entry.expiry === null || entry.expiry === date)
    );
    return line === undefined ? [] : [line.key];
  });
};

export const formatPrice = (value: number): string =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);

/** A number without grouping and with at most 6 decimals: the text of a price or size field. */
export const formatPlain = (value: number): string =>
  String(Number(value.toFixed(6)));

const premiumText = (netPremium: number): string => {
  if (netPremium === 0) return "no premium";
  return netPremium > 0
    ? `debit ${formatPrice(netPremium)}`
    : `credit ${formatPrice(-netPremium)}`;
};

/** "Bull call spread 300/350 · debit 5 · 2027-01-15"; built from the closed line type only. */
export const lineLabel = (line: LabLine): string =>
  line.expiry === null
    ? `${KIND_LABEL.stock} · basis ${formatPrice(line.netPremium)}`
    : `${KIND_LABEL[line.kind]} ${line.strikes.map(formatPrice).join("/")} · ${premiumText(line.netPremium)} · ${line.expiry}`;

/** The group of a line in the add control: its expiry date and kind. */
export const groupLabel = (line: LabLine): string =>
  line.expiry === null ? "Stock" : `${line.expiry} · ${KIND_LABEL[line.kind]}`;

export type PriceAxis = Readonly<{
  min: number;
  max: number;
  /** The price at expiry that the lab starts with. */
  start: number;
  step: number;
  source: "stock-basis" | "strike-midpoint";
}>;

const AXIS_BAND = 0.5;
const AXIS_MARGIN = 0.1;
const AXIS_STEPS = 200;
const MIN_STEP = 0.01;

/** The smallest of 1, 2 or 5 times a power of ten that is at least `raw`. */
const niceStep = (raw: number): number => {
  const power = 10 ** Math.floor(Math.log10(raw));
  const ratio = raw / power;
  let factor = 10;
  if (ratio <= 1) factor = 1;
  else if (ratio <= 2) factor = 2;
  else if (ratio <= 5) factor = 5;
  return Number((factor * power).toPrecision(1));
};

/**
 * The price axis, from every drawable line, so that it does not move when the selection changes:
 * 50% below to 50% above the starting price, widened to hold every strike and breakeven with a
 * 10% margin, never below 0. The starting price is the basis of the first stock line, else the
 * midpoint of the lowest and highest strike of the first set.
 */
export const priceAxis = (
  lines: readonly LabLine[],
  first: readonly string[]
): PriceAxis => {
  const stock = lines.flatMap((line) =>
    line.kind === "stock" ? [line.netPremium] : []
  );
  const firstStrikes = lines
    .filter((line) => first.includes(line.key))
    .flatMap((line) => line.strikes);
  const basis = stock.at(0);
  const start =
    basis ??
    (firstStrikes.length === 0
      ? 0
      : (Math.min(...firstStrikes) + Math.max(...firstStrikes)) / 2);
  const marks = lines.flatMap((line) => [...line.strikes, ...line.breakevens]);
  const low = Math.max(
    0,
    Math.min(
      start * (1 - AXIS_BAND),
      ...marks.map((mark) => mark * (1 - AXIS_MARGIN))
    )
  );
  const high = Math.max(
    start * (1 + AXIS_BAND),
    ...marks.map((mark) => mark * (1 + AXIS_MARGIN))
  );
  const step = high > low ? niceStep((high - low) / AXIS_STEPS) : MIN_STEP;
  // Six decimals absorb binary rounding (105 * 1.1 is 115.50000000000001).
  const steps = (value: number): number => Number((value / step).toFixed(6));
  const min = Number((Math.floor(steps(low)) * step).toFixed(6));
  const max = Number((Math.ceil(steps(high)) * step).toFixed(6));
  return {
    max: max > min ? max : Number((min + step).toFixed(6)),
    min,
    source: basis === undefined ? "strike-midpoint" : "stock-basis",
    start,
    step,
  };
};

const NUMBER = /^\d+(\.\d+)?$/u;
const positive = (text: string): number | null => {
  const trimmed = text.trim();
  const value = NUMBER.test(trimmed) ? Number(trimmed) : Number.NaN;
  return Number.isFinite(value) ? value : null;
};

/** A size typed by the operator: whole contracts above 0, or a share count above 0; else `null`. */
export const parseUnits = (text: string, kind: PayoffKind): number | null => {
  const value = positive(text);
  if (value === null || value <= 0) return null;
  return kind === "stock" || Number.isInteger(value) ? value : null;
};

/** A price typed by the operator: a finite number of 0 or more; else `null`. */
export const parsePrice = (text: string): number | null => positive(text);

const AMOUNT = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});
/** "USD 1,500.00", or "1,500.00" when the dossier states no currency. */
export const formatAmount = (value: number, currency: string | null): string =>
  currency === null
    ? AMOUNT.format(value)
    : `${currency} ${AMOUNT.format(value)}`;

/** The breakevens of an available payoff as text: points, closed ranges and one open range. */
export const breakevenText = (payoff: AvailablePayoff): string => {
  const parts = [
    ...payoff.breakevens.map(formatPrice),
    ...payoff.breakevenRanges.map((range) =>
      range.to === null
        ? `${formatPrice(range.from)} and above`
        : `${formatPrice(range.from)} to ${formatPrice(range.to)}`
    ),
  ];
  return parts.length === 0 ? "none" : parts.join("; ");
};

export const REASON_TEXT: Readonly<Record<RowReason, string>> = {
  "asset-type": "the lab draws only equity and ETF dossiers",
  "asset-type-unread":
    "the catalog asset type could not be read; reload the page",
  expiry: "no valid expiry date stored",
  "leg-shape": "legs have an unsupported shape",
  "multiplier-invalid": "a stored contract multiplier is invalid",
  "multiplier-mismatch": "contract multipliers of the legs differ",
  "multiplier-missing": "no contract multiplier stored",
  "no-legs": "no legs stored",
  premium: "an entry premium is missing or invalid",
  range: "numbers exceed the supported range",
  "row-shape": "row has an unsupported shape or kind",
  size: "the size is not a positive number",
  "stock-basis": "no stock entry basis stored",
  strike: "a strike is missing or invalid",
  structure: "legs do not match the strategy kind",
};

export const LAB_LIMITS: readonly string[] = [
  "Profit or loss at expiry only, from intrinsic value.",
  "No time value, no volatility and no probability.",
  "No early assignment.",
  "No fees, slippage or dividends.",
  "Stored entry premiums, not live prices.",
  "Lines with different expiry dates settle on different days.",
  "Research only: not advice and not an order.",
];
