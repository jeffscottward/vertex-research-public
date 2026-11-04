import type {
  SectorRotationPointRecord,
  SectorRotationRepository,
} from "@darkfactory/db/server";
import type { NotificationFetch } from "@darkfactory/notifications/server";
import { implement } from "@orpc/server";

import { appContract } from "../contract.ts";
import {
  SECTOR_ROTATION_BENCHMARK,
  SECTOR_ROTATION_HISTORY_DAYS,
  SECTOR_ROTATION_MAX_POINTS,
  SECTOR_ROTATION_SECTORS,
  SECTOR_ROTATION_SNAPSHOT_MAX_TRANSITIONS,
  SECTOR_ROTATION_SNAPSHOT_VERSION,
  type SectorRotationAlert,
  type SectorRotationMapOutput,
  type SectorRotationPoint,
  type SectorRotationQuadrant,
  type SectorRotationSeries,
  type SectorRotationSnapshotSector,
  type SectorRotationTimeframe,
  type SectorRotationTransition,
} from "../contracts/sector-rotation.ts";
import { YahooChartSchema } from "../deep-value-facts.ts";
import {
  type ClosePoint,
  computeTimeframePoints,
  daysBefore,
  isWeekComplete,
  latestOf,
  quadrantChanges,
  SECTOR_ROTATION_PARAMS,
} from "../sector-rotation.ts";
import type { ApiContext } from "./context.ts";
import type { DeployStatusFetch } from "./deploy-status.ts";
import { requireOperator } from "./operator-access.ts";
import { sendPriceAlertsNtfy } from "./price-alerts.ts";
import { fetchBoundedJson, type ResearchLensError } from "./research-lenses.ts";

// Sector rotation procedures (sectorRotation.*). Operator-only. collect (scheduler, operator agent
// write key) reads five years of Yahoo daily bars for SPY and the 11 sector ETFs, stores daily and
// weekly points for every computed date, and records one insert-once alert per daily entry into
// leading or lagging; only a newly recorded alert is sent to the price alert ntfy destination. map
// reads the stored sector points, or computes a custom list on request (two years of bars, 10-minute
// in-process cache). snapshot is the versioned research input. Research only: no order path.

const api = implement(appContract).$context<ApiContext>();

const YAHOO_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) vertex-research/sector-rotation";
const YAHOO_MAX_BYTES = 4 * 1024 * 1024;
const YAHOO_TIMEOUT_MS = 10_000;
const FETCH_CONCURRENCY = 4;
/** US regular session length; a quote after it is the closing price. */
const REGULAR_SESSION_SECONDS = 6.5 * 60 * 60;
const COLLECT_RANGE = "5y";
const MAP_RANGE = "2y";
const MAP_CACHE_TTL_MS = 10 * 60_000;
const MAP_CACHE_MAX_ENTRIES = 50;
/** Extra days read before the 12-month window, so a short collection gap still has a map. */
const STORED_LOOKBACK_MARGIN_DAYS = 31;
const ALERT_QUADRANTS: readonly SectorRotationQuadrant[] = [
  "leading",
  "lagging",
];
const NOTIFICATION_TITLE = "Vertex sector rotation";
const ALL_DATES = "0000-01-01";
/** Calendar days a new Leading or Lagging streak may be old and still be alerted (missed runs). */
const ALERT_LOOKBACK_DAYS = 7;

export type SectorRotationOptions = Readonly<{
  /** Yahoo chart fetch. */
  fetch?: DeployStatusFetch;
  /** ntfy publish fetch. */
  notify?: NotificationFetch;
  now?: () => Date;
}>;

let options: SectorRotationOptions = {};
const mapCache = new Map<
  string,
  Readonly<{ at: number; value: SectorRotationMapOutput }>
>();

/** Replaces the fetch, ntfy and clock seams and clears the map cache. */
export const setSectorRotationOptionsForTesting = (
  next: SectorRotationOptions
): void => {
  options = next;
  mapCache.clear();
};

