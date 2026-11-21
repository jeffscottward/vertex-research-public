import { describe, expect, it } from "vitest";

import {
  GoLiveDraftCandidateSchema,
  GoLiveOrderSchema,
  goLiveStrikesFitStructure,
} from "./contracts/golive-drafts.ts";
import type { JevVerdictOutput } from "./contracts/jev-verdict.ts";
import { evaluateFinalOrderGate } from "./server/final-order-gate.ts";
import {
  approvedOrderFitsDraft,
  buildCombo,
  limitFromQuote,
  maxLoss,
  strikeWidth,
} from "./server/golive-drafts-sizing.ts";

// Owner 2026-11-20: a single long QQQ put (about $1,000 max loss) is a valid go-live draft.
const NOW = new Date("2026-11-20T15:00:00.000Z");
const EXPIRY = "20261218";
const LONG_PUT = {
  expiry: EXPIRY,
  longStrike: 500,
  shortStrike: null,
  structure: "longPut" as const,
  symbol: "QQQ",
};

const candidate = (overrides: Record<string, unknown> = {}) => ({
  entryBasis: "signal_today",
  expiry: EXPIRY,
  longStrike: 500,
  quote: null,
  shortStrike: null,
  signalFacts: [],
  sleeveKey: "qqq-put",
  structure: "longPut",
  symbol: "QQQ",
  ...overrides,
});

const bearish: JevVerdictOutput = {
  configured: true,
  lastFailure: null,
  minIntervalSeconds: 1800,
  nextRefreshAt: null,
  notes: [],
  refreshed: false,
  staleAfterSeconds: 3600,
  state: "fresh",
  symbol: "QQQ",
  throttled: false,
  verdict: {
    choice: "BEARISH",
    dataAsOf: "2026-11-19",
    decidedAt: "2026-11-20T14:00:00Z",
    factors: [],
    model: "m",
    probabilities: { BEARISH: 0.8, BULLISH: 0.1, NEUTRAL: 0.1 },
    reason: "r",
    sentFields: [],
    stance: "BEARISH",
  },
};

describe("single long option drafts", () => {
  it("accepts a long put or call candidate without a short strike", () => {
    expect(GoLiveDraftCandidateSchema.safeParse(candidate()).success).toBe(
      true
    );
    expect(
      GoLiveDraftCandidateSchema.safeParse(candidate({ structure: "longCall" }))
        .success
    ).toBe(true);
  });

  it("refuses a short strike on a single leg and a missing one on a vertical", () => {
    expect(
      GoLiveDraftCandidateSchema.safeParse(candidate({ shortStrike: 490 }))
        .success
    ).toBe(false);
    expect(
      GoLiveDraftCandidateSchema.safeParse(
        candidate({ structure: "putDebitVertical" })
      ).success
    ).toBe(false);
    expect(goLiveStrikesFitStructure("longPut", 500, null)).toBe(true);
    expect(goLiveStrikesFitStructure("longPut", 500, 490)).toBe(false);
    expect(goLiveStrikesFitStructure("putDebitVertical", 500, null)).toBe(
      false
    );
  });

  it("builds one BUY leg, prices it from the long mid and loses at most the premium", () => {
    const order = buildCombo(LONG_PUT, 1, 9.5);
    expect(order.legs).toEqual([
      { expiry: EXPIRY, ratio: 1, right: "P", side: "BUY", strike: 500 },
    ]);
    expect(
      buildCombo({ ...LONG_PUT, structure: "longCall" }, 1, 9.5).legs[0]?.right
    ).toBe("C");
    expect(GoLiveOrderSchema.safeParse(order).success).toBe(true);
    expect(strikeWidth(LONG_PUT)).toBe(Number.POSITIVE_INFINITY);
    // Long mid 9.525, the short side is not read: limit rounds down to 9.52.
    expect(
      limitFromQuote(
        "longPut",
        { longAsk: 9.6, longBid: 9.45, shortAsk: 0, shortBid: 0 },
        strikeWidth(LONG_PUT)
      )
    ).toBe(9.52);
    expect(maxLoss("longPut", 9.5, strikeWidth(LONG_PUT), 1)).toBe(950);
    expect(approvedOrderFitsDraft(LONG_PUT, order)).toBe(true);
    expect(approvedOrderFitsDraft(LONG_PUT, { ...order, limitPrice: -1 })).toBe(
      false
    );
  });

  it("passes the final order gate (2% max loss, options only) and is refused above 2%", () => {
    const gate = (accountValue: number) =>
      evaluateFinalOrderGate({
        accountValue,
        jev: bearish,
        now: NOW,
        order: {
          engine: "golive",
          legs: buildCombo(LONG_PUT, 1, 9.5).legs.map((leg) => ({
            ...leg,
            secType: "OPT",
          })),
          limitPrice: 9.5,
          quantity: 1,
          reason: "owner single long put",
          symbol: "QQQ",
        },
        positions: [],
      });
    // $950 max loss on a $100,000 account is 0.95%: allowed as a long option.
    expect(gate(100_000)).toMatchObject({
      decision: "allow",
      maxLoss: 950,
      structure: "long-option",
    });
    // On $40,000 the same order is 2.4%: refused by the 2% gate.
    expect(gate(40_000).decision).toBe("deny");
  });
});
