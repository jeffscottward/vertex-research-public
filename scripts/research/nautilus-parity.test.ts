import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  BarColumns,
  InstantRunResult,
  InstantStats,
  InstantTrade,
} from "../../packages/api/src/instant-backtest-engine.ts";
import { BACKTEST_UNIVERSES } from "../../packages/shared/src/universes/index.ts";
import {
  argValue,
  type Batch,
  batchInput,
  buildCases,
  type Case,
  compare,
  compareCase,
  explain,
  libraryDefinitions,
  PERIODS,
  type ParityIo,
  type PyResult,
  parseBarsCsv,
  relDiff,
  renderMarkdown,
  type Row,
  runNautilusParity,
  runTs,
  slice,
  summarizeStrategies,
  TOLERANCES,
} from "./nautilus-parity.ts";

const repoRoot = join(import.meta.dirname, "..", "..");
const libraryText = readFileSync(
  join(repoRoot, "research/backtests/quantjourney/library.json"),
  "utf8"
);
const DAY_MS = 86_400_000;

/** Bars from [open, high, low, close] rows, one per day from 2020-01-01. */
const barsOf = (
  rows: readonly (readonly [number, number, number, number])[],
  withVolume = true
): BarColumns => {
  const start = Date.UTC(2020, 0, 1);
  return {
    c: Float64Array.from(rows, (row) => row[3]),
    h: Float64Array.from(rows, (row) => row[1]),
    l: Float64Array.from(rows, (row) => row[2]),
    o: Float64Array.from(rows, (row) => row[0]),
    t: Float64Array.from(rows, (_, index) => start + index * DAY_MS),
    ...(withVolume ? { v: Float64Array.from(rows, () => 1000) } : {}),
  };
};

const FLAT = [100, 101, 99, 100] as const;
const flatBars = barsOf([FLAT, FLAT, FLAT, FLAT, FLAT]);

const STATS: InstantStats = {
  bars: 5,
  buyHoldMaxDrawdown: 0,
  buyHoldReturn: 0,
  cagr: null,
  exposure: 0,
  maxDrawdown: -0.1,
  profitFactor: null,
  sharpe: 1,
  sortino: null,
  totalReturn: 0.2,
  trades: 0,
  winRate: null,
};

type TradeInput = Pick<
  InstantTrade,
  "entryIndex" | "exitIndex" | "exitPrice" | "exitReason"
>;

const trade = (input: TradeInput): InstantTrade => ({
  entryPrice: 100,
  netReturn: 0,
  pnl: 0,
  units: 1,
  ...input,
});

const tsResult = (
  trades: readonly TradeInput[],
  stats: Partial<InstantStats> = {}
): InstantRunResult => ({
  equity: Float64Array.from([1, 1, 1, 1, 1.2]),
  stats: { ...STATS, ...stats },
  trades: trades.map(trade),
});

/** The Nautilus side of `ts`, with the given changes. */
const pyOf = (
  ts: InstantRunResult,
  change: Partial<PyResult> = {}
): PyResult => ({
  equity: Array.from(ts.equity),
  stats: {
    maxDrawdown: ts.stats.maxDrawdown,
    sharpe: ts.stats.sharpe,
    totalReturn: ts.stats.totalReturn,
  },
  trades: ts.trades.map((entry) => ({ ...entry })),
  ...change,
});

const STOP_TRADE = {
  entryIndex: 1,
  exitIndex: 2,
  exitPrice: 99,
  exitReason: "stop",
} as const;

describe("argValue", () => {
  it("reads the value after a flag and rejects a missing one", () => {
    expect(argValue(["--data", "dir"], "--data")).toBe("dir");
    expect(() => argValue(["--data"], "--data")).toThrow("missing --data");
    expect(() => argValue([], "--out")).toThrow("missing --out");
  });
});

