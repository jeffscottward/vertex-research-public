import {
  RESEARCH_SCREEN_MESSAGE_MAX,
  RESEARCH_SCREEN_SWINGLYTICS_ERROR_MAX,
} from "@darkfactory/db/server";
import { describe, expect, it } from "vitest";

import {
  RESEARCH_SCREEN_API_ERRORS,
  RESEARCH_SCREEN_ERROR_CODES,
  RESEARCH_SCREEN_MAX_CONTEXT_ERROR,
  RESEARCH_SCREEN_MAX_MESSAGE,
  RESEARCH_SCREEN_MAX_MISSED_SLOTS,
  RESEARCH_SCREEN_MAX_ROW_TEXT,
  RESEARCH_SCREEN_MAX_ROW_TEXTS,
  RESEARCH_SCREEN_MAX_ROWS,
  RESEARCH_SCREEN_MAX_SLOT_LABELS,
  ResearchScreenStatusInputSchema,
  ResearchScreenStatusOutputSchema,
  ResearchScreenTickInputSchema,
  ResearchScreenTickOutputSchema,
  researchScreenContract,
} from "./contracts/research-screen.ts";
import { RESEARCH_SCREEN_LIMITS } from "./research-screen.ts";

const routeOf = (procedure: unknown) =>
  (procedure as { ["~orpc"]: { route: { method: string; path: string } } })[
    "~orpc"
  ].route;

// Synthetic sample: invented values.
const at = new Date("2030-01-07T15:00:00Z");

const run = () => ({
  barsFromIbkr: 1,
  barsFromYahoo: 1,
  claimedAt: at,
  deadlineAt: at,
  failed: 0,
  finishedAt: null,
  id: "run-1",
  message: null,
  notReached: 0,
  slotAt: at,
  slotLabels: ["open"],
  status: "running",
  succeeded: 2,
  total: 2,
});

const row = () => ({
  action: "watch",
  barsSource: "ibkr",
  blockingWarnings: [{ code: "old-quote", text: "The quote is old." }],
  buyZone: { high: 11, low: 10 },
  changePercent: 1.5,
  collection: "fresh",
  errorCode: null,
  errorMessage: null,
  historyAt: at,
  lastAttemptAt: at,
  lastAttemptRunId: "run-1",
  lastGoodAt: at,
  lastGoodRunId: "run-1",
  momentumPercent: 2.5,
  price: 10.5,
  providerSymbol: "TEST",
  quoteAgeMs: 1000,
  quoteAt: at,
  quoteSource: "yahoo",
  reasons: ["A reason."],
  reportId: "report-1",
  rewardRisk: 2,
  score: 60,
  stop: 9,
  storedAction: "review-entry",
  storedScore: 70,
  support: 9.5,
  symbol: "TEST",
  target: 13,
  warnings: ["A warning."],
});

const snapshot = () => ({
  breadth: {
    above20DayPercent: 40,
    above50DayPercent: 50,
    above200DayPercent: 60,
    regime: "Neutral",
    score: 55,
  },
  regime: { label: "Test Regime", riskLevel: null, trendStrength: null },
  scanner: { bearish: 1, bullish: 2, total: 100, withSetups: 3 },
  setups: [
    {
      direction: "bullish",
      name: null,
      pattern: null,
      sector: null,
      ticker: "AAA",
    },
  ],
  themes: [{ bias: null, changePercent: 1, name: "Theme" }],
  vix: { level: 18, percentile1Year: 40, regime: null, trend: null },
});

const status = () => ({
  activeRun: run(),
  evaluatedAt: at,
  lastRun: { ...run(), finishedAt: at, message: "Done.", status: "partial" },
  limitations: ["A limitation."],
  missedSlots: [{ at, labels: ["close"] }],
  nextSlots: Array.from({ length: 12 }, () => ({ at, labels: ["open"] })),
  rows: [row()],
  scheduler: { lastTickAt: at, lastTickDecision: "claimed", state: "ok" },
  swinglytics: {
    generatedAt: at,
    lastAttemptAt: at,
    lastAttemptStatus: "ok",
    lastError: null,
    retrievedAt: at,
    snapshot: snapshot(),
    stale: false,
    warning: "A warning.",
  },
});

const tick = () => ({
  decision: "claimed",
  done: false,
  processed: 1,
  remaining: 1,
  requestId: "request-1",
  runId: "run-1",
  runStatus: "running",
  slotAt: at,
  slotLabels: ["open"],
  total: 2,
});

const statusAccepts = (sample: unknown): boolean =>
  ResearchScreenStatusOutputSchema.safeParse(sample).success;

