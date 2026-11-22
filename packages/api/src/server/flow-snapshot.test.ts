import { describe, expect, it } from "vitest";

import {
  FLOW_SNAPSHOT_MAX_EVENTS,
  FLOW_SNAPSHOT_MAX_PRINTS,
  type FlowFreshness,
  FlowSnapshotSchema,
} from "../contracts/flow.ts";
import type {
  FlowBookRow,
  FlowEventRow,
  FlowMinuteRow,
} from "../flow-features.ts";
import type { FlowOptionPrintRow } from "../flow-options.ts";
import {
  buildConfluence,
  buildFlowSnapshot,
  buildFreshness,
  buildGexView,
  buildMinuteRows,
  buildOptionsSummary,
  type ConfluenceInput,
  confluenceSummary,
  FLOW_STALE_SECONDS,
  FLOW_TAPE_STALE_SECONDS,
  type FlowGexRow,
  type FlowSampleRow,
  type FlowSnapshotRows,
  flowClockText,
  flowSessionDate,
  flowSessionOpen,
  flowStaleSeconds,
  pct,
  vote,
} from "./flow-snapshot.ts";

// New York is on EST (UTC−5) from 2026-11-01, so these November instants are NY time + 5 h.
// 2026-11-09 is a Monday. The July instants use EDT (UTC−4).
const MON_10_00 = new Date("2026-11-09T15:00:00Z");
const MON_09_00 = new Date("2026-11-09T14:00:00Z");
const MON_16_15 = new Date("2026-11-09T21:15:00Z");
const MON_17_30 = new Date("2026-11-09T22:30:00Z");
const MON_18_30 = new Date("2026-11-09T23:30:00Z");
const MON_20_30 = new Date("2026-11-10T01:30:00Z");
const FRI_16_59 = new Date("2026-11-13T21:59:00Z");
const FRI_17_00 = new Date("2026-11-13T22:00:00Z");
const SAT_10_00 = new Date("2026-11-14T15:00:00Z");
const SUN_17_59 = new Date("2026-11-15T22:59:00Z");
const SUN_18_00 = new Date("2026-11-15T23:00:00Z");
const JUL_MON_09_30_EDT = new Date("2026-07-13T13:30:00Z");
const JUL_MON_09_29_EDT = new Date("2026-07-13T13:29:00Z");

const minuteRow = (
  minute: Date,
  overrides: Partial<FlowMinuteRow> = {}
): FlowMinuteRow => ({
  absorption: null,
  buyVolume: 60,
  close: 100,
  coveredSeconds: 60,
  delta: 20,
  high: 101,
  largePrints: 1,
  largePrintVolume: 0,
  low: 99,
  minute,
  offExchangeVolume: 10,
  open: 100,
  sellVolume: 40,
  stackedBuy: 0,
  stackedSell: 0,
  symbol: "SPY",
  trades: 5,
  volume: 100,
  vwap: 100,
  ...overrides,
});

const printRow = (
  tradedAt: Date,
  overrides: Partial<FlowOptionPrintRow> = {}
): FlowOptionPrintRow => ({
  ask: 2.1,
  bid: 2,
  consolidation: "sweep",
  dte: 0,
  expiry: "2026-11-09",
  goldenSweep: false,
  id: "p",
  iv: 0.2,
  moneyness: "otm",
  moneynessPct: 1,
  openInterest: 10,
  opening: true,
  premium: 1000,
  price: 2.05,
  right: "call",
  sentiment: "bullish",
  side: "ask",
  size: 5,
  strike: 600,
  symbol: "SPY",
  ticker: "SPY",
  tradedAt,
  underlyingPrice: 599,
  unusual: true,
  volume: 20,
  volumeOverOi: true,
  ...overrides,
});

const bookRow = (at: Date, pressure: number | null): FlowBookRow => ({
  askSize: 100,
  at,
  bestAsk: 101,
  bestBid: 100,
  bidSize: 300,
  levels: 4,
  pressure,
  symbol: "SPY",
});

const gexRow = (overrides: Partial<FlowGexRow> = {}): FlowGexRow => ({
  at: MON_10_00,
  basis: 10,
  callWall: 610,
  flip: 595,
  ivRegime: "contango",
  maxPain: 600,
  netDex: 5,
  putWall: 590,
  regime: "positive",
  spot: 600,
  symbol: "ES",
  ticker: "SPX",
  totalGex: 1e9,
  zeroDteShare: 0.3,
  ...overrides,
});