describe("bars", () => {
  it("parses an importer CSV and slices a date range with or without volume", () => {
    const text = [
      "t,o,h,l,c,v",
      `${Date.UTC(2020, 0, 1)},1,2,0.5,1.5,10`,
      `${Date.UTC(2020, 0, 2)},2,3,1.5,2.5,20`,
      `${Date.UTC(2020, 0, 3)},3,4,2.5,3.5,30`,
      "",
    ].join("\n");
    const bars = parseBarsCsv(text);
    expect(Array.from(bars.c)).toEqual([1.5, 2.5, 3.5]);
    expect(Array.from(bars.v ?? [])).toEqual([10, 20, 30]);
    const cut = slice(bars, "2020-01-02", "2020-01-02");
    expect(Array.from(cut.o)).toEqual([2]);
    expect(Array.from(cut.v ?? [])).toEqual([20]);
    const noVolume = slice(
      barsOf([FLAT, FLAT], false),
      "2019-01-01",
      "2030-01-01"
    );
    expect(noVolume.v).toBeUndefined();
    expect(noVolume.t.length).toBe(2);
  });

  it("writes the batch input with volume only when the bars have it", () => {
    const cases = buildCases(libraryText).slice(0, 1);
    const withVolume = JSON.parse(batchInput(flatBars, cases));
    expect(withVolume.bars.v).toHaveLength(5);
    expect(withVolume.cases[0].id).toBe(cases[0]?.id);
    const without = JSON.parse(batchInput(barsOf([FLAT], false), []));
    expect(without.bars.v).toBeUndefined();
    expect(without.cases).toEqual([]);
  });
});

describe("cases", () => {
  it("keeps daily library definitions only", () => {
    const definition = (name: string) => ({
      entry: {
        all: [
          {
            left: { field: "close", type: "price" },
            op: ">",
            right: { type: "const", value: 0 },
          },
        ],
      },
      name,
      version: 1,
    });
    const text = JSON.stringify({
      strategies: [
        { dsl: definition("Daily"), id: "A" },
        { dsl: definition("Hourly pullback"), id: "B" },
        { dsl: null, id: "C" },
        { id: "D" },
      ],
    });
    expect(libraryDefinitions(text).map((entry) => entry.id)).toEqual(["QJ-A"]);
  });

  it("builds library, template, fixed-rule and cost-profile cases", () => {
    const cases = buildCases(libraryText);
    const ids = cases.map((entry) => entry.id);
    expect(ids).toContain("template-atrExpansion");
    expect(ids).toContain("rule-smaCross-20-50-stop5-target10+ibkr-tiered");
    const atr = cases.find(
      (entry) => entry.id === "template-atrExpansion+ibkr-tiered"
    );
    expect(atr?.spec.costs?.capital).toBe(100_000);
    expect(atr?.spec.rule.kind).toBe("dsl");
    expect(ids.some((id) => id.startsWith("QJ-"))).toBe(true);
  });

  it("runs fixed rules and DSL rules, with and without a cost profile", () => {
    const cases = buildCases(libraryText);
    const bars = parseBarsCsv(syntheticCsv(0));
    for (const id of [
      "rule-smaCross-20-50-stop5-target10",
      "rule-smaCross-20-50-stop5-target10+ibkr-tiered",
      "template-smaCross",
      "template-atrExpansion+ibkr-tiered",
    ]) {
      const entry = cases.find((item) => item.id === id) as Case;
      expect(runTs(bars, entry.spec).equity.length).toBe(bars.t.length);
    }
  });
});

describe("relDiff", () => {
  it("is 0 for equal values and relative otherwise", () => {
    expect(relDiff(2, 2)).toBe(0);
    expect(relDiff(1, 2)).toBe(0.5);
    expect(relDiff(0, 1e-13)).toBeCloseTo(0.1);
  });
});

