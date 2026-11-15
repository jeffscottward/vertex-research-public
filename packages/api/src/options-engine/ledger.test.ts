import { describe, expect, it } from "vitest";
import type { PricedTrade } from "./book.ts";
import { runLedger, timeline } from "./ledger.ts";

const trade = (
  tradeId: number,
  entryDate: string,
  exitDate: string,
  marks: [string, number][],
  overrides: Partial<PricedTrade> = {}
): PricedTrade => {
  const entryPrice = (marks[0] as [string, number])[1];
  return {
    entryDate,
    entryFee: 1.3,
    entryIndex: 0,
    entryPrice,
    exitDate,
    exitFee: 1.3,
    exitIndex: 2,
    exitPrice: (marks.at(-1) as [string, number])[1],
    exitReason: "signal",
    expiry: "2024-02-16",
    longStrike: 100,
    marks,
    maxLoss: Math.round((entryPrice + 1.3 + 11.3) * 100) / 100,
    maxLossPct: 2,
    premium: 1,
    shortStrike: 105,
    staleDays: 0,
    structure: "callDebitVertical",
    symbol: "SPY",
    tradeId,
    width: 5,
    ...overrides,
  };
};

// Expected values: services/research/strategies/qc_ports/ledger.py run_ledger on the same trades.
const a = trade(2, "2024-01-02", "2024-01-05", [
  ["2024-01-02", 250],
  ["2024-01-03", 260],
  ["2024-01-05", 300],
]);
const b = trade(
  1,
  "2024-01-03",
  "2024-01-05",
  [
    ["2024-01-03", 120],
    ["2024-01-04", 90],
    ["2024-01-05", 140],
  ],
  { exitFee: 0, exitReason: "expiry" }
);
const c = trade(
  3,
  "2024-01-03",
  "2024-01-04",
  [
    ["2024-01-03", 4000],
    ["2024-01-04", 4100],
  ],
  { maxLoss: 6000 }
);
const DAYS = [
  "2024-01-02",
  "2024-01-03",
  "2024-01-04",
  "2024-01-05",
  "2024-01-08",
];

describe("runLedger", () => {
  it("sizes, carries the last mark, skips unaffordable trades and sorts the records", () => {
    const result = runLedger([a, b, c], 30_000, DAYS);
    expect(result.equity).toEqual([
      29_997.4, 30_012.2, 29_892.2, 30_169.6, 30_169.6,
    ]);
    expect(result.openPositions).toEqual([1, 2, 2, 0, 0]);
    expect(result.skipped).toEqual([
      { entryDate: "2024-01-03", id: 3, reason: "size", symbol: "SPY" },
    ]);
    expect(
      result.trades.map((record) => [
        record.id,
        record.contracts,
        record.pnl,
        record.returnOnRisk,
      ])
    ).toEqual([
      [1, 4, 74.8, 0.141_025_641_025_641_02],
      [2, 2, 94.8, 0.180_502_665_651_180_48],
    ]);
    expect([result.capital, result.engine]).toEqual([
      30_000,
      "qc-ports-ledger",
    ]);
  });

  it("runs on the mark days with the default capital", () => {
    const result = runLedger([a]);
    expect(result.dates).toEqual(["2024-01-02", "2024-01-03", "2024-01-05"]);
    expect(result.capital).toBe(100_000);
  });

  it("refuses a bad capital, foreign mark dates, repeated ids and trades left open", () => {
    expect(() => runLedger([a], 0)).toThrow("capital must be above 0");
    expect(() => runLedger([a], Number.NaN)).toThrow("capital must be above 0");
    expect(() => timeline([a], ["2024-01-02", "2024-01-03"])).toThrow(
      "Mark dates outside the run dates: 2024-01-05"
    );
    expect(() => timeline([a, { ...b, tradeId: 2 }])).toThrow(
      "Trade ids must be unique"
    );
    const early = trade(4, "2024-01-02", "2024-01-09", [["2024-01-02", 10]]);
    expect(() => runLedger([early], 30_000, DAYS)).toThrow(
      "Trades open after the last run day"
    );
  });
});
