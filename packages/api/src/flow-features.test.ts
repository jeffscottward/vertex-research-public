import { describe, expect, it } from "vitest";

import {
  absorptionOf,
  buildBook,
  buildMinuteFeatures,
  countStacks,
  FLOW_INSTRUMENTS,
} from "./flow-features.ts";
import type { SignedTrade } from "./flow-trade-signing.ts";

const T0 = 1_700_000_040; // a minute boundary (divisible by 60)

const signed = (
  t: number,
  price: number,
  size: number,
  side: SignedTrade["side"] = "buy",
  venue: string | null = "ARCA"
): SignedTrade => ({
  ask: null,
  bid: null,
  conditions: null,
  method: "quote",
  price,
  side,
  size,
  t,
  venue,
});

const levels = (
  entries: readonly [number, number, number][]
): Map<number, { buy: number; sell: number }> =>
  new Map(entries.map(([index, buy, sell]) => [index, { buy, sell }]));

describe("FLOW_INSTRUMENTS", () => {
  it("describes SPY and ES", () => {
    expect(FLOW_INSTRUMENTS.SPY).toMatchObject({
      largePrint: 10_000,
      optionsTicker: "SPY",
      secType: "STK",
    });
    expect(FLOW_INSTRUMENTS.ES).toMatchObject({
      exchange: "CME",
      largePrint: 50,
      optionsTicker: "SPX",
      secType: "CONTFUT",
    });
  });
});

describe("countStacks", () => {
  it("counts a buy run of three adjacent imbalanced levels once", () => {
    expect(
      countStacks(
        levels([
          [1, 10, 0],
          [2, 10, 0],
          [3, 10, 0],
          [4, 10, 0],
        ])
      )
    ).toEqual({ buy: 1, sell: 0 });
  });

  it("counts a sell run", () => {
    expect(
      countStacks(
        levels([
          [10, 0, 9],
          [11, 0, 9],
          [12, 0, 9],
        ])
      )
    ).toEqual({ buy: 0, sell: 1 });
  });

  it("breaks a run on a price gap or a balanced level", () => {
    expect(
      countStacks(
        levels([
          [1, 10, 0],
          [2, 10, 0],
          [4, 10, 0],
          [5, 10, 0],
        ])
      )
    ).toEqual({ buy: 0, sell: 0 });
    // Level 2 buys 10 against 5 sells at level 1: below the 3:1 ratio.
    expect(
      countStacks(
        levels([
          [1, 10, 5],
          [2, 10, 0],
          [3, 10, 0],
        ])
      )
    ).toEqual({ buy: 0, sell: 0 });
  });

  it("returns zero for an empty map", () => {
    expect(countStacks(new Map())).toEqual({ buy: 0, sell: 0 });
  });
});

describe("absorptionOf", () => {
  it("needs enough trades, volume and one-sided delta", () => {
    expect(absorptionOf(29, 100, 100, 1, 1)).toBeNull();
    expect(absorptionOf(30, 0, 0, 1, 1)).toBeNull();
    expect(absorptionOf(30, 100, 39, 1, 1)).toBeNull();
  });

  it("reads buy and sell absorption only when price did not follow", () => {
    expect(absorptionOf(30, 100, 50, 2, 2)).toBe("buy");
    expect(absorptionOf(30, 100, 50, 1, 2)).toBeNull();
    expect(absorptionOf(30, 100, -50, 2, 2)).toBe("sell");
    expect(absorptionOf(30, 100, -50, 2, 1)).toBeNull();
  });
});

