import { describe, expect, it } from "vitest";

import {
  evaluateAgentRatings,
  PLACEBO_SIMS,
  positionWeight,
  type RatingBars,
  type RatingSeriesInput,
} from "./agent-rating-placebo.ts";
import { seedFrom } from "./backtest-analytics.ts";
import type {
  AgentRating,
  RatingEvaluationOutput,
} from "./contracts/agent-ops.ts";

type Ready = Extract<RatingEvaluationOutput, { status: "ready" }>;

// Consecutive weekdays from 2023-01-02. Bars open at 14:30 UTC, so the UTC date is the trading day.
const weekdays = (count: number): string[] => {
  const dates: string[] = [];
  for (
    let day = Date.UTC(2023, 0, 2);
    dates.length < count;
    day += 86_400_000
  ) {
    const weekday = new Date(day).getUTCDay();
    if (weekday !== 0 && weekday !== 6)
      dates.push(new Date(day).toISOString().slice(0, 10));
  }
  return dates;
};

const barsOf = (
  dates: readonly string[],
  open: readonly number[],
  close: readonly number[]
): RatingBars => ({
  t: Float64Array.from(dates, (date) => Date.parse(`${date}T14:30:00Z`)),
  o: Float64Array.from(open),
  c: Float64Array.from(close),
});

const series = (
  decisions: readonly (readonly [string, AgentRating | null])[],
  costBps = 0
): RatingSeriesInput => ({
  symbol: "SPY",
  timeframe: "1d",
  costBps,
  decisions: decisions.map(([date, rating]) => ({ date, rating })),
});

const ready = (evaluation: RatingEvaluationOutput): Ready => {
  if (evaluation.status !== "ready")
    throw new Error(`expected ready, got ${evaluation.reason}`);
  return evaluation;
};

const strategy = (
  evaluation: Ready,
  key: Ready["strategies"][number]["key"]
) => {
  const found = evaluation.strategies.find((row) => row.key === key);
  if (found === undefined) throw new Error(`missing ${key}`);
  return found;
};