const sectorNames: ReadonlyMap<string, string> = new Map(
  SECTOR_ROTATION_SECTORS.map((sector) => [sector.symbol, sector.name])
);
const SECTOR_SYMBOLS = SECTOR_ROTATION_SECTORS.map((sector) => sector.symbol);

type Failures = Readonly<{
  FORBIDDEN: (options?: { message?: string }) => Error;
  NOT_FOUND: (options?: { message?: string }) => Error;
  STORAGE_ERROR: () => Error;
  UNAVAILABLE: (options?: { message?: string }) => Error;
}>;

type SymbolError = Readonly<{ symbol: string; reason: string }>;

type DailyBars = Readonly<{ closes: ClosePoint[]; name: string | null }>;

type BarsResult =
  | Readonly<{ ok: true; bars: DailyBars }>
  | Readonly<{ ok: false; reason: string; unknown: boolean }>;

/**
 * Daily closes from one Yahoo chart, oldest first, one per UTC date. The adjusted close is used when
 * present (dividends and splits), otherwise the close. Rows without a positive finite value are dropped.
 */
const fetchDailyBars = async (
  symbol: string,
  range: string
): Promise<BarsResult> => {
  let raw: unknown;
  try {
    raw = await fetchBoundedJson(
      {
        headers: { "user-agent": YAHOO_USER_AGENT },
        label: "Yahoo chart",
        maxBytes: YAHOO_MAX_BYTES,
        url: `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol.replace(/[./]/gu, "-"))}?range=${range}&interval=1d`,
      },
      {
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        timeoutMs: YAHOO_TIMEOUT_MS,
      }
    );
  } catch (error) {
    // fetchBoundedJson reports every failure as a ResearchLensError without the URL.
    const lens = error as ResearchLensError;
    return {
      ok: false,
      reason: lens.message,
      unknown: lens.code === "NOT_FOUND",
    };
  }
  const parsed = YahooChartSchema.safeParse(raw);
  if (!parsed.success)
    return {
      ok: false,
      reason: "Yahoo returned an unexpected document",
      unknown: false,
    };
  const result = parsed.data.chart.result?.[0];
  // Adjusted closes when Yahoo sends them (never mixed with raw closes row by row), else closes.
  const values =
    result?.indicators.adjclose?.[0]?.adjclose ??
    result?.indicators.quote?.[0]?.close ??
    [];
  const byDate = new Map<string, number>();
  (result?.timestamp ?? []).forEach((time, index) => {
    const value = values[index];
    // The chart schema admits only finite numbers.
    if (typeof value === "number" && value > 0)
      byDate.set(new Date(time * 1000).toISOString().slice(0, 10), value);
  });
  // The newest daily bar holds a live price while the regular session runs (6.5 hours after the
  // bar opens), and Yahoo leaves its close empty for some hours after the session. When the quote
  // time is on the newest bar's date: before the session end that bar is dropped (an intraday price
  // never becomes a close); after it an empty close is filled with the quote price.
  const opened = result?.timestamp?.at(-1) ?? 0;
  const quoted = result?.meta?.regularMarketTime ?? 0;
  const price = result?.meta?.regularMarketPrice ?? 0;
  const day = new Date(opened * 1000).toISOString().slice(0, 10);
  if (new Date(quoted * 1000).toISOString().slice(0, 10) === day) {
    if (quoted < opened + REGULAR_SESSION_SECONDS) byDate.delete(day);
    else if (price > 0 && !byDate.has(day)) byDate.set(day, price);
  }
  if (byDate.size === 0)
    return {
      ok: false,
      reason: "Yahoo has no daily bars for this symbol",
      unknown: true,
    };
  const name = (result?.meta?.shortName ?? result?.meta?.longName)?.trim();
  return {
    bars: {
      closes: [...byDate]
        .map(([date, close]) => ({ close, date }))
        .sort((a, b) => a.date.localeCompare(b.date)),
      name: name === undefined || name === "" ? null : name.slice(0, 80),
    },
    ok: true,
  };
};

