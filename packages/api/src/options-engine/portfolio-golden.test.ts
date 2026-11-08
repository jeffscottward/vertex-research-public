import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { StrategyDefinitionSchema } from "../strategy-dsl.ts";
import {
  type OptionsDatasetRows,
  optionsDatasetFromRows,
  optionsRunMetrics,
  runOptionsDefinition,
} from "./index.ts";

/**
 * Whole-definition parity with portfolio.run_definition: portfolio_golden.json
 * (strategies/qc_ports/golden.py) runs the definitions of portfolio_definitions.json on synthetic
 * store rows. Trades, skips and signal counts must be identical; equity and metrics within 1e-9
 * relative (the largest gap is reported).
 */
const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(
        `../../../../services/research/tests/fixtures/qc_ports/${name}`,
        import.meta.url
      ),
      "utf8"
    )
  );

interface Table {
  columns: string[];
  rows: unknown[][];
}

interface GoldenRun {
  bookSkipped: number;
  metrics: Record<string, unknown>[];
  name: string;
  priced: Table;
  result: {
    days: number;
    first: string;
    equity: number[];
    openPositions: number[];
    trades: Table;
    skipped: unknown[];
    capital: number;
    engine: string;
  };
  signals: Record<string, number>;
}

const golden = fixture("portfolio_golden.json") as {
  calendar: string[];
  rows: Record<string, Record<string, unknown>>;
  cases: GoldenRun[];
};
const inputs = fixture("portfolio_definitions.json") as {
  cases: {
    name: string;
    definition: unknown;
    start: string;
    end?: string;
    capital?: number;
    symbol?: string;
  }[];
};

/** Expands the fixture's shorthands: dates "calendar" = the SPY dates, a column "close" = the close column. */
const rows: OptionsDatasetRows = Object.fromEntries(
  Object.entries(golden.rows).map(([seriesId, row]) => [
    seriesId,
    Object.fromEntries(
      Object.entries(row).map(([key, values]) => [
        key,
        values === "calendar"
          ? golden.calendar
          : values === "close"
            ? row["close"]
            : values,
      ])
    ),
  ])
) as OptionsDatasetRows;

const records = (table: Table) =>
  table.rows.map((row) =>
    Object.fromEntries(
      table.columns.map((column, index) => [column, row[index]])
    )
  );

const gap = (actual: unknown, expected: unknown): number => {
  if (actual === expected) return 0;
  if (typeof actual !== "number" || typeof expected !== "number")
    return Number.POSITIVE_INFINITY;
  return (
    Math.abs(actual - expected) / Math.max(Math.abs(actual), Math.abs(expected))
  );
};

const gaps = new Map<
  string,
  { equity: number; metrics: number; premium: number }
>();
const TRIAL_VARIANCE = 0.0004;

describe("options portfolio runner golden parity with portfolio.run_definition", () => {
  const data = optionsDatasetFromRows(rows);

  it.each(
    golden.cases.map(
      (run, index) => [run.name, run, inputs.cases[index]] as const
    )
  )("%s", (name, run, input) => {
    expect(input?.name).toBe(name);
    const spec = input as NonNullable<typeof input>;
    const outcome = runOptionsDefinition(
      StrategyDefinitionSchema.parse(spec.definition),
      data,
      {
        start: spec.start,
        ...(spec.end === undefined ? {} : { end: spec.end }),
        ...(spec.capital === undefined ? {} : { capital: spec.capital }),
        ...(spec.symbol === undefined ? {} : { symbol: spec.symbol }),
      }
    );
    const found = { equity: 0, metrics: 0, premium: 0 };
    const { result } = outcome;
    expect(result.dates).toHaveLength(run.result.days);
    expect(result.dates[0]).toBe(run.result.first);
    expect(result.openPositions).toEqual(run.result.openPositions);
    expect(result.trades).toEqual(records(run.result.trades));
    expect(result.skipped).toEqual(run.result.skipped);
    expect([result.capital, result.engine]).toEqual([
      run.result.capital,
      run.result.engine,
    ]);
    expect(result.equity).toHaveLength(run.result.equity.length);
    result.equity.forEach((value, index) => {
      found.equity = Math.max(
        found.equity,
        gap(value, run.result.equity[index])
      );
    });
    const priced = records(run.priced);
    expect(outcome.priced).toHaveLength(priced.length);
    outcome.priced.forEach((trade, index) => {
      const expected = priced[index] as Record<string, unknown>;
      found.premium = Math.max(
        found.premium,
        gap(trade.premium, expected["premium"])
      );
      const actual = Object.fromEntries(
        run.priced.columns.map((column) => [
          column,
          (trade as unknown as Record<string, unknown>)[column],
        ])
      );
      expect({ ...actual, premium: 0 }).toEqual({ ...expected, premium: 0 });
    });
    expect(outcome.bookSkipped).toBe(run.bookSkipped);
    expect(outcome.signals).toEqual(run.signals);
    const metrics = [
      optionsRunMetrics(outcome),
      optionsRunMetrics(outcome, 32, TRIAL_VARIANCE),
    ];
    metrics.forEach((stats, index) => {
      const expected = run.metrics[index] as Record<string, unknown>;
      expect(Object.keys(stats)).toEqual(Object.keys(expected));
      for (const [key, value] of Object.entries(expected)) {
        const actual = (stats as unknown as Record<string, unknown>)[key];
        if (typeof value === "number")
          found.metrics = Math.max(found.metrics, gap(actual, value));
        else expect([key, actual]).toEqual([key, value]);
      }
    });
    gaps.set(name, found);
  });

  it("stays within 1e-9 relative on equity and metrics", () => {
    for (const [name, found] of gaps)
      console.info(
        `options portfolio golden ${name}: equity ${found.equity}, metrics ${found.metrics}, premium ${found.premium}`
      );
    expect(gaps.size).toBe(golden.cases.length);
    for (const found of gaps.values()) {
      expect(found.equity).toBeLessThanOrEqual(1e-9);
      expect(found.metrics).toBeLessThanOrEqual(1e-9);
      expect(found.premium).toBeLessThanOrEqual(1e-9);
    }
  });
});