const sample = (
  source: FlowSampleRow["source"],
  at: Date,
  status: FlowSampleRow["status"] = "ok",
  message: string | null = null
): FlowSampleRow => ({ at, items: 1, message, source, status, symbol: "SPY" });

const ago = (seconds: number): Date =>
  new Date(MON_10_00.getTime() - seconds * 1000);

const rowsOf = (
  overrides: Partial<FlowSnapshotRows> = {}
): FlowSnapshotRows => ({
  books: [],
  events: [],
  gex: null,
  latest: [],
  latestOk: [],
  minutes: [],
  now: MON_10_00,
  prints: [],
  symbol: "SPY",
  windowEnd: MON_10_00,
  windowStart: ago(3600),
  ...overrides,
});

describe("flowSessionOpen", () => {
  it("opens options and gex 09:30-16:15 on weekdays only", () => {
    for (const source of ["options", "gex"] as const) {
      expect(flowSessionOpen(source, "SPY", MON_10_00)).toBe(true);
      expect(flowSessionOpen(source, "ES", MON_09_00)).toBe(false);
      expect(flowSessionOpen(source, "SPY", MON_16_15)).toBe(false);
      expect(flowSessionOpen(source, "SPY", SAT_10_00)).toBe(false);
      expect(flowSessionOpen(source, "ES", SUN_18_00)).toBe(false);
      expect(flowSessionOpen(source, "SPY", JUL_MON_09_30_EDT)).toBe(true);
      expect(flowSessionOpen(source, "SPY", JUL_MON_09_29_EDT)).toBe(false);
    }
  });

  it("follows the extended equity session for SPY ticks and depth", () => {
    for (const source of ["ticks", "depth"] as const) {
      expect(flowSessionOpen(source, "SPY", MON_09_00)).toBe(true);
      expect(flowSessionOpen(source, "SPY", MON_17_30)).toBe(true);
      expect(flowSessionOpen(source, "SPY", MON_20_30)).toBe(false);
      expect(flowSessionOpen(source, "SPY", SAT_10_00)).toBe(false);
    }
  });

  it("follows the CME Globex week for ES ticks and depth", () => {
    for (const source of ["ticks", "depth"] as const) {
      expect(flowSessionOpen(source, "ES", SAT_10_00)).toBe(false);
      expect(flowSessionOpen(source, "ES", SUN_17_59)).toBe(false);
      expect(flowSessionOpen(source, "ES", SUN_18_00)).toBe(true);
      expect(flowSessionOpen(source, "ES", FRI_16_59)).toBe(true);
      expect(flowSessionOpen(source, "ES", FRI_17_00)).toBe(false);
      expect(flowSessionOpen(source, "ES", MON_10_00)).toBe(true);
      expect(flowSessionOpen(source, "ES", MON_17_30)).toBe(false);
      expect(flowSessionOpen(source, "ES", MON_18_30)).toBe(true);
      expect(flowSessionOpen(source, "ES", MON_20_30)).toBe(true);
    }
  });
});

