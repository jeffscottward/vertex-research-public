import { describe, expect, it } from "vitest";

import golden from "./fixtures/flow-control-golden.fixture.json" with {
  type: "json",
};
import {
  type FlowNetDriftBucket,
  netDriftRequest,
  newestBucketAt,
  parseNetDrift,
} from "./flow-net-drift.ts";

const MINUTE = Date.UTC(2026, 10, 13, 14, 30);

const bucket = (overrides: Record<string, unknown> = {}) => ({
  netCallPremium: 1000,
  netCallVolume: 10,
  netPutPremium: -400,
  netPutVolume: -4,
  ...overrides,
});

describe("netDriftRequest", () => {
  it("builds exactly the two request bodies of the golden fixture", () => {
    for (const part of ["total", "zero_dte"] as const) {
      const body = netDriftRequest("YYYY-MM-DD", "T", part);
      expect(body).toEqual(golden.netDriftRequests[part]);
      expect(JSON.stringify(body)).toBe(
        JSON.stringify(golden.netDriftRequests[part])
      );
    }
  });
});

describe("parseNetDrift", () => {
  it("maps buckets in minute order with signed values", () => {
    const result = parseNetDrift({
      [String(MINUTE + 60_000)]: bucket({ netCallPremium: -250 }),
      [String(MINUTE)]: bucket(),
    });
    expect(result).toEqual({
      buckets: [
        {
          minute: new Date(MINUTE),
          netCallPremium: 1000,
          netCallVolume: 10,
          netPutPremium: -400,
          netPutVolume: -4,
          underlyingPrice: null,
        },
        {
          minute: new Date(MINUTE + 60_000),
          netCallPremium: -250,
          netCallVolume: 10,
          netPutPremium: -400,
          netPutVolume: -4,
          underlyingPrice: null,
        },
      ],
      ok: true,
    });
  });

  it("keeps the price when present and null when absent", () => {
    const result = parseNetDrift({
      [String(MINUTE)]: bucket({
        midMarketCallPremium: 5,
        midMarketPutPremium: 6,
        other: "dropped",
        stockPrice: 6012.5,
      }),
      [String(MINUTE + 60_000)]: bucket(),
    });
    expect(
      result.ok && result.buckets.map((row) => row.underlyingPrice)
    ).toEqual([6012.5, null]);
  });

  it("rejects a key that is not a whole minute or not 13 digits", () => {
    const offMinute = parseNetDrift({
      [String(MINUTE + 1)]: bucket(),
      [String(MINUTE)]: bucket(),
    });
    expect(offMinute).toEqual({
      message: `net drift answer has an unexpected shape: ${MINUTE + 1}`,
      ok: false,
    });
    const seconds = String(MINUTE / 1000);
    expect(parseNetDrift({ [seconds]: bucket() })).toEqual({
      message: `net drift answer has an unexpected shape: ${seconds}`,
      ok: false,
    });
  });

  it("rejects a non-object answer, a bad key and a non-number value with a message that has no payload", () => {
    expect(parseNetDrift("secret-text")).toEqual({
      message: "net drift answer has an unexpected shape: (root)",
      ok: false,
    });
    const badKey = parseNetDrift({ "not-a-time": bucket() });
    expect(badKey.ok).toBe(false);
    expect(JSON.stringify(badKey)).not.toContain("1000");
    const badValue = parseNetDrift({
      [String(MINUTE)]: bucket({ netPutPremium: "payload-value" }),
    });
    expect(badValue).toEqual({
      message: `net drift answer has an unexpected shape: ${MINUTE}.netPutPremium`,
      ok: false,
    });
  });

  it("rejects more than 1500 buckets", () => {
    const many = Object.fromEntries(
      Array.from({ length: 1501 }, (_, index) => [
        String(MINUTE + index * 60_000),
        bucket(),
      ])
    );
    expect(parseNetDrift(many).ok).toBe(false);
    const limit = Object.fromEntries(Object.entries(many).slice(0, 1500));
    expect(parseNetDrift(limit).ok).toBe(true);
  });
});

describe("newestBucketAt", () => {
  it("returns the newest bucket time, or null for no buckets", () => {
    const rows: FlowNetDriftBucket[] = [
      {
        minute: new Date(MINUTE),
        netCallPremium: 0,
        netCallVolume: 0,
        netPutPremium: 0,
        netPutVolume: 0,
        underlyingPrice: null,
      },
      {
        minute: new Date(MINUTE + 60_000),
        netCallPremium: 0,
        netCallVolume: 0,
        netPutPremium: 0,
        netPutVolume: 0,
        underlyingPrice: null,
      },
    ];
    expect(newestBucketAt(rows)).toEqual(new Date(MINUTE + 60_000));
    expect(newestBucketAt([])).toBeNull();
  });
});
