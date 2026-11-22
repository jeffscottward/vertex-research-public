import { type FlowPutCallRatio, PUT_CALL_RATIO_RULES } from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  buildDaysPriceChart,
  buildDaysRatioChart,
  buildSessionPriceChart,
  buildSessionRatioChart,
  daysRatioAriaLabel,
  formatSessionShortDate,
  PUT_CALL_RATIO_CHART_PAD,
  PUT_CALL_RATIO_LOADING,
  PUT_CALL_RATIO_NO_CALLS_DAYS,
  PUT_CALL_RATIO_NO_CALLS_SESSION,
  PUT_CALL_RATIO_NO_DAYS,
  PUT_CALL_RATIO_NO_POINTS,
  putCallRatioCountsLine,
  putCallRatioDaysSummaryLine,
  putCallRatioEmptyLine,
  putCallRatioExtremesLine,
  putCallRatioFailureLine,
  putCallRatioHeaderLine,
  putCallRatioLegend,
  putCallRatioPriceAriaLabel,
  putCallRatioPriceName,
  putCallRatioRuleText,
  putCallRatioSymbolOf,
  putCallRatioTitle,
  putCallRatioTotalsLine,
  ratioNiceScale,
  sessionRatioAriaLabel,
} from "./put-call-ratio-view-model.ts";

const baseResponse = (
  overrides: Partial<FlowPutCallRatio> = {}
): FlowPutCallRatio => ({
  days: [
    {
      callPremium: 10_000_000,
      callPrints: 80,
      callVolume: 2000,
      incomplete: false,
      premiumRatio: 0.8,
      price: 658.4,
      prints: 150,
      putPremium: 8_000_000,
      putPrints: 70,
      putVolume: 1800,
      session: "2026-11-18",
      volumeRatio: 0.9,
    },
    {
      callPremium: 12_000_000,
      callPrints: 90,
      callVolume: 2400,
      incomplete: true,
      premiumRatio: 1.25,
      price: 660.1,
      prints: 195,
      putPremium: 15_000_000,
      putPrints: 105,
      putVolume: 2880,
      session: "2026-11-19",
      volumeRatio: 1.2,
    },
    {
      callPremium: 11_000_000,
      callPrints: 85,
      callVolume: 2200,
      incomplete: false,
      premiumRatio: 1.1,
      price: 661.5,
      prints: 175,
      putPremium: 12_100_000,
      putPrints: 90,
      putVolume: 2310,
      session: "2026-11-20",
      volumeRatio: 1.05,
    },
  ],
  options: {
    ageSeconds: 30,
    lastOkAt: "2026-11-20T15:00:00.000Z",
    lastStatus: "ok",
    message: "quantdata flow: 20 prints",
    sessionOpen: true,
    source: "options",
    state: "fresh",
  },
  points: [
    {
      callPremium: 2_000_000,
      callVolume: 400,
      minute: "2026-11-20T14:30:00.000Z",
      premiumRatio: 0.75,
      price: 660.5,
      prints: 10,
      putPremium: 1_500_000,
      putVolume: 360,
      volumeRatio: 0.9,
    },
    {
      callPremium: 4_000_000,
      callVolume: 800,
      minute: "2026-11-20T14:45:00.000Z",
      premiumRatio: 1.4,
      price: 661.5,
      prints: 12,
      putPremium: 5_600_000,
      putVolume: 1040,
      volumeRatio: 1.3,
    },
  ],
  rules: { ...PUT_CALL_RATIO_RULES },
  schemaVersion: "flow-put-call-ratio.v1",
  session: "2026-11-20",
  storedUntil: "2026-11-20T14:45:42.000Z",
  symbol: "SPY",
  ticker: "SPY",
  totals: {
    callPremium: 4_000_000,
    callPrints: 10,
    callVolume: 800,
    premiumHigh: { minute: "2026-11-20T14:45:00.000Z", ratio: 1.4 },
    premiumLow: { minute: "2026-11-20T14:30:00.000Z", ratio: 0.75 },
    premiumRatio: 1.4,
    prints: 22,
    putPremium: 5_600_000,
    putPrints: 12,
    putVolume: 1040,
    volumeHigh: { minute: "2026-11-20T14:45:00.000Z", ratio: 1.3 },
    volumeLow: { minute: "2026-11-20T14:30:00.000Z", ratio: 0.9 },
    volumeRatio: 1.3,
  },
  unread: null,
  ...overrides,
});

