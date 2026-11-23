import { describe, expect, it } from "vitest";
import {
  FLOW_STRIKE_HEATMAP_BUCKETS,
  FLOW_STRIKE_HEATMAP_MAX_CELLS,
  FLOW_STRIKE_HEATMAP_MAX_SLOTS,
  FLOW_STRIKE_HEATMAP_MAX_STRIKES,
  FLOW_STRIKE_HEATMAP_SYMBOLS,
  FLOW_SYMBOLS,
  type FlowStrikeHeatmap,
  FlowStrikeHeatmapInputSchema,
  FlowStrikeHeatmapSchema,
  flowContract,
} from "./contracts/flow.ts";
import { FLOW_INSTRUMENTS } from "./flow-features.ts";

const slot: FlowStrikeHeatmap["slots"][number] = {
  bearishPremium: 90_000,
  bullishPremium: 910_000,
  end: "2026-11-20T14:45:00.000Z",
  grossPremium: 1_050_000,
  index: 0,
  netPremium: 820_000,
  price: 600.4,
  prints: 14,
  start: "2026-11-20T14:30:00.000Z",
  unread: false,
  unsignedPrints: 2,
  volume: 1240,
};

const strike: FlowStrikeHeatmap["strikes"][number] = {
  bearishPremium: 90_000,
  bullishPremium: 910_000,
  callPremium: 860_000,
  grossPremium: 1_050_000,
  netPremium: 820_000,
  prints: 14,
  putPremium: 190_000,
  strike: 602,
  unsignedPrints: 2,
  volume: 1240,
};

const cell: FlowStrikeHeatmap["cells"][number] = {
  bearishPremium: 90_000,
  bullishPremium: 910_000,
  callPremium: 860_000,
  grossPremium: 1_050_000,
  netPremium: 820_000,
  prints: 14,
  putPremium: 190_000,
  slotIndex: 0,
  strike: 602,
  unsignedPrints: 2,
  volume: 1240,
};

const response: FlowStrikeHeatmap = {
  bucketMinutes: 15,
  cells: [cell],
  options: {
    ageSeconds: 42,
    lastOkAt: "2026-11-20T14:46:05.000Z",
    lastStatus: "ok",
    message: "quantdata flow: 14 prints",
    sessionOpen: true,
    source: "options",
    state: "fresh",
  },
  rules: {
    defaultBucketMinutes: 15,
    maxStrikes: 20,
    minPremiumUsd: 10_000,
    retentionDays: 14,
    version: "strike-heatmap.v1",
  },
  schemaVersion: "flow-strike-heatmap.v1",
  session: "2026-11-20",
  slots: [slot],
  storedUntil: "2026-11-20T14:44:50.000Z",
  strikes: [strike],
  symbol: "SPY",
  ticker: "SPY",
  totals: {
    bearishPremium: 90_000,
    bullishPremium: 910_000,
    callPremium: 860_000,
    grossPremium: 1_050_000,
    latestPrice: 600.4,
    netPremium: 820_000,
    omittedGrossPremium: 0,
    omittedNetPremium: 0,
    omittedPrints: 0,
    omittedStrikes: 0,
    prints: 14,
    putPremium: 190_000,
    shownStrikes: 1,
    totalStrikes: 1,
    unsignedPrints: 2,
    volume: 1240,
  },
  unread: {
    from: "2026-11-20T15:00:00.000Z",
    ranges: 1,
    to: "2026-11-20T15:15:00.000Z",
  },
};

const accepts = (value: unknown): boolean =>
  FlowStrikeHeatmapSchema.safeParse(value).success;

describe("flow.strikeHeatmap input", () => {
  it("accepts SPY and ES, defaults bucketMinutes to 15, and parses number or string query widths", () => {
    expect(FlowStrikeHeatmapInputSchema.parse({ symbol: "SPY" })).toEqual({
      bucketMinutes: 15,
      symbol: "SPY",
    });
    expect(
      FlowStrikeHeatmapInputSchema.parse({ bucketMinutes: 5, symbol: "ES" })
    ).toEqual({
      bucketMinutes: 5,
      symbol: "ES",
    });
    for (const width of FLOW_STRIKE_HEATMAP_BUCKETS) {
      expect(
        FlowStrikeHeatmapInputSchema.parse({
          bucketMinutes: String(width),
          symbol: "SPY",
        })
      ).toEqual({
        bucketMinutes: width,
        symbol: "SPY",
      });
    }
  });

  it.each([
    [{ symbol: "QQQ" }],
    [{ symbol: "NQ" }],
    [{ bucketMinutes: "", symbol: "SPY" }],
    [{ bucketMinutes: "10", symbol: "SPY" }],
    [{ bucketMinutes: "15.5", symbol: "SPY" }],
    [{ bucketMinutes: " 15 ", symbol: "SPY" }],
    [{ bucketMinutes: 0, symbol: "SPY" }],
    [{ bucketMinutes: -15, symbol: "SPY" }],
    [{ bucketMinutes: true, symbol: "SPY" }],
    [{ bucketMinutes: false, symbol: "SPY" }],
    [{ bucketMinutes: null, symbol: "SPY" }],
    [{ extra: true, symbol: "SPY" }],
    [{}],
  ])("rejects %j", (input) => {
    expect(FlowStrikeHeatmapInputSchema.safeParse(input).success).toBe(false);
  });

  it("matches every instrument that collects option prints", () => {
    const collected = FLOW_SYMBOLS.filter((symbol) =>
      FLOW_INSTRUMENTS[symbol].sources.includes("options")
    );
    expect([...FLOW_STRIKE_HEATMAP_SYMBOLS].sort()).toEqual(
      [...collected].sort()
    );
  });
});

