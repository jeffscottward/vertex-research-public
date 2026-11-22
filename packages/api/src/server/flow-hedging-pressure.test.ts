import { describe, expect, it } from "vitest";

import { FlowHedgingPressureSchema } from "../contracts/flow.ts";
import {
  HEDGING_READ_CAP,
  type HedgingPrint,
} from "../flow-hedging-pressure-rules.ts";
import {
  buildFlowHedgingPressure,
  type FlowHedgingPressureRows,
} from "./flow-hedging-pressure.ts";

// Friday 2026-11-20: 09:30 New York is 14:30 UTC (standard time).
const OPEN = new Date("2026-11-20T14:30:00.000Z");
const CLOSE = new Date("2026-11-20T21:15:00.000Z");
// 10:00 New York: the options session is open.
const NOW = new Date("2026-11-20T15:00:00.000Z");

const print = (tradedAt: Date, overrides: Partial<HedgingPrint> = {}) =>
  ({
    dte: 10,
    iv: 20,
    right: "call",
    side: "ask",
    size: 10,
    strike: 660,
    tradedAt,
    underlyingPrice: 660,
    ...overrides,
  }) satisfies HedgingPrint;

const rowsOf = (
  overrides: Partial<FlowHedgingPressureRows> = {}
): FlowHedgingPressureRows => ({
  gaps: [],
  latest: [],
  latestOk: [],
  now: NOW,
  prints: [],
  session: "2026-11-20",
  symbol: "SPY",
  ...overrides,
});
const minutes = (count: number) => new Date(OPEN.getTime() + count * 60_000);

