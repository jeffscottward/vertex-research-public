import { describe, expect, it } from "vitest";

import { FlowControlSchema, type FlowOptionTicker } from "../contracts/flow.ts";
import type { FlowNetDriftRow } from "../flow-net-drift.ts";
import type { FlowOptionPrintRow } from "../flow-options.ts";
import {
  buildFlowControl,
  etClock,
  type FlowControlRows,
  optionsSessionRange,
} from "./flow-control.ts";
import type { FlowSampleRow } from "./flow-snapshot.ts";

// Monday 2026-11-09; New York is UTC−5. 09:30 New York = 14:30Z.
const DATE = "2026-11-09";
const FROM = new Date("2026-11-09T14:30:00.000Z");
const at = (minute: number) => new Date(FROM.getTime() + minute * 60_000);
const NOW = at(21);

const bucket = (
  ticker: FlowOptionTicker,
  minute: number,
  netCallPremium: number,
  netPutPremium: number,
  overrides: Partial<FlowNetDriftRow> = {}
): FlowNetDriftRow => ({
  filterProfile: "otm-clean.v1",
  minute: at(minute),
  netCallPremium,
  netCallVolume: 10,
  netPutPremium,
  netPutVolume: 4,
  part: "total",
  ticker,
  underlyingPrice: 6000,
  ...overrides,
});

const run = (
  ticker: FlowOptionTicker,
  start: number,
  end: number,
  call: number,
  put: number,
  overrides: Partial<FlowNetDriftRow> = {}
) =>
  Array.from({ length: end - start }, (_, index) =>
    bucket(ticker, start + index, call, put, overrides)
  );

const sample = (
  symbol: FlowSampleRow["symbol"],
  when: Date,
  status: FlowSampleRow["status"] = "ok",
  message: string | null = null
): FlowSampleRow => ({
  at: when,
  items: 2,
  message,
  source: "net_drift",
  status,
  symbol,
});

const freshSamples = (now: Date = NOW) => ({
  ES: { latest: [sample("ES", now)], latestOk: [sample("ES", now)] },
  SPY: { latest: [sample("SPY", now)], latestOk: [sample("SPY", now)] },
});

/** Prints read for the 40 minutes before now, as flow.control reads them while the session is open. */
const readFor = (
  prints: readonly FlowOptionPrintRow[]
): FlowControlRows["crossPrints"] => ({ from: at(-19), prints, to: NOW });

const rowsOf = (overrides: Partial<FlowControlRows> = {}): FlowControlRows => ({
  crossGaps: [],
  crossPrints: readFor([]),
  group: "sp500",
  netDrift: [
    ...run("SPX", 0, 21, 1000, 0),
    ...run("SPY", 0, 21, 500, 500),
    ...run("SPX", 0, 21, 100, 0, { part: "zero_dte" }),
  ],
  now: NOW,
  samples: freshSamples(),
  sessionDate: DATE,
  study: { rulesVersion: null, status: "not_tested", testedOn: null },
  ...overrides,
});

const print = (
  minute: number,
  side: FlowOptionPrintRow["side"],
  right: FlowOptionPrintRow["right"],
  ticker: FlowOptionTicker = "SPX"
) =>
  ({
    premium: 1000,
    right,
    side,
    ticker,
    tradedAt: at(minute),
  }) as FlowOptionPrintRow;

