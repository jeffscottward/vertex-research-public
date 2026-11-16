import { oc } from "@orpc/contract";
import { z } from "zod";

import { SwinglyticsSnapshotSchema } from "../swinglytics.ts";

// Research screen (researchScreen.*): a scheduled screen of the catalog reports against public
// price evidence. `tick` is scheduler-only and works one share of a run; `status` is
// operator-only and returns the stored rows. Research only: no order path, no instruction to
// trade. A provider failure is never an API error; it is an error code on a row.

export const RESEARCH_SCREEN_DECISIONS = [
  "not-due",
  "claimed",
  "resumed",
  "busy",
] as const;
export const RESEARCH_SCREEN_RUN_STATUSES = [
  "running",
  "completed",
  "partial",
  "failed",
  "interrupted",
] as const;
export const RESEARCH_SCREEN_SCHEDULER_STATES = [
  "ok",
  "late",
  "silent",
  "never",
] as const;
export const RESEARCH_SCREEN_ACTIONS = [
  "review-entry",
  "watch",
  "wait",
  "unavailable",
] as const;
export const RESEARCH_SCREEN_COLLECTIONS = [
  "fresh",
  "failed",
  "never",
] as const;
export const RESEARCH_SCREEN_BARS_SOURCES = ["ibkr", "yahoo"] as const;
export const RESEARCH_SCREEN_QUOTE_SOURCES = ["yahoo"] as const;
export const RESEARCH_SCREEN_ATTEMPT_STATUSES = ["ok", "error"] as const;
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
/** Slots the status lists ahead. */
export const RESEARCH_SCREEN_NEXT_SLOTS = 12;
/** Characters a run message or a row error message may hold. */
export const RESEARCH_SCREEN_MAX_MESSAGE = 300;
/** Characters the last error of the Swinglytics context may hold. */
export const RESEARCH_SCREEN_MAX_CONTEXT_ERROR = 240;
/** Labels one slot may hold. */
export const RESEARCH_SCREEN_MAX_SLOT_LABELS = 5;
/** Reasons, warnings or blocking warnings one row may hold. */
export const RESEARCH_SCREEN_MAX_ROW_TEXTS = 24;
/** Characters one reason, warning or blocking-warning text may hold. */
export const RESEARCH_SCREEN_MAX_ROW_TEXT = 400;
/** Rows the status may hold. */
export const RESEARCH_SCREEN_MAX_ROWS = 1000;
/** Missed slots the status may hold. */
export const RESEARCH_SCREEN_MAX_MISSED_SLOTS = 24;

const count = z.number().int().min(0);
const value = z.number().finite();
const decision = z.enum(RESEARCH_SCREEN_DECISIONS);
const runStatus = z.enum(RESEARCH_SCREEN_RUN_STATUSES);
const action = z.enum(RESEARCH_SCREEN_ACTIONS);
const message = z.string().max(RESEARCH_SCREEN_MAX_MESSAGE);
const slotLabels = z.array(z.string()).max(RESEARCH_SCREEN_MAX_SLOT_LABELS);
const rowText = z.string().max(RESEARCH_SCREEN_MAX_ROW_TEXT);
const rowTexts = z.array(rowText).max(RESEARCH_SCREEN_MAX_ROW_TEXTS);

export const ResearchScreenTickInputSchema = z.strictObject({});
export const ResearchScreenStatusInputSchema = z.strictObject({});

export const ResearchScreenTickOutputSchema = z.strictObject({
  decision,
  done: z.boolean(),
  processed: count,
  remaining: count,
  requestId: z.string(),
  runId: z.string().nullable(),
  runStatus: runStatus.nullable(),
  slotAt: z.date().nullable(),
  slotLabels,
  total: count,
});

export const ResearchScreenSlotSchema = z.strictObject({
  at: z.date(),
  labels: slotLabels,
});

export const ResearchScreenRunSchema = z.strictObject({
  barsFromIbkr: count,
  barsFromYahoo: count,
  claimedAt: z.date(),
  deadlineAt: z.date(),
  failed: count,
  finishedAt: z.date().nullable(),
  id: z.string(),
  message: message.nullable(),
  notReached: count,
  slotAt: z.date(),
  slotLabels,
  status: runStatus,
  succeeded: count,
  total: count,
});