describe("put-call-ratio view-model labels and texts", () => {
  it("maps symbols, titles, price names, and constants", () => {
    expect(putCallRatioSymbolOf("SPY")).toBe("SPY");
    expect(putCallRatioSymbolOf("ES")).toBe("ES");
    expect(putCallRatioSymbolOf("QQQ")).toBeNull();
    expect(putCallRatioSymbolOf("NQ")).toBeNull();

    expect(putCallRatioTitle("SPY")).toBe("Put/call ratio · SPY options");
    expect(putCallRatioTitle("ES")).toBe("Put/call ratio · SPX options (ES)");
    expect(putCallRatioPriceName(baseResponse())).toBe("SPY price");
    expect(
      putCallRatioPriceName(baseResponse({ symbol: "ES", ticker: "SPX" }))
    ).toBe("SPX index price");
    expect(putCallRatioEmptyLine("SPY")).toBe(
      "No option prints stored for SPY in the last 14 days."
    );
    expect(PUT_CALL_RATIO_LOADING).toContain("Loading");
    expect(PUT_CALL_RATIO_NO_POINTS).toContain("regular-session");
    expect(PUT_CALL_RATIO_NO_DAYS).toContain("14 days");
    expect(PUT_CALL_RATIO_NO_CALLS_SESSION).toContain("no call prints");
    expect(PUT_CALL_RATIO_NO_CALLS_DAYS).toContain("no call prints");
    expect(formatSessionShortDate("2026-11-20")).toBe("Nov 20");
  });

  it("formats failure, header, totals, extremes, counts, days summary and rule lines", () => {
    expect(
      putCallRatioFailureLine(
        {
          code: "STORAGE_ERROR",
          failedAt: Date.parse("2026-11-20T15:00:00.000Z"),
          message: "db down",
        },
        60_000
      )
    ).toBe(
      "Put/call ratio not loaded: STORAGE_ERROR: db down · retrying with the next refresh at 10:01 ET"
    );

    expect(putCallRatioHeaderLine(baseResponse())).toBe(
      "Session 2026-11-20 · as of 09:45 ET · 3 stored sessions · options fresh"
    );
    expect(
      putCallRatioHeaderLine(
        baseResponse({
          days: [baseResponse().days[0]!],
          options: { ...baseResponse().options, state: "stale" },
          session: null,
          storedUntil: null,
          unread: {
            from: "2026-11-20T14:40:00.000Z",
            ranges: 1,
            to: "2026-11-20T14:50:00.000Z",
          },
        })
      )
    ).toBe(
      "Session none · no regular-session print · 1 stored session · options stale · Incomplete: prints of 09:40–09:50 ET not read yet; earlier parts of the line can still change."
    );

    expect(putCallRatioTotalsLine(baseResponse())).toBe(
      "Premium P/C 1.40 (puts $5.6M / calls $4M) · volume P/C 1.30 (puts 1K / calls 800)"
    );
    expect(putCallRatioExtremesLine(baseResponse())).toBe(
      "Session range · premium 0.75 at 09:30 ET to 1.40 at 09:45 ET · volume 0.90 at 09:30 ET to 1.30 at 09:45 ET"
    );
    expect(
      putCallRatioExtremesLine(
        baseResponse({
          totals: {
            ...baseResponse().totals,
            premiumHigh: null,
            premiumLow: null,
            volumeHigh: null,
            volumeLow: null,
          },
        })
      )
    ).toBe("Session range · premium no ratio · volume no ratio");

    expect(putCallRatioCountsLine(baseResponse())).toBe(
      "22 prints (12 puts, 10 calls)"
    );

    expect(putCallRatioDaysSummaryLine(baseResponse())).toBe(
      "3 sessions (2026-11-18 to 2026-11-20) · latest premium P/C 1.10 · latest volume P/C 1.05 · 1 session incomplete (open collector gap)"
    );
    expect(putCallRatioDaysSummaryLine(baseResponse({ days: [] }))).toBe(
      PUT_CALL_RATIO_NO_DAYS
    );
    expect(
      putCallRatioDaysSummaryLine(
        baseResponse({
          days: [{ ...baseResponse().days[0]!, incomplete: false }],
        })
      )
    ).toBe(
      "1 session (2026-11-18) · latest premium P/C 0.80 · latest volume P/C 0.90"
    );
    expect(
      putCallRatioDaysSummaryLine(
        baseResponse({
          days: [
            { ...baseResponse().days[0]!, incomplete: true },
            { ...baseResponse().days[1]!, incomplete: true },
          ],
        })
      )
    ).toContain("2 sessions incomplete (open collector gaps)");

    const rulesText = putCallRatioRuleText(PUT_CALL_RATIO_RULES);
    expect(rulesText).toContain("$10,000");
    expect(rulesText).toContain("14 days");
    expect(rulesText).toContain("1.00");
    expect(rulesText).toContain("Net drift stores signed values");
    expect(rulesText).toContain("put-call-ratio.v1");

    expect(sessionRatioAriaLabel(baseResponse())).toContain("2026-11-20");
    expect(sessionRatioAriaLabel(baseResponse({ session: null }))).toContain(
      "session none"
    );
    expect(daysRatioAriaLabel(baseResponse())).toContain("3 sessions");
  });
});

