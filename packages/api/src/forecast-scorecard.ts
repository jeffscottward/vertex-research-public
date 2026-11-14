// Forecast scorecard: direction score for dated probability forecasts (pure, no I/O, no clock).
//
// Spec: docs/specs/research/forecast-scorecard.md (status rule, label, baselines, interval).
// Method adapted from calibrain-harness (https://github.com/zadescoxp/calibrain-harness, MIT,
// commit d9a3a62d1e64bfd28514e07ce6d300ec44654ddb): an outcome label for every forecast, a
// comparison with the instrument's own base rates, non-overlapping windows and a bootstrap
// status. Ideas only; no upstream code is copied. See NOTICE and licenses/calibrain-harness-MIT.txt.
//
// Research only. A result is information. Nothing here creates, sizes, sends or blocks an order,
// and nothing here evaluates the final order gate.

import { z } from "zod";

import { at, quantile, sorted } from "./quant-arrays.ts";
import { stationaryResample } from "./quant-significance.ts";

const FORECAST_SCORECARD_VERSION = "1";
const FORECAST_LABEL_RULE_VERSION = "direction-sign-v1";
// Same classes as JEV_STANCES (contracts/jev-verdict.ts); a test pins the two tuples.
export const FORECAST_CLASSES = ["BULLISH", "NEUTRAL", "BEARISH"] as const;
export const FORECAST_SYMBOL_PATTERN = /^[A-Z][A-Z0-9.]{0,11}$/u;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/u;
// The form Date.toISOString() writes; text order equals time order.
const UTC_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

export const ForecastRecordSchema = z
  .object({
    // Date of the last bar the forecaster saw (the decision bar); null = none reported.
    dataAsOf: z.string().regex(ISO_DAY).nullable(),
    decidedAt: z.string().regex(UTC_INSTANT).nullable(),
    model: z.string().max(200).nullable(),
    // Raw values. The range is checked by the status rule, not here.
    probabilities: z
      .object({
        BEARISH: z.number(),
        BULLISH: z.number(),
        NEUTRAL: z.number(),
      })
      .strict(),
    schemaVersion: z.literal(1),
    source: z.string().min(1).max(64),
    sourceVersion: z.string().max(64).nullable(),
    symbol: z.string().regex(FORECAST_SYMBOL_PATTERN),
  })
  .strict();
export type ForecastRecord = Readonly<z.infer<typeof ForecastRecordSchema>>;

/** Validates the shape of a record list. A shape error is a caller error: it throws. */
export const parseForecastRecords = (input: unknown): ForecastRecord[] =>
  z.array(ForecastRecordSchema).parse(input);

// In rule order: the first condition that holds gives the status.
export const FORECAST_STATUSES = [
  "BAD_PROBABILITIES",
  "NO_BARS",
  "NO_DECISION_BAR",
  "DUPLICATE",
  "SHORT_HISTORY",
  "PENDING_OUTCOME",
  "FLAT_OUTCOME",
  "OVERLAP",
  "SCORED",
] as const;
export type ForecastStatus = (typeof FORECAST_STATUSES)[number];

export type ScorecardParams = Readonly<{
  horizonBars: number;
  priorMinWindows: number;
  sumTolerance: number;
  minClusters: number;
  resamples: number;
  intervalLow: number;
  intervalHigh: number;
  blockLength: number;
}>;
export const DEFAULT_SCORECARD_PARAMS: ScorecardParams = {
  blockLength: 2,
  horizonBars: 10,
  intervalHigh: 0.95,
  intervalLow: 0.05,
  minClusters: 30,
  priorMinWindows: 250,
  resamples: 2000,
  sumTolerance: 0.02,
};

/** Ascending unique ISO dates and one finite price above 0 per date (caller guarantees it). */
export type SymbolBars = Readonly<{
  dates: readonly string[];
  prices: readonly number[];
}>;

const DAY_MS = 86_400_000;
const FIRST_MONDAY_MS = Date.UTC(1970, 0, 5);

/** Monday-to-Friday days from Monday 1970-01-05; Saturday and Sunday count as the Friday before. */
export const weekdayNumber = (date: string): number => {
  const days = Math.round(
    (Date.parse(`${date}T00:00:00Z`) - FIRST_MONDAY_MS) / DAY_MS
  );
  const week = Math.floor(days / 7);
  return week * 5 + Math.min(days - week * 7, 4);
};

