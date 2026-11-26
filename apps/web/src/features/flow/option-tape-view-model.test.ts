import type { FlowFreshness, FlowOptionPrints } from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  OPTION_TAPE_HEADERS,
  OPTION_TAPE_TICKERS,
  OPTION_TAPE_WINDOWS,
  optionTapeFreshness,
  optionTapeMetrics,
  optionTapeRows,
  optionTapeUnreadLine,
  optionTapeWindowLabel,
} from "./option-tape-view-model.ts";

const freshness = (overrides: Partial<FlowFreshness>): FlowFreshness => ({
  ageSeconds: null,
  lastOkAt: null,
  lastStatus: null,
  message: null,
  sessionOpen: false,
  source: "options",
  state: "never",
  ...overrides,
});

const printDefaults = {
  expiry: "2026-12-18",
  moneyness: "otm" as const,
  opening: false,
  strike: 230,
  volumeOverOi: false,
};

const sampleData = (
  overrides: Partial<FlowOptionPrints> = {}
): FlowOptionPrints => ({
  asOf: "2026-11-23T15:30:00.000Z",
  delay:
    "Intraday, ~1-2 min cadence (parity staggered, QuantData order-flow/consolidated; market hours 09:30-16:15 ET).",
  freshness: freshness({
    ageSeconds: 45,
    lastOkAt: "2026-11-23T15:29:15.000Z",
    lastStatus: "ok",
    sessionOpen: true,
    state: "fresh",
  }),
  prints: [
    {
      ...printDefaults,
      at: "2026-11-23T15:29:00.000Z",
      consolidation: "sweep",
      contract: "IWM 2026-12-18 230 C",
      goldenSweep: true,
      opening: true,
      premium: 325_000,
      price: 4.5,
      right: "call",
      sentiment: "bullish",
      side: "above_ask",
      size: 722,
      unusual: true,
      volumeOverOi: true,
    },
    {
      ...printDefaults,
      at: "2026-11-23T15:28:00.000Z",
      consolidation: "block",
      contract: "IWM 2026-12-18 220 P",
      goldenSweep: false,
      premium: 180_000,
      price: 2.25,
      right: "put",
      sentiment: "bearish",
      side: "below_bid",
      size: 800,
      strike: 220,
      unusual: false,
    },
    {
      ...printDefaults,
      at: "2026-11-23T15:27:00.000Z",
      consolidation: "split",
      contract: "IWM 2026-12-18 225 C",
      goldenSweep: false,
      moneyness: "atm",
      premium: 95_000,
      price: 3.1,
      right: "call",
      sentiment: "neutral",
      side: "mid",
      size: 306,
      strike: 225,
      unusual: false,
    },
    {
      ...printDefaults,
      at: "2026-11-23T15:26:00.000Z",
      consolidation: "other",
      contract: "IWM 2026-12-18 228 C",
      goldenSweep: false,
      premium: 40_000,
      price: 1.5,
      right: "call",
      sentiment: "bullish",
      side: "ask",
      size: 266,
      strike: 228,
      unusual: false,
    },
    {
      ...printDefaults,
      at: "2026-11-23T15:25:00.000Z",
      consolidation: "sweep",
      contract: "IWM 2026-12-18 215 P",
      goldenSweep: false,
      premium: 25_000,
      price: 1.25,
      right: "put",
      sentiment: "bearish",
      side: "bid",
      size: 200,
      strike: 215,
      unusual: false,
    },
    {
      ...printDefaults,
      at: "2026-11-23T15:24:00.000Z",
      consolidation: "other",
      contract: "IWM 2026-12-18 226 P",
      goldenSweep: false,
      premium: 15_000,
      price: null,
      right: "put",
      sentiment: "neutral",
      side: "not_classified",
      size: 150,
      strike: 226,
      unusual: false,
    },
  ],
  schemaVersion: "flow-option-prints.v1",
  source: "QuantData order-flow/consolidated",
  summary: {
    bearishPremium: 205_000,
    blocks: 1,
    bullishPremium: 365_000,
    callPremium: 460_000,
    goldenSweeps: 1,
    putPremium: 220_000,
    sweeps: 2,
    ticker: "IWM",
    trades: 6,
    unusualCount: 1,
  },
  symbol: "IWM",
  ticker: "IWM",
  unreadRanges: 0,
  windowEnd: "2026-11-23T15:30:00.000Z",
  windowMinutes: 60,
  windowStart: "2026-11-23T14:30:00.000Z",
  ...overrides,
});

