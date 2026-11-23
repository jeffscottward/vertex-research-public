import {
  FLOW_TAPE_SPEED_RULES,
  FlowEventsOutputSchema,
  FlowHedgingPressureSchema,
  FlowTapeSpeedSchema,
  HEDGING_PRESSURE_RULES,
  MarketBarsOutputSchema,
  MarketDepthOutputSchema,
  MarketTicksOutputSchema,
  OptionsAnalyticsOutputSchema,
} from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  createSeededRandom,
  hashSeed,
  LAB_ACCOUNT,
  LAB_NOW_ISO,
  LAB_TICKERS,
  labBasePrice,
  labDaysAgo,
  labMinutesAgo,
  labReadOnly,
  roundTo,
} from "./core.ts";
import { labFlowHedgingPressure, labFlowTapeSpeed } from "./flow.ts";
import {
  labBars,
  labBarsOutput,
  labDepthEntitlementError,
  labDepthOutput,
  labFlowEventsOutput,
  labOptionsAnalytics,
  labTicksOutput,
} from "./market.ts";

describe("lab fixture core", () => {
  it("gives the same random sequence for the same seed", () => {
    const first = createSeededRandom("seed");
    const second = createSeededRandom("seed");
    const other = createSeededRandom("other");
    const a = [first(), first(), first()];
    expect([second(), second(), second()]).toEqual(a);
    expect(other()).not.toBe(a[0]);
    for (const value of a) {
      expect(value).toBeGreaterThan(0);
      expect(value).toBeLessThan(1);
    }
    expect(hashSeed("")).toBe(8);
  });

  it("uses a fictional account and fixed clock", () => {
    expect(LAB_ACCOUNT.name).toBe("Demo Capital");
    expect(LAB_TICKERS).toContain("NVDA");
    expect(LAB_NOW_ISO).toBe("2026-10-30T20:00:00.000Z");
    expect(labDaysAgo(1)).toBe("2026-10-29");
    expect(labMinutesAgo(60)).toBe("2026-10-30T19:00:00.000Z");
    expect(roundTo(1.234_56)).toBe(1.23);
    expect(roundTo(1.5, 0)).toBe(2);
  });

  it("prices known and unknown tickers deterministically", () => {
    expect(labBasePrice("NVDA")).toBe(138.2);
    expect(labBasePrice("ZZZZ")).toBe(labBasePrice("ZZZZ"));
    expect(labBasePrice("ZZZZ")).toBeGreaterThanOrEqual(20);
  });

  it("rejects write calls", async () => {
    await expect(labReadOnly()).rejects.toThrow("dummy data only");
  });
});

describe("lab market fixtures", () => {
  it("builds the same valid bars every time", () => {
    const first = labBarsOutput({ symbol: "nvda" });
    expect(labBarsOutput({ symbol: "NVDA" })).toEqual(first);
    expect(MarketBarsOutputSchema.parse(first)).toEqual(first);
    expect(first.count).toBe(250);
    expect(first.request).toMatchObject({
      barSize: "1 day",
      exchange: "SMART",
      secType: "STK",
      symbol: "NVDA",
    });
    for (const bar of first.bars) {
      expect(bar.h).toBeGreaterThanOrEqual(Math.max(bar.o, bar.c));
      expect(bar.l).toBeLessThanOrEqual(Math.min(bar.o, bar.c));
    }
  });

  it("follows the requested bar size and contract", () => {
    const output = labBarsOutput({
      barSize: "1 hour",
      contractMonth: "202612",
      currency: "USD",
      duration: "1 M",
      exchange: "CME",
      secType: "FUT",
      symbol: "ES",
      useRTH: false,
      whatToShow: "MIDPOINT",
    });
    expect(output.count).toBe(400);
    expect(output.bars[1]?.t).toBe((output.bars[0]?.t ?? 0) + 3600);
    expect(output.request).toMatchObject({
      contractMonth: "202612",
      exchange: "CME",
      secType: "FUT",
      useRTH: false,
    });
    expect(labBars("SPY", 3, "5 mins")).toHaveLength(3);
    const weekdays = labBars("SPY", 30).map((bar) =>
      new Date(bar.t * 1000).getUTCDay()
    );
    expect(weekdays).not.toContain(0);
    expect(weekdays).not.toContain(6);
  });

  it("builds a valid options snapshot for cheap and expensive tickers", () => {
    for (const symbol of ["SPY", "NVDA", "SLV"]) {
      const snapshot = labOptionsAnalytics(symbol);
      expect(OptionsAnalyticsOutputSchema.parse(snapshot)).toEqual(snapshot);
      expect(labOptionsAnalytics(symbol)).toEqual(snapshot);
    }
    expect(labOptionsAnalytics("SPY", 6).flow.hours).toBe(6);
  });
});

