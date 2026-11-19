import { describe, expect, it } from "vitest";

import { prepareExpiryPayoff } from "./payoff.ts";
import {
  breakevenText,
  EXPIRED_MARK,
  firstSet,
  firstSetDate,
  formatAmount,
  formatPlain,
  formatPrice,
  groupLabel,
  isExpired,
  KIND_ORDER,
  LAB_LIMITS,
  lineLabel,
  MAX_SELECTED_LINES,
  parsePrice,
  parseUnits,
  priceAxis,
  REASON_TEXT,
  utcDate,
} from "./payoff-lab-model.ts";
import {
  type LabLine,
  type ParsedStrategies,
  parsePayoffStrategies,
} from "./payoff-strategies.ts";

// Synthetic fixtures only. Lines come from the real parser, so the tests use the closed type.
const leg = (side: string, type: string, strike: number, premium: number) => ({
  multiplier: 100,
  premium,
  side,
  strike,
  type,
});
const rows = {
  call: (expiry: string, strike = 100, id = "call") => ({
    expiry,
    id,
    kind: "long-call",
    legs: [leg("buy", "call", strike, 5)],
  }),
  callSpread: (expiry: string) => ({
    expiry,
    kind: "bull-call-spread",
    legs: [leg("buy", "call", 100, 8), leg("sell", "call", 110, 3)],
  }),
  put: (expiry: string) => ({
    expiry,
    kind: "cash-secured-put",
    legs: [leg("sell", "put", 90, 4)],
  }),
  putSpread: (expiry: string) => ({
    expiry,
    kind: "put-credit-spread",
    legs: [leg("sell", "put", 95, 3), leg("buy", "put", 85, 1)],
  }),
  stock: (stockEntry = 40) => ({
    hypothetical: true,
    kind: "stock",
    stockEntry,
    stockShares: 100,
  }),
};
const linesOf = (
  strategies: readonly unknown[],
  extra: Readonly<Record<string, unknown>> = {}
): readonly LabLine[] => {
  const parsed: ParsedStrategies = parsePayoffStrategies(
    { ...extra, strategies },
    { catalogCurrency: null, gate: "allowed", reportId: "AAA" }
  );
  if (parsed.state !== "parsed") throw new Error(parsed.state);
  return parsed.lines;
};
const one = (row: unknown): LabLine => {
  const [line] = linesOf([row]);
  if (line === undefined) throw new Error("row is not drawable");
  return line;
};

const JAN = "2027-01-15";
const MAR = "2027-03-19";
const OLD = "2026-10-09";

describe("dates", () => {
  it("reads the UTC calendar date", () => {
    expect(utcDate(new Date("2026-11-19T23:59:59.000Z"))).toBe("2026-11-19");
    expect(utcDate(new Date("2026-11-19T23:59:59.000-05:00"))).toBe(
      "2026-11-20"
    );
  });

  it("treats the expiry day itself as open and stock as never expired", () => {
    const line = one(rows.call(JAN));
    expect(isExpired(line, "2027-01-14")).toBe(false);
    expect(isExpired(line, JAN)).toBe(false);
    expect(isExpired(line, "2027-01-16")).toBe(true);
    expect(isExpired(one(rows.stock()), "2099-01-01")).toBe(false);
  });
});