describe("compare", () => {
  it("passes when both engines agree", () => {
    const ts = tsResult([
      STOP_TRADE,
      { ...STOP_TRADE, entryIndex: 3, exitIndex: 4 },
    ]);
    const result = compare(flatBars, ts, pyOf(ts));
    expect(result.pass).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.explanation).toBeNull();
    expect(result.reasons).toEqual({ stop: 2 });
    expect(result.finalEquity).toEqual({ nautilus: 1.2, ts: 1.2 });
  });

  it("reports price, equity, Sharpe, drawdown and total return failures", () => {
    const ts = tsResult([STOP_TRADE]);
    const py = pyOf(ts, {
      equity: [1, 1, 1, 1, 1.3],
      stats: { maxDrawdown: -0.2, sharpe: 2, totalReturn: 0.3 },
      trades: [{ ...STOP_TRADE, entryPrice: 100, exitPrice: 98, pnl: 0 }],
    });
    const result = compare(flatBars, ts, py);
    expect(result.failures).toEqual([
      "fill price",
      "equity",
      "sharpe",
      "max drawdown",
      "total return",
    ]);
    expect(result.maxPriceRel).toBeGreaterThan(TOLERANCES.priceRel);
    // Same trades: no trade-level explanation.
    expect(result.explanation).toBeNull();
  });

  it("fails Sharpe when only one engine has it, and checks the equity length", () => {
    const ts = tsResult([]);
    const missing = compare(
      flatBars,
      ts,
      pyOf(ts, { stats: { maxDrawdown: -0.1, totalReturn: 0.2 } })
    );
    expect(missing.failures).toEqual(["sharpe"]);
    expect(missing.sharpe).toEqual({ nautilus: null, ts: 1 });
    const tsNull = tsResult([], { sharpe: null });
    expect(compare(flatBars, tsNull, pyOf(tsNull)).pass).toBe(true);
    const short = compare(
      flatBars,
      ts,
      pyOf(ts, { equity: [1, 1, 1, 1, 1.2, 1.2] })
    );
    expect(short.failures).toEqual(["equity length"]);
  });

  it("explains a level near the bar low or high (Nautilus price rounding)", () => {
    // TS stop at the bar low (99).
    const tsLow = tsResult([STOP_TRADE]);
    const pyLow = pyOf(tsLow, {
      trades: [
        {
          ...STOP_TRADE,
          entryPrice: 100,
          exitIndex: 3,
          exitReason: "end",
          pnl: 0,
        },
      ],
    });
    expect(compare(flatBars, tsLow, pyLow).explanation).toBe(
      "trade 0: level within 1e-8 of the bar extreme at bar 2 (9-decimal price rounding in Nautilus)"
    );
    // Nautilus stop at the bar high (101); TS exits on a signal.
    const tsHigh = tsResult([
      { ...STOP_TRADE, exitIndex: 3, exitReason: "signal" },
    ]);
    const pyHigh = pyOf(tsHigh, {
      trades: [{ ...STOP_TRADE, entryPrice: 100, exitPrice: 101, pnl: 0 }],
    });
    expect(explain(flatBars, tsHigh, pyHigh)).toContain("level within 1e-8");
  });

  it("explains other trade differences and a trade count difference", () => {
    const ts = tsResult([{ ...STOP_TRADE, exitPrice: 95 }]);
    const py = pyOf(ts, {
      trades: [
        {
          ...STOP_TRADE,
          entryPrice: 100,
          exitIndex: 4,
          exitReason: "target",
          exitPrice: 110,
          pnl: 0,
        },
      ],
    });
    expect(compare(flatBars, ts, py).explanation).toBe(
      "trade 0: TS 1->2 stop, Nautilus 1->4 target"
    );
    const more = pyOf(ts, {
      trades: [
        { ...STOP_TRADE, entryPrice: 100, exitPrice: 95, pnl: 0 },
        { ...STOP_TRADE, entryIndex: 3, entryPrice: 100, exitIndex: 4, pnl: 0 },
      ],
    });
    const counted = compare(flatBars, ts, more);
    expect(counted.failures).toContain("trade sequence");
    expect(counted.explanation).toBe("trade count 1 vs 2");
  });
});

