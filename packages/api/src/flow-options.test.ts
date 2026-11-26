import { describe, expect, it } from "vitest";

import {
  type FlowOptionPrintRow,
  oiFlags,
  oiFlagsKnown,
  oldestRowTime,
  optionEvents,
  parseOptionPrints,
} from "./flow-options.ts";

const MS = Date.parse("2026-11-09T15:00:00Z");

const row = (overrides: Record<string, unknown> = {}) => ({
  askPrice: 2.1,
  bidPrice: 2,
  contractType: "CALL",
  dte: 0,
  expirationDate: "2026-11-09T00:00:00",
  id: "abc",
  impliedVolatility: 0.2,
  isGoldenSweep: true,
  isOpeningPosition: true,
  isUnusual: true,
  isVolumeGreaterThanOpenInterest: true,
  moneyness: { degreeInPercent: 1.5, moneyType: "OUT_OF_THE_MONEY" },
  openInterest: 1000,
  optionPrice: 2.05,
  premium: 600_000,
  sentimentType: "BULLISH",
  size: 12.7,
  stockPrice: 600,
  strikePrice: 605,
  tradeConsolidationType: "SWEEP",
  tradeSideCode: "ASK",
  tradeTime: MS,
  unknownField: "ignored",
  volume: 5000,
  ...overrides,
});

const parseOne = (overrides: Record<string, unknown>) =>
  parseOptionPrints([row(overrides)], "SPY", "SPY").prints[0];

describe("parseOptionPrints", () => {
  it("treats non-array input as empty", () => {
    expect(parseOptionPrints({ rows: [] }, "SPY", "SPY")).toEqual({
      prints: [],
      skipped: 0,
    });
    expect(parseOptionPrints(null, "ES", "SPX")).toEqual({
      prints: [],
      skipped: 0,
    });
  });

  it("parses a full row", () => {
    const { prints, skipped } = parseOptionPrints([row()], "SPY", "SPY");
    expect(skipped).toBe(0);
    expect(prints).toEqual([
      {
        ask: 2.1,
        bid: 2,
        consolidation: "sweep",
        dte: 0,
        expiry: "2026-11-09",
        goldenSweep: true,
        id: "abc",
        iv: 0.2,
        moneyness: "otm",
        moneynessPct: 1.5,
        openInterest: 1000,
        opening: true,
        premium: 600_000,
        price: 2.05,
        right: "call",
        sentiment: "bullish",
        side: "ask",
        size: 12,
        strike: 605,
        symbol: "SPY",
        ticker: "SPY",
        tradedAt: new Date(MS),
        underlyingPrice: 600,
        unusual: true,
        volume: 5000,
        volumeOverOi: true,
      },
    ]);
  });

  it("stores both open-interest flags as not reported when the print reports open interest 0", () => {
    // QuantData sets Opening and Vol > OI on every print with open interest 0 (card
    // vertex-flow-print-flags-oi-zero-third-state); null is the stored third state.
    expect(parseOne({ openInterest: 0 })).toMatchObject({
      openInterest: 0,
      opening: null,
      volumeOverOi: null,
    });
    expect(
      parseOne({
        isOpeningPosition: false,
        isVolumeGreaterThanOpenInterest: false,
        openInterest: 0,
      })
    ).toMatchObject({ opening: null, volumeOverOi: null });
  });

  it("keeps the flags as sent when open interest is above 0 or not sent", () => {
    expect(
      parseOne({
        isOpeningPosition: false,
        isVolumeGreaterThanOpenInterest: true,
        openInterest: 1,
      })
    ).toMatchObject({ opening: false, volumeOverOi: true });
    expect(parseOne({ openInterest: null })).toMatchObject({
      opening: true,
      volumeOverOi: true,
    });
  });

  it("skips and counts invalid rows and unparseable times", () => {
    const result = parseOptionPrints(
      [
        row(),
        row({ premium: -1 }),
        row({ contractType: "STRADDLE" }),
        row({ tradeTime: "not a time" }),
        "junk",
      ],
      "SPY",
      "SPY"
    );
    expect(result.prints).toHaveLength(1);
    expect(result.skipped).toBe(4);
  });

  it("accepts ISO-string and numeric-string trade times", () => {
    expect(parseOne({ tradeTime: "2026-11-09T15:00:00Z" })?.tradedAt).toEqual(
      new Date(MS)
    );
    expect(parseOne({ tradeTime: String(MS) })?.tradedAt).toEqual(new Date(MS));
  });

  it("maps every side code", () => {
    const sides = {
      ABOVE_ASK: "above_ask",
      ask: "ask",
      BELOW_BID: "below_bid",
      BID: "bid",
      MID_MARKET: "mid",
      WEIRD: "unknown",
    };
    for (const [code, side] of Object.entries(sides))
      expect(parseOne({ tradeSideCode: code })?.side).toBe(side);
  });

  it("maps every moneyness, consolidation and sentiment", () => {
    const moneyness = {
      AT_THE_MONEY: "atm",
      DEEP: "unknown",
      IN_THE_MONEY: "itm",
      out_of_the_money: "otm",
    };
    for (const [moneyType, value] of Object.entries(moneyness))
      expect(
        parseOne({ moneyness: { degreeInPercent: 1, moneyType } })?.moneyness
      ).toBe(value);
    const consolidations = {
      block: "block",
      OTHER: "other",
      SPLIT: "split",
      SWEEP: "sweep",
    };
    for (const [type, value] of Object.entries(consolidations))
      expect(parseOne({ tradeConsolidationType: type })?.consolidation).toBe(
        value
      );
    const sentiments = {
      BULLISH: "bullish",
      bearish: "bearish",
      NEUTRAL: "neutral",
    };
    for (const [type, value] of Object.entries(sentiments))
      expect(parseOne({ sentimentType: type })?.sentiment).toBe(value);
  });

  it("defaults nullish fields", () => {
    const print = parseOne({
      askPrice: null,
      bidPrice: undefined,
      contractType: "put",
      dte: null,
      impliedVolatility: null,
      isGoldenSweep: null,
      isOpeningPosition: undefined,
      isUnusual: false,
      isVolumeGreaterThanOpenInterest: null,
      moneyness: null,
      openInterest: null,
      optionPrice: null,
      sentimentType: null,
      stockPrice: null,
      tradeConsolidationType: undefined,
      tradeSideCode: null,
      volume: null,
    });
    expect(print).toMatchObject({
      ask: null,
      bid: null,
      consolidation: "other",
      dte: null,
      goldenSweep: false,
      iv: null,
      moneyness: "unknown",
      moneynessPct: null,
      openInterest: null,
      opening: false,
      price: null,
      right: "put",
      sentiment: "neutral",
      side: "unknown",
      underlyingPrice: null,
      unusual: false,
      volume: null,
      volumeOverOi: false,
    });
  });
});