describe("first set", () => {
  const mixed = [
    rows.call(OLD),
    rows.call(MAR),
    rows.put(MAR),
    rows.call(JAN, 100, "jan-call"),
    rows.call(JAN, 120, "jan-call-2"),
    rows.callSpread(JAN),
    rows.stock(),
  ];

  it("uses the earliest date on or after today, one line per kind in the fixed order", () => {
    const lines = linesOf(mixed);
    expect(firstSetDate(lines, "2026-11-19")).toBe(JAN);
    expect(firstSetDate(lines, JAN)).toBe(JAN);
    expect(firstSetDate(lines, "2027-01-16")).toBe(MAR);
    expect(firstSet(lines, "2026-11-19")).toEqual([
      "line-6",
      "line-3",
      "line-5",
    ]);
  });

  it("uses the latest date when all expiry dates are in the past", () => {
    const lines = linesOf(mixed);
    expect(firstSetDate(lines, "2030-01-01")).toBe(MAR);
    expect(firstSet(lines, "2030-01-01")).toEqual([
      "line-6",
      "line-1",
      "line-2",
    ]);
  });

  it("has no date without an option line and is empty without lines", () => {
    const stockOnly = linesOf([rows.stock()]);
    expect(firstSetDate(stockOnly, JAN)).toBeNull();
    expect(firstSet(stockOnly, JAN)).toEqual(["line-0"]);
    expect(firstSet([], JAN)).toEqual([]);
  });

  it("holds at most one line of each of the five kinds", () => {
    expect(KIND_ORDER).toEqual([
      "stock",
      "long-call",
      "bull-call-spread",
      "cash-secured-put",
      "put-credit-spread",
    ]);
    expect(MAX_SELECTED_LINES).toBe(5);
    const lines = linesOf([
      rows.putSpread(JAN),
      rows.put(JAN),
      rows.callSpread(JAN),
      rows.call(JAN),
      rows.call(JAN, 130),
      rows.stock(),
    ]);
    expect(firstSet(lines, "2026-11-19")).toEqual([
      "line-5",
      "line-3",
      "line-2",
      "line-1",
      "line-0",
    ]);
  });
});

describe("labels", () => {
  it("builds each label from the kind, the strikes, the net premium and the expiry", () => {
    expect(lineLabel(one(rows.stock()))).toBe("Stock, hypothetical · basis 40");
    expect(lineLabel(one(rows.call(JAN, 1250.5)))).toBe(
      "Long call 1,250.5 · debit 5 · 2027-01-15"
    );
    expect(lineLabel(one(rows.put(JAN)))).toBe(
      "Cash-secured put 90 · credit 4 · 2027-01-15"
    );
    expect(lineLabel(one(rows.callSpread(JAN)))).toBe(
      "Bull call spread 100/110 · debit 5 · 2027-01-15"
    );
    expect(lineLabel(one(rows.putSpread(JAN)))).toBe(
      "Put credit spread 85/95 · credit 2 · 2027-01-15"
    );
    expect(
      lineLabel(
        one({
          expiry: JAN,
          kind: "long-call",
          legs: [leg("buy", "call", 100, 0)],
        })
      )
    ).toBe("Long call 100 · no premium · 2027-01-15");
    expect(EXPIRED_MARK).toBe("expired (UTC date)");
  });

  it("groups the add control by expiry date and kind", () => {
    expect(groupLabel(one(rows.callSpread(JAN)))).toBe(
      "2027-01-15 · Bull call spread"
    );
    expect(groupLabel(one(rows.stock()))).toBe("Stock");
  });
});

describe("price axis", () => {
  it("starts at the basis of the stock line and ends on multiples of the step", () => {
    const lines = linesOf([rows.call(JAN), rows.stock(40)]);
    // Band 20 to 60; the breakeven 105 widens it to 115.5. Raw step 0.4775 gives 0.5.
    expect(priceAxis(lines, firstSet(lines, JAN))).toEqual({
      max: 115.5,
      min: 20,
      source: "stock-basis",
      start: 40,
      step: 0.5,
    });
  });

  it("starts at the midpoint of the strikes of the first set without a stock line", () => {
    const lines = linesOf([
      rows.call(JAN, 100),
      rows.call(JAN, 300),
      rows.put(JAN),
    ]);
    // First set: the call at 100 and the put at 90, so the midpoint is 95.
    // Raw range 47.5 to 335.5 (the breakeven 305 with its margin); raw step 1.44 gives 2.
    expect(priceAxis(lines, firstSet(lines, JAN))).toEqual({
      max: 336,
      min: 46,
      source: "strike-midpoint",
      start: 95,
      step: 2,
    });
  });

  it("uses steps of 1, 2 or 5 times a power of ten", () => {
    const step = (basis: number): number =>
      priceAxis(linesOf([rows.stock(basis)]), ["line-0"]).step;
    // Raw range = basis (0.5 to 1.5 times it); raw step = basis / 200.
    expect(step(200)).toBe(1);
    expect(step(300)).toBe(2);
    expect(step(900)).toBe(5);
    expect(step(1200)).toBe(10);
    expect(step(3)).toBe(0.02);
  });

  it("never goes below 0 and has a width for a basis of 0 and without lines", () => {
    const empty = {
      max: 0.01,
      min: 0,
      start: 0,
      step: 0.01,
    };
    expect(priceAxis(linesOf([rows.stock(0)]), ["line-0"])).toEqual({
      ...empty,
      source: "stock-basis",
    });
    expect(priceAxis([], [])).toEqual({ ...empty, source: "strike-midpoint" });
  });

  it("holds the open breakeven range of a line", () => {
    const zeroCredit = linesOf([
      {
        expiry: JAN,
        kind: "bull-call-spread",
        legs: [leg("buy", "call", 100, 10), leg("sell", "call", 110, 0)],
      },
    ]);
    // Start 105; band 52.5 to 157.5; raw step 0.525 gives 1.
    expect(priceAxis(zeroCredit, ["line-0"])).toEqual({
      max: 158,
      min: 52,
      source: "strike-midpoint",
      start: 105,
      step: 1,
    });
  });
});

