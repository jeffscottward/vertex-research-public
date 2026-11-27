// What: the market_premium source of flow.collect. Each run makes at most one QuantData
// gainers-losers request: the live capture of today's session (about every 15 minutes while
// options trade, 09:30-16:15 New York, 13:15 on an early close, on an NYSE trading day), else the
// gap fill of the oldest weekday of the last 400 days that the session ledger does not hold as
// complete. A session is complete only when it was fetched on a New York day after the session
// date, so the gap fill is the one-year backfill, the settle fetch of each partial live session
// (after midnight) and the repair of missed sessions.
// Each attempt updates the ledger row of its session (flow_market_premium_sessions).
// Research only: nothing here places, changes or cancels orders. Doc: docs/vertex-rebuild/flow-pipeline.md.
import type {
  FlowMarketPremiumSessionRecord,
  FlowRepository,
} from "@darkfactory/db/server";

import type { FlowSampleStatus } from "../contracts/flow.ts";
import {
  MARKET_PREMIUM_FILTER_PROFILE,
  marketPremiumRequest,
  parseMarketPremium,
} from "../flow-market-premium.ts";
import { isMarketPremiumSessionOpen } from "../openbb-overdue.ts";
import { newYorkDate } from "./gex-context.ts";
import type { QuantDataClient } from "./quantdata-client.ts";

/** Seconds between two live captures of today's session (the 60 s timer gives about 15 minutes). */
const MARKET_PREMIUM_LIVE_SECONDS = 840;
/** The gap fill looks back this many calendar days (QuantData kept at least 371 on 2026-11-20). */
export const MARKET_PREMIUM_HISTORY_DAYS = 400;
/** The gap fill requests a partial or unavailable session again at most this often. */
export const MARKET_PREMIUM_RETRY_SECONDS = 6 * 3600;
/** An answer with fewer than this share of the stored tickers of its session is not stored. */
const MARKET_PREMIUM_MIN_KEEP_SHARE = 0.5;
const CACHE_TTL_MS = 60_000;
const DAY_MS = 86_400_000;

export type MarketPremiumAttempt = Readonly<{
  status: FlowSampleStatus;
  items: number;
  message: string;
  /** false: not due or held by the budget; reported in the run output only, not stored as a sample. */
  record: boolean;
}>;

export type MarketPremiumDeps = Readonly<{
  client: QuantDataClient | null;
  repository: FlowRepository;
  now: Date;
  /** Operator seed run: capture the newest session even outside the live window. */
  seed: boolean;
  /** Dry run: request and parse, store nothing. */
  dryRun: boolean;
  /** The New York date of the newest session at or before now (flowSessionDate). */
  sessionDate: string;
}>;

const notDue = (message: string): MarketPremiumAttempt => ({
  items: 0,
  message,
  record: false,
  status: "skipped",
});

const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);

const isWeekday = (date: string): boolean => {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6;
};

/**
 * true when a capture at `at` holds the whole session `sessionDate`: it was fetched on a New York
 * day after the session date, so no trade of the session can still arrive.
 */
export const marketPremiumCompletes = (
  sessionDate: string,
  at: Date
): boolean => newYorkDate(at) > sessionDate;

/** A session the gap fill should request again: missing, or partial or unavailable and old enough. */
const wanted = (
  row: FlowMarketPremiumSessionRecord | undefined,
  now: Date
): boolean =>
  row === undefined ||
  ((row.status === "partial" || row.status === "unavailable") &&
    now.getTime() - row.lastAttemptAt.getTime() >=
      MARKET_PREMIUM_RETRY_SECONDS * 1000);

/**
 * The oldest weekday before today (New York) and at most MARKET_PREMIUM_HISTORY_DAYS back that the
 * gap fill should request, or null. Oldest first: the oldest sessions leave QuantData's history first.
 */
export const marketPremiumGapDate = (
  ledger: readonly FlowMarketPremiumSessionRecord[],
  today: string,
  now: Date
): string | null => {
  const rows = new Map(ledger.map((row) => [row.sessionDate, row]));
  for (
    let date = addDays(today, -MARKET_PREMIUM_HISTORY_DAYS);
    date < today;
    date = addDays(date, 1)
  )
    if (isWeekday(date) && wanted(rows.get(date), now)) return date;
  return null;
};

type Outcome =
  | Readonly<{ kind: "stored"; tickers: number; message: string }>
  | Readonly<{ kind: "failed"; message: string }>;

/**
 * The ledger row after one attempt. A session that holds rows (complete or partial) keeps its
 * status, capture time and ticker count when an attempt fails or brings no rows; else a session
 * without rows becomes no_data when the answer came after the session date, and unavailable before.
 */
