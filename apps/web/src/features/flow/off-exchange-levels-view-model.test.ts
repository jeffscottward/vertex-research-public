import type {
  FlowOffExchangeBar,
  FlowOffExchangeLevel,
  FlowOffExchangeLevels,
  FlowOffExchangePrint,
} from "@darkfactory/api";
import { describe, expect, it } from "vitest";
import {
  buildOffExchangeFinraSummary,
  buildOffExchangeLevelRows,
  buildOffExchangePlot,
  nextOffExchangeLevelIndex,
  OFF_EXCHANGE_CHART,
  OFF_EXCHANGE_DEFAULT_RANGE,
  OFF_EXCHANGE_LOADING,
  OFF_EXCHANGE_NO_FINRA,
  OFF_EXCHANGE_NO_PRINTS,
  OFF_EXCHANGE_RANGE_OPTIONS,
  offExchangeAriaLabel,
  offExchangeEmptyLine,
  offExchangeFailureLine,
  offExchangeHeaderLine,
  offExchangeOmittedLine,
  offExchangeRuleText,
  offExchangeSymbolOf,
  offExchangeTitle,
  offExchangeTotalsLine,
} from "./off-exchange-levels-view-model.ts";

const makeBar = (
  overrides: Partial<FlowOffExchangeBar> = {}
): FlowOffExchangeBar => ({
  close: 590.5,
  coveredSeconds: 300,
  high: 591,
  low: 590,
  offExchangeShare: 0.42,
  offExchangeVolume: 42_000,
  open: 590.1,
  possibleSeconds: 900,
  session: "2026-11-20",
  start: "2026-11-20T14:30:00.000Z",
  volume: 100_000,
  vwap: 590.4,
  ...overrides,
});

const makePrint = (
  overrides: Partial<FlowOffExchangePrint> = {}
): FlowOffExchangePrint => ({
  at: "2026-11-20T15:00:00.000Z",
  direction: "bullish",
  key: "print:1:590.5:25000:FINRA",
  levelIndex: 0,
  notional: 14_762_500,
  price: 590.5,
  session: "2026-11-20",
  size: 25_000,
  ...overrides,
});

const makeLevel = (
  overrides: Partial<FlowOffExchangeLevel> = {}
): FlowOffExchangeLevel => ({
  bandHigh: 590.75,
  bandLow: 590.25,
  buyShares: 25_000,
  distanceFromSpot: 0.5,
  distancePct: 0.000_847,
  dominantDirection: "bullish",
  firstAt: "2026-11-20T15:00:00.000Z",
  lastAt: "2026-11-20T16:00:00.000Z",
  maxPrice: 590.6,
  minPrice: 590.4,
  neutralShares: 0,
  price: 590.5,
  prints: 2,
  rank: 1,
  sellShares: 5000,
  totalNotional: 17_715_000,
  totalShares: 30_000,
  ...overrides,
});

