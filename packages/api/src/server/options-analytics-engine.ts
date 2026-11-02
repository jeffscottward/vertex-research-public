// Pure volatility, exposure and flow calculations (port of Gamma Forge market/service.py
// build_volatility/exposure/flow_dashboard_snapshot). Input is raw QuantData `data`
// values; every field is checked before use. No I/O, no clock reads.

import {
  IV_SKEW_TARGET_DELTAS,
  IV_SURFACE_MONEYNESS,
  type ExposureSection,
  type FlowEvent,
  type FlowSection,
  type VolatilitySection,
} from "../contracts/options-analytics.ts";

const DAY_MS = 86_400_000;
const SKEW_MAX_DELTA_DISTANCE = 18;
const SURFACE_STRIKE_TOLERANCE = 0.025;
const SURFACE_MAX_EXPIRIES = 12;
const MAX_IV = 5; // 500 %; larger values are provider artifacts on deep ITM rows.
const MAX_FLOW_EVENTS = 100;

export type ChainRow = Readonly<{
  expiry: string;
  strike: number;
  right: "call" | "put";
  delta: number | null;
  iv: number | null;
}>;

export type OpenInterestRow = Readonly<{
  strike: number;
  callOpenInterest: number;
  putOpenInterest: number;
}>;

const toNumber = (value: unknown): number | null => {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

const entries = (value: unknown): [string, unknown][] =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.entries(value)
    : [];

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? Reflect.get(value, key)
    : undefined;

// QuantData IV is in percent (42.8 = 42.8 %); values <= 5 are taken as decimals.
export const ivDecimal = (value: unknown): number | null => {
  const parsed = toNumber(value);
  if (parsed === null || parsed <= 0) return null;
  const decimal = parsed > 5 ? parsed / 100 : parsed;
  return decimal <= MAX_IV ? decimal : null;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export const daysUntil = (expiry: string, today: string): number =>
  Math.round(
    (Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) /
      DAY_MS
  );

// term-structure data: { "YYYY-MM-DD": { "<strike>": { CALL: {delta, iv}, PUT: {...} } } }.
// Keeps only expiries on or after `today`.
export const parseChain = (
  data: unknown,
  today: string
): { rows: ChainRow[]; expired: number } => {
  const rows: ChainRow[] = [];
  let expired = 0;
  for (const [expiry, strikes] of entries(data)) {
    if (!(ISO_DATE.test(expiry) && !Number.isNaN(Date.parse(expiry)))) continue;
    if (expiry < today) {
      expired += 1;
      continue;
    }
    for (const [strikeKey, sides] of entries(strikes)) {
      const strike = toNumber(strikeKey);
      if (strike === null || strike <= 0) continue;
      for (const [side, right] of [
        ["CALL", "call"],
        ["PUT", "put"],
      ] as const) {
        const values = field(sides, side);
        if (values === undefined || values === null) continue;
        const delta = toNumber(field(values, "delta"));
        rows.push({
          delta: delta !== null && delta >= -1 && delta <= 1 ? delta : null,
          expiry,
          iv: ivDecimal(field(values, "iv")),
          right,
          strike,
        });
      }
    }
  }
  rows.sort(
    (a, b) =>
      a.expiry.localeCompare(b.expiry) ||
      a.strike - b.strike ||
      a.right.localeCompare(b.right)
  );
  return { expired, rows };
};

// open-interest-by-strike data: { "<strike>": { callOpenInterest, putOpenInterest } }.
export const parseOpenInterest = (data: unknown): OpenInterestRow[] => {
  const rows: OpenInterestRow[] = [];
  for (const [strikeKey, cell] of entries(data)) {
    const strike = toNumber(strikeKey);
    if (strike === null || strike <= 0) continue;
    const call = Math.max(
      0,
      Math.trunc(toNumber(field(cell, "callOpenInterest")) ?? 0)
    );
    const put = Math.max(
      0,
      Math.trunc(toNumber(field(cell, "putOpenInterest")) ?? 0)
    );
    if (call === 0 && put === 0) continue;
    rows.push({ callOpenInterest: call, putOpenInterest: put, strike });
  }
  return rows.sort((a, b) => a.strike - b.strike);
};

const groupByExpiry = (rows: readonly ChainRow[]): Map<string, ChainRow[]> => {
  const groups = new Map<string, ChainRow[]>();
  for (const row of rows) {
    const list = groups.get(row.expiry) ?? [];
    list.push(row);
    groups.set(row.expiry, list);
  }
  return groups;
};

// ATM IV per expiry: the row closest to spot, with |delta| closest to 0.5 as tie-break weight.
export const termStructure = (
  rows: readonly ChainRow[],
  spot: number | null,
  today: string
): VolatilitySection["termStructure"] => {
  const points: VolatilitySection["termStructure"] = [];
  for (const [expiry, group] of groupByExpiry(rows)) {
    let best: { score: number; iv: number } | null = null;
    for (const row of group) {
      if (row.iv === null) continue;
      const distance = spot === null ? 0 : Math.abs(row.strike - spot);
      const deltaDistance =
        row.delta === null ? 1 : Math.abs(Math.abs(row.delta) - 0.5);
      const score = distance + deltaDistance;
      if (best === null || score < best.score) best = { iv: row.iv, score };
    }
    if (best !== null)
      points.push({
        atmIv: best.iv,
        dte: Math.max(0, daysUntil(expiry, today)),
        expiry,
      });
  }
  return points;
};

interface SkewCandidate {
  target: number;
  delta: number;
  distance: number;
  iv: number;
}

// The contract nearest one target delta (puts for negative targets), within the limit.
const skewCandidate = (
  group: readonly ChainRow[],
  target: number
): SkewCandidate | null => {
  const right = target < 0 ? "put" : "call";
  let best: SkewCandidate | null = null;
  for (const row of group) {
    if (row.right !== right || row.iv === null || row.delta === null) continue;
    const distance = Math.abs(row.delta * 100 - target);
    if (best === null || distance < best.distance)
      best = {
        delta: Math.round(row.delta * 100),
        distance,
        iv: row.iv,
        target,
      };
  }
  return best !== null && best.distance <= SKEW_MAX_DELTA_DISTANCE
    ? best
    : null;
};

// IV at fixed deltas (puts negative, calls positive) per expiry. When several
// targets pick the same contract, only the nearest target keeps it.
export const skew = (rows: readonly ChainRow[]): VolatilitySection["skew"] => {
  const points: VolatilitySection["skew"] = [];
  for (const [expiry, group] of groupByExpiry(rows)) {
    const candidates = IV_SKEW_TARGET_DELTAS.map((target) =>
      skewCandidate(group, target)
    ).filter((candidate) => candidate !== null);
    const owner = new Map<number, SkewCandidate>();
    for (const candidate of candidates) {
      const current = owner.get(candidate.delta);
      if (current === undefined || candidate.distance < current.distance)
        owner.set(candidate.delta, candidate);
    }
    for (const candidate of candidates)
      if (owner.get(candidate.delta) === candidate)
        points.push({
          delta: candidate.delta,
          expiry,
          iv: candidate.iv,
          target: candidate.target,
        });
  }
  return points;
};

// Out-of-the-money IV at fixed moneyness (strike / spot): puts below 1, calls above,
// the mean of both at 1. Null when no strike lies within 2.5 % of the target.
export const ivSurface = (
  rows: readonly ChainRow[],
  spot: number | null,
  today: string
): VolatilitySection["surface"] => {
  const moneyness = [...IV_SURFACE_MONEYNESS];
  if (spot === null || spot <= 0) return { moneyness, rows: [] };
  const surfaceRows: VolatilitySection["surface"]["rows"] = [];
  for (const [expiry, group] of groupByExpiry(rows)) {
    if (surfaceRows.length >= SURFACE_MAX_EXPIRIES) break;
    const pick = (target: number, right: "call" | "put"): number | null => {
      let best: { distance: number; iv: number } | null = null;
      for (const row of group) {
        if (row.right !== right || row.iv === null) continue;
        const distance = Math.abs(row.strike - target);
        if (best === null || distance < best.distance)
          best = { distance, iv: row.iv };
      }
      return best !== null && best.distance <= target * SURFACE_STRIKE_TOLERANCE
        ? best.iv
        : null;
    };
    const ivs = moneyness.map((m) => {
      const target = spot * m;
      if (m < 1) return pick(target, "put");
      if (m > 1) return pick(target, "call");
      const both = [pick(target, "put"), pick(target, "call")].filter(
        (iv): iv is number => iv !== null
      );
      return both.length === 0
        ? null
        : both.reduce((a, b) => a + b, 0) / both.length;
    });
    if (ivs.some((iv) => iv !== null))
      surfaceRows.push({
        dte: Math.max(0, daysUntil(expiry, today)),
        expiry,
        ivs,
      });
  }
  return { moneyness, rows: surfaceRows };
};

// Strike of minimum total option-holder payout at expiry (aggregate OI proxy).
export const maxPain = (rows: readonly OpenInterestRow[]): number | null => {
  let best: { strike: number; pain: number } | null = null;
  for (const candidate of rows) {
    let pain = 0;
    for (const row of rows) {
      pain +=
        Math.max(0, candidate.strike - row.strike) * row.callOpenInterest * 100;
      pain +=
        Math.max(0, row.strike - candidate.strike) * row.putOpenInterest * 100;
    }
    if (best === null || pain < best.pain)
      best = { pain, strike: candidate.strike };
  }
  return best?.strike ?? null;
};

// Display set: up to 55 strikes nearest spot (within 50-150 % of spot) plus the
// 25 largest OI strikes, sorted, at most 80.
export const displayStrikes = (
  rows: readonly OpenInterestRow[],
  spot: number | null
): OpenInterestRow[] => {
  if (rows.length === 0) return [];
  let pool: readonly OpenInterestRow[] = rows;
  let near: OpenInterestRow[];
  if (spot !== null && spot > 0) {
    const inRange = rows.filter(
      (row) => row.strike >= spot * 0.5 && row.strike <= spot * 1.5
    );
    pool = inRange.length > 0 ? inRange : rows;
    near = [...pool]
      .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
      .slice(0, 55);
  } else {
    near = rows.slice(0, 40);
  }
  const top = [...pool]
    .sort(
      (a, b) =>
        b.callOpenInterest +
        b.putOpenInterest -
        (a.callOpenInterest + a.putOpenInterest)
    )
    .slice(0, 25);
  const selected = new Map<number, OpenInterestRow>();
  for (const row of [...near, ...top]) selected.set(row.strike, row);
  return [...selected.values()]
    .sort((a, b) => a.strike - b.strike)
    .slice(0, 80);
};

// Black-Scholes gamma with zero rate and dividend.
export const blackScholesGamma = (
  spot: number,
  strike: number,
  iv: number,
  years: number
): number => {
  const sqrtT = Math.sqrt(years);
  const d1 = (Math.log(spot / strike) + 0.5 * iv * iv * years) / (iv * sqrtT);
  return (
    Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI) / (spot * iv * sqrtT)
  );
};

// Estimated GEX per strike, dollars per 1 % move: (callOI*gamma - putOI*gamma) * 100 * S^2 * 0.01.
// Gamma uses the IV of the nearest expiry with DTE >= 1 at that strike (ATM IV as fallback).
// Assumes dealers are long calls and short puts; aggregate OI spans all expiries.
export const exposure = (
  oiRows: readonly OpenInterestRow[],
  chain: readonly ChainRow[],
  spot: number | null,
  today: string
): Omit<ExposureSection, "status" | "message"> => {
  const strikes = displayStrikes(oiRows, spot);
  const pain = maxPain(oiRows);
  const expiries = [...new Set(chain.map((row) => row.expiry))];
  const gexExpiry =
    expiries.find((expiry) => daysUntil(expiry, today) >= 1) ??
    expiries[0] ??
    null;
  if (spot === null || spot <= 0 || gexExpiry === null) {
    return {
      gexExpiry: null,
      maxPain: pain,
      strikes: strikes.map((row) => ({ ...row, gex: null })),
      totalGex: null,
    };
  }
  const front = chain.filter(
    (row) => row.expiry === gexExpiry && row.iv !== null
  );
  const atm = termStructure(front, spot, today)[0]?.atmIv ?? null;
  const years = Math.max(daysUntil(gexExpiry, today), 0.5) / 365;
  const ivAt = (strike: number, right: "call" | "put"): number | null =>
    front.find((row) => row.strike === strike && row.right === right)?.iv ??
    atm;
  let total = 0;
  let any = false;
  const rows = strikes.map((row) => {
    const callIv = ivAt(row.strike, "call");
    const putIv = ivAt(row.strike, "put");
    if (callIv === null || putIv === null) return { ...row, gex: null };
    const scale = 100 * spot * spot * 0.01;
    const gex =
      (row.callOpenInterest *
        blackScholesGamma(spot, row.strike, callIv, years) -
        row.putOpenInterest *
          blackScholesGamma(spot, row.strike, putIv, years)) *
      scale;
    total += gex;
    any = true;
    return { ...row, gex };
  });
  return {
    gexExpiry,
    maxPain: pain,
    strikes: rows,
    totalGex: any ? total : null,
  };
};

const SENTIMENTS = new Set(["bullish", "bearish", "neutral"]);

const flowTime = (value: unknown): string | null => {
  const numeric = toNumber(value);
  const ms =
    numeric ?? (typeof value === "string" ? Date.parse(value) : Number.NaN);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

const flowType = (value: unknown): string | null => {
  if (typeof value !== "string" || value.trim() === "") return null;
  const lower = value.trim().toLowerCase();
  if (lower.includes("block")) return "block";
  if (lower.includes("sweep")) return "sweep";
  return lower.slice(0, 24);
};

// order-flow/consolidated data: an array of trade rows (contractType, strikePrice, ...).
export const parseFlow = (data: unknown, symbol: string): FlowEvent[] => {
  if (!Array.isArray(data)) return [];
  const events: FlowEvent[] = [];
  for (const row of data) {
    const rawRight = String(field(row, "contractType") ?? "").toLowerCase();
    const right = rawRight === "call" || rawRight === "put" ? rawRight : null;
    const strike = toNumber(field(row, "strikePrice"));
    const expiry = String(field(row, "expirationDate") ?? "").slice(0, 10);
    const premium = toNumber(field(row, "premium"));
    const time = flowTime(field(row, "tradeTime"));
    if (
      right === null ||
      strike === null ||
      !ISO_DATE.test(expiry) ||
      premium === null ||
      time === null
    )
      continue;
    const size = Math.max(
      0,
      Math.trunc(
        toNumber(field(row, "size")) ?? toNumber(field(row, "volume")) ?? 0
      )
    );
    const sentiment = String(field(row, "sentimentType") ?? "").toLowerCase();
    events.push({
      contract: `${symbol} ${expiry} ${strike}${right === "call" ? "C" : "P"}`,
      expiry,
      flowType: flowType(field(row, "tradeConsolidationType")),
      premium,
      right,
      sentiment: SENTIMENTS.has(sentiment)
        ? (sentiment as FlowEvent["sentiment"])
        : "neutral",
      size,
      strike,
      time,
      unusual: field(row, "isUnusual") === true,
    });
  }
  return events.sort((a, b) => b.time.localeCompare(a.time));
};

// Hourly call/put premium buckets plus totals; keeps the newest 100 events.
export const summarizeFlow = (
  events: readonly FlowEvent[]
): Pick<FlowSection, "callPremium" | "putPremium" | "events" | "buckets"> => {
  const buckets = new Map<string, FlowSection["buckets"][number]>();
  let callPremium = 0;
  let putPremium = 0;
  for (const event of events) {
    const start = `${event.time.slice(0, 13)}:00:00.000Z`;
    const bucket = buckets.get(start) ?? {
      callPremium: 0,
      netPremium: 0,
      putPremium: 0,
      start,
      trades: 0,
    };
    if (event.right === "call") {
      bucket.callPremium += event.premium;
      callPremium += event.premium;
    } else {
      bucket.putPremium += event.premium;
      putPremium += event.premium;
    }
    bucket.netPremium = bucket.callPremium - bucket.putPremium;
    bucket.trades += 1;
    buckets.set(start, bucket);
  }
  return {
    buckets: [...buckets.values()].sort((a, b) =>
      a.start.localeCompare(b.start)
    ),
    callPremium,
    events: events.slice(0, MAX_FLOW_EVENTS),
    putPremium,
  };
};
