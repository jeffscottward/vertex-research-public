import { describe, expect, it } from "vitest";

import {
  resolveRules,
  STRUCTURE_RULE_KEYS,
  structureLegs,
} from "./structures.ts";

describe("structureLegs strike collisions", () => {
  it("keeps long put < short put < short call < long call when rounding merges the put strikes", () => {
    const legs = structureLegs(
      "iron_condor",
      resolveRules("iron_condor", { dte: 7, exitDte: 0 }),
      500,
      0.12,
      0.04
    );
    const strike = (side: string, kind: string) =>
      legs.find((leg) => leg.side === side && leg.kind === kind)?.strike ?? 0;
    expect(strike("long", "put")).toBeLessThan(strike("short", "put"));
    expect(strike("short", "put")).toBeLessThan(strike("short", "call"));
    expect(strike("short", "call")).toBeLessThan(strike("long", "call"));
    expect(legs).toHaveLength(4);
  });

  it("moves the wing outward on an iron butterfly collision as well", () => {
    const legs = structureLegs(
      "iron_butterfly",
      resolveRules("iron_butterfly", { dte: 2, exitDte: 0 }),
      500,
      0.05,
      0.04
    );
    const strike = (side: string, kind: string) =>
      legs.find((leg) => leg.side === side && leg.kind === kind)?.strike ?? 0;
    expect(strike("long", "put")).toBeLessThan(strike("short", "put"));
    expect(strike("short", "call")).toBeLessThan(strike("long", "call"));
  });
});

describe("rule resolution and leg defaults", () => {
  it("lists rule keys and validates layers", () => {
    expect(STRUCTURE_RULE_KEYS("long_call")).toContain("longDelta");
    expect(resolveRules("long_call", undefined, { dte: 20 })["dte"]).toBe(20);
    expect(() => resolveRules("long_call", { bogus: 1 })).toThrow(
      /bogus is not a rule/u
    );
    expect(() => resolveRules("long_call", { dte: Number.NaN })).toThrow(
      /dte must be a finite number/u
    );
  });

  it("falls back to 30 DTE and 0.5 delta with empty rules on a cheap stock", () => {
    const calls = structureLegs("long_call", {}, 20, 0.3, 0.04);
    expect(calls[0]?.dte).toBe(30);
    expect(calls[0]?.strike).toBe(20);
    const puts = structureLegs("long_put", {}, 20, 0.3, 0.04);
    expect(puts[0]?.strike).toBe(20);
    const covered = structureLegs("covered_call", {}, 80, 0.3, 0.04);
    expect(covered.map((leg) => leg.label)).toContain("Long 100 shares");
  });

  it("labels short and multi-contract legs", () => {
    const legs = structureLegs(
      "ratio_call_spread",
      resolveRules("ratio_call_spread"),
      100,
      0.3,
      0.04
    );
    expect(legs[0]?.label).toMatch(/^Long \d/u);
    expect(legs[1]?.label).toMatch(/^Short 2x /u);
  });
});
