import { describe, expect, it } from "vitest";

import { FlowControlSchema, type FlowOptionTicker } from "../contracts/flow.ts";
import type { FlowDeepTradeRow } from "../flow-deep-trades.ts";
import type { FlowEventRow, FlowMinuteRow } from "../flow-features.ts";
import type { FlowNetDriftRow } from "../flow-net-drift.ts";
import type { FlowOptionPrintRow } from "../flow-options.ts";
import {
  buildFlowControl,
  etClock,
  type FlowControlRows,
  futuresSessionRange,
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

const ticks = (
  when: Date,
  status: FlowSampleRow["status"] = "ok",
  message: string | null = null
): FlowSampleRow => ({
  ...sample("ES", when, status, message),
  source: "ticks",
});

const rowsOf = (overrides: Partial<FlowControlRows> = {}): FlowControlRows => ({
  crossGaps: [],
  crossPrints: readFor([]),
  group: "sp500",
  largeTrades: [],
  netDrift: [
    ...run("SPX", 0, 21, 1000, 0),
    ...run("SPY", 0, 21, 500, 500),
    ...run("SPX", 0, 21, 100, 0, { part: "zero_dte" }),
  ],
  now: NOW,
  previousClose: null,
  samples: freshSamples(),
  sessionDate: DATE,
  sessionEvent: { calendar: "read", event: null },
  study: { rulesVersion: null, status: "not_tested", testedOn: null },
  tape: [],
  tapeEvents: [],
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
    const lateBuckets = buildFlowControl(
      rowsOf({ netDrift: run("SPX", 0, 8, 1000, 0), now: at(11) })
    );
    expect(lateBuckets.options).toMatchObject({
      detail: "9 of 10 minutes needed since 09:30 ET",
      noDataReason: "session_start",
    });
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

  it("futures side is no_data in the stated order: market_closed, source_unavailable, stale, sampled_tape; no ratio is computed", () => {
    const withTicks = (
      latest: FlowSampleRow[],
      latestOk: FlowSampleRow[],
      now: Date = NOW
    ) =>
      buildFlowControl(
        rowsOf({
          now,
          samples: { ...freshSamples(now), ES: { latest, latestOk } },
        })
      ).futures;
    const fresh = ticks(at(19));
    // 1 market_closed: before 09:30, at 16:00 and on a weekend.
    for (const now of [at(-1), at(390), new Date("2026-11-07T16:00:00.000Z")])
      expect(withTicks([fresh], [fresh], now)).toMatchObject({
        detail:
          "The ES deep-trade window is 09:30 to 16:00 ET; the last window was 2026-11-09",
        label: "Market closed",
        noDataReason: "market_closed",
      });
    // 2 source_unavailable: newest unavailable, no ok sample within 10 min.
    const failed = ticks(at(20), "unavailable", "gateway timeout");
    expect(withTicks([failed], [ticks(at(5))])).toMatchObject({
      detail: "gateway timeout",
      noDataReason: "source_unavailable",
    });
    expect(withTicks([failed], [])).toMatchObject({
      noDataReason: "source_unavailable",
    });
    // A storage failure of the newest sample names storage, not the source.
    const unstored = ticks(
      at(20),
      "unavailable",
      "storage: write failed (Error)"
    );
    expect(withTicks([unstored], [ticks(at(5))])).toMatchObject({
      label: "Futures ticks were not stored",
      noDataReason: "storage_failed",
    });
    // An ok sample at most 10 min old: not source_unavailable.
    expect(withTicks([failed], [fresh]).noDataReason).toBe("sampled_tape");
    // 3 stale.
    expect(withTicks([ticks(at(5))], [ticks(at(5))])).toMatchObject({
      asOf: at(5).toISOString(),
      detail: `Newest ES tick sample is ${etClock(at(5))}; stale after 10 min`,
      noDataReason: "stale",
    });
    // 4 sampled_tape.
    expect(withTicks([fresh], [fresh])).toEqual({
      asOf: at(19).toISOString(),
      detail:
        "ES deep trades are listed below; a futures state needs the full tape",
      direction: "neutral",
      enterRatio: 0.3,
      inputs: { denominator: null, numerator: null, rows: 0 },
      instrument: "ES",
      label: "Futures: deep trades only (sampled tape, no state)",
      noDataReason: "sampled_tape",
      ratio: null,
      since: null,
      state: "no_data",
      windowEnd: null,
      windowStart: null,
    });
  });

  it("stale without any ok tick sample", () => {
    expect(buildFlowControl(rowsOf()).futures).toMatchObject({
      asOf: null,
      detail: "No ES tick sample since 09:30 ET; stale after 10 min",
      noDataReason: "stale",
    });
    // Within 10 min of the open without a sample: not stale yet.
    expect(buildFlowControl(rowsOf({ now: at(5) })).futures.noDataReason).toBe(
      "sampled_tape"
    );
  });

  it("stale when the newest samples are empty or skipped", () => {
    for (const status of ["empty", "skipped"] as const) {
      const control = buildFlowControl(
        rowsOf({
          samples: {
            ...freshSamples(),
            ES: { latest: [ticks(at(20), status)], latestOk: [] },
          },
        })
      );
      expect(control.futures.noDataReason).toBe("stale");
    }
  });

  it("agreement is not_comparable with the futures cause", () => {
    const ok = ticks(at(20));
    expect(
      buildFlowControl(
        rowsOf({
          samples: { ...freshSamples(), ES: { latest: [ok], latestOk: [ok] } },
        })
      ).agreement
    ).toEqual({
      detail:
        "Futures: deep trades only (sampled tape, no state): ES deep trades are listed below; a futures state needs the full tape",
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

  it("returns the notes and null for session.event", () => {
    const control = buildFlowControl(rowsOf());
    expect(control.notes).toHaveLength(8);
    expect(control.notes[0]).toContain("otm-clean.v1");
    expect(control.notes).toContain(
      "Deep trades are single prints of at least 40 contracts on ES, from a sampled tape; sums are lower bounds."
    );
    expect(control.notes.join(" ")).not.toContain("not collected");
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

  describe("buildFlowControl deep trades, levels and event", () => {
    const trade = (
      minute: number,
      side: "buy" | "sell",
      size: number,
      signing: "quote" | "tick" = "quote",
      second = 7
    ): FlowDeepTradeRow => ({
      capture: "sampled",
      limitSize: 40,
      price: 6870.5,
      sampledAt: NOW,
      second: new Date(at(minute).getTime() + second * 1000),
      seq: 0,
      side,
      signing,
      size,
      symbol: "ES",
    });
    const tapeRow = (minute: number, coveredSeconds = 60): FlowMinuteRow =>
      ({
        coveredSeconds,
        minute: at(minute),
        symbol: "ES",
      }) as FlowMinuteRow;
    const absorption = (
      minute: number,
      price: number | null,
      kind: FlowEventRow["kind"] = "absorption"
    ): FlowEventRow =>
      ({
        at: at(minute),
        detail: `Buy absorption ${minute}`,
        direction: "bearish",
        kind,
        price,
        symbol: "ES",
      }) as FlowEventRow;

    it("deep trades block: limit, session sums, newest 60 of the total, sampled minutes only with their covered seconds, absorption marks", () => {
      const trades = [
        trade(-1, "buy", 99),
        ...Array.from({ length: 70 }, (_, index) =>
          trade(index % 20, index % 3 === 0 ? "sell" : "buy", 40 + (index % 5))
        ),
        trade(390, "buy", 99),
      ].sort((a, b) => a.second.getTime() - b.second.getTime());
      const control = buildFlowControl(
        rowsOf({
          largeTrades: trades,
          tape: [tapeRow(2, 30), tapeRow(0), tapeRow(1), tapeRow(400)],
          tapeEvents: [
            absorption(1, 6870.5),
            absorption(3, null),
            absorption(4, 1, "large_print"),
            absorption(-5, 1),
          ],
        })
      );
      const deep = control.deepTrades;
      const inSession = trades.slice(1, -1);
      const buy = inSession
        .filter((row) => row.side === "buy")
        .reduce((sum, row) => sum + row.size, 0);
      const sell = inSession
        .filter((row) => row.side === "sell")
        .reduce((sum, row) => sum + row.size, 0);
      expect(deep).toMatchObject({
        limitSize: 40,
        signing: "quote",
        sums: {
          buyVolume: buy,
          cumulativeFrom: FROM.toISOString(),
          netVolume: buy - sell,
          sellVolume: sell,
        },
        symbol: "ES",
        totalTrades: 70,
      });
      expect(deep.trades).toHaveLength(60);
      expect(deep.trades[0]?.at).toBe(inSession.at(-1)?.second.toISOString());
      expect(
        deep.minutes.map((row) => [row.minute, row.coveredSeconds])
      ).toEqual([
        [at(0).toISOString(), 60],
        [at(1).toISOString(), 60],
        [at(2).toISOString(), 30],
      ]);
      const minuteZero = inSession.filter(
        (row) => row.second.getTime() < at(1).getTime()
      );
      expect(deep.minutes[0]).toMatchObject({
        buyVolume: minuteZero
          .filter((row) => row.side === "buy")
          .reduce((sum, row) => sum + row.size, 0),
      });
      expect(
        buildFlowControl(rowsOf({ tape: [tapeRow(25)] })).deepTrades.minutes[0]
      ).toMatchObject({ buyVolume: 0, sellVolume: 0 });
      expect(deep.absorptions).toEqual([
        {
          at: at(3).toISOString(),
          detail: "Buy absorption 3",
          direction: "bearish",
          price: null,
        },
        {
          at: at(1).toISOString(),
          detail: "Buy absorption 1",
          direction: "bearish",
          price: 6870.5,
        },
      ]);
      expect(control.futures.inputs.rows).toBe(70);
      expect(FlowControlSchema.parse(control)).toEqual(control);
      const empty = buildFlowControl(rowsOf()).deepTrades;
      expect(empty.sums).toEqual({
        buyVolume: 0,
        cumulativeFrom: null,
        netVolume: 0,
        sellVolume: 0,
      });
    });

    it("signing is the one method of the rows, null for mixed rows and for no row", () => {
      const signing = (largeTrades: FlowDeepTradeRow[]) =>
        buildFlowControl(rowsOf({ largeTrades })).deepTrades.signing;
      expect(signing([trade(1, "buy", 40, "tick")])).toBe("tick");
      expect(
        signing([trade(1, "buy", 40, "tick"), trade(2, "buy", 40, "quote")])
      ).toBeNull();
      expect(signing([])).toBeNull();
    });

    it("coverage: share of the trailing window, shorter window at the open, null without a tape minute, last stored minute after 16:00, empty before 09:30", () => {
      const coverage = (now: Date, tape: FlowMinuteRow[]) =>
        buildFlowControl(rowsOf({ now, tape })).deepTrades.coverage;
      // At 10:30 (m = 60): the window holds minutes 31..60.
      expect(
        coverage(at(60), [tapeRow(30), tapeRow(31, 20), tapeRow(60, 40)])
      ).toEqual({ seenSeconds: 60, share: 60 / 1800, windowSeconds: 1800 });
      // At 09:51 (m = 21): 22 minutes.
      expect(coverage(NOW, [tapeRow(0)])).toEqual({
        seenSeconds: 60,
        share: 60 / 1320,
        windowSeconds: 1320,
      });
      expect(coverage(NOW, [])).toEqual({
        seenSeconds: 0,
        share: null,
        windowSeconds: 1320,
      });
      // After 16:00: the last stored minute is 15:59 (m = 389).
      expect(coverage(at(500), [tapeRow(389, 30), tapeRow(359)])).toEqual({
        seenSeconds: 30,
        share: 30 / 1800,
        windowSeconds: 1800,
      });
      expect(coverage(at(-10), [tapeRow(0)])).toEqual({
        seenSeconds: 0,
        share: null,
        windowSeconds: 1800,
      });
    });

    it("levels from one-minute closes with the previous close, null parts and a null block", () => {
      const priced = (minute: number, price: number | null, part = "total") =>
        bucket("SPX", minute, 0, 0, {
          part: part as FlowNetDriftRow["part"],
          underlyingPrice: price,
        });
      const levels = buildFlowControl(
        rowsOf({
          netDrift: [
            priced(0, 6852.1),
            priced(1, null),
            priced(1, 6880.4, "zero_dte"),
            priced(2, 6841),
            priced(2, 1, "zero_dte"),
            priced(390, 1),
            bucket("SPY", 3, 0, 0, { underlyingPrice: 1 }),
          ],
          previousClose: 6848.3,
        })
      ).levels;
      expect(levels).toEqual({
        previousClose: 6848.3,
        sessionHigh: 6880.4,
        sessionLow: 6841,
        sessionOpen: 6852.1,
        source: "one_minute_closes",
        ticker: "SPX",
      });
      expect(
        buildFlowControl(rowsOf({ netDrift: [], previousClose: 6848.3 })).levels
      ).toEqual({
        previousClose: 6848.3,
        sessionHigh: null,
        sessionLow: null,
        sessionOpen: null,
        source: "one_minute_closes",
        ticker: "SPX",
      });
      expect(buildFlowControl(rowsOf({ netDrift: [] })).levels).toBeNull();
    });

    it("session.event is fomc on a meeting day and null on another, with its note", () => {
      const fomc = buildFlowControl(
        rowsOf({ sessionEvent: { calendar: "read", event: "fomc" } })
      );
      expect(fomc.session.event).toBe("fomc");
      expect(fomc.notes).toContain(
        "FOMC meeting day (Federal Reserve calendar)."
      );
      const plain = buildFlowControl(rowsOf());
      expect(plain.session.event).toBeNull();
      expect(plain.notes.join(" ")).not.toContain("FOMC");
    });

    it("adds the note when the calendar was not read", () => {
      const control = buildFlowControl(
        rowsOf({ sessionEvent: { calendar: "not_read", event: null } })
      );
      expect(control.notes).toContain(
        "The event calendar was not read; no FOMC mark for this session."
      );
      expect(control.notes.length).toBeLessThanOrEqual(12);
    });

    it("both groups still pass the contract schema", () => {
      for (const group of ["sp500", "nasdaq100"] as const) {
        const control = buildFlowControl(
          rowsOf({
            group,
            largeTrades: [trade(1, "buy", 40)],
            sessionEvent: { calendar: "not_read", event: "fomc" },
            tape: [tapeRow(1)],
          })
        );
        expect(FlowControlSchema.parse(control)).toEqual(control);
      }
    });

    it("the futures session runs from 09:30 to 16:00 New York", () => {
      expect(futuresSessionRange(DATE)).toEqual({
        from: FROM,
        to: at(390),
      });
    });
  });
});
