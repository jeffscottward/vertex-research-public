import type {
  OpenbbIvHistoryOutput,
  OpenbbIvHistoryPoint,
} from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  basisBadgeText,
  basisCaveatText,
  buildIvHistoryTableRows,
  buildIvRankChart,
  classifyIvRegime,
  formatIvScore,
  formatIvValue,
  formatUtcTickDate,
  IV_CHART_HEIGHT,
  IV_CHART_WIDTH,
  IV_HISTORY_HORIZON_LABELS,
  ivHistoryAriaLabel,
} from "./iv-rank-history-model.ts";

const makePoint = (
  overrides: Partial<OpenbbIvHistoryPoint> & { date: string }
): OpenbbIvHistoryPoint => ({
  high52w: 30,
  iv: 20,
  ivPercentile: 50,
  ivRank: 50,
  low52w: 10,
  ...overrides,
});

const makePayload = (
  overrides: Partial<OpenbbIvHistoryOutput> = {}
): OpenbbIvHistoryOutput => {
  const points = overrides.points ?? [
    makePoint({ date: "2026-01-02", iv: 18, ivPercentile: 25, ivRank: 20 }),
    makePoint({ date: "2026-06-15", iv: 26, ivPercentile: 82, ivRank: 85 }),
    makePoint({ date: "2026-11-20", iv: 21, ivPercentile: 58, ivRank: 55 }),
  ];
  return {
    asOf: points.at(-1)?.date ?? null,
    basis: "vol_index_proxy",
    latest: points.at(-1) ?? null,
    minSessions: 252,
    own: {
      asOf: "2026-11-20",
      ivPercentile: null,
      ivRank: null,
      latestValue: 0.21,
      minSessions: 252,
      reason: "Needs 252 sessions with ATM IV (12 stored)",
      sessions: 12,
      windowSessions: 252,
    },
    points,
    proxy: {
      asOf: "2026-11-20",
      index: "VIX",
      ivPercentile: 58,
      ivRank: 55,
      latestValue: 21,
      minSessions: 252,
      reason: null,
      sessions: 252,
      windowSessions: 252,
    },
    proxyIndex: "VIX",
    reason: null,
    requestedSessions: 252,
    symbol: "SPY",
    unit: "vol_points",
    windowSessions: 252,
    ...overrides,
  };
};

