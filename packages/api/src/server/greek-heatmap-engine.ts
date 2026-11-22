// What: pure strike-by-expiry Greek exposure heatmap engine (GEX, VEX, Charm, DEX and
// Volume-GEX) with king node, call/put walls and per-expiry spot-sweep gamma flip.
// Reuses zero-rate Black-Scholes Greeks from gex-context.ts and chain helpers from
// options-analytics-engine.ts. Pure math, no I/O, research-only estimates.

import type {
  GreekHeatmapExpiry,
  GreekHeatmapMarks,
  GreekHeatmapMetricData,
  GreekHeatmapOutput,
  GreekHeatmapRow,
  GreekHeatmapStatus,
} from "../contracts/options-analytics.ts";
import { callGreeks } from "./gex-context.ts";
import {
  type ChainRow,
  daysUntil,
  termStructure,
} from "./options-analytics-engine.ts";

const DAYS_PER_YEAR = 365;
const FLIP_RANGE = 0.3;
const FLIP_STEPS = 120;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const RANGE_MIN = 0.5;
const RANGE_MAX = 1.5;

export const MAX_HEATMAP_EXPIRIES = 10;
export const MAX_HEATMAP_STRIKES = 25;

const GREEK_HEATMAP_NOTES = [
  "GEX, VEX, Charm and Volume-GEX assume dealers are long calls and short puts; DEX uses holders' net delta (calls +, puts -).",
  "Each expiry-strike cell uses that expiry's own days to expiry (0 DTE floored at 0.5 days) and QuantData IV (zero rate, expiry ATM IV fallback).",
  "Gamma flip sweeps spot +/-30% across the shown expiries with fixed IV; walls and king rank net exposure across those expiries.",
  "Research view only. Estimates are not observed dealer positions or trade signals.",
] as const;

export type ExpiryStrikeCounts = Readonly<{
  expiry: string;
  strike: number;
  callCount: number;
  putCount: number;
}>;

type ExpiryIvModel = Readonly<{
  years: number;
  ivAt: (strike: number, right: "call" | "put") => number;
}>;

type PricedCell = Readonly<{
  expiry: string;
  strike: number;
  callCount: number;
  putCount: number;
  callIv: number | null;
  putIv: number | null;
  years: number;
  gex: number;
  vex: number;
  charm: number;
  dex: number;
}>;

const toNumber = (value: unknown): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

const entries = (value: unknown): [string, unknown][] =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.entries(value)
    : [];

const nonNegCount = (cell: unknown, key: string): number => {
  if (typeof cell !== "object" || cell === null || Array.isArray(cell))
    return 0;
  const num = toNumber((cell as Record<string, unknown>)[key]);
  return num === null ? 0 : Math.trunc(Math.abs(num));
};

/**
 * Parses a QuantData `/v1/options/tool/heat-map` contract payload (`NET_OPEN_INTEREST` or
 * `NET_VOLUME`): `{ "YYYY-MM-DD": { "<strike>": { callValue?, putValue? } } }`.
 * Keeps unexpired expiries (`expiry >= today`) and positive strikes with non-zero count.
 */
export const parseHeatMapCounts = (
  data: unknown,
  today: string
): ExpiryStrikeCounts[] => {
  const merged = new Map<
    string,
    { expiry: string; strike: number; callCount: number; putCount: number }
  >();
  for (const [expiry, strikes] of entries(data)) {
    if (!(ISO_DATE.test(expiry) && !Number.isNaN(Date.parse(expiry)))) continue;
    if (expiry < today) continue;
    for (const [strikeKey, cell] of entries(strikes)) {
      const strike = toNumber(strikeKey);
      if (strike === null || strike <= 0) continue;
      const callCount = nonNegCount(cell, "callValue");
      const putCount = nonNegCount(cell, "putValue");
      if (callCount === 0 && putCount === 0) continue;
      const key = `${expiry}|${strike}`;
      const existing = merged.get(key);
      if (existing === undefined) {
        merged.set(key, { callCount, expiry, putCount, strike });
      } else {
        existing.callCount += callCount;
        existing.putCount += putCount;
      }
    }
  }
  return [...merged.values()].sort(
    (a, b) => a.expiry.localeCompare(b.expiry) || a.strike - b.strike
  );
};

