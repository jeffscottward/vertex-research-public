import { describe, expect, it } from "vitest";

import type { ResearchReportStoredTechnicals } from "./contracts/research-reports.ts";
import {
  buildResearchReportTechnicals,
  candidatePivots,
  compareWithStored,
  completedBars,
  type DossierBar,
  fibonacciLevels,
  readStoredTechnicals,
  recomputeIndicators,
  swingPivots,
  TECHNICALS_METHOD,
  validRange,
  volumeProfile,
  type WeeklyClose,
  weeklyCloses,
  weinsteinStage,
  wilderAtr,
  wilderRsi,
} from "./research-report-technicals.ts";

// Golden values: the old workspace builders (`scripts/workspace-analysis.mjs` `analyzeHistory`,
// `scripts/analyze-technicals.mjs` `calculateIndicators` and `fibonacciLevels`, branch
// wip/vertex-research-local-20261016) run on the same generated bars on 2026-11-16.
// The port must give the same numbers exactly.

const DAY_MS = 86_400_000;

/** Weekday bars from 2025-01-06: a sine wave on a slow rise (same formula as the golden run). */
const makeHistory = (count: number) => {
  const bars: Record<string, unknown>[] = [];
  let time = Date.parse("2025-01-06T00:00:00Z");
  for (let index = 0; index < count; index += 1) {
    while ([0, 6].includes(new Date(time).getUTCDay())) time += DAY_MS;
    const close = 100 + 10 * Math.sin(index / 7) + index * 0.1;
    bars.push({
      close,
      date: new Date(time).toISOString().slice(0, 10),
      high: close + 1 + (index % 3) * 0.5,
      isPartial: false,
      low: close - 1 - (index % 4) * 0.25,
      open: close,
      volume: 1000 + (index % 5) * 100,
    });
    time += DAY_MS;
  }
  return bars;
};

const HISTORY = makeHistory(260);
const BARS = completedBars(HISTORY);
const LAST_CLOSE = 119.464_618_666_430_01;

const bar = (overrides: Partial<DossierBar> = {}): DossierBar => ({
  close: 10,
  date: "2026-01-05",
  high: 11,
  low: 9,
  volume: 100,
  ...overrides,
});

describe("completedBars", () => {
  it("keeps completed bars with a valid date once and reads missing fields as NaN", () => {
    const bars = completedBars([
      null,
      [1],
      { close: 1, date: "2026-01-02", isPartial: true },
      { close: Number.NaN, date: "2026-01-02" },
      { close: "1", date: "2026-01-02" },
      { close: 1, date: 20_260_102 },
      { close: 1, date: "2026-1-2" },
      { close: 1, date: "2026-02-30" },
      { close: 1, date: "2026-01-02", high: 2, low: 0.5, volume: 3 },
      { close: 9, date: "2026-01-02", high: 10, low: 8, volume: 4 },
      { close: 2, date: "2026-01-05" },
    ]);
    expect(bars).toHaveLength(2);
    expect(bars[0]).toEqual({
      close: 1,
      date: "2026-01-02",
      high: 2,
      low: 0.5,
      volume: 3,
    });
    expect(bars[1]?.high).toBeNaN();
    expect(bars[1]?.volume).toBeNaN();
  });

  it("returns no bars for a history that is not an array", () => {
    expect(completedBars(undefined)).toEqual([]);
    expect(completedBars({ date: "2026-01-02" })).toEqual([]);
  });
});

describe("validRange", () => {
  it("needs a finite high and low that contain the close", () => {
    expect(validRange(bar())).toBe(true);
    expect(validRange(bar({ high: Number.NaN }))).toBe(false);
    expect(validRange(bar({ low: Number.NaN }))).toBe(false);
    expect(validRange(bar({ high: 9.5 }))).toBe(false);
    expect(validRange(bar({ low: 10.5 }))).toBe(false);
    expect(validRange(bar({ close: 10, high: 10, low: 10 }))).toBe(true);
  });
});

