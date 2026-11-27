import { describe, expect, it } from "vitest";
import {
  FLOW_AGREEMENT_STATES,
  FLOW_CAPTURE_MODES,
  FLOW_FUTURES_HOLDS,
  FLOW_NO_DATA_REASONS,
  FLOW_PARTS_STATUSES,
  FlowCollectInputSchema,
  FlowCollectOutputSchema,
  FlowControlFuturesSideSchema,
  FlowControlInputSchema,
  FlowControlSchema,
  FlowFreshnessSchema,
  FlowFuturesRulesSchema,
  flowContract,
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
  it("accepts six option-print symbols in flow.collect and rejects seven", () => {
    expect(
      FlowCollectInputSchema.safeParse({
        symbols: ["SPY", "ES", "QQQ", "NQ", "IWM", "NVDA"],
      }).success
    ).toBe(true);
    expect(
      FlowCollectInputSchema.safeParse({
        symbols: ["SPY", "ES", "QQQ", "NQ", "IWM", "NVDA", "SPY"],
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
});

const line = { netCallPremiumUsd: 1, netPutPremiumUsd: 2 };
const totals = {
  callMinusPutUsd: -1,
  netCallPremiumUsd: 1,
  netCallVolume: 3,
  netPutPremiumUsd: 2,
  netPutVolume: 4,
};
const side = {
  asOf: "2026-11-09T15:00:00.000Z",
  detail: "Ratio 0.42 over the last 30 min; enter ratio 0.30",
  direction: "bullish",
  enterRatio: 0.3,
  inputs: { denominator: 10, numerator: 4.2, rows: 30 },
  instrument: "SPX",
  label: "SPX options: bullish, call buying leads",
  noDataReason: null,
  ratio: 0.42,
  since: "2026-11-09T14:45:00.000Z",
  state: "buyers",
  windowEnd: "2026-11-09T15:00:00.000Z",
  windowStart: "2026-11-09T14:30:00.000Z",
};
const DOCUMENT = {
  agreement: {
    detail: "x",
    direction: "neutral",
    label: "Cannot compare",
    since: null,
    state: "not_comparable",
  },
  crossCheck: {
    detail: "x",
    oldestUnreadAt: null,
    result: "same_direction",
    storedPrints: 25,
    ticker: "SPX",
    unreadRanges: 0,
  },
  deepTrades: {
    absorptions: [{ at: "t", detail: "d", direction: "bullish", price: 1 }],
    audit: { checks: 1, comparedSeconds: 18, matchedSeconds: 17 },
    capture: "streamed",
    coverage: { seenSeconds: 10, share: 0.5, windowSeconds: 20 },
    limitSize: 50,
    minutes: [{ buyVolume: 1, coveredSeconds: 60, minute: "t", sellVolume: 2 }],
    signing: "quote",
    sums: { buyVolume: 1, cumulativeFrom: "t", netVolume: -1, sellVolume: 2 },
    symbol: "ES",
    totalTrades: 1,
    trades: [{ at: "t", price: 1, side: "buy", signing: "tick", size: 2 }],
  },
  freshness: [
    {
      ageSeconds: 5,
      instrument: "SPX",
      lastOkAt: "t",
      message: null,
      source: "net_drift",
      state: "fresh",
    },
    {
      ageSeconds: 40,
      instrument: "ES",
      lastOkAt: "t",
      message: "streamed tape ESZ6: 900 prints in 1 complete minutes",
      source: "ticks",
      state: "fresh",
    },
  ],
  futures: {
    ...side,
    detail:
      "Deep-trade ratio 0.42 over the last 30 min from 14 deep trades; enter ratio 0.30; not counted: the delta of all trades points the other way",
    direction: "neutral",
    hold: "delta_against",
    instrument: "ES",
    label: "ES futures: balanced",
    since: null,
    state: "balanced",
    trades: 14,
  },
  futuresRules: {
    enterRatio: 0.3,
    exitRatio: 0.1,
    maxMissingMinutes: 5,
    minBuckets: 10,
    minCoveredSeconds: 55,
    minMinutes: 5,
    minTrades: 10,
    version: "flow-futures-rules.v1",
    windowMinutes: 30,
  },
  generatedAt: "2026-11-09T15:00:00.000Z",
  group: "sp500",
  levels: null,
  netDrift: [
    {
      asOf: "t",
      filterProfile: "otm-clean.v1",
      partsDetail: null,
      partsStatus: "complete",
      points: [
        {
          longer: line,
          minute: "t",
          total: line,
          underlyingPrice: 6000,
          zeroDte: line,
        },
      ],
      role: "primary",
      slopeUsdPerMinute: 1,
      slopeWindowMinutes: 15,
      ticker: "SPX",
      totals: {
        cumulativeFrom: "t",
        longer: totals,
        total: totals,
        zeroDte: totals,
      },
    },
  ],
  notes: ["Research only."],
  options: {
    ...side,
    checkState: "balanced",
    checkTicker: "SPY",
    primaryTicker: "SPX",
  },
  rules: {
    enterRatio: 0.3,
    exitRatio: 0.1,
    minBuckets: 10,
    minMinutes: 5,
    version: "flow-control-rules.v1",
    windowMinutes: 30,
  },
  schemaVersion: "flow-control.v1",
  session: {
    date: "2026-11-09",
    event: null,
    futuresOpen: true,
    open: true,
    optionsOpen: true,
  },
  study: {
    agreementDetail: "a",
    detail: "d",
    rulesVersion: null,
    status: "not_tested",
    strategyId: "flow-control-continuation",
    testedOn: null,
  },
};

const ok = (document: unknown) => FlowControlSchema.safeParse(document).success;

describe("flow-control.v1", () => {
  it("accepts a full flow-control.v1 document", () => {
    expect(FlowControlSchema.parse(DOCUMENT)).toEqual(DOCUMENT);
  });

  it("accepts null and a filled value for session.event and levels", () => {
    expect(
      ok({
        ...DOCUMENT,
        levels: {
          previousClose: 1,
          sessionHigh: 2,
          sessionLow: 0.5,
          sessionOpen: 1.5,
          source: "one_minute_closes",
          ticker: "SPX",
        },
        session: { ...DOCUMENT.session, event: "fomc" },
      })
    ).toBe(true);
  });

  it("rejects an extra key at every level", () => {
    expect(ok({ ...DOCUMENT, extra: 1 })).toBe(false);
    expect(
      ok({ ...DOCUMENT, options: { ...DOCUMENT.options, extra: 1 } })
    ).toBe(false);
    expect(
      ok({ ...DOCUMENT, futures: { ...DOCUMENT.futures, extra: 1 } })
    ).toBe(false);
    expect(
      ok({ ...DOCUMENT, futuresRules: { ...DOCUMENT.futuresRules, extra: 1 } })
    ).toBe(false);
    expect(
      ok({ ...DOCUMENT, agreement: { ...DOCUMENT.agreement, extra: 1 } })
    ).toBe(false);
    expect(
      ok({
        ...DOCUMENT,
        futures: { ...DOCUMENT.futures, inputs: { ...side.inputs, extra: 1 } },
      })
    ).toBe(false);
    expect(
      ok({
        ...DOCUMENT,
        deepTrades: {
          ...DOCUMENT.deepTrades,
          coverage: { ...DOCUMENT.deepTrades.coverage, extra: 1 },
        },
      })
    ).toBe(false);
  });

  it("rejects more than 420 points, 60 trades, 420 minutes, 20 absorptions", () => {
    const [series] = DOCUMENT.netDrift;
    const many = <T>(item: T, count: number) => new Array<T>(count).fill(item);
    expect(
      ok({
        ...DOCUMENT,
        netDrift: [{ ...series, points: many(series?.points[0], 421) }],
      })
    ).toBe(false);
    for (const [key, count] of [
      ["trades", 61],
      ["minutes", 421],
      ["absorptions", 21],
    ] as const)
      expect(
        ok({
          ...DOCUMENT,
          deepTrades: {
            ...DOCUMENT.deepTrades,
            [key]: many(DOCUMENT.deepTrades[key][0], count),
          },
        })
      ).toBe(false);
  });

  it("rejects a ratio outside -1 to 1", () => {
    expect(
      ok({ ...DOCUMENT, options: { ...DOCUMENT.options, ratio: 1.01 } })
    ).toBe(false);
    expect(
      ok({ ...DOCUMENT, options: { ...DOCUMENT.options, ratio: -1.01 } })
    ).toBe(false);
  });

  it("accepts sp500 and nasdaq100 and rejects another group", () => {
    expect(FlowControlInputSchema.safeParse({ group: "sp500" }).success).toBe(
      true
    );
    expect(
      FlowControlInputSchema.safeParse({ group: "nasdaq100" }).success
    ).toBe(true);
    expect(FlowControlInputSchema.safeParse({ group: "dow" }).success).toBe(
      false
    );
  });

  it("allows sampled and streamed as the capture mode", () => {
    expect(FLOW_CAPTURE_MODES).toEqual(["sampled", "streamed"]);
    for (const capture of FLOW_CAPTURE_MODES)
      expect(
        ok({ ...DOCUMENT, deepTrades: { ...DOCUMENT.deepTrades, capture } })
      ).toBe(true);
    expect(
      ok({
        ...DOCUMENT,
        deepTrades: { ...DOCUMENT.deepTrades, capture: "streaming" },
      })
    ).toBe(false);
  });

  it("holds the seven no-data reasons in priority order, without sampled_tape and partial", () => {
    expect(FLOW_NO_DATA_REASONS).toEqual([
      "market_closed",
      "source_unavailable",
      "storage_failed",
      "stale",
      "gap",
      "session_start",
      "not_collected",
    ]);
    const noData = (noDataReason: string) =>
      ok({
        ...DOCUMENT,
        futures: {
          ...DOCUMENT.futures,
          hold: null,
          noDataReason,
          ratio: null,
          state: "no_data",
        },
      });
    for (const reason of FLOW_NO_DATA_REASONS)
      expect(noData(reason)).toBe(true);
    expect(noData("sampled_tape")).toBe(false);
    expect(noData("partial")).toBe(false);
  });

  it("allows the five agreement states and no other", () => {
    expect(FLOW_AGREEMENT_STATES).toEqual([
      "not_comparable",
      "agree",
      "diverge",
      "one_sided",
      "both_balanced",
    ]);
    const agreement = (state: string) =>
      ok({ ...DOCUMENT, agreement: { ...DOCUMENT.agreement, state } });
    for (const state of FLOW_AGREEMENT_STATES)
      expect(agreement(state)).toBe(true);
    expect(agreement("agrees")).toBe(false);
    expect(
      ok({
        ...DOCUMENT,
        agreement: {
          ...DOCUMENT.agreement,
          direction: "bullish",
          since: "2026-11-09T14:45:00.000Z",
          state: "agree",
        },
      })
    ).toBe(true);
  });

  it("the futures side needs hold and trades; the options side does not take them", () => {
    const futures = (overrides: Record<string, unknown>) =>
      FlowControlFuturesSideSchema.safeParse({
        ...DOCUMENT.futures,
        ...overrides,
      }).success;
    expect(FLOW_FUTURES_HOLDS).toEqual([
      "few_trades",
      "delta_against",
      "price_against",
    ]);
    for (const hold of [...FLOW_FUTURES_HOLDS, null])
      expect(futures({ hold })).toBe(true);
    expect(futures({ hold: "absorption" })).toBe(false);
    expect(futures({ trades: 0 })).toBe(true);
    expect(futures({ trades: -1 })).toBe(false);
    expect(futures({ trades: 1.5 })).toBe(false);
    const { hold: _hold, ...withoutHold } = DOCUMENT.futures;
    const { trades: _trades, ...withoutTrades } = DOCUMENT.futures;
    expect(ok({ ...DOCUMENT, futures: withoutHold })).toBe(false);
    expect(ok({ ...DOCUMENT, futures: withoutTrades })).toBe(false);
    expect(
      ok({ ...DOCUMENT, options: { ...DOCUMENT.options, hold: null } })
    ).toBe(false);
    expect(
      ok({ ...DOCUMENT, options: { ...DOCUMENT.options, trades: 3 } })
    ).toBe(false);
  });

  it("futuresRules: the version literal and the bounds of the three tape numbers", () => {
    const rules = (overrides: Record<string, unknown>) =>
      FlowFuturesRulesSchema.safeParse({
        ...DOCUMENT.futuresRules,
        ...overrides,
      }).success;
    expect(rules({})).toBe(true);
    expect(rules({ version: "flow-control-rules.v1" })).toBe(false);
    expect(rules({ extra: 1 })).toBe(false);
    for (const [key, low, high] of [
      ["maxMissingMinutes", 0, 30],
      ["minCoveredSeconds", 1, 60],
      ["minTrades", 1, 1000],
    ] as const) {
      expect(rules({ [key]: low })).toBe(true);
      expect(rules({ [key]: high })).toBe(true);
      expect(rules({ [key]: low - 1 })).toBe(false);
      expect(rules({ [key]: high + 1 })).toBe(false);
      expect(rules({ [key]: low + 0.5 })).toBe(false);
      const { [key]: _removed, ...rest } = DOCUMENT.futuresRules;
      expect(FlowFuturesRulesSchema.safeParse(rest).success).toBe(false);
    }
    // The options numbers keep their bounds in the futures rules.
    expect(rules({ enterRatio: 1.1 })).toBe(false);
    expect(rules({ windowMinutes: 0 })).toBe(false);
    const { futuresRules: _rules, ...withoutRules } = DOCUMENT;
    expect(ok(withoutRules)).toBe(false);
    expect(
      ok({
        ...DOCUMENT,
        futuresRules: { ...DOCUMENT.futuresRules, version: "v2" },
      })
    ).toBe(false);
  });

  it("accepts complete, partial and no_data as the parts status", () => {
    expect(FLOW_PARTS_STATUSES).toEqual(["complete", "partial", "no_data"]);
    const [series] = DOCUMENT.netDrift;
    for (const partsStatus of FLOW_PARTS_STATUSES)
      expect(ok({ ...DOCUMENT, netDrift: [{ ...series, partsStatus }] })).toBe(
        true
      );
  });

  it("exposes flow.control as GET /flow/control", () => {
    const route = (
      flowContract.control as unknown as {
        "~orpc": {
          route: { method: string; path: string; operationId: string };
        };
      }
    )["~orpc"].route;
    expect(route).toMatchObject({
      method: "GET",
      operationId: "flow.control",
      path: "/flow/control",
    });
  });
});