const buildExpiryIvMap = (
  chain: readonly ChainRow[],
  spot: number,
  today: string
): Map<string, ExpiryIvModel> => {
  const atmByExpiry = new Map(
    termStructure(chain, spot, today).map((point) => [
      point.expiry,
      point.atmIv,
    ])
  );
  const ivLookup = new Map<string, number>();
  // Walk in reverse so the first row of a duplicate strike wins.
  for (const row of [...chain].reverse()) {
    if (row.iv === null) continue;
    ivLookup.set(`${row.expiry}|${row.right}|${row.strike}`, row.iv);
  }
  const models = new Map<string, ExpiryIvModel>();
  for (const [expiry, atmIv] of atmByExpiry) {
    models.set(expiry, {
      ivAt: (strike, right) =>
        ivLookup.get(`${expiry}|${right}|${strike}`) ?? atmIv,
      years: Math.max(daysUntil(expiry, today), 0.5) / DAYS_PER_YEAR,
    });
  }
  return models;
};

const priceCell = (
  row: ExpiryStrikeCounts,
  model: ExpiryIvModel,
  spot: number
): PricedCell => {
  const callIv = row.callCount > 0 ? model.ivAt(row.strike, "call") : null;
  const putIv = row.putCount > 0 ? model.ivAt(row.strike, "put") : null;
  const call =
    callIv === null
      ? { charm: 0, delta: 0, gamma: 0, vanna: 0 }
      : callGreeks(spot, row.strike, callIv, model.years);
  const put =
    putIv === null
      ? { charm: 0, delta: 1, gamma: 0, vanna: 0 }
      : callGreeks(spot, row.strike, putIv, model.years);
  const calls = row.callCount * 100;
  const puts = row.putCount * 100;
  return {
    callCount: row.callCount,
    callIv,
    charm: ((calls * call.charm - puts * put.charm) * spot) / DAYS_PER_YEAR,
    dex: (calls * call.delta + puts * (put.delta - 1)) * spot,
    expiry: row.expiry,
    gex: (calls * call.gamma - puts * put.gamma) * spot * spot * 0.01,
    putCount: row.putCount,
    putIv,
    strike: row.strike,
    vex: (calls * call.vanna - puts * put.vanna) * spot * 0.01,
    years: model.years,
  };
};

const priceCounts = (
  counts: readonly ExpiryStrikeCounts[],
  ivByExpiry: ReadonlyMap<string, ExpiryIvModel>,
  spot: number
): PricedCell[] => {
  const low = spot * RANGE_MIN;
  const high = spot * RANGE_MAX;
  const priced: PricedCell[] = [];
  for (const row of counts) {
    if (row.strike < low || row.strike > high) continue;
    const model = ivByExpiry.get(row.expiry);
    if (model === undefined) continue;
    priced.push(priceCell(row, model, spot));
  }
  return priced;
};
const totalGexAt = (
  priced: readonly PricedCell[],
  trialSpot: number
): number => {
  let total = 0;
  for (const cell of priced) {
    const callGamma =
      cell.callIv === null
        ? 0
        : callGreeks(trialSpot, cell.strike, cell.callIv, cell.years).gamma;
    const putGamma =
      cell.putIv === null
        ? 0
        : callGreeks(trialSpot, cell.strike, cell.putIv, cell.years).gamma;
    total +=
      (cell.callCount * 100 * callGamma - cell.putCount * 100 * putGamma) *
      trialSpot *
      trialSpot *
      0.01;
  }
  return total;
};

/**
 * Per-expiry spot-sweep gamma flip: sweeps spot +/-30% in 120 steps with fixed IV and
 * each expiry's own time to expiry, returning the zero crossing nearest spot.
 */
export const perExpiryGexFlip = (
  priced: readonly PricedCell[],
  spot: number
): number | null => {
  if (priced.length === 0) return null;
  const low = spot * (1 - FLIP_RANGE);
  const step = (spot * 2 * FLIP_RANGE) / FLIP_STEPS;
  let best: number | null = null;
  let previous: Readonly<{ at: number; gex: number }> | null = null;
  let zeroAt: number | null = null;
  for (let index = 0; index <= FLIP_STEPS; index += 1) {
    const at = low + step * index;
    const gex = totalGexAt(priced, at);
    if (gex === 0) {
      if (previous !== null && zeroAt === null) zeroAt = at;
      continue;
    }
    if (previous !== null && previous.gex < 0 !== gex < 0) {
      const crossing =
        zeroAt ?? previous.at + (step * previous.gex) / (previous.gex - gex);
      if (best === null || Math.abs(crossing - spot) < Math.abs(best - spot))
        best = crossing;
    }
    previous = { at, gex };
    zeroAt = null;
  }
  return best;
};