describe("ratioNiceScale", () => {
  it("keeps parity 1.00 inside a non-negative 3 to 5 tick scale", () => {
    const aroundParity = ratioNiceScale(0.75, 1.4, 1);
    expect(aroundParity.min).toBeGreaterThanOrEqual(0);
    expect(aroundParity.min).toBeLessThanOrEqual(0.75);
    expect(aroundParity.max).toBeGreaterThanOrEqual(1.4);
    expect(
      Math.round((aroundParity.max - aroundParity.min) / aroundParity.step)
    ).toBeLessThanOrEqual(4);

    // Equal to parity: widens above parity without dividing by zero
    const flat = ratioNiceScale(1, 1, 1);
    expect(flat.max).toBeGreaterThan(flat.min);

    // Tight near-parity ratios keep distinct two-decimal tick labels (step >= 0.05)
    const tight = ratioNiceScale(0.998, 1.002, 1);
    expect(tight.step).toBeGreaterThanOrEqual(0.05);
    expect(tight.min).toBeLessThanOrEqual(0.998);
    expect(tight.max).toBeGreaterThanOrEqual(1.002);

    // Large ratio spike
    const spike = ratioNiceScale(0.5, 18.2, 1);
    expect(spike.min).toBe(0);
    expect(spike.max).toBeGreaterThanOrEqual(18.2);
  });
});