describe("compareCase", () => {
  const cases = buildCases(libraryText);
  const smaCross = cases.find(
    (entry) => entry.id === "rule-smaCross-20-50-stop5-target10"
  ) as Case;

  it("passes when both engines report the same input error", () => {
    const message = "fast must be an integer from 1 to 5";
    expect(
      compareCase(flatBars, smaCross, { error: message, id: smaCross.id })
    ).toEqual({
      comparison: null,
      errors: { nautilus: message, ts: message },
      pass: true,
    });
    expect(
      compareCase(flatBars, smaCross, { error: "other", id: smaCross.id }).pass
    ).toBe(false);
    const ts = tsResult([]);
    expect(
      compareCase(flatBars, smaCross, { id: smaCross.id, result: pyOf(ts) })
    ).toEqual({
      comparison: null,
      errors: { nautilus: null, ts: message },
      pass: false,
    });
    expect(compareCase(flatBars, smaCross, undefined)).toEqual({
      comparison: null,
      errors: { nautilus: null, ts: message },
      pass: false,
    });
  });

  it("fails when only Nautilus errors and compares when both run", () => {
    const bars = parseBarsCsv(syntheticCsv(0));
    expect(
      compareCase(bars, smaCross, { error: "boom", id: smaCross.id })
    ).toEqual({
      comparison: null,
      errors: { nautilus: "boom", ts: null },
      pass: false,
    });
    const ts = runTs(bars, smaCross.spec);
    const result = compareCase(bars, smaCross, {
      id: smaCross.id,
      result: pyOf(ts),
    });
    expect(result.pass).toBe(true);
    expect(result.comparison?.pass).toBe(true);
  });
});

describe("summary and report", () => {
  const row = (
    strategy: string,
    comparison: Row["comparison"],
    pass: boolean
  ): Row => ({
    bars: 5,
    caseId: strategy,
    comparison,
    from: "2020-01-01",
    pass,
    period: "P1",
    strategy,
    symbol: "ES",
    to: "2020-01-05",
    universe: "core7",
  });

  it("sums cases, trades, exit reasons and the largest differences", () => {
    const ts = tsResult([STOP_TRADE, { ...STOP_TRADE, exitReason: "target" }]);
    const good = compare(flatBars, ts, pyOf(ts));
    const noSharpe = compare(
      flatBars,
      tsResult([], { sharpe: null }),
      pyOf(tsResult([], { sharpe: null }))
    );
    const worse = compare(
      flatBars,
      ts,
      pyOf(ts, { stats: { maxDrawdown: -0.1, sharpe: 1.5, totalReturn: 0.2 } })
    );
    const summary = summarizeStrategies([
      row("A", good, true),
      row("A", worse, false),
      row("A", noSharpe, true),
      row("B", null, false),
    ]);
    expect(summary["A"]).toEqual({
      cases: 3,
      maxEquityRel: 0,
      maxPriceRel: 0,
      maxSharpeAbs: 0.5,
      passed: 2,
      reasons: { stop: 2, target: 2 },
      trades: 4,
    });
    expect(summary["B"]).toMatchObject({ cases: 1, passed: 0, trades: 0 });

    const markdown = renderMarkdown({
      engines: { nautilus: "nautilus-trader-1", ts: "ts-engine" },
      generated: "2026-01-01T00:00:00.000Z",
      passed: 2,
      strategies: summary,
      total: 4,
    });
    expect(markdown).toContain("- Result: 2 of 4 cases pass.");
    expect(markdown).toContain(
      "| A | 3 | 2 | 4 | 2 / 2 | 0.0e+0 | 0.0e+0 | 5.0e-1 |"
    );
    expect(markdown).toContain("| B | 1 | 0 | 0 | 0 / 0 |");
    expect(markdown).toContain(
      `${PERIODS[0].id} ${PERIODS[0].from} to ${PERIODS[0].to}`
    );
  });
});

/** Weekly importer CSV from 2018 to 2026 with a slow sine trend; `phase` varies the symbol. */
function syntheticCsv(phase: number): string {
  const lines = ["t,o,h,l,c,v"];
  let price = 100 + phase;
  for (
    let t = Date.UTC(2017, 11, 25);
    t < Date.UTC(2026, 10, 30);
    t += 7 * DAY_MS
  ) {
    const step = Math.sin(t / (90 * DAY_MS) + phase) * 2;
    const open = price;
    const close = price + step;
    lines.push(
      `${t},${open},${Math.max(open, close) + 1},${Math.min(open, close) - 1},${close},1000`
    );
    price = close;
  }
  return `${lines.join("\n")}\n`;
}

