import { describe, expect, it } from "vitest";

import type { JevVerdictOutput } from "./contracts/jev-verdict.ts";
import {
  classifyStructure,
  evaluateFinalOrderGate,
  type FinalGateLeg,
  type FinalGateOrder,
} from "./server/final-order-gate.ts";

const NOW = new Date("2026-11-05T15:00:00Z");
const EXP = "20261218";

const leg = (
  side: "BUY" | "SELL",
  strike: number,
  right: "C" | "P" | "" = "C",
  extra: Partial<FinalGateLeg> = {}
): FinalGateLeg => ({
  expiry: EXP,
  ratio: 1,
  right,
  secType: "OPT",
  side,
  strike,
  ...extra,
});

const order = (
  legs: FinalGateLeg[],
  limitPrice: number,
  quantity = 1,
  riskReducing = false
): FinalGateOrder => ({
  engine: "platform-ticket",
  legs,
  limitPrice,
  quantity,
  reason: "test",
  riskReducing,
  symbol: "MSFT",
});

const verdict = (
  stance: "BULLISH" | "NEUTRAL" | "BEARISH",
  state: "fresh" | "stale" | "none" = "fresh"
): JevVerdictOutput => ({
  configured: true,
  lastFailure: null,
  minIntervalSeconds: 1800,
  nextRefreshAt: null,
  notes: [],
  refreshed: false,
  staleAfterSeconds: 3600,
  state,
  symbol: "MSFT",
  throttled: false,
  verdict:
    state === "none"
      ? null
      : {
          choice: stance,
          dataAsOf: "2026-11-04",
          decidedAt: "2026-11-05T14:50:00Z",
          factors: [],
          model: "m",
          probabilities: { BEARISH: 0.1, BULLISH: 0.8, NEUTRAL: 0.1 },
          reason: "r",
          sentFields: [],
          stance,
        },
});

const ACCOUNT = 100_000; // 2% = 2000

describe("classifyStructure", () => {
  it("accepts a long call, a debit vertical and a defined-width credit vertical", () => {
    expect(classifyStructure(order([leg("BUY", 400)], 5)).kind).toBe(
      "long-option"
    );
    const debit = classifyStructure(
      order([leg("BUY", 400), leg("SELL", 410)], 4)
    );
    expect(debit).toMatchObject({ kind: "debit-vertical", maxLoss: 400 });
    const credit = classifyStructure(
      order([leg("SELL", 400, "P"), leg("BUY", 390, "P")], -3)
    );
    expect(credit).toMatchObject({ kind: "credit-vertical", maxLoss: 700 });
  });

  it("rejects shares, naked shorts and undefined-risk shapes", () => {
    expect(
      classifyStructure(
        order(
          [leg("BUY", 0, "C", { expiry: "", right: "", secType: "STK" })],
          400
        )
      ).kind
    ).toBe("rejected");
    expect(classifyStructure(order([leg("SELL", 400)], -5)).kind).toBe(
      "rejected"
    );
    // ratio spread: one naked extra short
    expect(
      classifyStructure(
        order([leg("BUY", 400), leg("SELL", 410, "C", { ratio: 2 })], 1)
      ).kind
    ).toBe("rejected");
    // mixed rights / expiries
    expect(
      classifyStructure(order([leg("BUY", 400), leg("SELL", 410, "P")], 1)).kind
    ).toBe("rejected");
    expect(
      classifyStructure(
        order(
          [leg("BUY", 400), leg("SELL", 410, "C", { expiry: "20270115" })],
          1
        )
      ).kind
    ).toBe("rejected");
    // a "credit" on a debit-shaped spread is not a valid price
    expect(
      classifyStructure(order([leg("BUY", 400), leg("SELL", 410)], -1)).kind
    ).toBe("rejected");
    // credit >= width is not a real credit spread
    expect(
      classifyStructure(
        order([leg("SELL", 400, "P"), leg("BUY", 390, "P")], -10)
      ).kind
    ).toBe("rejected");
  });
});

