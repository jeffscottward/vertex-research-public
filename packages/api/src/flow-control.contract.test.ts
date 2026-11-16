import { describe, expect, it } from "vitest";
import {
  FLOW_AGREEMENT_STATES,
  FLOW_NO_DATA_REASONS,
  FLOW_PARTS_STATUSES,
  FlowCollectInputSchema,
  FlowCollectOutputSchema,
  FlowControlInputSchema,
  FlowControlSchema,
  FlowFreshnessSchema,
  FlowSnapshotToolInputSchema,
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
    capture: "sampled",
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
  ],
  futures: {
    ...side,
    instrument: "ES",
    noDataReason: "not_collected",
    ratio: null,
    state: "no_data",
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

  it("allows only sampled as the capture mode", () => {
    expect(
      ok({
        ...DOCUMENT,
        deepTrades: { ...DOCUMENT.deepTrades, capture: "streaming" },
      })
    ).toBe(false);
  });

  it("holds the seven no-data reasons in priority order and no partial", () => {
    expect(FLOW_NO_DATA_REASONS).toEqual([
      "market_closed",
      "source_unavailable",
      "stale",
      "gap",
      "session_start",
      "sampled_tape",
      "not_collected",
    ]);
  });

  it("allows only not_comparable as the agreement state", () => {
    expect(FLOW_AGREEMENT_STATES).toEqual(["not_comparable"]);
    expect(
      ok({ ...DOCUMENT, agreement: { ...DOCUMENT.agreement, state: "agree" } })
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
