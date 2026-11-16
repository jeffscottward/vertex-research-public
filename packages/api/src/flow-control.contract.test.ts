import { describe, expect, it } from "vitest";

import {
  FlowCollectInputSchema,
  FlowCollectOutputSchema,
  FlowFreshnessSchema,
  FlowSnapshotToolInputSchema,
} from "./contracts/flow.ts";

const collectOutput = {
  at: "2026-11-13T15:00:00.000Z",
  budget: {
    ibkrLimit: 6,
    ibkrRecent: 2,
    quantDataFree: 17,
    quantDataReserve: 6,
    runSeconds: 41,
  },
  busy: false,
  dryRun: false,
  pruned: 0,
  runs: [],
};

describe("flow.collect output", () => {
  it("requires the budget block in the collect output", () => {
    expect(FlowCollectOutputSchema.safeParse(collectOutput).success).toBe(true);
    const { budget: _budget, ...withoutBudget } = collectOutput;
    expect(FlowCollectOutputSchema.safeParse(withoutBudget).success).toBe(
      false
    );
    expect(
      FlowCollectOutputSchema.safeParse({
        ...collectOutput,
        budget: {
          ...collectOutput.budget,
          ibkrRecent: null,
          quantDataFree: null,
        },
      }).success
    ).toBe(true);
    expect(
      FlowCollectOutputSchema.safeParse({
        ...collectOutput,
        budget: { ...collectOutput.budget, extra: 1 },
      }).success
    ).toBe(false);
  });
});

describe("four symbols", () => {
  it("accepts four symbols in flow.collect and rejects five", () => {
    expect(
      FlowCollectInputSchema.safeParse({ symbols: ["SPY", "ES", "QQQ", "NQ"] })
        .success
    ).toBe(true);
    expect(
      FlowCollectInputSchema.safeParse({
        symbols: ["SPY", "ES", "QQQ", "NQ", "SPY"],
      }).success
    ).toBe(false);
  });

  it("keeps flow-snapshot.v1 freshness to the four snapshot sources", () => {
    const row = {
      ageSeconds: null,
      lastOkAt: null,
      lastStatus: null,
      message: null,
      sessionOpen: true,
      source: "gex",
      state: "never",
    };
    expect(FlowFreshnessSchema.safeParse(row).success).toBe(true);
    expect(
      FlowFreshnessSchema.safeParse({ ...row, source: "net_drift" }).success
    ).toBe(false);
  });

  it("the tool input of flow_snapshot accepts SPY and ES and rejects QQQ", () => {
    for (const symbol of ["SPY", "ES"])
      expect(FlowSnapshotToolInputSchema.safeParse({ symbol }).success).toBe(
        true
      );
    expect(
      FlowSnapshotToolInputSchema.safeParse({ symbol: "QQQ" }).success
    ).toBe(false);
  });
});