const makeResponse = (
  overrides: Partial<FlowOffExchangeLevels> = {}
): FlowOffExchangeLevels => ({
  anchorSession: "2026-11-20",
  bars: [
    makeBar({ start: "2026-11-20T14:30:00.000Z" }),
    makeBar({
      close: 591.2,
      high: 591.5,
      low: 590.4,
      offExchangeShare: 0.5,
      start: "2026-11-20T14:45:00.000Z",
      vwap: 590.9,
    }),
  ],
  bucketMinutes: 15,
  finraWeekly: [
    {
      atsShare: 0.35,
      atsShares: 35_000_000,
      atsTrades: 70_000,
      avgAtsTradeSize: 500,
      lastUpdated: "2026-11-16",
      nonAtsShares: 65_000_000,
      nonAtsTrades: 130_000,
      tier: "T1",
      totalShares: 100_000_000,
      weekStart: "2026-11-09",
    },
    {
      atsShare: 0.4,
      atsShares: 48_000_000,
      atsTrades: 80_000,
      avgAtsTradeSize: 600,
      lastUpdated: "2026-11-23",
      nonAtsShares: 72_000_000,
      nonAtsTrades: 120_000,
      tier: "T1",
      totalShares: 120_000_000,
      weekStart: "2026-11-16",
    },
  ],
  latestPrice: 590,
  latestPriceAt: "2026-11-20T19:00:00.000Z",
  levels: [makeLevel()],
  prints: [makePrint()],
  range: "5d",
  rules: {
    capture: "sampled",
    clusterStep: 0.5,
    finraMaxWeeks: 8,
    maxLevels: 12,
    maxPrints: 200,
    minPrintShares: 10_000,
    readCap: 2000,
    version: "flow-off-exchange-levels-rules.v1",
  },
  schemaVersion: "flow-off-exchange-levels.v1",
  sessions: ["2026-11-20"],
  symbol: "SPY",
  ticks: {
    ageSeconds: 45,
    lastOkAt: "2026-11-20T18:59:15.000Z",
    lastStatus: "ok",
    message: null,
    sessionOpen: true,
    source: "ticks",
    state: "fresh",
  },
  totals: {
    barsCount: 2,
    buyShares: 25_000,
    coveredSeconds: 600,
    neutralShares: 0,
    omittedLevels: 0,
    omittedPrints: 0,
    prints: 1,
    sampledOffExchangeShare: 0.46,
    sampledOffExchangeVolume: 92_000,
    sampledVolume: 200_000,
    sellShares: 5000,
    totalClusterCount: 1,
    totalNotional: 17_715_000,
    totalShares: 30_000,
    truncated: false,
  },
  windowEnd: "2026-11-20T21:00:00.000Z",
  windowStart: "2026-11-20T14:30:00.000Z",
  ...overrides,
});