/** Bars for each symbol, a few requests at a time. */
const fetchAllBars = async (
  symbols: readonly string[],
  range: string
): Promise<Map<string, BarsResult>> => {
  const out = new Map<string, BarsResult>();
  for (let start = 0; start < symbols.length; start += FETCH_CONCURRENCY) {
    const batch = symbols.slice(start, start + FETCH_CONCURRENCY);
    const results = await Promise.all(
      batch.map((symbol) => fetchDailyBars(symbol, range))
    );
    batch.forEach((symbol, index) => {
      out.set(symbol, results[index] as BarsResult);
    });
  }
  return out;
};

const repositoryFor = (
  context: ApiContext,
  failures: Failures
): SectorRotationRepository => {
  const repository = context.repositories.sectorRotation;
  if (repository === undefined) throw failures.STORAGE_ERROR();
  return repository;
};

const clock = (): Date => (options.now ?? (() => new Date()))();

/** The fixed-format alert line sent to ntfy and printed by the scheduler. */
export const sectorRotationAlertLine = (
  transition: SectorRotationTransition,
  point: SectorRotationPoint
): string =>
  `Sector rotation: ${transition.symbol}${transition.name === null ? "" : ` (${transition.name})`} entered ${transition.to.slice(0, 1).toUpperCase()}${transition.to.slice(1)} on ${transition.date} (latest ratio ${point.ratio.toFixed(1)}, momentum ${point.momentum.toFixed(1)}). Research only.`;

type StoredWindow = Readonly<{
  asOf: string;
  computedAt: Date;
  bySymbol: ReadonlyMap<string, SectorRotationPoint[]>;
}>;

/**
 * Stored sector points of the 12 months before the newest stored date. Null when nothing was
 * stored in the last 13 months.
 */
const loadStoredWindow = async (
  repository: SectorRotationRepository,
  timeframe: SectorRotationTimeframe
): Promise<StoredWindow | null> => {
  const today = clock().toISOString().slice(0, 10);
  const records = await repository.listPoints({
    fromDate: daysBefore(
      today,
      SECTOR_ROTATION_HISTORY_DAYS + STORED_LOOKBACK_MARGIN_DAYS
    ),
    symbols: SECTOR_SYMBOLS,
    timeframe,
  });
  const first = records[0];
  if (first === undefined) return null;
  let asOf = first.date;
  let computedAt = first.computedAt;
  for (const record of records) {
    if (record.date > asOf) asOf = record.date;
    if (record.computedAt > computedAt) computedAt = record.computedAt;
  }
  const fromDate = daysBefore(asOf, SECTOR_ROTATION_HISTORY_DAYS);
  const bySymbol = new Map<string, SectorRotationPoint[]>();
  for (const record of records) {
    if (record.date < fromDate) continue;
    const points = bySymbol.get(record.symbol) ?? [];
    points.push({
      date: record.date,
      momentum: record.momentum,
      quadrant: record.quadrant,
      ratio: record.ratio,
    });
    bySymbol.set(record.symbol, points);
  }
  return { asOf, bySymbol, computedAt };
};

type SectorPoints = Readonly<{
  /** The newest daily date over every sector; undefined when no sector has points. */
  asOf: string | undefined;
  daily: ReadonlyMap<string, SectorRotationPoint[]>;
  fetchErrors: SymbolError[];
  records: Readonly<
    Record<SectorRotationTimeframe, SectorRotationPointRecord[]>
  >;
}>;

