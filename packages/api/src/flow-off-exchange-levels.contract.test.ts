import { describe, expect, it } from "vitest";
import {
  FLOW_OFF_EXCHANGE_BUCKETS,
  FLOW_OFF_EXCHANGE_LEVELS_VERSION,
  FLOW_OFF_EXCHANGE_MAX_BARS,
  FLOW_OFF_EXCHANGE_MAX_FINRA_WEEKS,
  FLOW_OFF_EXCHANGE_MAX_LEVELS,
  FLOW_OFF_EXCHANGE_MAX_PRINTS,
  FLOW_OFF_EXCHANGE_RANGES,
  FLOW_OFF_EXCHANGE_RULES_VERSION,
  FLOW_OFF_EXCHANGE_SYMBOLS,
  type FlowOffExchangeLevels,
  FlowOffExchangeLevelsInputSchema,
  FlowOffExchangeLevelsSchema,
  flowContract,
} from "./contracts/flow.ts";

const sampleDocument = (): FlowOffExchangeLevels => ({
  anchorSession: "2026-11-20",
  bars: [
    {
      close: 592.4,
      coveredSeconds: 180,
      high: 592.6,
      low: 592.1,
      offExchangeShare: 0.35,
      offExchangeVolume: 35_000,
      open: 592.2,
      possibleSeconds: 300,
      session: "2026-11-20",
      start: "2026-11-20T14:30:00.000Z",
      volume: 100_000,
      vwap: 592.38,
    },
  ],
  bucketMinutes: 5,
  finraWeekly: [
    {
      atsShare: 0.294,
      atsShares: 38_400_000,
      atsTrades: 240_000,
      avgAtsTradeSize: 160,
      lastUpdated: "2026-11-02",
      nonAtsShares: 92_100_000,
      nonAtsTrades: 610_000,
      tier: "NMS_TIER_1",
      totalShares: 130_500_000,
      weekStart: "2026-10-19",
    },
  ],
  latestPrice: 592.4,
  latestPriceAt: "2026-11-20T14:30:00.000Z",
  levels: [
    {
      bandHigh: 592.5,
      bandLow: 592.25,
      buyShares: 45_000,
      distanceFromSpot: 0,
      distancePct: 0,
      dominantDirection: "bullish",
      firstAt: "2026-11-20T14:31:00.000Z",
      lastAt: "2026-11-20T14:34:00.000Z",
      maxPrice: 592.42,
      minPrice: 592.38,
      neutralShares: 0,
      price: 592.4,
      prints: 2,
      rank: 1,
      sellShares: 0,
      totalNotional: 26_658_000,
      totalShares: 45_000,
    },
  ],
  prints: [
    {
      at: "2026-11-20T14:31:00.000Z",
      direction: "bullish",
      key: "print:1795185060:592.4:25000:FINRA",
      levelIndex: 0,
      notional: 14_810_000,
      price: 592.4,
      session: "2026-11-20",
      size: 25_000,
    },
  ],
  range: "5d",
  rules: {
    capture: "sampled",
    clusterStep: 0.25,
    finraMaxWeeks: FLOW_OFF_EXCHANGE_MAX_FINRA_WEEKS,
    maxLevels: FLOW_OFF_EXCHANGE_MAX_LEVELS,
    maxPrints: FLOW_OFF_EXCHANGE_MAX_PRINTS,
    minPrintShares: 10_000,
    readCap: 2000,
    version: FLOW_OFF_EXCHANGE_RULES_VERSION,
  },
  schemaVersion: FLOW_OFF_EXCHANGE_LEVELS_VERSION,
  sessions: ["2026-11-20"],
  symbol: "SPY",
  ticks: {
    ageSeconds: 40,
    lastOkAt: "2026-11-20T14:34:20.000Z",
    lastStatus: "ok",
    message: "1000 ticks sampled",
    sessionOpen: true,
    source: "ticks",
    state: "fresh",
  },
  totals: {
    barsCount: 1,
    buyShares: 45_000,
    coveredSeconds: 180,
    neutralShares: 0,
    omittedLevels: 0,
    omittedPrints: 0,
    prints: 2,
    sampledOffExchangeShare: 0.35,
    sampledOffExchangeVolume: 35_000,
    sampledVolume: 100_000,
    sellShares: 0,
    totalClusterCount: 1,
    totalNotional: 26_658_000,
    totalShares: 45_000,
    truncated: false,
  },
  windowEnd: "2026-11-20T21:00:00.000Z",
  windowStart: "2026-11-16T14:30:00.000Z",
});

