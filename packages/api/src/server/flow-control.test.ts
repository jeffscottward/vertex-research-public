import { describe, expect, it } from "vitest";

import { FlowControlSchema, type FlowOptionTicker } from "../contracts/flow.ts";
import { FLOW_FUTURES_RULES } from "../flow-control-rules.ts";
import type { FlowDeepTradeRow } from "../flow-deep-trades.ts";
import type { FlowEventRow, FlowMinuteRow } from "../flow-features.ts";
import type { FlowNetDriftRow } from "../flow-net-drift.ts";
import type { FlowOptionPrintRow } from "../flow-options.ts";
import {
  buildFlowControl,
  etClock,
  type FlowControlRows,
  flowCaptureOf,
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

  describe("futures side and agreement", () => {
    /** A covered ES tape minute: a positive delta and a close above the VWAP. */
    const minuteRow = (
      minute: number,
      overrides: Partial<FlowMinuteRow> = {}
    ): FlowMinuteRow => ({
      absorption: null,
      buyVolume: 60,
      close: 6001,
      coveredSeconds: 60,
      delta: 20,
      high: 6002,
      largePrints: 0,
      largePrintVolume: 0,
      low: 5999,
      minute: at(minute),
      offExchangeVolume: 0,
      open: 6000,
      sellVolume: 40,
      stackedBuy: 0,
      stackedSell: 0,
      symbol: "ES",
      trades: 50,
      volume: 100,
      vwap: 6000,
      ...overrides,
    });
    const tapeOf = (
      start: number,
      end: number,
      overrides: Partial<FlowMinuteRow> = {}
    ) =>
      Array.from({ length: end - start }, (_, index) =>
        minuteRow(start + index, overrides)
      );
    const deep = (
      minute: number,
      side: "buy" | "sell",
      overrides: Partial<FlowDeepTradeRow> = {}
    ): FlowDeepTradeRow => ({
      capture: "streamed",
      limitSize: 40,
      price: 6000,
      sampledAt: at(minute + 1),
      second: new Date(at(minute).getTime() + 7000),
      seq: 0,
      side,
      signing: "quote",
      size: 40,
      symbol: "ES",
      ...overrides,
    });
    const deepOf = (start: number, end: number, side: "buy" | "sell") =>
      Array.from({ length: end - start }, (_, index) =>
        deep(start + index, side)
      );
    /** The samples of a session with tape reads of ES: the newest read and the newest ok read. */
    const tapeSamples = (
      now: Date = NOW,
      latest: FlowSampleRow = ticks(now),
      latestOk: FlowSampleRow | null = latest
    ) => ({
      ...freshSamples(now),
      ES: {
        latest: [sample("ES", now), latest],
        latestOk: [sample("ES", now), ...(latestOk === null ? [] : [latestOk])],
      },
    });
    const control = (overrides: Partial<FlowControlRows> = {}) =>
      buildFlowControl(
        rowsOf({ samples: tapeSamples(overrides.now), ...overrides })
      );
    /** Deep buys in every minute: ratio +1 and every check passes. */
    const buyTape = { largeTrades: deepOf(0, 21, "buy"), tape: tapeOf(0, 21) };
    /** Deep sells in every minute: ratio -1 and every check passes. */
    const sellTape = {
      largeTrades: deepOf(0, 21, "sell"),
      tape: tapeOf(0, 21, { close: 5999, delta: -20 }),
    };
    const seconds = (now: Date, back: number) =>
      new Date(now.getTime() - back * 1000);

    it("buyers: the state, its start, the window, the inputs and asOf come from the last step", () => {
      const document = control(buyTape);
      expect(document.futures).toEqual({
        asOf: at(21).toISOString(),
        detail:
          "Deep-trade ratio 1.00 over the last 30 min from 21 deep trades; enter ratio 0.30",
        direction: "bullish",
        enterRatio: 0.3,
        hold: null,
        inputs: { denominator: 840, numerator: 840, rows: 21 },
        instrument: "ES",
        label: "ES futures: buyers in control",
        noDataReason: null,
        ratio: 1,
        since: at(9).toISOString(),
        state: "buyers",
        trades: 21,
        windowEnd: at(21).toISOString(),
        windowStart: at(-9).toISOString(),
      });
      expect(document.futuresRules).toEqual(FLOW_FUTURES_RULES);
      expect(FlowControlSchema.parse(document)).toEqual(document);
    });

    it("sellers are bearish, and a tape without a deep trade is balanced with the ratio 0", () => {
      expect(control(sellTape).futures).toMatchObject({
        direction: "bearish",
        hold: null,
        inputs: { denominator: 840, numerator: -840, rows: 21 },
        label: "ES futures: sellers in control",
        ratio: -1,
        since: at(9).toISOString(),
        state: "sellers",
      });
      expect(control({ tape: tapeOf(0, 21) }).futures).toMatchObject({
        detail:
          "Deep-trade ratio 0.00 over the last 30 min from 0 deep trades; enter ratio 0.30",
        direction: "neutral",
        hold: null,
        inputs: { denominator: 0, numerator: 0, rows: 21 },
        label: "ES futures: balanced",
        noDataReason: null,
        ratio: 0,
        since: null,
        state: "balanced",
        trades: 0,
      });
    });

    it("reports each hold with a balanced state, the ratio before the checks and the reason in the detail", () => {
      const sentence = (trades: number) =>
        `Deep-trade ratio 1.00 over the last 30 min from ${trades} deep trades; enter ratio 0.30; not counted: `;
      expect(
        control({ largeTrades: deepOf(15, 21, "buy"), tape: tapeOf(0, 21) })
          .futures
      ).toMatchObject({
        detail: `${sentence(6)}fewer than 10 deep trades`,
        direction: "neutral",
        hold: "few_trades",
        label: "ES futures: balanced",
        ratio: 1,
        since: null,
        state: "balanced",
        trades: 6,
      });
      expect(
        control({ ...buyTape, tape: tapeOf(0, 21, { delta: -20 }) }).futures
      ).toMatchObject({
        detail: `${sentence(21)}the delta of all trades points the other way`,
        hold: "delta_against",
        state: "balanced",
      });
      expect(
        control({ ...buyTape, tape: tapeOf(0, 21, { close: 5999 }) }).futures
      ).toMatchObject({
        detail: `${sentence(21)}the price is on the other side of the 30-min VWAP`,
        hold: "price_against",
        state: "balanced",
      });
    });

    it("folds covered minutes of the future that have ended; the deep trades of another minute do not count", () => {
      const now = new Date(at(21).getTime() + 30_000);
      const futures = (tape: FlowMinuteRow[]) =>
        control({ largeTrades: deepOf(0, 22, "buy"), now, tape }).futures;
      // Minute 21 is in progress: it is left out.
      expect(futures(tapeOf(0, 22))).toMatchObject({
        asOf: at(21).toISOString(),
        inputs: { denominator: 840, numerator: 840, rows: 21 },
        trades: 21,
      });
      // 55 covered seconds count; 54 do not, and the deep trade of that minute is left out.
      expect(
        futures([...tapeOf(0, 20), minuteRow(20, { coveredSeconds: 55 })])
      ).toMatchObject({ asOf: at(21).toISOString(), trades: 21 });
      expect(
        futures([...tapeOf(0, 20), minuteRow(20, { coveredSeconds: 54 })])
      ).toMatchObject({
        asOf: at(20).toISOString(),
        inputs: { denominator: 800, numerator: 800, rows: 20 },
        trades: 20,
      });
      // A row of another symbol and a row outside the session are left out.
      expect(
        futures([
          ...tapeOf(0, 20),
          minuteRow(20, { symbol: "NQ" }),
          minuteRow(-1),
        ])
      ).toMatchObject({ asOf: at(20).toISOString(), trades: 20 });
    });

    it("market_closed comes first: before 09:30, at 16:00 and on a weekend", () => {
      const saturday = new Date("2026-11-07T16:00:00.000Z");
      for (const now of [at(-1), at(390), saturday])
        expect(control({ ...buyTape, now }).futures).toMatchObject({
          detail:
            "The ES deep-trade window is 09:30 to 16:00 ET; the last window was 2026-11-09",
          direction: "neutral",
          hold: null,
          label: "Market closed",
          noDataReason: "market_closed",
          ratio: null,
          since: null,
          state: "no_data",
        });
      // After the close the window of the last covered minute stays in the document.
      expect(control({ ...buyTape, now: at(390) }).futures).toMatchObject({
        asOf: at(21).toISOString(),
        inputs: { denominator: 840, numerator: 840, rows: 21 },
        trades: 21,
        windowEnd: at(21).toISOString(),
      });
      // Before the open no minute has ended.
      expect(control({ ...buyTape, now: at(-1) }).futures).toMatchObject({
        asOf: null,
        inputs: { denominator: null, numerator: null, rows: 0 },
        trades: 0,
        windowEnd: null,
        windowStart: null,
      });
    });

    it("source_unavailable and storage_failed: the newest tape read failed and no ok read is inside 180 s", () => {
      const failed = ticks(at(21), "unavailable", "tape stream down: no tick");
      const side = (latest: FlowSampleRow, latestOk: FlowSampleRow | null) =>
        control({ ...buyTape, samples: tapeSamples(NOW, latest, latestOk) })
          .futures;
      expect(side(failed, ticks(seconds(NOW, 181)))).toMatchObject({
        detail: "tape stream down: no tick",
        label: "No answer from the IBKR tape",
        noDataReason: "source_unavailable",
        ratio: null,
        state: "no_data",
      });
      expect(side(failed, null).noDataReason).toBe("source_unavailable");
      expect(side(ticks(at(21), "unavailable"), null).detail).toBe(
        "the last request failed"
      );
      const unstored = ticks(
        at(21),
        "unavailable",
        "storage: write failed (Error)"
      );
      expect(side(unstored, ticks(seconds(NOW, 181)))).toMatchObject({
        detail:
          "The last ES tape read was not stored (storage: write failed (Error)); the next run retries",
        label: "Futures tape was not stored",
        noDataReason: "storage_failed",
      });
      // An ok read at most 180 s old: the fold decides.
      expect(side(failed, ticks(seconds(NOW, 180)))).toMatchObject({
        noDataReason: null,
        state: "buyers",
      });
    });

    it("stale: the newest ok tape read is older than 180 s", () => {
      const side = (latestOk: FlowSampleRow) =>
        control({ ...buyTape, samples: tapeSamples(NOW, latestOk) }).futures;
      const old = seconds(NOW, 181);
      expect(side(ticks(old))).toMatchObject({
        detail: `Newest ES tape read is ${etClock(old)}; stale after 3 min`,
        hold: null,
        label: "Futures tape is stale",
        noDataReason: "stale",
        ratio: null,
        since: null,
        state: "no_data",
      });
      expect(side(ticks(seconds(NOW, 180))).state).toBe("buyers");
    });

    it("stale without any ok tape read, but not in the first 180 s after the open", () => {
      expect(buildFlowControl(rowsOf()).futures).toMatchObject({
        asOf: null,
        detail: "No ES tape read since 09:30 ET; stale after 3 min",
        noDataReason: "stale",
      });
      expect(
        buildFlowControl(rowsOf({ now: at(3) })).futures.noDataReason
      ).toBe("session_start");
      expect(
        buildFlowControl(rowsOf({ now: new Date(at(3).getTime() + 1000) }))
          .futures.noDataReason
      ).toBe("stale");
    });

    it("stale when the newest tape reads are empty or skipped", () => {
      for (const status of ["empty", "skipped"] as const)
        expect(
          control({
            ...buyTape,
            samples: tapeSamples(NOW, ticks(at(20), status), null),
          }).futures.noDataReason
        ).toBe("stale");
    });

    it("session_start: fewer than 10 minutes have ended since 09:30", () => {
      const early = control({
        largeTrades: deepOf(0, 6, "buy"),
        now: at(6),
        tape: tapeOf(0, 6),
      }).futures;
      expect(early).toMatchObject({
        asOf: at(6).toISOString(),
        detail: "6 of 10 covered tape minutes needed in the last 30 min for ES",
        hold: null,
        inputs: { denominator: 240, numerator: 240, rows: 6 },
        label: "Futures: session start",
        noDataReason: "session_start",
        ratio: null,
        since: null,
        state: "no_data",
        trades: 6,
      });
      // No covered minute yet.
      const none = (now: Date) => control({ now, tape: [] }).futures;
      expect(none(at(2))).toMatchObject({
        asOf: null,
        detail: "0 of 10 covered tape minutes needed in the last 30 min for ES",
        noDataReason: "session_start",
        trades: 0,
      });
      expect(none(new Date(at(10).getTime() - 1000)).noDataReason).toBe(
        "session_start"
      );
      expect(none(at(10))).toMatchObject({
        detail:
          "0 covered tape minutes in the last 30 min for ES; at most 5 may be missing",
        label: "Gap in the ES tape",
        noDataReason: "gap",
      });
    });

    it("gap: too few covered minutes in the window ends the state", () => {
      const futures = control({
        largeTrades: deepOf(0, 21, "buy"),
        tape: [...tapeOf(0, 3), ...tapeOf(10, 21)],
      }).futures;
      expect(futures).toMatchObject({
        asOf: at(21).toISOString(),
        detail:
          "14 covered tape minutes in the last 30 min for ES; at most 5 may be missing",
        direction: "neutral",
        inputs: { denominator: 560, numerator: 560, rows: 14 },
        label: "Gap in the ES tape",
        noDataReason: "gap",
        ratio: null,
        since: null,
        state: "no_data",
        trades: 14,
      });
      // Minutes with too few covered seconds are a gap too.
      expect(
        control({ tape: tapeOf(0, 21, { coveredSeconds: 54 }) }).futures
          .noDataReason
      ).toBe("gap");
    });

    it("a state does not outlive its tape: 6 newer stored minutes without coverage give a gap, 3 keep the state", () => {
      const uncovered = (start: number) => [
        ...tapeOf(0, start),
        ...tapeOf(start, 21, { coveredSeconds: 30 }),
      ];
      // Minutes 15 to 20 are stored with 30 covered seconds; the newest tape read is ok and fresh.
      const gap = control({
        largeTrades: deepOf(0, 21, "buy"),
        tape: uncovered(15),
      });
      expect(gap.futures).toEqual({
        asOf: at(15).toISOString(),
        detail:
          "15 covered tape minutes in the last 30 min for ES; at most 5 may be missing",
        direction: "neutral",
        enterRatio: 0.3,
        hold: null,
        inputs: { denominator: 600, numerator: 600, rows: 15 },
        instrument: "ES",
        label: "Gap in the ES tape",
        noDataReason: "gap",
        ratio: null,
        since: null,
        state: "no_data",
        trades: 15,
        windowEnd: at(21).toISOString(),
        windowStart: at(-9).toISOString(),
      });
      expect(gap.agreement.state).toBe("not_comparable");
      expect(FlowControlSchema.parse(gap)).toEqual(gap);
      // Minutes 18 to 20 only: the state stays, and asOf shows the age of the tape.
      const kept = control({
        largeTrades: deepOf(0, 21, "buy"),
        tape: uncovered(18),
      });
      expect(kept.futures).toMatchObject({
        asOf: at(18).toISOString(),
        inputs: { denominator: 720, numerator: 720, rows: 18 },
        label: "ES futures: buyers in control",
        noDataReason: null,
        ratio: 1,
        since: at(9).toISOString(),
        state: "buyers",
        trades: 18,
        windowEnd: at(21).toISOString(),
      });
      // Stored minutes without any covered minute: no asOf, and the fold gives the reason.
      expect(
        control({ now: at(4), tape: tapeOf(0, 4, { coveredSeconds: 30 }) })
          .futures
      ).toMatchObject({
        asOf: null,
        inputs: { denominator: 0, numerator: 0, rows: 0 },
        noDataReason: "session_start",
        windowEnd: at(4).toISOString(),
      });
    });

    it("stored minutes without coverage do not count toward an entry: one seen minute plus four unseen minutes is not five in a row", () => {
      // 09:30 to 09:49 are covered; 12 deep buys all in 09:49; 09:50 to 09:53 have 30 covered seconds.
      const now = new Date(at(24).getTime() + 30_000);
      const document = control({
        largeTrades: Array.from({ length: 12 }, (_, index) =>
          deep(19, "buy", {
            second: new Date(at(19).getTime() + index * 1000),
          })
        ),
        now,
        tape: [...tapeOf(0, 20), ...tapeOf(20, 24, { coveredSeconds: 30 })],
      });
      expect(document.futures).toMatchObject({
        asOf: at(20).toISOString(),
        detail:
          "Deep-trade ratio 1.00 over the last 30 min from 12 deep trades; enter ratio 0.30",
        direction: "neutral",
        hold: null,
        inputs: { denominator: 480, numerator: 480, rows: 20 },
        label: "ES futures: balanced",
        noDataReason: null,
        ratio: 1,
        since: null,
        state: "balanced",
        trades: 12,
        windowEnd: at(24).toISOString(),
      });
      expect(FlowControlSchema.parse(document)).toEqual(document);
    });

    it("agree: both sides show the same control side; since is the later start", () => {
      // Futures: the tenth deep trade arrives in minute 13, so the run starts there. Options: 09:39.
      const later = control({
        largeTrades: deepOf(4, 21, "buy"),
        tape: tapeOf(0, 21),
      });
      expect(later.futures.since).toBe(at(13).toISOString());
      expect(later.options.since).toBe(at(9).toISOString());
      expect(later.agreement).toEqual({
        detail: "ES futures and SPX options both show buyers in control",
        direction: "bullish",
        label: "Agree: buyers in control on both sides",
        since: at(13).toISOString(),
        state: "agree",
      });
      // Options start later than the futures.
      const options = control({
        ...buyTape,
        netDrift: [
          ...run("SPX", 0, 10, 500, 500),
          ...run("SPX", 10, 21, 1000, 0),
          ...run("SPY", 0, 21, 500, 500),
        ],
      });
      expect(options.futures.since).toBe(at(9).toISOString());
      expect(options.agreement).toMatchObject({
        since: at(14).toISOString(),
        state: "agree",
      });
      const bearish = control({
        ...sellTape,
        netDrift: [
          ...run("SPX", 0, 21, 0, 1000),
          ...run("SPY", 0, 21, 0, 1000),
        ],
      });
      expect(bearish.agreement).toEqual({
        detail: "ES futures and SPX options both show sellers in control",
        direction: "bearish",
        label: "Agree: sellers in control on both sides",
        since: at(9).toISOString(),
        state: "agree",
      });
      expect(FlowControlSchema.parse(bearish)).toEqual(bearish);
    });

    it("diverge: opposite control sides, neutral, with the later start", () => {
      const document = control({
        largeTrades: deepOf(4, 21, "sell"),
        tape: sellTape.tape,
      });
      expect(document.agreement).toEqual({
        detail:
          "ES futures: sellers in control; SPX options: bullish, call buying leads",
        direction: "neutral",
        label: "Diverge: the two sides show opposite control",
        since: at(13).toISOString(),
        state: "diverge",
      });
      expect(FlowControlSchema.parse(document)).toEqual(document);
    });

    it("one_sided and both_balanced have no start", () => {
      const balancedOptions = [
        ...run("SPX", 0, 21, 500, 500),
        ...run("SPY", 0, 21, 500, 500),
      ];
      expect(control({ tape: tapeOf(0, 21) }).agreement).toEqual({
        detail: "ES futures: balanced; SPX options: bullish, call buying leads",
        direction: "neutral",
        label: "One-sided: only the options side shows control",
        since: null,
        state: "one_sided",
      });
      expect(
        control({ ...buyTape, netDrift: balancedOptions }).agreement
      ).toEqual({
        detail: "ES futures: buyers in control; SPX options: balanced",
        direction: "neutral",
        label: "One-sided: only the futures side shows control",
        since: null,
        state: "one_sided",
      });
      const both = control({ netDrift: balancedOptions, tape: tapeOf(0, 21) });
      expect(both.agreement).toEqual({
        detail: "Neither ES futures nor SPX options show a side in control",
        direction: "neutral",
        label: "Both sides balanced",
        since: null,
        state: "both_balanced",
      });
      expect(FlowControlSchema.parse(both)).toEqual(both);
    });

    it("not_comparable: a futures side without data, or a mixed options side", () => {
      expect(buildFlowControl(rowsOf()).agreement).toEqual({
        detail:
          "Futures tape is stale: No ES tape read since 09:30 ET; stale after 3 min",
        direction: "neutral",
        label: "Cannot compare",
        since: null,
        state: "not_comparable",
      });
      const mixed = control({
        ...buyTape,
        netDrift: [
          ...run("SPX", 0, 21, 1000, 0),
          ...run("SPY", 0, 21, 0, 1000),
        ],
      });
      expect(mixed.options.state).toBe("mixed");
      expect(mixed.agreement).toMatchObject({
        direction: "neutral",
        label: "Cannot compare",
        since: null,
        state: "not_comparable",
      });
      expect(mixed.agreement.detail).toContain(
        "Options mixed: SPX bullish, SPY bearish: "
      );
      // The options side has no data while the futures side has a state.
      const noOptions = control({ ...buyTape, netDrift: [] });
      expect(noOptions.agreement).toMatchObject({
        since: null,
        state: "not_comparable",
      });
      expect(noOptions.agreement.detail).toBe(
        `${noOptions.options.label}: ${noOptions.options.detail}`
      );
    });

    it("nasdaq100: the futures side reads the NQ tape and passes the schema", () => {
      const tick: FlowSampleRow = { ...ticks(NOW), symbol: "NQ" };
      const document = buildFlowControl(
        rowsOf({
          crossGaps: null,
          crossPrints: null,
          group: "nasdaq100",
          largeTrades: deepOf(0, 21, "buy").map((row) => ({
            ...row,
            limitSize: 10,
            symbol: "NQ" as const,
          })),
          netDrift: run("QQQ", 0, 21, 0, 1000),
          samples: { NQ: { latest: [tick], latestOk: [tick] } },
          tape: tapeOf(0, 21, { symbol: "NQ" }),
        })
      );
      expect(FlowControlSchema.parse(document)).toEqual(document);
      expect(document.futures).toMatchObject({
        instrument: "NQ",
        label: "NQ futures: buyers in control",
        state: "buyers",
      });
      expect(document.agreement).toMatchObject({
        detail:
          "NQ futures: buyers in control; QQQ options: bearish, put buying leads",
        state: "diverge",
      });
      expect(document.freshness.at(-1)).toMatchObject({
        instrument: "NQ",
        source: "ticks",
        state: "fresh",
      });
      expect(document.deepTrades.capture).toBe("streamed");
    });

    it("lists the tape of the future as the last freshness row: never, fresh, stale after 180 s, closed", () => {
      const row = (
        now: Date,
        latest: FlowSampleRow,
        latestOk: FlowSampleRow | null = latest
      ) =>
        control({ now, samples: tapeSamples(now, latest, latestOk) })
          .freshness[2];
      const message = "streamed tape ESZ6: 900 prints in 1 complete minutes";
      expect(row(NOW, ticks(seconds(NOW, 180), "ok", message))).toEqual({
        ageSeconds: 180,
        instrument: "ES",
        lastOkAt: seconds(NOW, 180).toISOString(),
        message,
        source: "ticks",
        state: "fresh",
      });
      expect(row(NOW, ticks(seconds(NOW, 181)))?.state).toBe("stale");
      // The message is the one of the newest read, also when that read failed.
      expect(
        row(
          NOW,
          ticks(NOW, "unavailable", "tape stream down: no tick"),
          ticks(at(5))
        )
      ).toMatchObject({
        ageSeconds: 16 * 60,
        message: "tape stream down: no tick",
        state: "stale",
      });
      expect(
        row(NOW, ticks(NOW, "unavailable", "tape stream down: no tick"), null)
      ).toEqual({
        ageSeconds: null,
        instrument: "ES",
        lastOkAt: null,
        message: "tape stream down: no tick",
        source: "ticks",
        state: "never",
      });
      // Globex is open after the options close and closed on Saturday.
      const evening = new Date("2026-11-09T21:21:00.000Z");
      expect(row(evening, ticks(evening))?.state).toBe("fresh");
      const saturday = new Date("2026-11-07T16:00:00.000Z");
      expect(row(saturday, ticks(saturday))?.state).toBe("closed");
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

  it("lists net drift freshness per ticker as never, closed, stale and fresh, then the tape of the future", () => {
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
      expect.objectContaining({
        instrument: "SPY",
        source: "net_drift",
        state: "fresh",
      }),
      {
        ageSeconds: null,
        instrument: "ES",
        lastOkAt: null,
        message: null,
        source: "ticks",
        state: "never",
      },
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
    expect(stale.freshness.map((row) => row.state)).toEqual([
      "stale",
      "never",
      "never",
    ]);
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
      "Deep trades are single prints of at least 40 contracts on ES, from the streamed tape."
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
      agreementDetail: "the agreement is not tested as an entry rule yet",
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
      // Minutes 0 and 1 are covered; minute 2 has 30 covered seconds.
      expect(control.futures.inputs.rows).toBe(2);
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

    it("capture is streamed without a sampled row of the session; one sampled row makes it sampled", () => {
      const streamed = (row: FlowDeepTradeRow): FlowDeepTradeRow => ({
        ...row,
        capture: "streamed",
      });
      const capture = (largeTrades: FlowDeepTradeRow[]) =>
        buildFlowControl(rowsOf({ largeTrades })).deepTrades.capture;
      // No row: the tick mode of the future decides.
      for (const group of ["sp500", "nasdaq100"] as const)
        expect(buildFlowControl(rowsOf({ group })).deepTrades.capture).toBe(
          "streamed"
        );
      expect(
        capture([streamed(trade(1, "buy", 40)), streamed(trade(2, "buy", 40))])
      ).toBe("streamed");
      expect(
        capture([streamed(trade(1, "buy", 40)), trade(2, "buy", 40)])
      ).toBe("sampled");
      expect(capture([trade(1, "buy", 40), trade(2, "buy", 40)])).toBe(
        "sampled"
      );
      // A sampled row outside the session does not count.
      expect(
        capture([trade(-1, "buy", 40), streamed(trade(1, "buy", 40))])
      ).toBe("streamed");
      expect(flowCaptureOf("ES", [])).toBe("streamed");
      expect(flowCaptureOf("NQ", [])).toBe("streamed");
      expect(flowCaptureOf("ES", [trade(1, "buy", 40)])).toBe("sampled");
      // A symbol without a stream is sampled, with and without rows.
      expect(flowCaptureOf("SPY", [])).toBe("sampled");
      expect(flowCaptureOf("SPY", [streamed(trade(1, "buy", 40))])).toBe(
        "sampled"
      );
    });

    it("streamed notes name the streamed tape and count the deep trades of the session that the tick rule signed", () => {
      const control = buildFlowControl(
        rowsOf({
          largeTrades: [
            trade(-1, "buy", 40, "tick"),
            trade(1, "buy", 40, "tick"),
            trade(2, "buy", 40),
            trade(3, "sell", 40),
          ].map((row) => ({ ...row, capture: "streamed" as const })),
        })
      );
      expect(control.deepTrades.capture).toBe("streamed");
      expect(control.notes.slice(3, 7)).toEqual([
        "Deep trades are single prints of at least 40 contracts on ES, from the streamed tape.",
        "Each side comes from the quote rule against the quotes of the same contract; the tick rule signed 1 of 3 deep trades of this session.",
        "Session levels are from one-minute closes of SPX; on a half day the previous close is not the official close.",
        "Tape coverage counts the seconds between received trades of a live stream; it is not checked against a second source.",
      ]);
      expect(control.notes.join(" ")).not.toContain("sampled");
    });

    it("the sampled notes stay for a session with a sampled deep trade", () => {
      const control = buildFlowControl(
        rowsOf({
          largeTrades: [
            { ...trade(1, "buy", 40, "tick"), capture: "streamed" },
            trade(2, "buy", 40),
          ],
          sessionEvent: { calendar: "read", event: "fomc" },
        })
      );
      expect(control.deepTrades.capture).toBe("sampled");
      expect(control.notes.slice(3, 8)).toEqual([
        "Deep trades are single prints of at least 40 contracts on ES, from a sampled tape; sums are lower bounds.",
        "Futures sides come from the quote rule where the sampled quotes cover a print, else from the tick rule; a part of this session was sampled, so the sums of this session are lower bounds.",
        "Session levels are from one-minute closes of SPX; on a half day the previous close is not the official close.",
        "Coverage is approximate: it comes from flow_minutes.covered_seconds, which counts the edge seconds that deep-trade detection leaves out.",
        "FOMC meeting day (Federal Reserve calendar).",
      ]);
      expect(control.notes.join(" ")).not.toContain("streamed");
      expect(FlowControlSchema.parse(control)).toEqual(control);
    });

    it("coverage: share of the ended minutes of the trailing window, shorter window at the open, null without a tape minute, last stored minute after 16:00, empty before the first minute has ended", () => {
      const coverage = (now: Date, tape: FlowMinuteRow[]) =>
        buildFlowControl(rowsOf({ now, tape })).deepTrades.coverage;
      const seconds = (minute: number, more: number) =>
        new Date(at(minute).getTime() + more * 1000);
      const full = (start: number, end: number) =>
        Array.from({ length: end - start }, (_, index) =>
          tapeRow(start + index)
        );
      // At 10:30: the window holds the ended minutes 30..59; the minute in progress is left out.
      expect(
        coverage(at(60), [
          tapeRow(29),
          tapeRow(30),
          tapeRow(31, 20),
          tapeRow(60, 40),
        ])
      ).toEqual({ seenSeconds: 80, share: 80 / 1800, windowSeconds: 1800 });
      // A stream without a gap gives the share 1 at any second of the minute in progress.
      for (const now of [
        at(30),
        seconds(30, 5),
        seconds(30, 30),
        seconds(30, 59),
      ])
        expect(coverage(now, [...full(0, 30), tapeRow(30, 25)])).toEqual({
          seenSeconds: 1800,
          share: 1,
          windowSeconds: 1800,
        });
      expect(coverage(seconds(45, 30), full(0, 46))).toEqual({
        seenSeconds: 1800,
        share: 1,
        windowSeconds: 1800,
      });
      // Early session: 5 ended minutes give a window of 5 minutes.
      expect(coverage(seconds(5, 10), full(0, 5))).toEqual({
        seenSeconds: 300,
        share: 1,
        windowSeconds: 300,
      });
      // At 09:51: 21 ended minutes.
      expect(coverage(NOW, [tapeRow(0)])).toEqual({
        seenSeconds: 60,
        share: 60 / 1260,
        windowSeconds: 1260,
      });
      expect(coverage(NOW, [])).toEqual({
        seenSeconds: 0,
        share: null,
        windowSeconds: 1260,
      });
      // After 16:00: the last minute of the window is 15:59.
      expect(coverage(at(500), [tapeRow(389, 30), tapeRow(359)])).toEqual({
        seenSeconds: 30,
        share: 30 / 1800,
        windowSeconds: 1800,
      });
      // Before 09:30 and inside the first minute no minute has ended.
      for (const now of [at(-10), at(0), seconds(0, 30)])
        expect(coverage(now, [tapeRow(0)])).toEqual({
          seenSeconds: 0,
          share: null,
          windowSeconds: 1800,
        });
      // The first ended minute gives a window of one minute.
      expect(coverage(at(1), [tapeRow(0, 45)])).toEqual({
        seenSeconds: 45,
        share: 0.75,
        windowSeconds: 60,
      });
    });

    it("coverage: the window ends after the newest stored minute while it is at most 2 minutes behind; a larger delay shows as a gap", () => {
      const coverage = (now: Date, tape: FlowMinuteRow[]) =>
        buildFlowControl(rowsOf({ now, tape })).deepTrades.coverage;
      const seconds = (minute: number, more: number) =>
        new Date(at(minute).getTime() + more * 1000);
      const full = (start: number, end: number) =>
        Array.from({ length: end - start }, (_, index) =>
          tapeRow(start + index)
        );
      const whole = { seenSeconds: 1800, share: 1, windowSeconds: 1800 };
      // 59 full minutes are stored; the row of 10:29 is not stored yet.
      for (const second of [1, 30, 59])
        expect(coverage(seconds(60, second), full(0, 59))).toEqual(whole);
      // The newest stored minute is 2 minutes behind: the window ends after it (09:58 to 10:27).
      expect(coverage(seconds(60, 30), full(0, 58))).toEqual(whole);
      expect(
        coverage(seconds(60, 30), [
          tapeRow(27),
          ...full(28, 57),
          tapeRow(57, 30),
        ])
      ).toEqual({ seenSeconds: 1770, share: 1770 / 1800, windowSeconds: 1800 });
      // 3 and 4 minutes behind: the window ends after 10:29 and the missing minutes show.
      expect(coverage(seconds(60, 30), full(0, 57))).toEqual({
        seenSeconds: 1620,
        share: 0.9,
        windowSeconds: 1800,
      });
      expect(coverage(seconds(60, 30), full(0, 56))).toEqual({
        seenSeconds: 1560,
        share: 1560 / 1800,
        windowSeconds: 1800,
      });
      // Early session: 3 ended minutes, only 09:30 is stored; the window is that one minute.
      expect(coverage(seconds(3, 10), [tapeRow(0)])).toEqual({
        seenSeconds: 60,
        share: 1,
        windowSeconds: 60,
      });
      // No stored minute has ended: the window ends after the last ended minute.
      expect(coverage(seconds(2, 10), [tapeRow(2, 10)])).toEqual({
        seenSeconds: 0,
        share: 0,
        windowSeconds: 120,
      });
      expect(coverage(seconds(60, 30), [])).toEqual({
        seenSeconds: 0,
        share: null,
        windowSeconds: 1800,
      });
      // The last open minute: stored through 15:57, read at 15:59:30.
      expect(coverage(seconds(389, 30), full(350, 388))).toEqual(whole);
      // After the close the lag is measured against the clock minute, as during the session: the
      // 15:59 row that is not stored yet does not count as a gap.
      for (const now of [at(390), seconds(390, 30), seconds(391, 59)])
        expect(coverage(now, full(350, 389))).toEqual(whole);
      expect(coverage(at(390), full(350, 388))).toEqual(whole);
      // 3 minutes behind the clock is a gap: the window ends after 15:59.
      expect(coverage(at(390), full(350, 387))).toEqual({
        seenSeconds: 1620,
        share: 1620 / 1800,
        windowSeconds: 1800,
      });
      expect(coverage(seconds(391, 30), full(350, 388))).toEqual({
        seenSeconds: 1680,
        share: 1680 / 1800,
        windowSeconds: 1800,
      });
      // From 16:02 every row that is not stored shows as a gap.
      expect(coverage(at(392), full(350, 389))).toEqual({
        seenSeconds: 1740,
        share: 1740 / 1800,
        windowSeconds: 1800,
      });
      expect(coverage(at(395), full(350, 388))).toEqual({
        seenSeconds: 1680,
        share: 1680 / 1800,
        windowSeconds: 1800,
      });
      // A full day read at 16:05 gives the share 1.
      expect(coverage(at(395), full(350, 390))).toEqual(whole);
      expect(coverage(at(395), full(0, 390))).toEqual(whole);
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
