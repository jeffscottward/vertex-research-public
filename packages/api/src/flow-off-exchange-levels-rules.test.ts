import { describe, expect, it } from "vitest";
import {
  FLOW_OFF_EXCHANGE_MAX_LEVELS,
  FLOW_OFF_EXCHANGE_MAX_PRINTS,
} from "./contracts/flow.ts";
import {
  foldFinraWeeklyContext,
  foldOffExchangeLevels,
  OFF_EXCHANGE_LEVELS_RULES,
  OFF_EXCHANGE_RANGE_CONFIG,
  type OffExchangeEventRow,
  type OffExchangeFinraRow,
  type OffExchangeMinuteRow,
} from "./flow-off-exchange-levels-rules.ts";

const minute = (
  iso: string,
  close: number,
  overrides: Partial<OffExchangeMinuteRow> = {}
): OffExchangeMinuteRow => ({
  close,
  coveredSeconds: 60,
  high: close + 0.1,
  low: close - 0.1,
  minute: new Date(iso),
  offExchangeVolume: 30_000,
  open: close - 0.05,
  volume: 100_000,
  vwap: close,
  ...overrides,
});

const printEvent = (
  key: string,
  iso: string,
  price: number | null,
  size: number | null,
  direction: OffExchangeEventRow["direction"] = "bullish"
): OffExchangeEventRow => ({
  at: new Date(iso),
  direction,
  key,
  price,
  size,
});

