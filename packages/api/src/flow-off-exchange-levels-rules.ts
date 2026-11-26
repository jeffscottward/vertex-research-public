// What: pure bucketing, clustering, ranking, and FINRA weekly folding rules for
// flow.offExchangeLevels (flow-off-exchange-levels.v1). Zero I/O, deterministic.
// Used by: packages/api/src/server/flow-off-exchange-levels.ts and apps/web view-models.
// Research only: describes stored sampled FINRA TRF prints and lagged FINRA weekly OTC shares.
import {
  FLOW_OFF_EXCHANGE_MAX_BARS,
  FLOW_OFF_EXCHANGE_MAX_FINRA_WEEKS,
  FLOW_OFF_EXCHANGE_MAX_LEVELS,
  FLOW_OFF_EXCHANGE_MAX_PRINTS,
  FLOW_OFF_EXCHANGE_RULES_VERSION,
  type FlowDirection,
  type FlowOffExchangeBar,
  type FlowOffExchangeBucketMinutes,
  type FlowOffExchangeFinraWeek,
  type FlowOffExchangeLevel,
  type FlowOffExchangeLevelsRules,
  type FlowOffExchangePrint,
  type FlowOffExchangeRange,
  type FlowOffExchangeTotals,
} from "./contracts/flow.ts";
import { FLOW_INSTRUMENTS } from "./flow-features.ts";
import { newYorkClock } from "./signal-alerts.ts";

/** Regular US equity session in New York minutes from midnight: [09:30, 16:00). */
const SESSION_OPEN_MINUTE = 9 * 60 + 30;
const SESSION_CLOSE_MINUTE = 16 * 60;
const CLUSTER_EPSILON = 1e-9;

export const OFF_EXCHANGE_READ_CAP = 2000;
export const OFF_EXCHANGE_FINRA_LOOKBACK_DAYS = 120;

export const OFF_EXCHANGE_LEVELS_RULES: FlowOffExchangeLevelsRules =
  Object.freeze({
    capture: "sampled",
    clusterStep: 0.25,
    finraMaxWeeks: FLOW_OFF_EXCHANGE_MAX_FINRA_WEEKS,
    maxLevels: FLOW_OFF_EXCHANGE_MAX_LEVELS,
    maxPrints: FLOW_OFF_EXCHANGE_MAX_PRINTS,
    minPrintShares: FLOW_INSTRUMENTS.SPY.largePrint,
    readCap: OFF_EXCHANGE_READ_CAP,
    version: FLOW_OFF_EXCHANGE_RULES_VERSION,
  });

export type OffExchangeRangeConfig = Readonly<{
  bucketMinutes: FlowOffExchangeBucketMinutes;
  calendarLookbackDays: number;
  maxSessions: number;
}>;

export const OFF_EXCHANGE_RANGE_CONFIG: Readonly<
  Record<FlowOffExchangeRange, OffExchangeRangeConfig>
> = Object.freeze({
  "1d": { bucketMinutes: 1, calendarLookbackDays: 1, maxSessions: 1 },
  "5d": { bucketMinutes: 5, calendarLookbackDays: 8, maxSessions: 5 },
  "14d": { bucketMinutes: 15, calendarLookbackDays: 14, maxSessions: 10 },
});

export type OffExchangeMinuteRow = Readonly<{
  minute: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  vwap: number;
  volume: number;
  offExchangeVolume: number;
  coveredSeconds: number;
}>;

export type OffExchangeEventRow = Readonly<{
  key: string;
  at: Date;
  direction: FlowDirection;
  price: number | null;
  size: number | null;
}>;

export type OffExchangeFinraRow = Readonly<{
  weekStart: string;
  venue: "ats" | "non_ats";
  shares: number;
  trades: number;
  tier: string | null;
  lastUpdated: string | null;
}>;

export type OffExchangeFoldInput = Readonly<{
  range: FlowOffExchangeRange;
  minutes: readonly OffExchangeMinuteRow[];
  events: readonly OffExchangeEventRow[];
  finraRows: readonly OffExchangeFinraRow[];
  truncated: boolean;
}>;

export type OffExchangeFoldOutput = Readonly<{
  bucketMinutes: FlowOffExchangeBucketMinutes;
  sessions: string[];
  latestPrice: number | null;
  latestPriceAt: string | null;
  bars: FlowOffExchangeBar[];
  prints: FlowOffExchangePrint[];
  levels: FlowOffExchangeLevel[];
  totals: FlowOffExchangeTotals;
  finraWeekly: FlowOffExchangeFinraWeek[];
}>;

const isPositiveFinite = (value: number | null): value is number =>
  value !== null && Number.isFinite(value) && value > 0;

const nonNegativeFinite = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, value) : 0;