describe("option-tape-view-model", () => {
  it("exposes all 6 option tickers, window choices, and column headers", () => {
    expect(OPTION_TAPE_TICKERS).toEqual([
      "SPY",
      "SPX",
      "QQQ",
      "NDX",
      "IWM",
      "NVDA",
    ]);
    expect(OPTION_TAPE_WINDOWS).toEqual([15, 60, 390]);
    expect(OPTION_TAPE_HEADERS).toHaveLength(8);
  });

  it("formats all freshness states with and without age", () => {
    expect(
      optionTapeFreshness(freshness({ ageSeconds: 45, state: "fresh" }))
    ).toEqual({
      label: "Live · 45s",
      tone: "success",
    });
    expect(
      optionTapeFreshness(freshness({ ageSeconds: 300, state: "stale" }))
    ).toEqual({
      label: "Stale · 5m",
      tone: "warning",
    });
    expect(
      optionTapeFreshness(freshness({ ageSeconds: null, state: "closed" }))
    ).toEqual({
      label: "Closed",
      tone: "neutral",
    });
    expect(
      optionTapeFreshness(freshness({ ageSeconds: null, state: "never" }))
    ).toEqual({
      label: "No data yet",
      tone: "warning",
    });
  });

  it("formats unread gap counts for zero, singular, and plural ranges", () => {
    expect(optionTapeUnreadLine(0)).toBe("0 unread gap ranges");
    expect(optionTapeUnreadLine(1)).toBe("1 unread gap range catching up");
    expect(optionTapeUnreadLine(3)).toBe("3 unread gap ranges catching up");
  });

  it("formats full-window summary metrics", () => {
    const metrics = optionTapeMetrics(sampleData());
    expect(metrics).toEqual([
      { label: "Trades", value: "6" },
      { label: "Call premium", value: "$460K" },
      { label: "Put premium", value: "$220K" },
      { label: "Bullish", value: "$365K" },
      { label: "Bearish", value: "$205K" },
      { label: "Sweeps / Golden", value: "2 / 1" },
      { label: "Blocks / Unusual", value: "1 / 1" },
    ]);
  });

  it("formats all print sides, sentiments, consolidations, and golden sweep badges", () => {
    const rows = optionTapeRows(sampleData());
    expect(rows).toHaveLength(6);
    expect(rows[0]).toMatchObject({
      contract: "IWM 2026-12-18 230 C",
      kind: "Golden sweep",
      premium: "$325K",
      price: "4.50",
      sentiment: "Bullish",
      side: "Above ask",
      size: "722",
    });
    expect(rows[1]).toMatchObject({
      kind: "Block",
      sentiment: "Bearish",
      side: "Below bid",
    });
    expect(rows[2]).toMatchObject({
      kind: "Split",
      sentiment: "Neutral",
      side: "Mid",
    });
    expect(rows[3]).toMatchObject({
      kind: "Print",
      side: "Ask",
    });
    expect(rows[4]).toMatchObject({
      kind: "Sweep",
      side: "Bid",
    });
    expect(rows[5]).toMatchObject({
      kind: "Print",
      price: "no value",
      side: "Unclassified",
    });
  });

  it("formats window button labels", () => {
    expect(optionTapeWindowLabel(15)).toBe("15m");
    expect(optionTapeWindowLabel(60)).toBe("60m");
    expect(optionTapeWindowLabel(390)).toBe("Session");
  });
});
