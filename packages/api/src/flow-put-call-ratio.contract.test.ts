import { describe, expect, it } from "vitest";
import {
  FLOW_PUT_CALL_RATIO_MAX_DAYS,
  FLOW_PUT_CALL_RATIO_MAX_POINTS,
  FLOW_PUT_CALL_RATIO_SYMBOLS,
  FLOW_SYMBOLS,
  type FlowPutCallRatio,
  FlowPutCallRatioInputSchema,
  FlowPutCallRatioSchema,
  flowContract,
} from "./contracts/flow.ts";
import { FLOW_INSTRUMENTS } from "./flow-features.ts";

const point: FlowPutCallRatio["points"][number] = {
  callPremium: 2_000_000,
  callVolume: 400,
  minute: "2026-11-20T14:30:00.000Z",
  premiumRatio: 0.75,
  price: 661.2,
  prints: 5,
  putPremium: 1_500_000,
  putVolume: 320,
  volumeRatio: 0.8,
};

const day: FlowPutCallRatio["days"][number] = {
  callPremium: 12_000_000,
  callPrints: 80,
  callVolume: 3000,
  incomplete: false,
  premiumRatio: 0.9,
  price: 661.5,
  prints: 150,
  putPremium: 10_800_000,
  putPrints: 70,
  putVolume: 2700,
  session: "2026-11-20",
  volumeRatio: 0.9,
};

const response: FlowPutCallRatio = {
  days: [day],
  options: {
    ageSeconds: 42,
    lastOkAt: "2026-11-20T14:31:05.000Z",
    lastStatus: "ok",
    message: "quantdata flow: 12 prints",
    sessionOpen: true,
    source: "options",
    state: "fresh",
  },
  points: [point],
  rules: {
    minPremiumUsd: 10_000,
    parity: 1,
    retentionDays: 14,
    version: "put-call-ratio.v1",
  },
  schemaVersion: "flow-put-call-ratio.v1",
  session: "2026-11-20",
  storedUntil: "2026-11-20T14:30:41.000Z",
  symbol: "SPY",
  ticker: "SPY",
  totals: {
    callPremium: 2_000_000,
    callPrints: 3,
    callVolume: 400,
    premiumHigh: { minute: point.minute, ratio: 0.75 },
    premiumLow: { minute: point.minute, ratio: 0.75 },
    premiumRatio: 0.75,
    prints: 5,
    putPremium: 1_500_000,
    putPrints: 2,
    putVolume: 320,
    volumeHigh: { minute: point.minute, ratio: 0.8 },
    volumeLow: { minute: point.minute, ratio: 0.8 },
    volumeRatio: 0.8,
  },
  unread: {
    from: "2026-11-20T15:00:00.000Z",
    ranges: 1,
    to: "2026-11-20T15:20:00.000Z",
  },
};

const accepts = (value: unknown): boolean =>
  FlowPutCallRatioSchema.safeParse(value).success;

describe("flow.putCallRatio input", () => {
  it("takes SPY and ES", () => {
    expect(FlowPutCallRatioInputSchema.parse({ symbol: "SPY" })).toEqual({
      symbol: "SPY",
    });
    expect(FlowPutCallRatioInputSchema.parse({ symbol: "ES" })).toEqual({
      symbol: "ES",
    });
  });

  it.each([
    [{ symbol: "QQQ" }],
    [{ symbol: "NQ" }],
    [{ minutes: 120, symbol: "SPY" }],
    [{}],
  ])("rejects %j", (input) => {
    expect(FlowPutCallRatioInputSchema.safeParse(input).success).toBe(false);
  });

  it("matches every instrument that collects option prints", () => {
    const collected = FLOW_SYMBOLS.filter((symbol) =>
      FLOW_INSTRUMENTS[symbol].sources.includes("options")
    );
    expect([...FLOW_PUT_CALL_RATIO_SYMBOLS].sort()).toEqual(
      [...collected].sort()
    );
  });
});

