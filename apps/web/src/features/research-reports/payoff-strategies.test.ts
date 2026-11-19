import { describe, expect, it } from "vitest";

import {
  type AssetGate,
  assetGate,
  type CatalogFacts,
  LEGACY_MULTIPLIER_REPORT_IDS,
  type ParsedStrategies,
  parsePayoffStrategies,
  UNTYPED_REPORT_IDS,
} from "./payoff-strategies.ts";

// Synthetic fixtures only; no stored dossier data.
type Parsed = Extract<ParsedStrategies, { state: "parsed" }>;

const parse = (
  data: unknown,
  overrides: Partial<{
    reportId: string;
    gate: AssetGate;
    catalogCurrency: string | null;
  }> = {}
): ParsedStrategies =>
  parsePayoffStrategies(data, {
    catalogCurrency: null,
    gate: "allowed",
    reportId: "AAA",
    ...overrides,
  });

const parsed = (
  strategies: readonly unknown[],
  overrides: Parameters<typeof parse>[1] = {},
  extra: Readonly<Record<string, unknown>> = {}
): Parsed => {
  const result = parse({ ...extra, strategies }, overrides);
  if (result.state !== "parsed") throw new Error(result.state);
  return result;
};

const call = (strike: number, premium: number, multiplier?: unknown) => ({
  premium,
  side: "buy",
  strike,
  type: "call",
  ...(multiplier === undefined ? {} : { multiplier }),
});
const longCall = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  expiry: "2027-01-15",
  id: "row-a",
  kind: "long-call",
  legs: [call(100, 5, 100)],
  quantity: 1,
  ...overrides,
});
const hypotheticalStock = (
  overrides: Readonly<Record<string, unknown>> = {}
) => ({
  hypothetical: true,
  kind: "stock",
  stockEntry: 40,
  stockShares: 100,
  ...overrides,
});
const reasonsOf = (result: Parsed): readonly string[] =>
  result.notDrawable.map((entry) => `${entry.reason}:${entry.rows}`);

const facts = (
  assetType: string | null
): Extract<CatalogFacts, { status: "ready" }> => ({
  assetType,
  currency: null,
  status: "ready",
});

describe("assetGate", () => {
  it("lets an equity or ETF dossier pass, in any letter case", () => {
    for (const assetType of ["equity", "etf", "ETF", "Equity", " etf "])
      expect(assetGate("AAA", facts(assetType))).toBe("allowed");
  });

  it("refuses every other stated type", () => {
    for (const assetType of ["future", "index", "equities"])
      expect(assetGate("APP", facts(assetType))).toBe("refused");
  });

  it("lets a report without a stated type pass only when it is APP or SIVE", () => {
    expect(UNTYPED_REPORT_IDS).toEqual(["APP", "SIVE"]);
    for (const assetType of [null, "", "  "]) {
      expect(assetGate("APP", facts(assetType))).toBe("allowed");
      expect(assetGate("SIVE", facts(assetType))).toBe("allowed");
      expect(assetGate("AAA", facts(assetType))).toBe("refused");
    }
  });

  it("refuses when the catalog could not be read", () => {
    expect(assetGate("APP", { status: "failed" })).toBe("unread");
  });
});

describe("parsePayoffStrategies: states", () => {
  it("reports a dataset without strategies", () => {
    for (const data of [null, undefined, 7, "text", [], {}, { strategies: [] }])
      expect(parse(data)).toEqual({ state: "no-strategies" });
  });

  it("reports strategies that are not an array, and has no row limit", () => {
    for (const strategies of [null, 7, "rows", { 0: longCall() }, true])
      expect(parse({ strategies })).toEqual({ state: "malformed" });
    const rows = Array.from({ length: 600 }, () => longCall());
    expect(parsed(rows).stored).toBe(600);
    expect(parsed(rows).lines).toHaveLength(1);
  });
});

