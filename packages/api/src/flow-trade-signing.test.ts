import type {
  MarketQuoteTick,
  MarketTradeTick,
} from "./contracts/market-data.ts";
import { describe, expect, it } from "vitest";

import {
  countSigning,
  describeSigning,
  type SignedTrade,
  signTape,
  signTrades,
  type TapePrint,
} from "./flow-trade-signing.ts";

const trade = (t: number, p: number, s = 100): MarketTradeTick => ({
  c: null,
  p,
  s,
  t,
  x: "ARCA",
});
const quote = (t: number, bp: number, ap: number): MarketQuoteTick => ({
  ap,
  as: 5,
  bp,
  bs: 5,
  t,
});

const sides = (signed: readonly SignedTrade[]) =>
  signed.map((item) => `${item.side}/${item.method}`);

describe("signTrades", () => {
  it("ignores a quote more than 5 s older than the print and uses the tick rule", () => {
    const signed = signTrades(
      [trade(10, 100), trade(15, 100.02), trade(16, 99.99), trade(30, 99.98)],
      [quote(10, 99.99, 100.01)]
    );
    // 15 - 10 = 5 s: still usable; 16 - 10 = 6 s: stale, tick rule; 30: stale, tick rule
    expect(sides(signed)).toEqual([
      "unknown/none",
      "buy/quote",
      "sell/tick",
      "sell/tick",
    ]);
    expect(signed[2]?.bid).toBeNull();
  });

  it("uses the quote rule: at or above the ask is a buy, at or below the bid a sell", () => {
    const signed = signTrades(
      [trade(10, 100.02), trade(11, 100.05), trade(12, 100), trade(13, 99.9)],
      [quote(9, 100, 100.02)]
    );
    expect(sides(signed)).toEqual([
      "buy/quote",
      "buy/quote",
      "sell/quote",
      "sell/quote",
    ]);
    expect(signed[0]).toMatchObject({ ask: 100.02, bid: 100, venue: "ARCA" });
  });

  it("falls back to the tick rule inside the spread, comparing with the previous different price", () => {
    const signed = signTrades(
      [
        trade(10, 100.02), // at ask: buy (quote)
        trade(11, 100.01), // inside, down from 100.02: sell (tick)
        trade(12, 100.01), // repeat: still compares with 100.02: sell (tick)
        trade(13, 100.015), // inside, up from 100.01: buy (tick)
      ],
      [quote(10, 100, 100.02)]
    );
    expect(sides(signed)).toEqual([
      "buy/quote",
      "sell/tick",
      "sell/tick",
      "buy/tick",
    ]);
  });

  it("uses only quotes at or before the print, counting the same second", () => {
    const signed = signTrades(
      [trade(10, 50), trade(20, 50.5), trade(24, 50.5)],
      [quote(20, 50.4, 50.5), quote(25, 50.5, 50.6)]
    );
    // t=10 has no quote and no earlier price; t=20 meets the same-second quote at its ask;
    // t=24 still uses the t=20 quote (the t=25 quote is later).
    expect(sides(signed)).toEqual(["unknown/none", "buy/quote", "buy/quote"]);
    expect(signed[0]).toMatchObject({ ask: null, bid: null });
  });

  it("signs prints before the first quote by the tick rule", () => {
    const signed = signTrades(
      [trade(1, 10), trade(2, 9.99), trade(3, 10.01)],
      [quote(100, 9.9, 10.1)]
    );
    expect(sides(signed)).toEqual(["unknown/none", "sell/tick", "buy/tick"]);
  });

  it("ignores locked, crossed and empty quotes", () => {
    const locked = signTrades(
      [trade(1, 10), trade(2, 10.01)],
      [quote(0, 10.01, 10.01)]
    );
    expect(sides(locked)).toEqual(["unknown/none", "buy/tick"]);
    const crossed = signTrades(
      [trade(1, 10), trade(2, 9.99)],
      [quote(0, 10.02, 10)]
    );
    expect(sides(crossed)).toEqual(["unknown/none", "sell/tick"]);
    const empty = signTrades([trade(1, 10), trade(2, 10.5)], [quote(0, 0, 0)]);
    expect(sides(empty)).toEqual(["unknown/none", "buy/tick"]);
  });

  it("leaves repeated prices with no earlier different price unsigned", () => {
    const signed = signTrades([trade(1, 10), trade(2, 10), trade(3, 10)], []);
    expect(sides(signed)).toEqual([
      "unknown/none",
      "unknown/none",
      "unknown/none",
    ]);
  });

  it("sorts prints and quotes by time without reordering same-second prints", () => {
    const signed = signTrades(
      [trade(5, 10.5, 1), trade(1, 10, 2), trade(5, 10.4, 3)],
      [quote(4, 10.4, 10.5), quote(0, 9, 11)]
    );
    expect(signed.map((item) => item.size)).toEqual([2, 1, 3]);
    expect(sides(signed)).toEqual(["unknown/none", "buy/quote", "sell/quote"]);
  });
});