describe("flow.putCallRatio output", () => {
  it("accepts a full response and an empty response without stored prints", () => {
    expect(accepts(response)).toBe(true);
    expect(
      accepts({
        ...response,
        days: [],
        points: [],
        session: null,
        storedUntil: null,
        symbol: "ES",
        ticker: "SPX",
        totals: {
          callPremium: 0,
          callPrints: 0,
          callVolume: 0,
          premiumHigh: null,
          premiumLow: null,
          premiumRatio: null,
          prints: 0,
          putPremium: 0,
          putPrints: 0,
          putVolume: 0,
          volumeHigh: null,
          volumeLow: null,
          volumeRatio: null,
        },
        unread: null,
      })
    ).toBe(true);
  });

  it("accepts null ratios and null prices on points and days", () => {
    expect(
      accepts({
        ...response,
        days: [
          {
            ...day,
            incomplete: true,
            premiumRatio: null,
            price: null,
            volumeRatio: null,
          },
        ],
        points: [
          { ...point, premiumRatio: null, price: null, volumeRatio: null },
        ],
      })
    ).toBe(true);
  });

  it("rejects bad versions, unknown fields, negative values and non-integer counts", () => {
    expect(
      accepts({ ...response, schemaVersion: "flow-put-call-ratio.v2" })
    ).toBe(false);
    expect(accepts({ ...response, extra: true })).toBe(false);
    expect(accepts({ ...response, session: "2026/11/20" })).toBe(false);
    expect(
      accepts({ ...response, points: [{ ...point, premiumRatio: -0.1 }] })
    ).toBe(false);
    expect(
      accepts({
        ...response,
        points: [{ ...point, volumeRatio: Number.POSITIVE_INFINITY }],
      })
    ).toBe(false);
    expect(
      accepts({ ...response, points: [{ ...point, callVolume: 1.5 }] })
    ).toBe(false);
    expect(
      accepts({ ...response, points: [{ ...point, putPremium: -1 }] })
    ).toBe(false);
    expect(
      accepts({ ...response, days: [{ ...day, session: "bad-date" }] })
    ).toBe(false);
    expect(accepts({ ...response, days: [{ ...day, prints: -1 }] })).toBe(
      false
    );
    expect(
      accepts({ ...response, totals: { ...response.totals, callPrints: 1.5 } })
    ).toBe(false);
    expect(
      accepts({
        ...response,
        rules: { ...response.rules, version: "put-call-ratio.v2" },
      })
    ).toBe(false);
    expect(
      accepts({
        ...response,
        rules: { ...response.rules, minPremiumUsd: 0 },
      })
    ).toBe(false);
    expect(
      accepts({
        ...response,
        rules: { ...response.rules, retentionDays: 0 },
      })
    ).toBe(false);
    expect(
      accepts({
        ...response,
        rules: { ...response.rules, parity: 2 },
      })
    ).toBe(false);
  });

  it("bounds points to 405 session minutes and days to 20 sessions", () => {
    expect(FLOW_PUT_CALL_RATIO_MAX_POINTS).toBe(405);
    expect(FLOW_PUT_CALL_RATIO_MAX_DAYS).toBe(20);
    expect(
      accepts({
        ...response,
        days: new Array(20).fill(day),
        points: new Array(405).fill(point),
      })
    ).toBe(true);
    expect(
      accepts({
        ...response,
        points: new Array(406).fill(point),
      })
    ).toBe(false);
    expect(
      accepts({
        ...response,
        days: new Array(21).fill(day),
      })
    ).toBe(false);
  });

  it("exposes flow.putCallRatio as GET /flow/put-call-ratio", () => {
    expect(flowContract.putCallRatio["~orpc"].route).toMatchObject({
      method: "GET",
      operationId: "flow.putCallRatio",
      path: "/flow/put-call-ratio",
    });
  });
});