describe("flow.strikeHeatmap output", () => {
  it("accepts a full response and an empty response without stored prints", () => {
    expect(accepts(response)).toBe(true);
    expect(
      accepts({
        ...response,
        bucketMinutes: 30,
        cells: [],
        session: null,
        slots: [],
        storedUntil: null,
        strikes: [],
        symbol: "ES",
        ticker: "SPX",
        totals: {
          bearishPremium: 0,
          bullishPremium: 0,
          callPremium: 0,
          grossPremium: 0,
          latestPrice: null,
          netPremium: 0,
          omittedGrossPremium: 0,
          omittedNetPremium: 0,
          omittedPrints: 0,
          omittedStrikes: 0,
          prints: 0,
          putPremium: 0,
          shownStrikes: 0,
          totalStrikes: 0,
          unsignedPrints: 0,
          volume: 0,
        },
        unread: null,
      })
    ).toBe(true);
  });

  it("accepts negative netPremium and null slot prices", () => {
    expect(
      accepts({
        ...response,
        cells: [{ ...cell, netPremium: -450_000 }],
        slots: [{ ...slot, netPremium: -450_000, price: null, unread: true }],
        strikes: [{ ...strike, netPremium: -450_000 }],
        totals: {
          ...response.totals,
          latestPrice: null,
          netPremium: -450_000,
          omittedNetPremium: -50_000,
        },
      })
    ).toBe(true);
  });

  it("rejects bad versions, unknown fields, non-positive strikes/prices and out-of-range indices", () => {
    expect(
      accepts({ ...response, schemaVersion: "flow-strike-heatmap.v2" })
    ).toBe(false);
    expect(accepts({ ...response, extra: true })).toBe(false);
    expect(accepts({ ...response, bucketMinutes: 10 })).toBe(false);
    expect(accepts({ ...response, session: "2026/11/20" })).toBe(false);
    expect(accepts({ ...response, slots: [{ ...slot, index: -1 }] })).toBe(
      false
    );
    expect(accepts({ ...response, slots: [{ ...slot, index: 81 }] })).toBe(
      false
    );
    expect(accepts({ ...response, slots: [{ ...slot, price: 0 }] })).toBe(
      false
    );
    expect(accepts({ ...response, strikes: [{ ...strike, strike: 0 }] })).toBe(
      false
    );
    expect(accepts({ ...response, cells: [{ ...cell, slotIndex: 81 }] })).toBe(
      false
    );
    expect(
      accepts({
        ...response,
        cells: [{ ...cell, bullishPremium: -1 }],
      })
    ).toBe(false);
    expect(
      accepts({
        ...response,
        totals: { ...response.totals, omittedGrossPremium: -1 },
      })
    ).toBe(false);
    expect(
      accepts({
        ...response,
        rules: { ...response.rules, version: "strike-heatmap.v2" },
      })
    ).toBe(false);
  });

  it("bounds slots to 81, strikes to 20, and cells to 1620", () => {
    expect(FLOW_STRIKE_HEATMAP_MAX_SLOTS).toBe(81);
    expect(FLOW_STRIKE_HEATMAP_MAX_STRIKES).toBe(20);
    expect(FLOW_STRIKE_HEATMAP_MAX_CELLS).toBe(1620);
    expect(
      accepts({
        ...response,
        cells: new Array(1620).fill(cell),
        slots: new Array(81).fill(slot),
        strikes: new Array(20).fill(strike),
      })
    ).toBe(true);
    expect(
      accepts({
        ...response,
        slots: new Array(82).fill(slot),
      })
    ).toBe(false);
    expect(
      accepts({
        ...response,
        strikes: new Array(21).fill(strike),
      })
    ).toBe(false);
    expect(
      accepts({
        ...response,
        cells: new Array(1621).fill(cell),
      })
    ).toBe(false);
  });

  it("exposes flow.strikeHeatmap as GET /flow/strike-heatmap", () => {
    expect(flowContract.strikeHeatmap["~orpc"].route).toMatchObject({
      method: "GET",
      operationId: "flow.strikeHeatmap",
      path: "/flow/strike-heatmap",
    });
  });
});
