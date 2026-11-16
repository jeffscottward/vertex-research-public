import { describe, expect, it } from "vitest";

import { FlowCollectOutputSchema } from "./contracts/flow.ts";

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
