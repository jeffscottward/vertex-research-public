import { describe, expect, it } from "vitest";

import {
  FLOW_FILTER_PROFILE,
  type FlowControlRules,
} from "./contracts/flow.ts";
import {
  crossCheckResult,
  describeAgreement,
  describeCrossCheck,
  describeParts,
  describeSide,
  describeStudy,
  FLOW_CONTROL_RULES,
  FLOW_CONTROL_STUDY_RULES_ITEM,
  type FlowDriftMinute,
  type FlowSideFacts,
  foldControlState,
  groupOptionsState,
  optionsRatio,
  windowTotals,
} from "./flow-control-rules.ts";
import golden from "./fixtures/flow-control-golden.fixture.json" with {
  type: "json",
};

const rulesWith = (overrides: Partial<FlowControlRules>): FlowControlRules => ({
  ...FLOW_CONTROL_RULES,
  ...overrides,
});

const run = (
  spec: readonly (readonly [number, number, number, number])[]
): FlowDriftMinute[] =>
  spec.flatMap(([start, end, netCallPremium, netPutPremium]) =>
    Array.from({ length: end - start }, (_, index) => ({
      minute: start + index,
      netCallPremium,
      netPutPremium,
    }))
  );

const facts = (overrides: Partial<FlowSideFacts> = {}): FlowSideFacts => ({
  buckets: 12,
  cause: null,
  checkInstrument: "SPY",
  closeState: null,
  instrument: "SPX",
  minutesSinceOpen: 4,
  newestBucketEt: null,
  primaryState: "buyers",
  ratio: 0.42,
  reason: null,
  sessionDate: "2026-11-13",
  staleMinutes: 5,
  state: "buyers",
  ...overrides,
});

describe("golden vectors", () => {
  it("replays every options case of the golden fixture: ratio, state, reason and start minute per minute", () => {
    expect(golden.optionsCases.length).toBeGreaterThan(0);
    for (const testCase of golden.optionsCases) {
      const rules = rulesWith(
        "rules" in testCase ? (testCase.rules as Partial<FlowControlRules>) : {}
      );
      const steps = foldControlState(testCase.minutes, rules);
      expect(
        steps.map((step) => step.minute),
        testCase.name
      ).toEqual(testCase.expected.map((step) => step.minute));
      steps.forEach((step, index) => {
        const expected = testCase.expected[index];
        expect(step.state, `${testCase.name} ${index}`).toBe(expected?.state);
        expect(step.noDataReason, `${testCase.name} ${index}`).toBe(
          expected?.noDataReason
        );
        expect(step.sinceMinute, `${testCase.name} ${index}`).toBe(
          expected?.sinceMinute
        );
        if (expected?.ratio === null || expected?.ratio === undefined)
          expect(step.ratio).toBeNull();
        else expect(step.ratio).toBeCloseTo(expected.ratio, 9);
      });
    }
  });

  it("replays every group case of the golden fixture", () => {
    expect(golden.groupCases.length).toBeGreaterThan(0);
    for (const testCase of golden.groupCases)
      expect(
        groupOptionsState(
          testCase.primary as Parameters<typeof groupOptionsState>[0],
          testCase.check as Parameters<typeof groupOptionsState>[1]
        ),
        testCase.name
      ).toBe(testCase.expected);
  });

  it("the fixture carries the rules object, the study rules item and the filter profile of the code", () => {
    expect(golden.rules).toEqual(FLOW_CONTROL_RULES);
    expect(golden.studyRulesItem).toBe(FLOW_CONTROL_STUDY_RULES_ITEM);
    expect(golden.filterProfile).toBe(FLOW_FILTER_PROFILE);
  });
});