export const nextMarketPremiumSession = (
  previous: FlowMarketPremiumSessionRecord | undefined,
  sessionDate: string,
  outcome: Outcome,
  now: Date
): FlowMarketPremiumSessionRecord => {
  const base = {
    attempts: (previous?.attempts ?? 0) + 1,
    lastAttemptAt: now,
    lastMessage: outcome.message.slice(0, 300),
    sessionDate,
  };
  if (outcome.kind === "stored" && outcome.tickers > 0)
    return {
      ...base,
      capturedAt: now,
      status: marketPremiumCompletes(sessionDate, now) ? "complete" : "partial",
      tickers: outcome.tickers,
    };
  if (previous !== undefined && previous.capturedAt !== null)
    return {
      ...base,
      capturedAt: previous.capturedAt,
      status: previous.status,
      tickers: previous.tickers,
    };
  return {
    ...base,
    capturedAt: null,
    status:
      outcome.kind === "stored" && marketPremiumCompletes(sessionDate, now)
        ? "no_data"
        : "unavailable",
    tickers: 0,
  };
};

/** One request for one session; stores the rows and the ledger row unless dry. */
const captureSession = async (
  deps: MarketPremiumDeps,
  client: QuantDataClient,
  sessionDate: string,
  previous: FlowMarketPremiumSessionRecord | undefined,
  label: string
): Promise<MarketPremiumAttempt> => {
  const { now, repository } = deps;
  const result = await client.request(
    "gainersLosers",
    marketPremiumRequest(sessionDate),
    CACHE_TTL_MS
  );
  if (!result.ok && result.reason === "reserved")
    return notDue("budget: QuantData starts kept free for other callers");
  // A provider cooldown or a shared-quota wait refuses before any request leaves: not an attempt.
  if (
    !result.ok &&
    result.reason === "rate_limited" &&
    result.httpStatus === undefined
  )
    return notDue(`QuantData paused: ${result.message}`.slice(0, 300));
  // HTTP 422 is QuantData's "data-unavailable": the session has no data (an answer without rows).
  const parsed = result.ok
    ? parseMarketPremium(result.data)
    : result.httpStatus === 422
      ? { ok: true as const, rows: [], skipped: 0 }
      : { message: result.message, ok: false as const };
  const kept =
    previous === undefined || previous.capturedAt === null
      ? 0
      : previous.tickers;
  const shrank =
    parsed.ok &&
    parsed.rows.length < Math.ceil(kept * MARKET_PREMIUM_MIN_KEEP_SHARE);
  const outcome: Outcome = parsed.ok
    ? shrank
      ? {
          kind: "failed",
          message: `${label} ${sessionDate}: answer shrank from ${kept} to ${parsed.rows.length} tickers; stored totals kept`,
        }
      : {
          kind: "stored",
          message: `${label} ${sessionDate}: ${parsed.rows.length} tickers with trades >= $100k${parsed.skipped > 0 ? `, ${parsed.skipped} keys skipped` : ""}, 1 request`,
          tickers: parsed.rows.length,
        }
    : { kind: "failed", message: `${label} ${sessionDate}: ${parsed.message}` };
  const session = nextMarketPremiumSession(previous, sessionDate, outcome, now);
  const rows =
    outcome.kind === "stored" && parsed.ok
      ? parsed.rows.map((row) => ({
          ...row,
          capturedAt: now,
          filterProfile: MARKET_PREMIUM_FILTER_PROFILE,
          sessionDate,
        }))
      : [];
  const items = deps.dryRun
    ? rows.length
    : await repository.storeMarketPremium({ rows, session });
  const status: FlowSampleStatus =
    outcome.kind === "failed"
      ? "unavailable"
      : rows.length > 0
        ? "ok"
        : "empty";
  return {
    items,
    message: outcome.message.slice(0, 300),
    record: true,
    status,
  };
};

/** The market_premium attempt of one flow.collect run (at most one QuantData request). */
export const collectMarketPremium = async (
  deps: MarketPremiumDeps
): Promise<MarketPremiumAttempt> => {
  const { client, now } = deps;
  if (client === null) return notDue("QuantData not configured");
  const today = newYorkDate(now);
  const ledger = await deps.repository.marketPremiumLedger({
    from: addDays(today, -MARKET_PREMIUM_HISTORY_DAYS),
    to: today,
  });
  const row = (date: string) =>
    ledger.find((entry) => entry.sessionDate === date);
  if (deps.seed)
    return await captureSession(
      deps,
      client,
      deps.sessionDate,
      row(deps.sessionDate),
      "seed"
    );
  // Live captures run while options trade (09:30-16:15 New York, 13:15 on an early close, on an
  // NYSE trading day): on a market holiday the gap fill runs instead.
  if (isMarketPremiumSessionOpen(now)) {
    const live = row(today);
    if (
      live === undefined ||
      now.getTime() - live.lastAttemptAt.getTime() >=
        MARKET_PREMIUM_LIVE_SECONDS * 1000
    )
      return await captureSession(deps, client, today, live, "live");
  }
  const gap = marketPremiumGapDate(ledger, today, now);
  if (gap === null)
    return notDue(
      `not due; the ledger holds every weekday of the last ${MARKET_PREMIUM_HISTORY_DAYS} days`
    );
  return await captureSession(deps, client, gap, row(gap), "gap fill");
};
