import {
  OPENBB_DAILY_BAR_SYMBOLS,
  OPENBB_PRICE_SERIES_IDS,
  OPENBB_VOL_INDEX_IDS,
} from "./contracts/openbb.ts";
import { isNyseTradingDay, utcDay } from "./nyse-calendar.ts";

// Pure freshness evaluation and incident-transition logic for the 31 stored daily series and 14
// stored 1d bar series (docs/vertex-rebuild/designs/price-freshness-alert/plan.md). Research data
// alerting only: no DB or HTTP dependencies, no order or risk paths.

const DAY_MS = 86_400_000;
const SLA_CUTOFF_HOUR_NY = 6;
const EY_TNX_RATIO_ID = "EY_TNX_RATIO";

export const OPENBB_PRICE_FRESHNESS_MONITOR = "price-freshness" as const;
const OPENBB_PRICE_FRESHNESS_MAX_SESSIONS = 2 as const;
const OPENBB_PRICE_FRESHNESS_CLEAR_SESSIONS = 1 as const;
const OPENBB_EY_TNX_RATIO_MAX_SESSIONS = 25 as const;
const OPENBB_EY_TNX_RATIO_CLEAR_SESSIONS = 24 as const;
const OPENBB_FRESHNESS_MAX_LISTED_ITEMS = 8 as const;
export const OPENBB_FRESHNESS_IN_FLIGHT_LEASE_MS = 60_000 as const;

export const OPENBB_ALL_DAILY_SERIES_IDS = [
  ...OPENBB_VOL_INDEX_IDS,
  ...OPENBB_PRICE_SERIES_IDS,
] as const;

export const OPENBB_PRICE_FRESHNESS_TABLES = [
  "daily_series",
  "daily_bars",
] as const;

export type OpenbbPriceFreshnessTable =
  (typeof OPENBB_PRICE_FRESHNESS_TABLES)[number];

export type OpenbbStaleSeries = Readonly<{
  id: string;
  lastDate: string | null;
  maxSessionsBehind: number;
  sessionsBehind: number | null;
  table: OpenbbPriceFreshnessTable;
}>;

export type OpenbbFreshnessPlannedAlert = Readonly<{
  body: string;
  kind: "alert" | "recovery";
  title: string;
}>;

export type OpenbbFreshnessDiff =
  | Readonly<{
      action: "alert" | "recovery";
      alert: OpenbbFreshnessPlannedAlert;
      idempotencySource: string;
      newlyStale: OpenbbStaleSeries[];
      nextActiveKeys: string[];
    }>
  | Readonly<{
      action: "noop" | "in-flight" | "prune-active" | "clear-pending";
      alert: null;
      idempotencySource: null;
      newlyStale: OpenbbStaleSeries[];
      nextActiveKeys: string[];
    }>;

const NY_PARTS = new Intl.DateTimeFormat("en-US", {
  day: "2-digit",
  hour: "2-digit",
  hourCycle: "h23",
  month: "2-digit",
  timeZone: "America/New_York",
  year: "numeric",
});

const parseIsoDay = (iso: string): number => {
  const [year, month, day] = iso.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  return utcDay(year, month - 1, day);
};

/**
 * Expected latest stored NYSE trading session as of `now` using the 06:00 America/New_York SLA:
 * overnight ingest finishes before 06:00 ET, so session D becomes due at 06:00 ET on D+1.
 */
export const expectedFreshnessSession = (now: Date): string => {
  const parts = Object.fromEntries(
    NY_PARTS.formatToParts(now).map((part) => [part.type, part.value])
  ) as Record<string, string>;
  const today = utcDay(
    Number(parts["year"]),
    Number(parts["month"]) - 1,
    Number(parts["day"])
  );
  const hour = Number(parts["hour"]);
  let candidate = hour >= SLA_CUTOFF_HOUR_NY ? today - 1 : today - 2;
  while (!isNyseTradingDay(candidate)) candidate -= 1;
  return new Date(candidate * DAY_MS).toISOString().slice(0, 10);
};

/**
 * Count of NYSE trading days strictly after `lastDate` and on or before `expectedSession`.
 * Returns 0 when `lastDate >= expectedSession`.
 */
export const nyseSessionsBehind = (
  lastDate: string,
  expectedSession: string
): number => {
  const lastDay = parseIsoDay(lastDate);
  const expectedDay = parseIsoDay(expectedSession);
  if (lastDay >= expectedDay) return 0;
  let behind = 0;
  for (let day = lastDay + 1; day <= expectedDay; day += 1)
    if (isNyseTradingDay(day)) behind += 1;
  return behind;
};