describe("foldControlState", () => {
  it("ratio is 0 for a zero denominator and the state stays balanced", () => {
    expect(optionsRatio([])).toBe(0);
    const steps = foldControlState(run([[0, 12, 0, 0]]), FLOW_CONTROL_RULES);
    expect(steps.at(-1)).toMatchObject({ ratio: 0, state: "balanced" });
  });

  it("reports session_start before minBuckets minutes and gap after them", () => {
    const steps = foldControlState(
      run([
        [0, 12, 1000, 0],
        [40, 41, 1000, 0],
      ]),
      FLOW_CONTROL_RULES
    );
    expect(steps[8]).toMatchObject({
      noDataReason: "session_start",
      state: "no_data",
    });
    expect(steps[9]).toMatchObject({ noDataReason: null, state: "balanced" });
    expect(steps[40]).toMatchObject({ noDataReason: "gap", state: "no_data" });
  });

  it("returns no step for an empty input", () => {
    expect(foldControlState([], FLOW_CONTROL_RULES)).toEqual([]);
  });

  it("enters after minMinutes in a row and dates the start at the first of them", () => {
    const steps = foldControlState(run([[0, 20, 1000, 0]]), FLOW_CONTROL_RULES);
    expect(steps[12]).toMatchObject({ sinceMinute: null, state: "balanced" });
    expect(steps[13]).toMatchObject({ sinceMinute: 9, state: "buyers" });
  });

  it("a ratio equal to the enter ratio counts and a ratio equal to the exit ratio keeps control", () => {
    const rules = rulesWith({ windowMinutes: 10 });
    const steps = foldControlState(
      run([
        [0, 20, 650, 350],
        [20, 40, 550, 450],
      ]),
      rules
    );
    expect(steps[13]).toMatchObject({ ratio: 0.3, state: "buyers" });
    expect(steps[39]).toMatchObject({ ratio: 0.1, state: "buyers" });
  });

  it("a ratio between the two resets the run", () => {
    const rules = rulesWith({ minBuckets: 1, windowMinutes: 1 });
    const steps = foldControlState(
      run([
        [0, 4, 1000, 0],
        [4, 5, 600, 400],
        [5, 9, 1000, 0],
        [9, 10, 0, 1000],
        [10, 15, 1000, 0],
      ]),
      rules
    );
    expect(steps.map((step) => step.state)).toEqual([
      ...new Array(14).fill("balanced"),
      "buyers",
    ]);
    expect(steps[14]?.sinceMinute).toBe(10);
  });

  it("after a gap the step reports the carried state with its original start", () => {
    const rules = rulesWith({ windowMinutes: 10 });
    const steps = foldControlState(
      run([
        [0, 20, 1000, 0],
        [45, 60, 1000, 0],
      ]),
      rules
    );
    expect(steps[30]).toMatchObject({ sinceMinute: null, state: "no_data" });
    expect(steps[54]).toMatchObject({ sinceMinute: 9, state: "buyers" });
  });

  it("sellers mirror buyers", () => {
    const rules = rulesWith({ windowMinutes: 10 });
    const steps = foldControlState(
      run([
        [0, 20, 0, 1000],
        [20, 40, 450, 550],
        [40, 60, 1000, 0],
      ]),
      rules
    );
    expect(steps[13]).toMatchObject({ sinceMinute: 9, state: "sellers" });
    expect(steps[39]).toMatchObject({ ratio: -0.1, state: "sellers" });
    expect(steps[59]?.state).toBe("buyers");
  });

  it("an exit with a ratio at or below the negative enter ratio starts a sell run", () => {
    const rules = rulesWith({ minBuckets: 1, minMinutes: 1, windowMinutes: 1 });
    const steps = foldControlState(
      run([
        [0, 2, 1000, 0],
        [2, 3, 0, 1000],
      ]),
      rules
    );
    expect(steps.map((step) => [step.state, step.sinceMinute])).toEqual([
      ["buyers", 0],
      ["buyers", 0],
      ["sellers", 2],
    ]);
  });

  it("works with windows of 15, 30 and 60 minutes", () => {
    const minutes = run([
      [0, 10, 700, 300],
      [10, 25, 300, 700],
      [25, 50, 800, 100],
    ]);
    const states = [15, 30, 60].map(
      (windowMinutes) =>
        foldControlState(minutes, rulesWith({ windowMinutes })).at(-1)?.state
    );
    expect(states).toEqual(["buyers", "buyers", "balanced"]);
    expect(windowTotals(minutes, 49, rulesWith({ windowMinutes: 15 }))).toEqual(
      { denominator: 13_500, numerator: 10_500, rows: 15 }
    );
  });
});