describe("buildFreshness", () => {
  it("reports never, stale and fresh while open", () => {
    const freshness = buildFreshness(
      rowsOf({
        latest: [
          sample("ticks", ago(10), "unavailable", "boom"),
          sample("depth", ago(FLOW_STALE_SECONDS.depth + 1)),
        ],
        latestOk: [
          sample("ticks", ago(-5)),
          sample("depth", ago(FLOW_STALE_SECONDS.depth + 1)),
          sample("options", ago(FLOW_STALE_SECONDS.options)),
        ],
      })
    );
    expect(freshness).toEqual([
      {
        ageSeconds: 0,
        lastOkAt: ago(-5).toISOString(),
        lastStatus: "unavailable",
        message: "boom",
        sessionOpen: true,
        source: "ticks",
        state: "fresh",
      },
      {
        ageSeconds: FLOW_STALE_SECONDS.depth + 1,
        lastOkAt: ago(FLOW_STALE_SECONDS.depth + 1).toISOString(),
        lastStatus: "ok",
        message: null,
        sessionOpen: true,
        source: "depth",
        state: "stale",
      },
      {
        ageSeconds: FLOW_STALE_SECONDS.options,
        lastOkAt: ago(FLOW_STALE_SECONDS.options).toISOString(),
        lastStatus: null,
        message: null,
        sessionOpen: true,
        source: "options",
        state: "fresh",
      },
      {
        ageSeconds: null,
        lastOkAt: null,
        lastStatus: null,
        message: null,
        sessionOpen: true,
        source: "gex",
        state: "never",
      },
    ]);
  });

  it("uses the tape stale limit for the streamed ticks of ES and NQ only", () => {
    expect(FLOW_TAPE_STALE_SECONDS).toBe(180);
    expect(flowStaleSeconds("ticks", "ES")).toBe(180);
    expect(flowStaleSeconds("ticks", "NQ")).toBe(180);
    expect(flowStaleSeconds("ticks", "SPY")).toBe(FLOW_STALE_SECONDS.ticks);
    expect(FLOW_STALE_SECONDS.ticks).toBe(600);
    // Every other source of a stream instrument keeps the limit of its source.
    for (const source of ["depth", "gex", "net_drift", "options"] as const)
      expect(flowStaleSeconds(source, "ES")).toBe(FLOW_STALE_SECONDS[source]);
  });

  it("calls streamed ticks stale after 180 s and sampled ticks after 600 s", () => {
    const ticksState = (symbol: "ES" | "SPY", ageSeconds: number) =>
      buildFreshness(
        rowsOf({ latestOk: [sample("ticks", ago(ageSeconds))], symbol })
      ).find((entry) => entry.source === "ticks")?.state;
    expect(ticksState("ES", FLOW_TAPE_STALE_SECONDS)).toBe("fresh");
    expect(ticksState("ES", FLOW_TAPE_STALE_SECONDS + 1)).toBe("stale");
    expect(ticksState("SPY", FLOW_TAPE_STALE_SECONDS + 1)).toBe("fresh");
    expect(ticksState("SPY", FLOW_STALE_SECONDS.ticks + 1)).toBe("stale");
  });

  it("reports closed outside the session regardless of age", () => {
    const freshness = buildFreshness(
      rowsOf({ latestOk: [sample("gex", ago(99_999))], now: SAT_10_00 })
    );
    expect(freshness.find((entry) => entry.source === "gex")?.state).toBe(
      "closed"
    );
  });
});

describe("vote and pct", () => {
  it("votes by threshold", () => {
    expect(vote(null, 0.1)).toBe("no_data");
    expect(vote(0.1, 0.1)).toBe("bullish");
    expect(vote(-0.1, 0.1)).toBe("bearish");
    expect(vote(0.05, 0.1)).toBe("neutral");
  });

  it("formats signed percentages", () => {
    expect(pct(0)).toBe("+0%");
    expect(pct(0.256)).toBe("+26%");
    expect(pct(-0.1)).toBe("-10%");
  });
});

describe("confluenceSummary", () => {
  it("covers every reading", () => {
    expect(confluenceSummary(2, 0, 1)).toBe("insufficient");
    expect(confluenceSummary(1, 1, 2)).toBe("disagree");
    expect(confluenceSummary(2, 0, 2)).toBe("agree_bullish");
    expect(confluenceSummary(0, 2, 3)).toBe("agree_bearish");
    expect(confluenceSummary(1, 0, 3)).toBe("neutral");
  });
});