describe("foldOffExchangeLevels", () => {
  it("buckets 1m/5m/15m regular-session bars, skips extended hours, and caps sessions", () => {
    expect(OFF_EXCHANGE_LEVELS_RULES.clusterStep).toBe(0.25);
    expect(OFF_EXCHANGE_RANGE_CONFIG["1d"].bucketMinutes).toBe(1);
    expect(OFF_EXCHANGE_RANGE_CONFIG["5d"].bucketMinutes).toBe(5);
    expect(OFF_EXCHANGE_RANGE_CONFIG["14d"].bucketMinutes).toBe(15);

    // EST = UTC-5: 09:30 ET = 14:30Z, 16:00 ET = 21:00Z.
    const result = foldOffExchangeLevels({
      events: [],
      finraRows: [],
      minutes: [
        // Pre-market (09:29 ET) and after-hours (16:00 ET) must be ignored.
        minute("2026-11-20T14:29:00.000Z", 590),
        minute("2026-11-20T21:00:00.000Z", 595),
        // Non-positive price row ignored.
        minute("2026-11-20T14:32:00.000Z", 0, { open: 0 }),
        // Older session dropped in 1d mode.
        minute("2026-11-19T14:30:00.000Z", 588),
        // Two minutes in the same 5m bucket on 2026-11-20 (when tested with 5d).
        minute("2026-11-20T14:33:00.000Z", 592.5, {
          coveredSeconds: 45,
          high: 592.9,
          low: 592.1,
          offExchangeVolume: 60_000,
          open: 592.2,
          volume: 100_000,
          vwap: 592.5,
        }),
        minute("2026-11-20T14:30:00.000Z", 592.1, {
          coveredSeconds: 30,
          high: 592.3,
          low: 591.9,
          offExchangeVolume: 40_000,
          open: 592,
          volume: 100_000,
          vwap: 592.1,
        }),
      ],
      range: "5d",
      truncated: false,
    });

    expect(result.sessions).toEqual(["2026-11-19", "2026-11-20"]);
    expect(result.bars).toHaveLength(2);
    const merged = result.bars[1];
    expect(merged).toEqual({
      close: 592.5,
      coveredSeconds: 75,
      high: 592.9,
      low: 591.9,
      offExchangeShare: 0.5,
      offExchangeVolume: 100_000,
      open: 592,
      possibleSeconds: 300,
      session: "2026-11-20",
      start: "2026-11-20T14:30:00.000Z",
      volume: 200_000,
      vwap: 592.3,
    });
    expect(result.latestPrice).toBe(592.5);
    expect(result.latestPriceAt).toBe("2026-11-20T14:30:00.000Z");

    // 1d mode keeps only the newest session (2026-11-20) at 1m buckets.
    const oneDay = foldOffExchangeLevels({
      events: [],
      finraRows: [],
      minutes: [
        minute("2026-11-19T14:30:00.000Z", 588),
        minute("2026-11-20T14:30:00.000Z", 592.1, {
          offExchangeVolume: 0,
          volume: 0,
        }),
      ],
      range: "1d",
      truncated: false,
    });
    expect(oneDay.sessions).toEqual(["2026-11-20"]);
    expect(oneDay.bars).toHaveLength(1);
    expect(oneDay.bars[0]?.offExchangeShare).toBeNull();
    expect(oneDay.bars[0]?.vwap).toBe(592.1);
    expect(oneDay.totals.sampledOffExchangeShare).toBeNull();
  });

  it("clusters prints into $0.25 bands with VWAP prices, direction rules, spot distance, and top-10 ranking", () => {
    const events: OffExchangeEventRow[] = [
      // Cluster A ($592.25-$592.50): 3 prints, bullish majority (50k buy, 10k sell = 83% buy)
      printEvent("p1", "2026-11-20T14:35:00.000Z", 592.4, 30_000, "bullish"),
      printEvent("p2", "2026-11-20T15:10:00.000Z", 592.3, 20_000, "bullish"),
      printEvent("p3", "2026-11-20T16:00:00.000Z", 592.45, 10_000, "bearish"),
      // Cluster B ($594.00-$594.25): bearish majority (40k sell, 10k neutral)
      printEvent("p4", "2026-11-20T15:00:00.000Z", 594.1, 40_000, "bearish"),
      printEvent("p5", "2026-11-20T15:20:00.000Z", 594.2, 10_000, "neutral"),
      // Cluster C ($590.00-$590.25): neutral (15k buy, 15k sell, 10k neutral)
      printEvent("p6", "2026-11-20T14:40:00.000Z", 590.0, 15_000, "bullish"),
      printEvent("p7", "2026-11-20T14:45:00.000Z", 590.1, 15_000, "bearish"),
      printEvent("p8", "2026-11-20T14:50:00.000Z", 590.05, 10_000, "neutral"),
      // Invalid rows ignored
      printEvent("bad1", "2026-11-20T14:55:00.000Z", null, 10_000, "neutral"),
      printEvent("bad2", "2026-11-20T14:56:00.000Z", 592.0, 0, "neutral"),
      // Out-of-window session ignored when sessions exist
      printEvent("old", "2026-11-10T14:56:00.000Z", 580.0, 99_000, "bullish"),
    ];

    const result = foldOffExchangeLevels({
      events,
      finraRows: [],
      minutes: [minute("2026-11-20T19:00:00.000Z", 593.0)],
      range: "1d",
      truncated: true,
    });

    expect(result.levels).toHaveLength(3);
    // Cluster A: 60k shares around 592.375 -> ~$35.54M (rank 1)
    expect(result.levels[0]).toMatchObject({
      bandHigh: 592.5,
      bandLow: 592.25,
      buyShares: 50_000,
      dominantDirection: "bullish",
      firstAt: "2026-11-20T14:35:00.000Z",
      lastAt: "2026-11-20T16:00:00.000Z",
      maxPrice: 592.45,
      minPrice: 592.3,
      neutralShares: 0,
      prints: 3,
      rank: 1,
      sellShares: 10_000,
      totalShares: 60_000,
    });
    const expectedVwap =
      (592.4 * 30_000 + 592.3 * 20_000 + 592.45 * 10_000) / 60_000;
    expect(result.levels[0]?.price).toBeCloseTo(expectedVwap, 6);
    expect(result.levels[0]?.distanceFromSpot).toBeCloseTo(
      expectedVwap - 593.0,
      6
    );
    expect(result.levels[0]?.distancePct).toBeCloseTo(
      (expectedVwap - 593.0) / 593.0,
      8
    );

    // Cluster B: 50k shares around 594.12 -> ~$29.71M (rank 2, bearish)
    expect(result.levels[1]?.dominantDirection).toBe("bearish");
    expect(result.levels[1]?.rank).toBe(2);

    // Cluster C: 40k shares around 590.05 -> ~$23.60M (rank 3, neutral)
    expect(result.levels[2]?.dominantDirection).toBe("neutral");
    expect(result.levels[2]?.rank).toBe(3);

    expect(result.totals).toMatchObject({
      buyShares: 65_000,
      neutralShares: 20_000,
      omittedLevels: 0,
      omittedPrints: 0,
      prints: 8,
      sellShares: 65_000,
      totalClusterCount: 3,
      totalShares: 150_000,
      truncated: true,
    });
    // Prints are sorted chronologically and tagged with levelIndex
    expect(result.prints.map((p) => p.key)).toEqual([
      "p1",
      "p6",
      "p7",
      "p8",
      "p4",
      "p2",
      "p5",
      "p3",
    ]);
    expect(result.prints[0]?.levelIndex).toBe(0);
    expect(result.prints[1]?.levelIndex).toBe(2);
  });

  it("caps levels at 10, caps prints at 500, handles tie-breakers and prints without bars", () => {
    // 12 distinct price bands with no minute rows (so distanceFromSpot is null)
    const events: OffExchangeEventRow[] = [];
    for (let i = 0; i < 12; i += 1) {
      events.push(
        printEvent(
          `band-${i}`,
          `2026-11-20T15:${String(i).padStart(2, "0")}:00.000Z`,
          580 + i,
          10_000,
          "neutral"
        )
      );
    }
    // Add 500 extra prints at the same timestamp on band 0 to exercise print cap & key tie-break
    for (let i = 0; i < FLOW_OFF_EXCHANGE_MAX_PRINTS; i += 1) {
      events.push(
        printEvent(
          `extra-${String(i).padStart(4, "0")}`,
          "2026-11-20T16:00:00.000Z",
          580.1,
          10_000,
          "bullish"
        )
      );
    }

    const result = foldOffExchangeLevels({
      events,
      finraRows: [],
      minutes: [],
      range: "5d",
      truncated: false,
    });

    expect(result.latestPrice).toBeNull();
    expect(result.levels).toHaveLength(FLOW_OFF_EXCHANGE_MAX_LEVELS);
    expect(result.levels[0]?.distanceFromSpot).toBeNull();
    expect(result.levels[0]?.distancePct).toBeNull();
    expect(result.totals.totalClusterCount).toBe(12);
    expect(result.totals.omittedLevels).toBe(2);
    expect(result.prints).toHaveLength(FLOW_OFF_EXCHANGE_MAX_PRINTS);
    expect(result.totals.omittedPrints).toBe(12);
    // Prints outside the top 10 levels get levelIndex === null
    const smallResult = foldOffExchangeLevels({
      events: events.slice(0, 12),
      finraRows: [],
      minutes: [],
      range: "5d",
      truncated: false,
    });
    expect(
      smallResult.prints.filter((p) => p.levelIndex === null)
    ).toHaveLength(2);
  });

  it("breaks ties deterministically when notional matches across bands", () => {
    // Same notional (100 * 10000 = 1_000_000 vs 200 * 5000 = 1_000_000 -> more shares wins)
    const result = foldOffExchangeLevels({
      events: [
        printEvent("a", "2026-11-20T15:00:00.000Z", 200, 5000, "neutral"),
        printEvent("b", "2026-11-20T15:01:00.000Z", 100, 10_000, "neutral"),
      ],
      finraRows: [],
      minutes: [],
      range: "1d",
      truncated: false,
    });
    expect(result.levels.map((l) => l.bandLow)).toEqual([100, 200]);
  });
});

