import { describe, expect, it } from "vitest";

import { compareTapeWithHistory } from "./flow-tape-audit.ts";
import type { TapePrint } from "./flow-trade-signing.ts";

const T = 1_800_000_000;
const print = (t: number, size: number): TapePrint => [
  t,
  6000,
  size,
  6000,
  6000.25,
];

describe("compareTapeWithHistory", () => {
  it("compares the covered seconds strictly between the first and the last history second", () => {
    const history = [
      { s: 1, t: T },
      { s: 2, t: T + 1 },
      { s: 3, t: T + 1 },
      { s: 4, t: T + 3 },
      { s: 5, t: T + 4 },
    ];
    const tape = [
      print(T, 9), // the first history second is cut by the 1000-print limit: not compared
      print(T + 1, 2),
      print(T + 1, 3),
      print(T + 3, 4),
      print(T + 4, 7), // the last history second can still grow: not compared
    ];
    expect(
      compareTapeWithHistory({
        covered: [[T - 5, T + 10]],
        history,
        tape,
        until: T + 10,
      })
    ).toEqual({
      comparedSeconds: 3,
      fromSecond: T + 1,
      historyContracts: 9,
      historyTrades: 3,
      // T + 2 has no print in either source: it matches.
      matchedSeconds: 3,
      tapeContracts: 9,
      tapeTrades: 3,
      toSecond: T + 3,
    });
  });

  it("counts a second as different when the count or the contracts differ", () => {
    const history = [
      { s: 1, t: T },
      { s: 2, t: T + 1 },
      { s: 3, t: T + 2 },
      { s: 1, t: T + 2 },
      { s: 1, t: T + 5 },
    ];
    const tape = [
      print(T + 1, 5), // same count, other contracts
      print(T + 2, 3), // one print missing
    ];
    expect(
      compareTapeWithHistory({
        covered: [[T, T + 5]],
        history,
        tape,
        until: T + 5,
      })
    ).toMatchObject({
      comparedSeconds: 4,
      historyContracts: 6,
      historyTrades: 3,
      matchedSeconds: 2,
      tapeContracts: 8,
      tapeTrades: 2,
    });
  });

  it("skips seconds the tape does not cover and seconds after until", () => {
    const history = [
      { s: 1, t: T + 3 },
      { s: 1, t: T },
      { s: 1, t: T + 9 },
    ];
    expect(
      compareTapeWithHistory({
        covered: [
          [T + 2, T + 3],
          [T + 6, T + 8],
        ],
        history,
        tape: [print(T + 3, 1)],
        until: T + 6,
      })
    ).toMatchObject({
      comparedSeconds: 3,
      fromSecond: T + 2,
      matchedSeconds: 3,
      toSecond: T + 6,
    });
  });

  it("is null without history or without a compared second", () => {
    const covered = [[T, T + 10]] as const;
    expect(
      compareTapeWithHistory({ covered, history: [], tape: [], until: T + 10 })
    ).toBeNull();
    // Two adjacent history seconds leave no second between them.
    expect(
      compareTapeWithHistory({
        covered,
        history: [
          { s: 1, t: T },
          { s: 1, t: T + 1 },
        ],
        tape: [],
        until: T + 10,
      })
    ).toBeNull();
    expect(
      compareTapeWithHistory({
        covered: [],
        history: [
          { s: 1, t: T },
          { s: 1, t: T + 5 },
        ],
        tape: [],
        until: T + 10,
      })
    ).toBeNull();
  });
});