describe("wilderRsi", () => {
  it("is null until period + 1 closes and for a series with a missing close", () => {
    expect(wilderRsi([1, 2, 3], 14)).toEqual([null, null, null]);
    expect(wilderRsi([1, Number.NaN, 3, 4], 2)).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it("gives 50 without changes, 100 without losses and the Wilder value otherwise", () => {
    expect(wilderRsi([5, 5, 5, 5], 2)).toEqual([null, null, 50, 50]);
    expect(wilderRsi([1, 2, 3, 4], 2)).toEqual([null, null, 100, 100]);
    // Seed gain 0.5 and loss 0.5 (50); then gain 0.25, loss 1.25: 100 - 100 / 1.2.
    expect(wilderRsi([1, 2, 1, -1], 2)).toEqual([
      null,
      null,
      50,
      100 - 100 / (1 + 0.25 / 1.25),
    ]);
  });
});

describe("wilderAtr", () => {
  it("is null for a short series or a missing high or low", () => {
    expect(wilderAtr([bar()], 2)).toEqual([null]);
    expect(wilderAtr([bar(), bar({ low: Number.NaN })], 2)).toEqual([
      null,
      null,
    ]);
  });

  it("seeds with the first ranges (the first is high - low) and then recurses", () => {
    const bars = [
      bar({ close: 10, high: 11, low: 9 }),
      bar({ close: 14, high: 15, low: 12 }),
      bar({ close: 12, high: 13, low: 11 }),
    ];
    // Ranges: 2, max(3, 5, 2) = 5, max(2, 1, 3) = 3. Seed (2 + 5) / 2 = 3.5; then (3.5 + 3) / 2.
    expect(wilderAtr(bars, 2)).toEqual([null, 3.5, 3.25]);
  });
});

describe("recomputeIndicators", () => {
  it("recomputes the golden values of the old builder exactly", () => {
    expect(recomputeIndicators(BARS)).toEqual({
      asOf: "2026-01-02",
      atr14: 2.908_461_401_062_575,
      latestClose: LAST_CLOSE,
      rsi14: 47.127_871_237_110_13,
      sampleCount: 260,
      sma20: 118.816_069_650_070_83,
      sma50: 122.432_671_025_615_93,
      sma150: 117.605_889_001_451_33,
      sma200: 115.455_588_944_274_94,
    });
  });

  it("leaves values without enough bars empty and ATR empty after one invalid range", () => {
    expect(recomputeIndicators([])).toEqual({
      asOf: null,
      atr14: null,
      latestClose: null,
      rsi14: null,
      sampleCount: 0,
      sma20: null,
      sma50: null,
      sma150: null,
      sma200: null,
    });
    const broken = BARS.map((item, index) =>
      index === 3 ? { ...item, high: item.close - 1 } : item
    );
    expect(recomputeIndicators(broken).atr14).toBeNull();
  });
});

const STORED_BODY = {
  asOf: "2026-01-02",
  atr14: 2.908_461_401_062_575,
  latestClose: LAST_CLOSE,
  maximumObservedHigh: { date: "2025-11-24", drawdownPct: -11.5, price: 135 },
  portfolio: { cash: 1 },
  range52Week: {
    high: 135,
    highDate: "2025-11-24",
    low: 90,
    lowDate: "2025-02-18",
    sampleCount: 251,
  },
  rsi14: 47.127_871_237_110_13,
  sampleCount: 260,
  sma20: 118.816_069_650_070_83,
  sma50: 122.432_671_025_615_93,
  sma150: 117.605_889_001_451_33,
  sma200: 115.455_588_944_274_94,
  sma200Slope: {
    change: 1.5,
    changePct: 1.3,
    fromDate: "2025-12-03",
    toDate: "2026-01-02",
  },
  trendChecks: { closeAboveSma20: true, closeAboveSma50: false },
};

describe("readStoredTechnicals", () => {
  it("reads only the listed fields", () => {
    const stored = readStoredTechnicals(STORED_BODY);
    expect(stored).toMatchObject({
      asOf: "2026-01-02",
      maximumObservedHigh: {
        date: "2025-11-24",
        drawdownPct: -11.5,
        price: 135,
      },
      range52Week: { high: 135, low: 90, sampleCount: 251 },
      sampleCount: 260,
      sma200Slope: { change: 1.5, changePct: 1.3 },
    });
    expect(stored).not.toHaveProperty("portfolio");
    expect(stored.trendChecks.slice(0, 3)).toEqual([
      { key: "closeAboveSma20", passed: true },
      { key: "closeAboveSma50", passed: false },
      { key: "closeAboveSma150", passed: null },
    ]);
    expect(stored.trendChecks).toHaveLength(8);
  });

  it("turns fields of another shape into null", () => {
    const stored = readStoredTechnicals({
      asOf: "account note: not a date",
      maximumObservedHigh: { price: "135" },
      range52Week: { high: 1 },
      rsi14: Number.POSITIVE_INFINITY,
      sampleCount: 2.5,
      sma200Slope: { change: null },
      trendChecks: [true],
    });
    expect(stored).toMatchObject({
      asOf: null,
      maximumObservedHigh: null,
      range52Week: null,
      rsi14: null,
      sampleCount: null,
      sma200Slope: null,
    });
    expect(readStoredTechnicals({ sampleCount: -1 }).sampleCount).toBeNull();
    expect(readStoredTechnicals({ sampleCount: 1e16 }).sampleCount).toBeNull();
    const empty = readStoredTechnicals("not json object");
    expect(empty.latestClose).toBeNull();
    expect(empty.trendChecks.every((check) => check.passed === null)).toBe(
      true
    );
    expect(
      readStoredTechnicals({
        maximumObservedHigh: { price: 2 },
        range52Week: { high: 2, low: 1 },
        sma200Slope: { change: 0 },
      })
    ).toMatchObject({
      maximumObservedHigh: { date: null, drawdownPct: null, price: 2 },
      range52Week: { highDate: null, lowDate: null, sampleCount: null },
      sma200Slope: { changePct: null, fromDate: null, toDate: null },
    });
  });
});

describe("compareWithStored", () => {
  const stored: ResearchReportStoredTechnicals =
    readStoredTechnicals(STORED_BODY);
  const recomputed = recomputeIndicators(BARS);

  it("matches the stored values exactly", () => {
    expect(compareWithStored(stored, recomputed)).toEqual({
      mismatches: [],
      status: "match",
    });
  });

  it("names every field that differs", () => {
    expect(
      compareWithStored({ ...stored, rsi14: 47.1, sma200: null }, recomputed)
    ).toEqual({ mismatches: ["rsi14", "sma200"], status: "mismatch" });
  });

  it("is unavailable without bars or without a stored sample count", () => {
    const unavailable = { mismatches: [], status: "unavailable" };
    expect(compareWithStored(stored, null)).toEqual(unavailable);
    expect(compareWithStored(stored, recomputeIndicators([]))).toEqual(
      unavailable
    );
    expect(
      compareWithStored({ ...stored, sampleCount: null }, recomputed)
    ).toEqual(unavailable);
  });
});

const GOLDEN_PIVOTS = [
  {
    confirmedOn: "2025-10-24",
    date: "2025-10-22",
    kind: "support",
    price: 109.322_23,
  },
  {
    confirmedOn: "2025-10-29",
    date: "2025-10-27",
    kind: "support",
    price: 109.619_684,
  },
  {
    confirmedOn: "2025-11-26",
    date: "2025-11-24",
    kind: "resistance",
    price: 134.916_163,
  },
  {
    confirmedOn: "2025-12-01",
    date: "2025-11-27",
    kind: "resistance",
    price: 134.856_341,
  },
  {
    confirmedOn: "2025-12-25",
    date: "2025-12-23",
    kind: "support",
    price: 113.715_426,
  },
  {
    confirmedOn: "2025-12-25",
    date: "2025-12-23",
    kind: "resistance",
    price: 117.465_426,
  },
  {
    confirmedOn: "2025-12-30",
    date: "2025-12-26",
    kind: "support",
    price: 114.023_616,
  },
];

describe("swingPivots and candidatePivots", () => {
  it("finds the golden pivots of the last 60 sessions", () => {
    expect(swingPivots(BARS)).toEqual(GOLDEN_PIVOTS);
  });

  it("finds no pivot in a short or straight series", () => {
    expect(swingPivots(BARS.slice(0, 4))).toEqual([]);
    expect(swingPivots(Array.from({ length: 10 }, () => bar()))).toEqual([]);
  });

  it("picks the newest support below and resistance above the close", () => {
    expect(candidatePivots(swingPivots(BARS), LAST_CLOSE)).toEqual({
      resistance: GOLDEN_PIVOTS[3],
      support: GOLDEN_PIVOTS[6],
    });
    expect(candidatePivots([], 1)).toEqual({
      resistance: null,
      support: null,
    });
  });
});

describe("fibonacciLevels", () => {
  it("gives the golden levels of the trailing 252-session up swing", () => {
    expect(fibonacciLevels(BARS, LAST_CLOSE)).toEqual({
      direction: "up",
      levels: [
        { price: 134.916_163, ratio: 0 },
        { price: 124.728_964, ratio: 0.236 },
        { price: 118.426_714, ratio: 0.382 },
        { price: 113.333_114, ratio: 0.5 },
        { price: 108.239_515, ratio: 0.618 },
        { price: 100.987_61, ratio: 0.786 },
        { price: 91.750_066, ratio: 1 },
      ],
      nearestAbove: { price: 124.728_964, ratio: 0.236 },
      nearestBelow: { price: 118.426_714, ratio: 0.382 },
      swingHigh: { date: "2025-11-24", price: 134.916_163 },
      swingLow: { date: "2025-02-18", price: 91.750_066 },
      window: 252,
    });
  });

  it("measures a down swing up from the low and has no level beyond the swing", () => {
    const falling = Array.from({ length: 20 }, (_, index) =>
      bar({
        close: 50 - index,
        date: `2026-02-${String(index + 1).padStart(2, "0")}`,
        high: 51 - index,
        low: 49 - index,
      })
    );
    const levels = fibonacciLevels(falling, 100);
    expect(levels?.direction).toBe("down");
    expect(levels?.levels[0]).toEqual({ price: 30, ratio: 0 });
    expect(levels?.nearestAbove).toBeNull();
    expect(levels?.nearestBelow).toEqual({ price: 51, ratio: 1 });
    expect(fibonacciLevels(falling, 1)?.nearestBelow).toBeNull();
  });

  it("skips bars without a high or a low", () => {
    const bars = [
      { ...(BARS.at(-252) as DossierBar), high: Number.NaN, low: Number.NaN },
      ...BARS.slice(-251),
    ];
    const levels = fibonacciLevels(bars, LAST_CLOSE);
    expect(levels?.window).toBe(251);
    expect(levels?.swingHigh).toEqual({
      date: "2025-11-24",
      price: 134.916_163,
    });
  });

  it("is null for fewer than 20 bars, no close or no range", () => {
    expect(fibonacciLevels(BARS.slice(0, 19), 100)).toBeNull();
    expect(fibonacciLevels(BARS, Number.NaN)).toBeNull();
    expect(
      fibonacciLevels(
        Array.from({ length: 20 }, () => bar({ high: 10, low: 10 })),
        10
      )
    ).toBeNull();
    expect(fibonacciLevels([], 10)).toBeNull();
  });
});

describe("weeklyCloses", () => {
  it("keys weeks by Friday and counts a week only after Friday 21:00 UTC", () => {
    const bars = [
      bar({ close: 1, date: "2026-01-05" }),
      bar({ close: 2, date: "2026-01-09" }),
      bar({ close: 3, date: "2026-01-12" }),
      bar({ close: 4, date: "2026-01-15" }),
    ];
    expect(weeklyCloses(bars, "2026-01-15T21:58:00Z")).toEqual([
      { close: 2, week: "2026-01-09" },
    ]);
    // A later bar completes a week whose Friday had no session.
    expect(
      weeklyCloses(
        [
          bar({ close: 1, date: "2026-04-02" }),
          bar({ close: 2, date: "2026-04-06" }),
        ],
        "2026-04-06T21:00:00Z"
      )
    ).toEqual([{ close: 1, week: "2026-04-03" }]);
    expect(weeklyCloses(bars, "2026-01-16T21:00:00Z")).toEqual([
      { close: 2, week: "2026-01-09" },
      { close: 4, week: "2026-01-16" },
    ]);
  });

  it("has no weeks without bars", () => {
    expect(weeklyCloses([], "2026-01-16T21:00:00Z")).toEqual([]);
  });

  it("gives the golden count and last close for the generated bars", () => {
    const weeks = weeklyCloses(BARS, "2026-01-02T21:00:00Z");
    expect(weeks).toHaveLength(52);
    expect(weeks.at(-1)?.close).toBe(LAST_CLOSE);
  });
});

const weeksOf = (closes: readonly number[]): WeeklyClose[] =>
  closes.map((close, index) => ({
    close,
    week: new Date(Date.parse("2025-01-03T00:00:00Z") + index * 7 * DAY_MS)
      .toISOString()
      .slice(0, 10),
  }));
const rising = Array.from({ length: 40 }, (_, index) => 100 + 5 * index);
const falling = Array.from({ length: 40 }, (_, index) => 400 - 5 * index);

describe("weinsteinStage", () => {
  it("needs 34 complete weeks", () => {
    expect(weinsteinStage(weeksOf(rising.slice(0, 33)))).toBeNull();
  });

  it("is Stage 2 above a rising average and Stage 4 below a falling one", () => {
    const advancing = weinsteinStage(weeksOf(rising));
    expect(advancing).toMatchObject({
      completeWeeks: 40,
      label: "Stage 2: advancing",
      stage: 2,
      weekEnding: "2025-10-03",
      weeklyClose: 295,
    });
    expect(advancing?.sma30).toBe(222.5);
    expect(advancing?.sma30ChangePct).toBeGreaterThan(1);
    expect(weinsteinStage(weeksOf(falling))).toMatchObject({
      label: "Stage 4: declining",
      stage: 4,
    });
  });

  it("is Stage 3 after a Stage 2 and Stage 1 after a Stage 4", () => {
    expect(weinsteinStage(weeksOf([...rising, 150]))).toMatchObject({
      label: "Stage 3: topping",
      stage: 3,
    });
    expect(weinsteinStage(weeksOf([...falling, 350]))).toMatchObject({
      label: "Stage 1: basing",
      stage: 1,
    });
  });

  it("classifies only the last 104 weeks, so older history does not change the stage", () => {
    const flat = Array.from({ length: 200 }, () => 100);
    expect(weinsteinStage(weeksOf([...rising, ...flat]))?.stage).toBeNull();
    expect(
      weinsteinStage(weeksOf([...rising, ...flat.slice(0, 60)]))?.stage
    ).toBe(1);
  });

  it("is unavailable when the average falls to zero or below", () => {
    const toZero = Array.from({ length: 40 }, (_, index) =>
      index < 30 ? 0 : 10
    );
    expect(weinsteinStage(weeksOf(toZero))).toBeNull();
  });

  it("is unavailable when the current average is at or below zero", () => {
    const closes = [
      ...Array.from({ length: 36 }, () => 2),
      ...Array.from({ length: 4 }, () => -100),
    ];
    expect(weinsteinStage(weeksOf(closes))).toBeNull();
  });

  it("is unavailable when the average overflows", () => {
    expect(
      weinsteinStage(weeksOf(Array.from({ length: 40 }, () => 1e307)))
    ).toBeNull();
  });

  it("is unavailable when the slope overflows", () => {
    const closes = [
      ...Array.from({ length: 30 }, () => 1e-300),
      ...Array.from({ length: 10 }, () => 1e10),
    ];
    expect(weinsteinStage(weeksOf(closes))).toBeNull();
  });

  it("is unresolved while the average was always flat", () => {
    expect(
      weinsteinStage(weeksOf(Array.from({ length: 40 }, () => 100)))
    ).toMatchObject({
      label: "Stage 1 or 3: unresolved (no earlier Stage 2 or 4)",
      sma30ChangePct: 0,
      stage: null,
    });
  });
});

const flatWindow = (count: number, overrides: Partial<DossierBar> = {}) =>
  Array.from({ length: count }, () =>
    bar({ close: 15, high: 20, low: 10, volume: 0, ...overrides })
  );

describe("volumeProfile", () => {
  it("is null for too few sessions, an invalid range or volume, no range and no volume", () => {
    expect(volumeProfile(flatWindow(19), 15)).toBeNull();
    expect(
      volumeProfile([...flatWindow(19), bar({ high: 9.5 })], 15)
    ).toBeNull();
    expect(
      volumeProfile([...flatWindow(19), bar({ volume: Number.NaN })], 15)
    ).toBeNull();
    expect(
      volumeProfile([...flatWindow(19), bar({ volume: -1 })], 15)
    ).toBeNull();
    expect(volumeProfile(flatWindow(20, { high: 15, low: 15 }), 15)).toBeNull();
    expect(volumeProfile(flatWindow(20), 15)).toBeNull();
  });

  it("puts a one-price day in its bin and takes the lower bin on a POC tie", () => {
    const window = [
      ...flatWindow(18),
      bar({ close: 18, high: 18, low: 18, volume: 500 }),
      bar({ close: 12, high: 12, low: 12, volume: 500 }),
    ];
    const profile = volumeProfile(window, 15);
    expect(profile).toMatchObject({
      binWidth: 0.2,
      closeLocation: "inside",
      high: 20,
      low: 10,
      poc: { high: 12.2, low: 12, volume: 500 },
      sessions: 20,
      totalVolume: 1000,
      valueAreaHigh: 18.2,
      valueAreaLow: 12,
      valueAreaVolumePct: 100,
    });
    expect(profile?.bins).toHaveLength(50);
    expect(volumeProfile(window, 19)?.closeLocation).toBe("above");
    expect(volumeProfile(window, 11)?.closeLocation).toBe("below");
    const top = volumeProfile(
      [
        ...flatWindow(18),
        bar({ close: 10, high: 10, low: 10, volume: 8 }),
        bar({ close: 20, high: 20, low: 20, volume: 9 }),
      ],
      20
    );
    // The POC is the top bin; the value area can grow only down, to the bottom bin.
    expect(top).toMatchObject({
      poc: { high: 20, low: 19.8, volume: 9 },
      valueAreaHigh: 20,
      valueAreaLow: 10,
      valueAreaVolumePct: 100,
    });
  });

  it("spreads each day's volume over its range and stops the value area at 70%", () => {
    const profile = volumeProfile(
      [...flatWindow(19), bar({ close: 15, high: 20, low: 10, volume: 5000 })],
      15
    );
    expect(profile?.totalVolume).toBe(5000);
    expect(profile?.bins.every((bin) => bin.volume === 100)).toBe(true);
    expect(profile?.valueAreaVolumePct).toBeGreaterThanOrEqual(70);
    expect(profile?.valueAreaVolumePct).toBeLessThan(72.1);
  });

  it("is null when the volume total is not a safe integer and keeps huge prices finite", () => {
    expect(volumeProfile(flatWindow(20, { volume: 5e14 }), 15)).toBeNull();
    const huge = 2e302;
    const levels = fibonacciLevels(
      Array.from({ length: 20 }, (_, index) =>
        bar({
          close: huge,
          date: `2026-03-${String(index + 1).padStart(2, "0")}`,
          high: index === 5 ? huge * 2 : huge,
          low: huge,
        })
      ),
      huge
    );
    expect(levels?.swingHigh.price).toBe(huge * 2);
    expect(levels?.levels.every((level) => Number.isFinite(level.price))).toBe(
      true
    );
  });

  it("is null when the price range overflows", () => {
    const wide = [
      ...flatWindow(19, { volume: 1 }),
      bar({ close: 0, high: 1.7e308, low: -1.7e308, volume: 1 }),
    ];
    expect(volumeProfile(wide, 0)).toBeNull();
    expect(fibonacciLevels(wide, 0)).toBeNull();
  });

  it("uses only the last 63 sessions of the generated bars", () => {
    const profile = volumeProfile(BARS, LAST_CLOSE);
    expect(profile?.sessions).toBe(63);
    expect(profile?.endDate).toBe("2026-01-02");
    expect(profile?.startDate).toBe(BARS.at(-63)?.date);
    expect(profile?.totalVolume).toBe(
      BARS.slice(-63).reduce((sum, item) => sum + item.volume, 0)
    );
    expect(profile?.poc.volume).toBe(
      Math.max(...(profile?.bins.map((bin) => bin.volume) ?? []))
    );
  });
});

describe("buildResearchReportTechnicals", () => {
  it("builds every marker from the stored bars and the market collection time", () => {
    const result = buildResearchReportTechnicals({
      assetType: "equity",
      market: { collectedAt: "2026-01-02T21:30:00Z", history: HISTORY },
      technicals: STORED_BODY,
    });
    expect(result.check.status).toBe("match");
    expect(result.bars).toEqual({
      collectedAt: "2026-01-02T21:30:00.000Z",
      count: 260,
      firstDate: "2025-01-06",
      lastDate: "2026-01-02",
    });
    expect(result.pivots).toMatchObject({
      candidateResistance: GOLDEN_PIVOTS[3],
      candidateSupport: GOLDEN_PIVOTS[6],
      lookbackSessions: 60,
    });
    expect(result.weinstein).toMatchObject({
      completeWeeks: 52,
      sma30: 117.735_685,
      weekEnding: "2026-01-02",
      weeklyClose: 119.464_619,
    });
    expect(result.fibonacci?.window).toBe(252);
    expect(result.volumeProfile?.sessions).toBe(63);
    expect(result.method).toBe(TECHNICALS_METHOD);
    expect(result.warnings).toEqual([]);
  });

  it("falls back to the last bar's date when collectedAt is missing or invalid", () => {
    for (const collectedAt of [
      undefined,
      "not a time",
      "secret token 2024",
      "2026-01-02 21:30",
    ]) {
      const result = buildResearchReportTechnicals({
        assetType: null,
        market: { collectedAt, history: HISTORY.slice(0, 259) },
        technicals: STORED_BODY,
      });
      // 2026-01-01 is a Thursday: its week is not complete at 21:00 UTC that day.
      expect(result.weinstein?.weekEnding).toBe("2025-12-26");
      expect(result.bars?.collectedAt).toBeNull();
      expect(result.check).toEqual({
        mismatches: [
          "asOf",
          "sampleCount",
          "latestClose",
          "rsi14",
          "atr14",
          "sma20",
          "sma50",
          "sma150",
          "sma200",
        ],
        status: "mismatch",
      });
    }
  });

  it("names a zero average as the reason when enough weeks exist", () => {
    const history = HISTORY.map((item, index) =>
      index < 150 ? { ...item, close: 0, high: 0, low: 0, open: 0 } : item
    );
    const result = buildResearchReportTechnicals({
      assetType: "equity",
      market: { history },
      technicals: {},
    });
    expect(result.weinstein).toBeNull();
    expect(result.warnings).toContain(
      "Weinstein stage unavailable: the 30-week SMA or its slope is not a finite positive value inside the classified window."
    );
  });

  it("explains each missing marker and warns about futures", () => {
    const result = buildResearchReportTechnicals({
      assetType: "future",
      market: {
        history: HISTORY.slice(0, 19).map((item) => ({
          ...item,
          volume: null,
        })),
      },
      technicals: {},
    });
    expect(result.weinstein).toBeNull();
    expect(result.fibonacci).toBeNull();
    expect(result.volumeProfile).toBeNull();
    expect(result.check.status).toBe("unavailable");
    expect(result.warnings).toEqual([
      "Weinstein stage needs 34 complete weeks; this revision has 3.",
      "Fibonacci levels need at least 20 bars with a price range.",
      "The volume profile needs 20 or more recent bars, each with a valid range and volume.",
      "Continuous futures bars can contain roll gaps; a roll inside a window can distort pivots, Fibonacci levels and the volume profile.",
    ]);
  });

  it("returns only the stored values when the revision has no bars", () => {
    const result = buildResearchReportTechnicals({
      assetType: "equity",
      market: null,
      technicals: STORED_BODY,
    });
    expect(result).toMatchObject({
      bars: null,
      check: { mismatches: [], status: "unavailable" },
      fibonacci: null,
      pivots: null,
      recomputed: null,
      volumeProfile: null,
      weinstein: null,
    });
    expect(result.stored.rsi14).toBe(47.127_871_237_110_13);
    expect(result.warnings).toHaveLength(1);
  });
});