describe("buildMinuteFeatures", () => {
  it("returns nothing for no trades", () => {
    expect(buildMinuteFeatures(FLOW_INSTRUMENTS.SPY, [], 0.01)).toEqual({
      events: [],
      minutes: [],
    });
  });

  it("aggregates a minute with large, off-exchange and unlabelled prints", () => {
    const trades = [
      signed(T0 + 50, 101, 20_000, "sell", "FINRA"),
      signed(T0 + 10, 100, 100, "buy", "ARCA"),
      signed(T0 + 20, 102, 10_000, "buy", null),
      signed(T0 + 30, 99, 300, "unknown", "IEX"),
      signed(T0 + 40, 100, 10_000, "unknown", "XYZ"),
    ];
    const { events, minutes } = buildMinuteFeatures(
      FLOW_INSTRUMENTS.SPY,
      trades,
      0.01
    );
    expect(minutes).toHaveLength(1);
    const [row] = minutes;
    expect(row).toMatchObject({
      absorption: null,
      buyVolume: 10_100,
      close: 101,
      coveredSeconds: 41,
      delta: 10_100 - 20_000,
      high: 102,
      largePrints: 3,
      largePrintVolume: 40_000,
      low: 99,
      offExchangeVolume: 20_000,
      open: 100,
      sellVolume: 20_000,
      stackedBuy: 0,
      stackedSell: 0,
      symbol: "SPY",
      trades: 5,
      volume: 40_400,
    });
    expect(row?.minute).toEqual(new Date(T0 * 1000));
    expect(row?.vwap).toBeCloseTo(
      (100 * 100 + 102 * 10_000 + 99 * 300 + 100 * 10_000 + 101 * 20_000) /
        40_400
    );
    expect(events.map((event) => [event.kind, event.direction])).toEqual([
      ["large_print", "bullish"],
      ["large_print", "neutral"],
      ["off_exchange_print", "bearish"],
    ]);
    expect(events[0]).toMatchObject({
      detail: "10000 @ 102, buy (quote rule)",
      key: `print:${T0 + 20}:102:10000:`,
      premium: null,
      source: "ibkr",
    });
    expect(events[1]?.detail).toBe("10000 @ 100 on XYZ, unknown (quote rule)");
    expect(events[2]?.detail).toBe(
      "20000 @ 101 off-exchange (FINRA TRF), sell (quote rule)"
    );
    expect(events[2]?.key).toBe(`print:${T0 + 50}:101:20000:FINRA`);
  });

  it("covers partial first and last minutes and falls back to close for vwap", () => {
    const { minutes } = buildMinuteFeatures(
      FLOW_INSTRUMENTS.ES,
      [signed(T0 + 30, 5000, 0, "unknown"), signed(T0 + 65, 5001, 1)],
      0.25
    );
    expect(minutes.map((row) => row.coveredSeconds)).toEqual([30, 6]);
    expect(minutes[0]?.vwap).toBe(5000);
  });

  it("flags buy absorption", () => {
    const trades = Array.from({ length: 30 }, (_, index) =>
      signed(T0 + index, 100, 1, "buy")
    );
    const { events, minutes } = buildMinuteFeatures(
      FLOW_INSTRUMENTS.ES,
      trades,
      0.25
    );
    expect(minutes[0]?.absorption).toBe("buy");
    expect(events).toEqual([
      {
        at: new Date(T0 * 1000),
        detail: "Buying absorbed: delta 30 of 30",
        direction: "bearish",
        key: `absorption:${T0}`,
        kind: "absorption",
        premium: null,
        price: 100,
        size: 30,
        source: "ibkr",
        symbol: "ES",
      },
    ]);
  });

  it("flags sell absorption", () => {
    const trades = Array.from({ length: 30 }, (_, index) =>
      signed(T0 + index, 100, 1, "sell")
    );
    const { events } = buildMinuteFeatures(FLOW_INSTRUMENTS.ES, trades, 0.25);
    expect(events[0]).toMatchObject({
      detail: "Selling absorbed: delta -30 of 30",
      direction: "bullish",
      kind: "absorption",
    });
  });

  it("emits stacked imbalance events with singular and plural detail", () => {
    const buys = [1, 2, 3, 5, 6, 7].map((price, index) =>
      signed(T0 + index, price, 3, "buy")
    );
    const sells = [20, 21, 22].map((price, index) =>
      signed(T0 + 10 + index, price, 3, "sell")
    );
    const { events, minutes } = buildMinuteFeatures(
      FLOW_INSTRUMENTS.ES,
      [...buys, ...sells],
      1
    );
    expect(minutes[0]).toMatchObject({ stackedBuy: 2, stackedSell: 1 });
    const stacks = events.filter((event) => event.kind === "stacked_imbalance");
    expect(stacks).toEqual([
      expect.objectContaining({
        detail: "2 stacked buy imbalances (≥3:1 on ≥3 levels)",
        direction: "bullish",
        key: `stack:buy:${T0}`,
        price: 22,
        size: null,
      }),
      expect.objectContaining({
        detail: "1 stacked sell imbalance (≥3:1 on ≥3 levels)",
        direction: "bearish",
        key: `stack:sell:${T0}`,
      }),
    ]);
  });
});

describe("buildBook", () => {
  const at = new Date("2026-11-09T15:00:00Z");

  it("computes best prices, sizes and pressure", () => {
    expect(
      buildBook(
        "SPY",
        at,
        [
          { price: 99, size: 3 },
          { price: 100, size: 1 },
        ],
        [
          { price: 101, size: 2 },
          { price: 102, size: 2 },
        ],
        100
      )
    ).toEqual({
      askSize: 400,
      at,
      bestAsk: 101,
      bestBid: 100,
      bidSize: 400,
      levels: 4,
      pressure: 0,
      symbol: "SPY",
    });
  });

  it("handles empty sides", () => {
    expect(buildBook("ES", at, [], [], 1)).toEqual({
      askSize: 0,
      at,
      bestAsk: null,
      bestBid: null,
      bidSize: 0,
      levels: 0,
      pressure: null,
      symbol: "ES",
    });
    expect(buildBook("ES", at, [{ price: 1, size: 2 }], [], 1).pressure).toBe(
      1
    );
  });
});
