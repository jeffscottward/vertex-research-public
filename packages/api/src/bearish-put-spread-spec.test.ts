import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  formatDay,
  isNyseHoliday,
  parseDay,
  weekday,
} from "./options-engine/calendar.ts";
import {
  type OptionsDatasetRows,
  optionsDatasetFromRows,
  runOptionsDefinition,
} from "./options-engine/portfolio.ts";
import { StrategyDefinitionSchema } from "./strategy-dsl.ts";

// The bearish put-spread definitions of docs/specs/strategies/bearish-put-spread.md parse as strategy
// definitions and run in the TypeScript options runner. On the synthetic history of
// services/research/tests/test_qc_ports_bearish_put.py they give the same trades as the Python book
// (values printed by that fixture), so both engines run the definitions the same way.

const SPEC = readFileSync(
  new URL(
    "../../../docs/specs/strategies/bearish-put-spread.md",
    import.meta.url
  ),
  "utf8"
);
const definitions = new Map(
  [...SPEC.matchAll(/### (\w+)\n.*?```json\n(.*?)\n```/gsu)].map((match) => [
    match[1] as string,
    StrategyDefinitionSchema.parse(JSON.parse(match[2] as string)),
  ])
);
const definition = (name: string) => {
  const found = definitions.get(name);
  if (found === undefined) throw new Error(`No definition ${name}`);
  return found;
};

const SIZE = 300;
const SIGNAL = 230;

const tradingDays = (start: string, count: number): string[] => {
  const out: string[] = [];
  for (let day = parseDay(start); out.length < count; day += 1) {
    if (weekday(day) < 5 && !isNyseHoliday(day)) out.push(formatDay(day));
  }
  return out;
};

const rows = (upPctOnSignal: number): OptionsDatasetRows => {
  const dates = tradingDays("2024-01-02", SIZE);
  const close = dates.map((_, index) => 200 - 0.2 * index);
  const high = [...close];
  high[SIGNAL] = (close[SIGNAL] as number) + 5;
  const upPct = dates.map((_, index) =>
    index === SIGNAL ? upPctOnSignal : 55
  );
  const flat = dates.map(() => 100);
  return {
    IRX: { close: dates.map(() => 4), dates },
    NYSE_UPVOL_PCT: { close: upPct, dates },
    QQQ: { adjClose: close, close, dates, high, low: close, open: close },
    SPY: {
      adjClose: flat,
      close: flat,
      dates,
      high: flat,
      low: flat,
      open: flat,
    },
    VXN: { close: dates.map(() => 25), dates },
  };
};

const run = (name: string, upPct: number) =>
  runOptionsDefinition(definition(name), optionsDatasetFromRows(rows(upPct)), {
    start: "2024-01-02",
    symbol: "QQQ",
  });

describe("bearish put-spread definitions", () => {
  it("are the four definitions of the spec and parse unchanged", () => {
    expect([...definitions.keys()]).toEqual([
      "RULE_EXIT3",
      "RULE_EXPIRY",
      "PROXY_EXIT3",
      "BASELINE",
    ]);
    for (const parsed of definitions.values())
      expect(parsed.options).toMatchObject({
        dte: { min: 45, target: 52 },
        longDelta: 0.425,
        maxLossPct: 2,
        structure: "putDebitVertical",
        widthSigma: 0.6,
      });
  });

  it("trade the Python book's spread one session after the signal", () => {
    const early = run("RULE_EXIT3", 55);
    expect(early.priced).toHaveLength(1);
    expect(early.priced[0]).toMatchObject({
      entryDate: "2024-12-02",
      entryFee: 11.18,
      entryPrice: 194.79,
      exitDate: "2025-01-14",
      exitFee: 9.74,
      exitPrice: 435.36,
      exitReason: "exitDte",
      expiry: "2025-01-17",
      longStrike: 153,
      maxLoss: 228.27,
      shortStrike: 146,
      structure: "putDebitVertical",
    });
    expect(early.result.equity.at(-1)).toBeCloseTo(101_757.2, 6);
    const held = run("RULE_EXPIRY", 55);
    expect(held.priced[0]).toMatchObject({
      exitDate: "2025-01-17",
      exitFee: 0,
      exitPrice: 560,
      exitReason: "expiry",
    });
    expect(held.result.equity.at(-1)).toBeCloseTo(102_832.24, 6);
  });

  it("skip a heavy down-volume day only with the breadth filter", () => {
    expect(run("RULE_EXIT3", 13.1).priced).toHaveLength(0);
    expect(run("PROXY_EXIT3", 13.1).priced[0]).toMatchObject({
      entryDate: "2024-12-02",
      exitPrice: 435.36,
    });
  });

  it("enter the baseline on every free bar", () => {
    const baseline = run("BASELINE", 55);
    expect(baseline.priced).toHaveLength(7);
    expect(baseline.priced[0]).toMatchObject({
      entryDate: "2024-01-03",
      entryPrice: 318.51,
    });
    expect(baseline.result.equity.at(-1)).toBeCloseTo(114_891.31, 6);
  });
});