describe("buildConfluence", () => {
  const allUsable = { depth: true, gex: true, options: true, ticks: true };
  const noneUsable = { depth: false, gex: false, options: false, ticks: false };
  const freshnessOf = (
    source: FlowFreshness["source"],
    overrides: Partial<FlowFreshness> = {}
  ): FlowFreshness => ({
    ageSeconds: 30,
    lastOkAt: ago(30).toISOString(),
    lastStatus: "ok",
    message: null,
    sessionOpen: true,
    source,
    state: "fresh",
    ...overrides,
  });
  const allFresh = (["ticks", "depth", "options", "gex"] as const).map(
    (source) => freshnessOf(source)
  );
  const input = (
    overrides: Partial<ConfluenceInput> = {}
  ): ConfluenceInput => ({
    deltaRatio: 0.2,
    freshness: allFresh,
    gex: gexRow(),
    lastPrice: 6000,
    now: MON_10_00,
    premiumBias: 0.2,
    pressure: 0.3,
    symbol: "SPY",
    usable: allUsable,
    ...overrides,
  });
  const NO_VOTE_DETAIL =
    " The freshness table shows the last collector message; the next collector run retries.";

  it("agrees bullish with a GEX context factor above the flip", () => {
    const confluence = buildConfluence(input());
    expect(confluence).toMatchObject({
      bearish: 0,
      bullish: 3,
      known: 3,
      label: "Flows agree: bullish",
      summary: "agree_bullish",
    });
    expect(
      confluence.factors.map((factor) => [factor.key, factor.value])
    ).toEqual([
      ["order_flow", "+20%"],
      ["book", "+30%"],
      ["options_flow", "+20%"],
      ["gex", "positive gamma, price above flip 605.00"],
    ]);
    // The GEX factor gives background: it has no vote and is outside the count.
    expect(confluence.factors[3]?.vote).toBe("context");
    expect(confluence.factors[0]?.detail).not.toContain("freshness table");
  });

  it("names the state of each source that gives no vote", () => {
    const confluence = buildConfluence(
      input({
        freshness: [
          // No entry for ticks: the symbol does not collect them.
          freshnessOf("depth", {
            ageSeconds: null,
            lastOkAt: null,
            lastStatus: null,
            state: "never",
          }),
          freshnessOf("options", {
            ageSeconds: 7200,
            lastOkAt: ago(7200).toISOString(),
            lastStatus: "unavailable",
            state: "stale",
          }),
          freshnessOf("gex", { state: "stale" }),
        ],
        usable: noneUsable,
      })
    );
    expect(confluence).toMatchObject({
      bearish: 0,
      bullish: 0,
      known: 0,
      label: "Not enough fresh data",
      summary: "insufficient",
    });
    expect(
      confluence.factors.map((factor) => [factor.value, factor.vote])
    ).toEqual([
      ["No vote: not collected for SPY", "no_data"],
      ["No vote: never collected", "no_data"],
      ["No vote: source failed; last good 13:00 UTC", "no_data"],
      ["Stale since 15:00 UTC; last: positive gamma", "context"],
    ]);
    expect(confluence.factors[0]?.detail).toBe(
      `Signed volume (buys − sells) ÷ volume over the stored minutes of the last 15 min; ±10% or more counts.${NO_VOTE_DETAIL}`
    );
    expect(confluence.factors[1]?.detail).toBe(
      `Resting bid size vs ask size in the newest book snapshot (top 10 rows); ±20% or more counts. Resting size can be pulled.${NO_VOTE_DETAIL}`
    );
    expect(confluence.factors[2]?.detail).toBe(
      `QuantData bullish minus bearish premium over the last 30 minutes, as a share of both; ±15% or more counts.${NO_VOTE_DETAIL}`
    );
    for (const factor of confluence.factors) {
      expect(factor.value.length).toBeLessThanOrEqual(80);
      expect(factor.detail.length).toBeLessThanOrEqual(300);
    }
  });

  it("adds the date to a last good time of another UTC day", () => {
    const stale = (lastStatus: FlowFreshness["lastStatus"]) =>
      buildConfluence(
        input({
          freshness: [
            freshnessOf("ticks", {
              lastOkAt: "2026-11-08T14:05:00.000Z",
              lastStatus,
              state: "stale",
            }),
          ],
          usable: noneUsable,
        })
      ).factors[0]?.value;
    // The longest new value text (rule 7): 54 characters.
    expect(stale("unavailable")).toBe(
      "No vote: source failed; last good 2026-11-08 14:05 UTC"
    );
    expect(stale("unavailable")).toHaveLength(54);
    expect(stale("empty")).toBe(
      "No vote: sample stale; last good 2026-11-08 14:05 UTC"
    );
    expect(stale(null)).toBe(
      "No vote: sample stale; last good 2026-11-08 14:05 UTC"
    );
  });

  it("names the missing input of a usable source", () => {
    const confluence = buildConfluence(
      input({ deltaRatio: null, premiumBias: null, pressure: null })
    );
    expect(confluence.known).toBe(0);
    expect(
      confluence.factors
        .slice(0, 3)
        .map((factor) => [factor.value, factor.vote])
    ).toEqual([
      ["No vote: no trades in last 15 min", "no_data"],
      ["No vote: no book sizes in newest snapshot", "no_data"],
      ["No vote: no signed premium in last 30 min", "no_data"],
    ]);
    expect(confluence.factors[0]?.detail).toContain(NO_VOTE_DETAIL);
  });

  it("counts a neutral vote as known and a missing one as not known", () => {
    const confluence = buildConfluence(
      input({ deltaRatio: 0, premiumBias: null, pressure: -0.5 })
    );
    expect(confluence.factors.map((factor) => factor.vote)).toEqual([
      "neutral",
      "bearish",
      "no_data",
      "context",
    ]);
    expect(confluence.known).toBe(2);
  });

  it("describes gex value variants", () => {
    const gexValue = (overrides: Partial<ConfluenceInput>) =>
      buildConfluence(input(overrides)).factors[3]?.value;
    expect(
      gexValue({
        freshness: allFresh.filter((entry) => entry.source !== "gex"),
        gex: null,
      })
    ).toBe("Not collected for SPY");
    expect(gexValue({ gex: null })).toBe("No GEX stored yet");
    // Guard: the collector stores no row without a sign, so no producer exists today.
    expect(gexValue({ gex: gexRow({ regime: "unknown" }) })).toBe(
      "Not computed: no GEX estimate"
    );
    expect(
      gexValue({
        gex: gexRow({
          at: new Date("2026-11-06T20:55:00Z"),
          regime: "negative",
        }),
        usable: { ...allUsable, gex: false },
      })
    ).toBe("Stale since 2026-11-06 20:55 UTC; last: negative gamma");
    expect(gexValue({ gex: gexRow({ basis: null }) })).toBe("positive gamma");
    expect(gexValue({ gex: gexRow({ flip: null }) })).toBe("positive gamma");
    expect(gexValue({ lastPrice: null })).toBe("positive gamma");
    expect(
      gexValue({ gex: gexRow({ regime: "negative" }), lastPrice: 600 })
    ).toBe("negative gamma, price below flip 605.00");
  });

  it("reports disagreement and bearish agreement", () => {
    expect(buildConfluence(input({ pressure: -0.5 })).summary).toBe("disagree");
    expect(
      buildConfluence(
        input({ deltaRatio: -0.5, premiumBias: -0.5, pressure: 0 })
      ).label
    ).toBe("Flows agree: bearish");
  });
});

