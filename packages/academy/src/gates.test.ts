import { describe, expect, it } from "vitest";

import {
  checkOverride,
  evaluateDeployGates,
  type GateCaps,
  wilsonLower,
} from "./gates.ts";

const caps: GateCaps = {
  optionsOnly: true,
  optionsOnlyScope: "No new share positions.",
  shortPremiumPct: 2,
  leapsPremiumPct: 2,
  leapsMinDte: 365,
};

const base = {
  nlv: 100_000,
  allocationPct: 10,
  riskPerTradePct: 10,
  otherAllocationsPct: 0,
  tranches: 2,
  caps,
};

describe("evaluateDeployGates", () => {
  it("passes a defined-risk long call inside the caps", () => {
    const result = evaluateDeployGates({
      ...base,
      structure: "long_call",
      rules: {},
    });
    expect(result.verdict).toBe("pass");
    expect(result.premiumPerPositionPctNlv).toBeCloseTo(1, 6);
    expect(
      result.checks.find((check) => check.id === "premium-cap")?.status
    ).toBe("pass");
  });

  it("passes an OTM call debit spread whose reward:risk reaches 2:1", () => {
    const result = evaluateDeployGates({
      ...base,
      structure: "call_debit_spread",
      rules: { longDelta: 0.4, shortDelta: 0.15 },
    });
    expect(result.rewardRisk).toBeGreaterThanOrEqual(2);
    expect(result.verdict).toBe("pass");
  });

  it("blocks a share position under the options-only rule", () => {
    const result = evaluateDeployGates({
      ...base,
      structure: "covered_call",
      rules: {},
    });
    expect(result.verdict).toBe("blocked");
    expect(result.conflicts).toContain("options-only");
  });

  it("blocks undefined-risk short premium (X03)", () => {
    const result = evaluateDeployGates({
      ...base,
      structure: "short_strangle",
      rules: {},
    });
    expect(result.conflicts).toContain("X03");
  });

  it("blocks a per-position premium above the NLV cap", () => {
    const result = evaluateDeployGates({
      ...base,
      structure: "call_debit_spread",
      rules: {},
      allocationPct: 40,
    });
    expect(result.premiumPerPositionPctNlv).toBeCloseTo(4, 6);
    expect(result.conflicts).toContain("premium-cap");
  });

  it("counts premium already open in the same name", () => {
    const result = evaluateDeployGates({
      ...base,
      structure: "long_call",
      rules: {},
      openPremiumInNameUsd: 1500,
    });
    expect(result.conflicts).toContain("premium-cap");
  });

  it("blocks when total academy allocations exceed 100%", () => {
    const result = evaluateDeployGates({
      ...base,
      structure: "call_debit_spread",
      rules: {},
      otherAllocationsPct: 95,
    });
    expect(result.conflicts).toContain("allocation-total");
  });

  it("blocks reward:risk below 2 unless logged hit-rate evidence supports it (X09)", () => {
    const blocked = evaluateDeployGates({
      ...base,
      structure: "put_credit_spread",
      rules: {},
    });
    expect(blocked.conflicts).toContain("X09");
    const supported = evaluateDeployGates({
      ...base,
      structure: "put_credit_spread",
      rules: {},
      evidence: { trades: 400, wins: 360 },
    });
    expect(supported.conflicts).not.toContain("X09");
  });

  it("blocks 0DTE and single-tranche entries", () => {
    const result = evaluateDeployGates({
      ...base,
      structure: "call_debit_spread",
      rules: { dte: 1 },
      tranches: 1,
    });
    expect(result.conflicts).toEqual(
      expect.arrayContaining(["no-0dte", "X10"])
    );
  });

  it("refuses an unknown NLV", () => {
    const result = evaluateDeployGates({
      ...base,
      structure: "call_debit_spread",
      rules: {},
      nlv: 0,
    });
    expect(result.conflicts).toContain("nlv-known");
  });
});

