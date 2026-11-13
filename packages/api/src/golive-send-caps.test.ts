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

  it("pairs shorts with the nearest long, skips spent longs and empty rows, and counts shares at cost", () => {
    // Shorts 610 x1 and 615 x1; longs 600 x1 and 605 x1 (paid 500 each). 610 takes 605 (width 5),
    // 615 then finds 605 spent and takes 600 (width 15): 2,000 at risk, no premium left over.
    expect(
      heldRiskCents([
        opt("SPY", 600, 1, 500),
        opt("SPY", 605, 1, 500),
        opt("SPY", 610, -1),
        opt("SPY", 615, -1),
        opt("SPY", 620, 0),
        { ...opt("AAPL", 0, 10, 1500), right: "", secType: "STK" },
      ])
    ).toEqual(
      new Map([
        ["SPY", 50_000 + 150_000],
        ["AAPL", 150_000],
      ])
    );
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

  it("keeps a name with undefined risk undefined when a working order adds to it", () => {
    expect(
      checkSendCaps({
        ...base,
        positions: [opt("SPY", 600, -1)],
        working: [{ maxLoss: 100, symbol: "SPY" }],
      }).refusals
    ).toEqual(["UNDEFINED_RISK_HELD"]);
  });

  it("adds a working order to the risk already held on its name", () => {
    expect(
      checkSendCaps({
        ...base,
        positions: [opt("SPY", 600, 1, 800)],
        working: [{ maxLoss: 400, symbol: "SPY" }],
      })
    ).toMatchObject({ heldByName: { SPY: 1200 }, refusals: ["NAME_CAP"] });
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