export type ForecastRow = Readonly<{
  status: ForecastStatus;
  symbol: string;
  dataAsOf: string | null;
  // Non-null exactly for SCORED.
  scored: null | Readonly<{
    pUp: number;
    prior: number;
    outcome: 0 | 1;
    cluster: number;
  }>;
}>;

type SymbolTable = Readonly<{
  index: ReadonlyMap<string, number>;
  // cumulative[k] = counts over the windows that start at bars 0..k-1.
  ups: readonly number[];
  moved: readonly number[];
}>;

const symbolTable = (bars: SymbolBars, horizon: number): SymbolTable => {
  const ups = [0];
  const moved = [0];
  for (let start = 0; start + horizon < bars.prices.length; start += 1) {
    const from = at(bars.prices, start);
    const to = at(bars.prices, start + horizon);
    ups.push(at(ups, start) + Number(to > from));
    moved.push(at(moved, start) + Number(to !== from));
  }
  return {
    index: new Map(bars.dates.map((date, position) => [date, position])),
    moved,
    ups,
  };
};

const validProbabilities = (
  probabilities: ForecastRecord["probabilities"]
): boolean => {
  const values = FORECAST_CLASSES.map((name) => probabilities[name]);
  return (
    values.every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 1
    ) && values.reduce((total, value) => total + value, 0) > 0
  );
};

// Text order with null last.
const compareText = (left: string | null, right: string | null): number => {
  if (left === right) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return left < right ? -1 : 1;
};

/** The status rule of the spec: one row per record, in input order. */
export const classifyForecasts = (
  records: readonly ForecastRecord[],
  barsBySymbol: ReadonlyMap<string, SymbolBars>,
  params: ScorecardParams
): ForecastRow[] => {
  const horizon = params.horizonBars;
  const tables = new Map<string, SymbolTable>();
  const seen = new Set<string>();
  const lastScored = new Map<string, number>();

  type Located = Readonly<{
    bars: SymbolBars;
    table: SymbolTable;
    decision: number;
    dataAsOf: string;
  }>;

  // Statuses 1 to 4, or the decision bar.
  const locate = (record: ForecastRecord): ForecastStatus | Located => {
    if (!validProbabilities(record.probabilities)) return "BAD_PROBABILITIES";
    const bars = barsBySymbol.get(record.symbol);
    if (bars === undefined) return "NO_BARS";
    const table = tables.get(record.symbol) ?? symbolTable(bars, horizon);
    tables.set(record.symbol, table);
    const { dataAsOf } = record;
    if (dataAsOf === null) return "NO_DECISION_BAR";
    const decision = table.index.get(dataAsOf);
    if (decision === undefined) return "NO_DECISION_BAR";
    const key = `${record.symbol}|${dataAsOf}`;
    if (seen.has(key)) return "DUPLICATE";
    seen.add(key);
    return { bars, dataAsOf, decision, table };
  };

  // Statuses 5 to 9.
  const settle = (
    record: ForecastRecord,
    { bars, dataAsOf, decision, table }: Located
  ): Pick<ForecastRow, "status" | "scored"> => {
    const without = (status: ForecastStatus) => ({ scored: null, status });
    // Earlier windows that ended on or before the decision bar: starts 0..decision - horizon.
    const earlier = Math.max(0, decision - horizon + 1);
    const moved = at(table.moved, earlier);
    if (moved < params.priorMinWindows) return without("SHORT_HISTORY");
    if (decision + horizon >= bars.prices.length)
      return without("PENDING_OUTCOME");
    const from = at(bars.prices, decision);
    const to = at(bars.prices, decision + horizon);
    // The outcome is the sign of ln(to / from).
    if (to === from) return without("FLAT_OUTCOME");
    const previous = lastScored.get(record.symbol);
    if (previous !== undefined && decision - previous < horizon)
      return without("OVERLAP");
    lastScored.set(record.symbol, decision);
    const { BULLISH, BEARISH } = record.probabilities;
    const directional = BULLISH + BEARISH;
    return {
      scored: {
        cluster: Math.floor(weekdayNumber(dataAsOf) / horizon),
        outcome: to > from ? 1 : 0,
        prior: (at(table.ups, earlier) + 1) / (moved + 2),
        pUp: directional === 0 ? 0.5 : BULLISH / directional,
      },
      status: "SCORED",
    };
  };

  const order = records
    .map((_, position) => position)
    .sort((left, right) => {
      const a = at(records, left);
      const b = at(records, right);
      return (
        compareText(a.symbol, b.symbol) ||
        compareText(a.dataAsOf, b.dataAsOf) ||
        compareText(a.decidedAt, b.decidedAt) ||
        left - right
      );
    });
  const rows = new Map<number, ForecastRow>();
  for (const position of order) {
    const record = at(records, position);
    const located = locate(record);
    rows.set(position, {
      dataAsOf: record.dataAsOf,
      symbol: record.symbol,
      ...(typeof located === "string"
        ? { scored: null, status: located }
        : settle(record, located)),
    });
  }
  return records.map((_, position) => rows.get(position) as ForecastRow);
};