describe("buildFlowHedgingPressure", () => {
  it("answers a symbol without a stored print with no session, no points and zero totals", () => {
    const response = buildFlowHedgingPressure(
      rowsOf({ prints: [print(minutes(1))], session: null, symbol: "ES" })
    );
    expect(FlowHedgingPressureSchema.parse(response)).toEqual(response);
    expect(response).toMatchObject({
      points: [],
      schemaVersion: "flow-hedging-pressure.v1",
      session: null,
      storedUntil: null,
      symbol: "ES",
      ticker: "SPX",
      truncated: false,
      unread: null,
    });
    expect(response.totals).toMatchObject({
      gross: 0,
      net: 0,
      prints: 0,
      signed: 0,
    });
    expect(response.options).toMatchObject({
      lastOkAt: null,
      source: "options",
      state: "never",
    });
  });

  it("folds the session's prints with the rules and the options freshness", () => {
    const response = buildFlowHedgingPressure(
      rowsOf({
        latest: [
          {
            at: new Date(NOW.getTime() - 30_000),
            items: 4,
            message: "quantdata flow: 4 prints",
            source: "options",
            status: "ok",
            symbol: "SPY",
          },
        ],
        latestOk: [
          {
            at: new Date(NOW.getTime() - 30_000),
            items: 4,
            message: "quantdata flow: 4 prints",
            source: "options",
            status: "ok",
            symbol: "SPY",
          },
        ],
        prints: [
          // Before 09:30 and at 16:15: outside the session, not counted.
          print(new Date(OPEN.getTime() - 1)),
          print(minutes(0)),
          print(minutes(2), { side: "mid" }),
          print(CLOSE),
        ],
      })
    );
    expect(FlowHedgingPressureSchema.parse(response)).toEqual(response);
    expect(response).toMatchObject({
      rules: {
        dividendYield: 0.015,
        rate: 0.04,
        version: "hedging-pressure.v1",
        volFallback: 0.2,
      },
      session: "2026-11-20",
      storedUntil: OPEN.toISOString(),
      ticker: "SPY",
      truncated: false,
    });
    expect(response.totals).toMatchObject({ notSigned: 1, prints: 2 });
    expect(response.points.map((point) => point.minute)).toEqual([
      OPEN.toISOString(),
    ]);
    expect(response.options).toMatchObject({ ageSeconds: 30, state: "fresh" });
  });

  it("drops the newest prints beyond the read cap and marks the response truncated", () => {
    const capped = new Array<HedgingPrint>(HEDGING_READ_CAP).fill(
      print(minutes(0))
    );
    const exact = buildFlowHedgingPressure(rowsOf({ prints: capped }));
    expect(exact.truncated).toBe(false);
    expect(exact.totals.prints).toBe(HEDGING_READ_CAP);

    const response = buildFlowHedgingPressure(
      rowsOf({ prints: [...capped, print(minutes(5))] })
    );
    expect(response.truncated).toBe(true);
    expect(response.totals.prints).toBe(HEDGING_READ_CAP);
    expect(response.storedUntil).toBe(OPEN.toISOString());
    expect(response.points).toHaveLength(1);
  });

  it("gives no unread span when every gap is outside the session", () => {
    const response = buildFlowHedgingPressure(
      rowsOf({
        gaps: [
          // Ends at 09:30: no overlap with [09:30, 16:15).
          { endTime: OPEN, startTime: new Date(OPEN.getTime() - 3_600_000) },
          // Starts at 16:15.
          { endTime: new Date(CLOSE.getTime() + 60_000), startTime: CLOSE },
          // The day before.
          {
            endTime: new Date("2026-11-19T16:00:00.000Z"),
            startTime: new Date("2026-11-19T15:00:00.000Z"),
          },
        ],
      })
    );
    expect(response.unread).toBeNull();
  });

  it("clips overlapping gaps to the session and spans the gaps inside it", () => {
    const overlapping = buildFlowHedgingPressure(
      rowsOf({
        gaps: [
          {
            endTime: new Date(CLOSE.getTime() + 3_600_000),
            startTime: minutes(400),
          },
          {
            endTime: minutes(10),
            startTime: new Date(OPEN.getTime() - 3_600_000),
          },
        ],
      })
    );
    expect(overlapping.unread).toEqual({
      from: OPEN.toISOString(),
      ranges: 2,
      to: CLOSE.toISOString(),
    });

    const inside = buildFlowHedgingPressure(
      rowsOf({
        gaps: [
          { endTime: minutes(60), startTime: minutes(30) },
          { endTime: minutes(130), startTime: minutes(120) },
          {
            endTime: new Date("2026-11-19T16:00:00.000Z"),
            startTime: new Date("2026-11-19T15:00:00.000Z"),
          },
        ],
      })
    );
    expect(inside.unread).toEqual({
      from: minutes(30).toISOString(),
      ranges: 2,
      to: minutes(130).toISOString(),
    });
  });

  it.each([
    // The Monday after the March change: daylight time, 09:30 New York is 13:30 UTC.
    ["2026-03-09", "2026-03-09T13:30:00.000Z", "2026-03-09T20:15:00.000Z"],
    // The Monday after the November change: standard time, 09:30 New York is 14:30 UTC.
    ["2026-11-02", "2026-11-02T14:30:00.000Z", "2026-11-02T21:15:00.000Z"],
  ])("uses the New York session range of %s", (session, open, close) => {
    const from = new Date(open);
    const to = new Date(close);
    const response = buildFlowHedgingPressure(
      rowsOf({
        gaps: [
          {
            endTime: new Date(to.getTime() + 60_000),
            startTime: new Date(from.getTime() - 60_000),
          },
        ],
        now: new Date(to.getTime() + 3_600_000),
        prints: [
          print(new Date(from.getTime() - 1)),
          print(from),
          print(new Date(to.getTime() - 1)),
          print(to),
        ],
        session,
      })
    );
    expect(response.totals.prints).toBe(2);
    expect(response.points.map((point) => point.minute)).toEqual([
      from.toISOString(),
      new Date(to.getTime() - 60_000).toISOString(),
    ]);
    expect(response.unread).toEqual({ from: open, ranges: 1, to: close });
  });
});
