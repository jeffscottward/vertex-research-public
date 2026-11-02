// Pure client-side analysis of loaded bars. Display only; no trading authority.

export type AnalysisBar = Readonly<{ t: number; c: number }>;
// t: epoch seconds of the bar that closes the return; r: simple close-to-close return.
export type BarReturn = Readonly<{ t: number; r: number }>;
export type ReturnStats = Readonly<{
  count: number;
  mean: number | null;
  stdev: number | null;
  skew: number | null;
  min: number | null;
  max: number | null;
}>;
export type HistogramBin = Readonly<{
  from: number;
  to: number;
  count: number;
}>;
export type SessionGrouping = "weekday" | "hour";
export type SessionRow = Readonly<{
  key: number;
  label: string;
  count: number;
  meanReturn: number;
  positiveShare: number;
}>;

const HISTOGRAM_BINS = 20;

export const closeReturns = (bars: readonly AnalysisBar[]): BarReturn[] => {
  const returns: BarReturn[] = [];
  for (let index = 1; index < bars.length; index += 1) {
    const previousBar = bars[index - 1];
    const currentBar = bars[index];
    if (previousBar === undefined || currentBar === undefined) continue;
    const previous = previousBar.c;
    const current = currentBar.c;
    if (
      !(Number.isFinite(previous) && Number.isFinite(current)) ||
      previous <= 0
    )
      continue;
    returns.push({ t: currentBar.t, r: current / previous - 1 });
  }
  return returns;
};

// Sample stdev (n - 1) and adjusted Fisher-Pearson skew (spreadsheet SKEW).
export const returnStats = (values: readonly number[]): ReturnStats => {
  const finite = values.filter((value) => Number.isFinite(value));
  const count = finite.length;
  if (count === 0)
    return {
      count: 0,
      mean: null,
      stdev: null,
      skew: null,
      min: null,
      max: null,
    };
  const mean = finite.reduce((sum, value) => sum + value, 0) / count;
  const min = finite.reduce(
    (low, value) => Math.min(low, value),
    Number.POSITIVE_INFINITY
  );
  const max = finite.reduce(
    (high, value) => Math.max(high, value),
    Number.NEGATIVE_INFINITY
  );
  if (count < 2) return { count, mean, stdev: null, skew: null, min, max };
  const variance =
    finite.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (count - 1);
  const stdev = Math.sqrt(variance);
  const skew =
    count < 3 || stdev === 0
      ? null
      : (count / ((count - 1) * (count - 2))) *
        finite.reduce((sum, value) => sum + ((value - mean) / stdev) ** 3, 0);
  return { count, mean, stdev, skew, min, max };
};

export const returnHistogram = (
  values: readonly number[],
  binCount = HISTOGRAM_BINS
): HistogramBin[] => {
  if (!Number.isSafeInteger(binCount) || binCount < 1 || binCount > 200)
    throw new RangeError("Bin count must be 1 to 200");
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return [];
  const low = finite.reduce(
    (least, value) => Math.min(least, value),
    Number.POSITIVE_INFINITY
  );
  const high = finite.reduce(
    (most, value) => Math.max(most, value),
    Number.NEGATIVE_INFINITY
  );
  if (low === high) return [{ from: low, to: high, count: finite.length }];
  const width = (high - low) / binCount;
  const counts = Array.from({ length: binCount }, () => 0);
  for (const value of finite) {
    const bin = Math.min(binCount - 1, Math.floor((value - low) / width));
    counts[bin] = (counts[bin] ?? 0) + 1;
  }
  return counts.map((count, index) => ({
    from: low + index * width,
    to: index === binCount - 1 ? high : low + (index + 1) * width,
    count,
  }));
};

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const formatters = new Map<string, Intl.DateTimeFormat>();
const formatterFor = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      weekday: "short",
      hour: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
};

const sessionKey = (
  seconds: number,
  grouping: SessionGrouping,
  timeZone: string
): number | null => {
  const parts = formatterFor(timeZone).formatToParts(new Date(seconds * 1000));
  if (grouping === "weekday") {
    const index = WEEKDAYS.indexOf(
      parts.find((part) => part.type === "weekday")
        ?.value as (typeof WEEKDAYS)[number]
    );
    return index < 0 ? null : index;
  }
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
};

// Groups returns by weekday (Monday first) or hour of day in an IANA zone. Only groups with data appear.
export const sessionStats = (
  returns: readonly BarReturn[],
  grouping: SessionGrouping,
  timeZone = "UTC"
): SessionRow[] => {
  const groups = new Map<
    number,
    { count: number; sum: number; positive: number }
  >();
  for (const row of returns) {
    if (!Number.isFinite(row.r)) continue;
    const key = sessionKey(row.t, grouping, timeZone);
    if (key === null) continue;
    const group = groups.get(key) ?? { count: 0, sum: 0, positive: 0 };
    group.count += 1;
    group.sum += row.r;
    if (row.r > 0) group.positive += 1;
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([key, group]) => ({
      key,
      label:
        grouping === "weekday"
          ? (WEEKDAYS[key] ?? String(key))
          : `${String(key).padStart(2, "0")}:00`,
      count: group.count,
      meanReturn: group.sum / group.count,
      positiveShare: group.positive / group.count,
    }));
};

export const isIntradayBarSize = (barSize: string): boolean =>
  barSize !== "1 day";

const validTimeZone = (timeZone: string): boolean => {
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
};

// Daily bars are stamped 00:00 UTC of the trading date, so a local zone would shift the weekday.
export const analysisTimeZone = (
  barSize: string,
  timeZoneId: string | null
): string => {
  if (!isIntradayBarSize(barSize) || timeZoneId === null || timeZoneId === "")
    return "UTC";
  return validTimeZone(timeZoneId) ? timeZoneId : "UTC";
};