describe("flow.offExchangeLevels input", () => {
  it("accepts SPY with default 5d range and all supported ranges", () => {
    expect(FLOW_OFF_EXCHANGE_SYMBOLS).toEqual(["SPY"]);
    expect(FLOW_OFF_EXCHANGE_RANGES).toEqual(["1d", "5d", "14d"]);
    expect(FLOW_OFF_EXCHANGE_BUCKETS).toEqual([1, 5, 15]);
    expect(FlowOffExchangeLevelsInputSchema.parse({ symbol: "SPY" })).toEqual({
      range: "5d",
      symbol: "SPY",
    });
    for (const range of FLOW_OFF_EXCHANGE_RANGES) {
      expect(
        FlowOffExchangeLevelsInputSchema.parse({ range, symbol: "SPY" })
      ).toEqual({ range, symbol: "SPY" });
    }
  });

  it.each([
    [{ symbol: "ES" }],
    [{ symbol: "NQ" }],
    [{ symbol: "QQQ" }],
    [{ range: "3d", symbol: "SPY" }],
    [{ extra: 1, symbol: "SPY" }],
    [{}],
  ])("rejects invalid input %j", (input) => {
    expect(FlowOffExchangeLevelsInputSchema.safeParse(input).success).toBe(
      false
    );
  });
});

describe("flow.offExchangeLevels output", () => {
  it("accepts a full populated document and an empty no-data document", () => {
    const full = sampleDocument();
    expect(FlowOffExchangeLevelsSchema.parse(full)).toEqual(full);

    const empty: FlowOffExchangeLevels = {
      ...full,
      anchorSession: null,
      bars: [],
      bucketMinutes: 1,
      finraWeekly: [],
      latestPrice: null,
      latestPriceAt: null,
      levels: [],
      prints: [],
      range: "1d",
      sessions: [],
      totals: {
        barsCount: 0,
        buyShares: 0,
        coveredSeconds: 0,
        neutralShares: 0,
        omittedLevels: 0,
        omittedPrints: 0,
        prints: 0,
        sampledOffExchangeShare: null,
        sampledOffExchangeVolume: 0,
        sampledVolume: 0,
        sellShares: 0,
        totalClusterCount: 0,
        totalNotional: 0,
        totalShares: 0,
        truncated: false,
      },
      windowEnd: null,
      windowStart: null,
    };
    expect(FlowOffExchangeLevelsSchema.parse(empty)).toEqual(empty);
  });

  it("rejects out-of-bounds arrays, invalid bucket widths, and non-finite numbers", () => {
    const base = sampleDocument();
    expect(
      FlowOffExchangeLevelsSchema.safeParse({ ...base, bucketMinutes: 10 })
        .success
    ).toBe(false);
    expect(
      FlowOffExchangeLevelsSchema.safeParse({
        ...base,
        bars: Array.from({ length: FLOW_OFF_EXCHANGE_MAX_BARS + 1 }, () => ({
          ...base.bars[0],
        })),
      }).success
    ).toBe(false);
    expect(
      FlowOffExchangeLevelsSchema.safeParse({
        ...base,
        levels: Array.from(
          { length: FLOW_OFF_EXCHANGE_MAX_LEVELS + 1 },
          (_, i) => ({ ...base.levels[0], rank: i + 1 })
        ),
      }).success
    ).toBe(false);
    expect(
      FlowOffExchangeLevelsSchema.safeParse({
        ...base,
        latestPrice: Number.POSITIVE_INFINITY,
      }).success
    ).toBe(false);
    expect(
      FlowOffExchangeLevelsSchema.safeParse({
        ...base,
        levels: [{ ...base.levels[0], rank: 0 }],
      }).success
    ).toBe(false);
  });

  it("exposes flow.offExchangeLevels as GET /flow/off-exchange-levels", () => {
    expect(flowContract.offExchangeLevels["~orpc"].route).toMatchObject({
      method: "GET",
      operationId: "flow.offExchangeLevels",
      path: "/flow/off-exchange-levels",
    });
  });
});