describe("buildSessionRatioChart and buildSessionPriceChart", () => {
  it("returns null when session is null, points are empty, or no point has a ratio", () => {
    expect(
      buildSessionRatioChart(baseResponse({ session: null }), 1000, 128)
    ).toBeNull();
    expect(
      buildSessionRatioChart(baseResponse({ points: [] }), 1000, 128)
    ).toBeNull();
    expect(
      buildSessionRatioChart(
        baseResponse({
          points: [
            {
              ...baseResponse().points[0]!,
              premiumRatio: null,
              volumeRatio: null,
            },
          ],
        }),
        1000,
        128
      )
    ).toBeNull();
    expect(
      buildSessionPriceChart(baseResponse({ session: null }), 1000, 64)
    ).toBeNull();
    expect(
      buildSessionPriceChart(baseResponse({ points: [] }), 1000, 64)
    ).toBeNull();
  });

  it("builds stepped session paths, daylight/standard time axes, ticks, and gap shades", () => {
    // No open gap -> unread shade is null
    expect(
      buildSessionRatioChart(baseResponse(), 1000, 128)?.unread
    ).toBeNull();

    // Standard time (Nov 20) with an open gap overlapping the drawn span
    const estChart = buildSessionRatioChart(
      baseResponse({
        unread: {
          from: "2026-11-20T14:35:00.000Z",
          ranges: 1,
          to: "2026-11-20T14:40:00.000Z",
        },
      }),
      1000,
      128
    );
    expect(estChart).not.toBeNull();
    expect(estChart?.startLabel).toBe("09:30 ET");
    expect(estChart?.endLabel).toBe("09:46 ET");
    expect(estChart?.premiumPath).toMatch(/^M0 .* H.* V.* H1000$/);
    expect(estChart?.volumePath).toMatch(/^M0 .* H.* V.* H1000$/);
    expect(estChart?.unread).not.toBeNull();
    expect(estChart?.unread?.width).toBeGreaterThan(0);
    expect(estChart?.ticks.length).toBeGreaterThanOrEqual(3);
    expect(estChart?.ticks.length).toBeLessThanOrEqual(5);
    expect(estChart?.parityY).toBeGreaterThanOrEqual(PUT_CALL_RATIO_CHART_PAD);
    expect(estChart?.parityY).toBeLessThanOrEqual(
      128 - PUT_CALL_RATIO_CHART_PAD
    );

    // Daylight time (July 15) + gap outside drawn span -> unread is null; null first point skipped
    const edtChart = buildSessionRatioChart(
      baseResponse({
        points: [
          {
            ...baseResponse().points[0]!,
            minute: "2026-07-15T13:30:00.000Z",
            premiumRatio: null,
            volumeRatio: null,
          },
          {
            ...baseResponse().points[1]!,
            minute: "2026-07-15T13:35:00.000Z",
            premiumRatio: 1.2,
            volumeRatio: null,
          },
        ],
        session: "2026-07-15",
        unread: {
          from: "2026-07-15T15:00:00.000Z",
          ranges: 1,
          to: "2026-07-15T15:10:00.000Z",
        },
      }),
      1000,
      128
    );
    expect(edtChart?.startLabel).toBe("09:30 ET");
    expect(edtChart?.endLabel).toBe("09:36 ET");
    expect(edtChart?.unread).toBeNull();
    expect(edtChart?.premiumPath).not.toBeNull();
    expect(edtChart?.volumePath).toBeNull();
  });

  it("builds stepped price chart for varying, flat, and missing prices", () => {
    const priced = buildSessionPriceChart(baseResponse(), 1000, 64);
    expect(priced?.path).toMatch(/^M.* H.* V.* H1000$/);
    expect(priced?.lowLabel).toBe("660.50");
    expect(priced?.highLabel).toBe("661.50");
    expect(putCallRatioPriceAriaLabel(baseResponse(), priced!, "session")).toBe(
      "SPY price, session 2026-11-20: low 660.50, high 661.50"
    );

    const flat = buildSessionPriceChart(
      baseResponse({
        points: [{ ...baseResponse().points[0]!, price: 660.5 }],
      }),
      1000,
      64
    );
    expect(flat?.path).toBe("M0 32 H1000");

    const none = buildSessionPriceChart(
      baseResponse({
        points: [{ ...baseResponse().points[0]!, price: null }],
      }),
      1000,
      64
    );
    expect(none?.path).toBeNull();
    expect(
      putCallRatioPriceAriaLabel(
        baseResponse({ session: null }),
        none!,
        "session"
      )
    ).toBe("SPY price, session none: no price");
  });
});