/** Daily and weekly points of every fetched sector, for every computed date. */
const computeSectorPoints = (
  fetched: ReadonlyMap<string, BarsResult>,
  benchmark: readonly ClosePoint[],
  now: Date
): SectorPoints => {
  const fetchErrors: SymbolError[] = [];
  const daily = new Map<string, SectorRotationPoint[]>();
  const records: Record<SectorRotationTimeframe, SectorRotationPointRecord[]> =
    { daily: [], weekly: [] };
  let asOf: string | undefined;
  for (const symbol of SECTOR_SYMBOLS) {
    const result = fetched.get(symbol) as BarsResult;
    if (!result.ok) {
      fetchErrors.push({ reason: result.reason, symbol });
      continue;
    }
    const points = computeTimeframePoints(
      result.bars.closes,
      benchmark,
      "daily",
      ALL_DATES
    );
    const last = points.at(-1);
    if (last === undefined) {
      fetchErrors.push({ reason: "Too little price history", symbol });
      continue;
    }
    daily.set(symbol, points);
    if (asOf === undefined || last.date > asOf) asOf = last.date;
    // Only final weeks are stored: a partial week would leave one row per weekday.
    const weekly = computeTimeframePoints(
      result.bars.closes,
      benchmark,
      "weekly",
      ALL_DATES
    ).filter((point) => isWeekComplete(point.date, last.date));
    for (const [timeframe, list] of [
      ["daily", points],
      ["weekly", weekly],
    ] as const)
      for (const point of list)
        records[timeframe].push({
          ...point,
          benchmark: SECTOR_ROTATION_BENCHMARK,
          computedAt: now,
          symbol,
          timeframe,
        });
  }
  return { asOf, daily, fetchErrors, records };
};

/**
 * Records one alert insert-once and sends it only when this call created it. Null means the alert
 * was already recorded by an earlier run (or the second daily timer), so it is not sent again.
 */
const recordAndSend = async (
  repository: SectorRotationRepository,
  context: ApiContext,
  transition: SectorRotationTransition,
  line: string,
  now: Date
): Promise<SectorRotationAlert | null> => {
  const key = {
    enteredOn: transition.date,
    quadrant: transition.to,
    symbol: transition.symbol,
  };
  if (!(await repository.recordAlert({ ...key, createdAt: now, line })))
    return null;
  const delivery = await sendPriceAlertsNtfy(
    context.priceAlertsNtfy ?? null,
    { body: line, title: NOTIFICATION_TITLE },
    `sector-rotation:${key.symbol}:${key.quadrant}:${key.enteredOn}`,
    now,
    options.notify
  );
  await repository.recordDelivery({ ...key, delivery });
  return { ...transition, delivery, line };
};

const collect = api.sectorRotation.collect
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    // Scheduler only: one run stores points and sends alerts for the whole deployment.
    if (context.agentApiKeyPresented !== true)
      throw failures.FORBIDDEN({
        message: "sectorRotation.collect needs an agent API key",
      });
    const repository = repositoryFor(context, failures);
    const now = clock();
    const fetched = await fetchAllBars(
      [SECTOR_ROTATION_BENCHMARK, ...SECTOR_SYMBOLS],
      COLLECT_RANGE
    );
    const benchmark = fetched.get(SECTOR_ROTATION_BENCHMARK) as BarsResult;
    if (!benchmark.ok)
      throw failures.UNAVAILABLE({
        message: `${SECTOR_ROTATION_BENCHMARK}: ${benchmark.reason}`,
      });
    const { asOf, daily, fetchErrors, records } = computeSectorPoints(
      fetched,
      benchmark.bars.closes,
      now
    );
    if (asOf === undefined)
      throw failures.UNAVAILABLE({
        message: "No sector has enough price history",
      });
    const stored = input.dryRun
      ? { daily: 0, weekly: 0 }
      : {
          daily: await repository.upsertPoints(records.daily),
          weekly: await repository.upsertPoints(records.weekly),
        };
    const transitions: SectorRotationTransition[] = [];
    const alerts: SectorRotationAlert[] = [];
    const alertFrom = daysBefore(asOf, ALERT_LOOKBACK_DAYS);
    for (const { name, symbol } of SECTOR_ROTATION_SECTORS) {
      const points = daily.get(symbol) ?? [];
      for (const change of quadrantChanges(points))
        if (change.date === asOf) transitions.push({ ...change, name, symbol });
      // Alert the current Leading or Lagging streak when it began inside the look-back window, so a
      // missed run still alerts and an entry that already reversed does not.
      const latest = latestOf(points);
      if (
        latest === null ||
        latest.date !== asOf ||
        latest.since < alertFrom ||
        !ALERT_QUADRANTS.includes(latest.quadrant)
      )
        continue;
      // A short history (new listing) can start inside the window with no point before the streak.
      const before = points.at(-1 - latest.periods);
      if (before === undefined) continue;
      const transition = {
        date: latest.since,
        from: before.quadrant,
        name,
        symbol,
        to: latest.quadrant,
      };
      const line = sectorRotationAlertLine(transition, latest);
      const alert = input.dryRun
        ? { ...transition, delivery: "dry-run" as const, line }
        : await recordAndSend(repository, context, transition, line, now);
      if (alert === null) continue;
      alerts.push(alert);
    }
    return {
      alerts,
      asOf,
      dryRun: input.dryRun,
      fetchErrors,
      stored,
      transitions,
    };
  });

