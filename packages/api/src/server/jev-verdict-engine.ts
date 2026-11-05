import { z } from "zod";

import {
  JEV_STANCES,
  type JevFailure,
  type JevStance,
  type JevVerdict,
  type JevVerdictOutput,
  type JevVerdictState,
} from "../contracts/jev-verdict.ts";

// Pure parts of the JEV verdict (merge plan P5): public feature extraction, the privacy
// allow-list, the JEV questions and answer parser, and the per-symbol throttle and cache.
// Nothing here performs I/O or can place, change or cancel orders.

// Only these fields may leave the process. publicState() walks this list, not its input,
// so any other key (account ids, positions, NLV, balances, orders) is never copied.
export const JEV_PUBLIC_FIELDS = [
  "ticker",
  "as_of",
  "last",
  "day_change_pct",
  "change_5d_pct",
  "change_20d_pct",
  "change_60d_pct",
  "recent_closes_1m",
  "sma20",
  "sma50",
  "sma200",
  "distance_sma20_pct",
  "distance_sma50_pct",
  "distance_sma200_pct",
  "high_52w",
  "low_52w",
  "from_high_52w_pct",
  "from_low_52w_pct",
  "volume_vs_avg20",
] as const;
export type JevPublicField = (typeof JEV_PUBLIC_FIELDS)[number];
export type JevPublicValue = string | number | readonly number[];
export type JevPublicState = Readonly<
  Partial<Record<JevPublicField, JevPublicValue>>
>;

const TICKER = /^[A-Z][A-Z0-9.]{0,11}$/u;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/u;
const MAX_RECENT_CLOSES = 21;

const finiteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const publicValue = (
  field: JevPublicField,
  value: unknown
): JevPublicValue | undefined => {
  if (field === "ticker")
    return typeof value === "string" && TICKER.test(value) ? value : undefined;
  if (field === "as_of")
    return typeof value === "string" && ISO_DAY.test(value) ? value : undefined;
  if (field === "recent_closes_1m")
    return Array.isArray(value) &&
      value.length <= MAX_RECENT_CLOSES &&
      value.every(finiteNumber)
      ? value
      : undefined;
  return finiteNumber(value) ? value : undefined;
};

export const publicState = (
  raw: Readonly<Record<string, unknown>>
): JevPublicState => {
  const state: Partial<Record<JevPublicField, JevPublicValue>> = {};
  for (const field of JEV_PUBLIC_FIELDS) {
    const value = publicValue(field, raw[field]);
    if (value !== undefined) state[field] = value;
  }
  return state;
};

export type JevBar = Readonly<{ t: number; c: number; v: number | null }>;

