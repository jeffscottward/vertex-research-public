// What: the research screen as a platform job (researchScreen.*): one run per claimed slot with
// its lease, deadline and counters; one row per report with the last good observation and the
// last attempt; the stored daily bars of a report; the single scheduler row (last tick); the
// single Swinglytics row (last good snapshot and last attempt).
// Rows and bars leave only through the cascade from research_reports. The jsonb payload types are
// structural: the oRPC layer parses them before a row leaves the server.
// Research only: nothing here places, changes or cancels an order.
// Used by: packages/db/src/server/research-screen.ts.
// See: docs/vertex-rebuild/designs/research-screen/design.md (Tables).
import { sql } from "drizzle-orm";
import {
  check,
  date,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

import { researchReports } from "./research-reports.ts";

export const RESEARCH_SCREEN_RUN_STATUSES = [
  "running",
  "completed",
  "partial",
  "failed",
  "interrupted",
] as const;
export type ResearchScreenRunStatus =
  (typeof RESEARCH_SCREEN_RUN_STATUSES)[number];

export const RESEARCH_SCREEN_TICK_DECISIONS = [
  "not-due",
  "claimed",
  "resumed",
  "busy",
] as const;
export type ResearchScreenTickDecision =
  (typeof RESEARCH_SCREEN_TICK_DECISIONS)[number];

export const RESEARCH_SCREEN_SOURCES = ["ibkr", "yahoo"] as const;
export type ResearchScreenSource = (typeof RESEARCH_SCREEN_SOURCES)[number];

export const RESEARCH_SCREEN_ERROR_CODES = [
  "identity-unverified",
  "metadata-invalid",
  "provider-http",
  "provider-timeout",
  "rate-limited",
  "identity-mismatch",
  "quote-missing",
  "too-few-bars",
  "invalid-ohlc",
] as const;
export type ResearchScreenErrorCode =
  (typeof RESEARCH_SCREEN_ERROR_CODES)[number];

export const RESEARCH_SCREEN_ATTEMPT_STATUSES = ["ok", "error"] as const;
export type ResearchScreenAttemptStatus =
  (typeof RESEARCH_SCREEN_ATTEMPT_STATUSES)[number];

/** The computed screen values of one report, as stored in research_screen_rows.observation. */
export interface ResearchScreenObservationValue {
  action: string;
  blockingWarnings: { code: string; text: string }[];
  buyZone: { high: number; low: number } | null;
  changePercent: number | null;
  momentumPercent: number | null;
  price: number | null;
  reasons: string[];
  rewardRisk: number | null;
  score: number;
  stop: number | null;
  support: number | null;
  target: number | null;
  warnings: string[];
}

/** One completed daily bar; `date` is YYYY-MM-DD. */
export interface ResearchScreenBarValue {
  c: number;
  date: string;
  h: number;
  l: number;
  o: number;
}

/** The parsed Swinglytics context, as stored in research_screen_swinglytics.snapshot. */
export interface ResearchScreenSwinglyticsSnapshotValue {
  breadth: {
    above200DayPercent: number | null;
    above20DayPercent: number | null;
    above50DayPercent: number | null;
    regime: string | null;
    score: number | null;
  };
  regime: {
    label: string;
    riskLevel: string | null;
    trendStrength: string | null;
  };
  scanner: {
    bearish: number | null;
    bullish: number | null;
    total: number | null;
    withSetups: number | null;
  };
  setups: {
    direction: "bullish" | "bearish";
    name: string | null;
    pattern: string | null;
    sector: string | null;
    ticker: string;
  }[];
  themes: {
    bias: string | null;
    changePercent: number | null;
    name: string;
  }[];
  vix: {
    level: number | null;
    percentile1Year: number | null;
    regime: string | null;
    trend: string | null;
  };
}

const utc = (name: string) =>
  timestamp(name, { mode: "date", withTimezone: true });
const counter = (name: string) => integer(name).default(0).notNull();

export const researchScreenRuns = pgTable(
  "research_screen_runs",
  {
    barsFromIbkr: counter("bars_from_ibkr"),
    barsFromYahoo: counter("bars_from_yahoo"),
    claimedAt: utc("claimed_at").notNull(),
    /** claimed_at + 25 minutes, database clock. */
    deadlineAt: utc("deadline_at").notNull(),
    failed: counter("failed"),
    /** Raised by each lease take; every write of a tick checks it. */
    fence: counter("fence"),
    finishedAt: utc("finished_at"),
    /** Stop counter: IBKR reads that failed in a row. */
    ibkrFailuresInRow: counter("ibkr_failures_in_row"),
    id: uuid("id").defaultRandom().primaryKey(),
    leaseExpiresAt: utc("lease_expires_at"),
    /** The request id of the tick that holds the lease. */
    leaseOwner: text("lease_owner"),
    message: text("message"),
    notReached: counter("not_reached"),
    slotAt: utc("slot_at").notNull(),
    slotLabels: jsonb("slot_labels").$type<string[]>().notNull(),
    status: text("status").$type<ResearchScreenRunStatus>().notNull(),
    succeeded: counter("succeeded"),
    total: counter("total"),
    /** Stop counter: Yahoo rate limits in a row. */
    yahooRateLimitsInRow: counter("yahoo_rate_limits_in_row"),
  },
  (table) => [
    uniqueIndex("research_screen_runs_slot_at_idx").on(table.slotAt),
    uniqueIndex("research_screen_runs_running_idx")
      .on(table.status)
      .where(sql`${table.status} = 'running'`),
    check(
      "research_screen_runs_status_check",
      sql`${table.status} in ('running', 'completed', 'partial', 'failed', 'interrupted')`
    ),
    check(
      "research_screen_runs_shape_check",
      sql`jsonb_typeof(${table.slotLabels}) = 'array' and (${table.message} is null or char_length(${table.message}) <= 300)`
    ),
  ]
);

export const researchScreenRows = pgTable(
  "research_screen_rows",
  {
    attemptAt: utc("attempt_at"),
    attemptRunId: uuid("attempt_run_id").references(
      () => researchScreenRuns.id,
      { onDelete: "set null" }
    ),
    barsSource: text("bars_source").$type<ResearchScreenSource>(),
    errorCode: text("error_code").$type<ResearchScreenErrorCode>(),
    errorMessage: text("error_message"),
    goodAt: utc("good_at"),
    goodRunId: uuid("good_run_id").references(() => researchScreenRuns.id, {
      onDelete: "set null",
    }),
    historyAt: utc("history_at"),
    observation: jsonb("observation").$type<ResearchScreenObservationValue>(),
    /** A change clears the last good observation. */
    providerSymbol: text("provider_symbol").notNull(),
    quoteAt: utc("quote_at"),
    quoteSource: text("quote_source").$type<ResearchScreenSource>(),
    reportId: text("report_id")
      .primaryKey()
      .references(() => researchReports.id, { onDelete: "cascade" }),
  },
  (table) => [
    check(
      "research_screen_rows_source_check",
      sql`(${table.barsSource} is null or ${table.barsSource} in ('ibkr', 'yahoo')) and (${table.quoteSource} is null or ${table.quoteSource} in ('ibkr', 'yahoo'))`
    ),
    check(
      "research_screen_rows_error_check",
      sql`(${table.errorCode} is null or ${table.errorCode} in ('identity-unverified', 'metadata-invalid', 'provider-http', 'provider-timeout', 'rate-limited', 'identity-mismatch', 'quote-missing', 'too-few-bars', 'invalid-ohlc')) and (${table.errorMessage} is null or char_length(${table.errorMessage}) <= 300)`
    ),
  ]
);

export const researchScreenBars = pgTable(
  "research_screen_bars",
  {
    /** At most 300 completed daily bars, oldest first. */
    bars: jsonb("bars").$type<ResearchScreenBarValue[]>().notNull(),
    fetchedAt: utc("fetched_at").notNull(),
    providerSymbol: text("provider_symbol").notNull(),
    reportId: text("report_id")
      .primaryKey()
      .references(() => researchReports.id, { onDelete: "cascade" }),
    /** Date of the newest stored bar (YYYY-MM-DD). */
    sessionDate: date("session_date", { mode: "string" }).notNull(),
  },
  (table) => [
    check(
      "research_screen_bars_check",
      sql`jsonb_typeof(${table.bars}) = 'array' and jsonb_array_length(${table.bars}) <= 300`
    ),
  ]
);

export const researchScreenScheduler = pgTable(
  "research_screen_scheduler",
  {
    id: integer("id").primaryKey(),
    lastTickAt: utc("last_tick_at").notNull(),
    lastTickDecision: text("last_tick_decision")
      .$type<ResearchScreenTickDecision>()
      .notNull(),
  },
  (table) => [
    check(
      "research_screen_scheduler_check",
      sql`${table.id} = 1 and ${table.lastTickDecision} in ('not-due', 'claimed', 'resumed', 'busy')`
    ),
  ]
);

export const researchScreenSwinglytics = pgTable(
  "research_screen_swinglytics",
  {
    generatedAt: utc("generated_at"),
    id: integer("id").primaryKey(),
    lastAttemptAt: utc("last_attempt_at"),
    lastAttemptStatus: text(
      "last_attempt_status"
    ).$type<ResearchScreenAttemptStatus>(),
    lastError: text("last_error"),
    retrievedAt: utc("retrieved_at"),
    snapshot: jsonb("snapshot").$type<ResearchScreenSwinglyticsSnapshotValue>(),
  },
  (table) => [
    check(
      "research_screen_swinglytics_check",
      sql`${table.id} = 1 and (${table.lastAttemptStatus} is null or ${table.lastAttemptStatus} in ('ok', 'error'))`
    ),
  ]
);