/** Per-series lag thresholds (stale > maxSessions; clear <= clearSessions). */
export const thresholdForSeries = (
  table: OpenbbPriceFreshnessTable,
  id: string
): Readonly<{ clearSessions: number; maxSessions: number }> =>
  table === "daily_series" && id === EY_TNX_RATIO_ID
    ? {
        clearSessions: OPENBB_EY_TNX_RATIO_CLEAR_SESSIONS,
        maxSessions: OPENBB_EY_TNX_RATIO_MAX_SESSIONS,
      }
    : {
        clearSessions: OPENBB_PRICE_FRESHNESS_CLEAR_SESSIONS,
        maxSessions: OPENBB_PRICE_FRESHNESS_MAX_SESSIONS,
      };

/** Canonical key `<table:id>` used in activeKeys and deterministic sorting. */
export const freshnessKeyOf = (
  item: Readonly<{ id: string; table: OpenbbPriceFreshnessTable }>
): string => `${item.table}:${item.id}`;

const SORTED_DAILY_IDS = [...OPENBB_ALL_DAILY_SERIES_IDS].sort();
const SORTED_BAR_SYMBOLS = [...OPENBB_DAILY_BAR_SYMBOLS].sort();
const TOTAL_MONITORED = SORTED_DAILY_IDS.length + SORTED_BAR_SYMBOLS.length;

/**
 * Evaluates all 31 stored daily series and 14 stored 1d bar series against `expectedSession`.
 * Output `stale` is sorted deterministically (`daily_series` before `daily_bars`, then by `id`).
 */
export type OpenbbFreshnessEvaluation = Readonly<{
  clearableKeys: string[];
  monitoredKeys: string[];
  stale: OpenbbStaleSeries[];
}>;

export const evaluatePriceFreshness = (
  input: Readonly<{
    bars: readonly Readonly<{ lastDate: string; symbol: string }>[];
    expectedSession: string;
    series: readonly Readonly<{ id: string; lastDate: string }>[];
  }>
): OpenbbFreshnessEvaluation => {
  const seriesById = new Map(
    input.series.map((entry) => [entry.id, entry.lastDate])
  );
  const barsBySymbol = new Map(
    input.bars.map((entry) => [entry.symbol, entry.lastDate])
  );
  const stale: OpenbbStaleSeries[] = [];
  const clearableKeys: string[] = [];
  const monitoredKeys: string[] = [];

  const checkOne = (
    table: OpenbbPriceFreshnessTable,
    id: string,
    lastDate: string | undefined
  ) => {
    const key = freshnessKeyOf({ id, table });
    monitoredKeys.push(key);
    const { clearSessions, maxSessions } = thresholdForSeries(table, id);
    if (lastDate === undefined) {
      stale.push({
        id,
        lastDate: null,
        maxSessionsBehind: maxSessions,
        sessionsBehind: null,
        table,
      });
      return;
    }
    const behind = nyseSessionsBehind(lastDate, input.expectedSession);
    if (behind > maxSessions) {
      stale.push({
        id,
        lastDate,
        maxSessionsBehind: maxSessions,
        sessionsBehind: behind,
        table,
      });
    } else if (behind <= clearSessions) {
      clearableKeys.push(key);
    }
  };

  for (const id of SORTED_DAILY_IDS)
    checkOne("daily_series", id, seriesById.get(id));
  for (const symbol of SORTED_BAR_SYMBOLS)
    checkOne("daily_bars", symbol, barsBySymbol.get(symbol));

  return { clearableKeys, monitoredKeys, stale };
};

const formatStaleItem = (item: OpenbbStaleSeries): string => {
  const label = item.table === "daily_bars" ? `${item.id} 1d bars` : item.id;
  return item.lastDate === null
    ? `${label} (missing)`
    : `${label} (${item.sessionsBehind}d, last ${item.lastDate})`;
};

/**
 * Formats one consolidated ASCII-only alert message (title <= 120 B, body <= 1,000 B).
 * `<N>` in the title is `newlyStale.length`.
 */
export const formatFreshnessAlertMessage = (
  newlyStale: readonly OpenbbStaleSeries[],
  totalStale: number,
  expectedSession: string
): Readonly<{ body: string; title: string }> => {
  const title = `Vertex: ${newlyStale.length} daily price/bar series stale (${expectedSession})`;
  const listed = newlyStale
    .slice(0, OPENBB_FRESHNESS_MAX_LISTED_ITEMS)
    .map(formatStaleItem);
  const overflow = newlyStale.length - listed.length;
  if (overflow > 0) listed.push(`+${overflow} more`);
  const body = `${listed.join(", ")}. Total stale: ${totalStale}/${TOTAL_MONITORED}; expected ${expectedSession}. Repair: vertex:series:import or vertex:bars:import`;
  return { body, title };
};

