import { describe, expect, it } from "vitest";

import { checkSendCaps, heldRiskCents } from "./server/golive-send-caps.ts";

const LIMITS = { nameRiskCapPct: 2, openRiskCapPct: 4, positionRiskPct: 1 };
const opt = (
  symbol: string,
  strike: number,
  quantity: number,
  premium = 0,
  right = "C"
) => ({
  expiry: "20261218",
  premium,
  quantity,
  right,
  secType: "OPT",
  strike,
  symbol,
});

describe("heldRiskCents", () => {
  it("counts a vertical at its width only and an unpaired long at its cost", () => {
    // 2 long 600C (paid 2,000), 2 short 610C: width 10 x 100 x 2 = 2,000 at risk, nothing more.
    expect(
      heldRiskCents([opt("SPY", 600, 2, 2000), opt("SPY", 610, -2)]).get("SPY")
    ).toBe(200_000);
    // 3 long 600C (paid 3,000), 1 short 610C: width 1,000 + 2/3 of the premium 2,000.
    expect(
      heldRiskCents([opt("SPY", 600, 3, 3000), opt("SPY", 610, -1)]).get("SPY")
    ).toBe(100_000 + 200_000);
  });

  it("marks a symbol with an uncovered short option as undefined risk", () => {
    expect(heldRiskCents([opt("QQQ", 500, -1, 0, "P")]).get("QQQ")).toBeNull();
    // Another right does not cover it.
    expect(
      heldRiskCents([opt("QQQ", 500, -1, 0, "P"), opt("QQQ", 490, 1, 100)]).get(
        "QQQ"
      )
    ).toBeNull();
  });
});

describe("checkSendCaps", () => {
  const base = {
    limits: LIMITS,
    nlv: 100_000,
    orderMaxLoss: 900,
    positions: [],
    symbol: "SPY",
    working: [],
  };

  it("allows an order inside every cap", () => {
    expect(checkSendCaps(base).refusals).toEqual([]);
  });

  it("names each broken cap", () => {
    expect(checkSendCaps({ ...base, orderMaxLoss: 1000.01 }).refusals).toEqual([
      "POSITION_CAP",
    ]);
    // 1,500 already on SPY + 900 > 2,000 name cap.
    expect(
      checkSendCaps({ ...base, positions: [opt("SPY", 600, 1, 1500)] }).refusals
    ).toEqual(["NAME_CAP"]);
    // Open + working on other names 3,200 + 900 > 4,000.
    expect(
      checkSendCaps({
        ...base,
        positions: [opt("QQQ", 500, 1, 1600), opt("IWM", 200, 1, 1000)],
        working: [{ maxLoss: 600, symbol: "DIA" }],
      }).refusals
    ).toEqual(["OPEN_RISK_CAP"]);
  });

  it("refuses without an account value, with undefined held risk or an unknown working order", () => {
    expect(checkSendCaps({ ...base, nlv: null }).refusals).toEqual([
      "NLV_UNAVAILABLE",
    ]);
    expect(
      checkSendCaps({ ...base, positions: [opt("SPY", 600, -1)] }).refusals
    ).toEqual(["UNDEFINED_RISK_HELD"]);
    expect(
      checkSendCaps({ ...base, working: [{ maxLoss: null, symbol: "SPY" }] })
        .refusals
    ).toEqual(["WORKING_ORDER_RISK_UNKNOWN"]);
  });
});
