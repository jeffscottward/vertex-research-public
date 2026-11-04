import type {
  SectorRotationMapOutput,
  SectorRotationPoint,
  SectorRotationSeries,
  SectorRotationTimeframe,
} from "@darkfactory/api";

// Fictional ratio and momentum values for tests. Not market data.

export const rotationPoint = (
  date: string,
  ratio: number,
  momentum: number,
  quadrant: SectorRotationPoint["quadrant"]
): SectorRotationPoint => ({ date, momentum, quadrant, ratio });

/** XLK: improving, improving, leading, leading (stored streak of 2 since 2026-10-23). */
export const leaderSeries = (): SectorRotationSeries => ({
  latest: {
    date: "2026-10-30",
    momentum: 101.5,
    periods: 2,
    quadrant: "leading",
    ratio: 101.25,
    since: "2026-10-23",
  },
  name: "Technology",
  points: [
    rotationPoint("2026-10-09", 99.5, 100.4, "improving"),
    rotationPoint("2026-10-16", 99.8, 100.8, "improving"),
    rotationPoint("2026-10-23", 100.6, 101.2, "leading"),
    rotationPoint("2026-10-30", 101.25, 101.5, "leading"),
  ],
  symbol: "XLK",
});

/** XLE: starts one period late, no stored latest, no name. */
export const laggardSeries = (): SectorRotationSeries => ({
  latest: null,
  name: null,
  points: [
    rotationPoint("2026-10-16", 98.4, 99.1, "lagging"),
    rotationPoint("2026-10-23", 98.1, 98.9, "lagging"),
    rotationPoint("2026-10-30", 98.6, 100.2, "improving"),
  ],
  symbol: "XLE",
});

export const mapFixture = (
  overrides: Partial<SectorRotationMapOutput> = {}
): SectorRotationMapOutput => ({
  asOf: "2026-10-30",
  benchmark: "SPY",
  errors: [],
  generatedAt: "2026-10-30T22:00:00.000Z",
  params: {
    momentumLag: 4,
    momentumSmoothing: 3,
    rsSmoothing: 4,
    trendWindow: 26,
  },
  series: [leaderSeries(), laggardSeries()],
  source: "stored",
  timeframe: "weekly" satisfies SectorRotationTimeframe,
  universe: "sectors",
  ...overrides,
});