describe("off-exchange-levels view-model helpers", () => {
  it("maps symbols, titles, and static constants", () => {
    expect(offExchangeSymbolOf("SPY")).toBe("SPY");
    expect(offExchangeSymbolOf("ES")).toBeNull();
    expect(offExchangeSymbolOf("QQQ")).toBeNull();
    expect(offExchangeSymbolOf("NQ")).toBeNull();
    expect(offExchangeTitle("SPY")).toBe("Off-exchange print levels (SPY)");
    expect(OFF_EXCHANGE_DEFAULT_RANGE).toBe("5d");
    expect(OFF_EXCHANGE_RANGE_OPTIONS.map((o) => o.value)).toEqual([
      "1d",
      "5d",
      "14d",
    ]);
    expect(OFF_EXCHANGE_LOADING).toContain("Loading");
    expect(OFF_EXCHANGE_NO_PRINTS).toContain("10,000");
    expect(OFF_EXCHANGE_NO_FINRA).toContain("FINRA");
    expect(OFF_EXCHANGE_CHART.width).toBe(1000);
  });

  it("formats header, totals, omitted, empty, failure, rule, and aria lines", () => {
    const single = makeResponse();
    expect(offExchangeHeaderLine(single)).toContain("Session 2026-11-20");
    expect(offExchangeHeaderLine(single)).toContain("Latest 590.00");
    expect(offExchangeHeaderLine(single)).toContain("Ticks fresh (45s)");

    const multi = makeResponse({
      latestPrice: null,
      sessions: ["2026-11-18", "2026-11-19", "2026-11-20"],
      ticks: { ...single.ticks, ageSeconds: 180, state: "stale" },
    });
    expect(offExchangeHeaderLine(multi)).toContain(
      "3 sessions (2026-11-18 to 2026-11-20)"
    );
    expect(offExchangeHeaderLine(multi)).not.toContain("Latest");
    expect(offExchangeHeaderLine(multi)).toContain("Ticks stale");

    const none = makeResponse({ sessions: [] });
    expect(offExchangeHeaderLine(none)).toContain("No stored tick sessions");

    expect(offExchangeTotalsLine(single)).toContain("1 prints");
    expect(offExchangeTotalsLine(single)).toContain("1 levels");
    expect(offExchangeTotalsLine(single)).toContain("Sampled FINRA TRF share");

    expect(offExchangeOmittedLine(single)).toBeNull();
    const omitted = offExchangeOmittedLine(
      makeResponse({
        totals: {
          ...single.totals,
          omittedLevels: 3,
          omittedPrints: 15,
          prints: 215,
          totalClusterCount: 15,
          truncated: true,
        },
      })
    );
    expect(omitted).toContain("3 smaller bands omitted");
    expect(omitted).toContain("15 older prints");
    expect(omitted).toContain("read cap");

    expect(
      offExchangeEmptyLine(makeResponse({ bars: [], prints: [] }))
    ).toContain("No stored SPY tick minutes");
    expect(offExchangeEmptyLine(makeResponse({ prints: [] }))).toBe(
      OFF_EXCHANGE_NO_PRINTS
    );

    const failure = {
      code: "UNAVAILABLE",
      failedAt: Date.parse("2026-11-20T19:00:00.000Z"),
      message: "db down",
    };
    expect(offExchangeFailureLine(failure, null, 30_000)).toContain(
      "Off-exchange levels not loaded: UNAVAILABLE: db down · retrying every 30 s"
    );
    expect(offExchangeFailureLine(failure, single, 15_000)).toContain(
      "showing stored 5d view · retrying every 15 s"
    );

    expect(offExchangeRuleText(single)).toContain("Research view only");
    expect(offExchangeRuleText(single)).toContain("$0.50 bands");
    expect(offExchangeAriaLabel(single)).toContain(
      "largest level #1 at $590.50"
    );
    expect(offExchangeAriaLabel(makeResponse({ levels: [] }))).toContain(
      "no print levels"
    );
  });

  it("handles keyboard navigation for levels", () => {
    expect(nextOffExchangeLevelIndex("ArrowDown", null, 0)).toBeUndefined();
    expect(nextOffExchangeLevelIndex("Escape", 1, 3)).toBeNull();
    expect(nextOffExchangeLevelIndex("Home", 2, 3)).toBe(0);
    expect(nextOffExchangeLevelIndex("End", 0, 3)).toBe(2);
    expect(nextOffExchangeLevelIndex("ArrowDown", null, 3)).toBe(0);
    expect(nextOffExchangeLevelIndex("ArrowDown", 1, 3)).toBe(2);
    expect(nextOffExchangeLevelIndex("ArrowDown", 2, 3)).toBe(2);
    expect(nextOffExchangeLevelIndex("ArrowUp", null, 3)).toBe(2);
    expect(nextOffExchangeLevelIndex("ArrowUp", 2, 3)).toBe(1);
    expect(nextOffExchangeLevelIndex("ArrowUp", 0, 3)).toBe(0);
    expect(nextOffExchangeLevelIndex("Enter", 0, 3)).toBeUndefined();
  });
});