describe("runNautilusParity", () => {
  const members = BACKTEST_UNIVERSES.flatMap((universe) =>
    universe.members.map((member) => member.symbol)
  );

  /** In-memory files and a fake Python batch that answers with the TS results. */
  const fakeIo = (
    answer: (
      batch: Readonly<{ bars: BarColumns; cases: readonly Case[] }>
    ) => Batch
  ) => {
    const files = new Map<string, string>([
      [
        join("/repo", "research/backtests/quantjourney/library.json"),
        libraryText,
      ],
    ]);
    members.forEach((symbol, index) => {
      files.set(
        join("/data", "import", `${symbol}-1d.csv`),
        syntheticCsv(index)
      );
    });
    const out: string[] = [];
    const dirs: string[] = [];
    let tick = 0;
    const io: ParityIo = {
      clock: () => {
        tick += 500;
        return tick;
      },
      makeDir: (path) => {
        dirs.push(path);
      },
      now: () => new Date("2026-11-05T00:00:00.000Z"),
      readText: (path) => {
        const text = files.get(path);
        if (text === undefined) throw new Error(`no file ${path}`);
        return text;
      },
      root: "/repo",
      spawn: (_python, args, cwd) => {
        expect(cwd).toBe(join("/repo", "services/research"));
        const [, , , input, output] = args as [
          string,
          string,
          string,
          string,
          string,
        ];
        const request = JSON.parse(files.get(input) as string) as {
          bars: Record<"t" | "o" | "h" | "l" | "c" | "v", number[]>;
          cases: Case[];
        };
        const bars: BarColumns = {
          c: Float64Array.from(request.bars.c),
          h: Float64Array.from(request.bars.h),
          l: Float64Array.from(request.bars.l),
          o: Float64Array.from(request.bars.o),
          t: Float64Array.from(request.bars.t),
          v: Float64Array.from(request.bars.v),
        };
        files.set(
          output,
          JSON.stringify(answer({ bars, cases: request.cases }))
        );
        return { status: 0, stderr: "" };
      },
      stdout: { write: (text: string) => out.push(text) },
      tempDir: () => "/tmp/work",
      writeText: (path, text) => {
        files.set(path, text);
      },
    };
    return { dirs, files, io, out };
  };

  const args = ["--data", "/data", "--python", "python3", "--out", "/out"];

  it("writes report.json and README.md; a missing Nautilus result fails its case", () => {
    const { dirs, files, io, out } = fakeIo(({ bars, cases }) => ({
      engine: "nautilus-trader-test",
      results: cases
        .filter((entry) => entry.id !== "template-smaCross")
        .map((entry) => {
          try {
            const ts = runTs(bars, entry.spec);
            return { id: entry.id, result: pyOf(ts) };
          } catch (error) {
            return { error: (error as Error).message, id: entry.id };
          }
        }),
    }));
    expect(runNautilusParity(args, io)).toBe(0);
    expect(dirs).toEqual(["/out"]);
    const report = JSON.parse(files.get("/out/report.json") as string);
    const perSeries = buildCases(libraryText).length;
    expect(report.total).toBe(members.length * PERIODS.length * perSeries);
    expect(report.passed).toBe(report.total - members.length * PERIODS.length);
    expect(report.generated).toBe("2026-11-05T00:00:00.000Z");
    expect(report.engines.nautilus).toBe("nautilus-trader-test");
    expect(files.get("/out/README.md")).toContain(
      `- Result: ${report.passed} of ${report.total} cases pass.`
    );
    expect(out[0]).toMatch(/^\S+ P1: \d+ cases in 0\.5 s\n$/u);
    expect(out.at(-1)).toBe(
      `parity: ${report.passed}/${report.total} cases pass; report /out/report.json\n`
    );
  });

  it("stops when the Python batch fails", () => {
    const { io } = fakeIo(() => ({ engine: "x", results: [] }));
    const failing: ParityIo = {
      ...io,
      spawn: () => ({ status: 1, stderr: "Traceback" }),
    };
    expect(() => runNautilusParity(args, failing)).toThrow(
      /nautilus batch failed for \/tmp\/work\/\S+-P1\.json: Traceback/u
    );
  });
});
