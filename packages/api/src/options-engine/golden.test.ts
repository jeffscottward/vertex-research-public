import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildOptionsBook,
  type LedgerResult,
  type Market,
  type PricedTrade,
  runOptionsLedger,
  summarizeOptionsRun,
} from "./index.ts";

/**
 * Parity with the Python reference: services/research/tests/fixtures/qc_ports/options_golden.json
 * (services/research/tests/qc_ports_golden.py) holds synthetic markets, signal events and options blocks with
 * the Python book, ledger and summaries. Trades, skips and ledger records must be identical;
 * unrounded floats (premium, equity, statistics) may differ by the last-bit libm differences
 * described in libm.ts, bounded here at 1e-9 relative (the largest gap is reported).
 */
interface GoldenLedger {
  capital: number;
  dates: "run" | "marks";
  result: Omit<LedgerResult, "dates"> & { days: number };
  summaries: {
    nTrials: number;
    trialVariance: number | null;
    stats: Record<string, unknown>;
  }[];
}

interface GoldenCase {
  name: string;
  marketSet: string;
  options: Record<string, unknown>;
  events: [string, number, number | null][];
  book: {
    trades: PricedTrade[];
    skipped: {
      symbol: string;
      entryIndex: number;
      exitIndex: number | null;
      reason: string;
    }[];
  };
  ledgers: GoldenLedger[];
}

const golden = JSON.parse(
  readFileSync(
    new URL(
      "../../../../services/research/tests/fixtures/qc_ports/options_golden.json",
      import.meta.url
    ),
    "utf8"
  )
) as {
  marketSets: Record<string, Record<string, Market>>;
  runDays: Record<string, string[]>;
  cases: GoldenCase[];
};

const gaps = { premium: 0, equity: 0, stats: 0 };

/** Relative gap of two numbers (0 when equal, including both null). */
const gap = (actual: unknown, expected: unknown): number => {
  if (actual === expected) return 0;
  if (typeof actual !== "number" || typeof expected !== "number")
    return Number.POSITIVE_INFINITY;
  return (
    Math.abs(actual - expected) / Math.max(Math.abs(actual), Math.abs(expected))
  );
};

describe("options engine golden parity with the Python qc-ports runner", () => {
  it.each(golden.cases.map((testCase) => [testCase.name, testCase] as const))(
    "%s",
    (_name, testCase) => {
      const markets = golden.marketSets[testCase.marketSet] as Record<
        string,
        Market
      >;
      const book = buildOptionsBook(testCase.events, testCase.options, markets);

      expect(book.trades).toHaveLength(testCase.book.trades.length);
      book.trades.forEach((trade, index) => {
        const expected = testCase.book.trades[index] as PricedTrade;
        gaps.premium = Math.max(
          gaps.premium,
          gap(trade.premium, expected.premium)
        );
        expect({ ...trade, premium: 0 }).toEqual({ ...expected, premium: 0 });
      });
      expect(
        book.skipped.map(({ event, reason }) => ({
          symbol: event.symbol,
          entryIndex: event.entryIndex,
          exitIndex: event.exitIndex ?? null,
          reason,
        }))
      ).toEqual(testCase.book.skipped);

      for (const ledger of testCase.ledgers) {
        const runDays = golden.runDays[testCase.marketSet] as string[];
        const result = runOptionsLedger(book.trades, {
          capital: ledger.capital,
          dates: ledger.dates === "run" ? runDays : null,
        });
        const { days, equity, ...rest } = ledger.result;
        const markDays = [
          ...new Set(
            testCase.book.trades.flatMap((trade) =>
              trade.marks.map(([day]) => day)
            )
          ),
        ].sort();
        expect(result.dates).toEqual(
          ledger.dates === "run" ? runDays : markDays
        );
        expect(result.dates).toHaveLength(days);
        const { dates: _dates, equity: actualEquity, ...actualRest } = result;
        expect(actualRest).toEqual(rest);
        expect(actualEquity).toHaveLength(equity.length);
        actualEquity.forEach((value, index) => {
          gaps.equity = Math.max(gaps.equity, gap(value, equity[index]));
        });

        for (const summary of ledger.summaries) {
          const stats = summarizeOptionsRun(result, {
            nTrials: summary.nTrials,
            trialVariance: summary.trialVariance,
          }) as unknown as Record<string, unknown>;
          expect(Object.keys(stats)).toEqual(Object.keys(summary.stats));
          for (const [key, expected] of Object.entries(summary.stats)) {
            if (typeof expected === "number")
              gaps.stats = Math.max(gaps.stats, gap(stats[key], expected));
            else expect([key, stats[key]]).toEqual([key, expected]);
          }
        }
      }
    }
  );

  it("stays within 1e-9 relative on every unrounded value", () => {
    console.info(
      `options-engine golden max relative gap: premium ${gaps.premium}, equity ${gaps.equity}, stats ${gaps.stats}`
    );
    expect(gaps.premium).toBeLessThanOrEqual(1e-9);
    expect(gaps.equity).toBeLessThanOrEqual(1e-9);
    expect(gaps.stats).toBeLessThanOrEqual(1e-9);
  });
});
