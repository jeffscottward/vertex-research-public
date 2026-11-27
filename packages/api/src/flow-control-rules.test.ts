import { describe, expect, it } from "vitest";

import {
  FLOW_CONTROL_STATES,
  FLOW_FILTER_PROFILE,
  type FlowControlRules,
  type FlowControlState,
  type FlowFuturesRules,
  FlowFuturesRulesSchema,
} from "./contracts/flow.ts";
import golden from "./fixtures/flow-control-golden.fixture.json" with {
  type: "json",
};
import {
  agreementOf,
  crossCheckResult,
  describeAgreement,
  describeCrossCheck,
  describeFuturesSide,
  describeParts,
  describeSide,
  describeStudy,
  FLOW_CONTROL_RULES,
  FLOW_CONTROL_STUDY_RULES_ITEM,
  FLOW_FUTURES_RULES,
  FLOW_STUDY_AGREEMENT_DETAIL,
  type FlowDriftMinute,
  type FlowFuturesSideFacts,
  type FlowSideFacts,
  type FlowTapeMinute,
  foldControlState,
  foldFuturesState,
  futuresWindowTotals,
  groupOptionsState,
  optionsRatio,
  windowTotals,
} from "./flow-control-rules.ts";

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
    expect(golden.futuresRules).toEqual(FLOW_FUTURES_RULES);
    expect(golden.studyRulesItem).toBe(FLOW_CONTROL_STUDY_RULES_ITEM);
    expect(golden.filterProfile).toBe(FLOW_FILTER_PROFILE);
  });

  it("replays every futures case of the golden fixture: ratio, state, reason, start minute, hold and trades", () => {
    expect(golden.futuresCases.length).toBeGreaterThan(0);
    for (const testCase of golden.futuresCases) {
      const rules: FlowFuturesRules = {
        ...FLOW_FUTURES_RULES,
        ...("rules" in testCase
          ? (testCase.rules as Partial<FlowFuturesRules>)
          : {}),
      };
      const through =
        "through" in testCase && typeof testCase.through === "number"
          ? testCase.through
          : -1;
      const steps = foldFuturesState(testCase.minutes, rules, through);
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
        expect(step.hold, `${testCase.name} ${index}`).toBe(expected?.hold);
        expect(step.trades, `${testCase.name} ${index}`).toBe(expected?.trades);
        if (expected?.ratio === null || expected?.ratio === undefined)
          expect(step.ratio).toBeNull();
        else expect(step.ratio).toBeCloseTo(expected.ratio, 9);
      });
    }
  });

  it("replays every agreement case of the golden fixture", () => {
    expect(golden.agreementCases.length).toBe(25);
    for (const testCase of golden.agreementCases)
      expect(
        agreementOf(
          testCase.futures as FlowControlState,
          testCase.options as FlowControlState
        ),
        testCase.name
      ).toEqual(testCase.expected);
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

  it("storage_failed names the stored cause or a default", () => {
    expect(
      side({
        cause: "storage: write failed (TypeError)",
        reason: "storage_failed",
        state: "no_data",
      })
    ).toEqual({
      detail:
        "The last SPX net drift answer was not stored (storage: write failed (TypeError)); the next run retries",
      label: "Net drift was not stored",
    });
    expect(side({ reason: "storage_failed", state: "no_data" }).detail).toBe(
      "The last SPX net drift answer was not stored (write failed); the next run retries"
    );
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

  it("gap, session_start and not_collected", () => {
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
    detail: "No ES tape read since 09:30 ET; stale after 3 min",
    instrument: "ES",
    label: "Futures tape is stale",
    state: "no_data" as const,
  };
  const options = {
    detail: "4 of 10 minutes needed since 09:30 ET",
    instrument: "SPX",
    label: "Session start",
    state: "no_data" as const,
  };
  const futuresBuyers = {
    ...futures,
    label: "ES futures: buyers in control",
    state: "buyers" as const,
  };
  const futuresBalanced = {
    ...futures,
    label: "ES futures: balanced",
    state: "balanced" as const,
  };
  const optionsBuyers = {
    ...options,
    label: "SPX options: bullish, call buying leads",
    state: "buyers" as const,
  };
  const optionsSellers = {
    ...options,
    label: "SPX options: bearish, put buying leads",
    state: "sellers" as const,
  };
  const optionsBalanced = {
    ...options,
    label: "SPX options: balanced",
    state: "balanced" as const,
  };
  const agreement = (
    futuresSide: Readonly<{ state: FlowControlState }>,
    optionsSide: Readonly<{ state: FlowControlState }>
  ) => agreementOf(futuresSide.state, optionsSide.state);

  it("agree names the control side of both sides", () => {
    expect(
      describeAgreement(
        agreement(futuresBuyers, optionsBuyers),
        futuresBuyers,
        optionsBuyers
      )
    ).toEqual({
      detail: "ES futures and SPX options both show buyers in control",
      label: "Agree: buyers in control on both sides",
    });
    const futuresSellers = { ...futures, state: "sellers" as const };
    expect(
      describeAgreement(
        agreement(futuresSellers, optionsSellers),
        { ...futuresSellers, instrument: "NQ" },
        { ...optionsSellers, instrument: "NDX" }
      )
    ).toEqual({
      detail: "NQ futures and NDX options both show sellers in control",
      label: "Agree: sellers in control on both sides",
    });
  });

  it("diverge and one_sided give the two labels", () => {
    expect(
      describeAgreement(
        agreement(futuresBuyers, optionsSellers),
        futuresBuyers,
        optionsSellers
      )
    ).toEqual({
      detail:
        "ES futures: buyers in control; SPX options: bearish, put buying leads",
      label: "Diverge: the two sides show opposite control",
    });
    expect(
      describeAgreement(
        agreement(futuresBuyers, optionsBalanced),
        futuresBuyers,
        optionsBalanced
      )
    ).toEqual({
      detail: "ES futures: buyers in control; SPX options: balanced",
      label: "One-sided: only the futures side shows control",
    });
    expect(
      describeAgreement(
        agreement(futuresBalanced, optionsSellers),
        futuresBalanced,
        optionsSellers
      )
    ).toEqual({
      detail: "ES futures: balanced; SPX options: bearish, put buying leads",
      label: "One-sided: only the options side shows control",
    });
  });

  it("both_balanced names both instruments", () => {
    expect(
      describeAgreement(
        agreement(futuresBalanced, optionsBalanced),
        futuresBalanced,
        optionsBalanced
      )
    ).toEqual({
      detail: "Neither ES futures nor SPX options show a side in control",
      label: "Both sides balanced",
    });
  });

  it("not_comparable names the futures side when it has no data, else the options side (no data or mixed)", () => {
    expect(
      describeAgreement(agreement(futures, options), futures, options)
    ).toEqual({
      detail:
        "Futures tape is stale: No ES tape read since 09:30 ET; stale after 3 min",
      label: "Cannot compare",
    });
    expect(
      describeAgreement(
        agreement(futures, optionsBuyers),
        futures,
        optionsBuyers
      ).detail
    ).toContain("Futures tape is stale");
    expect(
      describeAgreement(
        agreement(futuresBuyers, options),
        futuresBuyers,
        options
      )
    ).toEqual({
      detail: "Session start: 4 of 10 minutes needed since 09:30 ET",
      label: "Cannot compare",
    });
    const mixed = {
      detail:
        "SPX ratio 0.42 over the last 30 min; SPY is in control of the other side",
      instrument: "SPX",
      label: "Options mixed: SPX bullish, SPY bearish",
      state: "mixed" as const,
    };
    expect(
      describeAgreement(agreement(futuresBuyers, mixed), futuresBuyers, mixed)
        .detail
    ).toBe(
      "Options mixed: SPX bullish, SPY bearish: SPX ratio 0.42 over the last 30 min; SPY is in control of the other side"
    );
  });

  it("cuts an agreement detail to 300 characters", () => {
    const long = { ...futures, detail: "x".repeat(400) };
    expect(
      describeAgreement(agreement(long, options), long, options).detail
    ).toHaveLength(300);
  });

  it("the study sentence says that the agreement is not an entry rule yet", () => {
    expect(FLOW_STUDY_AGREEMENT_DETAIL).toBe(
      "the agreement is not tested as an entry rule yet"
    );
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

describe("describeFuturesSide", () => {
  const facts = (
    overrides: Partial<FlowFuturesSideFacts> = {}
  ): FlowFuturesSideFacts => ({
    cause: null,
    coveredMinutes: 28,
    hold: null,
    instrument: "ES",
    newestReadEt: null,
    ratio: 0.42,
    reason: null,
    sessionDate: "2026-11-13",
    staleMinutes: 3,
    state: "buyers",
    trades: 14,
    ...overrides,
  });
  const text = (overrides: Partial<FlowFuturesSideFacts> = {}) =>
    describeFuturesSide(facts(overrides), FLOW_FUTURES_RULES);
  const sentence =
    "Deep-trade ratio 0.42 over the last 30 min from 14 deep trades; enter ratio 0.30";

  it("buyers, sellers and balanced give the ratio sentence", () => {
    expect(text()).toEqual({
      detail: sentence,
      label: "ES futures: buyers in control",
    });
    expect(text({ ratio: -0.5, state: "sellers" })).toEqual({
      detail:
        "Deep-trade ratio -0.50 over the last 30 min from 14 deep trades; enter ratio 0.30",
      label: "ES futures: sellers in control",
    });
    expect(text({ state: "balanced" })).toEqual({
      detail: sentence,
      label: "ES futures: balanced",
    });
  });

  it.each([
    ["few_trades", "fewer than 10 deep trades"],
    ["delta_against", "the delta of all trades points the other way"],
    ["price_against", "the price is on the other side of the 30-min VWAP"],
  ] as const)(
    "balanced with the hold %s adds why the ratio is not counted",
    (hold, why) => {
      expect(text({ hold, state: "balanced" })).toEqual({
        detail: `${sentence}; not counted: ${why}`,
        label: "ES futures: balanced",
      });
    }
  );

  it("session_start and gap count the covered tape minutes", () => {
    expect(
      text({ coveredMinutes: 4, reason: "session_start", state: "no_data" })
    ).toEqual({
      detail: "4 of 10 covered tape minutes needed in the last 30 min for ES",
      label: "Futures: session start",
    });
    expect(text({ coveredMinutes: 4, state: "no_data" }).label).toBe(
      "Futures: session start"
    );
    expect(
      text({ coveredMinutes: 22, reason: "gap", state: "no_data" })
    ).toEqual({
      detail:
        "22 covered tape minutes in the last 30 min for ES; at most 5 may be missing",
      label: "Gap in the ES tape",
    });
  });

  it("stale with and without a tape read", () => {
    expect(
      text({ newestReadEt: "10:41 ET", reason: "stale", state: "no_data" })
    ).toEqual({
      detail: "Newest ES tape read is 10:41 ET; stale after 3 min",
      label: "Futures tape is stale",
    });
    expect(text({ reason: "stale", state: "no_data" }).detail).toBe(
      "No ES tape read since 09:30 ET; stale after 3 min"
    );
  });

  it("source_unavailable gives the cause, or a default", () => {
    expect(
      text({
        cause: "tape stream down: no tick",
        reason: "source_unavailable",
        state: "no_data",
      })
    ).toEqual({
      detail: "tape stream down: no tick",
      label: "No answer from the IBKR tape",
    });
    expect(
      text({ reason: "source_unavailable", state: "no_data" }).detail
    ).toBe("the last request failed");
  });

  it("storage_failed names the read that was not stored, with the cause or a default", () => {
    expect(
      text({
        cause: "storage write failed: connection reset",
        reason: "storage_failed",
        state: "no_data",
      })
    ).toEqual({
      detail:
        "The last ES tape read was not stored (storage write failed: connection reset); the next run retries",
      label: "Futures tape was not stored",
    });
    expect(text({ reason: "storage_failed", state: "no_data" }).detail).toBe(
      "The last ES tape read was not stored (write failed); the next run retries"
    );
  });

  it("market_closed names the window and the last session", () => {
    expect(text({ reason: "market_closed", state: "no_data" })).toEqual({
      detail:
        "The ES deep-trade window is 09:30 to 16:00 ET; the last window was 2026-11-13",
      label: "Market closed",
    });
  });

  it("cuts a futures detail at 300 characters", () => {
    expect(
      text({
        cause: "x".repeat(400),
        reason: "source_unavailable",
        state: "no_data",
      }).detail
    ).toHaveLength(300);
  });

  it("every futures text takes its numbers from the rules argument and the facts", () => {
    const rules: FlowFuturesRules = {
      ...FLOW_FUTURES_RULES,
      enterRatio: 0.4,
      maxMissingMinutes: 7,
      minBuckets: 12,
      minTrades: 25,
      windowMinutes: 45,
    };
    const custom = (overrides: Partial<FlowFuturesSideFacts>) =>
      describeFuturesSide(
        facts({ instrument: "NQ", ratio: null, trades: 3, ...overrides }),
        rules
      ).detail;
    expect(custom({ hold: "few_trades", state: "balanced" })).toBe(
      "Deep-trade ratio 0.00 over the last 45 min from 3 deep trades; enter ratio 0.40; not counted: fewer than 25 deep trades"
    );
    expect(custom({ hold: "price_against", state: "balanced" })).toContain(
      "the 45-min VWAP"
    );
    expect(custom({ reason: "session_start", state: "no_data" })).toBe(
      "28 of 12 covered tape minutes needed in the last 45 min for NQ"
    );
    expect(custom({ reason: "gap", state: "no_data" })).toBe(
      "28 covered tape minutes in the last 45 min for NQ; at most 7 may be missing"
    );
    expect(
      custom({
        newestReadEt: "11:05 ET",
        reason: "stale",
        staleMinutes: 15,
        state: "no_data",
      })
    ).toBe("Newest NQ tape read is 11:05 ET; stale after 15 min");
    expect(
      custom({
        reason: "market_closed",
        sessionDate: "2026-11-16",
        state: "no_data",
      })
    ).toBe(
      "The NQ deep-trade window is 09:30 to 16:00 ET; the last window was 2026-11-16"
    );
  });
});

describe("agreementOf", () => {
  const pairs = [
    ["buyers", "buyers", "agree", "bullish"],
    ["sellers", "sellers", "agree", "bearish"],
    ["buyers", "sellers", "diverge", "neutral"],
    ["sellers", "buyers", "diverge", "neutral"],
    ["buyers", "balanced", "one_sided", "neutral"],
    ["sellers", "balanced", "one_sided", "neutral"],
    ["balanced", "buyers", "one_sided", "neutral"],
    ["balanced", "sellers", "one_sided", "neutral"],
    ["balanced", "balanced", "both_balanced", "neutral"],
    ["no_data", "buyers", "not_comparable", "neutral"],
    ["no_data", "sellers", "not_comparable", "neutral"],
    ["no_data", "balanced", "not_comparable", "neutral"],
    ["no_data", "mixed", "not_comparable", "neutral"],
    ["no_data", "no_data", "not_comparable", "neutral"],
    ["buyers", "no_data", "not_comparable", "neutral"],
    ["sellers", "no_data", "not_comparable", "neutral"],
    ["balanced", "no_data", "not_comparable", "neutral"],
    ["mixed", "no_data", "not_comparable", "neutral"],
    ["buyers", "mixed", "not_comparable", "neutral"],
    ["sellers", "mixed", "not_comparable", "neutral"],
    ["balanced", "mixed", "not_comparable", "neutral"],
    ["mixed", "mixed", "not_comparable", "neutral"],
    ["mixed", "buyers", "not_comparable", "neutral"],
    ["mixed", "sellers", "not_comparable", "neutral"],
    ["mixed", "balanced", "not_comparable", "neutral"],
  ] as const;

  it("the table holds each of the 25 pairs of the five states once", () => {
    const keys = new Set(
      pairs.map(([futures, options]) => `${futures}/${options}`)
    );
    expect(pairs).toHaveLength(25);
    expect(keys.size).toBe(25);
    for (const futures of FLOW_CONTROL_STATES)
      for (const options of FLOW_CONTROL_STATES)
        expect(keys.has(`${futures}/${options}`)).toBe(true);
  });

  it.each(pairs)(
    "futures %s and options %s give %s (%s)",
    (futures, options, state, direction) => {
      expect(agreementOf(futures, options)).toEqual({ direction, state });
    }
  );
});

describe("foldFuturesState", () => {
  /** One covered minute: by default no deep trade, a positive delta and a close above the VWAP. */
  const tape = (
    minute: number,
    overrides: Partial<FlowTapeMinute> = {}
  ): FlowTapeMinute => ({
    close: 101,
    deepBuy: 0,
    deepSell: 0,
    deepTrades: 0,
    delta: 10,
    minute,
    volume: 100,
    vwap: 100,
    ...overrides,
  });
  const tapeRun = (
    start: number,
    end: number,
    overrides: Partial<FlowTapeMinute> = {}
  ): FlowTapeMinute[] =>
    Array.from({ length: end - start }, (_, index) =>
      tape(start + index, overrides)
    );
  /** One deep buy per minute: ratio +1, and every check passes. */
  const buying = { deepBuy: 40, deepTrades: 1 };
  /** One deep sell per minute: ratio -1, and every check passes. */
  const selling = { close: 99, deepSell: 40, deepTrades: 1, delta: -10 };
  /** A window of one minute: each step reads its own minute only. */
  const single: FlowFuturesRules = {
    ...FLOW_FUTURES_RULES,
    maxMissingMinutes: 0,
    minBuckets: 1,
    minTrades: 2,
    windowMinutes: 1,
  };
  const strong = { deepBuy: 40, deepTrades: 2 };
  const fold = (minutes: readonly FlowTapeMinute[]) =>
    foldFuturesState(minutes, single);

  it("the futures rules hold the start values of the plan and pass the contract", () => {
    expect(FLOW_FUTURES_RULES).toEqual({
      enterRatio: 0.3,
      exitRatio: 0.1,
      maxMissingMinutes: 5,
      minBuckets: 10,
      minCoveredSeconds: 55,
      minMinutes: 5,
      minTrades: 10,
      version: "flow-futures-rules.v1",
      windowMinutes: 30,
    });
    expect(Object.isFrozen(FLOW_FUTURES_RULES)).toBe(true);
    expect(FlowFuturesRulesSchema.parse(FLOW_FUTURES_RULES)).toEqual(
      FLOW_FUTURES_RULES
    );
  });

  it("returns no step for an empty input", () => {
    expect(foldFuturesState([], FLOW_FUTURES_RULES)).toEqual([]);
  });

  it("enters after minMinutes in a row and dates the start at the first of them", () => {
    const steps = foldFuturesState(tapeRun(0, 15, buying), FLOW_FUTURES_RULES);
    expect(steps).toHaveLength(15);
    expect(steps[9]).toEqual({
      hold: null,
      minute: 9,
      noDataReason: null,
      ratio: 1,
      sinceMinute: null,
      state: "balanced",
      trades: 10,
    });
    expect(steps[12]?.state).toBe("balanced");
    expect(steps[13]).toEqual({
      hold: null,
      minute: 13,
      noDataReason: null,
      ratio: 1,
      sinceMinute: 9,
      state: "buyers",
      trades: 14,
    });
    expect(steps[14]).toMatchObject({ sinceMinute: 9, state: "buyers" });
  });

  it("sellers mirror buyers", () => {
    const steps = foldFuturesState(tapeRun(0, 15, selling), FLOW_FUTURES_RULES);
    expect(steps[12]).toMatchObject({
      hold: null,
      ratio: -1,
      state: "balanced",
    });
    expect(steps[13]).toMatchObject({
      hold: null,
      ratio: -1,
      sinceMinute: 9,
      state: "sellers",
    });
  });

  it("the ratio is 0 for a window without a deep trade and the state stays balanced", () => {
    const steps = foldFuturesState(tapeRun(0, 20), FLOW_FUTURES_RULES);
    expect(steps[19]).toEqual({
      hold: null,
      minute: 19,
      noDataReason: null,
      ratio: 0,
      sinceMinute: null,
      state: "balanced",
      trades: 0,
    });
  });

  it("the ratio is the net deep volume over the total deep volume of the window", () => {
    const minutes = [
      ...tapeRun(0, 10, { deepBuy: 60, deepSell: 20, deepTrades: 2 }),
      ...tapeRun(10, 12, { deepSell: 100, deepTrades: 1 }),
    ];
    const steps = foldFuturesState(minutes, FLOW_FUTURES_RULES);
    expect(steps[9]?.ratio).toBeCloseTo(0.5, 10);
    expect(steps[11]?.ratio).toBeCloseTo(200 / 1000, 10);
    expect(steps[11]?.trades).toBe(22);
    expect(futuresWindowTotals(minutes, 11, FLOW_FUTURES_RULES)).toEqual({
      denominator: 1000,
      numerator: 200,
      rows: 12,
    });
    expect(futuresWindowTotals(minutes, 40, FLOW_FUTURES_RULES)).toEqual({
      denominator: 100,
      numerator: -100,
      rows: 1,
    });
  });

  it("a state ends only when the ratio falls below the exit ratio", () => {
    const steps = fold([
      ...tapeRun(0, 5, strong),
      tape(5, { deepBuy: 55, deepSell: 45, deepTrades: 2 }),
      tape(6, { deepBuy: 60, deepSell: 40, deepTrades: 2 }),
      tape(7, { deepBuy: 54, deepSell: 46, deepTrades: 2 }),
    ]);
    expect(steps[4]).toMatchObject({ sinceMinute: 0, state: "buyers" });
    expect(steps[5]).toMatchObject({ sinceMinute: 0, state: "buyers" });
    expect(steps[5]?.ratio).toBeCloseTo(0.1, 10);
    expect(steps[6]).toMatchObject({ sinceMinute: 0, state: "buyers" });
    expect(steps[7]).toMatchObject({ sinceMinute: null, state: "balanced" });
    expect(steps[7]?.ratio).toBeCloseTo(0.08, 10);
  });

  it.each([
    ["few_trades", { deepTrades: 1 }],
    ["delta_against", { delta: -10 }],
    ["delta_against", { delta: 0 }],
    ["price_against", { close: 100 }],
    ["price_against", { close: 99 }],
  ] as const)(
    "the hold %s blocks a buyers entry and keeps the ratio (%o)",
    (hold, failing) => {
      const steps = fold(tapeRun(0, 8, { ...strong, ...failing }));
      expect(steps).toHaveLength(8);
      for (const step of steps)
        expect(step).toMatchObject({
          hold,
          ratio: 1,
          sinceMinute: null,
          state: "balanced",
        });
    }
  );

  it.each([
    ["few_trades", { deepTrades: 1 }],
    ["delta_against", { delta: 10 }],
    ["delta_against", { delta: 0 }],
    ["price_against", { close: 100 }],
    ["price_against", { close: 101 }],
  ] as const)("the hold %s blocks a sellers entry (%o)", (hold, failing) => {
    const steps = fold(
      tapeRun(0, 8, { ...selling, deepTrades: 2, ...failing })
    );
    expect(steps).toHaveLength(8);
    for (const step of steps)
      expect(step).toMatchObject({ hold, ratio: -1, state: "balanced" });
  });

  it("a held minute breaks the entry run", () => {
    const steps = fold([
      ...tapeRun(0, 4, strong),
      tape(4, { ...strong, delta: -10 }),
      ...tapeRun(5, 10, strong),
    ]);
    expect(steps[3]).toMatchObject({ hold: null, state: "balanced" });
    expect(steps[4]).toMatchObject({
      hold: "delta_against",
      state: "balanced",
    });
    expect(steps[8]).toMatchObject({ hold: null, state: "balanced" });
    expect(steps[9]).toMatchObject({ sinceMinute: 5, state: "buyers" });
  });

  it("the checks stop at the first failure: few_trades, then delta_against, then price_against", () => {
    const steps = fold([
      tape(0, { ...strong, close: 99, deepTrades: 1, delta: -10 }),
      tape(1, { ...strong, close: 99, delta: -10 }),
      tape(2, { ...strong, close: 99 }),
      tape(3, strong),
    ]);
    expect(steps.map((step) => step.hold)).toEqual([
      "few_trades",
      "delta_against",
      "price_against",
      null,
    ]);
  });

  it("a ratio below the enter ratio has no hold, whatever the checks say", () => {
    const steps = fold([
      tape(0, {
        close: 99,
        deepBuy: 60,
        deepSell: 40,
        deepTrades: 1,
        delta: -10,
      }),
    ]);
    expect(steps[0]).toMatchObject({ hold: null, state: "balanced" });
    expect(steps[0]?.ratio).toBeCloseTo(0.2, 10);
  });

  it("a failed check does not end a state, and a step reports the hold only while it is balanced", () => {
    const steps = fold([
      ...tapeRun(0, 5, strong),
      tape(5, { ...strong, deepTrades: 1 }),
      tape(6, { ...strong, delta: -10 }),
      tape(7, { ...strong, close: 99 }),
      tape(8, { deepTrades: 2 }),
      tape(9, { ...strong, close: 99 }),
    ]);
    for (const minute of [4, 5, 6, 7])
      expect(steps[minute]).toMatchObject({
        hold: null,
        ratio: 1,
        sinceMinute: 0,
        state: "buyers",
      });
    expect(steps[8]).toMatchObject({ hold: null, ratio: 0, state: "balanced" });
    expect(steps[9]).toMatchObject({
      hold: "price_against",
      ratio: 1,
      state: "balanced",
    });
  });

  it("an exit with a ratio at or beyond the negative enter ratio starts a sell run, unless a check fails", () => {
    const sellers = { ...selling, deepTrades: 2 };
    const steps = fold([...tapeRun(0, 5, strong), ...tapeRun(5, 10, sellers)]);
    expect(steps[5]).toMatchObject({ hold: null, state: "balanced" });
    expect(steps[9]).toMatchObject({ sinceMinute: 5, state: "sellers" });
    const held = fold([
      ...tapeRun(0, 5, strong),
      tape(5, { ...sellers, delta: 10 }),
      ...tapeRun(6, 10, sellers),
    ]);
    expect(held[5]).toMatchObject({
      hold: "delta_against",
      ratio: -1,
      sinceMinute: null,
      state: "balanced",
    });
    expect(held[9]).toMatchObject({ state: "balanced" });
  });

  it("the price check reads the close of the newest window row, in any input order", () => {
    const rules: FlowFuturesRules = {
      ...single,
      minBuckets: 3,
      windowMinutes: 3,
    };
    const rising = [
      tape(0, { ...strong, close: 95 }),
      tape(1, { ...strong, close: 95 }),
      tape(2, { ...strong, close: 105 }),
    ];
    const falling = [
      tape(0, { ...strong, close: 105 }),
      tape(1, { ...strong, close: 105 }),
      tape(2, { ...strong, close: 95 }),
    ];
    const reordered = <T>(rows: readonly T[]): T[] => [
      ...rows.slice(2),
      ...rows.slice(0, 2),
    ];
    expect(foldFuturesState(rising, rules)[2]?.hold).toBeNull();
    expect(foldFuturesState(reordered(rising), rules)[2]?.hold).toBeNull();
    expect(foldFuturesState(falling, rules)[2]?.hold).toBe("price_against");
    expect(foldFuturesState(reordered(falling), rules)[2]?.hold).toBe(
      "price_against"
    );
  });

  it("the window VWAP weights each minute by its volume", () => {
    const rules: FlowFuturesRules = {
      ...single,
      minBuckets: 2,
      windowMinutes: 2,
    };
    // Weighted VWAP 101, plain mean 105: a close of 103 is above the first and below the second.
    const steps = foldFuturesState(
      [
        tape(0, { ...strong, volume: 900, vwap: 100 }),
        tape(1, { ...strong, close: 103, volume: 100, vwap: 110 }),
      ],
      rules
    );
    expect(steps[1]?.hold).toBeNull();
  });

  it("a window without volume has no VWAP: the price check fails", () => {
    expect(fold([tape(0, { ...strong, volume: 0 })])[0]?.hold).toBe(
      "price_against"
    );
  });

  it("reports session_start before minBuckets minutes have passed", () => {
    const steps = foldFuturesState(tapeRun(0, 10, buying), FLOW_FUTURES_RULES);
    for (const step of steps.slice(0, 9))
      expect(step).toEqual({
        hold: null,
        minute: step.minute,
        noDataReason: "session_start",
        ratio: null,
        sinceMinute: null,
        state: "no_data",
        trades: step.minute + 1,
      });
    expect(steps[9]?.state).toBe("balanced");
  });

  it("reports gap for fewer covered minutes than minBuckets", () => {
    const minutes = tapeRun(0, 11).filter((entry) => entry.minute !== 3);
    const steps = foldFuturesState(minutes, FLOW_FUTURES_RULES);
    expect(steps[9]).toMatchObject({ noDataReason: "gap", state: "no_data" });
    expect(steps[10]).toMatchObject({ noDataReason: null, state: "balanced" });
  });

  it("reports gap when more than maxMissingMinutes of the window since 09:30 are missing", () => {
    const steps = foldFuturesState(
      [...tapeRun(0, 12), tape(17)],
      FLOW_FUTURES_RULES
    );
    // Minute 16: 12 rows of 17 expected, 5 missing. Minute 17: 13 rows of 18 expected, 5 missing.
    expect(steps[16]).toMatchObject({ noDataReason: null, state: "balanced" });
    expect(steps[17]).toMatchObject({ noDataReason: null, state: "balanced" });
    const wider = foldFuturesState(
      [...tapeRun(0, 12), tape(18)],
      FLOW_FUTURES_RULES
    );
    // Minute 17: 12 rows of 18 expected, 6 missing. Minute 18: 13 rows of 19 expected, 6 missing.
    expect(wider[16]).toMatchObject({ noDataReason: null, state: "balanced" });
    expect(wider[17]).toMatchObject({ noDataReason: "gap", state: "no_data" });
    expect(wider[18]).toMatchObject({ noDataReason: "gap", state: "no_data" });
  });

  it("counts the missing minutes against the window length after the first 30 minutes", () => {
    const steps = foldFuturesState(
      [...tapeRun(0, 40), ...tapeRun(46, 60)],
      FLOW_FUTURES_RULES
    );
    expect(steps[44]).toMatchObject({ noDataReason: null, state: "balanced" });
    expect(steps[45]).toMatchObject({ noDataReason: "gap", state: "no_data" });
    expect(steps[59]).toMatchObject({ noDataReason: "gap", state: "no_data" });
  });

  it("a gap ends a state, and the next state needs a new entry", () => {
    const steps = foldFuturesState(
      [...tapeRun(0, 14, buying), ...tapeRun(20, 50, buying)],
      FLOW_FUTURES_RULES
    );
    expect(steps[13]).toMatchObject({ sinceMinute: 9, state: "buyers" });
    // Minutes 14 to 18: at most 5 minutes are missing, so the state is carried.
    expect(steps[18]).toMatchObject({ sinceMinute: 9, state: "buyers" });
    expect(steps[19]).toEqual({
      hold: null,
      minute: 19,
      noDataReason: "gap",
      ratio: null,
      sinceMinute: null,
      state: "no_data",
      trades: 14,
    });
    // The 6 missing minutes leave the window at minute 44.
    expect(steps[43]).toMatchObject({ noDataReason: "gap", state: "no_data" });
    expect(steps[44]).toMatchObject({
      noDataReason: null,
      ratio: 1,
      sinceMinute: null,
      state: "balanced",
    });
    expect(steps[47]).toMatchObject({ sinceMinute: null, state: "balanced" });
    expect(steps[48]).toMatchObject({ sinceMinute: 44, state: "buyers" });
  });

  it("minutes after the last covered minute count as missing up to `through`: 5 keep the state, the 6th is a gap", () => {
    const covered = tapeRun(0, 14, buying);
    const steps = foldFuturesState(covered, FLOW_FUTURES_RULES, 19);
    expect(steps).toHaveLength(20);
    expect(steps[13]).toMatchObject({ sinceMinute: 9, state: "buyers" });
    for (const minute of [14, 15, 16, 17, 18])
      expect(steps[minute]).toMatchObject({
        noDataReason: null,
        ratio: 1,
        sinceMinute: 9,
        state: "buyers",
        trades: 14,
      });
    expect(steps[19]).toEqual({
      hold: null,
      minute: 19,
      noDataReason: "gap",
      ratio: null,
      sinceMinute: null,
      state: "no_data",
      trades: 14,
    });
    // A later covered run must enter again from balanced.
    const later = foldFuturesState(
      [...covered, ...tapeRun(20, 50, buying)],
      FLOW_FUTURES_RULES,
      49
    );
    expect(later[19]).toEqual(steps[19]);
    expect(later[44]).toMatchObject({ sinceMinute: null, state: "balanced" });
    expect(later[48]).toMatchObject({ sinceMinute: 44, state: "buyers" });
  });

  it("`through` at or below the newest input minute changes nothing", () => {
    const minutes = [...tapeRun(0, 14, buying), ...tapeRun(20, 50, buying)];
    const steps = foldFuturesState(minutes, FLOW_FUTURES_RULES);
    expect(steps).toHaveLength(50);
    for (const through of [-1, 5, 49])
      expect(foldFuturesState(minutes, FLOW_FUTURES_RULES, through)).toEqual(
        steps
      );
  });

  it("an empty input with `through` gives session_start steps, then gap steps", () => {
    const early = foldFuturesState([], FLOW_FUTURES_RULES, 3);
    expect(early).toHaveLength(4);
    for (const step of early)
      expect(step).toEqual({
        hold: null,
        minute: step.minute,
        noDataReason: "session_start",
        ratio: null,
        sinceMinute: null,
        state: "no_data",
        trades: 0,
      });
    const late = foldFuturesState([], FLOW_FUTURES_RULES, 12);
    expect(late).toHaveLength(13);
    expect(late[8]?.noDataReason).toBe("session_start");
    expect(late[9]?.noDataReason).toBe("gap");
    expect(late.at(-1)).toMatchObject({
      minute: 12,
      noDataReason: "gap",
      state: "no_data",
    });
    expect(foldFuturesState([], FLOW_FUTURES_RULES, -1)).toEqual([]);
  });

  it("a minute without a covered row does not count toward an entry: one seen minute plus four unseen minutes is not five in a row", () => {
    // 09:30 to 09:49 are covered and 12 deep buys are all in 09:49; 09:50 to 09:53 are stored without coverage.
    const seen = [
      ...tapeRun(0, 19),
      tape(19, { deepBuy: 480, deepTrades: 12 }),
    ];
    const steps = foldFuturesState(seen, FLOW_FUTURES_RULES, 23);
    expect(steps).toHaveLength(24);
    for (const minute of [19, 20, 21, 22, 23])
      expect(steps[minute]).toEqual({
        hold: null,
        minute,
        noDataReason: null,
        ratio: 1,
        sinceMinute: null,
        state: "balanced",
        trades: 12,
      });
    // The run starts again and needs 5 covered minutes in a row.
    const later = foldFuturesState(
      [...seen, ...tapeRun(24, 29)],
      FLOW_FUTURES_RULES,
      28
    );
    expect(later[27]).toMatchObject({ ratio: 1, state: "balanced" });
    expect(later[28]).toMatchObject({
      ratio: 1,
      sinceMinute: 24,
      state: "buyers",
    });
  });

  it("one uncovered minute in a covered run breaks it: the entry needs 5 covered minutes in a row after it", () => {
    for (const [side, state, ratio] of [
      [buying, "buyers", 1],
      [selling, "sellers", -1],
    ] as const) {
      const steps = foldFuturesState(
        [...tapeRun(0, 12, side), ...tapeRun(13, 19, side)],
        FLOW_FUTURES_RULES
      );
      // Minutes 9, 10 and 11 count; minute 12 has no tape.
      for (const minute of [11, 12, 13, 16])
        expect(steps[minute]).toMatchObject({
          hold: null,
          noDataReason: null,
          ratio,
          sinceMinute: null,
          state: "balanced",
        });
      expect(steps[17]).toMatchObject({ sinceMinute: 13, state });
      expect(steps[18]).toMatchObject({ sinceMinute: 13, state });
    }
  });

  it("a running state is carried through minutes without tape until the gap rule ends it", () => {
    const steps = foldFuturesState(
      [...tapeRun(0, 14, buying), ...tapeRun(15, 17, buying)],
      FLOW_FUTURES_RULES,
      19
    );
    for (const minute of [13, 14, 15, 16, 17, 18, 19])
      expect(steps[minute]).toMatchObject({ sinceMinute: 9, state: "buyers" });
  });
});
