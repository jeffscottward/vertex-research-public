import { describe, expect, it } from "vitest";
import {
  buildBook,
  chooseExpiry,
  chooseStrikes,
  contractsFor,
  formatG,
  instrumentValue,
  type Market,
  marketPricer,
  OptionsSpec,
  parseOptions,
  validateMarket,
  worstExitCost,
} from "./book.ts";
import { formatDay, parseDay, TradingCalendar } from "./calendar.ts";

// Expected values: services/research/strategies/qc_ports/book.py on the same inputs.
const DEBIT = {
  dte: { min: 20, target: 30 },
  maxLossPct: 2,
  structure: "callDebitVertical",
  widthSigma: 0.5,
};

const market = (
  symbol: string,
  size = 40,
  overrides: Partial<Market> = {}
): Market => {
  const dates: string[] = [];
  for (let day = parseDay("2024-01-02"); dates.length < size; day++) {
    const weekdayOf = new Date(day * 86_400_000).getUTCDay();
    if (weekdayOf !== 0 && weekdayOf !== 6) dates.push(formatDay(day));
  }
  return {
    close: dates.map((_, index) => 100 + index),
    dates,
    ivIndex: dates.map(() => 20),
    rate: dates.map(() => 0.04),
    symbol,
    ...overrides,
  };
};

describe("formatG", () => {
  it("formats like Python's g", () => {
    expect(
      [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0].map(
        formatG
      )
    ).toEqual(["nan", "inf", "-inf", "-0"]);
    expect(
      [2.5, 123_456, 1_234_567, 1e-5, 0.0001, 100, 0].map(formatG)
    ).toEqual(["2.5", "123456", "1.23457e+06", "1e-05", "0.0001", "100", "0"]);
  });
});

describe("parseOptions", () => {
  it("applies the defaults and keeps the optional fields", () => {
    const spec = parseOptions(DEBIT);
    expect([
      spec.longDelta,
      spec.shortDelta,
      spec.profitTakePct,
      spec.exitDte,
      spec.right,
      spec.kind,
    ]).toEqual([0.5, 0.25, null, null, "call", "debit"]);
    const full = parseOptions({
      ...DEBIT,
      exitDte: 5,
      longDelta: 0.4,
      profitTakePct: 50,
      shortDelta: 0.2,
      structure: "putCreditVertical",
    });
    expect([
      full.longDelta,
      full.shortDelta,
      full.profitTakePct,
      full.exitDte,
      full.right,
      full.kind,
    ]).toEqual([0.4, 0.2, 50, 5, "put", "credit"]);
  });

  it("refuses bad blocks with the Python messages", () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...DEBIT, bar: 2, foo: 1 }, "Unknown options field: bar, foo"],
      [
        { ...DEBIT, structure: "ironCondor" },
        "structure must be one of callDebitVertical, putDebitVertical, putCreditVertical, callCreditVertical",
      ],
      [{ ...DEBIT, dte: null }, "dte must be {target, min}"],
      [{ ...DEBIT, dte: [30, 20] }, "dte must be {target, min}"],
      [{ ...DEBIT, dte: 30 }, "dte must be {target, min}"],
      [{ ...DEBIT, dte: { target: 30 } }, "dte must be {target, min}"],
      [
        { ...DEBIT, maxLossPct: 2.5 },
        "maxLossPct 2.5 refused: the cap is 2% of equity per trade",
      ],
      [
        { ...DEBIT, dte: { min: 2, target: 3 } },
        "target must be an integer in 7..400",
      ],
      [
        { ...DEBIT, dte: { min: 2.5, target: 30 } },
        "min must be an integer in 1..400",
      ],
      [
        { ...DEBIT, dte: { min: 2, target: "30" } },
        "target must be an integer in 7..400",
      ],
      [{ ...DEBIT, widthSigma: "wide" }, "widthSigma must be a number"],
      [{ ...DEBIT, widthSigma: 5 }, "widthSigma must be in [0.1, 3]"],
      [{ ...DEBIT, widthSigma: 0.05 }, "widthSigma must be in [0.1, 3]"],
      [{ ...DEBIT, maxLossPct: 0 }, "maxLossPct must be in (0, 2]"],
      [{ ...DEBIT, exitDte: -1 }, "exitDte must be an integer in 0..400"],
    ];
    for (const [block, message] of cases)
      expect(() => parseOptions(block)).toThrow(message);
  });
});