describe("optionEvents", () => {
  const base = parseOne({}) as FlowOptionPrintRow;
  const print = (
    overrides: Partial<FlowOptionPrintRow>
  ): FlowOptionPrintRow => ({ ...base, ...overrides });

  it("keeps prints over the premium floor or golden sweeps", () => {
    const events = optionEvents(
      [
        print({ goldenSweep: false, id: "small", premium: 1 }),
        print({ goldenSweep: true, id: "golden", premium: 1 }),
        print({ consolidation: "sweep", goldenSweep: false, id: "sweep" }),
        print({ consolidation: "block", goldenSweep: false, id: "block" }),
        print({ consolidation: "split", goldenSweep: false, id: "split" }),
      ],
      500_000
    );
    expect(events.map((event) => [event.key, event.kind])).toEqual([
      ["option:golden", "option_golden_sweep"],
      ["option:sweep", "option_sweep"],
      ["option:block", "option_block"],
      ["option:split", "option_print"],
    ]);
  });

  it("builds detail text with optional flags", () => {
    const [flagged, plain] = optionEvents(
      [
        print({ side: "above_ask" }),
        print({
          price: null,
          right: "put",
          sentiment: "bearish",
          unusual: false,
          volumeOverOi: false,
        }),
      ],
      0
    );
    expect(flagged).toEqual({
      at: new Date(MS),
      detail:
        "SPY 2026-11-09 605C 12x @ 2.05 (above ask, otm), unusual, vol > OI",
      direction: "bullish",
      key: "option:abc",
      kind: "option_golden_sweep",
      premium: 600_000,
      price: 605,
      size: 12,
      source: "quantdata",
      symbol: "SPY",
    });
    expect(plain?.detail).toBe(
      "SPY 2026-11-09 605P 12x @ price not reported (ask, otm)"
    );
    expect(plain?.direction).toBe("bearish");
  });

  it("names a stored side or moneyness that the feed did not report", () => {
    // "unknown" is the stored word of both columns; the event text never shows it.
    const [event] = optionEvents(
      [print({ moneyness: "unknown", side: "unknown" })],
      0
    );
    expect(event?.detail).toBe(
      "SPY 2026-11-09 605C 12x @ 2.05 (side not classified, moneyness not classified), unusual, vol > OI"
    );
  });

  it("leaves out vol > OI when the print reports open interest 0 or stored null flags", () => {
    const [legacy, storedNull] = optionEvents(
      [
        print({ openInterest: 0 }),
        print({ openInterest: 0, opening: null, volumeOverOi: null }),
      ],
      0
    );
    expect(legacy?.detail).toBe(
      "SPY 2026-11-09 605C 12x @ 2.05 (ask, otm), unusual"
    );
    expect(storedNull?.detail).toBe(
      "SPY 2026-11-09 605C 12x @ 2.05 (ask, otm), unusual"
    );
  });
});