describe("buildDaysRatioChart, buildDaysPriceChart and legend", () => {
  it("returns null when days are empty or all ratios are null", () => {
    expect(
      buildDaysRatioChart(baseResponse({ days: [] }), 1000, 128)
    ).toBeNull();
    expect(
      buildDaysRatioChart(
        baseResponse({
          days: [
            {
              ...baseResponse().days[0]!,
              premiumRatio: null,
              volumeRatio: null,
            },
          ],
        }),
        1000,
        128
      )
    ).toBeNull();
    expect(
      buildDaysPriceChart(baseResponse({ days: [] }), 1000, 64)
    ).toBeNull();
  });

  it("builds multi-day lines, markers, incomplete bands, breaks across null days, and single-day markers", () => {
    const multi = buildDaysRatioChart(baseResponse(), 900, 128);
    expect(multi).not.toBeNull();
    expect(multi?.premiumPath).toMatch(/^M150 .* L450 .* L750 /);
    expect(multi?.volumePath).toMatch(/^M150 .* L450 .* L750 /);
    expect(multi?.premiumMarkers).toHaveLength(3);
    expect(multi?.volumeMarkers).toHaveLength(3);
    expect(multi?.incompleteBands).toEqual([
      { session: "2026-11-19", width: 300, x: 300 },
    ]);
    expect(multi?.axisLabels.map((entry) => entry.label)).toEqual([
      "Nov 18",
      "Nov 19",
      "Nov 20",
    ]);

    // Single day: no polyline segment, centered marker at width / 2
    const single = buildDaysRatioChart(
      baseResponse({ days: [baseResponse().days[0]!] }),
      1000,
      128
    );
    expect(single?.premiumPath).toBeNull();
    expect(single?.premiumMarkers).toHaveLength(1);
    expect(single?.premiumMarkers[0]?.x).toBe(500);
    expect(single?.axisLabels).toHaveLength(1);

    // 4 days: axis labels keep first, middle and last only (skips index 2)
    const fourDays = buildDaysRatioChart(
      baseResponse({
        days: [
          ...baseResponse().days,
          { ...baseResponse().days[2]!, session: "2026-11-23" },
        ],
      }),
      1000,
      128
    );
    expect(fourDays?.axisLabels.map((entry) => entry.label)).toEqual([
      "Nov 18",
      "Nov 19",
      "Nov 23",
    ]);

    // Null day in the middle breaks the polyline into no segments (2 isolated points)
    const gapped = buildDaysRatioChart(
      baseResponse({
        days: [
          baseResponse().days[0]!,
          {
            ...baseResponse().days[1]!,
            premiumRatio: null,
            volumeRatio: 1.2,
          },
          {
            ...baseResponse().days[2]!,
            volumeRatio: null,
          },
        ],
      }),
      900,
      128
    );
    expect(gapped?.premiumPath).toBeNull();
    expect(gapped?.premiumMarkers).toHaveLength(2);
    expect(gapped?.volumePath).toMatch(/^M150 .* L450 /);
    expect(gapped?.volumeMarkers).toHaveLength(2);
  });

  it("builds days price chart for varying, flat, and missing prices", () => {
    const priced = buildDaysPriceChart(baseResponse(), 900, 64);
    expect(priced?.path).toMatch(/^M150 .* L450 .* L750 /);
    expect(priced?.markers).toHaveLength(3);
    expect(priced?.lowLabel).toBe("658.40");
    expect(priced?.highLabel).toBe("661.50");
    expect(putCallRatioPriceAriaLabel(baseResponse(), priced!, "days")).toBe(
      "SPY price, stored days: low 658.40, high 661.50"
    );

    const flat = buildDaysPriceChart(
      baseResponse({ days: [{ ...baseResponse().days[0]!, price: 658.4 }] }),
      1000,
      64
    );
    expect(flat?.path).toBeNull();
    expect(flat?.markers).toEqual([
      { label: "2026-11-18: 658.40", x: 500, y: 32 },
    ]);

    const none = buildDaysPriceChart(
      baseResponse({ days: [{ ...baseResponse().days[0]!, price: null }] }),
      1000,
      64
    );
    expect(none?.path).toBeNull();
    expect(none?.markers).toEqual([]);
    expect(putCallRatioPriceAriaLabel(baseResponse(), none!, "days")).toBe(
      "SPY price, stored days: no price"
    );
  });

  it("includes the gap shade in the legend only when drawn, with view-specific text", () => {
    expect(
      putCallRatioLegend(false, "session").map((entry) => entry.key)
    ).toEqual(["premium", "volume", "parity"]);
    expect(putCallRatioLegend(true, "session").at(-1)).toEqual({
      key: "unread",
      text: "Not read yet (open collector gap)",
    });
    expect(putCallRatioLegend(true, "days").at(-1)).toEqual({
      key: "unread",
      text: "Incomplete session (open collector gap)",
    });
  });
});
