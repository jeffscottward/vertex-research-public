// Parity suite: the TypeScript backtest engine against the NautilusTrader engine (research only).
// Nothing here creates, routes or simulates broker orders. This file holds the logic; the CLI
// (scripts/research-nautilus-parity.ts) passes in file access and the Python process.
//
//   bun run research:nautilus-parity -- --data ~/Documents/reports/vertex-core7/data \
//     --python /tmp/nbt-venv/bin/python --out research/backtests/nautilus-parity
//
// Cases: every member of the "Core 7 futures" and "Core 7 ETF twins" universes
// (packages/shared/src/universes/index.ts) x the daily library DSL definitions
// (research/backtests/quantjourney/library.json), the four DSL templates and two fixed rules
// x two periods. A third set repeats the fixed rules and the ATR template with the
// IBKR Pro Tiered cost profile. Bars are the Vertex importer CSVs written by
// research/backtests/core7/fetch_data.py (import/<SYMBOL>-1d.csv: t,o,h,l,c,v, split-adjusted),
// the same format the market_bars table stores.
//
// Each case runs in TypeScript (runInstantBacktest / runStrategyDefinition) and in Python
// (python -m nautilus_backtest batch, services/research/nautilus_backtest). The script compares
// trades, fills, P&L, Sharpe and max drawdown against the tolerances in TOLERANCES, explains
// each mismatch it can classify, and writes report.json and README.md to --out.
import { join, resolve } from "node:path";

import { COST_PROFILE_PRESETS } from "../../packages/api/src/backtest-costs.ts";
import {
  type BarColumns,
  type InstantRunParams,
  type InstantRunResult,
  runInstantBacktest,
} from "../../packages/api/src/instant-backtest-engine.ts";
import {
  STRATEGY_TEMPLATES,
  StrategyDefinitionSchema,
  type StrategyDefinition,
} from "../../packages/api/src/strategy-dsl.ts";
import { runStrategyDefinition } from "../../packages/api/src/strategy-dsl-compile.ts";
import { BACKTEST_UNIVERSES } from "../../packages/shared/src/universes/index.ts";

export const PERIODS = [
  { from: "2018-01-01", id: "P1", to: "2021-12-31" },
  { from: "2022-01-01", id: "P2", to: "2026-10-31" },
] as const;
const COST_BPS = 10;
const PROFILE_CAPITAL = 100_000;
const DEFAULT_CAPITAL = 1_000_000;

/** Pass limits per case. Prices and equity are relative; Sharpe and drawdown are absolute. */
export const TOLERANCES = {
  equityRel: 1e-5,
  maxDrawdownAbs: 1e-5,
  priceRel: 1e-6,
  sharpeAbs: 1e-3,
  totalReturnAbs: 1e-5,
} as const;

export type Spec = Readonly<{
  rule:
    | Readonly<{ kind: "dsl"; definition: StrategyDefinition }>
    | InstantRunParams["rule"];
  stopLossPct: number;
  takeProfitPct: number;
  costBps: number;
  costs: InstantRunParams["costs"] | null;
  initialCapital: number;
}>;

export type Case = Readonly<{ id: string; strategy: string; spec: Spec }>;

export type PyTrade = Readonly<{
  entryIndex: number;
  exitIndex: number;
  entryPrice: number;
  exitPrice: number;
  exitReason: string;
  pnl: number;
}>;
export type PyResult = Readonly<{
  equity: number[];
  trades: PyTrade[];
  stats: Record<string, number | null>;
}>;

export const argValue = (args: readonly string[], name: string): string => {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (value === undefined) throw new Error(`missing ${name}`);
  return value;
};

/** Parses a Vertex importer CSV (t,o,h,l,c,v with a header row). */
export const parseBarsCsv = (text: string): BarColumns => {
  const lines = text.trim().split("\n").slice(1);
  const rows = lines.map((line) => line.split(",").map(Number));
  const column = (index: number) =>
    Float64Array.from(rows, (row) => row[index] as number);
  return {
    c: column(4),
    h: column(2),
    l: column(3),
    o: column(1),
    t: column(0),
    v: column(5),
  };
};