/** Formats one ASCII-only full-recovery message (title <= 120 B, body <= 400 B). */
export const formatFreshnessRecoveryMessage = (
  recoveredCount: number,
  expectedSession: string
): Readonly<{ body: string; title: string }> => ({
  body: `All ${SORTED_DAILY_IDS.length} daily series and ${SORTED_BAR_SYMBOLS.length} 1d bar series are fresh as of ${expectedSession} (${recoveredCount} recovered).`,
  title: `Vertex: daily price/bar series fresh again (${expectedSession})`,
});

const sameStringSet = (
  left: readonly string[],
  right: readonly string[]
): boolean => {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
};

/**
 * Exhaustive 5-way incident transition (+ 60 s in-flight lease guard):
 * 1. in-flight: a pending delivery is younger than 60 s -> noop without overwriting pendingEventId.
 * 2. alert: newlyStale is non-empty -> stage/refresh alert.
 * 3. recovery: nextActiveKeys is empty while activeKeys was non-empty -> stage/refresh recovery.
 * 4. prune-active: activeKeys shrank silently (partial recovery) -> commit nextActiveKeys, clear pending.
 * 5. clear-pending: obsolete pendingEventId remains while activeKeys unchanged -> clear pending silently.
 * 6. noop: steady state -> zero DB writes.
 */
export const diffFreshnessIncident = (
  input: Readonly<{
    activeKeys: readonly string[];
    clearableKeys: readonly string[];
    expectedSession: string;
    monitoredKeys: readonly string[];
    now: Date;
    pendingDelivery: "pending" | "not-configured" | "failed" | null;
    pendingEventId: string | null;
    stale: readonly OpenbbStaleSeries[];
    updatedAt: Date | null;
  }>
): OpenbbFreshnessDiff => {
  if (
    input.pendingEventId !== null &&
    input.pendingDelivery === "pending" &&
    input.updatedAt !== null &&
    input.now.getTime() - input.updatedAt.getTime() <
      OPENBB_FRESHNESS_IN_FLIGHT_LEASE_MS
  ) {
    return {
      action: "in-flight",
      alert: null,
      idempotencySource: null,
      newlyStale: [],
      nextActiveKeys: [...input.activeKeys].sort(),
    };
  }

  const activeSet = new Set(input.activeKeys);
  const clearableSet = new Set(input.clearableKeys);
  const monitoredSet = new Set(input.monitoredKeys);
  const staleKeys = input.stale.map(freshnessKeyOf);
  const retainedActive = input.activeKeys.filter(
    (key) => monitoredSet.has(key) && !clearableSet.has(key)
  );
  const newlyStale = input.stale.filter(
    (item) => !activeSet.has(freshnessKeyOf(item))
  );
  const nextActiveKeys = [...new Set([...retainedActive, ...staleKeys])].sort();

  if (newlyStale.length > 0) {
    const message = formatFreshnessAlertMessage(
      newlyStale,
      input.stale.length,
      input.expectedSession
    );
    return {
      action: "alert",
      alert: { ...message, kind: "alert" },
      idempotencySource: `price-freshness:alert:${input.expectedSession}:${nextActiveKeys.join(",")}`,
      newlyStale,
      nextActiveKeys,
    };
  }

  if (nextActiveKeys.length === 0 && input.activeKeys.length > 0) {
    const sortedPrev = [...input.activeKeys].sort();
    const message = formatFreshnessRecoveryMessage(
      sortedPrev.length,
      input.expectedSession
    );
    return {
      action: "recovery",
      alert: { ...message, kind: "recovery" },
      idempotencySource: `price-freshness:recovery:${input.expectedSession}:${sortedPrev.join(",")}`,
      newlyStale: [],
      nextActiveKeys: [],
    };
  }

  if (!sameStringSet(nextActiveKeys, input.activeKeys)) {
    return {
      action: "prune-active",
      alert: null,
      idempotencySource: null,
      newlyStale: [],
      nextActiveKeys,
    };
  }

  if (input.pendingEventId !== null) {
    return {
      action: "clear-pending",
      alert: null,
      idempotencySource: null,
      newlyStale: [],
      nextActiveKeys,
    };
  }

  return {
    action: "noop",
    alert: null,
    idempotencySource: null,
    newlyStale: [],
    nextActiveKeys,
  };
};