describe("research screen contract", () => {
  it("routes the tick as a POST and the status as a GET", () => {
    expect(routeOf(researchScreenContract.tick)).toMatchObject({
      method: "POST",
      path: "/research-screen/tick",
    });
    expect(routeOf(researchScreenContract.status)).toMatchObject({
      method: "GET",
      path: "/research-screen/status",
    });
    expect(Object.keys(researchScreenContract).sort()).toEqual([
      "status",
      "tick",
    ]);
  });

  it("pins the API errors and the 9 row error codes", () => {
    expect(RESEARCH_SCREEN_API_ERRORS).toEqual({
      FORBIDDEN: { message: "Forbidden", status: 403 },
      STORAGE_ERROR: {
        message: "Research screen storage unavailable",
        status: 503,
      },
      UNAUTHORIZED: { message: "Authentication required", status: 401 },
    });
    expect(RESEARCH_SCREEN_ERROR_CODES).toHaveLength(9);
    for (const errorCode of RESEARCH_SCREEN_ERROR_CODES) {
      expect(
        statusAccepts({ ...status(), rows: [{ ...row(), errorCode }] })
      ).toBe(true);
    }
  });

  it("refuses an extra key in both inputs", () => {
    expect(ResearchScreenTickInputSchema.safeParse({}).success).toBe(true);
    expect(ResearchScreenTickInputSchema.safeParse({ now: 1 }).success).toBe(
      false
    );
    expect(ResearchScreenStatusInputSchema.safeParse({}).success).toBe(true);
    expect(ResearchScreenStatusInputSchema.safeParse({ now: 1 }).success).toBe(
      false
    );
  });

  it("parses a tick output and the not-due form", () => {
    expect(ResearchScreenTickOutputSchema.parse(tick())).toEqual(tick());
    expect(
      ResearchScreenTickOutputSchema.safeParse({
        ...tick(),
        decision: "not-due",
        done: true,
        processed: 0,
        remaining: 0,
        runId: null,
        runStatus: null,
        slotAt: null,
        slotLabels: [],
        total: 0,
      }).success
    ).toBe(true);
    for (const change of [
      { decision: "due" },
      { runStatus: "done" },
      { slotAt: "2030-01-07T15:00:00Z" },
      { processed: -1 },
      { extra: 1 },
    ]) {
      expect(
        ResearchScreenTickOutputSchema.safeParse({ ...tick(), ...change })
          .success
      ).toBe(false);
    }
  });

  it("parses a full status and the empty form", () => {
    expect(ResearchScreenStatusOutputSchema.parse(status())).toEqual(status());
    expect(
      statusAccepts({
        ...status(),
        activeRun: null,
        lastRun: null,
        missedSlots: [],
        rows: [],
        scheduler: { lastTickAt: null, lastTickDecision: null, state: "never" },
        swinglytics: null,
      })
    ).toBe(true);
  });

  it("refuses one invalid value per enum", () => {
    const base = status();
    const invalid = [
      { ...base, scheduler: { ...base.scheduler, state: "idle" } },
      { ...base, scheduler: { ...base.scheduler, lastTickDecision: "due" } },
      { ...base, activeRun: { ...run(), status: "done" } },
      { ...base, rows: [{ ...row(), collection: "stale" }] },
      { ...base, rows: [{ ...row(), action: "buy" }] },
      { ...base, rows: [{ ...row(), storedAction: "sell" }] },
      { ...base, rows: [{ ...row(), barsSource: "other" }] },
      { ...base, rows: [{ ...row(), quoteSource: "ibkr" }] },
      { ...base, rows: [{ ...row(), errorCode: "unknown" }] },
      {
        ...base,
        swinglytics: { ...base.swinglytics, lastAttemptStatus: "pending" },
      },
      {
        ...base,
        swinglytics: {
          ...base.swinglytics,
          snapshot: {
            ...snapshot(),
            setups: [{ ...snapshot().setups[0], direction: "flat" }],
          },
        },
      },
    ];
    for (const sample of invalid) {
      expect(statusAccepts(sample)).toBe(false);
    }
  });

  it("refuses 11 and 13 next slots", () => {
    const slot = { at, labels: ["open"] };
    for (const length of [11, 13]) {
      expect(
        statusAccepts({
          ...status(),
          nextSlots: Array.from({ length }, () => slot),
        })
      ).toBe(false);
    }
  });

  it("refuses an over-long message", () => {
    const limit = "x".repeat(RESEARCH_SCREEN_MAX_MESSAGE);
    expect(RESEARCH_SCREEN_MAX_MESSAGE).toBe(300);
    expect(
      statusAccepts({
        ...status(),
        lastRun: { ...run(), message: limit },
        rows: [{ ...row(), errorMessage: limit }],
      })
    ).toBe(true);
    expect(
      statusAccepts({
        ...status(),
        lastRun: { ...run(), message: `${limit}x` },
      })
    ).toBe(false);
    expect(
      statusAccepts({
        ...status(),
        rows: [{ ...row(), errorMessage: `${limit}x` }],
      })
    ).toBe(false);
    expect(
      statusAccepts({
        ...status(),
        swinglytics: { ...status().swinglytics, lastError: "x".repeat(241) },
      })
    ).toBe(false);
  });

  it("keeps the bounds that exist in two places equal", () => {
    // The repository cuts to these lengths before it writes; the contract refuses longer texts.
    expect(RESEARCH_SCREEN_MAX_MESSAGE).toBe(RESEARCH_SCREEN_MESSAGE_MAX);
    expect(RESEARCH_SCREEN_MAX_CONTEXT_ERROR).toBe(
      RESEARCH_SCREEN_SWINGLYTICS_ERROR_MAX
    );
    expect(RESEARCH_SCREEN_MAX_CONTEXT_ERROR).toBe(240);
    // The screen cuts its reasons and warnings to these bounds.
    expect(RESEARCH_SCREEN_MAX_ROW_TEXT).toBe(
      RESEARCH_SCREEN_LIMITS.maxMessageLength
    );
    expect(RESEARCH_SCREEN_MAX_ROW_TEXTS).toBe(
      RESEARCH_SCREEN_LIMITS.maxMessages
    );
  });

  it("pins the maxima of the lists", () => {
    expect({
      missedSlots: RESEARCH_SCREEN_MAX_MISSED_SLOTS,
      rows: RESEARCH_SCREEN_MAX_ROWS,
      rowText: RESEARCH_SCREEN_MAX_ROW_TEXT,
      rowTexts: RESEARCH_SCREEN_MAX_ROW_TEXTS,
      slotLabels: RESEARCH_SCREEN_MAX_SLOT_LABELS,
    }).toEqual({
      missedSlots: 24,
      rows: 1000,
      rowText: 400,
      rowTexts: 24,
      slotLabels: 5,
    });
  });

  it("accepts the lists of a row at their maxima and refuses one more", () => {
    const text = "x".repeat(400);
    const texts = (length: number) => Array.from({ length }, () => text);
    const blocking = (length: number) =>
      Array.from({ length }, () => ({ code: "old-quote", text }));
    const withRow = (change: Record<string, unknown>) => ({
      ...status(),
      rows: [{ ...row(), ...change }],
    });
    expect(
      statusAccepts(
        withRow({
          blockingWarnings: blocking(24),
          reasons: texts(24),
          warnings: texts(24),
        })
      )
    ).toBe(true);
    for (const change of [
      { reasons: texts(25) },
      { warnings: texts(25) },
      { blockingWarnings: blocking(25) },
      { reasons: [`${text}x`] },
      { warnings: [`${text}x`] },
      { blockingWarnings: [{ code: "old-quote", text: `${text}x` }] },
    ]) {
      expect(statusAccepts(withRow(change))).toBe(false);
    }
  });

  it("accepts 5 slot labels and refuses 6 in every place", () => {
    const five = ["a", "b", "c", "d", "e"];
    const six = [...five, "f"];
    const slots = (labels: string[]) =>
      Array.from({ length: 12 }, () => ({ at, labels }));
    expect(
      statusAccepts({
        ...status(),
        activeRun: { ...run(), slotLabels: five },
        missedSlots: [{ at, labels: five }],
        nextSlots: slots(five),
      })
    ).toBe(true);
    for (const change of [
      { activeRun: { ...run(), slotLabels: six } },
      { lastRun: { ...run(), slotLabels: six } },
      { missedSlots: [{ at, labels: six }] },
      { nextSlots: slots(six) },
    ]) {
      expect(statusAccepts({ ...status(), ...change })).toBe(false);
    }
    expect(
      ResearchScreenTickOutputSchema.safeParse({ ...tick(), slotLabels: five })
        .success
    ).toBe(true);
    expect(
      ResearchScreenTickOutputSchema.safeParse({ ...tick(), slotLabels: six })
        .success
    ).toBe(false);
  });

  it("accepts 1000 rows and 24 missed slots and refuses one more", () => {
    const rows = (length: number) => Array.from({ length }, () => row());
    const missed = (length: number) =>
      Array.from({ length }, () => ({ at, labels: ["close"] }));
    expect(
      statusAccepts({ ...status(), missedSlots: missed(24), rows: rows(1000) })
    ).toBe(true);
    expect(statusAccepts({ ...status(), rows: rows(1001) })).toBe(false);
    expect(statusAccepts({ ...status(), missedSlots: missed(25) })).toBe(false);
  });

  it("refuses a date given as text", () => {
    expect(
      statusAccepts({ ...status(), evaluatedAt: "2030-01-07T15:00:00Z" })
    ).toBe(false);
  });
});