describe("groupOptionsState and crossCheckResult", () => {
  it("uses the primary state and marks opposite control as mixed", () => {
    expect(groupOptionsState("buyers", "sellers")).toBe("mixed");
    expect(groupOptionsState("sellers", "buyers")).toBe("mixed");
    expect(groupOptionsState("sellers", "sellers")).toBe("sellers");
    expect(groupOptionsState("no_data", "buyers")).toBe("no_data");
    expect(groupOptionsState("balanced", "no_data")).toBe("balanced");
  });

  it("cross-check needs 20 prints and two non-zero figures", () => {
    expect(crossCheckResult(10, 5, 19)).toBe("not_comparable");
    expect(crossCheckResult(null, 5, 20)).toBe("not_comparable");
    expect(crossCheckResult(0, 5, 20)).toBe("not_comparable");
    expect(crossCheckResult(10, 0, 20)).toBe("not_comparable");
    expect(crossCheckResult(10, 5, 20)).toBe("same_direction");
    expect(crossCheckResult(-10, 5, 20)).toBe("opposite_direction");
  });
});

describe("describeSide", () => {
  const side = (overrides: Partial<FlowSideFacts>) =>
    describeSide(facts(overrides), FLOW_CONTROL_RULES);

  it.each([
    ["buyers", "SPX options: bullish, call buying leads"],
    ["sellers", "SPX options: bearish, put buying leads"],
    ["balanced", "SPX options: balanced"],
  ] as const)("%s", (state, label) => {
    expect(side({ state })).toEqual({
      detail: "Ratio 0.42 over the last 30 min; enter ratio 0.30",
      label,
    });
  });

  it("mixed names both tickers and their sides", () => {
    expect(side({ primaryState: "buyers", state: "mixed" })).toEqual({
      detail:
        "SPX ratio 0.42 over the last 30 min; SPY is in control of the other side",
      label: "Options mixed: SPX bullish, SPY bearish",
    });
    expect(
      side({
        checkInstrument: null,
        primaryState: "sellers",
        ratio: null,
        state: "mixed",
      })
    ).toEqual({
      detail:
        "SPX ratio 0.00 over the last 30 min;  is in control of the other side",
      label: "Options mixed: SPX bearish,  bullish",
    });
  });

  it.each([
    [
      "buyers",
      "Last session ended 16:15 ET on 2026-11-13; at the close the SPX options side was bullish",
    ],
    [
      "sellers",
      "Last session ended 16:15 ET on 2026-11-13; at the close the SPX options side was bearish",
    ],
    [
      "balanced",
      "Last session ended 16:15 ET on 2026-11-13; at the close the SPX options side was balanced",
    ],
    [
      "mixed",
      "Last session ended 16:15 ET on 2026-11-13; at the close the SPX options side was mixed",
    ],
    [
      "no_data",
      "Last session ended 16:15 ET on 2026-11-13; at the close the SPX options side had no state",
    ],
    [null, "No net drift session is stored yet"],
  ] as const)("market_closed with close state %s", (closeState, detail) => {
    expect(
      side({ closeState, reason: "market_closed", state: "no_data" })
    ).toEqual({ detail, label: "Market closed" });
  });

  it("source_unavailable gives the cause or a default", () => {
    expect(
      side({
        cause: "HTTP 500",
        reason: "source_unavailable",
        state: "no_data",
      })
    ).toEqual({
      detail: "HTTP 500",
      label: "No answer from QuantData net drift",
    });
    expect(
      side({ reason: "source_unavailable", state: "no_data" }).detail
    ).toBe("the last request failed");
  });

  it("stale with and without a bucket", () => {
    expect(
      side({ newestBucketEt: "10:41 ET", reason: "stale", state: "no_data" })
    ).toEqual({
      detail: "Newest SPX bucket is 10:41 ET; stale after 5 min",
      label: "Net drift is stale",
    });
    expect(side({ reason: "stale", state: "no_data" }).detail).toBe(
      "No SPX bucket since 09:30 ET; stale after 5 min"
    );
  });

  it("gap, session_start, sampled_tape and not_collected", () => {
    expect(side({ reason: "gap", state: "no_data" })).toEqual({
      detail: "12 of 10 buckets needed in the last 30 min for SPX",
      label: "Gap in net drift",
    });
    expect(side({ reason: "session_start", state: "no_data" })).toEqual({
      detail: "4 of 10 minutes needed since 09:30 ET",
      label: "Session start",
    });
    expect(side({ state: "no_data" }).label).toBe("Session start");
    expect(
      side({ instrument: "ES", reason: "sampled_tape", state: "no_data" })
    ).toEqual({
      detail: "ES trades are sampled; no state is computed from them",
      label: "Sampled tape",
    });
    expect(
      side({ instrument: "ES", reason: "not_collected", state: "no_data" })
    ).toEqual({
      detail: "ES deep trades are not collected yet",
      label: "Futures: deep trades not collected yet",
    });
  });

  it("cuts a detail to 300 characters", () => {
    expect(
      side({
        cause: "x".repeat(400),
        reason: "source_unavailable",
        state: "no_data",
      }).detail
    ).toHaveLength(300);
  });

  it("every text takes its numbers from the rules argument and the facts", () => {
    const rules = rulesWith({
      enterRatio: 0.25,
      minBuckets: 8,
      windowMinutes: 15,
    });
    expect(describeSide(facts({ ratio: 0.5 }), rules).detail).toBe(
      "Ratio 0.50 over the last 15 min; enter ratio 0.25"
    );
    expect(
      describeSide(
        facts({ buckets: 3, reason: "gap", state: "no_data" }),
        rules
      ).detail
    ).toBe("3 of 8 buckets needed in the last 15 min for SPX");
    expect(
      describeSide(
        facts({
          minutesSinceOpen: 2,
          reason: "session_start",
          state: "no_data",
        }),
        rules
      ).detail
    ).toBe("2 of 8 minutes needed since 09:30 ET");
  });
});