describe("iv-rank-history-model", () => {
  it("maps horizons to compact labels", () => {
    expect(IV_HISTORY_HORIZON_LABELS).toEqual({
      63: "3M",
      126: "6M",
      252: "1Y",
      504: "2Y",
    });
    expect(IV_CHART_WIDTH).toBe(1000);
    expect(IV_CHART_HEIGHT).toBe(240);
  });

  it("classifies regimes using ivRank and falls back to ivPercentile when ivRank is null", () => {
    expect(classifyIvRegime({ ivPercentile: 40, ivRank: 80 })).toEqual({
      kind: "high",
      label: "High IV (≥ 80)",
    });
    expect(classifyIvRegime({ ivPercentile: 60, ivRank: 20 })).toEqual({
      kind: "low",
      label: "Low IV (≤ 20)",
    });
    expect(classifyIvRegime({ ivPercentile: 90, ivRank: 50 })).toEqual({
      kind: "mid",
      label: "Mid range (20–80)",
    });
    expect(classifyIvRegime({ ivPercentile: 85, ivRank: null })).toEqual({
      kind: "high",
      label: "High IV (≥ 80)",
    });
    expect(classifyIvRegime({ ivPercentile: 10, ivRank: null })).toEqual({
      kind: "low",
      label: "Low IV (≤ 20)",
    });
    expect(classifyIvRegime({ ivPercentile: 50, ivRank: null })).toEqual({
      kind: "mid",
      label: "Mid range (20–80)",
    });
  });

  it("formats raw IV according to unit and formats flat-range null IV rank", () => {
    expect(formatIvValue(0.185, "decimal")).toBe("18.5%");
    expect(formatIvValue(18.54, "vol_points")).toBe("18.5");
    expect(formatIvValue(18.54, null)).toBe("18.5");
    expect(formatIvScore(64.26)).toBe("64.3");
    expect(formatIvScore(null)).toBe("Flat range");
  });

  it("formats UTC tick dates without local timezone drift and handles malformed dates", () => {
    expect(formatUtcTickDate("2026-01-05", 63)).toBe("Jan 05");
    expect(formatUtcTickDate("2026-11-23", 126)).toBe("Nov 23");
    expect(formatUtcTickDate("2026-11-23", 252)).toBe("Nov 26");
    expect(formatUtcTickDate("2025-03-01", 504)).toBe("Mar 25");
    expect(formatUtcTickDate("not-a-date", 252)).toBe("not-a-date");
    expect(formatUtcTickDate("2026-13-01", 63)).toBe("2026-13-01");
    expect(formatUtcTickDate("2026-01-00", 63)).toBe("2026-01-00");
  });

  it("produces basis badges and provenance caveats for own, proxy, and unavailable payloads", () => {
    const proxy = makePayload();
    expect(basisBadgeText(proxy)).toBe("Proxy: VIX");
    expect(basisCaveatText(proxy)).toContain("Cboe VIX");
    expect(basisCaveatText(proxy)).toContain("12 of 252");

    const own = makePayload({
      basis: "own_atm_iv",
      proxyIndex: null,
      unit: "decimal",
    });
    expect(basisBadgeText(own)).toBe("Own 30d ATM IV");
    expect(basisCaveatText(own)).toContain("openbb_option_iv_daily");

    const unavailable = makePayload({
      basis: null,
      latest: null,
      points: [],
      proxy: null,
      proxyIndex: null,
      reason: "Own ATM IV: No ATM IV sessions stored",
      symbol: "NVDA",
      unit: null,
    });
    expect(basisBadgeText(unavailable)).toBe("No 1y basis");
    expect(basisCaveatText(unavailable)).toBeNull();
  });

  it("splits IV rank polylines across null flat-range gaps and keeps isolated single points visible", () => {
    const payload = makePayload({
      points: [
        makePoint({ date: "2026-01-02", ivPercentile: 10, ivRank: 10 }),
        makePoint({ date: "2026-01-03", ivPercentile: 20, ivRank: 20 }),
        makePoint({ date: "2026-01-04", ivPercentile: 30, ivRank: null }),
        makePoint({ date: "2026-01-05", ivPercentile: 40, ivRank: 40 }),
        makePoint({ date: "2026-01-06", ivPercentile: 50, ivRank: null }),
        makePoint({ date: "2026-01-07", ivPercentile: 80, ivRank: 80 }),
        makePoint({ date: "2026-01-08", ivPercentile: 90, ivRank: 90 }),
      ],
      requestedSessions: 63,
    });

    const chart = buildIvRankChart(payload);
    expect(chart.rankSegments).toHaveLength(2);
    expect(chart.rankIsolatedDots).toHaveLength(1);
    expect(chart.rankIsolatedDots[0]?.date).toBe("2026-01-05");
    expect(chart.percentilePolyline.split(" ")).toHaveLength(7);
    expect(chart.latestRankDot?.value).toBe(90);
    expect(chart.latestPercentileDot?.value).toBe(90);
    expect(chart.partialNotice).toBe("Showing 7 of 63 requested sessions");
    expect(chart.singlePointNote).toBeNull();
    expect(chart.highBand.y).toBe(chart.plotTop);
    expect(chart.highBand.height).toBeCloseTo(
      (chart.plotBottom - chart.plotTop) * 0.2,
      0
    );
    expect(chart.lowBand.height).toBeCloseTo(
      (chart.plotBottom - chart.plotTop) * 0.2,
      0
    );
    expect(chart.xTicks).toHaveLength(5);
    expect(chart.xTicks[0]?.label).toBe("Jan 02");
    expect(chart.xTicks.at(-1)?.label).toBe("Jan 08");
    expect(chart.yTicks.map((tick) => tick.value)).toEqual([
      100, 80, 50, 20, 0,
    ]);
  });

  it("handles single-point and empty series without division by zero", () => {
    const single = makePayload({
      points: [makePoint({ date: "2026-11-20", ivPercentile: 60, ivRank: 55 })],
      requestedSessions: 252,
    });
    const singleChart = buildIvRankChart(single);
    expect(singleChart.singlePointNote).toBe("1 rolling session available");
    expect(singleChart.percentilePolyline).toBe("");
    expect(singleChart.rankSegments).toEqual([]);
    expect(singleChart.rankIsolatedDots).toHaveLength(1);
    expect(singleChart.latestRankDot?.x).toBe(
      singleChart.plotLeft + singleChart.plotWidth / 2
    );
    expect(singleChart.xTicks).toEqual([
      {
        label: "Nov 26",
        x: singleChart.plotLeft + singleChart.plotWidth / 2,
      },
    ]);

    const empty = makePayload({
      basis: null,
      latest: null,
      points: [],
      proxy: null,
      proxyIndex: null,
    });
    const emptyChart = buildIvRankChart(empty);
    expect(emptyChart.xTicks).toEqual([]);
    expect(emptyChart.latestPercentileDot).toBeNull();
    expect(emptyChart.latestRankDot).toBeNull();
    expect(emptyChart.partialNotice).toBeNull();
    expect(emptyChart.singlePointNote).toBeNull();
  });

  it("omits partialNotice when the returned points meet the requested horizon", () => {
    const points = Array.from({ length: 63 }, (_, index) =>
      makePoint({
        date: `2026-${String(Math.floor(index / 28) + 1).padStart(2, "0")}-${String((index % 28) + 1).padStart(2, "0")}`,
        ivPercentile: (index / 62) * 100,
        ivRank: (index / 62) * 100,
      })
    );
    const chart = buildIvRankChart(
      makePayload({ points, requestedSessions: 63 })
    );
    expect(chart.partialNotice).toBeNull();
  });

  it("builds descriptive aria labels for ready and unavailable payloads", () => {
    const ready = makePayload();
    const label = ivHistoryAriaLabel(ready);
    expect(label).toContain("SPY");
    expect(label).toContain("1Y");
    expect(label).toContain("Proxy: VIX");
    expect(label).toContain("IV Rank 55.0");
    expect(label).toContain("IV Percentile 58.0");
    expect(label).toContain("Mid range (20–80)");

    const unavailable = makePayload({
      basis: null,
      latest: null,
      points: [],
      proxy: null,
      proxyIndex: null,
      symbol: "NVDA",
    });
    expect(ivHistoryAriaLabel(unavailable)).toBe(
      "NVDA IV rank and percentile history (1Y): not enough history"
    );
  });

  it("builds table rows with newest 10 sessions plus older horizon milestones", () => {
    const points: OpenbbIvHistoryPoint[] = [];
    for (let i = 1; i <= 15; i += 1) {
      const date = `2026-05-${String(i).padStart(2, "0")}`;
      points.push(
        makePoint({
          date,
          high52w: 32,
          iv: 15 + i,
          ivPercentile: i === 2 ? 95 : i === 3 ? 5 : 40 + i,
          ivRank: i === 1 ? 99 : i === 4 ? 2 : i === 14 ? null : 45 + i,
          low52w: 11,
        })
      );
    }

    const rows = buildIvHistoryTableRows(makePayload({ points }));
    // 10 newest (May 15 down to May 06) + 4 distinct older milestones (May 04, 03, 02, 01)
    expect(rows).toHaveLength(14);
    expect(rows[0]?.date).toBe("2026-05-15");
    expect(rows[1]?.ivRankText).toBe("Flat range");
    expect(rows[9]?.date).toBe("2026-05-06");
    expect(rows.slice(10).map((row) => [row.date, row.note])).toEqual([
      ["2026-05-04", "Low IVR"],
      ["2026-05-03", "Low IVP"],
      ["2026-05-02", "High IVP"],
      ["2026-05-01", "High IVR"],
    ]);
    expect(rows[0]?.range52wText).toBe("11.0 – 32.0");

    // Empty points -> empty table
    expect(buildIvHistoryTableRows(makePayload({ points: [] }))).toEqual([]);

    // Shared milestone date combines labels cleanly
    const shared = buildIvHistoryTableRows(
      makePayload({
        basis: "own_atm_iv",
        points: [
          makePoint({
            date: "2026-11-20",
            high52w: 0.3,
            iv: 0.2,
            ivPercentile: 50,
            ivRank: null,
            low52w: 0.2,
          }),
        ],
        proxyIndex: null,
        unit: "decimal",
      })
    );
    expect(shared).toEqual([
      {
        date: "2026-11-20",
        ivPercentileText: "50.0",
        ivRankText: "Flat range",
        ivText: "20.0%",
        note: "High IVP, Low IVP",
        range52wText: "20.0% – 30.0%",
      },
    ]);
  });
});