const round = (value: number, digits: number): number => {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

const changePct = (closes: readonly number[], back: number): number | null => {
  const last = closes.at(-1);
  const base = closes.at(-1 - back);
  if (last === undefined || base === undefined || base <= 0) return null;
  return round((last / base - 1) * 100, 2);
};

const mean = (values: readonly number[]): number =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

const sma = (closes: readonly number[], length: number): number | null =>
  closes.length < length ? null : round(mean(closes.slice(-length)), 4);

const distancePct = (last: number, level: number | null): number | null =>
  level === null || level <= 0 ? null : round((last / level - 1) * 100, 2);

const volumeRatio = (bars: readonly JevBar[]): number | null => {
  const lastVolume = bars.at(-1)?.v ?? null;
  const prior = bars
    .slice(-21, -1)
    .map((bar) => bar.v)
    .filter((volume): volume is number => volume !== null);
  if (lastVolume === null || prior.length < 20) return null;
  const average = mean(prior);
  return average > 0 ? round(lastVolume / average, 2) : null;
};

// Public features from daily bars (oldest first after sorting). Null when fewer than 2 bars.
export const buildPublicFeatures = (
  symbol: string,
  bars: readonly JevBar[],
  asOf: string | null
): JevPublicState | null => {
  const sorted = [...bars]
    .filter((bar) => finiteNumber(bar.c) && bar.c > 0)
    .sort((left, right) => left.t - right.t);
  const closes = sorted.map((bar) => bar.c);
  const last = closes.at(-1);
  if (last === undefined || closes.length < 2) return null;
  const year = closes.slice(-252);
  const high = Math.max(...year);
  const low = Math.min(...year);
  const sma20 = sma(closes, 20);
  const sma50 = sma(closes, 50);
  const sma200 = sma(closes, 200);
  return publicState({
    as_of: asOf?.slice(0, 10),
    change_5d_pct: changePct(closes, 5),
    change_20d_pct: changePct(closes, 20),
    change_60d_pct: changePct(closes, 60),
    day_change_pct: changePct(closes, 1),
    distance_sma20_pct: distancePct(last, sma20),
    distance_sma50_pct: distancePct(last, sma50),
    distance_sma200_pct: distancePct(last, sma200),
    from_high_52w_pct: distancePct(last, high),
    from_low_52w_pct: distancePct(last, low),
    high_52w: round(high, 4),
    last: round(last, 4),
    low_52w: round(low, 4),
    recent_closes_1m: closes
      .slice(-MAX_RECENT_CLOSES)
      .map((close) => round(close, 4)),
    sma20,
    sma50,
    sma200,
    ticker: symbol,
    volume_vs_avg20: volumeRatio(sorted),
  });
};

const INSTRUCTIONS =
  "The state holds public daily price data for one listed stock or ETF. It holds no account, " +
  "position, balance or order data. Give a research view of the likely price direction over " +
  "the next 1 to 4 weeks. Choose NEUTRAL when the evidence is mixed or weak. The view is shown " +
  "to a person only; it does not size, place or change any order.";

const JEV_FACTORS = {
  momentum_healthy: {
    label: "Healthy momentum",
    question:
      "Is recent momentum positive without the price being overextended?",
  },
  reversal_risk_low: {
    label: "Low reversal risk",
    question: "Is the risk of a sharp price reversal in the next weeks low?",
  },
  trend_up: {
    label: "Uptrend",
    question:
      "Do the price and its 20-, 50- and 200-day averages show an uptrend?",
  },
} as const;
// Display and question order (object key order is not relied on).
const FACTOR_KEYS = [
  "trend_up",
  "momentum_healthy",
  "reversal_risk_low",
] as const satisfies readonly (keyof typeof JEV_FACTORS)[];

// BULLISH or BEARISH needs that choice with at least this probability; else NEUTRAL.
const JEV_MIN_STANCE_PROBABILITY = 0.6;

export const buildJevRequestBody = (
  model: string,
  state: JevPublicState
): Readonly<Record<string, unknown>> => ({
  model,
  questions: {
    decision: {
      criteria: {
        BEARISH: "The public price data supports a falling price",
        BULLISH: "The public price data supports a rising price",
        NEUTRAL: "The evidence is mixed or weak",
      },
      instructions: INSTRUCTIONS,
      type: "choice",
    },
    ...Object.fromEntries(
      FACTOR_KEYS.map((key) => [
        key,
        { instructions: JEV_FACTORS[key].question, type: "noul" },
      ])
    ),
  },
  state,
});

const probabilityValue = z.number().min(0).max(1);
const JevReplySchema = z.object({
  answers: z
    .object({
      decision: z.object({
        choice: z.string().max(40).nullish(),
        probabilities: z.record(z.string().max(40), z.unknown()).nullish(),
      }),
    })
    .catchall(z.unknown()),
  model: z.string().max(120).nullish(),
});
const NoulSchema = z.object({ noul: probabilityValue });

export type ParsedJevReply = Omit<
  JevVerdict,
  "decidedAt" | "dataAsOf" | "sentFields"
>;

const isStance = (value: unknown): value is JevStance =>
  typeof value === "string" &&
  (JEV_STANCES as readonly string[]).includes(value);

const probabilityOf = (
  probabilities: Readonly<Record<string, unknown>>,
  stance: JevStance
): number => {
  const parsed = probabilityValue.safeParse(probabilities[stance]);
  return parsed.success ? parsed.data : 0;
};

// Null when the reply does not hold a decision with probabilities.
export const parseJevReply = (document: unknown): ParsedJevReply | null => {
  const reply = JevReplySchema.safeParse(document);
  if (!reply.success) return null;
  const { answers } = reply.data;
  const rawProbabilities = answers.decision.probabilities;
  if (rawProbabilities === null || rawProbabilities === undefined) return null;
  const probabilities = {
    BEARISH: probabilityOf(rawProbabilities, "BEARISH"),
    BULLISH: probabilityOf(rawProbabilities, "BULLISH"),
    NEUTRAL: probabilityOf(rawProbabilities, "NEUTRAL"),
  };
  const choice = isStance(answers.decision.choice)
    ? answers.decision.choice
    : null;
  const stance: JevStance =
    choice !== null &&
    choice !== "NEUTRAL" &&
    probabilities[choice] >= JEV_MIN_STANCE_PROBABILITY
      ? choice
      : "NEUTRAL";
  const factors = FACTOR_KEYS.flatMap((key) => {
    const answer = NoulSchema.safeParse(answers[key]);
    return answer.success
      ? [
          {
            key,
            label: JEV_FACTORS[key].label,
            probability: round(answer.data.noul, 4),
          },
        ]
      : [];
  });
  const head =
    choice === null
      ? "no clear choice"
      : `P(${choice})=${probabilities[choice].toFixed(2)}`;
  const below =
    choice !== null && choice !== "NEUTRAL" && stance === "NEUTRAL"
      ? ` (below ${JEV_MIN_STANCE_PROBABILITY.toFixed(2)})`
      : "";
  const detail = factors
    .map(
      (factor) =>
        `${factor.label.toLowerCase()} ${factor.probability.toFixed(2)}`
    )
    .join(", ");
  return {
    choice,
    factors,
    model: reply.data.model ?? null,
    probabilities,
    reason: `${head}${below}${detail === "" ? "" : `; ${detail}`}`,
    stance,
  };
};

// Per-symbol cache and throttle. One store per server process (the QuantVPS web app runs
// one `vite preview` process); a restart clears it.
export type JevStoreEntry = Readonly<{
  verdict: JevVerdict | null;
  lastFailure: JevFailure | null;
  lastAttemptMs: number | null;
  inFlight: boolean;
}>;

export type JevStoreLimits = Readonly<{
  minIntervalMs: number;
  maxCallsPerHour: number;
  maxEntries: number;
}>;

export type JevStartResult =
  | Readonly<{ ok: true }>
  | Readonly<{ ok: false; nextAtMs: number }>;

export interface JevVerdictStore {
  readonly fail: (symbol: string, failure: JevFailure) => void;
  // Earliest time a JEV call for this symbol is allowed; null = allowed now.
  readonly nextAllowedMs: (symbol: string, nowMs: number) => number | null;
  readonly read: (symbol: string) => JevStoreEntry | null;
  readonly succeed: (symbol: string, verdict: JevVerdict) => void;
  // Reserves one JEV call (counts against both limits) or refuses it.
  readonly tryStart: (symbol: string, nowMs: number) => JevStartResult;
}

const HOUR_MS = 3_600_000;
const EMPTY: JevStoreEntry = {
  inFlight: false,
  lastAttemptMs: null,
  lastFailure: null,
  verdict: null,
};

export const createJevVerdictStore = (
  limits: JevStoreLimits
): JevVerdictStore => {
  const entries = new Map<string, JevStoreEntry>();
  let calls: number[] = [];

  const write = (symbol: string, entry: JevStoreEntry): void => {
    entries.delete(symbol);
    entries.set(symbol, entry);
    if (entries.size <= limits.maxEntries) return;
    for (const [key, value] of entries) {
      if (!value.inFlight && key !== symbol) {
        entries.delete(key);
        return;
      }
    }
  };

  const nextAllowedMs = (symbol: string, nowMs: number): number | null => {
    calls = calls.filter((at) => nowMs - at < HOUR_MS);
    const entry = entries.get(symbol) ?? EMPTY;
    const waits: number[] = [];
    if (entry.inFlight && entry.lastAttemptMs !== null)
      waits.push(
        Math.max(nowMs + 1, entry.lastAttemptMs + limits.minIntervalMs)
      );
    else if (
      entry.lastAttemptMs !== null &&
      nowMs - entry.lastAttemptMs < limits.minIntervalMs
    )
      waits.push(entry.lastAttemptMs + limits.minIntervalMs);
    const oldest = calls[0];
    if (calls.length >= limits.maxCallsPerHour && oldest !== undefined)
      waits.push(oldest + HOUR_MS);
    return waits.length === 0 ? null : Math.max(...waits);
  };

  return Object.freeze({
    fail: (symbol: string, failure: JevFailure) => {
      const entry = entries.get(symbol) ?? EMPTY;
      write(symbol, { ...entry, inFlight: false, lastFailure: failure });
    },
    nextAllowedMs,
    read: (symbol: string) => entries.get(symbol) ?? null,
    succeed: (symbol: string, verdict: JevVerdict) => {
      const entry = entries.get(symbol) ?? EMPTY;
      write(symbol, { ...entry, inFlight: false, lastFailure: null, verdict });
    },
    tryStart: (symbol: string, nowMs: number): JevStartResult => {
      const next = nextAllowedMs(symbol, nowMs);
      if (next !== null) return { nextAtMs: next, ok: false };
      calls.push(nowMs);
      const entry = entries.get(symbol) ?? EMPTY;
      write(symbol, { ...entry, inFlight: true, lastAttemptMs: nowMs });
      return { ok: true };
    },
  });
};

export const verdictState = (
  verdict: JevVerdict | null,
  nowMs: number,
  staleAfterMs: number
): JevVerdictState => {
  if (verdict === null) return "none";
  return nowMs - Date.parse(verdict.decidedAt) > staleAfterMs
    ? "stale"
    : "fresh";
};

export type JevOutputFlags = Readonly<{
  configured: boolean;
  refreshed: boolean;
  throttled: boolean;
}>;

const JEV_VERDICT_NOTES = [
  "Display only. The verdict never places, changes or cancels orders.",
  "JEV gets only public daily price fields for this symbol (see sent fields); never account, position, balance or order data.",
  "Refresh: one JEV call per symbol every 30 min and at most 12 calls per hour in total. The cache is kept in the web server process and is cleared on restart.",
] as const;

export const toJevVerdictOutput = (
  symbol: string,
  store: JevVerdictStore,
  nowMs: number,
  limits: Readonly<{ minIntervalMs: number; staleAfterMs: number }>,
  flags: JevOutputFlags
): JevVerdictOutput => {
  const entry = store.read(symbol) ?? EMPTY;
  const next = flags.configured ? store.nextAllowedMs(symbol, nowMs) : null;
  return {
    configured: flags.configured,
    lastFailure: entry.lastFailure,
    minIntervalSeconds: Math.round(limits.minIntervalMs / 1000),
    nextRefreshAt: next === null ? null : new Date(next).toISOString(),
    notes: [...JEV_VERDICT_NOTES],
    refreshed: flags.refreshed,
    staleAfterSeconds: Math.round(limits.staleAfterMs / 1000),
    state: verdictState(entry.verdict, nowMs, limits.staleAfterMs),
    symbol,
    throttled: flags.throttled,
    verdict: entry.verdict,
  };
};