describe("foldFinraWeeklyContext", () => {
  it("groups ATS and non-ATS rows by week, keeps newest 8 weeks oldest-first, and handles zeros", () => {
    const rows: OffExchangeFinraRow[] = [];
    for (let i = 1; i <= 10; i += 1) {
      const weekStart = `2026-08-${String(i).padStart(2, "0")}`;
      rows.push({
        lastUpdated: "2026-09-01",
        shares: i * 1_000_000,
        tier: "NMS_TIER_1",
        trades: i * 5000,
        venue: "ats",
        weekStart,
      });
      rows.push({
        lastUpdated: "2026-09-02",
        shares: i * 3_000_000,
        tier: "NMS_TIER_1",
        trades: i * 15_000,
        venue: "non_ats",
        weekStart,
      });
    }
    const weeks = foldFinraWeeklyContext(rows);
    expect(weeks).toHaveLength(8);
    expect(weeks[0]?.weekStart).toBe("2026-08-03");
    expect(weeks[7]?.weekStart).toBe("2026-08-10");
    expect(weeks[7]).toEqual({
      atsShare: 0.25,
      atsShares: 10_000_000,
      atsTrades: 50_000,
      avgAtsTradeSize: 200,
      lastUpdated: "2026-09-02",
      nonAtsShares: 30_000_000,
      nonAtsTrades: 150_000,
      tier: "NMS_TIER_1",
      totalShares: 40_000_000,
      weekStart: "2026-08-10",
    });

    const zeroWeek = foldFinraWeeklyContext([
      {
        lastUpdated: null,
        shares: 0,
        tier: null,
        trades: 0,
        venue: "ats",
        weekStart: "2026-10-19",
      },
    ]);
    expect(zeroWeek).toEqual([
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
        weekStart: "2026-10-19",
      },
    ]);
  });
});