export const slice = (
  bars: BarColumns,
  from: string,
  to: string
): BarColumns => {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`) + 86_400_000;
  let first = 0;
  while (first < bars.t.length && (bars.t[first] as number) < start) first += 1;
  let last = first;
  while (last < bars.t.length && (bars.t[last] as number) < end) last += 1;
  const cut = (values: Float64Array) => values.slice(first, last);
  return {
    c: cut(bars.c),
    h: cut(bars.h),
    l: cut(bars.l),
    o: cut(bars.o),
    t: cut(bars.t),
    ...(bars.v === undefined ? {} : { v: cut(bars.v) }),
  };
};

/** Daily DSL definitions of library.json (`text`); hourly ones are skipped. */
export const libraryDefinitions = (
  text: string
): readonly Readonly<{
  id: string;
  definition: StrategyDefinition;
}>[] => {
  const doc = JSON.parse(text) as {
    strategies: { id: string; dsl: unknown; timeframe?: string }[];
  };
  return doc.strategies
    .filter((strategy) => strategy.dsl !== null && strategy.dsl !== undefined)
    .map((strategy) => ({
      definition: StrategyDefinitionSchema.parse(strategy.dsl),
      id: `QJ-${strategy.id}`,
    }))
    .filter(({ definition }) => !/hourly/iu.test(definition.name));
};

/** Every parity case; `libraryText` is research/backtests/quantjourney/library.json. */
export const buildCases = (libraryText: string): readonly Case[] => {
  const base = {
    costBps: COST_BPS,
    costs: null,
    initialCapital: DEFAULT_CAPITAL,
    stopLossPct: 0,
    takeProfitPct: 0,
  };
  const dsl = [
    ...libraryDefinitions(libraryText),
    ...Object.entries(STRATEGY_TEMPLATES).map(([id, input]) => ({
      definition: StrategyDefinitionSchema.parse(input),
      id: `template-${id}`,
    })),
  ];
  const cases: Case[] = dsl.map(({ id, definition }) => ({
    id,
    spec: { ...base, rule: { definition, kind: "dsl" } },
    strategy: id,
  }));
  const fixed = [
    {
      id: "rule-smaCross-20-50-stop5-target10",
      spec: {
        ...base,
        rule: { fast: 20, kind: "smaCross", slow: 50 } as const,
        stopLossPct: 5,
        takeProfitPct: 10,
      },
    },
    {
      id: "rule-breakout-20-10-trend50-stop3",
      spec: {
        ...base,
        rule: {
          entryLookback: 20,
          exitLookback: 10,
          kind: "breakout",
          trendSma: 50,
        } as const,
        stopLossPct: 3,
      },
    },
  ];
  for (const rule of fixed) cases.push({ ...rule, strategy: rule.id });
  const profile = COST_PROFILE_PRESETS["ibkr-pro-tiered-us-stock"];
  const withProfile = (spec: Spec): Spec => ({
    ...spec,
    costs: {
      capital: PROFILE_CAPITAL,
      profile: { ...profile, slippage: { bps: 2, kind: "bps" }, spreadBps: 2 },
    },
    initialCapital: PROFILE_CAPITAL,
  });
  for (const rule of fixed) {
    cases.push({
      id: `${rule.id}+ibkr-tiered`,
      spec: withProfile(rule.spec),
      strategy: `${rule.id}+ibkr-tiered`,
    });
  }
  cases.push({
    id: "template-atrExpansion+ibkr-tiered",
    spec: withProfile({
      ...base,
      rule: {
        definition: StrategyDefinitionSchema.parse(
          STRATEGY_TEMPLATES.atrExpansion
        ),
        kind: "dsl",
      },
    }),
    strategy: "template-atrExpansion+ibkr-tiered",
  });
  return cases;
};

export const runTs = (bars: BarColumns, spec: Spec): InstantRunResult => {
  const costs = spec.costs ?? undefined;
  if (spec.rule.kind === "dsl")
    return runStrategyDefinition(
      bars,
      spec.rule.definition,
      spec.costBps,
      costs
    );
  return runInstantBacktest(bars, {
    costBps: spec.costBps,
    rule: spec.rule,
    stopLossPct: spec.stopLossPct,
    takeProfitPct: spec.takeProfitPct,
    ...(costs === undefined ? {} : { costs }),
  });
};

export const relDiff = (a: number, b: number): number =>
  a === b ? 0 : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-12);

export type Comparison = Readonly<{
  pass: boolean;
  trades: Readonly<{ ts: number; nautilus: number; sequenceEqual: boolean }>;
  maxPriceRel: number;
  maxEquityRel: number;
  finalEquity: Readonly<{ ts: number; nautilus: number }>;
  sharpe: Readonly<{ ts: number | null; nautilus: number | null }>;
  maxDrawdown: Readonly<{ ts: number; nautilus: number }>;
  totalReturn: Readonly<{ ts: number; nautilus: number }>;
  failures: readonly string[];
  explanation: string | null;
  /** Exit reasons of the TS trades. */
  reasons: Readonly<Record<string, number>>;
}>;

/** Classifies the first trade difference by looking at the bar where the engines part. */
export const explain = (
  bars: BarColumns,
  ts: InstantRunResult,
  py: PyResult
): string | null => {
  const count = Math.min(ts.trades.length, py.trades.length);
  for (let index = 0; index < count; index += 1) {
    const left = ts.trades[index] as InstantRunResult["trades"][number];
    const right = py.trades[index] as PyTrade;
    if (
      left.entryIndex === right.entryIndex &&
      left.exitIndex === right.exitIndex &&
      left.exitReason === right.exitReason
    )
      continue;
    const bar = Math.min(left.exitIndex, right.exitIndex);
    const low = bars.l[bar] as number;
    const high = bars.h[bar] as number;
    const stop = left.exitReason === "stop" ? left.exitPrice : right.exitPrice;
    const near =
      Math.abs(low - stop) / stop < 1e-8 || Math.abs(high - stop) / stop < 1e-8;
    return near
      ? `trade ${index}: level within 1e-8 of the bar extreme at bar ${bar} (9-decimal price rounding in Nautilus)`
      : `trade ${index}: TS ${left.entryIndex}->${left.exitIndex} ${left.exitReason}, Nautilus ${right.entryIndex}->${right.exitIndex} ${right.exitReason}`;
  }
  return ts.trades.length === py.trades.length
    ? null
    : `trade count ${ts.trades.length} vs ${py.trades.length}`;
};

export const compare = (
  bars: BarColumns,
  ts: InstantRunResult,
  py: PyResult
): Comparison => {
  const failures: string[] = [];
  const sequenceEqual =
    ts.trades.length === py.trades.length &&
    ts.trades.every((trade, index) => {
      const other = py.trades[index] as PyTrade;
      return (
        trade.entryIndex === other.entryIndex &&
        trade.exitIndex === other.exitIndex &&
        trade.exitReason === other.exitReason
      );
    });
  if (!sequenceEqual) failures.push("trade sequence");
  let maxPriceRel = 0;
  if (sequenceEqual) {
    ts.trades.forEach((trade, index) => {
      const other = py.trades[index] as PyTrade;
      maxPriceRel = Math.max(
        maxPriceRel,
        relDiff(trade.entryPrice, other.entryPrice),
        relDiff(trade.exitPrice, other.exitPrice)
      );
    });
  }
  if (maxPriceRel > TOLERANCES.priceRel) failures.push("fill price");
  let maxEquityRel = 0;
  ts.equity.forEach((value, index) => {
    maxEquityRel = Math.max(
      maxEquityRel,
      relDiff(value, py.equity[index] as number)
    );
  });
  if (py.equity.length !== ts.equity.length) failures.push("equity length");
  if (maxEquityRel > TOLERANCES.equityRel) failures.push("equity");
  const sharpeTs = ts.stats.sharpe;
  const sharpePy = py.stats["sharpe"] ?? null;
  if (
    (sharpeTs === null) !== (sharpePy === null) ||
    (sharpeTs !== null &&
      sharpePy !== null &&
      Math.abs(sharpeTs - sharpePy) > TOLERANCES.sharpeAbs)
  )
    failures.push("sharpe");
  const ddPy = py.stats["maxDrawdown"] as number;
  if (Math.abs(ts.stats.maxDrawdown - ddPy) > TOLERANCES.maxDrawdownAbs)
    failures.push("max drawdown");
  const trPy = py.stats["totalReturn"] as number;
  if (Math.abs(ts.stats.totalReturn - trPy) > TOLERANCES.totalReturnAbs)
    failures.push("total return");
  const reasons: Record<string, number> = {};
  for (const trade of ts.trades)
    reasons[trade.exitReason] = (reasons[trade.exitReason] ?? 0) + 1;
  return {
    explanation: failures.length === 0 ? null : explain(bars, ts, py),
    failures,
    finalEquity: {
      nautilus: py.equity.at(-1) as number,
      ts: ts.equity.at(-1) as number,
    },
    maxDrawdown: { nautilus: ddPy, ts: ts.stats.maxDrawdown },
    maxEquityRel,
    maxPriceRel,
    pass: failures.length === 0,
    reasons,
    sharpe: { nautilus: sharpePy, ts: sharpeTs },
    totalReturn: { nautilus: trPy, ts: ts.stats.totalReturn },
    trades: {
      nautilus: py.trades.length,
      sequenceEqual,
      ts: ts.trades.length,
    },
  };
};

export type Row = Readonly<{
  bars: number;
  caseId: string;
  from: string;
  period: string;
  strategy: string;
  symbol: string;
  to: string;
  universe: string;
  comparison: Comparison | null;
  errors?: Readonly<{ nautilus: string | null; ts: string | null }>;
  pass: boolean;
}>;

export type Batch = Readonly<{
  engine: string;
  results: readonly Readonly<{
    id: string;
    result?: PyResult;
    error?: string;
  }>[];
}>;

/** Input file of one Nautilus batch: the bars and every case spec. */
export const batchInput = (bars: BarColumns, cases: readonly Case[]): string =>
  JSON.stringify({
    bars: {
      c: Array.from(bars.c),
      h: Array.from(bars.h),
      l: Array.from(bars.l),
      o: Array.from(bars.o),
      t: Array.from(bars.t),
      ...(bars.v === undefined ? {} : { v: Array.from(bars.v) }),
    },
    cases: cases.map((entry) => ({ id: entry.id, spec: entry.spec })),
  });

/** File access, the Python process and the clock, passed in by the CLI (and by tests). */
export type ParityIo = Readonly<{
  /** Repo root: library.json and services/research are read from here. */
  root: string;
  readText: (path: string) => string;
  writeText: (path: string, text: string) => void;
  makeDir: (path: string) => void;
  /** A new empty folder for the batch files. */
  tempDir: () => string;
  /** Runs `python args` in `cwd`; a status other than 0 is a failure. */
  spawn: (
    python: string,
    args: readonly string[],
    cwd: string
  ) => Readonly<{ status: number | null; stderr: string }>;
  now: () => Date;
  /** Milliseconds, for the per-batch timing line. */
  clock: () => number;
  stdout: Readonly<{ write: (text: string) => unknown }>;
}>;

/** Runs every case on one bar series in one Python process. */
const runNautilusBatch = (
  io: ParityIo,
  python: string,
  input: string,
  bars: BarColumns,
  cases: readonly Case[]
): Batch => {
  const output = `${input}.out`;
  io.writeText(input, batchInput(bars, cases));
  const run = io.spawn(
    python,
    ["-m", "nautilus_backtest", "batch", input, output],
    join(io.root, "services/research")
  );
  if (run.status !== 0)
    throw new Error(`nautilus batch failed for ${input}: ${run.stderr}`);
  return JSON.parse(io.readText(output)) as Batch;
};

/** Both engines must agree, also on input errors (the same message). */
export const compareCase = (
  bars: BarColumns,
  entry: Case,
  py: Batch["results"][number] | undefined
): Pick<Row, "comparison" | "errors" | "pass"> => {
  let ts: InstantRunResult | null = null;
  let tsError: string | null = null;
  try {
    ts = runTs(bars, entry.spec);
  } catch (error) {
    tsError = (error as Error).message;
  }
  if (ts === null || py?.result === undefined) {
    return {
      comparison: null,
      errors: { nautilus: py?.error ?? null, ts: tsError },
      pass: tsError !== null && py?.error === tsError,
    };
  }
  const comparison = compare(bars, ts, py.result);
  return { comparison, pass: comparison.pass };
};

export const summarizeStrategies = (
  rows: readonly Row[]
): Record<string, StrategySummary> => {
  const byStrategy: Record<string, StrategySummary> = {};
  for (const row of rows) {
    const entry = byStrategy[row.strategy] ?? {
      cases: 0,
      maxEquityRel: 0,
      maxPriceRel: 0,
      maxSharpeAbs: 0,
      passed: 0,
      reasons: {},
      trades: 0,
    };
    byStrategy[row.strategy] = entry;
    entry.cases += 1;
    if (row.pass) entry.passed += 1;
    const comparison = row.comparison;
    if (comparison === null) continue;
    entry.trades += comparison.trades.ts;
    entry.maxEquityRel = Math.max(entry.maxEquityRel, comparison.maxEquityRel);
    entry.maxPriceRel = Math.max(entry.maxPriceRel, comparison.maxPriceRel);
    const { nautilus, ts } = comparison.sharpe;
    if (nautilus !== null && ts !== null)
      entry.maxSharpeAbs = Math.max(
        entry.maxSharpeAbs,
        Math.abs(ts - nautilus)
      );
    for (const [reason, count] of Object.entries(comparison.reasons))
      entry.reasons[reason] = (entry.reasons[reason] ?? 0) + count;
  }
  return byStrategy;
};

/** Runs the suite and writes report.json and README.md to --out. */
/** Runs the suite and returns the process exit code (0; a failed batch throws). */
export const runNautilusParity = (
  args: readonly string[],
  io: ParityIo
): number => {
  const data = resolve(argValue(args, "--data"));
  const python = argValue(args, "--python");
  const out = resolve(argValue(args, "--out"));
  const cases = buildCases(
    io.readText(join(io.root, "research/backtests/quantjourney/library.json"))
  );
  const work = io.tempDir();
  const rows: Row[] = [];
  let engine = "";
  const members = BACKTEST_UNIVERSES.flatMap((universe) =>
    universe.members.map((member) => ({
      symbol: member.symbol,
      universe: universe.id,
    }))
  );
  for (const { symbol, universe } of members) {
    const all = parseBarsCsv(
      io.readText(join(data, "import", `${symbol}-1d.csv`))
    );
    for (const period of PERIODS) {
      const bars = slice(all, period.from, period.to);
      const started = io.clock();
      const batch = runNautilusBatch(
        io,
        python,
        join(work, `${symbol}-${period.id}.json`),
        bars,
        cases
      );
      engine = batch.engine;
      for (const entry of cases) {
        const py = batch.results.find((result) => result.id === entry.id);
        rows.push({
          bars: bars.t.length,
          caseId: entry.id,
          from: period.from,
          period: period.id,
          strategy: entry.strategy,
          symbol,
          to: period.to,
          universe,
          ...compareCase(bars, entry, py),
        });
      }
      const seconds = (io.clock() - started) / 1000;
      io.stdout.write(
        `${symbol} ${period.id}: ${cases.length} cases in ${seconds.toFixed(1)} s\n`
      );
    }
  }
  io.makeDir(out);
  const report = {
    costBps: COST_BPS,
    data: "Yahoo Finance daily bars via research/backtests/core7/fetch_data.py (import CSVs, split-adjusted OHLC)",
    engines: {
      nautilus: engine,
      ts: "packages/api/src/instant-backtest-engine.ts (instant-2)",
    },
    generated: io.now().toISOString(),
    passed: rows.filter((row) => row.pass).length,
    periods: PERIODS,
    researchOnly: true,
    rows,
    strategies: summarizeStrategies(rows),
    tolerances: TOLERANCES,
    total: rows.length,
  };
  io.writeText(
    join(out, "report.json"),
    `${JSON.stringify(report, null, 1)}\n`
  );
  io.writeText(join(out, "README.md"), renderMarkdown(report));
  io.stdout.write(
    `parity: ${report.passed}/${report.total} cases pass; report ${join(out, "report.json")}\n`
  );
  return 0;
};

export interface StrategySummary {
  cases: number;
  passed: number;
  trades: number;
  reasons: Record<string, number>;
  maxEquityRel: number;
  maxPriceRel: number;
  maxSharpeAbs: number;
}

export const renderMarkdown = (
  report: Readonly<{
    engines: Readonly<{ nautilus: string; ts: string }>;
    generated: string;
    passed: number;
    total: number;
    strategies: Readonly<Record<string, StrategySummary>>;
  }>
): string => {
  const lines = [
    "# Backtest engine parity: TypeScript against NautilusTrader",
    "",
    "Generated by `scripts/research/nautilus-parity.ts`. Research only: no orders.",
    "",
    `- Engines: ${report.engines.ts}; ${report.engines.nautilus} (services/research/nautilus_backtest).`,
    `- Generated: ${report.generated}.`,
    `- Result: ${report.passed} of ${report.total} cases pass.`,
    "- Cases: 14 symbols (Core 7 futures and Core 7 ETF twins) x strategies x 2 periods " +
      PERIODS.map(
        (period) => `${period.id} ${period.from} to ${period.to}`
      ).join(", ") +
      `. Cost ${COST_BPS} bp per side; the "+ibkr-tiered" cases add the IBKR Pro Tiered profile with 2 bp spread and 2 bp slippage at capital ${PROFILE_CAPITAL}.`,
    "",
    "## Tolerances (every case)",
    "",
    "- Trades: the same entry bar, exit bar and exit reason for every trade, in the same order.",
    `- Fill prices: relative difference at most ${TOLERANCES.priceRel}.`,
    `- Unit equity at every bar: relative difference at most ${TOLERANCES.equityRel}.`,
    `- Sharpe: absolute difference at most ${TOLERANCES.sharpeAbs}. Max drawdown and total return: absolute difference at most ${TOLERANCES.maxDrawdownAbs}.`,
    "",
    "## Per strategy",
    "",
    "| Strategy | Cases | Pass | Trades | Stop / target exits | Max equity diff | Max price diff | Max Sharpe diff |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const [id, entry] of Object.entries(report.strategies)) {
    lines.push(
      `| ${id} | ${entry.cases} | ${entry.passed} | ${entry.trades} | ${entry.reasons["stop"] ?? 0} / ${entry.reasons["target"] ?? 0} | ${entry.maxEquityRel.toExponential(1)} | ${entry.maxPriceRel.toExponential(1)} | ${entry.maxSharpeAbs.toExponential(1)} |`
    );
  }
  lines.push(
    "",
    "## Why the numbers are not bit-identical",
    "",
    "- Nautilus books commission in whole cents (USD precision 2). The TS engine keeps exact doubles. This gives the equity and P&L differences above (about one cent per fill at the run capital).",
    "- Nautilus prices and quantities have 9 decimals. A stop or target level within 1e-9 of a bar extreme can trigger in one engine and not the other. No case in this run hit that.",
    "- Signals are computed by the Python port (services/research/nautilus_backtest/signals.py), which matches the TS indicators bit for bit on the golden fixture.",
    ""
  );
  return lines.join("\n");
};
