import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { createRandom } from "./backtest-analytics.ts";
import { JEV_STANCES } from "./contracts/jev-verdict.ts";
import {
  classifyForecasts,
  DEFAULT_SCORECARD_PARAMS,
  FORECAST_CLASSES,
  FORECAST_STATUSES,
  type ForecastRecord,
  type ForecastRow,
  parseForecastRecords,
  type ScorecardParams,
  type SymbolBars,
  scoreForecasts,
  scoreWindows,
  weekdayNumber,
} from "./forecast-scorecard.ts";
import { at } from "./quant-arrays.ts";

const DAY_MS = 86_400_000;

// Consecutive Monday-to-Friday dates from Monday 2015-01-05.
const weekdays = (count: number): string[] => {
  const dates: string[] = [];
  for (let day = 0; dates.length < count; day += 1) {
    const date = new Date(Date.UTC(2015, 0, 5) + day * DAY_MS);
    if (date.getUTCDay() !== 0 && date.getUTCDay() !== 6)
      dates.push(date.toISOString().slice(0, 10));
  }
  return dates;
};

// A seeded random walk without equal prices.
const walk = (count: number, seed: number): SymbolBars => {
  const random = createRandom(seed);
  const prices: number[] = [];
  let price = 100;
  for (let index = 0; index < count; index += 1) {
    price *= 1 + (random() - 0.48) * 0.04;
    prices.push(price);
  }
  return { dates: weekdays(count), prices };
};

const record = (
  symbol: string,
  dataAsOf: string | null,
  probabilities: readonly [number, number, number] = [0.6, 0.2, 0.2],
  extra: Partial<ForecastRecord> = {}
): ForecastRecord => ({
  dataAsOf,
  decidedAt: null,
  model: null,
  probabilities: {
    BEARISH: probabilities[2],
    BULLISH: probabilities[0],
    NEUTRAL: probabilities[1],
  },
  schemaVersion: 1,
  source: "test",
  sourceVersion: null,
  symbol,
  ...extra,
});

// Small parameters for fast, readable cases.
const SMALL: ScorecardParams = {
  ...DEFAULT_SCORECARD_PARAMS,
  horizonBars: 2,
  minClusters: 3,
  priorMinWindows: 3,
  resamples: 200,
};

const scoredRow = (
  pUp: number,
  prior: number,
  outcome: 0 | 1,
  cluster: number
): ForecastRow => ({
  dataAsOf: "2020-01-01",
  scored: { cluster, outcome, prior, pUp },
  status: "SCORED",
  symbol: "AAA",
});

describe("parseForecastRecords", () => {
  const valid = {
    dataAsOf: "2026-01-05",
    decidedAt: "2026-01-06T14:30:00.000Z",
    model: "jev-1",
    probabilities: { BEARISH: 0.2, BULLISH: 0.5, NEUTRAL: 0.3 },
    schemaVersion: 1,
    source: "jev-verdict",
    sourceVersion: "v1",
    symbol: "SPY",
  };

  it("accepts a valid list and a null date", () => {
    expect(parseForecastRecords([valid, { ...valid, dataAsOf: null }])).toEqual(
      [valid, { ...valid, dataAsOf: null }]
    );
  });

  it.each([
    ["an unknown key", { ...valid, extra: 1 }],
    ["an unknown version", { ...valid, schemaVersion: 2 }],
    ["a lower-case symbol", { ...valid, symbol: "spy" }],
    ["a date with a time", { ...valid, dataAsOf: "2026-01-05T00:00:00Z" }],
    [
      "a time with an offset",
      { ...valid, decidedAt: "2026-01-06T14:30:00+02:00" },
    ],
    [
      "a missing class",
      { ...valid, probabilities: { BEARISH: 0.2, BULLISH: 0.5 } },
    ],
  ])("rejects %s", (_name, input) => {
    expect(() => parseForecastRecords([input])).toThrow();
  });
});