describe("sizing, expiry, strikes and values", () => {
  it("sizes by max loss and cash", () => {
    expect([
      contractsFor(100_000, 50_000, 2, 512.3, 300),
      contractsFor(100_000, 500, 2, 512.3, 300),
      contractsFor(100_000, 500, 2, 512.3, 0),
    ]).toEqual([3, 1, 3]);
    expect([
      contractsFor(100_000, 500, 2, 0, 1),
      contractsFor(0, 500, 2, 1, 1),
      contractsFor(1, 0, 2, 1, 1),
    ]).toEqual([0, 0, 0]);
    expect(() => contractsFor(1, 1, Number.NaN, 1, 1)).toThrow(
      "maxLossPct nan refused: must be above 0 and at most 2"
    );
    expect(() => contractsFor(1, 1, 3, 1, 1)).toThrow("maxLossPct 3 refused");
    expect(() => contractsFor(Number.NaN, 1, 2, 1, 1)).toThrow(
      "contracts_for needs finite equity, cash, max loss and unit cost"
    );
  });

  it("picks the expiry nearest the target DTE, none when the minimum is out of reach", () => {
    const calendar = new TradingCalendar(["2024-01-02"]);
    expect(
      formatDay(
        chooseExpiry(parseDay("2024-01-02"), 30, 20, calendar) as number
      )
    ).toBe("2024-02-16");
    // The scan always reaches the minimum for valid specs; an unvalidated NaN target scans nothing.
    expect(
      chooseExpiry(parseDay("2024-01-02"), Number.NaN, 20, calendar)
    ).toBeNull();
  });

  it("chooses strikes by delta, then distance to the spot, then the lower strike", () => {
    const spec = parseOptions(DEBIT);
    expect(
      chooseStrikes("call", "debit", 100.5, 1 / 365, 0, 0, 0.0095, 0, spec)
    ).toEqual([100, 101, 1]);
    expect(
      chooseStrikes("put", "debit", 100.5, 1 / 365, 0, 0, 0.0095, 0, spec)
    ).toEqual([100, 99, 1]);
    const wide = parseOptions({
      ...DEBIT,
      structure: "putCreditVertical",
      widthSigma: 3,
    });
    expect(
      chooseStrikes("put", "credit", 3, 1, 0.04, 0, 1.35, -0.1, wide)
    ).toBeNull();
    expect(
      chooseStrikes("call", "credit", 100, 0.25, 0.04, 0, 0.2, -0.3, wide)
    ).toEqual([137, 107, 30]);
    expect(
      chooseStrikes("call", "debit", 100, 0, 0.04, 0, 0.2, -0.3, spec)
    ).toBeNull();
  });

  it("values the spread and its worst exit in cents", () => {
    expect([
      instrumentValue("credit", 1.2, 2.5, 5),
      instrumentValue("debit", 1, 2, 5),
    ]).toEqual([370, 0]);
    expect(worstExitCost("SPY", 5)).toBe(11.3);
    expect(() => instrumentValue("debit", Number.NaN, 1, 5)).toThrow(
      "instrument value needs finite leg prices and width"
    );
  });
});

describe("markets and the book", () => {
  it("validates markets like data.Market", () => {
    const good = market("SPY", 5);
    const cases: [Partial<Market>, string][] = [
      [{ close: [1] }, "Market columns must have the same length"],
      [
        {
          dates: [
            "2024-01-02",
            "2024-01-02",
            "2024-01-03",
            "2024-01-04",
            "2024-01-05",
          ],
        },
        "strictly increasing",
      ],
      [{ close: [1, 2, 0, 4, 5] }, "Market closes must be finite and above 0"],
      [
        { ivIndex: [1, 2, -1, null, 5] },
        "Market IV index values must be None or finite and above 0",
      ],
      [
        { rate: [0, null, Number.NaN, 0, 0] },
        "Market rates must be None or finite and not negative",
      ],
    ];
    for (const [override, message] of cases)
      expect(() => validateMarket({ ...good, ...override })).toThrow(message);
  });

  it("prices tuple events with a parsed spec and refuses bad events", () => {
    const spec = parseOptions(DEBIT);
    const markets = { SPY: market("SPY") };
    const book = buildBook(
      [
        ["SPY", 0, 5],
        ["SPY", 1],
      ],
      spec,
      markets
    );
    expect(
      book.trades.map((trade) => [
        trade.tradeId,
        trade.exitReason,
        trade.exitIndex,
      ])
    ).toEqual([
      [1, "signal", 6],
      [2, "expiry", 33], // 2024-02-16
    ]);
    expect(() =>
      buildBook([{ entryIndex: 0, symbol: "QQQ" }], spec, markets)
    ).toThrow("No market data for QQQ");
    expect(() =>
      buildBook([{ entryIndex: 40, symbol: "SPY" }], spec, markets)
    ).toThrow("entry index 40 outside the SPY bars");
    expect(() =>
      buildBook([{ entryIndex: 0.5, symbol: "SPY" }], spec, markets)
    ).toThrow("entry index 0.5");
    expect(() =>
      buildBook([{ entryIndex: 3, exitIndex: 3, symbol: "SPY" }], spec, markets)
    ).toThrow("exit signal must come after the entry signal");
    expect(() =>
      buildBook([{ entryIndex: 0, symbol: "XYZ" }], DEBIT, {
        XYZ: market("XYZ"),
      })
    ).toThrow("No IV index for XYZ");
  });

  it("skips an event without a reachable expiry", () => {
    const spec = new OptionsSpec({
      dteMin: 20,
      dteTarget: Number.NaN,
      maxLossPct: 2,
      structure: "callDebitVertical",
      widthSigma: 0.5,
    });
    const price = marketPricer(spec, market("SPY"));
    expect(price({ entryIndex: 0, symbol: "SPY" }, 1)).toBe("no expiry");
  });
});