describe("oiFlags", () => {
  const flags = { opening: true, volumeOverOi: true };

  it("keeps the flags as sent when open interest is above 0", () => {
    expect(oiFlags({ ...flags, openInterest: 1 })).toEqual(flags);
    expect(
      oiFlags({ openInterest: 500, opening: false, volumeOverOi: false })
    ).toEqual({ opening: false, volumeOverOi: false });
  });

  it("keeps the flags as sent when open interest is not reported", () => {
    expect(oiFlags({ ...flags, openInterest: null })).toEqual(flags);
  });

  it("reads both flags as not reported when open interest is 0 (rows stored before null)", () => {
    expect(oiFlags({ ...flags, openInterest: 0 })).toEqual({
      opening: null,
      volumeOverOi: null,
    });
  });

  it("reads stored null flags as paired not reported", () => {
    expect(
      oiFlags({ openInterest: 0, opening: null, volumeOverOi: null })
    ).toEqual({ opening: null, volumeOverOi: null });
    expect(
      oiFlags({ openInterest: 7, opening: null, volumeOverOi: true })
    ).toEqual({ opening: null, volumeOverOi: null });
    expect(
      oiFlags({ openInterest: 7, opening: false, volumeOverOi: null })
    ).toEqual({ opening: null, volumeOverOi: null });
  });

  it("knows the OI flags only when both are reported", () => {
    expect(oiFlagsKnown({ ...flags, openInterest: 0 })).toBe(false);
    expect(oiFlagsKnown({ ...flags, openInterest: null })).toBe(true);
    expect(oiFlagsKnown({ ...flags, openInterest: 3 })).toBe(true);
    expect(
      oiFlagsKnown({ openInterest: 3, opening: null, volumeOverOi: true })
    ).toBe(false);
    expect(
      oiFlagsKnown({ openInterest: 3, opening: true, volumeOverOi: null })
    ).toBe(false);
  });
});

describe("oldestRowTime", () => {
  const start = new Date(MS - 10_000);
  const end = new Date(MS);

  it("reads epoch ms and ISO trade times, rows that fail the print schema included", () => {
    expect(
      oldestRowTime(
        [
          { tradeTime: MS },
          { broken: true, tradeTime: new Date(MS - 5000).toISOString() },
          { tradeTime: String(MS - 1000) },
        ],
        start,
        end
      )
    ).toStrictEqual(new Date(MS - 5000));
  });

  it("ignores rows without a usable trade time inside the range, and non-array data", () => {
    expect(
      oldestRowTime(
        [
          null,
          7,
          { tradeTime: "" },
          { tradeTime: 0 },
          { tradeTime: MS / 1000 },
          { tradeTime: 1e20 },
          { tradeTime: MS + 1 },
          { tradeTime: "not a time" },
          { tradeTime: { at: MS } },
        ],
        start,
        end
      )
    ).toBeNull();
    expect(oldestRowTime({ rows: [{ tradeTime: MS }] }, start, end)).toBeNull();
  });
});