describe("agent rating replay", () => {
  const dates = weekdays(6);
  // Opens and closes chosen so each fill and mark is easy to check by hand.
  const bars = barsOf(
    dates,
    [10, 10, 11, 12, 12, 10],
    [10, 11, 12, 12, 11, 10]
  );

  it("starts at 100 on the first decision close and fills at the next open", () => {
    const evaluation = ready(
      evaluateAgentRatings({
        bars,
        series: series([
          [dates[0] as string, "buy"],
          [dates[2] as string, "sell"],
        ]),
        seedKey: "bt-1",
      })
    );
    const agents = strategy(evaluation, "agents_rating");
    // Buy at the open of bar 1 (10): 10 shares. Marks 110, 120. Sell at the open of bar 3 (12): 120 cash.
    expect(agents.equity.map((point) => point.equity)).toEqual([
      100, 110, 120, 120, 120, 120,
    ]);
    expect(agents.label).toBe("Agents rating only");
    expect(agents.equity[0]).toEqual({ t: dates[0], equity: 100 });
    expect(agents.metrics).toMatchObject({
      totalReturn: expect.closeTo(0.2, 12),
      trades: 2,
      costDrag: 0,
      days: 5,
      maxDrawdown: 0,
    });
    expect(agents.metrics.timeInMarket).toBeCloseTo(2 / 5, 12);
    expect(evaluation).toMatchObject({
      symbol: "SPY",
      timeframe: "1d",
      costBps: 0,
      startDate: dates[0],
      endDate: dates[5],
      days: 5,
      failedDecisions: 0,
    });
    // Buy and hold fills once at the first fill open and holds to the end: 10 shares, last close 10.
    expect(
      strategy(evaluation, "buy_hold").equity.map((point) => point.equity)
    ).toEqual([100, 110, 120, 120, 110, 100]);
    // Fewer than 200 bars before the first decision: no moving-average baseline.
    expect(evaluation.strategies.map((row) => row.key)).toEqual([
      "agents_rating",
      "buy_hold",
    ]);
  });

  it("caps time in market at 100% when the buy commission takes cash below zero", () => {
    const evaluation = ready(
      evaluateAgentRatings({
        bars,
        series: series(
          [
            [dates[0] as string, "buy"],
            [dates[1] as string, "buy"],
          ],
          10
        ),
        seedKey: "bt-cost",
      })
    );
    // The fill buys the whole book and then pays 10 bp from cash, so the raw weight is just above 1.
    for (const key of ["agents_rating", "buy_hold"] as const)
      expect(strategy(evaluation, key).metrics.timeInMarket).toBe(1);
  });

  it("charges cost on traded notional and keeps the position on hold and failed runs", () => {
    const evaluation = ready(
      evaluateAgentRatings({
        bars,
        series: series(
          [
            [dates[0] as string, "overweight"],
            [dates[1] as string, "hold"],
            [dates[2] as string, null],
            [dates[3] as string, "underweight"],
          ],
          10
        ),
        seedKey: "bt-2",
      })
    );
    const agents = strategy(evaluation, "agents_rating");
    // Overweight at 10: 5 shares, cost 0.05, cash 49.95. Hold and the failed run keep 5 shares.
    expect(agents.equity[1]?.equity).toBeCloseTo(49.95 + 5 * 11, 4);
    expect(agents.equity[3]?.equity).toBeCloseTo(49.95 + 5 * 12, 4);
    // Underweight at the open of bar 4 (12): sells 5 shares (60 notional), cost 0.06.
    expect(agents.equity[4]?.equity).toBeCloseTo(49.95 + 60 - 0.06, 4);
    expect(agents.metrics.trades).toBe(2);
    expect(agents.metrics.costDrag).toBeCloseTo(0.0011, 12);
    expect(evaluation.failedDecisions).toBe(1);
  });

  it("lets a later decision on the same bar replace the earlier one", () => {
    // Saturday and Sunday both map to Friday 2023-01-06 (bar 4); only the Sunday rating trades.
    const evaluation = ready(
      evaluateAgentRatings({
        bars: barsOf(
          weekdays(8),
          [10, 10, 10, 10, 10, 10, 10, 10],
          [10, 10, 10, 10, 10, 10, 10, 12]
        ),
        series: series([
          ["2023-01-02", "sell"],
          ["2023-01-07", "underweight"],
          ["2023-01-08", "buy"],
        ]),
        seedKey: "bt-3",
      })
    );
    const agents = strategy(evaluation, "agents_rating");
    expect(agents.metrics.trades).toBe(1);
    expect(agents.metrics.totalReturn).toBeCloseTo(0.2, 12);
    // The replaced Saturday decision shares its bar with the next one: no next-period return.
    expect(evaluation.byRating).toEqual([
      {
        rating: "buy",
        decisions: 1,
        hitRate: 1,
        averageNextReturn: expect.closeTo(0.2, 12),
      },
      {
        rating: "underweight",
        decisions: 1,
        hitRate: null,
        averageNextReturn: null,
      },
      { rating: "sell", decisions: 1, hitRate: 0, averageNextReturn: 0 },
    ]);
  });

  it("reports flat and one-day series without volatility or Sharpe", () => {
    const flatBars = barsOf(weekdays(3), [10, 10, 10], [10, 10, 12]);
    const flat = ready(
      evaluateAgentRatings({
        bars: flatBars,
        series: series([
          ["2023-01-02", "sell"],
          ["2023-01-03", "underweight"],
        ]),
        seedKey: "bt-4",
      })
    );
    expect(strategy(flat, "agents_rating").metrics).toMatchObject({
      totalReturn: 0,
      annualReturn: 0,
      volatility: 0,
      sharpe: null,
      trades: 0,
      timeInMarket: 0,
    });
    // Later decisions after the last bar never trade; one day of history remains.
    const oneDay = ready(
      evaluateAgentRatings({
        bars: flatBars,
        series: series([
          ["2023-01-03", "buy"],
          ["2023-01-04", "hold"],
          ["2023-01-05", "sell"],
        ]),
        seedKey: "bt-5",
      })
    );
    expect(oneDay.days).toBe(1);
    expect(strategy(oneDay, "agents_rating").metrics).toMatchObject({
      volatility: null,
      sharpe: null,
      totalReturn: expect.closeTo(0.2, 12),
    });
  });

  it("reports why an evaluation is unavailable", () => {
    const decisions = series([
      ["2023-01-02", "buy"],
      ["2023-01-04", "sell"],
    ]);
    expect(
      evaluateAgentRatings({
        bars: barsOf([], [], []),
        series: decisions,
        seedKey: "x",
      })
    ).toEqual({ status: "unavailable", reason: "no_bars" });
    expect(
      evaluateAgentRatings({
        bars,
        series: series([["2023-01-02", "buy"]]),
        seedKey: "x",
      })
    ).toEqual({ status: "unavailable", reason: "too_few_decisions" });
    expect(
      evaluateAgentRatings({
        bars: barsOf(["2023-01-03", "2023-01-04"], [1, 1], [1, 1]),
        series: decisions,
        seedKey: "x",
      })
    ).toEqual({ status: "unavailable", reason: "outside_history" });
    expect(
      evaluateAgentRatings({
        bars: barsOf(["2022-12-30"], [1], [1]),
        series: decisions,
        seedKey: "x",
      })
    ).toEqual({ status: "unavailable", reason: "outside_history" });
    expect(() =>
      evaluateAgentRatings({
        bars,
        series: series(
          Array.from({ length: 521 }, () => ["2023-01-02", "buy"] as const)
        ),
        seedKey: "x",
      })
    ).toThrow(RangeError);
  });

  it("refuses zero, negative or non-finite prices the replay or the 200-day average would read", () => {
    const days = weekdays(210);
    const good = days.map((_, index) => 100 + index);
    const evaluate = (open: readonly number[], close: readonly number[]) =>
      evaluateAgentRatings({
        bars: barsOf(days, open, close),
        series: series([
          [days[205] as string, "buy"],
          [days[207] as string, "sell"],
        ]),
        seedKey: "bt-bad",
      });
    const replaced = (index: number, value: number) =>
      good.map((price, at) => (at === index ? value : price));
    const badBars = { status: "unavailable", reason: "bad_bars" };
    expect(evaluate(good, replaced(208, 0))).toEqual(badBars);
    expect(evaluate(replaced(206, Number.NaN), good)).toEqual(badBars);
    expect(evaluate(good, replaced(10, -1))).toEqual(badBars);
    expect(evaluate(good, replaced(209, Number.POSITIVE_INFINITY))).toEqual(
      badBars
    );
    // Opens before the first decision bar are never traded, and closes older than the 200-day
    // window are never read.
    expect(evaluate(replaced(3, 0), replaced(5, 0)).status).toBe("ready");
  });

  it("weighs an empty book as flat", () => {
    expect(positionWeight(50, 100)).toBe(0.5);
    expect(positionWeight(50, 0)).toBe(0);
    expect(positionWeight(0, -1)).toBe(0);
  });
});