describe("buildMinuteRows", () => {
  it("merges trade, option and book minutes with running CVD", () => {
    const m0 = new Date("2026-11-09T14:58:00Z");
    const m1 = new Date("2026-11-09T14:59:00Z");
    const m2 = new Date("2026-11-09T15:00:00Z");
    const rows = buildMinuteRows(
      [minuteRow(m2, { delta: -5 }), minuteRow(m0)],
      [
        printRow(new Date(m1.getTime() + 10_000)),
        printRow(new Date(m1.getTime() + 20_000), {
          premium: 500,
          right: "put",
          sentiment: "bearish",
        }),
        printRow(new Date(m2.getTime() + 1000), { sentiment: "neutral" }),
      ],
      [bookRow(new Date(m0.getTime() + 5000), 0.5)]
    );
    expect(rows.map((row) => row.minute)).toEqual([
      m0.toISOString(),
      m1.toISOString(),
      m2.toISOString(),
    ]);
    expect(rows.map((row) => row.cvd)).toEqual([20, 20, 15]);
    expect(rows[0]).toMatchObject({ bookPressure: 0.5, optionTrades: 0 });
    expect(rows[1]).toEqual({
      bearishPremium: 500,
      bookPressure: null,
      bullishPremium: 1000,
      buyVolume: 0,
      callPremium: 1000,
      close: null,
      coveredSeconds: 0,
      cvd: 20,
      delta: 0,
      minute: m1.toISOString(),
      optionTrades: 2,
      putPremium: 500,
      sellVolume: 0,
      trades: 0,
      volume: 0,
      vwap: null,
    });
    expect(rows[2]).toMatchObject({
      bearishPremium: 0,
      bullishPremium: 0,
      callPremium: 1000,
      close: 100,
      optionTrades: 1,
      trades: 5,
    });
  });
});