describe("signTape", () => {
  it("uses the quote of each print: at or above the ask is a buy, at or below the bid a sell", () => {
    const signed = signTape(
      [
        [10, 6000.25, 3, 6000, 6000.25],
        [10, 6000, 2, 6000, 6000.25],
        [11, 6000.5, 1, 6000, 6000.25],
        [11, 5999.75, 4, 6000, 6000.25],
      ],
      null
    );
    expect(sides(signed)).toEqual([
      "buy/quote",
      "sell/quote",
      "buy/quote",
      "sell/quote",
    ]);
    expect(signed[0]).toEqual({
      ask: 6000.25,
      bid: 6000,
      conditions: null,
      method: "quote",
      price: 6000.25,
      side: "buy",
      size: 3,
      t: 10,
      venue: null,
    });
  });

  it("gives no quote-rule side for a locked, crossed, empty or half quote", () => {
    const quotes: readonly (readonly [number | null, number | null])[] = [
      [6000, 6000],
      [6000.25, 6000],
      [0, 6000.25],
      [Number.NaN, 6000.25],
      [6000, null],
      [null, 6000.25],
      [null, null],
    ];
    for (const [bid, ask] of quotes) {
      // Without a price before the print the tick rule has no reference either.
      expect(signTape([[10, 6000, 1, bid, ask]], null)).toEqual([
        {
          ask,
          bid,
          conditions: null,
          method: "none",
          price: 6000,
          side: "unknown",
          size: 1,
          t: 10,
          venue: null,
        },
      ]);
      // With one, the tick rule signs the print.
      expect(sides(signTape([[10, 6000, 1, bid, ask]], 5999.75))).toEqual([
        "buy/tick",
      ]);
    }
  });

  it("signs a print without a quote by the tick rule, seeded with the price before the read", () => {
    const prints: TapePrint[] = [
      [10, 6000.25, 1, null, null],
      [11, 6000, 1, null, null],
    ];
    expect(sides(signTape(prints, 6000))).toEqual(["buy/tick", "sell/tick"]);
    expect(sides(signTape(prints, 6000.5))).toEqual(["sell/tick", "sell/tick"]);
    // Without the price before the read the first print has no reference.
    expect(sides(signTape(prints, null))).toEqual([
      "unknown/none",
      "sell/tick",
    ]);
  });

  it("signs a zero tick against the last different price", () => {
    const signed = signTape(
      [
        [10, 6000.25, 1, null, null],
        [10, 6000.25, 1, null, null],
        [11, 6000.25, 1, null, null],
        [12, 6000, 1, null, null],
        [12, 6000, 1, null, null],
      ],
      6000
    );
    expect(sides(signed)).toEqual([
      "buy/tick",
      "buy/tick",
      "buy/tick",
      "sell/tick",
      "sell/tick",
    ]);
    // A zero tick against the seed price has no different earlier price.
    expect(
      sides(
        signTape(
          [
            [10, 6000, 1, null, null],
            [11, 6000, 1, null, null],
            [12, 6000.25, 1, null, null],
          ],
          6000
        )
      )
    ).toEqual(["unknown/none", "unknown/none", "buy/tick"]);
  });

  it("moves the tick-rule reference on a print that the quote rule signs", () => {
    const signed = signTape(
      [
        [10, 6001, 1, 6000.75, 6001],
        [11, 6000.5, 1, null, null],
      ],
      null
    );
    expect(sides(signed)).toEqual(["buy/quote", "sell/tick"]);
  });

  it("keeps the given order and signs like signTrades for the same prints and quotes", () => {
    const fromTape = signTape(
      [
        [10, 100.02, 100, 99.99, 100.01],
        [10, 100, 100, 99.99, 100.01],
        [11, 100.01, 100, 99.99, 100.01],
      ],
      null
    );
    const fromSample = signTrades(
      [trade(10, 100.02), trade(10, 100), trade(11, 100.01)],
      [quote(10, 99.99, 100.01)]
    );
    expect(sides(fromTape)).toEqual(sides(fromSample));
    expect(sides(fromTape)).toEqual(["buy/quote", "sell/tick", "buy/quote"]);
    expect(signTape([], 100)).toEqual([]);
  });
});

describe("countSigning / describeSigning", () => {
  it("counts methods and sides and words the summary", () => {
    const counts = countSigning(
      signTrades(
        [trade(1, 10), trade(2, 10.02), trade(3, 10.01), trade(4, 10)],
        [quote(2, 10, 10.02)]
      )
    );
    expect(counts).toEqual({
      buy: 1,
      none: 1,
      quote: 2,
      sell: 2,
      tick: 1,
      unknown: 1,
    });
    expect(describeSigning(counts)).toBe(
      "2 quote rule · 1 tick rule · 1 unsigned"
    );
    expect(describeSigning(countSigning([]))).toBe("no trades");
  });
});