describe("Glassbench parity", () => {
  // Fixture replayed by Glassbench simulate.run_ticker at commit 255414b with cost 10 bps: 260 weekday
  // bars and six decisions from bar 205 on, so the 50/200-day rule is defined and the 6! = 720
  // orderings are enumerated.
  const dates = weekdays(260);
  const close = dates.map(
    (_, index) => 100 * (1 + 0.1 * Math.sin(index / 7)) + index * 0.05
  );
  const open = dates.map(
    (_, index) =>
      (index === 0 ? 100 : (close[index - 1] as number)) *
      (1 + 0.002 * Math.cos(index))
  );
  const ratings: [number, AgentRating | null][] = [
    [205, "buy"],
    [212, "hold"],
    [220, "sell"],
    [231, "overweight"],
    [240, null],
    [247, "underweight"],
  ];
  const evaluation = ready(
    evaluateAgentRatings({
      bars: barsOf(dates, open, close),
      series: series(
        ratings.map(([index, rating]) => [dates[index] as string, rating]),
        10
      ),
      seedKey: "parity",
    })
  );

  it("matches the rating, buy-and-hold and moving-average metrics", () => {
    // Glassbench's raw mean weight goes above 1 after a full buy pays its commission (agents
    // 0.421742850519, buy and hold 1.000930768737, MA 1.000131147821); Vertex caps each bar at 1.
    const expected = {
      agents_rating: {
        totalReturn: 0.016_425_560_231_962_29,
        annualReturn: 0.078_994_828_203_608_81,
        volatility: 0.085_068_991_927_922_11,
        sharpe: 0.935_443_713_379_028_8,
        maxDrawdown: -0.067_843_334_959_454_94,
        timeInMarket: 0.421_469_816_959_395_8,
        trades: 4,
        costDrag: 0.003_109_85,
      },
      buy_hold: {
        totalReturn: 0.045_108_107_482_053_85,
        annualReturn: 0.228_624_048_681_248_75,
        volatility: 0.137_397_220_583_197,
        sharpe: 1.566_545_708_787_499_7,
        maxDrawdown: -0.155_607_094_819_565_14,
        timeInMarket: 1,
        trades: 1,
        costDrag: 0.001,
      },
      ma_cross: {
        totalReturn: 0.045_060_006_149_312_05,
        annualReturn: 0.228_360_181_705_311_58,
        volatility: 0.137_274_958_311_747_35,
        sharpe: 1.566_255_039_897_613_6,
        maxDrawdown: -0.155_476_745_191_851_28,
        timeInMarket: 1,
        trades: 3,
        costDrag: 0.001_001,
      },
    } as const;
    for (const [key, metrics] of Object.entries(expected)) {
      const actual = strategy(evaluation, key as keyof typeof expected).metrics;
      expect(actual.days).toBe(54);
      // Glassbench rounds each trade cost to 6 decimals before summing; the replay does not.
      for (const [name, value] of Object.entries(metrics))
        expect(
          actual[name as keyof typeof actual],
          `${key}.${name}`
        ).toBeCloseTo(value, name === "costDrag" ? 7 : 9);
    }
  });

  it("follows the moving-average rule out of a falling market", () => {
    const falling = weekdays(260);
    const prices = falling.map((_, index) => 300 - index);
    const evaluation = ready(
      evaluateAgentRatings({
        bars: barsOf(falling, prices, prices),
        series: series([
          [falling[205] as string, "buy"],
          [falling[210] as string, "sell"],
        ]),
        seedKey: "bt-falling",
      })
    );
    // The 50-day average stays under the 200-day average: the rule stays flat and never trades.
    expect(strategy(evaluation, "ma_cross").metrics).toMatchObject({
      trades: 0,
      totalReturn: 0,
    });
  });

  it("matches the exhaustive placebo band and by-rating hit rates", () => {
    expect(evaluation.placebo).toMatchObject({
      sims: 720,
      exhaustive: true,
      seed: seedFrom("parity"),
    });
    expect(evaluation.placebo.finalP5).toBeCloseTo(90.137, 3);
    expect(evaluation.placebo.finalP50).toBeCloseTo(101.6929, 3);
    expect(evaluation.placebo.finalP95).toBeCloseTo(114.6787, 3);
    expect(evaluation.placebo.p5[0]).toBe(100);
    expect(evaluation.placebo.p50[20]).toBeCloseTo(104.5701, 3);
    expect(evaluation.placebo.p5).toHaveLength(55);
    // 356 of 720 placebo finals end below the agents final and 4 tie with it.
    expect(evaluation.placebo.agentsPercentile).toBeCloseTo(
      ((356 + 4 / 2) / 720) * 100,
      9
    );
    expect(evaluation.failedDecisions).toBe(1);
    expect(evaluation.byRating).toEqual([
      {
        rating: "buy",
        decisions: 1,
        hitRate: 0,
        averageNextReturn: expect.closeTo(-0.002_155_504_622_847_859, 12),
      },
      {
        rating: "overweight",
        decisions: 1,
        hitRate: 0,
        averageNextReturn: expect.closeTo(-0.056_474_399_238_601_76, 12),
      },
      {
        rating: "hold",
        decisions: 1,
        hitRate: null,
        averageNextReturn: expect.closeTo(0.094_249_179_302_787_53, 12),
      },
      {
        rating: "underweight",
        decisions: 1,
        hitRate: 0,
        averageNextReturn: expect.closeTo(0.007_756_812_619_337_472, 12),
      },
      {
        rating: "sell",
        decisions: 1,
        hitRate: 0,
        averageNextReturn: expect.closeTo(0.093_791_113_283_506_98, 12),
      },
    ]);
  });
});