describe("weekdayNumber", () => {
  it("counts Monday-to-Friday days from 1970-01-05", () => {
    expect(weekdayNumber("1970-01-05")).toBe(0);
    expect(weekdayNumber("1970-01-09")).toBe(4);
    expect(weekdayNumber("1970-01-10")).toBe(4);
    expect(weekdayNumber("1970-01-11")).toBe(4);
    expect(weekdayNumber("1970-01-12")).toBe(5);
    expect(weekdayNumber("2026-11-13") - weekdayNumber("2026-11-02")).toBe(9);
  });
});

describe("classifyForecasts", () => {
  // 40 bars; the window from bar 20 to bar 22 is flat.
  const base = walk(40, 11);
  const prices = [...base.prices];
  prices[22] = at(prices, 20);
  const bars: SymbolBars = { dates: base.dates, prices };
  const barsBySymbol = new Map([["AAA", bars]]);
  const day = (index: number): string => at(bars.dates, index);

  it("gives each of the nine statuses and a ledger that adds up", () => {
    const records = [
      record("AAA", day(10), [2, 0, 0]),
      record("ZZZ", day(10)),
      record("AAA", "2014-01-01"),
      record("AAA", null),
      record("AAA", day(10)),
      record("AAA", day(10)),
      record("AAA", day(1)),
      record("AAA", day(39)),
      record("AAA", day(20)),
      record("AAA", day(11)),
    ];
    const rows = classifyForecasts(records, barsBySymbol, SMALL);
    expect(rows.map((row) => row.status)).toEqual([
      "BAD_PROBABILITIES",
      "NO_BARS",
      "NO_DECISION_BAR",
      "NO_DECISION_BAR",
      "SCORED",
      "DUPLICATE",
      "SHORT_HISTORY",
      "PENDING_OUTCOME",
      "FLAT_OUTCOME",
      "OVERLAP",
    ]);
    expect(new Set(rows.map((row) => row.status))).toEqual(
      new Set(FORECAST_STATUSES)
    );
    expect(rows.filter((row) => row.scored !== null)).toHaveLength(1);

    const { ledger } = scoreForecasts(
      records,
      barsBySymbol,
      SMALL,
      createRandom(1)
    );
    const total = (counts: Readonly<Record<string, number>>): number =>
      Object.values(counts).reduce((sum, count) => sum + count, 0);
    expect(ledger.read).toBe(records.length);
    expect(total(ledger.byStatus)).toBe(records.length);
    expect(Object.keys(ledger.bySymbol)).toEqual(["AAA", "ZZZ"]);
    expect(total(at(Object.values(ledger.bySymbol), 0))).toBe(9);
    expect(ledger.bySymbol["ZZZ"]?.NO_BARS).toBe(1);
    expect(ledger.byStatus.NO_DECISION_BAR).toBe(2);
  });

  it("applies the rule in order", () => {
    const rows = classifyForecasts(
      [
        // Bad probabilities first: it takes no duplicate slot.
        record("AAA", day(10), [Number.NaN, 0.5, 0.5]),
        record("AAA", day(10)),
        // Short history takes no overlap slot.
        record("AAA", day(2)),
        record("AAA", day(4)),
        record("AAA", day(12)),
        record("AAA", day(14)),
      ],
      barsBySymbol,
      SMALL
    );
    expect(rows.map((row) => row.status)).toEqual([
      "BAD_PROBABILITIES",
      "SCORED",
      "SHORT_HISTORY",
      "SCORED",
      "SCORED",
      "SCORED",
    ]);
  });

  it("keeps the earliest duplicate: decidedAt, null last, then input position", () => {
    const at9 = (decidedAt: string | null, bullish: number) =>
      record("AAA", day(9), [bullish, 0, 1 - bullish], { decidedAt });
    const rows = classifyForecasts(
      [
        at9(null, 0.1),
        at9("2015-02-01T10:00:00Z", 0.2),
        at9("2015-02-01T09:00:00.500Z", 0.3),
        at9("2015-02-01T09:00:00.500Z", 0.4),
        record("BBB", day(9)),
      ],
      new Map([
        ["AAA", bars],
        ["BBB", bars],
      ]),
      SMALL
    );
    expect(rows.map((row) => row.status)).toEqual([
      "DUPLICATE",
      "DUPLICATE",
      "SCORED",
      "DUPLICATE",
      "SCORED",
    ]);
    expect(at(rows, 2).scored?.pUp).toBeCloseTo(0.3, 12);

    // Two records without a time: input position decides.
    const untimed = classifyForecasts(
      [at9(null, 0.7), at9(null, 0.8)],
      barsBySymbol,
      SMALL
    );
    expect(untimed.map((row) => row.status)).toEqual(["SCORED", "DUPLICATE"]);
  });

  it("checks the probability range and reduces to pUp", () => {
    const statusOf = (probabilities: readonly [number, number, number]) =>
      at(
        classifyForecasts(
          [record("AAA", day(10), probabilities)],
          barsBySymbol,
          SMALL
        ),
        0
      );
    expect(statusOf([-0.1, 0.6, 0.5]).status).toBe("BAD_PROBABILITIES");
    expect(statusOf([0.5, 1.5, 0]).status).toBe("BAD_PROBABILITIES");
    expect(statusOf([0, 0, 0]).status).toBe("BAD_PROBABILITIES");
    expect(statusOf([0.5, Number.POSITIVE_INFINITY, 0]).status).toBe(
      "BAD_PROBABILITIES"
    );
    expect(statusOf([0, 1, 0]).scored?.pUp).toBe(0.5);
    expect(statusOf([0.3, 0.6, 0.1]).scored?.pUp).toBeCloseTo(0.75, 12);

    // A sum of 1.5 is counted and still scored.
    const { ledger } = scoreForecasts(
      [record("AAA", day(10), [0.9, 0.3, 0.3]), record("AAA", day(14))],
      barsBySymbol,
      SMALL,
      createRandom(1)
    );
    expect(ledger.byStatus.SCORED).toBe(2);
    expect(ledger.sumOffTolerance).toBe(1);
    expect(ledger.maxSumDeviation).toBeCloseTo(0.5, 12);
  });

  it("labels with the sign of the return and builds the prior from earlier moved windows", () => {
    // Bars 0..12: windows of 2 bars. Flat windows start at bars 2 and 5.
    const explicit: SymbolBars = {
      dates: weekdays(13),
      prices: [10, 11, 12, 13, 12, 14, 13, 14, 15, 13, 16, 12, 17],
    };
    const rows = classifyForecasts(
      [
        record("AAA", at(explicit.dates, 8)),
        record("AAA", at(explicit.dates, 10)),
      ],
      new Map([["AAA", explicit]]),
      SMALL
    );
    // Decision bar 8: earlier windows start at 0..6: up, up, flat, up, up, flat, up.
    const first = at(rows, 0).scored;
    expect(first?.cluster).toBe(
      Math.floor(weekdayNumber(at(explicit.dates, 8)) / 2)
    );
    expect(first?.outcome).toBe(1);
    expect(first?.pUp).toBeCloseTo(0.75, 12);
    expect(first?.prior).toBe((5 + 1) / (5 + 2));
    // Decision bar 10: two more windows (starts 7 and 8): down, up. Outcome: 17 > 16.
    expect(at(rows, 1).scored?.prior).toBe((6 + 1) / (7 + 2));
    expect(at(rows, 1).scored?.outcome).toBe(1);

    const down = classifyForecasts(
      [record("AAA", at(explicit.dates, 9))],
      new Map([["AAA", explicit]]),
      SMALL
    );
    expect(at(down, 0).scored?.outcome).toBe(0);
  });

  it("needs 250 earlier windows at the default parameters", () => {
    const long = walk(300, 5);
    const statusAt = (index: number) =>
      at(
        classifyForecasts(
          [record("AAA", at(long.dates, index))],
          new Map([["AAA", long]]),
          DEFAULT_SCORECARD_PARAMS
        ),
        0
      ).status;
    expect(statusAt(258)).toBe("SHORT_HISTORY");
    expect(statusAt(259)).toBe("SCORED");
  });

  it("reads no bar after the horizon for the label and none after the decision bar for the prior", () => {
    const original = walk(80, 3);
    const params = { ...SMALL, horizonBars: 10, priorMinWindows: 20 };
    const rowFor = (bars80: SymbolBars) =>
      at(
        classifyForecasts(
          [record("AAA", at(original.dates, 40))],
          new Map([["AAA", bars80]]),
          params
        ),
        0
      );
    const afterHorizon = original.prices.map((price, index) =>
      index > 50 ? price * 3 : price
    );
    expect(rowFor({ dates: original.dates, prices: afterHorizon })).toEqual(
      rowFor(original)
    );
    const afterDecision = original.prices.map((price, index) =>
      index > 40 ? price * 3 : price
    );
    expect(
      rowFor({ dates: original.dates, prices: afterDecision }).scored?.prior
    ).toBe(rowFor(original).scored?.prior);
  });

  it("keeps scored rows when later bars and later records are added", () => {
    const long = walk(90, 9);
    const short: SymbolBars = {
      dates: long.dates.slice(0, 60),
      prices: long.prices.slice(0, 60),
    };
    const early = [
      record("AAA", at(long.dates, 20)),
      record("AAA", at(long.dates, 30)),
    ];
    const before = classifyForecasts(early, new Map([["AAA", short]]), SMALL);
    const after = classifyForecasts(
      [...early, record("AAA", at(long.dates, 70))],
      new Map([["AAA", long]]),
      SMALL
    );
    expect(before.map((row) => row.status)).toEqual(["SCORED", "SCORED"]);
    expect(after.slice(0, 2)).toEqual(before);
    expect(at(after, 2).status).toBe("SCORED");
  });
});

