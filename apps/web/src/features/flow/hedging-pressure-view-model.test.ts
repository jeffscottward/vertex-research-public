import type { FlowHedgingPressure } from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  buildHedgingChart,
  buildPriceChart,
  HEDGING_CHART_PAD,
  HEDGING_LOADING,
  HEDGING_NO_POINTS,
  hedgingAriaLabel,
  hedgingCountsLine,
  hedgingEmptyLine,
  hedgingFailureLine,
  hedgingHeaderLine,
  hedgingLargestLine,
  hedgingLegend,
  hedgingPriceAriaLabel,
  hedgingRuleText,
  hedgingSymbolOf,
  hedgingTitle,
  hedgingTotalsLine,
  niceScale,
} from "./hedging-pressure-view-model.ts";

// Friday 2026-11-20, standard time: 09:30 New York is 14:30 UTC.
const OPEN = Date.parse("2026-11-20T14:30:00.000Z");
const minute = (count: number) => new Date(OPEN + count * 60_000).toISOString();

type Point = FlowHedgingPressure["points"][number];
const point = (
  count: number,
  net: number,
  overrides: Partial<Point> = {}
): Point => ({
  calls: net,
  minute: minute(count),
  minuteNet: net,
  net,
  price: 660,
  prints: 1,
  puts: 0,
  ...overrides,
});

const response = (
  overrides: Partial<FlowHedgingPressure> = {}
): FlowHedgingPressure => ({
  options: {
    ageSeconds: 30,
    lastOkAt: "2026-11-20T20:58:30.000Z",
    lastStatus: "ok",
    message: null,
    sessionOpen: true,
    source: "options",
    state: "fresh",
  },
  points: [
    point(0, 1_000_000, { price: 660 }),
    point(72, 2_200_000, { calls: 2_000_000, price: 661.5, puts: 200_000 }),
    point(388, -500_000, { calls: 300_000, price: 659, puts: -800_000 }),
  ],
  rules: {
    dividendYield: 0.015,
    rate: 0.04,
    version: "hedging-pressure.v1",
    volFallback: 0.2,
  },
  schemaVersion: "flow-hedging-pressure.v1",
  session: "2026-11-20",
  storedUntil: "2026-11-20T20:58:41.000Z",
  symbol: "SPY",
  ticker: "SPY",
  totals: {
    calls: 2_000_000_000,
    gross: 5_100_000_000,
    ivAdjusted: 40,
    largestFall: {
      minute: "2026-11-20T20:58:00.000Z",
      minuteNet: -450_000_000,
    },
    largestRise: { minute: "2026-11-20T15:42:00.000Z", minuteNet: 310_000_000 },
    net: 1_234_000_000,
    notPriced: 12,
    notSigned: 300,
    prints: 3100,
    puts: -800_000_000,
    signed: 2800,
  },
  truncated: false,
  unread: null,
  ...overrides,
});

