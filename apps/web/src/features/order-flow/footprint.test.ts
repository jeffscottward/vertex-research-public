import { describe, expect, it } from "vitest";

import { buildFootprint, pointOfControl } from "./footprint.ts";
import type { SignedTrade, TradeSide } from "./trade-signing.ts";

const signed = (
  t: number,
  price: number,
  size: number,
  side: TradeSide
): SignedTrade => ({
  ask: null,
  bid: null,
  conditions: null,
  method: side === "unknown" ? "none" : "quote",
  price,
  side,
  size,
  t,
  venue: null,
});

// Two 10-second buckets (1000-1009, 1010-1019) over 100.00-100.02.
const TRADES: SignedTrade[] = [
  signed(1000, 100.01, 100, "buy"),
  signed(1002, 100.01, 50, "sell"),
  signed(1004, 100.02, 30, "buy"),
  signed(1009, 100.0, 200, "sell"),
  signed(1012, 100.02, 70, "buy"),
  signed(1015, 100.02, 10, "unknown"),
  signed(1019, 100.01, 40, "sell"),
];

describe("buildFootprint", () => {
  it("prefers IBKR's minTick over the tick guessed from the prints", () => {
    const trades = [
      signed(1000, 100, 10, "buy"),
      signed(1001, 100.5, 10, "sell"),
    ];
    expect(buildFootprint(trades)?.tickSize).toBe(0.5);
    const footprint = buildFootprint(trades, { tickSize: 0.25 });
    expect(footprint?.tickSize).toBe(0.25);
    expect(footprint?.priceStep).toBe(0.25);
    expect(buildFootprint(trades, { tickSize: null })?.tickSize).toBe(0.5);
  });

  it("puts sell (bid-hit) and buy (ask-lift) volume in each time x price cell", () => {
    const footprint = buildFootprint(TRADES, { bucketSeconds: 10 });
    expect(footprint).not.toBeNull();
    if (footprint === null) return;
    expect(footprint.priceStep).toBe(0.01);
    expect(footprint.tickSize).toBe(0.01);
    expect(footprint.levels).toEqual([100.02, 100.01, 100]);
    expect(footprint.buckets.map((bucket) => bucket.start)).toEqual([
      1000, 1010,
    ]);
    const [first, second] = footprint.buckets;
    expect(first?.cells).toEqual([
      { buy: 30, delta: 30, price: 100.02, sell: 0, unsigned: 0, volume: 30 },
      {
        buy: 100,
        delta: 50,
        price: 100.01,
        sell: 50,
        unsigned: 0,
        volume: 150,
      },
      { buy: 0, delta: -200, price: 100, sell: 200, unsigned: 0, volume: 200 },
    ]);
    expect(first).toMatchObject({
      buy: 130,
      delta: -120,
      end: 1010,
      poc: 100,
      sell: 250,
      trades: 4,
      volume: 380,
    });
    // Unsigned prints add volume but not delta.
    expect(second).toMatchObject({
      buy: 70,
      delta: 30,
      poc: 100.02,
      sell: 40,
      trades: 3,
      unsigned: 10,
      volume: 120,
    });
    expect(footprint.maxCellVolume).toBe(200);
  });

  it("auto-sizes buckets and keeps empty buckets so the time axis stays continuous", () => {
    const footprint = buildFootprint([
      signed(1000, 50, 1, "buy"),
      signed(1090, 50, 1, "sell"),
    ]);
    expect(footprint?.bucketSeconds).toBe(5);
    expect(footprint?.buckets).toHaveLength(19);
    expect(footprint?.buckets[5]).toMatchObject({
      cells: [],
      poc: null,
      volume: 0,
    });
  });

  it("groups prices by a chosen step and ignores a step or size that would explode the grid", () => {
    const grouped = buildFootprint(TRADES, {
      bucketSeconds: 60,
      priceStep: 0.02,
    });
    expect(grouped?.levels).toEqual([100.02, 100]);
    expect(grouped?.buckets).toHaveLength(1);
    expect(grouped?.buckets[0]?.cells.map((cell) => cell.volume)).toEqual([
      110, 390,
    ]);
    const sane = buildFootprint(TRADES, {
      bucketSeconds: 0.001,
      priceStep: 0.000_001,
    });
    expect(sane?.priceStep).toBe(0.01);
    expect(sane?.bucketSeconds).toBe(1);
  });

  it("widens the auto step when the tick grid would pass 40 rows", () => {
    const wide = buildFootprint([
      signed(1, 100, 1, "buy"),
      signed(2, 100.01, 1, "buy"),
      signed(3, 101, 1, "sell"),
    ]);
    expect(wide?.tickSize).toBe(0.01);
    expect(wide?.priceStep).toBe(0.05);
    expect(wide?.levels).toHaveLength(21);
  });

  it("returns null without prints", () => {
    expect(buildFootprint([])).toBeNull();
  });
});

describe("pointOfControl", () => {
  it("breaks volume ties toward the middle of the range, then the lower price", () => {
    expect(
      pointOfControl([
        { price: 10, volume: 5 },
        { price: 11, volume: 5 },
        { price: 12, volume: 1 },
      ])
    ).toBe(11);
    expect(
      pointOfControl([
        { price: 10, volume: 5 },
        { price: 11, volume: 1 },
        { price: 12, volume: 5 },
      ])
    ).toBe(10);
    expect(pointOfControl([{ price: 10, volume: 0 }])).toBeNull();
    expect(pointOfControl([])).toBeNull();
  });
});