const betterTie = (
  candidate: number,
  current: number,
  spot: number,
  preferLower: boolean
): boolean => {
  const diff = Math.abs(candidate - spot) - Math.abs(current - spot);
  if (diff !== 0) return diff < 0;
  return preferLower ? candidate < current : candidate > current;
};

export const computeMarks = (
  strikeTotals: ReadonlyMap<number, number>,
  spot: number,
  flip: number | null
): GreekHeatmapMarks => {
  let king: Readonly<{ strike: number; abs: number }> | null = null;
  let callWall: Readonly<{ strike: number; value: number }> | null = null;
  let putWall: Readonly<{ strike: number; value: number }> | null = null;
  for (const [strike, total] of strikeTotals) {
    const abs = Math.abs(total);
    if (
      abs > 0 &&
      (king === null ||
        abs > king.abs ||
        (abs === king.abs && betterTie(strike, king.strike, spot, false)))
    )
      king = { abs, strike };
    if (
      total > 0 &&
      (callWall === null ||
        total > callWall.value ||
        (total === callWall.value &&
          betterTie(strike, callWall.strike, spot, false)))
    )
      callWall = { strike, value: total };
    if (
      total < 0 &&
      (putWall === null ||
        total < putWall.value ||
        (total === putWall.value &&
          betterTie(strike, putWall.strike, spot, true)))
    )
      putWall = { strike, value: total };
  }
  return {
    callWall: callWall?.strike ?? null,
    flip,
    kingStrike: king?.strike ?? null,
    putWall: putWall?.strike ?? null,
  };
};

const selectDisplayEntries = (
  strikeTotals: ReadonlyMap<number, number>,
  spot: number,
  pinned: ReadonlySet<number>,
  maxStrikes: number
): [number, number][] => {
  const chosen = new Map<number, number>();
  for (const [strike, total] of strikeTotals) {
    if (pinned.has(strike)) chosen.set(strike, total);
  }
  const rest = [...strikeTotals.entries()]
    .filter(([strike]) => !chosen.has(strike))
    .sort(([a], [b]) => Math.abs(a - spot) - Math.abs(b - spot) || b - a);
  for (const [strike, total] of rest) {
    if (chosen.size >= maxStrikes) break;
    chosen.set(strike, total);
  }
  return [...chosen.entries()].sort(([a], [b]) => b - a);
};

const emptyMetric = (
  status: Exclude<GreekHeatmapStatus, "ok">,
  message: string
): GreekHeatmapMetricData => ({
  expiryTotals: [],
  grandTotal: null,
  marks: { callWall: null, flip: null, kingStrike: null, putWall: null },
  message,
  rows: [],
  status,
});

type ValueKey = "gex" | "vex" | "charm" | "dex";

const buildMetricFromBook = (
  priced: readonly PricedCell[],
  expiries: readonly GreekHeatmapExpiry[],
  spot: number,
  valueKey: ValueKey,
  flip: number | null,
  emptyMessage: string
): GreekHeatmapMetricData => {
  if (priced.length === 0) return emptyMetric("empty", emptyMessage);
  const strikeTotals = new Map<number, number>();
  const expirySums = new Map<string, number>();
  const cellValues = new Map<string, number>();
  let grandTotal = 0;
  for (const cell of priced) {
    const val = cell[valueKey];
    cellValues.set(`${cell.strike}|${cell.expiry}`, val);
    strikeTotals.set(cell.strike, (strikeTotals.get(cell.strike) ?? 0) + val);
    expirySums.set(cell.expiry, (expirySums.get(cell.expiry) ?? 0) + val);
    grandTotal += val;
  }
  const marks = computeMarks(strikeTotals, spot, flip);
  const pinned = new Set<number>(
    [marks.kingStrike, marks.callWall, marks.putWall].filter(
      (strike): strike is number => strike !== null
    )
  );
  const rows: GreekHeatmapRow[] = selectDisplayEntries(
    strikeTotals,
    spot,
    pinned,
    MAX_HEATMAP_STRIKES
  ).map(([strike, total]) => ({
    strike,
    total,
    values: expiries.map(
      ({ expiry }) => cellValues.get(`${strike}|${expiry}`) ?? null
    ),
  }));
  const expiryTotals = expiries.map(
    ({ expiry }) => expirySums.get(expiry) ?? null
  );
  return {
    expiryTotals,
    grandTotal,
    marks,
    message: null,
    rows,
    status: "ok",
  };
};

