import {
  FLOW_TAPE_SPEED_RULES,
  FlowEventsOutputSchema,
  FlowHedgingPressureSchema,
  FlowLiveDomSchema,
  FlowOptionBubblesSchema,
  FlowPutCallRatioSchema,
  FlowStrikeHeatmapSchema,
  FlowTapeSpeedSchema,
  FlowTradeBubblesSchema,
  HEDGING_PRESSURE_RULES,
  MarketBarsOutputSchema,
  MarketDepthOutputSchema,
  MarketTicksOutputSchema,
  OPTION_BUBBLES_RULES,
  OpenbbIvHistoryOutputSchema,
  OpenbbMacroOutputSchema,
  OptionsAnalyticsOutputSchema,
  PUT_CALL_RATIO_RULES,
  STRIKE_HEATMAP_RULES,
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
import {
  labFlowHedgingPressure,
  labFlowLiveDom,
  labFlowLiveDomStream,
  labFlowOptionBubbles,
  labFlowPutCallRatio,
  labFlowStrikeHeatmap,
  labFlowTapeSpeed,
  labFlowTradeBubbles,
} from "./flow.ts";
import {
  labBars,
  labBarsOutput,
  labDepthEntitlementError,
  labDepthOutput,
  labFlowEventsOutput,
  labIvHistory,
  labMacroOutput,
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

  it("stores made-up open-interest figures on daily bar dates, without the newest bar", () => {
    const output = labMacroOutput("2026-01-01", ["CME_ES_OI", "CME_NQ_OI"]);
    expect(labMacroOutput("2026-01-01", ["CME_ES_OI", "CME_NQ_OI"])).toEqual(
      output
    );
    expect(OpenbbMacroOutputSchema.parse(output)).toEqual(output);
    expect(output.series.map((series) => series.id)).toEqual([
      "CME_ES_OI",
      "CME_NQ_OI",
    ]);
    const barDates = new Set(
      labBars("ES").map((bar) =>
        new Date(bar.t * 1000).toISOString().slice(0, 10)
      )
    );
    const [es] = output.series;
    expect(es?.pointCount).toBe(179);
    expect(es?.lastDate).toBe("2026-10-29");
    for (const point of es?.points ?? []) {
      expect(barDates.has(point.date)).toBe(true);
      expect(Number.isInteger(point.value)).toBe(true);
    }
    // One trading day inside the range has no figure.
    expect(es?.points.some((point) => point.date === "2026-10-14")).toBe(false);
    expect(es?.points.some((point) => point.date === "2026-10-13")).toBe(true);
  });

  it("limits the figures to the from-date and to the known series", () => {
    const [es] = labMacroOutput("2026-10-01", ["CME_ES_OI"]).series;
    expect(es?.points[0]?.date).toBe("2026-10-01");
    expect((es?.firstDate ?? "9999") < "2026-10-01").toBe(true);
    expect(labMacroOutput("2026-10-01", ["DGS10"]).series).toEqual([]);
    expect(labMacroOutput("2026-10-01")).toEqual({
      from: "2026-10-01",
      series: [],
    });
  });

  it("quotes CASH pairs on MIDPOINT without volume", () => {
    const output = labBarsOutput({ secType: "CASH", symbol: "EUR" });
    expect(output.request.whatToShow).toBe("MIDPOINT");
    expect(output.bars.every((bar) => bar.v === null)).toBe(true);
    expect(MarketBarsOutputSchema.parse(output)).toEqual(output);
    expect(labBarsOutput({ symbol: "SPY" }).bars[0]?.v).toBeGreaterThan(0);
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
      // The strike profiles mark max pain at the smallest holder payout.
      const payouts = snapshot.strikeProfiles.strikes.map(
        (row) => row.holderPayout
      );
      const smallest = snapshot.strikeProfiles.strikes.find(
        (row) => row.holderPayout === Math.min(...payouts)
      );
      expect(snapshot.exposure.maxPain).toBe(smallest?.strike);
      expect(snapshot.strikeProfiles.flow.trades).toBe(
        snapshot.flow.events.length
      );
      const times = snapshot.flow.events.map((event) => event.time).sort();
      expect([
        snapshot.strikeProfiles.flow.oldestTradeAt,
        snapshot.strikeProfiles.flow.newestTradeAt,
      ]).toEqual([times[0], times.at(-1)]);
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

describe("lab flow put/call ratio", () => {
  it("SPY: starts below parity, ends above parity, has 8 stored sessions and one open gap", () => {
    const response = labFlowPutCallRatio("SPY");
    expect(FlowPutCallRatioSchema.parse(response)).toEqual(response);
    expect(response.rules).toEqual(PUT_CALL_RATIO_RULES);
    expect(response).toMatchObject({
      session: "2026-10-30",
      symbol: "SPY",
      ticker: "SPY",
    });
    expect(response.points[0]?.premiumRatio).toBeLessThan(1);
    expect(response.totals.premiumRatio).toBeGreaterThan(1);
    expect(response.days).toHaveLength(8);
    expect(response.days.at(-1)?.incomplete).toBe(true);
    expect(response.unread?.ranges).toBe(1);
  });

  it("ES: SPX options with 8 stored sessions and no open gap", () => {
    const response = labFlowPutCallRatio("ES");
    expect(FlowPutCallRatioSchema.parse(response)).toEqual(response);
    expect(response).toMatchObject({
      session: "2026-10-30",
      symbol: "ES",
      ticker: "SPX",
      unread: null,
    });
    expect(response.days).toHaveLength(8);
    expect(response.days.every((day) => !day.incomplete)).toBe(true);
    expect(response.totals.premiumRatio).toBeGreaterThan(1);
  });
});

describe("lab flow strike heatmap", () => {
  it.each([5, 15, 30] as const)(
    "SPY (%im): 20 displayed strikes, 3 omitted, open gap, and flat unsigned cell",
    (bucketMinutes) => {
      const response = labFlowStrikeHeatmap("SPY", bucketMinutes);
      expect(FlowStrikeHeatmapSchema.parse(response)).toEqual(response);
      expect(response.rules).toEqual(STRIKE_HEATMAP_RULES);
      expect(response).toMatchObject({
        bucketMinutes,
        session: "2026-10-30",
        symbol: "SPY",
        ticker: "SPY",
      });
      expect(response.strikes).toHaveLength(20);
      expect(response.totals.omittedStrikes).toBe(3);
      expect(response.unread?.ranges).toBe(1);
      expect(response.slots.some((slot) => slot.unread)).toBe(true);
    }
  );

  it("ES: SPX options with 12 strikes, zero omitted, exact-strike spot, and no open gap", () => {
    const response = labFlowStrikeHeatmap("ES");
    expect(FlowStrikeHeatmapSchema.parse(response)).toEqual(response);
    expect(response).toMatchObject({
      bucketMinutes: 15,
      session: "2026-10-30",
      symbol: "ES",
      ticker: "SPX",
      unread: null,
    });
    expect(response.strikes).toHaveLength(12);
    expect(response.totals.omittedStrikes).toBe(0);
    expect(response.totals.latestPrice).toBe(5810);
  });
});

describe("lab flow trade bubbles", () => {
  it("produces schema-valid ES and NQ price candles and deep trade bubbles", () => {
    const es = labFlowTradeBubbles("ES", 120);
    expect(FlowTradeBubblesSchema.parse(es)).toEqual(es);
    expect(es.symbol).toBe("ES");
    expect(es.candles).toHaveLength(120);
    expect(es.bubbles.length).toBeGreaterThan(10);
    expect(es.rules.deepTradeLimit).toBe(40);

    const nq = labFlowTradeBubbles("NQ", 60);
    expect(FlowTradeBubblesSchema.parse(nq)).toEqual(nq);
    expect(nq.symbol).toBe("NQ");
    expect(nq.candles).toHaveLength(60);
    expect(nq.rules.deepTradeLimit).toBe(10);
  });
});

describe("lab flow option bubbles", () => {
  it.each([100_000, 250_000, 500_000, 1_000_000] as const)(
    "SPY (floor $%i): schema-valid bubbles, price path, open gap, and unplotted print",
    (minPremiumUsd) => {
      const response = labFlowOptionBubbles("SPY", minPremiumUsd);
      expect(FlowOptionBubblesSchema.parse(response)).toEqual(response);
      expect(response.rules).toEqual(OPTION_BUBBLES_RULES);
      expect(response).toMatchObject({
        minPremiumUsd,
        session: "2026-10-30",
        symbol: "SPY",
        ticker: "SPY",
      });
      expect(response.pricePoints.length).toBeGreaterThan(20);
      expect(response.bubbles.length).toBeGreaterThan(0);
      expect(response.unread?.ranges).toBe(1);
      expect(response.gaps).toHaveLength(1);
    }
  );

  it("ES: SPX options with larger prints, zero unplotted prints, and no open gap", () => {
    const response = labFlowOptionBubbles("ES");
    expect(FlowOptionBubblesSchema.parse(response)).toEqual(response);
    expect(response).toMatchObject({
      minPremiumUsd: 250_000,
      session: "2026-10-30",
      symbol: "ES",
      ticker: "SPX",
      unread: null,
    });
    expect(response.bubbles.length).toBeGreaterThan(0);
    expect(response.totals.unplottedBubbles).toBe(0);
    expect(response.gaps).toHaveLength(0);
  });
});

describe("lab IV rank / percentile history", () => {
  it("produces schema-valid 1Y and 3M proxy curves for Core 7 ETFs", () => {
    const spy1y = labIvHistory("spy", 252);
    expect(OpenbbIvHistoryOutputSchema.parse(spy1y)).toEqual(spy1y);
    expect(spy1y.symbol).toBe("SPY");
    expect(spy1y.basis).toBe("vol_index_proxy");
    expect(spy1y.proxyIndex).toBe("VIX");
    expect(spy1y.points).toHaveLength(252);
    expect(spy1y.points.some((p) => (p.ivRank ?? 0) >= 80)).toBe(true);
    expect(spy1y.points.some((p) => (p.ivRank ?? 100) <= 20)).toBe(true);

    const qqq3m = labIvHistory("QQQ", 63);
    expect(OpenbbIvHistoryOutputSchema.parse(qqq3m)).toEqual(qqq3m);
    expect(qqq3m.proxyIndex).toBe("VXN");
    expect(qqq3m.points).toHaveLength(63);
  });

  it("returns an explicit unavailable state for non-Core-7 tickers", () => {
    const nvda = labIvHistory("NVDA");
    expect(OpenbbIvHistoryOutputSchema.parse(nvda)).toEqual(nvda);
    expect(nvda.basis).toBeNull();
    expect(nvda.points).toEqual([]);
    expect(nvda.own.sessions).toBe(0);
  });
});

describe("lab flow live DOM fixture", () => {
  it("produces schema-valid ES and NQ frames and aborts the fixture stream cleanly", async () => {
    const es = labFlowLiveDom("ES", 900);
    expect(FlowLiveDomSchema.parse(es)).toEqual(es);
    expect(es.contract).toBe("ESZ6");
    expect(es.source).toBe("live_stream");

    const nqReset = labFlowLiveDom("NQ", 300, 1_763_900_000);
    expect(FlowLiveDomSchema.parse(nqReset)).toEqual(nqReset);
    expect(nqReset.since).toBe(1_763_900_000);

    const ac = new AbortController();
    const events: string[] = [];
    for await (const event of labFlowLiveDomStream(
      "ES",
      900,
      null,
      ac.signal
    )) {
      events.push(event.type);
      ac.abort();
    }
    expect(events).toEqual(["frame"]);

    const preAborted = new AbortController();
    preAborted.abort();
    const events2: string[] = [];
    for await (const event of labFlowLiveDomStream(
      "NQ",
      900,
      null,
      preAborted.signal
    )) {
      events2.push(event.type);
    }
    expect(events2).toEqual(["frame"]);
  });
});