const clampUnit = (value: number): number => Math.min(1, Math.max(0, value));
const dominantDirectionOf = (
  buyShares: number,
  sellShares: number,
  totalShares: number
): FlowDirection => {
  const threshold = totalShares * 0.5;
  if (buyShares > sellShares && buyShares >= threshold) return "bullish";
  if (sellShares > buyShares && sellShares >= threshold) return "bearish";
  return "neutral";
};

interface BarAccumulator {
  close: number;
  coveredSeconds: number;
  high: number;
  low: number;
  offExchangeVolume: number;
  open: number;
  session: string;
  slotIndex: number;
  startMs: number;
  volume: number;
  vwapWeighted: number;
}

interface BucketedBars {
  bars: FlowOffExchangeBar[];
  coveredSeconds: number;
  latestPrice: number | null;
  latestPriceAt: string | null;
  sampledOffExchangeShare: number | null;
  sampledOffExchangeVolume: number;
  sampledVolume: number;
  sessions: string[];
}

const bucketMinutesRows = (
  rows: readonly OffExchangeMinuteRow[],
  bucketMinutes: FlowOffExchangeBucketMinutes,
  maxSessions: number
): BucketedBars => {
  const ordered = [...rows]
    .filter(
      (row) =>
        isPositiveFinite(row.open) &&
        isPositiveFinite(row.high) &&
        isPositiveFinite(row.low) &&
        isPositiveFinite(row.close) &&
        isPositiveFinite(row.vwap)
    )
    .sort((a, b) => a.minute.getTime() - b.minute.getTime());

  const tagged: Readonly<{
    row: OffExchangeMinuteRow;
    session: string;
    minuteOfDay: number;
  }>[] = [];
  const allSessions = new Set<string>();
  for (const row of ordered) {
    const ny = newYorkClock(row.minute);
    const minuteOfDay = ny.minute;
    if (
      minuteOfDay < SESSION_OPEN_MINUTE ||
      minuteOfDay >= SESSION_CLOSE_MINUTE
    )
      continue;
    tagged.push({ minuteOfDay, row, session: ny.day });
    allSessions.add(ny.day);
  }

  const sessions = [...allSessions].sort().slice(-maxSessions);
  const keptSessions = new Set(sessions);
  const possibleSeconds = bucketMinutes * 60;
  const buckets = new Map<string, BarAccumulator>();
  let sampledVolume = 0;
  let sampledOffExchangeVolume = 0;
  let totalCovered = 0;

  for (const entry of tagged) {
    if (!keptSessions.has(entry.session)) continue;
    const { row, session, minuteOfDay } = entry;
    const offset = minuteOfDay - SESSION_OPEN_MINUTE;
    const slotIndex = Math.floor(offset / bucketMinutes);
    const slotOffsetMinutes = offset % bucketMinutes;
    const startMs = row.minute.getTime() - slotOffsetMinutes * 60_000;
    const key = `${session}:${slotIndex}`;
    const vol = nonNegativeFinite(row.volume);
    const offVol = nonNegativeFinite(row.offExchangeVolume);
    const covered = Math.min(
      60,
      Math.round(nonNegativeFinite(row.coveredSeconds))
    );
    sampledVolume += vol;
    sampledOffExchangeVolume += offVol;
    totalCovered += covered;

    const existing = buckets.get(key);
    if (existing === undefined) {
      buckets.set(key, {
        close: row.close,
        coveredSeconds: covered,
        high: row.high,
        low: row.low,
        offExchangeVolume: offVol,
        open: row.open,
        session,
        slotIndex,
        startMs,
        volume: vol,
        vwapWeighted: row.vwap * vol,
      });
    } else {
      existing.high = Math.max(existing.high, row.high);
      existing.low = Math.min(existing.low, row.low);
      existing.close = row.close;
      existing.volume += vol;
      existing.offExchangeVolume += offVol;
      existing.vwapWeighted += row.vwap * vol;
      existing.coveredSeconds += covered;
    }
  }

  const allBars: FlowOffExchangeBar[] = [...buckets.values()]
    .sort((a, b) => a.startMs - b.startMs)
    .map((acc) => ({
      close: acc.close,
      coveredSeconds: Math.min(possibleSeconds, acc.coveredSeconds),
      high: acc.high,
      low: acc.low,
      offExchangeShare:
        acc.volume > 0 ? clampUnit(acc.offExchangeVolume / acc.volume) : null,
      offExchangeVolume: acc.offExchangeVolume,
      open: acc.open,
      possibleSeconds,
      session: acc.session,
      start: new Date(acc.startMs).toISOString(),
      volume: acc.volume,
      vwap: acc.volume > 0 ? acc.vwapWeighted / acc.volume : acc.close,
    }));

  const bars = allBars.slice(-FLOW_OFF_EXCHANGE_MAX_BARS);
  const newest = bars.at(-1) ?? null;

  return {
    bars,
    coveredSeconds: totalCovered,
    latestPrice: newest?.close ?? null,
    latestPriceAt: newest?.start ?? null,
    sampledOffExchangeShare:
      sampledVolume > 0
        ? clampUnit(sampledOffExchangeVolume / sampledVolume)
        : null,
    sampledOffExchangeVolume,
    sampledVolume,
    sessions,
  };
};