describe("lab order flow fixtures", () => {
  it("builds valid, deterministic fictional prints and quotes", () => {
    const ticks = labTicksOutput({ symbol: "nvda" });
    expect(labTicksOutput({ symbol: "NVDA" })).toEqual(ticks);
    expect(MarketTicksOutputSchema.parse(ticks)).toEqual(ticks);
    expect(ticks.trades).toHaveLength(500);
    expect(ticks.quotes.length).toBeGreaterThan(0);
    // The first prints come before the first quote.
    expect(ticks.quotes[0]?.t ?? 0).toBeGreaterThan(ticks.trades[0]?.t ?? 0);
    expect(new Set(ticks.trades.map((trade) => trade.x))).toEqual(
      new Set(["LAB-A", "LAB-B"])
    );
    expect(ticks.contract.longName).toContain("fake data");
    const futures = labTicksOutput({
      count: 100,
      exchange: "CME",
      quotes: false,
      secType: "FUT",
      symbol: "ES",
    });
    expect(MarketTicksOutputSchema.parse(futures).trades).toHaveLength(100);
    expect(futures.quotes).toEqual([]);
    for (const trade of futures.trades) {
      expect((trade.p * 4) % 1).toBe(0);
      expect(trade.x).toBeNull();
    }
  });

  it("builds a valid SMART book with a venue notice and a single-exchange futures book", () => {
    const depth = labDepthOutput({ symbol: "SPY" });
    expect(MarketDepthOutputSchema.parse(depth)).toEqual(depth);
    expect(depth.bids).toHaveLength(10);
    expect(depth.asks[0]?.price ?? 0).toBeGreaterThan(
      depth.bids[0]?.price ?? 0
    );
    expect(depth).toMatchObject({
      request: { smartDepth: true },
      sizeMultiplier: 100,
      venues: { missing: ["LAB-D"] },
    });
    const futures = labDepthOutput({
      exchange: "CME",
      rows: 5,
      secType: "FUT",
      symbol: "ES",
    });
    expect(MarketDepthOutputSchema.parse(futures).asks).toHaveLength(5);
    expect(futures).toMatchObject({ sizeMultiplier: 1, venues: null });
    expect(labDepthEntitlementError()).toMatchObject({ code: "ENTITLEMENT" });
  });

  it("builds valid fictional stored flow_events with and without a kind filter", () => {
    const all = labFlowEventsOutput({
      from: "2026-10-30T14:00:00.000Z",
      symbol: "SPY",
      to: "2026-10-30T20:00:00.000Z",
    });
    expect(FlowEventsOutputSchema.parse(all).events).toHaveLength(4);
    const onlyAbs = labFlowEventsOutput({
      from: "2026-10-30T14:00:00.000Z",
      kinds: ["absorption"],
      symbol: "ES",
      to: "2026-10-30T20:00:00.000Z",
    });
    expect(FlowEventsOutputSchema.parse(onlyAbs).events).toHaveLength(2);
    expect(onlyAbs.events.every((event) => event.kind === "absorption")).toBe(
      true
    );
  });
});