const seriesOf = (
  symbol: string,
  name: string | null,
  points: readonly SectorRotationPoint[]
): SectorRotationSeries => {
  const kept = points.slice(-SECTOR_ROTATION_MAX_POINTS);
  return { latest: latestOf(kept), name, points: kept, symbol };
};

/** A custom list (or another benchmark) computed from Yahoo bars on request. */
const computeMap = async (
  timeframe: SectorRotationTimeframe,
  benchmarkSymbol: string,
  symbols: readonly string[],
  universe: "sectors" | "custom",
  failures: Failures
): Promise<SectorRotationMapOutput> => {
  const now = clock();
  const key = `${timeframe}|${benchmarkSymbol}|${universe}|${[...symbols].sort().join(",")}`;
  const cached = mapCache.get(key);
  if (cached !== undefined && now.getTime() - cached.at < MAP_CACHE_TTL_MS)
    return cached.value;
  const fetched = await fetchAllBars(
    [...new Set([benchmarkSymbol, ...symbols])],
    MAP_RANGE
  );
  const benchmark = fetched.get(benchmarkSymbol) as BarsResult;
  if (!benchmark.ok)
    throw benchmark.unknown
      ? failures.NOT_FOUND({
          message: `Benchmark ${benchmarkSymbol}: ${benchmark.reason}`,
        })
      : failures.UNAVAILABLE({
          message: `Benchmark ${benchmarkSymbol}: ${benchmark.reason}`,
        });
  const asOf = (benchmark.bars.closes.at(-1) as ClosePoint).date;
  const fromDate = daysBefore(asOf, SECTOR_ROTATION_HISTORY_DAYS);
  const errors: SymbolError[] = [];
  const series: SectorRotationSeries[] = [];
  for (const symbol of symbols) {
    const result = fetched.get(symbol) as BarsResult;
    if (!result.ok) {
      errors.push({ reason: result.reason, symbol });
      continue;
    }
    const points = computeTimeframePoints(
      result.bars.closes,
      benchmark.bars.closes,
      timeframe,
      fromDate
    );
    if (points.length === 0) {
      errors.push({ reason: "Too little price history", symbol });
      continue;
    }
    series.push(
      seriesOf(symbol, sectorNames.get(symbol) ?? result.bars.name, points)
    );
  }
  const value: SectorRotationMapOutput = {
    asOf,
    benchmark: benchmarkSymbol,
    errors,
    generatedAt: now.toISOString(),
    params: SECTOR_ROTATION_PARAMS[timeframe],
    series,
    source: "computed",
    timeframe,
    universe,
  };
  for (const [entry, stored] of mapCache)
    if (now.getTime() - stored.at >= MAP_CACHE_TTL_MS) mapCache.delete(entry);
  // Insertion order: the first key is the oldest entry.
  if (mapCache.size >= MAP_CACHE_MAX_ENTRIES)
    mapCache.delete(mapCache.keys().next().value as string);
  mapCache.set(key, { at: now.getTime(), value });
  return value;
};