describe("hedging pressure texts", () => {
  it("has the panel for SPY and ES only", () => {
    expect(hedgingSymbolOf("SPY")).toBe("SPY");
    expect(hedgingSymbolOf("ES")).toBe("ES");
    expect(hedgingSymbolOf("QQQ")).toBeNull();
    expect(hedgingSymbolOf("NQ")).toBeNull();
  });

  it("names the options of the symbol in the title", () => {
    expect(hedgingTitle("SPY")).toBe("Hedging pressure · SPY options");
    expect(hedgingTitle("ES")).toBe("Hedging pressure · SPX options (ES)");
  });

  it("has the loading, empty, no-point and failure lines", () => {
    expect(HEDGING_LOADING).toBe("Loading hedging pressure…");
    expect(HEDGING_NO_POINTS).toBe("No counted print in this session.");
    expect(hedgingEmptyLine("ES")).toBe(
      "No option prints stored for ES in the last 14 days."
    );
    expect(
      hedgingFailureLine(
        {
          code: "STORAGE_ERROR",
          failedAt: Date.parse("2026-11-20T15:42:00.000Z"),
          message: "Flow storage: database request failed; retry",
        },
        60_000
      )
    ).toBe(
      "Hedging pressure not loaded: STORAGE_ERROR: Flow storage: database request failed; retry · retrying with the next refresh at 10:43 ET"
    );
  });

  it("states the session, the newest counted print and the options freshness in the header", () => {
    expect(hedgingHeaderLine(response())).toBe(
      "Session 2026-11-20 · as of 15:58 ET · options fresh"
    );
    expect(
      hedgingHeaderLine(
        response({
          options: { ...response().options, state: "never" },
          storedUntil: null,
        })
      )
    ).toBe("Session 2026-11-20 · no counted print · options never collected");
    expect(hedgingHeaderLine(response({ points: [], session: null }))).toBe(
      "Session none · as of 15:58 ET · options fresh"
    );
  });

  it("adds the read cap note and the incomplete sentence", () => {
    expect(
      hedgingHeaderLine(
        response({
          options: { ...response().options, state: "closed" },
          truncated: true,
          unread: {
            from: "2026-11-20T15:00:00.000Z",
            ranges: 2,
            to: "2026-11-20T15:20:00.000Z",
          },
        })
      )
    ).toBe(
      "Session 2026-11-20 · as of 15:58 ET · options closed · read cap reached, prints after 15:58 ET not counted · Incomplete: prints of 10:00–10:20 ET not read yet; earlier parts of the line can still change."
    );
    expect(
      hedgingHeaderLine(
        response({
          options: { ...response().options, state: "stale" },
          storedUntil: null,
          truncated: true,
        })
      )
    ).toBe(
      "Session 2026-11-20 · no counted print · options stale · read cap reached, later prints not read"
    );
  });

  it("writes the totals, the largest minutes and the counts", () => {
    expect(hedgingTotalsLine(response())).toBe(
      "Net +$1.2B · calls +$2B · puts −$800M · gross $5.1B"
    );
    expect(hedgingLargestLine(response())).toBe(
      "Largest rise +$310M at 10:42 ET · largest fall −$450M at 15:58 ET"
    );
    expect(
      hedgingLargestLine(
        response({
          totals: {
            ...response().totals,
            largestFall: null,
            largestRise: null,
          },
        })
      )
    ).toBe("No rising minute · no falling minute");
    expect(hedgingCountsLine(response())).toBe(
      "3,100 prints · 2,800 signed · 300 not signed (mid or unknown) · 12 not priced · 40 IV adjusted"
    );
  });

  it("builds the rule text from the rules of the response", () => {
    expect(hedgingRuleText(response().rules)).toBe(
      "Estimate. Each print is signed by its aggressor side, assuming the dealer took the other side; mid and unknown prints are not counted. Delta is Black-Scholes at the print time (rate 4%, yield 1.5%) from the print's IV (20% when the stored IV is below 1%); it is not updated as price moves. Only prints with premium of $10,000 or more are stored; prints before 09:30 ET are not counted. Research only, not a trade signal. hedging-pressure.v1."
    );
  });

  it("names the session, the end values and the largest minutes in the aria label", () => {
    expect(hedgingAriaLabel(response())).toBe(
      "Hedging pressure, session 2026-11-20: Net +$1.2B · calls +$2B · puts −$800M · gross $5.1B. Largest rise +$310M at 10:42 ET · largest fall −$450M at 15:58 ET."
    );
    expect(hedgingAriaLabel(response({ session: null }))).toContain(
      "session none:"
    );
  });

  it("has a legend entry per line and one for the gap shade only when the chart draws it", () => {
    expect(hedgingLegend({ unread: null }).map((entry) => entry.key)).toEqual([
      "net",
      "calls",
      "puts",
    ]);
    expect(hedgingLegend({ unread: { width: 10, x: 5 } }).at(-1)).toEqual({
      key: "unread",
      text: "Not read yet (open collector gap)",
    });
  });
});

describe("niceScale", () => {
  it.each([
    // Only positive values: 0 at the bottom.
    [0, 7, { max: 8, min: 0, step: 2 }],
    [0, 1, { max: 1, min: 0, step: 0.25 }],
    [0, 1_234_000_000, { max: 1_500_000_000, min: 0, step: 500_000_000 }],
    // Only negative values: 0 at the top.
    [-56_700, 0, { max: 0, min: -60_000, step: 20_000 }],
    // Mixed values.
    [-800, 2200, { max: 3000, min: -1000, step: 1000 }],
    // All 0: a scale of one unit.
    [0, 0, { max: 1, min: 0, step: 0.25 }],
  ])("scales %d to %d", (low, high, expected) => {
    expect(niceScale(low, high)).toEqual(expected);
  });

  it("gives 3 to 5 ticks over many spans", () => {
    for (const high of [1, 3, 9.9, 11, 26, 49, 51, 99, 101, 4321, 98_765]) {
      for (const low of [0, -high / 3, -high]) {
        const scale = niceScale(low, high);
        const ticks = Math.round((scale.max - scale.min) / scale.step) + 1;
        expect(ticks).toBeGreaterThanOrEqual(3);
        expect(ticks).toBeLessThanOrEqual(5);
        expect(scale.min).toBeLessThanOrEqual(Math.min(0, low));
        expect(scale.max).toBeGreaterThanOrEqual(high);
      }
    }
  });
});