describe("checkOverride", () => {
  it("requires every conflict acknowledged and named in the explanation", () => {
    expect(checkOverride(["X03"], [], "short")).toEqual(
      expect.arrayContaining([
        expect.stringContaining("acknowledge X03"),
        expect.stringContaining("at least 40"),
      ])
    );
    expect(
      checkOverride(
        ["X03", "premium-cap"],
        ["X03", "premium-cap"],
        "I accept X03 because the hedge sits in another account; premium-cap breach is one month only."
      )
    ).toEqual([]);
    expect(
      checkOverride(
        ["X03"],
        ["X03"],
        "I accept this risk for a short test period only, sized small."
      )
    ).toEqual(["The explanation must name rule X03"]);
  });

  it("has nothing to override when there are no conflicts", () => {
    expect(checkOverride([], [], "")).toEqual([
      "There is no rule conflict to override",
    ]);
  });
});

describe("unit-fits-budget", () => {
  const status = (unitLossUsd: number | null, openPremiumInNameUsd = 0) =>
    evaluateDeployGates({
      ...base,
      structure: "long_call",
      rules: {},
      unitLossUsd,
      openPremiumInNameUsd,
    }).checks.find((check) => check.id === "unit-fits-budget");

  it("blocks one deep ITM unit that risks far more than the per-position budget", () => {
    // Budget $1,000 (10% x 10% of $100k); one unit risks $12,000 (12% of NLV).
    expect(status(12_000)?.status).toBe("conflict");
    expect(status(12_000)?.detail).toContain("$12,000");
  });

  it("blocks a unit that fits the budget but not the NLV cap with premium already open", () => {
    expect(status(900, 1500)?.status).toBe("conflict");
  });

  it("passes a unit inside the budget and the cap", () => {
    expect(status(900)?.status).toBe("pass");
  });

  it("blocks when one unit could not be priced", () => {
    expect(status(null)?.detail).toContain("could not be priced");
    expect(status(null)?.status).toBe("conflict");
  });

  it("is not checked when the caller does not size real units", () => {
    expect(
      evaluateDeployGates({
        ...base,
        structure: "long_call",
        rules: {},
      }).checks.map((check) => check.id)
    ).not.toContain("unit-fits-budget");
  });
});

describe("gate edge cases", () => {
  const find = (result: ReturnType<typeof evaluateDeployGates>, id: string) =>
    result.checks.find((check) => check.id === id);

  it("bounds the Wilson lower bound at zero trades", () => {
    expect(wilsonLower(0, 0)).toBe(0);
    expect(wilsonLower(8, 10)).toBeGreaterThan(0.4);
  });

  it("uses the LEAPS cap and reports an unknown NLV", () => {
    const result = evaluateDeployGates({
      ...base,
      nlv: 0,
      structure: "long_call",
      rules: {},
      caps: { ...caps, leapsMinDte: 1, leapsPremiumPct: 7 },
    });
    expect(find(result, "nlv-known")?.status).toBe("conflict");
    expect(find(result, "premium-cap")?.detail).toBe(
      "NLV unknown: the 7% cap cannot be checked."
    );
  });

  it("names the LEAPS cap when NLV is known", () => {
    const result = evaluateDeployGates({
      ...base,
      structure: "long_call",
      rules: {},
      caps: { ...caps, leapsMinDte: 1, leapsPremiumPct: 7 },
    });
    expect(find(result, "premium-cap")?.detail).toContain("cap 7% (LEAPS)");
  });

  it("flags undefined risk without a stop under X02", () => {
    const result = evaluateDeployGates({
      ...base,
      structure: "synthetic_long",
      rules: { stopLossPct: 1000 },
    });
    expect(find(result, "X02")).toMatchObject({
      status: "conflict",
      detail: "No stop and undefined risk.",
    });
  });

  it("warns when long premium exits inside 10 DTE (C093)", () => {
    const result = evaluateDeployGates({
      ...base,
      structure: "long_call",
      rules: { exitDte: 5 },
    });
    expect(find(result, "C093")?.detail).toContain("exits at 5 DTE");
  });
});
