import { describe, expect, it } from "vitest";

import {
  FLOW_PUT_CALL_RATIO_MAX_DAYS,
  FlowPutCallRatioSchema,
} from "../contracts/flow.ts";
import { PUT_CALL_RATIO_RULES } from "../flow-put-call-ratio-rules.ts";
import {
  buildFlowPutCallRatio,
  type FlowPutCallRatioRows,
} from "./flow-put-call-ratio.ts";

// Friday 2026-11-20 10:00 New York (EST = UTC-5).
const NOW = new Date("2026-11-20T15:00:00.000Z");
const OPEN = new Date("2026-11-20T14:30:00.000Z");
const CLOSE = new Date("2026-11-20T21:15:00.000Z");

const okSample = {
  at: new Date("2026-11-20T14:59:30.000Z"),
  items: 12,
  message: "quantdata flow: 12 prints",
  source: "options" as const,
  status: "ok" as const,
  symbol: "SPY" as const,
};

const baseRows = (
  overrides: Partial<FlowPutCallRatioRows> = {}
): FlowPutCallRatioRows => ({
  days: [],
  gaps: [],
  latest: [okSample],
  latestOk: [okSample],
  minutes: [],
  now: NOW,
  session: "2026-11-20",
  symbol: "SPY",
  ...overrides,
});

describe("buildFlowPutCallRatio", () => {
  it("returns an empty response when no option print is stored (session is null)", () => {
    const response = buildFlowPutCallRatio(
      baseRows({
        days: [
          {
            callPremium: 100_000,
            callPrints: 1,
            callVolume: 10,
            lastPrice: 660,
            putPremium: 100_000,
            putPrints: 1,
            putVolume: 10,
            session: "2026-11-19",
          },
        ],
        gaps: [{ endTime: NOW, startTime: OPEN }],
        latest: [],
        latestOk: [],
        session: null,
        symbol: "ES",
      })
    );
    expect(FlowPutCallRatioSchema.parse(response)).toEqual(response);
    expect(response).toMatchObject({
      days: [],
      options: { state: "never" },
      points: [],
      rules: PUT_CALL_RATIO_RULES,
      schemaVersion: "flow-put-call-ratio.v1",
      session: null,
      storedUntil: null,
      symbol: "ES",
      ticker: "SPX",
      unread: null,
    });
    expect(response.totals.prints).toBe(0);
  });

  it("filters out-of-session minutes, clips overlapping gaps to the session, and flags incomplete days", () => {
    const response = buildFlowPutCallRatio(
      baseRows({
        days: [
          {
            callPremium: 1_000_000,
            callPrints: 10,
            callVolume: 1000,
            lastPrice: 660.1,
            putPremium: 900_000,
            putPrints: 9,
            putVolume: 850,
            session: "2026-11-19",
          },
          {
            callPremium: 500_000,
            callPrints: 5,
            callVolume: 500,
            lastPrice: 661.4,
            putPremium: 600_000,
            putPrints: 6,
            putVolume: 650,
            session: "2026-11-20",
          },
        ],
        gaps: [
          // Unrelated gap before 2026-11-19
          {
            endTime: new Date("2026-11-18T16:00:00.000Z"),
            startTime: new Date("2026-11-18T15:00:00.000Z"),
          },
          // Gap straddling Friday open -> clipped to OPEN
          {
            endTime: new Date("2026-11-20T14:40:00.000Z"),
            startTime: new Date("2026-11-20T14:00:00.000Z"),
          },
          // Gap straddling Friday close -> clipped to CLOSE
          {
            endTime: new Date("2026-11-20T22:00:00.000Z"),
            startTime: new Date("2026-11-20T21:00:00.000Z"),
          },
        ],
        minutes: [
          // Pre-open: excluded
          {
            callPremium: 999_000,
            callPrints: 9,
            callVolume: 999,
            lastPrice: 659,
            lastTradedAt: new Date(OPEN.getTime() - 10_000),
            minute: new Date(OPEN.getTime() - 60_000),
            putPremium: 999_000,
            putPrints: 9,
            putVolume: 999,
          },
          // In-session
          {
            callPremium: 500_000,
            callPrints: 5,
            callVolume: 500,
            lastPrice: 661.4,
            lastTradedAt: new Date(OPEN.getTime() + 30_000),
            minute: OPEN,
            putPremium: 600_000,
            putPrints: 6,
            putVolume: 650,
          },
          // At close: end-exclusive, excluded
          {
            callPremium: 999_000,
            callPrints: 9,
            callVolume: 999,
            lastPrice: 665,
            lastTradedAt: CLOSE,
            minute: CLOSE,
            putPremium: 0,
            putPrints: 0,
            putVolume: 0,
          },
        ],
      })
    );
    expect(FlowPutCallRatioSchema.parse(response)).toEqual(response);
    expect(response.points).toHaveLength(1);
    expect(response.totals.premiumRatio).toBe(1.2);
    expect(response.totals.volumeRatio).toBe(1.3);
    expect(response.unread).toEqual({
      from: OPEN.toISOString(),
      ranges: 2,
      to: CLOSE.toISOString(),
    });
    expect(
      response.days.map((day) => ({
        incomplete: day.incomplete,
        session: day.session,
      }))
    ).toEqual([
      { incomplete: false, session: "2026-11-19" },
      { incomplete: true, session: "2026-11-20" },
    ]);
  });

  it("caps days to the newest FLOW_PUT_CALL_RATIO_MAX_DAYS sessions and sets unread null when no gap overlaps", () => {
    const manyDays = Array.from(
      { length: FLOW_PUT_CALL_RATIO_MAX_DAYS + 3 },
      (_, index) => ({
        callPremium: 100_000,
        callPrints: 1,
        callVolume: 10,
        lastPrice: 660 + index,
        putPremium: 100_000,
        putPrints: 1,
        putVolume: 10,
        session: `2026-10-${String(index + 1).padStart(2, "0")}`,
      })
    );
    const response = buildFlowPutCallRatio(baseRows({ days: manyDays }));
    expect(FlowPutCallRatioSchema.parse(response)).toEqual(response);
    expect(response.days).toHaveLength(FLOW_PUT_CALL_RATIO_MAX_DAYS);
    expect(response.days[0]?.session).toBe("2026-10-04");
    expect(response.unread).toBeNull();
  });
});