export type ForecastLedger = Readonly<{
  read: number;
  byStatus: Readonly<Record<ForecastStatus, number>>;
  // Keys in sorted order.
  bySymbol: Readonly<Record<string, Readonly<Record<ForecastStatus, number>>>>;
  // Records (not BAD_PROBABILITIES) whose probabilities sum to more than sumTolerance away from 1.
  sumOffTolerance: number;
  maxSumDeviation: number;
}>;

const emptyCounts = (): Record<ForecastStatus, number> =>
  Object.fromEntries(FORECAST_STATUSES.map((status) => [status, 0])) as Record<
    ForecastStatus,
    number
  >;

const ledgerOf = (
  records: readonly ForecastRecord[],
  rows: readonly ForecastRow[],
  params: ScorecardParams
): ForecastLedger => {
  const byStatus = emptyCounts();
  const bySymbol = new Map<string, Record<ForecastStatus, number>>();
  let sumOffTolerance = 0;
  let maxSumDeviation = 0;
  rows.forEach((row, position) => {
    byStatus[row.status] += 1;
    const counts = bySymbol.get(row.symbol) ?? emptyCounts();
    counts[row.status] += 1;
    bySymbol.set(row.symbol, counts);
    if (row.status === "BAD_PROBABILITIES") return;
    const { BULLISH, NEUTRAL, BEARISH } = at(records, position).probabilities;
    const deviation = Math.abs(BULLISH + NEUTRAL + BEARISH - 1);
    sumOffTolerance += Number(deviation > params.sumTolerance);
    maxSumDeviation = Math.max(maxSumDeviation, deviation);
  });
  return {
    byStatus,
    bySymbol: Object.fromEntries(
      [...bySymbol.entries()].sort(([left], [right]) =>
        compareText(left, right)
      )
    ),
    maxSumDeviation,
    read: rows.length,
    sumOffTolerance,
  };
};

export type ForecastSkillStatus =
  | "NOT_ENOUGH_DATA"
  | "SKILL"
  | "WORSE_THAN_BASELINE"
  | "UNDECIDED";

export type ForecastScore = Readonly<{
  scored: number;
  clusters: number;
  minClusters: number;
  // The three blocks are null exactly when no window is scored.
  brier: null | Readonly<{ forecast: number; half: number; prior: number }>;
  // 1 - Brier(forecast) / Brier(baseline); best = against the baseline with the lower Brier.
  skill: null | Readonly<{ half: number; prior: number; best: number }>;
  interval: null | Readonly<{
    low: number;
    high: number;
    halfWidth: number;
    resamples: number;
  }>;
  skillStatus: ForecastSkillStatus;
  // Counts only; they never set skillStatus.
  hits: Readonly<{
    sided: number;
    forecastHits: number;
    priorHits: number;
    wins: number;
    losses: number;
  }>;
}>;

type Sums = Readonly<{
  count: number;
  forecast: number;
  half: number;
  prior: number;
}>;
const NO_SUMS: Sums = { count: 0, forecast: 0, half: 0, prior: 0 };
const addSums = (left: Sums, right: Sums): Sums => ({
  count: left.count + right.count,
  forecast: left.forecast + right.forecast,
  half: left.half + right.half,
  prior: left.prior + right.prior,
});
// Both baseline sums are above 0 for a non-empty set: 0.25 per window, and a prior inside (0, 1).
const bestSkill = (sums: Sums): number =>
  1 - sums.forecast / Math.min(sums.half, sums.prior);