describe("buildHedgingChart", () => {
  it("is null without a session or a point", () => {
    expect(
      buildHedgingChart(response({ points: [], session: null }), 1000, 128)
    ).toBeNull();
    expect(buildHedgingChart(response({ points: [] }), 1000, 128)).toBeNull();
  });

  it("draws stepped lines from 09:30 at 0 to the end of the newest minute", () => {
    // 09:30 to 09:40: one unit of width per minute.
    const chart = buildHedgingChart(
      response({
        points: [
          point(2, 1000, { calls: 1500, puts: -500 }),
          point(9, 2000, { calls: 3000, puts: -1000 }),
        ],
      }),
      10,
      108
    );
    if (chart === null) throw new Error("no chart");
    // Scale −1,000 to 3,000 in steps of 1,000; 100 usable units: 25 per 1,000.
    const y = (value: number) =>
      HEDGING_CHART_PAD + ((3000 - value) / 4000) * 100;
    expect(chart.zeroY).toBe(y(0));
    expect(chart.net).toBe(`M0 ${y(0)} H2 V${y(1000)} H9 V${y(2000)} H10`);
    expect(chart.calls).toBe(`M0 ${y(0)} H2 V${y(1500)} H9 V${y(3000)} H10`);
    expect(chart.puts).toBe(`M0 ${y(0)} H2 V${y(-500)} H9 V${y(-1000)} H10`);
    expect(chart.ticks).toEqual([
      { label: "+$3K", value: 3000, y: y(3000) },
      { label: "+$2K", value: 2000, y: y(2000) },
      { label: "+$1K", value: 1000, y: y(1000) },
      { label: "$0", value: 0, y: y(0) },
      { label: "−$1K", value: -1000, y: y(-1000) },
    ]);
    expect(chart.startLabel).toBe("09:30 ET");
    expect(chart.endLabel).toBe("09:40 ET");
    expect(chart.unread).toBeNull();
  });

  it("draws one point over the whole width", () => {
    const chart = buildHedgingChart(
      response({ points: [point(0, -56_700)] }),
      100,
      48
    );
    expect(chart?.net).toBe(`M0 ${HEDGING_CHART_PAD} H0 V41.8 H100`);
    expect(chart?.ticks.map((tick) => tick.label)).toEqual([
      "$0",
      "−$20K",
      "−$40K",
      "−$60K",
    ]);
  });

  it("starts at 09:30 daylight time in summer", () => {
    const chart = buildHedgingChart(
      response({
        points: [point(0, 1, { minute: "2026-07-01T13:31:00.000Z" })],
        session: "2026-07-01",
      }),
      2,
      48
    );
    expect(chart?.startLabel).toBe("09:30 ET");
    expect(chart?.net.startsWith("M0 ")).toBe(true);
    expect(chart?.net).toContain("H1 ");
  });

  it("shades the unread span inside the drawn time and drops it outside", () => {
    const points = [point(0, 1), point(9, 2)];
    const shade = (from: number, to: number) =>
      buildHedgingChart(
        response({
          points,
          unread: { from: minute(from), ranges: 1, to: minute(to) },
        }),
        10,
        48
      )?.unread;
    expect(shade(3, 5)).toEqual({ width: 2, x: 3 });
    // Clipped at the end of the newest minute.
    expect(shade(8, 30)).toEqual({ width: 2, x: 8 });
    // After the newest minute: nothing to draw.
    expect(shade(20, 30)).toBeNull();
  });
});

describe("buildPriceChart", () => {
  it("is null without a session or a point, and has no path without a price", () => {
    expect(
      buildPriceChart(response({ points: [], session: null }), 100, 64)
    ).toBeNull();
    expect(buildPriceChart(response({ points: [] }), 100, 64)).toBeNull();
    const none = buildPriceChart(
      response({ points: [point(0, 1, { price: null })] }),
      100,
      64
    );
    expect(none).toEqual({
      height: 64,
      highLabel: "",
      lowLabel: "",
      path: null,
      width: 100,
    });
    if (none === null) throw new Error("no chart");
    expect(hedgingPriceAriaLabel(response(), none)).toBe(
      "SPY price, session 2026-11-20: no price"
    );
  });

  it("draws the price with its low and high labels", () => {
    const chart = buildPriceChart(
      response({
        points: [
          point(0, 1, { price: 660 }),
          point(4, 1, { price: null }),
          point(5, 1, { price: 670 }),
          point(9, 1, { price: 665 }),
        ],
        symbol: "ES",
        ticker: "SPX",
      }),
      10,
      28
    );
    if (chart === null) throw new Error("no chart");
    expect(chart.path).toBe("M0 24 H5 V4 H9 V14 H10");
    expect(chart.lowLabel).toBe("660.00");
    expect(chart.highLabel).toBe("670.00");
    expect(
      hedgingPriceAriaLabel(response({ symbol: "ES", ticker: "SPX" }), chart)
    ).toBe("SPX index price, session 2026-11-20: low 660.00, high 670.00");
  });

  it("draws a flat price in the middle", () => {
    const chart = buildPriceChart(
      response({ points: [point(0, 1), point(1, 2)] }),
      2,
      64
    );
    expect(chart?.path).toBe("M0 32 H1 V32 H2");
  });
});