interface LevelAccumulator {
  bandHigh: number;
  bandIndex: number;
  bandLow: number;
  buyShares: number;
  firstMs: number;
  lastMs: number;
  maxPrice: number;
  minPrice: number;
  neutralShares: number;
  prints: number;
  sellShares: number;
  totalNotional: number;
  totalShares: number;
}

// Distinct price bands with identical totalNotional must differ in totalShares because every
// price in a higher band strictly exceeds every price in a lower band.
const compareClusters = (a: LevelAccumulator, b: LevelAccumulator): number =>
  b.totalNotional - a.totalNotional || b.totalShares - a.totalShares;

export const foldFinraWeeklyContext = (
  rows: readonly OffExchangeFinraRow[],
  maxWeeks = FLOW_OFF_EXCHANGE_MAX_FINRA_WEEKS
): FlowOffExchangeFinraWeek[] => {
  const byWeek = new Map<
    string,
    {
      atsShares: number;
      atsTrades: number;
      nonAtsShares: number;
      nonAtsTrades: number;
      tier: string | null;
      lastUpdated: string | null;
    }
  >();

  for (const row of rows) {
    const entry = byWeek.get(row.weekStart) ?? {
      atsShares: 0,
      atsTrades: 0,
      lastUpdated: null,
      nonAtsShares: 0,
      nonAtsTrades: 0,
      tier: null,
    };
    const shares = nonNegativeFinite(row.shares);
    const trades = Math.round(nonNegativeFinite(row.trades));
    if (row.venue === "ats") {
      entry.atsShares += shares;
      entry.atsTrades += trades;
    } else {
      entry.nonAtsShares += shares;
      entry.nonAtsTrades += trades;
    }
    if (row.tier !== null && row.tier.length > 0) entry.tier = row.tier;
    if (
      row.lastUpdated !== null &&
      (entry.lastUpdated === null || row.lastUpdated > entry.lastUpdated)
    ) {
      entry.lastUpdated = row.lastUpdated;
    }
    byWeek.set(row.weekStart, entry);
  }

  return [...byWeek.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-maxWeeks)
    .map(([weekStart, week]) => {
      const totalShares = week.atsShares + week.nonAtsShares;
      return {
        atsShare:
          totalShares > 0 ? clampUnit(week.atsShares / totalShares) : null,
        atsShares: week.atsShares,
        atsTrades: week.atsTrades,
        avgAtsTradeSize:
          week.atsTrades > 0 && week.atsShares > 0
            ? week.atsShares / week.atsTrades
            : null,
        lastUpdated: week.lastUpdated,
        nonAtsShares: week.nonAtsShares,
        nonAtsTrades: week.nonAtsTrades,
        tier: week.tier,
        totalShares,
        weekStart,
      };
    });
};