export const ResearchScreenRowSchema = z.strictObject({
  action,
  barsSource: z.enum(RESEARCH_SCREEN_BARS_SOURCES).nullable(),
  blockingWarnings: z
    .array(z.strictObject({ code: z.string(), text: rowText }))
    .max(RESEARCH_SCREEN_MAX_ROW_TEXTS),
  buyZone: z.strictObject({ high: value, low: value }).nullable(),
  changePercent: value.nullable(),
  collection: z.enum(RESEARCH_SCREEN_COLLECTIONS),
  errorCode: z.enum(RESEARCH_SCREEN_ERROR_CODES).nullable(),
  errorMessage: message.nullable(),
  historyAt: z.date().nullable(),
  lastAttemptAt: z.date().nullable(),
  lastAttemptRunId: z.string().nullable(),
  lastGoodAt: z.date().nullable(),
  lastGoodRunId: z.string().nullable(),
  momentumPercent: value.nullable(),
  price: value.nullable(),
  providerSymbol: z.string(),
  quoteAgeMs: value.nullable(),
  quoteAt: z.date().nullable(),
  quoteSource: z.enum(RESEARCH_SCREEN_QUOTE_SOURCES).nullable(),
  reasons: rowTexts,
  reportId: z.string(),
  rewardRisk: value.nullable(),
  score: value,
  stop: value.nullable(),
  storedAction: action.nullable(),
  storedScore: value.nullable(),
  support: value.nullable(),
  symbol: z.string(),
  target: value.nullable(),
  warnings: rowTexts,
});

export const ResearchScreenContextSchema = z.strictObject({
  generatedAt: z.date().nullable(),
  lastAttemptAt: z.date().nullable(),
  lastAttemptStatus: z.enum(RESEARCH_SCREEN_ATTEMPT_STATUSES).nullable(),
  lastError: z.string().max(RESEARCH_SCREEN_MAX_CONTEXT_ERROR).nullable(),
  retrievedAt: z.date().nullable(),
  snapshot: SwinglyticsSnapshotSchema.nullable(),
  stale: z.boolean(),
  warning: z.string(),
});

export const ResearchScreenStatusOutputSchema = z.strictObject({
  activeRun: ResearchScreenRunSchema.nullable(),
  evaluatedAt: z.date(),
  lastRun: ResearchScreenRunSchema.nullable(),
  limitations: z.array(z.string()),
  /** Slots of the last 24 hours with no run, newest first. */
  missedSlots: z
    .array(ResearchScreenSlotSchema)
    .max(RESEARCH_SCREEN_MAX_MISSED_SLOTS),
  nextSlots: z
    .array(ResearchScreenSlotSchema)
    .length(RESEARCH_SCREEN_NEXT_SLOTS),
  /** Order: catalog position. */
  rows: z.array(ResearchScreenRowSchema).max(RESEARCH_SCREEN_MAX_ROWS),
  scheduler: z.strictObject({
    lastTickAt: z.date().nullable(),
    lastTickDecision: decision.nullable(),
    state: z.enum(RESEARCH_SCREEN_SCHEDULER_STATES),
  }),
  swinglytics: ResearchScreenContextSchema.nullable(),
});

export type ResearchScreenDecision = (typeof RESEARCH_SCREEN_DECISIONS)[number];
export type ResearchScreenRunStatus =
  (typeof RESEARCH_SCREEN_RUN_STATUSES)[number];
export type ResearchScreenSchedulerState =
  (typeof RESEARCH_SCREEN_SCHEDULER_STATES)[number];
export type ResearchScreenAction = (typeof RESEARCH_SCREEN_ACTIONS)[number];
export type ResearchScreenCollection =
  (typeof RESEARCH_SCREEN_COLLECTIONS)[number];
export type ResearchScreenErrorCode =
  (typeof RESEARCH_SCREEN_ERROR_CODES)[number];
export type ResearchScreenTickOutput = z.infer<
  typeof ResearchScreenTickOutputSchema
>;
export type ResearchScreenSlot = z.infer<typeof ResearchScreenSlotSchema>;
export type ResearchScreenRun = z.infer<typeof ResearchScreenRunSchema>;
export type ResearchScreenRow = z.infer<typeof ResearchScreenRowSchema>;
export type ResearchScreenContext = z.infer<typeof ResearchScreenContextSchema>;
export type ResearchScreenStatusOutput = z.infer<
  typeof ResearchScreenStatusOutputSchema
>;

export const RESEARCH_SCREEN_API_ERRORS = {
  FORBIDDEN: { message: "Forbidden", status: 403 },
  STORAGE_ERROR: {
    message: "Research screen storage unavailable",
    status: 503,
  },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

const researchScreen = oc.errors(RESEARCH_SCREEN_API_ERRORS);
const tags = ["Research screen"];

const tick = researchScreen
  .route({
    method: "POST",
    operationId: "researchScreen.tick",
    path: "/research-screen/tick",
    summary: "Scheduler tick: claim or resume the run of the due slot",
    tags,
  })
  .input(ResearchScreenTickInputSchema)
  .output(ResearchScreenTickOutputSchema);

const status = researchScreen
  .route({
    method: "GET",
    operationId: "researchScreen.status",
    path: "/research-screen/status",
    summary:
      "Scheduler state, runs, slots, stored rows and third-party context",
    tags,
  })
  .input(ResearchScreenStatusInputSchema)
  .output(ResearchScreenStatusOutputSchema);

export const researchScreenContract = { status, tick };
