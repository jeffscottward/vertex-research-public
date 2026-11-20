import { describe, expect, it } from "vitest";

import type { MarketTradeTick } from "./contracts/market-data.ts";
import {
  deepTradesOf,
  type FlowDeepTradeRow,
  sumDeepTradesByMinute,
} from "./flow-deep-trades.ts";
import { buildMinuteFeatures, FLOW_INSTRUMENTS } from "./flow-features.ts";
import { type SignedTrade, signTrades } from "./flow-trade-signing.ts";

const T0 = 1_700_000_040; // a minute boundary
const SAMPLED_AT = new Date("2026-11-13T15:10:00.000Z");
const ES = FLOW_INSTRUMENTS.ES;

const print = (
  t: number,
  size: number,
  overrides: Partial<SignedTrade> = {}
): SignedTrade => ({
  ask: null,
  bid: null,
  conditions: null,
  method: "quote",
  price: 6870.5,
  side: "buy",
  size,
  t,
  venue: null,
  ...overrides,
});

describe("deepTradesOf", () => {
  it("returns one row per deep print inside the sample", () => {
    const { rows, unsigned } = deepTradesOf(
      ES,
      [print(T0 + 5, 40), print(T0 + 6, 44, { side: "sell" })],
      { first: T0, last: T0 + 10 },
      SAMPLED_AT
    );
    expect(unsigned).toBe(0);
    expect(rows).toEqual([
      {
        capture: "sampled",
        limitSize: 40,
        price: 6870.5,
        sampledAt: SAMPLED_AT,
        second: new Date((T0 + 5) * 1000),
        seq: 0,
        side: "buy",
        signing: "quote",
        size: 40,
        symbol: "ES",
      },
      expect.objectContaining({ seq: 0, side: "sell", size: 44 }),
    ]);
  });

  it("leaves out the first and the last sampled second", () => {
    const { rows } = deepTradesOf(
      ES,
      [print(T0, 50), print(T0 + 1, 41), print(T0 + 2, 60)],
      { first: T0, last: T0 + 2 },
      SAMPLED_AT
    );
    expect(rows.map((row) => row.size)).toEqual([41]);
  });

  it("writes the capture mode streamed and cuts no second of a tape range", () => {
    // The tape range [T0, T0 + 60) holds whole seconds: the caller passes the second before its
    // first second and its end second.
    const prints = [
      print(T0, 50),
      print(T0 + 30, 41),
      print(T0 + 59, 60),
      print(T0 + 60, 70),
    ];
    const streamed = deepTradesOf(
      ES,
      prints,
      { first: T0 - 1, last: T0 + 60 },
      SAMPLED_AT,
      "streamed"
    );
    expect(streamed.rows.map((row) => [row.size, row.capture])).toEqual([
      [50, "streamed"],
      [41, "streamed"],
      [60, "streamed"],
    ]);
    // Without the fifth argument the rows are sampled, as before.
    const sampled = deepTradesOf(
      ES,
      prints,
      { first: T0 - 1, last: T0 + 60 },
      SAMPLED_AT
    );
    expect(sampled.rows.map((row) => row.capture)).toEqual([
      "sampled",
      "sampled",
      "sampled",
    ]);
  });

  it("returns nothing for no deep print and for a sample of fewer than three seconds", () => {
    expect(
      deepTradesOf(ES, [], { first: T0, last: T0 + 10 }, SAMPLED_AT)
    ).toEqual({ invalid: 0, rows: [], unsigned: 0 });
    expect(
      deepTradesOf(
        ES,
        [print(T0, 50), print(T0 + 1, 50)],
        { first: T0, last: T0 + 1 },
        SAMPLED_AT
      ).rows
    ).toEqual([]);
  });

  it("numbers the deep trades of one second in print order", () => {
    const { rows } = deepTradesOf(
      ES,
      [print(T0 + 3, 45), print(T0 + 3, 41), print(T0 + 4, 42)],
      { first: T0, last: T0 + 9 },
      SAMPLED_AT
    );
    expect(rows.map((row) => [row.size, row.seq])).toEqual([
      [45, 0],
      [41, 1],
      [42, 0],
    ]);
  });

  it("does not add up same-side prints of one second", () => {
    const { rows } = deepTradesOf(
      ES,
      [print(T0 + 3, 40), print(T0 + 3, 40)],
      { first: T0, last: T0 + 9 },
      SAMPLED_AT
    );
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.size)).toEqual([40, 40]);
  });

  it("keeps the signing method and the limit on each row", () => {
    const { rows } = deepTradesOf(
      FLOW_INSTRUMENTS.NQ,
      [print(T0 + 3, 12, { method: "tick", side: "sell" })],
      { first: T0, last: T0 + 9 },
      SAMPLED_AT
    );
    expect(rows).toEqual([
      expect.objectContaining({
        limitSize: 10,
        side: "sell",
        signing: "tick",
        symbol: "NQ",
      }),
    ]);
  });

  it("does not store a deep print whose signing is none, counts it as unsigned and still numbers it", () => {
    const { rows, unsigned } = deepTradesOf(
      ES,
      [
        print(T0 + 3, 50, { method: "none", side: "unknown" }),
        print(T0 + 3, 41, { method: "quote", side: "unknown" }),
        print(T0 + 3, 42),
      ],
      { first: T0, last: T0 + 9 },
      SAMPLED_AT
    );
    expect(unsigned).toBe(2);
    expect(rows.map((row) => [row.size, row.seq])).toEqual([[42, 2]]);
  });

  it("does not store a deep print with a non-finite or non-positive price, counts it as invalid and still numbers it", () => {
    const { invalid, rows, unsigned } = deepTradesOf(
      ES,
      [
        print(T0 + 3, 50, { price: 0 }),
        print(T0 + 3, 41, { price: -1 }),
        print(T0 + 3, 44, { price: Number.NaN }),
        print(T0 + 3, 45, { price: Number.POSITIVE_INFINITY }),
        print(T0 + 3, 42),
      ],
      { first: T0, last: T0 + 9 },
      SAMPLED_AT
    );
    expect(invalid).toBe(4);
    expect(unsigned).toBe(0);
    expect(rows.map((row) => [row.size, row.seq, row.price])).toEqual([
      [42, 4, 6870.5],
    ]);
  });

  it("returns no rows for an instrument without a deep-trade limit", () => {
    const deep = [print(T0 + 3, 20_000)];
    const sample = { first: T0, last: T0 + 9 };
    expect(
      deepTradesOf(FLOW_INSTRUMENTS.SPY, deep, sample, SAMPLED_AT)
    ).toEqual({ invalid: 0, rows: [], unsigned: 0 });
    expect(
      deepTradesOf(
        { ...FLOW_INSTRUMENTS.QQQ, deepTradeLimit: 5 },
        deep,
        sample,
        SAMPLED_AT
      )
    ).toEqual({ invalid: 0, rows: [], unsigned: 0 });
  });

  it("two overlapping samples give the same keys for the seconds both hold complete", () => {
    const tape: MarketTradeTick[] = [];
    for (let second = 0; second <= 150; second += 1) {
      tape.push({
        c: null,
        p: 6870 + (second % 7) * 0.25,
        s: 1,
        t: T0 + second,
        x: null,
      });
      if (second >= 61 && second <= 89) {
        tape.push({
          c: null,
          p: 6871,
          s: 40 + (second % 3),
          t: T0 + second,
          x: null,
        });
        if (second % 2 === 0)
          tape.push({ c: null, p: 6870.75, s: 55, t: T0 + second, x: null });
      }
    }
    const keyed = (from: number, to: number) => {
      const trades = tape.filter(
        (trade) => trade.t >= T0 + from && trade.t <= T0 + to
      );
      const signed = signTrades(trades, []);
      const features = buildMinuteFeatures(ES, signed, 0.25);
      const sample = {
        first: (signed[0] as SignedTrade).t,
        last: (signed.at(-1) as SignedTrade).t,
      };
      return deepTradesOf(ES, features.deepPrints, sample, SAMPLED_AT)
        .rows.filter(
          (row) =>
            row.second.getTime() >= (T0 + 61) * 1000 &&
            row.second.getTime() <= (T0 + 89) * 1000
        )
        .map(({ second, seq, size, price, limitSize }) => ({
          limitSize,
          price,
          second: second.getTime(),
          seq,
          size,
        }));
    };
    const a = keyed(0, 90);
    const b = keyed(60, 150);
    expect(a.length).toBeGreaterThan(29);
    expect(b).toEqual(a);
  });

  it("an ES print of 40 contracts is a deep trade and no large_print event, and one of 50 is both", () => {
    const signed = [
      print(T0, 1),
      print(T0 + 10, 40),
      print(T0 + 20, 50),
      print(T0 + 30, 1),
    ];
    const features = buildMinuteFeatures(ES, signed, 0.25);
    const large = features.events.filter(
      (event) => event.kind === "large_print"
    );
    expect(large.map((event) => event.size)).toEqual([50]);
    const { rows } = deepTradesOf(
      ES,
      features.deepPrints,
      { first: T0, last: T0 + 30 },
      SAMPLED_AT
    );
    expect(rows.map((row) => row.size)).toEqual([40, 50]);
  });
});

describe("sumDeepTradesByMinute", () => {
  const OPEN = new Date("2026-11-13T14:30:00.000Z");
  const row = (
    offsetSeconds: number,
    side: "buy" | "sell",
    size: number
  ): FlowDeepTradeRow => ({
    capture: "sampled",
    limitSize: 40,
    price: 6870.5,
    sampledAt: SAMPLED_AT,
    second: new Date(OPEN.getTime() + offsetSeconds * 1000),
    seq: 0,
    side,
    signing: "quote",
    size,
    symbol: "ES",
  });

  it("sums buy and sell volume per session minute and drops rows before the open", () => {
    expect(
      sumDeepTradesByMinute(
        [
          row(-1, "buy", 99),
          row(130, "sell", 45),
          row(5, "buy", 40),
          row(59, "sell", 41),
          row(61, "buy", 42),
        ],
        OPEN
      )
    ).toEqual([
      { buyVolume: 40, minute: 0, sellVolume: 41, trades: 2 },
      { buyVolume: 42, minute: 1, sellVolume: 0, trades: 1 },
      { buyVolume: 0, minute: 2, sellVolume: 45, trades: 1 },
    ]);
  });
});