describe("buildOptionsSummary", () => {
  it("summarises premium by right, side, type and sentiment", () => {
    const prints = Array.from(
      { length: FLOW_SNAPSHOT_MAX_PRINTS + 1 },
      (_, i) => printRow(MON_10_00, { id: `c${i}`, premium: 100 + i })
    );
    const summary = buildOptionsSummary("SPY", [
      ...prints,
      printRow(MON_10_00, {
        consolidation: "block",
        dte: null,
        moneyness: "itm",
        opening: false,
        premium: 1000,
        right: "put",
        sentiment: "bearish",
        side: "below_bid",
        unusual: false,
        volumeOverOi: false,
      }),
      printRow(MON_10_00, {
        consolidation: "split",
        dte: 3,
        premium: 500,
        right: "put",
        side: "bid",
      }),
      printRow(MON_10_00, { premium: 200, side: "above_ask" }),
      printRow(MON_10_00, { premium: 300, side: "mid" }),
    ]);
    const callBase = prints.reduce((sum, print) => sum + print.premium, 0);
    const call = callBase + 500;
    const total = call + 1500;
    expect(summary).toMatchObject({
      askSidePremium: callBase + 200,
      bearishPremium: 1000,
      bidSidePremium: 1500,
      blockPremium: 1000,
      blocks: 1,
      bullishPremium: callBase + 1000,
      callPremium: call,
      putPremium: 1500,
      sweepPremium: call,
      sweeps: prints.length + 2,
      ticker: "SPY",
      trades: prints.length + 4,
      unusual: prints.length + 3,
      volumeOverOi: prints.length + 3,
    });
    expect(summary.putCallPremiumRatio).toBeCloseTo(1500 / call);
    expect(summary.openingPremiumShare).toBeCloseTo((total - 1000) / total);
    expect(summary.otmPremiumShare).toBeCloseTo((total - 1000) / total);
    expect(summary.zeroDtePremiumShare).toBeCloseTo(call / total);
    expect(summary.topPrints).toHaveLength(FLOW_SNAPSHOT_MAX_PRINTS);
    expect(summary.topPrints[0]).toEqual({
      at: MON_10_00.toISOString(),
      consolidation: "block",
      contract: "SPY 2026-11-09 600P",
      expiry: "2026-11-09",
      goldenSweep: false,
      moneyness: "itm",
      opening: false,
      premium: 1000,
      price: 2.05,
      right: "put",
      sentiment: "bearish",
      side: "below_bid",
      size: 5,
      strike: 600,
      unusual: false,
      volumeOverOi: false,
    });
    expect(summary.topPrints[2]?.contract).toBe("SPY 2026-11-09 600C");
  });

  it("returns null ratios with no prints", () => {
    expect(buildOptionsSummary("SPX", [])).toMatchObject({
      openingPremiumShare: null,
      otmPremiumShare: null,
      putCallPremiumRatio: null,
      topPrints: [],
      trades: 0,
      zeroDtePremiumShare: null,
    });
  });
});

describe("buildGexView", () => {
  it("returns null without gex", () => {
    expect(buildGexView(null)).toBeNull();
  });

  it("shifts levels by the basis", () => {
    expect(buildGexView(gexRow({ maxPain: null }))).toEqual({
      at: MON_10_00.toISOString(),
      basis: 10,
      ivRegime: "contango",
      levels: { callWall: 610, flip: 595, maxPain: null, putWall: 590 },
      netDex: 5,
      regime: "positive",
      spot: 600,
      symbolLevels: { callWall: 620, flip: 605, maxPain: null, putWall: 600 },
      ticker: "SPX",
      totalGex: 1e9,
      zeroDteShare: 0.3,
    });
  });

  it("omits symbol levels without a basis", () => {
    expect(buildGexView(gexRow({ basis: null }))?.symbolLevels).toBeNull();
  });
});