describe("buildFlowControl", () => {
  it("builds a document that the contract schema accepts for both groups", () => {
    const sp = buildFlowControl(rowsOf());
    expect(FlowControlSchema.parse(sp)).toEqual(sp);
    expect(sp.options).toMatchObject({
      checkState: "balanced",
      checkTicker: "SPY",
      direction: "bullish",
      instrument: "SPX",
      label: "SPX options: bullish, call buying leads",
      primaryTicker: "SPX",
      state: "buyers",
    });
    const nq = buildFlowControl(
      rowsOf({
        crossGaps: null,
        crossPrints: null,
        group: "nasdaq100",
        netDrift: run("QQQ", 0, 21, 0, 1000),
        samples: {},
      })
    );
    expect(FlowControlSchema.parse(nq)).toEqual(nq);
    expect(nq.options.instrument).toBe("QQQ");
    expect(optionsSessionRange(DATE)).toEqual({
      from: FROM,
      to: new Date("2026-11-09T21:15:00.000Z"),
    });
    expect(etClock(FROM)).toBe("09:30 ET");
  });

  it("leaves out the newest total bucket while the net drift session is open and keeps it after 16:20", () => {
    const open = buildFlowControl(rowsOf());
    expect(open.netDrift[0]?.points).toHaveLength(20);
    expect(open.options.asOf).toBe(at(20).toISOString());
    const after = buildFlowControl(
      rowsOf({ now: new Date("2026-11-09T21:21:00.000Z") })
    );
    expect(after.netDrift[0]?.points).toHaveLength(21);
  });

  it("ignores rows of another filter profile and outside the session", () => {
    const control = buildFlowControl(
      rowsOf({
        netDrift: [
          ...rowsOf().netDrift,
          bucket("SPX", 5, 9_999_999, 0, { filterProfile: "other" }),
          bucket("SPX", -1, 9_999_999, 0),
        ],
      })
    );
    expect(control.netDrift[0]?.points).toHaveLength(20);
    expect(control.netDrift[0]?.totals.total?.netCallPremiumUsd).toBe(20_000);
  });

  it("starts the cumulative lines at 09:30 New York and derives longer as total minus zero_dte", () => {
    const [series] = buildFlowControl(rowsOf()).netDrift;
    expect(series?.totals.cumulativeFrom).toBe(FROM.toISOString());
    expect(series?.partsStatus).toBe("complete");
    expect(series?.points[1]).toEqual({
      longer: { netCallPremiumUsd: 1800, netPutPremiumUsd: 0 },
      minute: at(1).toISOString(),
      total: { netCallPremiumUsd: 2000, netPutPremiumUsd: 0 },
      underlyingPrice: 6000,
      zeroDte: { netCallPremiumUsd: 200, netPutPremiumUsd: 0 },
    });
    expect(series?.totals).toMatchObject({
      longer: { callMinusPutUsd: 18_000, netCallVolume: 0 },
      total: {
        callMinusPutUsd: 20_000,
        netCallPremiumUsd: 20_000,
        netCallVolume: 200,
        netPutPremiumUsd: 0,
        netPutVolume: 80,
      },
      zeroDte: { netCallPremiumUsd: 2000 },
    });
  });

  it("sets partsStatus partial for the expiry split only and keeps the state", () => {
    const missing = buildFlowControl(
      rowsOf({
        netDrift: [...run("SPX", 0, 21, 1000, 0), ...run("SPY", 0, 21, 0, 0)],
      })
    );
    expect(missing.netDrift[0]).toMatchObject({
      partsDetail:
        "The same-day (0DTE) part of SPX net drift is missing; the totals are complete",
      partsStatus: "partial",
      totals: { longer: null, zeroDte: null },
    });
    expect(missing.netDrift[0]?.points[0]?.zeroDte).toBeNull();
    expect(missing.options.state).toBe("buyers");
    const lagging = buildFlowControl(
      rowsOf({
        netDrift: [
          ...run("SPX", 0, 21, 1000, 0),
          ...run("SPX", 0, 10, 100, 0, { part: "zero_dte" }),
        ],
      })
    );
    expect(lagging.netDrift[0]?.partsStatus).toBe("partial");
  });

  it("sets zeroDte and longer to null after the newest zero_dte bucket and takes the part totals there", () => {
    const [series] = buildFlowControl(
      rowsOf({
        netDrift: [
          ...run("SPX", 0, 21, 1000, 0),
          ...run("SPX", 0, 17, 100, 0, { part: "zero_dte" }),
        ],
      })
    ).netDrift;
    expect(series?.partsStatus).toBe("complete");
    expect(series?.points[16]?.zeroDte).toEqual({
      netCallPremiumUsd: 1700,
      netPutPremiumUsd: 0,
    });
    expect(series?.points[17]).toMatchObject({ longer: null, zeroDte: null });
    expect(series?.totals).toMatchObject({
      longer: { netCallPremiumUsd: 17_000 - 1700 },
      total: { netCallPremiumUsd: 20_000 },
      zeroDte: { netCallPremiumUsd: 1700 },
    });
    const [late] = buildFlowControl(
      rowsOf({
        netDrift: [
          ...run("SPX", 10, 21, 1000, 0),
          ...run("SPX", 0, 2, 100, 0, { part: "zero_dte" }),
          ...run("SPX", 16, 17, 100, 0, { part: "zero_dte" }),
        ],
      })
    ).netDrift;
    expect(late?.totals.zeroDte?.netCallPremiumUsd).toBe(300);
  });

  it("sets partsStatus no_data without a settled total bucket", () => {
    const control = buildFlowControl(
      rowsOf({ netDrift: [bucket("SPX", 20, 1, 0)], now: at(21) })
    );
    expect(control.netDrift[0]).toMatchObject({
      asOf: null,
      partsDetail: null,
      partsStatus: "no_data",
      points: [],
      slopeUsdPerMinute: null,
      totals: { longer: null, total: null, zeroDte: null },
    });
  });

  it("uses the primary ticker for the group and marks opposite control of the check ticker as mixed", () => {
    const control = buildFlowControl(
      rowsOf({
        netDrift: [
          ...run("SPX", 0, 21, 1000, 0),
          ...run("SPY", 0, 21, 0, 1000),
        ],
      })
    );
    expect(control.options).toMatchObject({
      checkState: "sellers",
      direction: "neutral",
      label: "Options mixed: SPX bullish, SPY bearish",
      since: null,
      state: "mixed",
    });
  });

  it("gives no_data with each reason in the stated order", () => {
    const saturday = new Date("2026-11-07T16:00:00.000Z");
    expect(
      buildFlowControl(rowsOf({ now: saturday, sessionDate: "2026-11-06" }))
        .options.noDataReason
    ).toBe("market_closed");
    const failing = buildFlowControl(
      rowsOf({
        samples: {
          ES: {
            latest: [sample("ES", NOW, "unavailable", "HTTP 500")],
            latestOk: [sample("ES", at(5))],
          },
        },
      })
    );
    expect(failing.options).toMatchObject({
      detail: "HTTP 500",
      noDataReason: "source_unavailable",
      ratio: null,
    });
    const recovered = buildFlowControl(
      rowsOf({
        samples: {
          ES: {
            latest: [sample("ES", NOW, "unavailable")],
            latestOk: [sample("ES", at(19))],
          },
        },
      })
    );
    expect(recovered.options.state).toBe("buyers");
    expect(buildFlowControl(rowsOf({ now: at(30) })).options.noDataReason).toBe(
      "stale"
    );
    expect(
      buildFlowControl(rowsOf({ netDrift: [], now: at(2) })).options
    ).toMatchObject({
      detail: "2 of 10 minutes needed since 09:30 ET",
      noDataReason: "session_start",
    });
    expect(
      buildFlowControl(rowsOf({ netDrift: [], now: at(8) })).options.detail
    ).toBe("No SPX bucket since 09:30 ET; stale after 5 min");
    const gap = buildFlowControl(
      rowsOf({
        netDrift: [...run("SPX", 0, 12, 1000, 0), ...run("SPX", 40, 43, 1, 0)],
        now: at(43),
      })
    );
    expect(gap.options).toMatchObject({
      detail: "2 of 10 buckets needed in the last 30 min for SPX",
      noDataReason: "gap",
    });
    const early = buildFlowControl(
      rowsOf({ netDrift: run("SPX", 0, 5, 1000, 0), now: at(5) })
    );
    expect(early.options).toMatchObject({
      detail: "5 of 10 minutes needed since 09:30 ET",
      noDataReason: "session_start",
    });
    const early30s = buildFlowControl(
      rowsOf({
        netDrift: run("SPX", 0, 5, 1000, 0),
        now: new Date(at(5).getTime() + 30_000),
      })
    );
    expect(early30s.options.detail).toBe(
      "5 of 10 minutes needed since 09:30 ET"
    );
    const storage = buildFlowControl(
      rowsOf({
        samples: {
          ES: {
            latest: [
              sample("ES", NOW, "unavailable", "storage: write failed (Error)"),
            ],
            latestOk: [sample("ES", at(5))],
          },
        },
      })
    );
    expect(storage.options).toMatchObject({
      detail:
        "The last SPX net drift answer was not stored (storage: write failed (Error)); the next run retries",
      label: "Net drift was not stored",
      noDataReason: "storage_failed",
    });
    const silent = buildFlowControl(
      rowsOf({
        samples: {
          ES: { latest: [sample("ES", NOW, "unavailable")], latestOk: [] },
        },
      })
    );
    expect(silent.options).toMatchObject({
      detail: "the last request failed",
      noDataReason: "source_unavailable",
    });
  });

  it("names the state at the last close, and says that no session is stored when there is none", () => {
    const closed = buildFlowControl(
      rowsOf({ now: new Date("2026-11-09T21:21:00.000Z") })
    );
    expect(closed.options).toMatchObject({
      detail:
        "Last session ended 16:15 ET on 2026-11-09; at the close the SPX options side was bullish",
      label: "Market closed",
      noDataReason: "market_closed",
    });
    const empty = buildFlowControl(
      rowsOf({ netDrift: [], now: new Date("2026-11-09T21:21:00.000Z") })
    );
    expect(empty.options.detail).toBe("No net drift session is stored yet");
  });

  it("fills since, asOf, the window and the inputs from the last step", () => {
    expect(buildFlowControl(rowsOf()).options).toMatchObject({
      asOf: at(20).toISOString(),
      enterRatio: 0.3,
      inputs: { denominator: 20_000, numerator: 20_000, rows: 20 },
      ratio: 1,
      since: at(9).toISOString(),
      windowEnd: at(20).toISOString(),
      windowStart: at(-10).toISOString(),
    });
  });

  it("computes the slope over 15 minutes and null without an earlier point", () => {
    const [series] = buildFlowControl(rowsOf()).netDrift;
    expect(series?.slopeUsdPerMinute).toBe(1000);
    expect(series?.slopeWindowMinutes).toBe(15);
    const short = buildFlowControl(
      rowsOf({ netDrift: run("SPX", 0, 11, 1000, 0), now: at(11) })
    );
    expect(short.netDrift[0]?.slopeUsdPerMinute).toBeNull();
  });

  it("returns the futures side as no_data not_collected and an empty deep trades block", () => {
    const control = buildFlowControl(rowsOf());
    expect(control.futures).toMatchObject({
      detail: "ES deep trades are not collected yet",
      instrument: "ES",
      label: "Futures: deep trades not collected yet",
      noDataReason: "not_collected",
      state: "no_data",
    });
    expect(control.deepTrades).toMatchObject({
      capture: "sampled",
      coverage: { seenSeconds: 0, share: null, windowSeconds: 1800 },
      symbol: "ES",
      totalTrades: 0,
      trades: [],
    });
  });

  it("agreement is not_comparable with the futures cause", () => {
    expect(buildFlowControl(rowsOf()).agreement).toEqual({
      detail:
        "Futures: deep trades not collected yet: ES deep trades are not collected yet",
      direction: "neutral",
      label: "Cannot compare",
      since: null,
      state: "not_comparable",
    });
  });

  it("cross-check: same direction, opposite direction, too few prints, no window, counts unread ranges and the oldest one", () => {
    const calls = Array.from({ length: 20 }, (_, index) =>
      print(index % 20, index % 2 === 0 ? "ask" : "above_ask", "call")
    );
    const same = buildFlowControl(
      rowsOf({
        crossGaps: [
          { endTime: at(5), startTime: at(2) },
          { endTime: at(3), startTime: at(1) },
          { endTime: at(6), startTime: at(4) },
          { endTime: at(40), startTime: at(30) },
        ],
        crossPrints: readFor([
          ...calls,
          print(3, "mid", "call"),
          print(3, "ask", "call", "SPY"),
          print(25, "ask", "call"),
        ]),
      })
    );
    expect(same.crossCheck).toMatchObject({
      oldestUnreadAt: at(1).toISOString(),
      result: "same_direction",
      storedPrints: 21,
      ticker: "SPX",
      unreadRanges: 3,
    });
    const opposite = buildFlowControl(
      rowsOf({
        crossPrints: readFor(
          Array.from({ length: 20 }, (_, index) =>
            print(index, index % 2 === 0 ? "bid" : "below_bid", "call")
          )
        ),
      })
    );
    expect(opposite.crossCheck.result).toBe("opposite_direction");
    const puts = buildFlowControl(
      rowsOf({
        crossPrints: readFor(
          Array.from({ length: 20 }, (_, index) => print(index, "bid", "put"))
        ),
      })
    );
    expect(puts.crossCheck.result).toBe("same_direction");
    const few = buildFlowControl(rowsOf({ crossGaps: null }));
    expect(few.crossCheck).toMatchObject({
      detail:
        "Too few stored SPX option prints to compare, or one figure is zero (0 prints, 20 needed)",
      oldestUnreadAt: null,
      result: "not_comparable",
    });
    for (const range of [
      { from: at(-5), to: NOW },
      { from: at(-19), to: at(19) },
    ]) {
      const outside = buildFlowControl(
        rowsOf({ crossPrints: { ...range, prints: calls } })
      );
      expect(outside.crossCheck).toMatchObject({
        result: "not_comparable",
        storedPrints: 0,
        unreadRanges: 0,
      });
    }
    const noWindow = buildFlowControl(rowsOf({ netDrift: [], now: at(2) }));
    expect(noWindow.crossCheck).toMatchObject({
      result: "not_comparable",
      storedPrints: 0,
      unreadRanges: 0,
    });
  });

  it("nasdaq100 cross-check is not_collected", () => {
    const control = buildFlowControl(
      rowsOf({ crossGaps: null, crossPrints: null, group: "nasdaq100" })
    );
    expect(control.crossCheck).toEqual({
      detail: "Option prints are not collected for QQQ",
      oldestUnreadAt: null,
      result: "not_collected",
      storedPrints: 0,
      ticker: "QQQ",
      unreadRanges: 0,
    });
  });

  it("lists net drift freshness per ticker as never, closed, stale and fresh", () => {
    const fresh = buildFlowControl(rowsOf());
    expect(fresh.freshness).toEqual([
      {
        ageSeconds: 0,
        instrument: "SPX",
        lastOkAt: NOW.toISOString(),
        message: null,
        source: "net_drift",
        state: "fresh",
      },
      expect.objectContaining({ instrument: "SPY", state: "fresh" }),
    ]);
    const stale = buildFlowControl(
      rowsOf({
        samples: {
          ES: {
            latest: [sample("ES", at(10), "empty", "SPX total 0 buckets")],
            latestOk: [sample("ES", at(10))],
          },
        },
      })
    );
    expect(stale.freshness.map((row) => row.state)).toEqual(["stale", "never"]);
    expect(stale.freshness[0]?.message).toBe("SPX total 0 buckets");
    const closed = buildFlowControl(
      rowsOf({ now: new Date("2026-11-09T21:21:00.000Z") })
    );
    expect(closed.freshness[0]?.state).toBe("closed");
  });

  it("returns the five notes and null for session.event and levels", () => {
    const control = buildFlowControl(rowsOf());
    expect(control.notes).toHaveLength(5);
    expect(control.notes[0]).toContain("otm-clean.v1");
    expect(control.levels).toBeNull();
    expect(control.session).toEqual({
      date: DATE,
      event: null,
      futuresOpen: true,
      open: true,
      optionsOpen: true,
    });
    expect(control.study).toEqual({
      agreementDetail:
        "futures and options agreement is not compared or tested",
      detail: "Options-side continuation rule (modelled fills): not tested yet",
      rulesVersion: null,
      status: "not_tested",
      strategyId: "flow-control-continuation",
      testedOn: null,
    });
    const weekend = buildFlowControl(
      rowsOf({
        now: new Date("2026-11-07T16:00:00.000Z"),
        sessionDate: "2026-11-06",
      })
    );
    expect(weekend.session).toMatchObject({ futuresOpen: false, open: false });
  });

  it("reports sellers with a bearish direction and its start", () => {
    const control = buildFlowControl(
      rowsOf({
        netDrift: [
          ...run("SPX", 0, 21, 0, 1000),
          ...run("SPY", 0, 21, 0, 1000),
        ],
      })
    );
    expect(control.options).toMatchObject({
      direction: "bearish",
      since: at(9).toISOString(),
      state: "sellers",
    });
  });
});
