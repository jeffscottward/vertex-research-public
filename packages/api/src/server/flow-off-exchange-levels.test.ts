import { describe, expect, it } from "vitest";
import {
  FLOW_OFF_EXCHANGE_LEVELS_VERSION,
  FlowOffExchangeLevelsSchema,
} from "../contracts/flow.ts";
import { OFF_EXCHANGE_LEVELS_RULES } from "../flow-off-exchange-levels-rules.ts";
import {
  buildFlowOffExchangeLevels,
  offExchangeFinraFromDate,
  offExchangeWindowRange,
  shiftCalendarDate,
} from "./flow-off-exchange-levels.ts";

describe("flow-off-exchange-levels helpers", () => {
  it("computes calendar date shifts and NY regular-session query ranges", () => {
    expect(shiftCalendarDate("2026-11-20", 0)).toBe("2026-11-20");
    expect(shiftCalendarDate("2026-11-20", 7)).toBe("2026-11-13");
    expect(offExchangeFinraFromDate("2026-11-20")).toBe("2026-07-23");

    const oneDay = offExchangeWindowRange("2026-11-20", "1d");
    expect(oneDay.from.toISOString()).toBe("2026-11-20T14:30:00.000Z");
    expect(oneDay.to.toISOString()).toBe("2026-11-20T21:00:00.000Z");

    const fiveDay = offExchangeWindowRange("2026-11-20", "5d");
    expect(fiveDay.from.toISOString()).toBe("2026-11-13T14:30:00.000Z");
    expect(fiveDay.to.toISOString()).toBe("2026-11-20T21:00:00.000Z");

    const fourteenDay = offExchangeWindowRange("2026-11-20", "14d");
    expect(fourteenDay.from.toISOString()).toBe("2026-11-07T14:30:00.000Z");
    expect(fourteenDay.to.toISOString()).toBe("2026-11-20T21:00:00.000Z");
  });

  it("assembles a full populated document and validates against FlowOffExchangeLevelsSchema", () => {
    const now = new Date("2026-11-20T15:05:00.000Z");
    const window = offExchangeWindowRange("2026-11-20", "5d");
    const doc = buildFlowOffExchangeLevels({
      anchorSession: "2026-11-20",
      events: [
        {
          at: new Date("2026-11-20T14:35:10.000Z"),
          direction: "bullish",
          key: "print:1:592.4:25000:FINRA",
          price: 592.4,
          size: 25_000,
        },
      ],
      finraRows: [
        {
          lastUpdated: "2026-11-02",
          shares: 38_400_000,
          tier: "NMS_TIER_1",
          trades: 240_000,
          venue: "ats",
          weekStart: "2026-10-19",
        },
        {
          lastUpdated: "2026-11-02",
          shares: 92_100_000,
          tier: "NMS_TIER_1",
          trades: 610_000,
          venue: "non_ats",
          weekStart: "2026-10-19",
        },
      ],
      latest: [
        {
          at: new Date("2026-11-20T15:04:00.000Z"),
          items: 1000,
          message: "ok",
          source: "ticks",
          status: "ok",
          symbol: "SPY",
        },
      ],
      latestOk: [
        {
          at: new Date("2026-11-20T15:04:00.000Z"),
          items: 1000,
          message: "ok",
          source: "ticks",
          status: "ok",
          symbol: "SPY",
        },
      ],
      minutes: [
        {
          close: 592.5,
          coveredSeconds: 60,
          high: 592.6,
          low: 592.2,
          minute: new Date("2026-11-20T14:35:00.000Z"),
          offExchangeVolume: 40_000,
          open: 592.3,
          volume: 100_000,
          vwap: 592.45,
        },
      ],
      now,
      range: "5d",
      symbol: "SPY",
      truncated: false,
      windowEnd: window.to,
      windowStart: window.from,
    });

    expect(FlowOffExchangeLevelsSchema.parse(doc)).toEqual(doc);
    expect(doc.schemaVersion).toBe(FLOW_OFF_EXCHANGE_LEVELS_VERSION);
    expect(doc.rules).toEqual(OFF_EXCHANGE_LEVELS_RULES);
    expect(doc.levels).toHaveLength(1);
    expect(doc.finraWeekly).toHaveLength(1);
    expect(doc.ticks.state).toBe("fresh");
  });

  it("assembles an empty document when anchorSession is null while keeping FINRA weekly context", () => {
    const doc = buildFlowOffExchangeLevels({
      anchorSession: null,
      events: [],
      finraRows: [
        {
          lastUpdated: "2026-11-02",
          shares: 20_000_000,
          tier: "NMS_TIER_1",
          trades: 100_000,
          venue: "ats",
          weekStart: "2026-10-19",
        },
      ],
      latest: [],
      latestOk: [],
      minutes: [],
      now: new Date("2026-11-20T15:05:00.000Z"),
      range: "1d",
      symbol: "SPY",
      truncated: false,
      windowEnd: null,
      windowStart: null,
    });

    expect(FlowOffExchangeLevelsSchema.parse(doc)).toEqual(doc);
    expect(doc.anchorSession).toBeNull();
    expect(doc.windowStart).toBeNull();
    expect(doc.windowEnd).toBeNull();
    expect(doc.bars).toEqual([]);
    expect(doc.levels).toEqual([]);
    expect(doc.finraWeekly).toHaveLength(1);
    expect(doc.ticks.state).toBe("never");
  });
});