const skillStatusOf = (
  clusters: number,
  minClusters: number,
  low: number,
  high: number
): ForecastSkillStatus => {
  if (clusters < minClusters) return "NOT_ENOUGH_DATA";
  if (low > 0) return "SKILL";
  return high < 0 ? "WORSE_THAN_BASELINE" : "UNDECIDED";
};

/** Brier scores, skill, the cluster bootstrap and the status for the SCORED rows. */
export const scoreWindows = (
  rows: readonly ForecastRow[],
  params: ScorecardParams,
  random: () => number
): ForecastScore => {
  const byCluster = new Map<number, Sums>();
  const hits = {
    forecastHits: 0,
    losses: 0,
    priorHits: 0,
    sided: 0,
    wins: 0,
  };
  for (const { scored } of rows) {
    if (scored === null) continue;
    const { cluster, outcome, pUp, prior } = scored;
    byCluster.set(
      cluster,
      addSums(byCluster.get(cluster) ?? NO_SUMS, {
        count: 1,
        forecast: (pUp - outcome) ** 2,
        half: 0.25,
        prior: (prior - outcome) ** 2,
      })
    );
    const truth = outcome === 1 ? 1 : -1;
    const forecastRight = Math.sign(pUp - 0.5) === truth;
    const priorRight = Math.sign(prior - 0.5) === truth;
    hits.sided += Number(pUp !== 0.5);
    hits.forecastHits += Number(forecastRight);
    hits.priorHits += Number(priorRight);
    hits.wins += Number(forecastRight && !priorRight);
    hits.losses += Number(priorRight && !forecastRight);
  }
  // Clusters in time order.
  const clusters = [...byCluster.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, sums]) => sums);
  const total = clusters.reduce(addSums, NO_SUMS);
  if (total.count === 0) {
    return {
      brier: null,
      clusters: 0,
      hits,
      interval: null,
      minClusters: params.minClusters,
      scored: 0,
      skill: null,
      skillStatus: "NOT_ENOUGH_DATA",
    };
  }
  const positions = clusters.map((_, position) => position);
  const draws = sorted(
    Array.from({ length: params.resamples }, () =>
      bestSkill(
        stationaryResample(positions, params.blockLength, random)
          .map((position) => at(clusters, position))
          .reduce(addSums, NO_SUMS)
      )
    )
  );
  const low = quantile(draws, params.intervalLow);
  const high = quantile(draws, params.intervalHigh);
  return {
    brier: {
      forecast: total.forecast / total.count,
      half: total.half / total.count,
      prior: total.prior / total.count,
    },
    clusters: clusters.length,
    hits,
    interval: {
      halfWidth: (high - low) / 2,
      high,
      low,
      resamples: params.resamples,
    },
    minClusters: params.minClusters,
    scored: total.count,
    skill: {
      best: bestSkill(total),
      half: 1 - total.forecast / total.half,
      prior: 1 - total.forecast / total.prior,
    },
    skillStatus: skillStatusOf(clusters.length, params.minClusters, low, high),
  };
};

export type ForecastScorecard = Readonly<{
  version: string;
  labelRuleVersion: string;
  // null for an empty record list.
  source: string | null;
  params: ScorecardParams;
  ledger: ForecastLedger;
  score: ForecastScore;
}>;

/**
 * Scores the records of one source. `random` is used only by the bootstrap. Preconditions: the
 * records have the schema shape, the bars have the SymbolBars shape, params are positive.
 */
export const scoreForecasts = (
  records: readonly ForecastRecord[],
  barsBySymbol: ReadonlyMap<string, SymbolBars>,
  params: ScorecardParams,
  random: () => number
): ForecastScorecard => {
  if (new Set(records.map((record) => record.source)).size > 1)
    throw new RangeError("Forecast records must share one source");
  const rows = classifyForecasts(records, barsBySymbol, params);
  return {
    labelRuleVersion: FORECAST_LABEL_RULE_VERSION,
    ledger: ledgerOf(records, rows, params),
    params,
    score: scoreWindows(rows, params, random),
    source: records[0]?.source ?? null,
    version: FORECAST_SCORECARD_VERSION,
  };
};