describe("inputs", () => {
  it("accepts whole contracts above 0 and any share count above 0", () => {
    expect(parseUnits("3", "long-call")).toBe(3);
    expect(parseUnits(" 12 ", "put-credit-spread")).toBe(12);
    expect(parseUnits("2.5", "stock")).toBe(2.5);
    for (const text of [
      "",
      " ",
      "0",
      "-1",
      "1.5",
      "abc",
      "1e3",
      "Infinity",
      "1,000",
    ])
      expect(parseUnits(text, "long-call")).toBeNull();
    for (const text of ["", "0", "-2", "x"])
      expect(parseUnits(text, "stock")).toBeNull();
  });

  it("accepts a price of 0 or more", () => {
    expect(parsePrice("0")).toBe(0);
    expect(parsePrice("320.25")).toBe(320.25);
    for (const text of ["", "-1", "abc", "1e400", ".5", "5."])
      expect(parsePrice(text)).toBeNull();
    expect(parsePrice("9".repeat(400))).toBeNull();
  });
});

describe("formats and texts", () => {
  it("writes amounts with the currency code in front when it is known", () => {
    expect(formatAmount(1500, "USD")).toBe("USD 1,500.00");
    expect(formatAmount(-250.456, null)).toBe("-250.46");
    expect(formatPrice(105)).toBe("105");
    expect(formatPlain(320)).toBe("320");
    expect(formatPlain(0.1 + 0.2)).toBe("0.3");
    expect(formatPlain(1_234_567.125)).toBe("1234567.125");
    expect(formatPrice(1234.567)).toBe("1,234.57");
  });

  it("writes the breakevens as points and ranges", () => {
    const text = (row: unknown) => {
      const line = one(row);
      const payoff = prepareExpiryPayoff(line.strategy, line.defaultUnits);
      if (!payoff.available) throw new Error(payoff.reason);
      return breakevenText(payoff);
    };
    expect(text(rows.call(JAN))).toBe("105");
    expect(
      text({
        expiry: JAN,
        kind: "long-call",
        legs: [leg("buy", "call", 100, 0)],
      })
    ).toBe("0 to 100");
    expect(
      text({
        expiry: JAN,
        kind: "bull-call-spread",
        legs: [leg("buy", "call", 100, 10), leg("sell", "call", 110, 0)],
      })
    ).toBe("110 and above");
    expect(
      text({
        expiry: JAN,
        kind: "bull-call-spread",
        legs: [leg("buy", "call", 100, 11), leg("sell", "call", 110, 0)],
      })
    ).toBe("none");
  });

  it("has one fixed text per reason and the limits of the model", () => {
    const texts = Object.values(REASON_TEXT);
    expect(texts).toHaveLength(15);
    expect(new Set(texts).size).toBe(15);
    expect(REASON_TEXT["no-legs"]).toBe("no legs stored");
    expect(REASON_TEXT["asset-type"]).toBe(
      "the lab draws only equity and ETF dossiers"
    );
    expect(LAB_LIMITS).toHaveLength(7);
    // The status-language guard refuses these words in user-facing text.
    for (const sentence of [...texts, ...LAB_LIMITS])
      expect(sentence).not.toMatch(
        /\b(unknown|n\/a|unavailable|not available|not set|unspecified|tbd)\b/iu
      );
  });
});