describe("shuffled-rating placebo", () => {
  const dates = weekdays(700);
  const close = dates.map(
    (_, index) => 50 + 10 * Math.sin(index / 11) + index / 20
  );
  const open = dates.map((_, index) => close[Math.max(0, index - 1)] as number);
  const bars = barsOf(dates, open, close);
  const cycle: AgentRating[] = [
    "buy",
    "sell",
    "overweight",
    "underweight",
    "hold",
  ];
  const decisions = series(
    Array.from(
      { length: 12 },
      (_, index) =>
        [
          dates[300 + index * 20] as string,
          cycle[index % cycle.length] as AgentRating,
        ] as const
    ),
    5
  );

  it("draws 1,000 seeded orderings when there are too many to enumerate", () => {
    const first = ready(
      evaluateAgentRatings({ bars, series: decisions, seedKey: "bt-seed" })
    );
    expect(first.placebo).toMatchObject({
      sims: PLACEBO_SIMS,
      exhaustive: false,
      seed: seedFrom("bt-seed"),
    });
    expect(
      evaluateAgentRatings({ bars, series: decisions, seedKey: "bt-seed" })
    ).toEqual(first);
    expect(
      ready(evaluateAgentRatings({ bars, series: decisions, seedKey: "other" }))
        .placebo.finalP50
    ).not.toBe(first.placebo.finalP50);
    // 399 trading days after the first decision: 400 points stay under the 500-point cap.
    expect(strategy(first, "agents_rating").equity).toHaveLength(400);
    expect(first.placebo.p5).toHaveLength(400);
    const { finalP5, finalP50, finalP95, agentsPercentile } = first.placebo;
    expect(finalP5).toBeLessThanOrEqual(finalP50);
    expect(finalP50).toBeLessThanOrEqual(finalP95);
    expect(agentsPercentile).toBeGreaterThanOrEqual(0);
    expect(agentsPercentile).toBeLessThanOrEqual(100);
    // 300 bars of history before the first decision: the moving-average rule is reported.
    expect(first.strategies.map((row) => row.key)).toEqual([
      "agents_rating",
      "buy_hold",
      "ma_cross",
    ]);
    expect(strategy(first, "ma_cross").label).toBe("50/200-day MA rule");
  });

  it("bounds placebo work by simulations times bars and downsamples long curves", () => {
    const evaluation = ready(
      evaluateAgentRatings({
        bars,
        series: series([
          [dates[0] as string, "buy"],
          [dates[1] as string, "sell"],
          [dates[2] as string, "hold"],
        ]),
        seedKey: "bt-bound",
        maxPlaceboSteps: 699 * 4,
      })
    );
    // 3! = 6 orderings exceed the 4 the step budget allows, so it draws 4 instead of enumerating.
    expect(evaluation.placebo).toMatchObject({ sims: 4, exhaustive: false });
    const equity = strategy(evaluation, "agents_rating").equity;
    expect(equity.length).toBeLessThanOrEqual(500);
    expect(equity[0]?.t).toBe(dates[0]);
    expect(equity.at(-1)?.t).toBe(dates[699]);
    expect(evaluation.placebo.p50).toHaveLength(equity.length);
    const tiny = ready(
      evaluateAgentRatings({
        bars,
        series: series([
          [dates[0] as string, "buy"],
          [dates[1] as string, "sell"],
        ]),
        seedKey: "bt-tiny",
        maxPlaceboSteps: 1,
      })
    );
    expect(tiny.placebo).toMatchObject({ sims: 1, exhaustive: false });
  });

  it("enumerates every distinct ordering of repeated ratings once", () => {
    const evaluation = ready(
      evaluateAgentRatings({
        bars,
        series: series([
          [dates[0] as string, "buy"],
          [dates[5] as string, "buy"],
          [dates[10] as string, "sell"],
          [dates[15] as string, "sell"],
        ]),
        seedKey: "bt-multiset",
      })
    );
    // 4! / (2! 2!) = 6 distinct orderings.
    expect(evaluation.placebo).toMatchObject({ sims: 6, exhaustive: true });
  });
});