describe("evaluateFinalOrderGate", () => {
  const base = { accountValue: ACCOUNT, now: NOW };

  it("allows a valid bullish debit vertical with a fresh agreeing verdict", () => {
    const result = evaluateFinalOrderGate({
      ...base,
      jev: verdict("BULLISH"),
      order: order([leg("BUY", 400), leg("SELL", 410)], 4, 5),
    });
    expect(result).toMatchObject({ decision: "allow", maxLoss: 2000 });
  });

  it("denies max loss above 2% of account value", () => {
    const result = evaluateFinalOrderGate({
      ...base,
      jev: verdict("BULLISH"),
      order: order([leg("BUY", 400), leg("SELL", 410)], 4, 6),
    });
    expect(result.decision).toBe("deny");
    expect(result.reasons.join(" ")).toMatch(/2% of account value/);
  });

  it("denies when the account value is unknown", () => {
    const result = evaluateFinalOrderGate({
      ...base,
      accountValue: null,
      jev: verdict("BULLISH"),
      order: order([leg("BUY", 400)], 1),
    });
    expect(result.decision).toBe("deny");
  });

  it("denies a missing, stale, unreachable or opposing JEV verdict", () => {
    const o = order([leg("BUY", 400)], 1);
    for (const jev of [
      verdict("BULLISH", "none"),
      verdict("BULLISH", "stale"),
      null,
      verdict("BEARISH"),
    ]) {
      expect(evaluateFinalOrderGate({ ...base, jev, order: o }).decision).toBe(
        "deny"
      );
    }
  });

  it("reads a put debit vertical and a call credit vertical as bearish", () => {
    const put = order([leg("BUY", 410, "P"), leg("SELL", 400, "P")], 3);
    expect(
      evaluateFinalOrderGate({ ...base, jev: verdict("BEARISH"), order: put })
        .decision
    ).toBe("allow");
    const callCredit = order([leg("SELL", 400), leg("BUY", 410)], -3);
    expect(
      evaluateFinalOrderGate({
        ...base,
        jev: verdict("BULLISH"),
        order: callCredit,
      }).decision
    ).toBe("deny");
    expect(
      evaluateFinalOrderGate({
        ...base,
        jev: verdict("NEUTRAL"),
        order: callCredit,
      }).decision
    ).toBe("allow");
  });

  it("sends a risk-reducing order when JEV is unreachable, but JEV can still deny it", () => {
    const close = order([leg("SELL", 400)], 2, 1, true);
    expect(
      evaluateFinalOrderGate({ ...base, jev: null, order: close }).decision
    ).toBe("allow");
    const denied = evaluateFinalOrderGate({
      ...base,
      jev: { ...verdict("BULLISH"), state: "fresh" },
      jevDenied: true,
      order: close,
    });
    expect(denied.decision).toBe("deny");
  });

  it("denies an expired or invalid expiry", () => {
    const result = evaluateFinalOrderGate({
      ...base,
      jev: verdict("BULLISH"),
      order: order([leg("BUY", 400, "C", { expiry: "20261101" })], 1),
    });
    expect(result.decision).toBe("deny");
  });
});

describe("classifyStructure rejection table", () => {
  const cases: [string, FinalGateOrder][] = [
    ["right", order([leg("BUY", 400, "")], 1)],
    ["quantity", order([leg("BUY", 400)], 1, 0)],
    ["debit", order([leg("BUY", 400)], -1)],
    [
      "three legs",
      order([leg("BUY", 400), leg("SELL", 410), leg("BUY", 420)], 1),
    ],
    ["same side", order([leg("BUY", 400), leg("BUY", 410)], 1)],
    ["same strike", order([leg("BUY", 400), leg("SELL", 400)], 1)],
    ["debit too wide", order([leg("SELL", 410), leg("BUY", 400)], 11)],
  ];
  it.each(cases)("rejects %s", (_name, o) => {
    expect(classifyStructure(o).kind).toBe("rejected");
  });

  it("reads a SELL-first debit vertical and a long put", () => {
    expect(
      classifyStructure(order([leg("SELL", 410), leg("BUY", 400)], 4)).kind
    ).toBe("debit-vertical");
    expect(classifyStructure(order([leg("BUY", 400, "P")], 2)).direction).toBe(
      "bearish"
    );
  });

  it("denies a risk-reducing order with an invalid expiry and passes one with a fresh verdict", () => {
    const base = { accountValue: ACCOUNT, now: NOW };
    const bad = order([leg("SELL", 400, "C", { expiry: "2026" })], 2, 1, true);
    expect(
      evaluateFinalOrderGate({ ...base, jev: null, order: bad }).decision
    ).toBe("deny");
    const ok = order([leg("SELL", 400)], 2, 1, true);
    expect(
      evaluateFinalOrderGate({ ...base, jev: verdict("BULLISH"), order: ok })
        .reasons
    ).toEqual([]);
  });

  it("skips the loss check for a rejected shape but still denies", () => {
    const r = evaluateFinalOrderGate({
      accountValue: ACCOUNT,
      jev: verdict("NEUTRAL"),
      now: NOW,
      order: order([leg("SELL", 400)], -1),
    });
    expect(r).toMatchObject({ decision: "deny", maxLossPct: null });
  });
});

it("evaluateFinalOrderGate denies a share order", () => {
  const shares = order(
    [leg("BUY", 0, "", { expiry: "", secType: "STK" })],
    400
  );
  const r = evaluateFinalOrderGate({
    accountValue: ACCOUNT,
    jev: verdict("BULLISH"),
    now: NOW,
    order: shares,
  });
  expect(r.decision).toBe("deny");
  expect(r.reasons.join(" ")).toMatch(/Options only/);
});