describe("scoreWindows", () => {
  const random = () => createRandom(7);

  it("computes Brier scores, the three skills and the hit counts", () => {
    const rows = [
      scoredRow(0.8, 0.6, 1, 1),
      scoredRow(0.3, 0.6, 0, 1),
      scoredRow(0.5, 0.4, 1, 2),
      scoredRow(0.9, 0.5, 0, 3),
      {
        ...scoredRow(0.5, 0.5, 1, 9),
        scored: null,
        status: "OVERLAP" as const,
      },
    ];
    const score = scoreWindows(rows, SMALL, random());
    const forecast = (0.04 + 0.09 + 0.25 + 0.81) / 4;
    const prior = (0.16 + 0.36 + 0.36 + 0.25) / 4;
    expect(score.scored).toBe(4);
    expect(score.clusters).toBe(3);
    expect(score.minClusters).toBe(3);
    expect(score.brier?.forecast).toBeCloseTo(forecast, 12);
    expect(score.brier?.half).toBeCloseTo(0.25, 12);
    expect(score.brier?.prior).toBeCloseTo(prior, 12);
    expect(score.skill?.half).toBeCloseTo(1 - forecast / 0.25, 12);
    expect(score.skill?.prior).toBeCloseTo(1 - forecast / prior, 12);
    // The half baseline has the lower Brier here.
    expect(score.skill?.best).toBeCloseTo(1 - forecast / 0.25, 12);
    expect(score.hits).toEqual({
      forecastHits: 2,
      losses: 0,
      priorHits: 1,
      sided: 3,
      wins: 1,
    });
    expect(score.interval?.resamples).toBe(200);
    expect(score.interval?.halfWidth).toBeCloseTo(
      ((score.interval?.high ?? 0) - (score.interval?.low ?? 0)) / 2,
      12
    );
  });

  it("uses the prior baseline when its Brier is lower, and counts losses", () => {
    const rows = [
      scoredRow(0.4, 0.9, 1, 1),
      scoredRow(0.6, 0.9, 1, 2),
      scoredRow(0.6, 0.1, 0, 3),
    ];
    const score = scoreWindows(rows, SMALL, random());
    const forecast = (0.36 + 0.16 + 0.36) / 3;
    expect(score.skill?.best).toBeCloseTo(1 - forecast / 0.01, 9);
    expect(score.skill?.best).toBe(score.skill?.prior);
    expect(score.hits).toEqual({
      forecastHits: 1,
      losses: 2,
      priorHits: 3,
      sided: 3,
      wins: 0,
    });
  });

  it("returns null blocks when no window is scored", () => {
    const empty = scoreWindows([], SMALL, random());
    expect(empty).toEqual({
      brier: null,
      clusters: 0,
      hits: { forecastHits: 0, losses: 0, priorHits: 0, sided: 0, wins: 0 },
      interval: null,
      minClusters: 3,
      scored: 0,
      skill: null,
      skillStatus: "NOT_ENOUGH_DATA",
    });
  });

  // One window per cluster with prior 0.5.
  const series = (count: number, pUpFor: (index: number) => number) =>
    Array.from({ length: count }, (_, index) =>
      scoredRow(pUpFor(index), 0.5, index % 2 === 0 ? 1 : 0, index)
    );
  const wide = { ...DEFAULT_SCORECARD_PARAMS, resamples: 400 };

  it("sets the status from the cluster count and the interval", () => {
    const perfect = (index: number) => (index % 2 === 0 ? 1 : 0);
    expect(scoreWindows(series(29, perfect), wide, random()).skillStatus).toBe(
      "NOT_ENOUGH_DATA"
    );
    const skill = scoreWindows(series(30, perfect), wide, random());
    expect(skill.skillStatus).toBe("SKILL");
    expect(skill.skill?.best).toBe(1);
    expect(skill.interval).toEqual({
      halfWidth: 0,
      high: 1,
      low: 1,
      resamples: 400,
    });

    const wrong = scoreWindows(
      series(30, (index) => (index % 2 === 0 ? 0.2 : 0.8)),
      wide,
      random()
    );
    expect(wrong.skillStatus).toBe("WORSE_THAN_BASELINE");
    expect(wrong.interval?.high).toBeLessThan(0);

    // Right in the first half of every four clusters, wrong in the second half.
    const mixed = scoreWindows(
      series(40, (index) => {
        const up = index % 2 === 0;
        const right = index % 4 < 2;
        return up === right ? 0.6 : 0.4;
      }),
      wide,
      random()
    );
    expect(mixed.skillStatus).toBe("UNDECIDED");
    expect(mixed.interval?.low).toBeLessThan(0);
    expect(mixed.interval?.high).toBeGreaterThan(0);
  });

  it("reports SKILL for a forecaster without skill in at most 12% of seeds", () => {
    // 40 clusters, 3 windows each with a shared move. Lean 0.1 with a 55% hit rate against a
    // prior of 0.5 has an expected Brier score equal to the baseline's.
    const params = { ...DEFAULT_SCORECARD_PARAMS, resamples: 500 };
    const seeds = 200;
    let reported = 0;
    for (let seed = 0; seed < seeds; seed += 1) {
      const draw = createRandom(1000 + seed);
      const rows: ForecastRow[] = [];
      for (let cluster = 0; cluster < 40; cluster += 1) {
        const shared = draw() < 0.5 ? 1 : 0;
        for (let member = 0; member < 3; member += 1) {
          const own = draw() < 0.5 ? 1 : 0;
          const outcome = draw() < 0.7 ? shared : own;
          const right = draw() < 0.55;
          const up = right === (outcome === 1);
          rows.push(scoredRow(up ? 0.6 : 0.4, 0.5, outcome, cluster));
        }
      }
      const status = scoreWindows(rows, params, createRandom(seed)).skillStatus;
      reported += Number(status === "SKILL");
    }
    expect(reported / seeds).toBeLessThanOrEqual(0.12);
    // Recorded in the spec ("First run"): keep the two in step.
    expect(reported).toMatchInlineSnapshot("22");
  });
});