describe("buildFlowSnapshot", () => {
  const event = (seconds: number, detail = "e"): FlowEventRow => ({
    at: ago(seconds),
    detail,
    direction: "bullish",
    key: `k${seconds}`,
    kind: "large_print",
    premium: null,
    price: 100,
    size: 10_000,
    source: "ibkr",
    symbol: "SPY",
  });

  it("assembles a SPY snapshot end to end", () => {
    const fresh = (["ticks", "depth", "options", "gex"] as const).map(
      (source) => sample(source, ago(30))
    );
    const events = Array.from(
      { length: FLOW_SNAPSHOT_MAX_EVENTS + 1 },
      (_, i) => event(i * 10)
    ).reverse();
    events.push(event(5, "x".repeat(300)));
    const snapshot = buildFlowSnapshot(
      rowsOf({
        books: [bookRow(ago(60), 0.5), bookRow(ago(120), -0.5)],
        events,
        latest: fresh,
        latestOk: fresh,
        minutes: [
          minuteRow(ago(60), { close: 101 }),
          minuteRow(ago(20 * 60), { delta: -100 }),
        ],
        prints: [
          printRow(ago(60)),
          printRow(ago(40 * 60), { sentiment: "bearish" }),
        ],
      })
    );
    expect(FlowSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.symbol).toBe("SPY");
    expect(snapshot.generatedAt).toBe(MON_10_00.toISOString());
    expect(snapshot.windowStart).toBe(ago(3600).toISOString());
    expect(snapshot.orderFlow).toMatchObject({
      book: { at: ago(60).toISOString(), pressure: 0.5 },
      coveredSeconds: 120,
      delta: -80,
      deltaRatio: -0.4,
      largePrints: 2,
      lastPrice: 101,
      offExchangeShare: 0.1,
      volume: 200,
      vwap: 100,
      windowSeconds: 3600,
    });
    expect(snapshot.confluence).toMatchObject({
      bullish: 3,
      known: 3,
      summary: "agree_bullish",
    });
    expect(snapshot.optionsFlow.ticker).toBe("SPY");
    expect(snapshot.minutes).toHaveLength(3);
    expect(snapshot.events).toHaveLength(FLOW_SNAPSHOT_MAX_EVENTS);
    expect(snapshot.events[0]?.at).toBe(ago(0).toISOString());
    expect(snapshot.events[1]?.detail).toHaveLength(200);
    expect(snapshot.events.at(-1)?.at).toBe(ago(580).toISOString());
    expect(snapshot.notes[2]).toMatch(/^SPY book is IEX depth/);
    expect(snapshot.notes).toHaveLength(4);
    expect(snapshot.gex).toBeNull();
  });

  it("assembles an empty ES snapshot with SPX context", () => {
    const snapshot = buildFlowSnapshot(
      rowsOf({
        gex: gexRow(),
        latestOk: [sample("gex", ago(99_999))],
        symbol: "ES",
      })
    );
    expect(FlowSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.orderFlow).toMatchObject({
      book: null,
      deltaRatio: null,
      lastPrice: null,
      offExchangeShare: null,
      volume: 0,
      vwap: null,
    });
    expect(snapshot.optionsFlow.ticker).toBe("SPX");
    expect(snapshot.notes[2]).toMatch(/^ES options context uses SPX/);
    expect(snapshot.gex?.symbolLevels?.flip).toBe(605);
    expect(snapshot.confluence.summary).toBe("insufficient");
    expect(snapshot.confluence.factors[3]?.value).toBe(
      "Stale since 15:00 UTC; last: positive gamma"
    );
    expect(snapshot.events).toEqual([]);
    expect(snapshot.minutes).toEqual([]);
  });
});