export const foldOffExchangeLevels = (
  input: OffExchangeFoldInput
): OffExchangeFoldOutput => {
  const config = OFF_EXCHANGE_RANGE_CONFIG[input.range];
  const barResult = bucketMinutesRows(
    input.minutes,
    config.bucketMinutes,
    config.maxSessions
  );
  const allowedSessions = new Set(barResult.sessions);
  const step = OFF_EXCHANGE_LEVELS_RULES.clusterStep;

  const validPrints = [...input.events]
    .filter(
      (event): event is OffExchangeEventRow & { price: number; size: number } =>
        isPositiveFinite(event.price) &&
        isPositiveFinite(event.size) &&
        Number.isFinite(event.price * event.size)
    )
    .map((event) => {
      const ny = newYorkClock(event.at);
      return {
        at: event.at,
        direction: event.direction,
        key: event.key,
        minuteOfDay: ny.minute,
        notional: event.price * event.size,
        price: event.price,
        session: ny.day,
        size: event.size,
      };
    })
    .filter(
      (item) =>
        item.minuteOfDay >= SESSION_OPEN_MINUTE &&
        item.minuteOfDay < SESSION_CLOSE_MINUTE &&
        (allowedSessions.size === 0 || allowedSessions.has(item.session))
    )
    .sort(
      (a, b) => a.at.getTime() - b.at.getTime() || a.key.localeCompare(b.key)
    );
  const clusters = new Map<number, LevelAccumulator>();
  let totalShares = 0;
  let totalNotional = 0;
  let buyShares = 0;
  let sellShares = 0;
  let neutralShares = 0;

  for (const item of validPrints) {
    totalShares += item.size;
    totalNotional += item.notional;
    if (item.direction === "bullish") buyShares += item.size;
    else if (item.direction === "bearish") sellShares += item.size;
    else neutralShares += item.size;

    const bandIndex = Math.floor(item.price / step + CLUSTER_EPSILON);
    const ms = item.at.getTime();
    const existing = clusters.get(bandIndex);
    if (existing === undefined) {
      clusters.set(bandIndex, {
        bandHigh: Math.round((bandIndex + 1) * step * 100) / 100,
        bandIndex,
        bandLow: Math.round(bandIndex * step * 100) / 100,
        buyShares: item.direction === "bullish" ? item.size : 0,
        firstMs: ms,
        lastMs: ms,
        maxPrice: item.price,
        minPrice: item.price,
        neutralShares: item.direction === "neutral" ? item.size : 0,
        prints: 1,
        sellShares: item.direction === "bearish" ? item.size : 0,
        totalNotional: item.notional,
        totalShares: item.size,
      });
    } else {
      existing.totalShares += item.size;
      existing.totalNotional += item.notional;
      existing.prints += 1;
      existing.minPrice = Math.min(existing.minPrice, item.price);
      existing.maxPrice = Math.max(existing.maxPrice, item.price);
      existing.firstMs = Math.min(existing.firstMs, ms);
      existing.lastMs = Math.max(existing.lastMs, ms);
      if (item.direction === "bullish") existing.buyShares += item.size;
      else if (item.direction === "bearish") existing.sellShares += item.size;
      else existing.neutralShares += item.size;
    }
  }

  const ranked = [...clusters.values()].sort(compareClusters);
  const topClusters = ranked.slice(0, FLOW_OFF_EXCHANGE_MAX_LEVELS);
  const bandToLevelIndex = new Map<number, number>(
    topClusters.map((cluster, index) => [cluster.bandIndex, index])
  );

  const levels: FlowOffExchangeLevel[] = topClusters.map((cluster, index) => {
    const price = cluster.totalNotional / cluster.totalShares;
    const distanceFromSpot =
      barResult.latestPrice === null ? null : price - barResult.latestPrice;
    const distancePct =
      barResult.latestPrice === null || distanceFromSpot === null
        ? null
        : distanceFromSpot / barResult.latestPrice;
    return {
      bandHigh: cluster.bandHigh,
      bandLow: cluster.bandLow,
      buyShares: cluster.buyShares,
      distanceFromSpot,
      distancePct,
      dominantDirection: dominantDirectionOf(
        cluster.buyShares,
        cluster.sellShares,
        cluster.totalShares
      ),
      firstAt: new Date(cluster.firstMs).toISOString(),
      lastAt: new Date(cluster.lastMs).toISOString(),
      maxPrice: cluster.maxPrice,
      minPrice: cluster.minPrice,
      neutralShares: cluster.neutralShares,
      price,
      prints: cluster.prints,
      rank: index + 1,
      sellShares: cluster.sellShares,
      totalNotional: cluster.totalNotional,
      totalShares: cluster.totalShares,
    };
  });

  const keptPrints = validPrints.slice(-FLOW_OFF_EXCHANGE_MAX_PRINTS);
  const omittedPrints = validPrints.length - keptPrints.length;
  const prints: FlowOffExchangePrint[] = keptPrints.map((item) => {
    const bandIndex = Math.floor(item.price / step + CLUSTER_EPSILON);
    return {
      at: item.at.toISOString(),
      direction: item.direction,
      key: item.key,
      levelIndex: bandToLevelIndex.get(bandIndex) ?? null,
      notional: item.notional,
      price: item.price,
      session: item.session,
      size: item.size,
    };
  });

  return {
    bars: barResult.bars,
    bucketMinutes: config.bucketMinutes,
    finraWeekly: foldFinraWeeklyContext(input.finraRows),
    latestPrice: barResult.latestPrice,
    latestPriceAt: barResult.latestPriceAt,
    levels,
    prints,
    sessions: barResult.sessions,
    totals: {
      barsCount: barResult.bars.length,
      buyShares,
      coveredSeconds: barResult.coveredSeconds,
      neutralShares,
      omittedLevels: Math.max(0, ranked.length - levels.length),
      omittedPrints,
      prints: validPrints.length,
      sampledOffExchangeShare: barResult.sampledOffExchangeShare,
      sampledOffExchangeVolume: barResult.sampledOffExchangeVolume,
      sampledVolume: barResult.sampledVolume,
      sellShares,
      totalClusterCount: ranked.length,
      totalNotional,
      totalShares,
      truncated: input.truncated,
    },
  };
};