export type BuildGreekHeatmapInput = Readonly<{
  symbol: string;
  spot: number | null;
  today: string;
  receivedAt: string;
  chainRows: readonly ChainRow[];
  oiCounts: readonly ExpiryStrikeCounts[];
  volumeCounts: readonly ExpiryStrikeCounts[];
  chainFailure: string | null;
  oiFailure: string | null;
  volumeFailure: string | null;
  rateLimited: boolean;
  retryAfterSeconds: number | null;
}>;

const NO_SPOT_MESSAGE =
  "QuantData returned no spot price or option-chain IV for this symbol.";
const NO_OI_MESSAGE =
  "QuantData returned no per-expiry open interest with IV for this symbol.";
const NO_VOLUME_MESSAGE =
  "QuantData returned no per-expiry option volume with IV for this symbol.";
const NO_EXPIRIES_MESSAGE =
  "QuantData returned no unexpired per-expiry open interest or volume for this symbol.";

export const buildGreekHeatmap = (
  input: BuildGreekHeatmapInput
): GreekHeatmapOutput => {
  const base = {
    notes: [...GREEK_HEATMAP_NOTES],
    rateLimited: input.rateLimited,
    receivedAt: input.receivedAt,
    retryAfterSeconds: input.retryAfterSeconds,
    source: "quantdata" as const,
    spot: input.spot,
    symbol: input.symbol,
  };
  if (input.chainFailure !== null) {
    const failed = emptyMetric("failed", input.chainFailure);
    return {
      ...base,
      expiries: [],
      message: input.chainFailure,
      metrics: {
        charm: failed,
        dex: failed,
        gex: failed,
        vex: failed,
        volumeGex: failed,
      },
      status: "failed",
    };
  }
  const { spot } = input;
  if (spot === null || spot <= 0 || input.chainRows.length === 0) {
    const empty = emptyMetric("empty", NO_SPOT_MESSAGE);
    return {
      ...base,
      expiries: [],
      message: NO_SPOT_MESSAGE,
      metrics: {
        charm: empty,
        dex: empty,
        gex: empty,
        vex: empty,
        volumeGex: empty,
      },
      status: "empty",
    };
  }

  const allIvByExpiry = buildExpiryIvMap(input.chainRows, spot, input.today);
  const allExpiries = [
    ...new Set([
      ...input.oiCounts.map((row) => row.expiry),
      ...input.volumeCounts.map((row) => row.expiry),
    ]),
  ]
    .filter((expiry) => allIvByExpiry.has(expiry))
    .sort()
    .slice(0, MAX_HEATMAP_EXPIRIES);

  const expiries: GreekHeatmapExpiry[] = allExpiries.map((expiry) => ({
    dte: Math.max(0, daysUntil(expiry, input.today)),
    expiry,
  }));
  const expirySet = new Set(allExpiries);
  const ivByExpiry = new Map(
    [...allIvByExpiry].filter(([expiry]) => expirySet.has(expiry))
  );

  const oiPriced =
    input.oiFailure === null
      ? priceCounts(input.oiCounts, ivByExpiry, spot)
      : [];
  const volPriced =
    input.volumeFailure === null
      ? priceCounts(input.volumeCounts, ivByExpiry, spot)
      : [];
  const gexFlipLevel = perExpiryGexFlip(oiPriced, spot);
  const volFlipLevel = perExpiryGexFlip(volPriced, spot);

  const oiMetric = (
    key: ValueKey,
    flip: number | null
  ): GreekHeatmapMetricData =>
    input.oiFailure === null
      ? buildMetricFromBook(oiPriced, expiries, spot, key, flip, NO_OI_MESSAGE)
      : emptyMetric("failed", input.oiFailure);

  const volumeGex =
    input.volumeFailure === null
      ? buildMetricFromBook(
          volPriced,
          expiries,
          spot,
          "gex",
          volFlipLevel,
          NO_VOLUME_MESSAGE
        )
      : emptyMetric("failed", input.volumeFailure);

  const metrics = {
    charm: oiMetric("charm", null),
    dex: oiMetric("dex", null),
    gex: oiMetric("gex", gexFlipLevel),
    vex: oiMetric("vex", null),
    volumeGex,
  };

  const anyOk =
    metrics.gex.status === "ok" || metrics.volumeGex.status === "ok";
  const topStatus: GreekHeatmapStatus = anyOk
    ? "ok"
    : input.oiFailure !== null || input.volumeFailure !== null
      ? "failed"
      : "empty";
  const topMessage = anyOk
    ? null
    : (input.oiFailure ?? input.volumeFailure ?? NO_EXPIRIES_MESSAGE);

  return {
    ...base,
    expiries: anyOk ? expiries : [],
    message: topMessage,
    metrics,
    status: topStatus,
  };
};
