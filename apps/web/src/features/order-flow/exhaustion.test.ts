import type { SignedTrade, TradeSide } from "@darkfactory/api";
import { describe, expect, it } from "vitest";
import { findExhaustion } from "./exhaustion.ts";

const trade = (
  t: number,
  price: number,
  size: number,
  side: TradeSide
): SignedTrade => ({
  ask: null,
  bid: null,
  conditions: null,
  method: "tick",
  price,
  side,
  size,
  t,
  venue: null,
});

describe("findExhaustion", () => {
  it("flags higher highs on shrinking volume and buy delta", () => {
    const runs = findExhaustion(
      [
        trade(0, 100, 820, "buy"),
        trade(10, 101, 560, "buy"),
        trade(20, 102, 340, "buy"),
        trade(30, 103, 180, "buy"),
      ],
      10
    );
    expect(runs).toEqual([
      {
        buckets: 4,
        direction: "up",
        end: 30,
        firstDelta: 820,
        firstVolume: 820,
        lastDelta: 180,
        lastVolume: 180,
        start: 0,
      },
    ]);
  });

  it("flags lower lows on shrinking volume and sell delta", () => {
    const runs = findExhaustion(
      [
        trade(0, 50, 300, "sell"),
        trade(5, 49, 200, "sell"),
        trade(10, 48, 100, "sell"),
      ],
      5
    );
    expect(
      runs.map(({ direction, buckets }) => ({ buckets, direction }))
    ).toEqual([{ buckets: 3, direction: "down" }]);
  });

  it("ignores pushes with growing fuel, gaps and short runs", () => {
    expect(
      findExhaustion(
        [
          trade(0, 100, 100, "buy"),
          trade(10, 101, 200, "buy"),
          trade(20, 102, 300, "buy"),
        ],
        10
      )
    ).toEqual([]);
    expect(
      findExhaustion(
        [
          trade(0, 100, 300, "buy"),
          trade(10, 101, 200, "buy"),
          trade(30, 102, 100, "buy"),
        ],
        10
      )
    ).toEqual([]);
    expect(findExhaustion([], 10)).toEqual([]);
  });
});
