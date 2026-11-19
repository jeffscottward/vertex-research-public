// What: Formatting for the /flow page: compact money and counts, signed deltas, shares, prices,
// ages, and New York timestamps with their zone label (EST/EDT).
// Used by: apps/web/src/features/flow/view-model.ts, apps/web/src/components/portal/flow-workspace.tsx.

const FLOW_TIME_ZONE = "America/New_York";

/** Default text for a null value; a call site that knows the cause passes its own reason. */
export const NO_VALUE = "no value";

/** Text for a timestamp that does not parse. */
export const UNREADABLE_TIME = "unreadable time";

const compactMoney = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 1,
  notation: "compact",
  style: "currency",
});

const compactCount = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 1,
  notation: "compact",
});

const wholeCount = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 0,
});

const priceFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
  minimumFractionDigits: 2,
});

const nyTime = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  timeZone: FLOW_TIME_ZONE,
  timeZoneName: "short",
});

const nyDateTime = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  month: "short",
  timeZone: FLOW_TIME_ZONE,
  timeZoneName: "short",
});

/** $1.2M, $950K, $0; null → the `missing` reason. */
export const formatMoney = (
  value: number | null,
  missing: string = NO_VALUE
): string => (value === null ? missing : compactMoney.format(value));

/** 1.2M, 950K, 12; null → the `missing` reason. */
export const formatCount = (
  value: number | null,
  missing: string = NO_VALUE
): string => (value === null ? missing : compactCount.format(value));

/** +1,234 / −1,234 / 0 with a true minus sign. */
export const formatSigned = (value: number): string => {
  const magnitude = wholeCount.format(Math.abs(value));
  if (value > 0) return `+${magnitude}`;
  if (value < 0) return `−${magnitude}`;
  return "0";
};

/** A −1..1 ratio as a signed decimal, e.g. +0.24; null → the `missing` reason. */
export const formatSignedRatio = (
  value: number | null,
  missing: string = NO_VALUE
): string => {
  if (value === null) return missing;
  const magnitude = Math.abs(value).toFixed(2);
  if (value > 0) return `+${magnitude}`;
  if (value < 0) return `−${magnitude}`;
  return "0.00";
};

/** A 0..1 share as a percentage, e.g. 0.42 → 42%; null → the `missing` reason. */
export const formatShare = (
  value: number | null,
  missing: string = NO_VALUE
): string => (value === null ? missing : `${Math.round(value * 100)}%`);

/** A plain ratio with two decimals, e.g. 0.85; null → the `missing` reason. */
export const formatRatio = (
  value: number | null,
  missing: string = NO_VALUE
): string => (value === null ? missing : value.toFixed(2));

/** A price with two decimals and grouping, e.g. 5,912.25; null → the `missing` reason. */
export const formatPrice = (
  value: number | null,
  missing: string = NO_VALUE
): string => (value === null ? missing : priceFormat.format(value));

/** A signed price difference, e.g. +18.50 / −3.25; null → the `missing` reason. */
export const formatSignedPrice = (
  value: number | null,
  missing: string = NO_VALUE
): string => {
  if (value === null) return missing;
  const magnitude = priceFormat.format(Math.abs(value));
  if (value > 0) return `+${magnitude}`;
  if (value < 0) return `−${magnitude}`;
  return magnitude;
};

/** 45s, 12m, 3h 5m, 2d 4h; null → "never". */
export const formatAge = (seconds: number | null): string => {
  if (seconds === null) return "never";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
};

/** 90 → "1m 30s", 7200 → "2h", 4500 → "1h 15m". */
export const formatDuration = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0 ? `${hours}h` : `${hours}h ${restMinutes}m`;
};

const valid = (iso: string): Date | null => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
};

/** "10:42 AM EST" in New York time; an unreadable timestamp → "unreadable time". */
export const formatNyTime = (iso: string): string => {
  const date = valid(iso);
  return date === null ? UNREADABLE_TIME : nyTime.format(date);
};

/** "Nov 6, 3:59 PM EST" in New York time; an unreadable timestamp → "unreadable time". */
export const formatNyDateTime = (iso: string): string => {
  const date = valid(iso);
  return date === null ? UNREADABLE_TIME : nyDateTime.format(date);
};

/**
 * The label of an enum value. A value without a label (a tab loaded before a later deploy) names
 * itself and the next step, not a blank.
 */
export const enumLabel = <K extends string>(
  labels: Partial<Record<K, string>>,
  value: string
): string => {
  const label = (labels as Partial<Record<string, string>>)[value];
  return label === undefined
    ? `Value "${value}" has no label in this page version · reload the page`
    : label;
};