describe("lab flow tape speed", () => {
  const WINDOWS = [
    [60, 10, 366],
    [120, 20, 363],
    [240, 60, 241],
    [390, 60, 391],
  ] as const;

  it.each(WINDOWS)(
    "ES with %i minutes: %i s bars, %i of them, three bursts and every bar state of a live tape",
    (minutes, bucket, count) => {
      const document = labFlowTapeSpeed("ES", minutes);
      expect(FlowTapeSpeedSchema.parse(document)).toEqual(document);
      expect(document.bucketSeconds).toBe(bucket);
      expect(document.bars).toHaveLength(count);
      expect(document.rules).toEqual(FLOW_TAPE_SPEED_RULES);
      expect(document.totals.bursts).toBe(3);
      expect(document.bursts).toHaveLength(3);
      const marked = document.bars.flatMap((bar, index) =>
        bar.burstSeconds > 0 ? [index] : []
      );
      expect(marked).toEqual([3, 90, 91, count - 40]);
      // The second burst starts in the last second of bar 90.
      expect(Date.parse(document.bursts[1]?.start ?? "")).toBe(
        Date.parse(document.bars[91]?.start ?? "") - 1000
      );
      expect(document.bars[130]?.state).toBe("no_data");
      expect(document.bars[172]).toMatchObject({
        coveredSeconds: 7,
        state: "counted",
      });
      // The newest minute of the axis is not stored yet.
      expect(document.bars.at(-1)?.state).toBe("no_data");
      expect(document.storedUntil).toBe(
        new Date(
          Date.parse(document.axisStart) + (count * bucket - 60) * 1000
        ).toISOString()
      );
      expect(Math.max(...document.bars.map((bar) => bar.peakTrades))).toBe(
        2740
      );
      expect(document.tape.state).toBe("fresh");
      expect(document.totals.evaluatedSeconds).toBe(
        document.totals.coveredSeconds
      );
      // A bar that can exist: its busiest second is never above its total.
      for (const bar of document.bars) {
        expect(bar.peakTrades).toBeLessThanOrEqual(bar.trades);
        expect(bar.peakContracts).toBeLessThanOrEqual(bar.contracts);
      }
    }
  );

  it.each(WINDOWS.slice(0, 3))(
    "NQ with %i minutes: not recorded, then covered without a trade, then quiet, with a write fault",
    (minutes, bucket, count) => {
      const document = labFlowTapeSpeed("NQ", minutes);
      expect(FlowTapeSpeedSchema.parse(document)).toEqual(document);
      expect(document.bars).toHaveLength(count);
      const third = Math.floor((count - 60 / bucket) / 3);
      expect(document.bars[0]?.state).toBe("not_recorded");
      expect(document.bars[third - 1]?.state).toBe("not_recorded");
      expect(document.bars[third]).toMatchObject({
        coveredSeconds: bucket,
        state: "counted",
        trades: 0,
      });
      expect(document.bars[2 * third]?.trades).toBeGreaterThan(0);
      expect(document.bars.at(-1)?.state).toBe("no_data");
      expect(document.bursts).toEqual([]);
      expect(
        document.totals.coveredSeconds - document.totals.evaluatedSeconds
      ).toBe(600);
      expect(document.tape.state).toBe("stale");
      expect(document.tape.message).toContain(
        "; per-second counts not stored (Error 42501)"
      );
      expect(document.tape.message?.length).toBeLessThanOrEqual(300);
      expect(document.contract).toBe("NQZ6");
    }
  );

  it("NQ with 390 minutes: nothing stored", () => {
    const document = labFlowTapeSpeed("NQ", 390);
    expect(FlowTapeSpeedSchema.parse(document)).toEqual(document);
    expect(document.bars).toHaveLength(391);
    expect(document.bars.every((bar) => bar.state === "no_data")).toBe(true);
    expect(document).toMatchObject({
      bursts: [],
      contract: null,
      storedUntil: null,
      tape: { state: "never" },
      totals: { bursts: 0, coveredSeconds: 0, evaluatedSeconds: 0 },
    });
  });
});

describe("lab flow hedging pressure", () => {
  it("SPY: a valid response that rises, then falls, with one open gap and no point inside it", () => {
    const response = labFlowHedgingPressure("SPY");
    expect(FlowHedgingPressureSchema.parse(response)).toEqual(response);
    expect(response.rules).toEqual(HEDGING_PRESSURE_RULES);
    expect(response).toMatchObject({
      session: "2026-10-30",
      symbol: "SPY",
      ticker: "SPY",
      truncated: false,
    });
    const nets = response.points.map((point) => point.net);
    const top = Math.max(...nets);
    const peak = nets.indexOf(top);
    expect(peak).toBeGreaterThan(0);
    expect(peak).toBeLessThan(nets.length - 1);
    expect(nets.at(-1)).toBeLessThan(top);
    expect(response.totals.largestRise?.minuteNet).toBeGreaterThan(0);
    expect(response.totals.largestFall?.minuteNet).toBeLessThan(0);
    const { unread } = response;
    if (unread === null) throw new Error("no unread span");
    expect(unread.ranges).toBe(1);
    expect(
      response.points.filter(
        (point) => point.minute >= unread.from && point.minute < unread.to
      )
    ).toEqual([]);
    expect(response.totals).toMatchObject({
      ivAdjusted: 0,
      notPriced: 0,
      notSigned: 0,
    });
    expect(response.totals.net).toBe(nets.at(-1));
    expect(response.storedUntil).toBe("2026-10-30T19:59:41.000Z");
  });

  it("ES: SPX options with prints that are not signed, not priced or IV adjusted, and no gap", () => {
    const response = labFlowHedgingPressure("ES");
    expect(FlowHedgingPressureSchema.parse(response)).toEqual(response);
    expect(response).toMatchObject({
      symbol: "ES",
      ticker: "SPX",
      unread: null,
    });
    const { totals } = response;
    expect(totals.notSigned).toBeGreaterThan(0);
    expect(totals.notPriced).toBeGreaterThan(0);
    expect(totals.ivAdjusted).toBeGreaterThan(0);
    const counted = response.points.reduce(
      (sum, point) => sum + point.prints,
      0
    );
    expect(totals.signed).toBe(counted + totals.notPriced);
    expect(totals.prints).toBe(totals.signed + totals.notSigned);
    expect(totals.gross).toBeGreaterThanOrEqual(Math.abs(totals.net));
  });
});