describe("buildOffExchangePlot", () => {
  it("returns null when both bars and prints are empty", () => {
    expect(
      buildOffExchangePlot(makeResponse({ bars: [], prints: [] }))
    ).toBeNull();
  });

  it("builds single-session geometry with price/vwap segments, spot line, levels, dots, and share bars", () => {
    const response = makeResponse({
      bars: [
        makeBar({ start: "2026-11-20T14:30:00.000Z" }),
        // Gap > 2 * 15m = 30m breaks segment
        makeBar({
          close: 591.2,
          high: 591.5,
          low: 590.8,
          offExchangeShare: null,
          start: "2026-11-20T16:00:00.000Z",
          vwap: 591.0,
        }),
      ],
      levels: [
        makeLevel({ dominantDirection: "bullish", price: 590.5, rank: 1 }),
        // Very close level triggers rail label collision avoidance
        makeLevel({
          bandHigh: 590.6,
          bandLow: 590.45,
          dominantDirection: "bearish",
          firstAt: "2026-11-18T15:00:00.000Z", // outside sessions falls back to first session
          price: 590.52,
          rank: 2,
          totalNotional: 10_000_000,
        }),
        makeLevel({
          bandHigh: 591.6,
          bandLow: 591.2,
          dominantDirection: "neutral",
          price: 591.4,
          rank: 3,
          totalNotional: 6_000_000,
        }),
      ],
      prints: [
        makePrint({ key: "p1", levelIndex: 0 }),
        makePrint({
          at: "2026-11-20T16:15:00.000Z",
          direction: "bearish",
          key: "p2",
          levelIndex: 1,
          notional: 8_000_000,
          price: 590.52,
          size: 13_500,
        }),
      ],
    });
    const plot = buildOffExchangePlot(response);
    expect(plot).not.toBeNull();
    if (plot === null) return;

    expect(plot.priceGridTicks).toHaveLength(5);
    expect(plot.timeTicks).toHaveLength(5);
    expect(plot.timeTicks[0]?.label).toBe("09:30 ET");
    expect(plot.sessionDividers).toHaveLength(1);
    expect(plot.priceSegments).toHaveLength(2);
    expect(plot.vwapSegments).toHaveLength(2);
    expect(plot.spotLine?.label).toBe("Spot $590.00");
    expect(plot.levelLines).toHaveLength(3);
    expect(plot.levelLines[0]?.showRailLabel).toBe(true);
    expect(plot.levelLines[1]?.showRailLabel).toBe(false);
    expect(plot.levelLines[0]?.ariaLabel).toContain("buy-skewed");
    expect(plot.levelLines[1]?.ariaLabel).toContain("sell-skewed");
    expect(plot.levelLines[2]?.ariaLabel).toContain("mixed");
    expect(plot.printDots).toHaveLength(2);
    expect(plot.shareBars).toHaveLength(1);
    for (const seg of [...plot.priceSegments, ...plot.vwapSegments]) {
      expect(seg).not.toContain("NaN");
    }
    for (const line of plot.levelLines) {
      expect(Number.isFinite(line.startX)).toBe(true);
      expect(Number.isFinite(line.y)).toBe(true);
    }
    for (const dot of plot.printDots) {
      expect(Number.isFinite(dot.x)).toBe(true);
      expect(Number.isFinite(dot.y)).toBe(true);
    }
    for (const bar of plot.shareBars) {
      expect(Number.isFinite(bar.x)).toBe(true);
      expect(Number.isFinite(bar.y)).toBe(true);
    }
  });

  it("handles multi-session plots, prints-only fallback without sessions/spot, and flat price span", () => {
    const multi = makeResponse({
      bars: [
        makeBar({
          close: 590,
          high: 590,
          low: 590,
          open: 590,
          session: "2026-11-19",
          start: "2026-11-19T15:00:00.000Z",
          vwap: 590,
        }),
        makeBar({
          close: 590,
          high: 590,
          low: 590,
          open: 590,
          session: "2026-11-20",
          start: "2026-11-20T15:00:00.000Z",
          vwap: 590,
        }),
      ],
      latestPrice: null,
      levels: [],
      prints: [],
      sessions: ["2026-11-19", "2026-11-20"],
    });
    const plot = buildOffExchangePlot(multi);
    expect(plot).not.toBeNull();
    expect(plot?.spotLine).toBeNull();
    expect(plot?.sessionDividers).toHaveLength(1);
    expect(plot?.sessionDividers[0]?.label).toBe("11-20");
    expect(plot?.timeTicks.map((t) => t.label)).toEqual(["11-19", "11-20"]);
    expect(plot?.priceSegments).toHaveLength(2);

    // Prints-only fallback derives sessionList from prints
    const printsOnly = makeResponse({
      bars: [],
      latestPrice: null,
      levels: [makeLevel({ bandHigh: 590.5, bandLow: 590.5, price: 590.5 })],
      prints: [
        makePrint({ session: "2026-11-20" }),
        makePrint({
          at: "2026-11-21T15:00:00.000Z",
          key: "p-unmatched",
          session: "2026-11-21",
        }),
      ],
      sessions: [],
    });
    const printsPlot = buildOffExchangePlot(printsOnly);
    expect(printsPlot?.printDots).toHaveLength(2);
    expect(printsPlot?.priceSegments).toHaveLength(0);
  });

  it("handles unknown print session gracefully via index fallback", () => {
    const response = makeResponse({
      prints: [makePrint({ session: "2026-11-15" })],
      sessions: ["2026-11-20"],
    });
    const plot = buildOffExchangePlot(response);
    expect(plot?.printDots).toHaveLength(1);
  });
});

