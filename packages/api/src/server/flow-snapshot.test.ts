import { describe, expect, it } from "vitest";

import {
  FLOW_SNAPSHOT_MAX_EVENTS,
  FLOW_SNAPSHOT_MAX_PRINTS,
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
  type FlowGexRow,
  type FlowSampleRow,
  type FlowSnapshotRows,
  flowSessionOpen,
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
    expect(vote(null, 0.1)).toBe("unknown");
    expect(vote(0.1, 0.1)).toBe("bullish");
    expect(vote(-0.1, 0.1)).toBe("bearish");
    expect(vote(0.05, 0.1)).toBe("neutral");
  });

  it("formats signed percentages", () => {
    expect(pct(null)).toBe("n/a");
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
  const input = (
    overrides: Partial<ConfluenceInput> = {}
  ): ConfluenceInput => ({
    deltaRatio: 0.2,
    gex: gexRow(),
    lastPrice: 6000,
    premiumBias: 0.2,
    pressure: 0.3,
    usable: allUsable,
    ...overrides,
  });

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
    expect(confluence.factors[3]?.vote).toBe("unknown");
  });

  it("ignores unusable sources", () => {
    const confluence = buildConfluence(
      input({
        usable: { depth: false, gex: false, options: false, ticks: false },
      })
    );
    expect(confluence).toMatchObject({
      known: 0,
      label: "Not enough fresh data",
      summary: "insufficient",
    });
    expect(confluence.factors.map((factor) => factor.value)).toEqual([
      "n/a",
      "n/a",
      "n/a",
      "n/a",
    ]);
  });

  it("describes gex value variants", () => {
    const gexValue = (overrides: Partial<ConfluenceInput>) =>
      buildConfluence(input(overrides)).factors[3]?.value;
    expect(gexValue({ gex: null })).toBe("n/a");
    expect(gexValue({ gex: gexRow({ regime: "unknown" }) })).toBe("n/a");
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
    expect(snapshot.confluence.factors[3]?.value).toBe("n/a");
    expect(snapshot.events).toEqual([]);
    expect(snapshot.minutes).toEqual([]);
  });
});
