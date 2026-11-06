import { describe, expect, it } from "vitest";

import { buildDepthLadder, depthSizeNote } from "./depth-ladder.ts";

describe("buildDepthLadder", () => {
  it("merges asks above bids, highest price first, with cumulative size from the best price", () => {
    const ladder = buildDepthLadder({
      asks: [
        { price: 100.03, size: 2, venue: "ARCA" },
        { price: 100.02, size: 1, venue: "NSDQ" },
        { price: 100.02, size: 3, venue: "ARCA" },
      ],
      bids: [
        { price: 99.99, size: 4, venue: "BATS" },
        { price: 100.0, size: 5, venue: "NSDQ" },
      ],
      sizeMultiplier: 100,
    });
    expect(
      ladder.rows.map(
        (row) =>
          `${row.side} ${row.price} ${row.venue} ${row.size} ${row.cumulative} #${row.depth}`
      )
    ).toEqual([
      "ask 100.03 ARCA 200 600 #2",
      "ask 100.02 ARCA 300 400 #1",
      "ask 100.02 NSDQ 100 100 #0",
      "bid 100 NSDQ 500 500 #0",
      "bid 99.99 BATS 400 900 #1",
    ]);
    expect(ladder).toMatchObject({
      bestAsk: 100.02,
      bestBid: 100,
      maxCumulative: 900,
      maxSize: 500,
      sizeMultiplier: 100,
      totalAsk: 600,
      totalBid: 900,
    });
    expect(ladder.spread).toBeCloseTo(0.02, 10);
    expect(ladder.bookState).toBe("normal");
    expect(ladder.mid).toBeCloseTo(100.01, 10);
    expect(ladder.bidShare).toBeCloseTo(0.6, 10);
    expect(new Set(ladder.rows.map((row) => row.key)).size).toBe(5);
  });

  it("handles a one-sided or empty book and a bad multiplier", () => {
    const bidsOnly = buildDepthLadder({
      asks: [],
      bids: [{ price: 4500.25, size: 7, venue: null }],
      sizeMultiplier: 0,
    });
    expect(bidsOnly).toMatchObject({
      bestAsk: null,
      bestBid: 4500.25,
      bookState: null,
      mid: null,
      sizeMultiplier: 1,
      spread: null,
      totalBid: 7,
    });
    const empty = buildDepthLadder({ asks: [], bids: [], sizeMultiplier: 1 });
    expect(empty.rows).toEqual([]);
    expect(empty.bidShare).toBeNull();
    expect(empty.maxSize).toBe(0);
  });

  it("flags locked and crossed books instead of a spread", () => {
    const locked = buildDepthLadder({
      asks: [{ price: 10, size: 1, venue: "ARCA" }],
      bids: [{ price: 10, size: 2, venue: "NSDQ" }],
      sizeMultiplier: 1,
    });
    expect(locked).toMatchObject({ bookState: "locked", spread: null });
    const crossed = buildDepthLadder({
      asks: [{ price: 9.99, size: 1, venue: "ARCA" }],
      bids: [{ price: 10.01, size: 2, venue: "NSDQ" }],
      sizeMultiplier: 1,
    });
    expect(crossed).toMatchObject({ bookState: "crossed", spread: null });
  });
});

describe("depthSizeNote", () => {
  it("explains stock lots as a lower bound and reported sizes otherwise", () => {
    expect(depthSizeNote(100, "shares")).toBe(
      "IBKR reports stock depth in lots of mdSizeMultiplier shares (100), rounded down, so shown shares are a lower bound."
    );
    expect(depthSizeNote(1, "contracts")).toBe(
      "Sizes in contracts as IBKR reports them."
    );
  });
});