describe("parsePayoffStrategies: rows", () => {
  it("draws the four option kinds and a hypothetical stock row", () => {
    const result = parsed(
      [
        longCall(),
        {
          expiry: "2027-01-15",
          kind: "cash-secured-put",
          legs: [
            {
              multiplier: 100,
              premium: 4,
              side: "sell",
              strike: 90,
              type: "put",
            },
          ],
        },
        {
          expiry: "2027-03-19",
          kind: "bull-call-spread",
          legs: [
            call(110, 3, 100),
            {
              multiplier: 100,
              premium: 1,
              side: "sell",
              strike: 120,
              type: "call",
            },
          ],
        },
        {
          expiry: "2027-03-19",
          kind: "put-credit-spread",
          legs: [
            {
              multiplier: 100,
              premium: 3,
              side: "sell",
              strike: 95,
              type: "put",
            },
            {
              multiplier: 100,
              premium: 1,
              side: "buy",
              strike: 85,
              type: "put",
            },
          ],
        },
        hypotheticalStock(),
      ],
      {},
      { currency: "SEK" }
    );
    expect(result.stored).toBe(5);
    expect(result.drawableRows).toBe(5);
    expect(result.notDrawable).toEqual([]);
    expect(result.notShown).toBe(0);
    expect(result.currency).toBe("SEK");
    expect(
      result.lines.map((line) => [
        line.key,
        line.kind,
        line.expiry,
        line.strikes,
        line.defaultUnits,
        line.rows,
        line.netPremium,
        line.breakevens,
      ])
    ).toEqual([
      ["line-0", "long-call", "2027-01-15", [100], 1, 1, 5, [105]],
      ["line-1", "cash-secured-put", "2027-01-15", [90], 1, 1, -4, [86]],
      ["line-2", "bull-call-spread", "2027-03-19", [110, 120], 1, 1, 2, [112]],
      ["line-3", "put-credit-spread", "2027-03-19", [85, 95], 1, 1, -2, [93]],
      ["line-4", "stock", null, [], 100, 1, 40, [40]],
    ]);
    expect(result.lines[4]?.strategy).toEqual({ basis: 40, kind: "stock" });
  });

  it("does not show a stock row that is not marked hypothetical with shares above 0", () => {
    const result = parsed([
      hypotheticalStock({ hypothetical: undefined }),
      hypotheticalStock({ hypothetical: "true" }),
      hypotheticalStock({ hypothetical: 1 }),
      hypotheticalStock({ stockShares: 0 }),
      hypotheticalStock({ stockShares: -5 }),
      hypotheticalStock({ stockShares: "100" }),
      hypotheticalStock({ stockShares: Number.POSITIVE_INFINITY }),
      hypotheticalStock({ stockShares: undefined }),
    ]);
    expect(result.notShown).toBe(8);
    expect(result.lines).toEqual([]);
    expect(result.notDrawable).toEqual([]);
    expect(result.drawableRows).toBe(0);
  });

  it("counts a hypothetical stock row without a usable basis as not drawable", () => {
    const result = parsed([
      hypotheticalStock({ stockEntry: undefined }),
      hypotheticalStock({ stockEntry: "40" }),
      hypotheticalStock({ stockEntry: -1 }),
      hypotheticalStock({ stockEntry: Number.MAX_VALUE, stockShares: 10 }),
      hypotheticalStock({ stockShares: 2.5 }),
    ]);
    expect(reasonsOf(result)).toEqual(["range:1", "stock-basis:3"]);
    expect(result.lines.map((line) => line.defaultUnits)).toEqual([2.5]);
  });

  it("gives every option row that cannot be drawn one fixed reason", () => {
    const put = { premium: 4, side: "sell", strike: 90, type: "put" };
    const result = parsed([
      null,
      7,
      ["long-call"],
      longCall({ kind: "iron-condor" }),
      longCall({ kind: "__proto__" }),
      longCall({ kind: undefined }),
      longCall({ legs: undefined }),
      longCall({ legs: [] }),
      longCall({ legs: "none" }),
      longCall({ legs: [call(100, 5, 100), put, put] }),
      longCall({ legs: ["buy call"] }),
      longCall({ legs: [{ ...call(100, 5, 100), side: "hold" }] }),
      longCall({ legs: [{ ...call(100, 5, 100), type: "future" }] }),
      longCall({ expiry: undefined }),
      longCall({ expiry: "2027-02-30" }),
      longCall({ expiry: "15 Jan 2027" }),
      longCall({ expiry: 20_270_115 }),
      longCall({ legs: [call(Number.NaN, 5, 100)] }),
      longCall({ legs: [{ ...call(100, 5, 100), strike: "100" }] }),
      longCall({ legs: [{ ...call(100, 5, 100), premium: null }] }),
      longCall({ legs: [{ ...call(100, 5, 100), premium: "5" }] }),
      longCall({ legs: [put] }),
      longCall({ legs: [call(100, 5)] }),
      longCall({ legs: [call(100, 5, "unverified")] }),
      longCall({ multiplier: null }),
      longCall({ multiplier: 10 }),
      longCall({ legs: [call(100, Number.MAX_VALUE, 100)] }),
    ]);
    expect(reasonsOf(result)).toEqual([
      "expiry:4",
      "leg-shape:4",
      "multiplier-invalid:2",
      "multiplier-mismatch:1",
      "multiplier-missing:1",
      "no-legs:3",
      "premium:2",
      "range:1",
      "row-shape:6",
      "strike:2",
      "structure:1",
    ]);
    expect(result.lines).toEqual([]);
    expect(result.stored).toBe(27);
    expect(result.drawableRows + result.notShown).toBe(0);
  });

  it("refuses a strike, basis or breakeven beyond the supported price range", () => {
    const result = parsed([
      longCall({ legs: [call(2e12, 5, 100)] }),
      longCall({ legs: [call(1e12, 5, 100)] }),
      hypotheticalStock({ stockEntry: 2e12 }),
      longCall({ legs: [call(1e12, 0, 100)] }),
    ]);
    // The second row has its breakeven above the limit; the last one is exactly on it.
    expect(reasonsOf(result)).toEqual(["range:3"]);
    expect(result.lines.map((line) => line.strikes)).toEqual([[1e12]]);
  });

  it("checks the legs before the expiry date", () => {
    expect(
      reasonsOf(parsed([longCall({ expiry: undefined, legs: [] })]))
    ).toEqual(["no-legs:1"]);
  });

  it("applies the asset-type gate to every row that could be drawn", () => {
    const rows = [
      longCall(),
      longCall({ legs: [] }),
      hypotheticalStock(),
      hypotheticalStock({ hypothetical: false }),
      "text",
    ];
    const refused = parsed(rows, { gate: "refused" });
    expect(reasonsOf(refused)).toEqual(["asset-type:3", "row-shape:1"]);
    expect(refused.lines).toEqual([]);
    expect(refused.notShown).toBe(1);
    const unread = parsed(rows, { gate: "unread" });
    expect(reasonsOf(unread)).toEqual(["asset-type-unread:3", "row-shape:1"]);
    expect(unread.lines).toEqual([]);
    expect(parsed(rows).lines.map((line) => line.kind)).toEqual([
      "long-call",
      "stock",
    ]);
  });

  it("assumes 100 shares per contract only for a report in the legacy list", () => {
    expect(LEGACY_MULTIPLIER_REPORT_IDS).toEqual(["APP"]);
    const rows = [longCall({ legs: [call(100, 5)] })];
    expect(reasonsOf(parsed(rows, { reportId: "SIVE" }))).toEqual([
      "multiplier-missing:1",
    ]);
    const app = parsed(rows, { reportId: "APP" });
    expect(app.lines[0]?.strategy).toEqual({
      assumedMultiplier: 100,
      kind: "long-call",
      legs: [
        {
          multiplier: undefined,
          premium: 5,
          side: "buy",
          strike: 100,
          type: "call",
        },
      ],
      multiplier: undefined,
    });
    // A stored strategy multiplier works for any report.
    expect(
      parsed([longCall({ legs: [call(100, 5)], multiplier: "10" })]).lines
    ).toHaveLength(1);
  });

  it("merges rows that differ only in fields outside the line and counts them", () => {
    const result = parsed([
      longCall({ id: "a", quantity: 1 }),
      hypotheticalStock(),
      longCall({ id: "b", quantity: 5 }),
      longCall({ id: "c", legs: [call(100, 6, 100)] }),
      longCall({ expiry: "2027-03-19", id: "d" }),
      longCall({ id: "e", quantity: 9 }),
    ]);
    expect(result.drawableRows).toBe(6);
    expect(result.lines.map((line) => [line.key, line.rows])).toEqual([
      ["line-0", 3],
      ["line-1", 1],
      ["line-3", 1],
      ["line-4", 1],
    ]);
  });

  it("keeps stock rows with a different basis or share count apart", () => {
    const result = parsed([
      hypotheticalStock(),
      hypotheticalStock({ stockEntry: 45 }),
      hypotheticalStock({ stockShares: 50 }),
      hypotheticalStock({ name: "same line" }),
    ]);
    expect(
      result.lines.map((line) => [line.key, line.rows, line.defaultUnits])
    ).toEqual([
      ["line-0", 2, 100],
      ["line-1", 1, 100],
      ["line-2", 1, 50],
    ]);
  });

  it("takes the currency from the dataset, then from the catalog, else none", () => {
    const rows = [hypotheticalStock()];
    expect(
      parsed(rows, { catalogCurrency: "USD" }, { currency: "SEK" }).currency
    ).toBe("SEK");
    expect(
      parsed(rows, { catalogCurrency: "USD" }, { currency: "kr" }).currency
    ).toBe("USD");
    expect(parsed(rows, { catalogCurrency: "USD" }).currency).toBe("USD");
    expect(parsed(rows, { catalogCurrency: "dollars" }).currency).toBeNull();
    expect(parsed(rows, {}, { currency: 7 }).currency).toBeNull();
  });

  it("accounts for every stored row", () => {
    const result = parsed([
      longCall(),
      longCall({ quantity: 3 }),
      longCall({ legs: [] }),
      hypotheticalStock(),
      hypotheticalStock({ hypothetical: false }),
      "text",
    ]);
    const notDrawable = result.notDrawable.reduce(
      (sum, item) => sum + item.rows,
      0
    );
    expect(result.stored).toBe(6);
    expect(result.drawableRows + notDrawable + result.notShown).toBe(6);
    expect([result.drawableRows, notDrawable, result.notShown]).toEqual([
      3, 2, 1,
    ]);
  });
});

