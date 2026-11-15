import {
  type ResearchScreenContext,
  type ResearchScreenRow,
  type ResearchScreenRun,
  type ResearchScreenStatusOutput,
  ResearchScreenStatusOutputSchema,
} from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  formatQuoteAge,
  formatScreenTime,
  RESEARCH_SCREEN_PATH,
  toResearchScreenViewModel,
} from "./view-model.ts";

// Synthetic fixtures: fictional symbols and values.
const WINTER = new Date("2026-11-13T14:30:00.000Z");
const SUMMER = new Date("2026-07-14T13:30:00.000Z");

const run = (
  overrides: Partial<ResearchScreenRun> = {}
): ResearchScreenRun => ({
  barsFromIbkr: 10,
  barsFromYahoo: 1,
  claimedAt: new Date("2026-11-13T14:31:00.000Z"),
  deadlineAt: new Date("2026-11-13T15:00:00.000Z"),
  failed: 1,
  finishedAt: null,
  id: "run-1",
  message: null,
  notReached: 46,
  slotAt: WINTER,
  slotLabels: ["open"],
  status: "running",
  succeeded: 11,
  total: 58,
  ...overrides,
});

const row = (
  overrides: Partial<ResearchScreenRow> = {}
): ResearchScreenRow => ({
  action: "watch",
  barsSource: "ibkr",
  blockingWarnings: [],
  buyZone: { high: 103.5, low: 101 },
  changePercent: 1.234,
  collection: "fresh",
  errorCode: null,
  errorMessage: null,
  historyAt: WINTER,
  lastAttemptAt: WINTER,
  lastAttemptRunId: "run-1",
  lastGoodAt: WINTER,
  lastGoodRunId: "run-1",
  momentumPercent: 4,
  price: 102.5,
  providerSymbol: "AAA",
  quoteAgeMs: 11_520_000,
  quoteAt: WINTER,
  quoteSource: "yahoo",
  reasons: ["Price is inside the buy zone"],
  reportId: "AAA",
  rewardRisk: 2.5,
  score: 71.25,
  stop: 98,
  storedAction: "watch",
  storedScore: 70,
  support: 100,
  symbol: "AAA",
  target: 112,
  warnings: ["Earnings in 3 days"],
  ...overrides,
});

const context = (
  overrides: Partial<ResearchScreenContext> = {}
): ResearchScreenContext => ({
  generatedAt: WINTER,
  lastAttemptAt: WINTER,
  lastAttemptStatus: "ok",
  lastError: null,
  retrievedAt: WINTER,
  snapshot: {
    breadth: {
      above20DayPercent: 60,
      above50DayPercent: 55,
      above200DayPercent: 50,
      regime: "healthy",
      score: 64,
    },
    regime: { label: "Uptrend", riskLevel: "low", trendStrength: "strong" },
    scanner: { bearish: 12, bullish: 40, total: 500, withSetups: null },
    setups: [
      {
        direction: "bullish",
        name: "Demo Maker",
        pattern: "flag",
        sector: "Tech",
        ticker: "AAA",
      },
      {
        direction: "bearish",
        name: null,
        pattern: null,
        sector: null,
        ticker: "BBB",
      },
    ],
    themes: [
      { bias: "bullish", changePercent: 1.5, name: "Chips" },
      { bias: null, changePercent: null, name: "Banks" },
      { bias: null, changePercent: -0.5, name: "Energy" },
    ],
    vix: { level: 15.5, percentile1Year: 20, regime: "calm", trend: "down" },
  },
  stale: false,
  warning: "Third-party context only.",
  ...overrides,
});

const status = (
  overrides: Partial<ResearchScreenStatusOutput> = {}
): ResearchScreenStatusOutput => ({
  activeRun: null,
  evaluatedAt: WINTER,
  lastRun: null,
  limitations: ["Research only."],
  missedSlots: [],
  nextSlots: Array.from({ length: 12 }, (_, index) => ({
    at: new Date(WINTER.getTime() + index * 1_800_000),
    labels: index === 0 ? ["open", "half-hour"] : [],
  })),
  rows: [row()],
  scheduler: {
    lastTickAt: WINTER,
    lastTickDecision: "not-due",
    state: "ok",
  },
  swinglytics: context(),
  ...overrides,
});

