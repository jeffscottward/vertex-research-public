import { describe, expect, it } from "vitest";

import {
  FLOW_TAPE_SPEED_RULES,
  foldTapeBursts,
  type JudgedTapeSecond,
  judgeTapeSeconds,
  type TapeSecond,
} from "./flow-tape-speed-rules.ts";

const T = 1_793_631_600;
/** `count` covered seconds from `start`, each with `trades` trades and as many contracts. */
const flat = (start: number, count: number, trades: number): TapeSecond[] =>
  Array.from({ length: count }, (_, index) => ({
    contracts: trades,
    t: start + index,
    trades,
  }));
const second = (t: number, trades: number, contracts = trades): TapeSecond => ({
  contracts,
  t,
  trades,
});
/** The verdict of the last second of a series. */
const last = (seconds: readonly TapeSecond[]): JudgedTapeSecond =>
  judgeTapeSeconds(seconds).at(-1) as JudgedTapeSecond;

describe("FLOW_TAPE_SPEED_RULES", () => {
  it("is version 1 with its five frozen values", () => {
    expect(FLOW_TAPE_SPEED_RULES).toEqual({
      baselineSeconds: 600,
      floorTrades: 20,
      minBaselineCoveredSeconds: 300,
      multiple: 8,
      version: "flow-tape-speed-rules.v1",
    });
    expect(Object.isFrozen(FLOW_TAPE_SPEED_RULES)).toBe(true);
  });
});

describe("judgeTapeSeconds", () => {
  it("does not evaluate a second with fewer than 300 covered seconds before it", () => {
    expect(last([...flat(T, 299, 10), second(T + 299, 500)])).toEqual({
      baseline: null,
      contracts: 500,
      t: T + 299,
      trades: 500,
      verdict: "not_evaluated",
    });
    expect(last([...flat(T, 300, 10), second(T + 300, 500)])).toMatchObject({
      baseline: 10,
      verdict: "burst",
    });
  });

  it("marks 8 times the baseline and not one trade less", () => {
    const before = flat(T, 600, 10);
    expect(last([...before, second(T + 600, 80)]).verdict).toBe("burst");
    expect(last([...before, second(T + 600, 79)]).verdict).toBe("normal");
  });

  it("needs at least 20 trades, also above 8 times a small baseline", () => {
    const before = flat(T, 600, 1);
    expect(last([...before, second(T + 600, 19)]).verdict).toBe("normal");
    expect(last([...before, second(T + 600, 20)]).verdict).toBe("burst");
  });

  it("marks 20 trades after a covered stretch without a trade", () => {
    expect(last([...flat(T, 600, 0), second(T + 600, 20)])).toMatchObject({
      baseline: 0,
      verdict: "burst",
    });
  });

  it("takes the baseline from the 600 seconds before the second, without the second itself", () => {
    // One second of 6,000 trades at T, then 600 seconds of 10. For T + 600 the window starts at T,
    // so its mean is (6,000 + 599 × 10) ÷ 600; for T + 601 the window starts at T + 1.
    const series = [second(T, 6000), ...flat(T + 1, 601, 10)];
    const judged = judgeTapeSeconds(series);
    expect(judged[600]?.t).toBe(T + 600);
    expect(judged[600]?.baseline).toBeCloseTo((6000 + 599 * 10) / 600, 10);
    expect(judged[601]?.baseline).toBe(10);
  });

  it("counts only covered seconds: an uncovered stretch leaves too few for a verdict", () => {
    // 200 covered seconds, 400 s without coverage, then the second: 200 of 600 are covered.
    expect(last([...flat(T, 200, 10), second(T + 600, 500)]).verdict).toBe(
      "not_evaluated"
    );
    // 300 covered seconds at the start of the window are enough.
    expect(last([...flat(T, 300, 10), second(T + 600, 500)])).toMatchObject({
      baseline: 10,
      verdict: "burst",
    });
  });

  it("gives one second the same verdict whatever the series holds before its baseline", () => {
    const tail = [...flat(T, 600, 10), second(T + 600, 85)];
    const longer = [...flat(T - 2400, 2400, 400), ...tail];
    expect(last(longer)).toEqual(last(tail));
    expect(last(tail)).toMatchObject({ baseline: 10, verdict: "burst" });
  });

  it("uses the rules that the caller passes", () => {
    const rules = {
      ...FLOW_TAPE_SPEED_RULES,
      floorTrades: 5,
      minBaselineCoveredSeconds: 2,
      multiple: 2,
    };
    const judged = judgeTapeSeconds(
      [second(T, 1), second(T + 1, 3), second(T + 2, 5)],
      rules
    );
    expect(judged.map((row) => row.verdict)).toEqual([
      "not_evaluated",
      "not_evaluated",
      "burst",
    ]);
  });

  it("returns an empty list for an empty series", () => {
    expect(judgeTapeSeconds([])).toEqual([]);
    expect(foldTapeBursts([])).toEqual([]);
  });
});

describe("foldTapeBursts", () => {
  const judged = (
    t: number,
    trades: number,
    verdict: JudgedTapeSecond["verdict"] = "burst",
    baseline: number | null = 10
  ): JudgedTapeSecond => ({
    baseline,
    contracts: trades * 2,
    t,
    trades,
    verdict,
  });

  it("joins burst seconds that follow each other into one burst with the baseline of the first", () => {
    expect(
      foldTapeBursts([
        judged(T, 5, "normal"),
        judged(T + 1, 90, "burst", 10),
        judged(T + 2, 140, "burst", 11),
        judged(T + 3, 100, "burst", 12),
        judged(T + 4, 5, "normal"),
      ])
    ).toEqual([
      {
        baseline: 10,
        contracts: 660,
        peakTrades: 140,
        seconds: 3,
        start: T + 1,
      },
    ]);
  });

  it("splits at a normal second and at a second that is not covered", () => {
    expect(
      foldTapeBursts([
        judged(T, 90),
        judged(T + 1, 5, "normal"),
        judged(T + 2, 95),
        // T + 3 is not in the series: it was not covered.
        judged(T + 4, 99),
      ]).map((burst) => [burst.start, burst.seconds, burst.peakTrades])
    ).toEqual([
      [T, 1, 90],
      [T + 2, 1, 95],
      [T + 4, 1, 99],
    ]);
  });

  it("ignores seconds that were not evaluated", () => {
    expect(
      foldTapeBursts([judged(T, 500, "not_evaluated", null), judged(T + 1, 90)])
    ).toEqual([
      {
        baseline: 10,
        contracts: 180,
        peakTrades: 90,
        seconds: 1,
        start: T + 1,
      },
    ]);
  });
});