describe("scoreForecasts", () => {
  const bars = walk(400, 21);
  const barsBySymbol = new Map([
    ["AAA", bars],
    ["BBB", walk(400, 22)],
  ]);
  const params = { ...SMALL, horizonBars: 5, priorMinWindows: 20 };
  const records = ["AAA", "BBB"].flatMap((symbol) =>
    Array.from({ length: 60 }, (_, index) =>
      record(symbol, at(bars.dates, 40 + index * 5), [
        0.3 + (index % 5) * 0.1,
        0.1,
        0.2,
      ])
    )
  );

  it("gives the same result for the same input and seed, without null numbers", () => {
    const first = scoreForecasts(
      records,
      barsBySymbol,
      params,
      createRandom(7)
    );
    const second = scoreForecasts(
      records,
      barsBySymbol,
      params,
      createRandom(7)
    );
    expect(second).toEqual(first);
    expect(first.source).toBe("test");
    expect(first.version).toBe("1");
    expect(first.labelRuleVersion).toBe("direction-sign-v1");
    expect(first.params).toBe(params);
    expect(first.score.scored).toBe(first.ledger.byStatus.SCORED);
    expect(first.score.scored).toBeGreaterThan(100);
    expect(JSON.stringify(first)).not.toContain("null");
    const other = scoreForecasts(
      records,
      barsBySymbol,
      params,
      createRandom(8)
    );
    expect(other.score.skill).toEqual(first.score.skill);
    expect(other.score.interval).not.toEqual(first.score.interval);
  });

  it("handles an empty list and a list without a scored record", () => {
    const empty = scoreForecasts([], barsBySymbol, params, createRandom(7));
    expect(empty.source).toBeNull();
    expect(empty.ledger).toEqual({
      byStatus: Object.fromEntries(
        FORECAST_STATUSES.map((status) => [status, 0])
      ),
      bySymbol: {},
      maxSumDeviation: 0,
      read: 0,
      sumOffTolerance: 0,
    });
    expect(empty.score.skillStatus).toBe("NOT_ENOUGH_DATA");

    const pending = scoreForecasts(
      [record("AAA", at(bars.dates, 399)), record("BBB", at(bars.dates, 398))],
      barsBySymbol,
      params,
      createRandom(7)
    );
    expect(pending.ledger.byStatus.PENDING_OUTCOME).toBe(2);
    expect(pending.score.scored).toBe(0);
    expect(pending.score.skill).toBeNull();
  });

  it("refuses a list with more than one source", () => {
    expect(() =>
      scoreForecasts(
        [
          record("AAA", null),
          record("AAA", null, [0.6, 0.2, 0.2], { source: "other" }),
        ],
        barsBySymbol,
        params,
        createRandom(7)
      )
    ).toThrow(new RangeError("Forecast records must share one source"));
  });
});

describe("forecast scorecard boundaries", () => {
  it("uses the classes of the JEV verdict", () => {
    expect([...FORECAST_CLASSES]).toEqual([...JEV_STANCES]);
  });

  it("is named by no other file of the package", () => {
    const root = fileURLToPath(new URL(".", import.meta.url));
    const files = readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name));
    expect(files.length).toBeGreaterThan(100);
    const naming = files.filter(
      (file) =>
        !/forecast-scorecard(?:\.test)?\.ts$/u.test(file) &&
        readFileSync(file, "utf8").includes("forecast-scorecard")
    );
    expect(naming).toEqual([]);
  });
});