describe("research screen view-model", () => {
  it("names the path and accepts a fixture of the contract shape", () => {
    expect(RESEARCH_SCREEN_PATH).toBe("/research/screen");
    expect(() =>
      ResearchScreenStatusOutputSchema.parse(status())
    ).not.toThrow();
  });

  it("labels each scheduler state with its tone and last tick", () => {
    const view = (state: ResearchScreenStatusOutput["scheduler"]["state"]) =>
      toResearchScreenViewModel(
        status({
          scheduler: { lastTickAt: WINTER, lastTickDecision: null, state },
        })
      ).scheduler;
    expect(view("ok")).toEqual({
      label: "Scheduler running",
      lastTick: "Nov 13, 09:30 ET (14:30 UTC)",
      tone: "success",
    });
    expect(view("late")).toMatchObject({
      label: "Scheduler late",
      tone: "warning",
    });
    expect(view("silent")).toMatchObject({
      label: "Scheduler silent",
      tone: "destructive",
    });
    expect(
      toResearchScreenViewModel(
        status({
          scheduler: {
            lastTickAt: null,
            lastTickDecision: null,
            state: "never",
          },
        })
      ).scheduler
    ).toEqual({
      label: "No tick yet",
      lastTick: "No tick recorded",
      tone: "neutral",
    });
  });

  it("formats slots in New York time in winter and in summer", () => {
    expect(formatScreenTime(WINTER)).toBe("Nov 13, 09:30 ET (14:30 UTC)");
    expect(formatScreenTime(SUMMER)).toBe("Jul 14, 09:30 ET (13:30 UTC)");
    const view = toResearchScreenViewModel(
      status({ missedSlots: [{ at: SUMMER, labels: ["open"] }] })
    );
    expect(view.missedSlots).toEqual([
      {
        key: "2026-07-14T13:30:00.000Z",
        labels: "open",
        time: "Jul 14, 09:30 ET (13:30 UTC)",
      },
    ]);
    expect(view.nextSlots).toHaveLength(12);
    expect(view.nextSlots[0]).toEqual({
      key: "2026-11-13T14:30:00.000Z",
      labels: "open, half-hour",
      time: "Nov 13, 09:30 ET (14:30 UTC)",
    });
    expect(view.nextSlots[1]?.labels).toBe("");
  });

  it("shows a run in progress with its progress and a finished run without", () => {
    const view = toResearchScreenViewModel(
      status({
        activeRun: run(),
        lastRun: run({
          failed: 0,
          finishedAt: new Date("2026-11-13T14:10:00.000Z"),
          id: "run-0",
          message: "All reports screened",
          notReached: 0,
          slotLabels: ["open", "half-hour"],
          status: "completed",
          succeeded: 58,
        }),
      })
    );
    expect(view.activeRun).toEqual({
      detail: "11 succeeded, 1 failed, 46 not reached; bars: 10 IBKR, 1 Yahoo",
      id: "run-1",
      message: null,
      progressPercent: 21,
      slotLabels: "open",
      statusLabel: "In progress",
      timing:
        "Claimed Nov 13, 09:31 ET (14:31 UTC); deadline Nov 13, 10:00 ET (15:00 UTC)",
      title: "Run of Nov 13, 09:30 ET (14:30 UTC): 12 of 58 reports",
      tone: "info",
    });
    expect(view.lastRun).toMatchObject({
      message: "All reports screened",
      progressPercent: null,
      slotLabels: "open, half-hour",
      statusLabel: "Completed",
      timing: "Finished Nov 13, 09:10 ET (14:10 UTC)",
      title: "Run of Nov 13, 09:30 ET (14:30 UTC): 58 of 58 reports",
      tone: "success",
    });
  });

  it("labels each run status and handles an empty run and no run", () => {
    const label = (state: ResearchScreenRun["status"]) =>
      toResearchScreenViewModel(status({ lastRun: run({ status: state }) }))
        .lastRun?.statusLabel;
    expect(label("partial")).toBe("Partial");
    expect(label("failed")).toBe("Failed");
    expect(label("interrupted")).toBe("Interrupted");
    const empty = toResearchScreenViewModel(
      status({ activeRun: run({ failed: 0, succeeded: 0, total: 0 }) })
    );
    expect(empty.activeRun?.progressPercent).toBe(0);
    const none = toResearchScreenViewModel(status());
    expect(none.activeRun).toBeNull();
    expect(none.lastRun).toBeNull();
  });

  it("labels each action and shows the stored action only when it differs", () => {
    const view = toResearchScreenViewModel(
      status({
        rows: [
          row({ action: "review-entry", storedAction: "wait" }),
          row({ action: "watch", storedAction: "watch" }),
          row({ action: "wait", storedAction: null }),
          row({ action: "unavailable", storedAction: "review-entry" }),
        ],
      })
    );
    expect(
      view.rows.map((item) => [
        item.actionLabel,
        item.actionTone,
        item.storedActionLabel,
      ])
    ).toEqual([
      ["Review entry", "success", "Wait"],
      ["Watch", "info", null],
      ["Wait", "neutral", null],
      ["No current data", "warning", "Review entry"],
    ]);
  });

  it("turns a fresh row into display texts", () => {
    expect(toResearchScreenViewModel(status()).rows[0]).toEqual({
      actionLabel: "Watch",
      actionTone: "info",
      blockingWarnings: [],
      buyZone: "101.00 to 103.50",
      change: "+1.23 %",
      collectionNote: null,
      errorCode: null,
      id: "AAA",
      price: "102.50",
      quoteAge: "3 h 12 min",
      reasons: ["Price is inside the buy zone"],
      rewardRisk: "2.50",
      score: "71.3",
      sources: "IBKR bars, Yahoo quote",
      stop: "98.00",
      storedActionLabel: null,
      support: "100.00",
      symbol: "AAA",
      target: "112.00",
      warnings: ["Earnings in 3 days"],
    });
  });

  it("explains failed and never collected rows and null levels", () => {
    const view = toResearchScreenViewModel(
      status({
        rows: [
          row({
            blockingWarnings: [{ code: "stale-quote", text: "Quote is old" }],
            changePercent: -2,
            collection: "failed",
            errorCode: "provider-timeout",
          }),
          row({ barsSource: "yahoo", collection: "failed", lastGoodAt: null }),
          row({
            barsSource: null,
            buyZone: null,
            changePercent: null,
            collection: "never",
            price: null,
            quoteAgeMs: null,
            quoteSource: null,
            rewardRisk: null,
            stop: null,
            support: null,
            target: null,
          }),
        ],
      })
    );
    expect(view.rows[0]).toMatchObject({
      blockingWarnings: ["Quote is old"],
      change: "-2.00 %",
      collectionNote:
        "Latest collection failed; values are from Nov 13, 09:30 ET (14:30 UTC)",
      errorCode: "provider-timeout",
    });
    expect(view.rows[1]).toMatchObject({
      collectionNote: "Latest collection failed; no earlier values are stored",
      sources: "Yahoo bars, Yahoo quote",
    });
    expect(view.rows[2]).toMatchObject({
      buyZone: "none",
      change: "none",
      collectionNote: "Not collected yet",
      price: "none",
      quoteAge: "no quote",
      rewardRisk: "none",
      sources: "no source",
      stop: "none",
      support: "none",
      target: "none",
    });
  });

  it("formats the quote age", () => {
    expect(formatQuoteAge(null)).toBe("no quote");
    expect(formatQuoteAge(720_000)).toBe("12 min");
    expect(formatQuoteAge(-5)).toBe("0 min");
    expect(formatQuoteAge(3_600_000)).toBe("1 h 0 min");
  });

  it("builds the context panel from a snapshot", () => {
    expect(toResearchScreenViewModel(status()).context).toEqual({
      generated: "Nov 13, 09:30 ET (14:30 UTC)",
      lastError: null,
      retrieved: "Nov 13, 09:30 ET (14:30 UTC)",
      snapshot: {
        groups: [
          {
            items: [
              { label: "Label", value: "Uptrend" },
              { label: "Trend strength", value: "strong" },
              { label: "Risk level", value: "low" },
            ],
            title: "Regime",
          },
          {
            items: [
              { label: "Score", value: "64" },
              { label: "Regime", value: "healthy" },
              { label: "Above 20-day average", value: "60.0 %" },
              { label: "Above 50-day average", value: "55.0 %" },
              { label: "Above 200-day average", value: "50.0 %" },
            ],
            title: "Breadth",
          },
          {
            items: [
              { label: "Level", value: "15.50" },
              { label: "1-year percentile", value: "20" },
              { label: "Regime", value: "calm" },
              { label: "Trend", value: "down" },
            ],
            title: "VIX",
          },
          {
            items: [
              { label: "Scanned", value: "500" },
              { label: "With setups", value: "none" },
              { label: "Bullish", value: "40" },
              { label: "Bearish", value: "12" },
            ],
            title: "Scanner",
          },
        ],
        setups: [
          {
            direction: "Bullish",
            name: "Demo Maker",
            pattern: "flag",
            sector: "Tech",
            ticker: "AAA",
          },
          {
            direction: "Bearish",
            name: "none",
            pattern: "none",
            sector: "none",
            ticker: "BBB",
          },
        ],
        themes: [
          { bias: "bullish", change: "+1.50 %", name: "Chips" },
          { bias: "none", change: "none", name: "Banks" },
          { bias: "none", change: "-0.50 %", name: "Energy" },
        ],
      },
      stale: false,
      warning: "Third-party context only.",
    });
  });

  it("shows the word for a missing value in every empty snapshot field", () => {
    const view = toResearchScreenViewModel(
      status({
        swinglytics: context({
          snapshot: {
            breadth: {
              above20DayPercent: null,
              above50DayPercent: null,
              above200DayPercent: null,
              regime: null,
              score: null,
            },
            regime: { label: "Range", riskLevel: null, trendStrength: null },
            scanner: {
              bearish: null,
              bullish: null,
              total: null,
              withSetups: null,
            },
            setups: [],
            themes: [],
            vix: {
              level: null,
              percentile1Year: null,
              regime: null,
              trend: null,
            },
          },
        }),
      })
    ).context?.snapshot;
    expect(
      view?.groups.map((group) => [
        group.title,
        group.items.map((item) => item.value),
      ])
    ).toEqual([
      ["Regime", ["Range", "none", "none"]],
      ["Breadth", ["none", "none", "none", "none", "none"]],
      ["VIX", ["none", "none", "none", "none"]],
      ["Scanner", ["none", "none", "none", "none"]],
    ]);
    expect(view?.setups).toEqual([]);
    expect(view?.themes).toEqual([]);
  });

  it("shows a row whose latest collection failed with its last good values", () => {
    const view = toResearchScreenViewModel(
      status({
        rows: [
          row({
            action: "unavailable",
            collection: "failed",
            errorCode: "provider-http",
            errorMessage: "Provider answered 502",
            lastAttemptAt: SUMMER,
            score: 0,
            storedAction: "review-entry",
            storedScore: 71.25,
          }),
        ],
      })
    ).rows[0];
    expect(view).toMatchObject({
      actionLabel: "No current data",
      actionTone: "warning",
      buyZone: "101.00 to 103.50",
      collectionNote:
        "Latest collection failed; values are from Nov 13, 09:30 ET (14:30 UTC)",
      errorCode: "provider-http",
      price: "102.50",
      score: "0.0",
      storedActionLabel: "Review entry",
      target: "112.00",
    });
  });

  it("keeps a stale snapshot, a missing snapshot and no context apart", () => {
    const stale = toResearchScreenViewModel(
      status({
        swinglytics: context({ lastError: "HTTP 503", stale: true }),
      })
    ).context;
    expect(stale).toMatchObject({ lastError: "HTTP 503", stale: true });
    expect(stale?.snapshot).not.toBeNull();
    expect(
      toResearchScreenViewModel(
        status({
          swinglytics: context({
            generatedAt: null,
            retrievedAt: null,
            snapshot: null,
          }),
        })
      ).context
    ).toMatchObject({
      generated: "not recorded",
      retrieved: "not recorded",
      snapshot: null,
    });
    expect(
      toResearchScreenViewModel(status({ swinglytics: null })).context
    ).toBeNull();
    expect(toResearchScreenViewModel(status()).limitations).toEqual([
      "Research only.",
    ]);
  });
});