const map = api.sectorRotation.map
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    if (input.universe.kind === "custom")
      return computeMap(
        input.timeframe,
        input.benchmark,
        input.universe.symbols,
        "custom",
        failures
      );
    if (input.benchmark !== SECTOR_ROTATION_BENCHMARK)
      return computeMap(
        input.timeframe,
        input.benchmark,
        SECTOR_SYMBOLS,
        "sectors",
        failures
      );
    const window = await loadStoredWindow(
      repositoryFor(context, failures),
      input.timeframe
    );
    if (window === null) throw failures.NOT_FOUND();
    const series: SectorRotationSeries[] = [];
    const missing: SymbolError[] = [];
    for (const sector of SECTOR_ROTATION_SECTORS) {
      const points = window.bySymbol.get(sector.symbol);
      if (points === undefined)
        missing.push({ reason: "Not yet collected", symbol: sector.symbol });
      else series.push(seriesOf(sector.symbol, sector.name, points));
    }
    return {
      asOf: window.asOf,
      benchmark: SECTOR_ROTATION_BENCHMARK,
      errors: missing,
      generatedAt: window.computedAt.toISOString(),
      params: SECTOR_ROTATION_PARAMS[input.timeframe],
      series,
      source: "stored" as const,
      timeframe: input.timeframe,
      universe: "sectors" as const,
    };
  });

const snapshot = api.sectorRotation.snapshot
  .use(requireOperator)
  .handler(async ({ context, input, errors }) => {
    const failures = errors as unknown as Failures;
    const window = await loadStoredWindow(
      repositoryFor(context, failures),
      input.timeframe
    );
    if (window === null) throw failures.NOT_FOUND();
    let previousDate: string | null = null;
    for (const points of window.bySymbol.values())
      for (const point of points)
        if (
          point.date < window.asOf &&
          (previousDate === null || point.date > previousDate)
        )
          previousDate = point.date;
    const sectors: SectorRotationSnapshotSector[] = [];
    const changes: SectorRotationTransition[] = [];
    const recent: SectorRotationTransition[] = [];
    for (const sector of SECTOR_ROTATION_SECTORS) {
      const points = window.bySymbol.get(sector.symbol) ?? [];
      const latest = latestOf(points);
      if (latest === null) continue;
      sectors.push({ ...latest, name: sector.name, symbol: sector.symbol });
      const current = points.find((point) => point.date === window.asOf);
      const before = points.find((point) => point.date === previousDate);
      if (
        current !== undefined &&
        before !== undefined &&
        current.quadrant !== before.quadrant
      )
        changes.push({
          date: window.asOf,
          from: before.quadrant,
          name: sector.name,
          symbol: sector.symbol,
          to: current.quadrant,
        });
      for (const change of quadrantChanges(points))
        recent.push({ ...change, name: sector.name, symbol: sector.symbol });
    }
    recent.sort(
      (a, b) => b.date.localeCompare(a.date) || a.symbol.localeCompare(b.symbol)
    );
    return {
      asOf: window.asOf,
      benchmark: SECTOR_ROTATION_BENCHMARK,
      changes,
      previousDate,
      recentTransitions: recent.slice(
        0,
        SECTOR_ROTATION_SNAPSHOT_MAX_TRANSITIONS
      ),
      schemaVersion: SECTOR_ROTATION_SNAPSHOT_VERSION,
      sectors,
      timeframe: input.timeframe,
    };
  });

export const sectorRotationRouter = { collect, map, snapshot };