describe("parsePayoffStrategies: privacy by construction", () => {
  // Every field that the closed line type does not carry holds a unique sentinel.
  const TEXT = "SENTINEL-TEXT";
  const NUMBER = 987_654_321;
  const free = (tag: string) => ({
    capitalRequired: NUMBER + 1,
    entryPrice: NUMBER + 2,
    id: `${TEXT}-id-${tag}`,
    maxLoss: NUMBER + 3,
    name: `${TEXT}-name-${tag}`,
    notes: [`${TEXT}-note-${tag}`],
    quantity: NUMBER + 4,
    quoteBasis: `${TEXT}-quote-${tag}`,
    status: `${TEXT}-status-${tag}`,
  });
  const dataset = {
    brokerRefresh: { cash: NUMBER + 5, note: `${TEXT}-broker` },
    recommendation: {
      headline: `${TEXT}-headline`,
      strategyId: `${TEXT}-id-option`,
    },
    strategies: [
      // Not shown: a stock row from a user-reported order.
      {
        ...free("order"),
        kind: "stock",
        stockEntry: NUMBER + 6,
        stockShares: NUMBER + 7,
      },
      // Drawn: an option row and a hypothetical stock row, both with free text around them.
      {
        ...free("option"),
        expiry: "2027-01-15",
        kind: "long-call",
        legs: [
          {
            ...call(100, 5, 100),
            contractSymbol: `${TEXT}-contract`,
            delta: NUMBER + 8,
          },
        ],
      },
      { ...free("stock"), ...hypotheticalStock() },
      // Not drawable: its text and numbers must not survive either.
      {
        ...free("legless"),
        expiry: `${TEXT}-expiry`,
        kind: "long-call",
        legs: [],
      },
      { ...free("kind"), kind: `${TEXT}-kind` },
    ],
    userStatedOrder: { shares: NUMBER + 9, text: `${TEXT}-order` },
  };

  it("lets no sentinel string or number into its output", () => {
    const result = parse(dataset);
    const text = JSON.stringify(result);
    expect(result.state).toBe("parsed");
    expect(text).not.toContain("SENTINEL");
    expect(text).not.toMatch(/9876543\d\d/u);
  });
});