describe("describeAgreement, describeParts, describeCrossCheck, describeStudy", () => {
  const futures = {
    detail: "ES deep trades are not collected yet",
    instrument: "ES",
    label: "Futures: deep trades not collected yet",
    state: "no_data" as const,
  };
  const options = {
    detail: "4 of 10 minutes needed since 09:30 ET",
    instrument: "SPX",
    label: "Session start",
    state: "no_data" as const,
  };

  it("agreement text names the side without data (the futures side when both have none)", () => {
    expect(describeAgreement(futures, options)).toEqual({
      detail:
        "Futures: deep trades not collected yet: ES deep trades are not collected yet",
      label: "Cannot compare",
    });
    expect(
      describeAgreement({ ...futures, state: "buyers" }, options).detail
    ).toBe("Session start: 4 of 10 minutes needed since 09:30 ET");
    expect(
      describeAgreement(futures, { ...options, state: "buyers" }).detail
    ).toContain("Futures");
    expect(
      describeAgreement(
        { ...futures, state: "buyers" },
        { ...options, state: "buyers" }
      ).detail
    ).toContain("Futures");
  });

  it("describeParts names the missing same-day part", () => {
    expect(describeParts("QQQ")).toBe(
      "The same-day (0DTE) part of QQQ net drift is missing; the totals are complete"
    );
  });

  it.each([
    [
      "same_direction",
      "Stored SPX option prints point the same way as the vendor net drift (25 prints, 2 unread time ranges)",
    ],
    [
      "opposite_direction",
      "Stored SPX option prints point the other way (25 prints, 2 unread time ranges). Check the filter profile and the vendor status. No state is changed.",
    ],
    [
      "not_comparable",
      "Too few stored SPX option prints to compare, or one figure is zero (25 prints, 20 needed)",
    ],
    ["not_collected", "Option prints are not collected for SPX"],
  ] as const)("cross-check %s", (result, text) => {
    expect(
      describeCrossCheck({
        result,
        storedPrints: 25,
        ticker: "SPX",
        unreadRanges: 2,
      })
    ).toBe(text);
  });

  it.each([
    [
      "not_tested",
      null,
      "Options-side continuation rule (modelled fills): not tested yet",
    ],
    [
      "edge",
      "2026-12-01",
      "Options-side continuation rule (modelled fills): tested on 2026-12-01, edge found (Strategy Library)",
    ],
    [
      "no-edge",
      "2026-12-01",
      "Options-side continuation rule (modelled fills): tested on 2026-12-01, no edge found (Strategy Library)",
    ],
    [
      "needs-more-data",
      null,
      "Options-side continuation rule (modelled fills): tested on , more data needed (Strategy Library)",
    ],
  ] as const)("study %s", (status, testedOn, text) => {
    expect(describeStudy({ status, testedOn })).toBe(text);
  });
});