describe("buildOffExchangeLevelRows", () => {
  it("formats above, below, at, and unknown spot relations and attaches prints per level", () => {
    const response = makeResponse({
      levels: [
        makeLevel({ distanceFromSpot: 1.25, distancePct: 0.0021, rank: 1 }),
        makeLevel({ distanceFromSpot: -0.75, distancePct: -0.0013, rank: 2 }),
        makeLevel({ distanceFromSpot: 0.002, distancePct: 0, rank: 3 }),
        makeLevel({ distanceFromSpot: null, distancePct: null, rank: 4 }),
        makeLevel({ distanceFromSpot: 0.5, distancePct: null, rank: 5 }),
      ],
      prints: [
        makePrint({ key: "p1", levelIndex: 0 }),
        makePrint({ key: "p2", levelIndex: 0, price: 590.55 }),
        makePrint({ key: "p-omitted", levelIndex: null }),
      ],
    });
    const rows = buildOffExchangeLevelRows(response);
    expect(rows).toHaveLength(5);
    expect(rows[0]?.spotRelation).toBe("above");
    expect(rows[0]?.spotDelta).toContain("+0.21%");
    expect(rows[0]?.levelPrints.map((p) => p.key)).toEqual(["p2", "p1"]);
    expect(rows[1]?.spotRelation).toBe("below");
    expect(rows[1]?.spotDelta).toContain("−0.13%");
    expect(rows[1]?.levelPrints).toEqual([]);
    expect(rows[2]?.spotRelation).toBe("at");
    expect(rows[2]?.spotDelta).toContain("0.00%");
    expect(rows[3]?.spotRelation).toBe("no_spot");
    expect(rows[3]?.spotDelta).toBe("no spot");
    expect(rows[4]?.spotDelta).toContain("no spot");
  });
});

describe("buildOffExchangeFinraSummary", () => {
  it("returns null when finraWeekly is empty", () => {
    expect(
      buildOffExchangeFinraSummary(makeResponse({ finraWeekly: [] }))
    ).toBeNull();
  });

  it("builds stacked weekly bars and formats zero-share and null avg trade size", () => {
    const response = makeResponse({
      finraWeekly: [
        {
          atsShare: null,
          atsShares: 0,
          atsTrades: 0,
          avgAtsTradeSize: null,
          lastUpdated: null,
          nonAtsShares: 0,
          nonAtsTrades: 0,
          tier: null,
          totalShares: 0,
          weekStart: "2026-11-09",
        },
        {
          atsShare: 0.4,
          atsShares: 40_000_000,
          atsTrades: 0,
          avgAtsTradeSize: null,
          lastUpdated: "2026-11-23",
          nonAtsShares: 60_000_000,
          nonAtsTrades: 100_000,
          tier: "T1",
          totalShares: 100_000_000,
          weekStart: "2026-11-16",
        },
      ],
    });
    const summary = buildOffExchangeFinraSummary(response);
    expect(summary).not.toBeNull();
    expect(summary?.avgAtsTradeSize).toBe("no value");
    expect(summary?.bars).toHaveLength(2);
    expect(summary?.bars[0]?.atsHeight).toBe(0);
    expect(summary?.bars[1]?.atsHeight).toBeGreaterThan(0);
    expect(summary?.latestWeekStart).toBe("2026-11-16");

    const withAvg = buildOffExchangeFinraSummary(makeResponse());
    expect(withAvg?.avgAtsTradeSize).toBe("600 sh/trade");
  });
});