describe("net drift sessions and four symbols", () => {
  it("opens net drift from 09:30 to 16:20 New York on weekdays", () => {
    expect(flowSessionOpen("net_drift", "QQQ", MON_09_00)).toBe(false);
    expect(flowSessionOpen("net_drift", "QQQ", MON_10_00)).toBe(true);
    expect(flowSessionOpen("net_drift", "NQ", MON_16_15)).toBe(true);
    expect(
      flowSessionOpen("net_drift", "SPY", new Date("2026-11-09T21:20:00Z"))
    ).toBe(false);
    expect(
      flowSessionOpen("net_drift", "SPY", new Date("2026-11-07T15:00:00Z"))
    ).toBe(false);
    expect(
      flowSessionOpen("net_drift", "SPY", new Date("2026-11-08T15:00:00Z"))
    ).toBe(false);
    expect(FLOW_STALE_SECONDS.net_drift).toBe(300);
  });

  it("gives the newest weekday as the session date", () => {
    expect(flowSessionDate(MON_10_00)).toBe("2026-11-09");
    expect(flowSessionDate(new Date("2026-11-07T15:00:00Z"))).toBe(
      "2026-11-06"
    );
    expect(flowSessionDate(new Date("2026-11-08T15:00:00Z"))).toBe(
      "2026-11-06"
    );
    expect(flowSessionDate(MON_20_30)).toBe("2026-11-09");
    // Before 09:30 New York: the previous weekday (Monday steps back to Friday).
    expect(flowSessionDate(MON_09_00)).toBe("2026-11-06");
    expect(flowSessionDate(new Date("2026-11-10T14:29:00Z"))).toBe(
      "2026-11-09"
    );
    expect(flowSessionDate(new Date("2026-11-10T14:30:00Z"))).toBe(
      "2026-11-10"
    );
    expect(flowClockText(MON_10_00)).toBe("10:00");
    expect(flowClockText(MON_09_00)).toBe("09:00");
  });

  it("lists freshness only for the sources a symbol collects", () => {
    expect(
      buildFreshness(rowsOf({ symbol: "QQQ" })).map((row) => row.source)
    ).toEqual(["depth", "gex"]);
  });

  it("keeps the SPY freshness rows unchanged", () => {
    expect(buildFreshness(rowsOf()).map((row) => row.source)).toEqual([
      "ticks",
      "depth",
      "options",
      "gex",
    ]);
  });

  it("QQQ confluence has no order-flow or options factor with data", () => {
    const fresh = (["ticks", "depth", "options", "gex"] as const).map(
      (source) => ({ ...sample(source, ago(30)), symbol: "QQQ" as const })
    );
    const snapshot = buildFlowSnapshot(
      rowsOf({ latest: fresh, latestOk: fresh, symbol: "QQQ" })
    );
    expect(FlowSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    const values = Object.fromEntries(
      snapshot.confluence.factors.map((factor) => [factor.key, factor.vote])
    );
    expect(snapshot.freshness.map((row) => row.source)).toEqual([
      "depth",
      "gex",
    ]);
    expect(values["order_flow"]).toBe("no_data");
    expect(values["options_flow"]).toBe("no_data");
    expect(values["gex"]).toBe("context");
    expect(snapshot.confluence.factors[0]?.value).toBe(
      "No vote: not collected for QQQ"
    );
    expect(snapshot.confluence.factors[2]?.value).toBe(
      "No vote: not collected for QQQ"
    );
  });

  it("maps the stored words of a rolled-back or older row to contract values", () => {
    const snapshot = buildFlowSnapshot(
      rowsOf({
        gex: gexRow({ ivRegime: "unknown", regime: "unknown", symbol: "SPY" }),
        prints: [
          printRow(ago(60), { id: "a", moneyness: "unknown", side: "unknown" }),
          printRow(ago(90), { id: "b", premium: 1, side: "above_ask" }),
        ],
      })
    );
    expect(FlowSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.gex).toMatchObject({
      ivRegime: "no_term_data",
      regime: "no_data",
    });
    expect(snapshot.optionsFlow.topPrints.map((print) => print.side)).toEqual([
      "not_classified",
      "above_ask",
    ]);
    expect(
      snapshot.optionsFlow.topPrints.map((print) => print.moneyness)
    ).toEqual(["not_reported", "otm"]);
    // A stored value that is a contract value passes through; a regime outside
    // positive and negative (here the contract's own `zero`) is read as no estimate.
    const kept = buildFlowSnapshot(
      rowsOf({ gex: gexRow({ ivRegime: "inverted", regime: "zero" }) })
    );
    expect(kept.gex).toMatchObject({ ivRegime: "inverted", regime: "no_data" });
    expect(
      buildFlowSnapshot(rowsOf({ gex: gexRow({ regime: "negative" }) })).gex
        ?.regime
    ).toBe("negative");
  });

  it("gives QQQ and NQ their registry note and no off-exchange share for NQ", () => {
    const qqq = buildFlowSnapshot(rowsOf({ symbol: "QQQ" }));
    const nq = buildFlowSnapshot(
      rowsOf({ minutes: [minuteRow(ago(60))], symbol: "NQ" })
    );
    expect(qqq.notes[1]).toMatch(/^QQQ book is IEX depth/);
    expect(qqq.notes[0]).toBe(
      "Trades and option prints are not collected for QQQ; this view shows depth and GEX only."
    );
    expect(qqq.notes).toHaveLength(3);
    // NQ reads the streamed tape but has no option prints.
    expect(nq.notes[0]).toBe(
      "Ticks come from the streamed tape: coveredSeconds says how much of each minute the stream covered. Coverage means that the stream was live; it is not checked against a second source."
    );
    expect(nq.notes[1]).toBe(
      "Trade side: quote rule, then tick rule. Option prints are not collected for NQ."
    );
    // The tick note follows the tick mode: streamed for ES, sampled for SPY.
    expect(buildFlowSnapshot(rowsOf({ symbol: "ES" })).notes[0]).toBe(
      "Ticks come from the streamed tape: coveredSeconds says how much of each minute the stream covered. Coverage means that the stream was live; it is not checked against a second source."
    );
    expect(buildFlowSnapshot(rowsOf({ symbol: "SPY" })).notes[0]).toBe(
      "Ticks are sampled (up to 1000 prints about every 6 minutes); coveredSeconds says how much of each minute was seen."
    );
    expect(nq.notes[2]).toMatch(/^NQ options context uses NDX/);
    expect(nq.notes).toHaveLength(4);
    expect(nq.orderFlow.offExchangeShare).toBeNull();
  });
});
