// Core 7 re-run of the QuantJourney strategy library (research only). Nothing here creates,
// routes or simulates broker orders, and nothing is promoted to paper trading.
//
//   bun run research:core7 -- --data ~/Documents/reports/vertex-core7/data \
//     [--engine nautilus|typescript] [--python <venv python with the Nautilus lock>]
//
// NautilusTrader is the default engine (switch plan step 3, docs/vertex-rebuild/
// nautilus-backtest-engine.md). A Nautilus run also runs each job on the TypeScript engine and
// writes nothing when the unit equity differs by more than the parity tolerance (dsl-engine.ts).
//
// Runs every library strategy with a daily Vertex DSL definition on each member of the
// "Core 7 futures" and "Core 7 ETF twins" universes (packages/shared/src/universes/index.ts),
// with buy and hold as the reference, and writes research/backtests/core7/rerun-results.json.
// The data directory is the output of research/backtests/core7/fetch_data.py.
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { AnalyticsEquityPoint } from "../../packages/api/src/backtest-analytics.ts";
import { at } from "../../packages/api/src/quant-arrays.ts";
import type { StrategyDefinition } from "../../packages/api/src/strategy-dsl.ts";
import {
  BACKTEST_UNIVERSES,
  type BacktestUniverse,
  type BacktestUniverseId,
} from "../../packages/shared/src/universes/index.ts";
import {
  catchNautilusErrors,
  type DslJob,
  type DslRunner,
  type EngineParity,
  engineOptions,
  type NautilusIo,
  type PreparedEngine,
  parityFailure,
  prepareEngine,
  typescriptEngine,
  typescriptRunner,
} from "./dsl-engine.ts";
import { describeSpans, sourceSpans, spanNames } from "./fetch-sources.ts";
import {
  combineSleeves,
  type LibraryDoc,
  type LibraryStrategy,
  loadLibrary,
  type PriceTable,
  parsePriceCsv,
  type SeriesSummary,
  summarize,
} from "./quantjourney.ts";

export const CORE7_DIR = "research/backtests/core7";
export const RESULTS_PATH = `${CORE7_DIR}/rerun-results.json`;
// Vertex research cost: 10 bp per side, the same value as VERTEX_COST_BPS in quantjourney.ts.
export const CORE7_COST_BPS = 10;
// Data fetched before 2026-11-10 (no per-source record in the manifests) is Yahoo only.
const YAHOO_DATA_SOURCE =
  "Yahoo Finance via yfinance 0.2.66 (research/backtests/core7/fetch_data.py)";
const MERGED_DATA_SOURCE =
  "research/backtests/core7/fetch_data.py; sources per symbol, see data.symbols.<SYMBOL>.source";
export const ADAPTER_REASON =
  "needs the QuantJourney adapter (fixed ticker lists); not re-run on Core 7";
export const HOURLY_REASON =
  "hourly (1h) definition; the Core 7 data set is daily only; not re-run on Core 7";
const methodLines = (ibkr: boolean): readonly string[] => [
  ibkr
    ? "Each symbol runs on its full daily history (sources per symbol, see data.symbols.<SYMBOL>.source; Yahoo fills the dates before IBKR's first), so per-symbol figures cover different periods."
    : "Each symbol runs on its full Yahoo daily history, so per-symbol figures cover different periods.",
  "Prices come from parsePriceCsv (scripts/research/quantjourney.ts): OHLC scaled by adj_close / close, so ETF runs include dividends. For the futures adj_close equals close.",
  "Rows that the Vertex bar importer rejects (non-positive price, low above open or close, high below open or close) are dropped, as in the import files.",
  "Combined: equal starting capital per member, never rebalanced (combineSleeves), on the common window of all members. Each sleeve is rebased to 1 at the window start.",
  ibkr
    ? "The futures are continuous front-month series (sources per symbol, see data.symbols.<SYMBOL>.source; where IBKR CONTFUT covers the latest window, the Yahoo part before it is scaled to IBKR at the seam), not back-adjusted by Vertex: a roll gap counts as a return."
    : "The futures are Yahoo continuous front-month series, not back-adjusted: a roll gap counts as a return.",
  "Statistics: Vertex returnStats (risk-free rate 0). Cost: 10 bp per side on every position change.",
];

export type Compact = Readonly<{
  cagr: number;
  end: string;
  maxDrawdown: number;
  sharpe: number | null;
  start: string;
  totalReturn: number;
}>;

export type Combined = Readonly<{
  summary: Compact | null;
  window: Readonly<{ end: string; start: string }>;
}>;

export type UniverseRun = Readonly<{
  combined: Combined;
  id: BacktestUniverseId;
  label: string;
  symbols: readonly Readonly<{ summary: Compact | null; symbol: string }>[];
}>;

export type StrategyRun =
  | Readonly<{
      id: string;
      name: string;
      status: "run";
      universes: readonly UniverseRun[];
    }>
  | Readonly<{ id: string; name: string; reason: string; status: "not-run" }>;

export type DataFile = Readonly<{
  manifestSha256: string;
  normalizedSha256: string;
  sourceSha256: string;
  // Where the bars came from: the manifest's per-source spans, else its source text (absent in old fixtures).
  source?: string;
}>;

export type Core7Results = Readonly<{
  buyAndHold: readonly UniverseRun[];
  costBps: number;
  data: Readonly<{
    source: string;
    symbols: Readonly<
      Record<
        string,
        DataFile & Readonly<{ bars: number; first: string; last: string }>
      >
    >;
  }>;
  /** Engine id of the strategy runs (buy and hold is closed-form). */
  engine: string;
  /** Nautilus runs only: every job compared with the TypeScript engine. */
  engineParity: EngineParity | null;
  generated: string;
  method: readonly string[];
  promoted: readonly string[];
  researchOnly: true;
  strategies: readonly StrategyRun[];
}>;

// ---------------------------------------------------------------- price data

/** Every symbol of both Core 7 universes, futures first, in member order. */
export const core7Symbols = (): string[] =>
  BACKTEST_UNIVERSES.flatMap((universe) =>
    universe.members.map((member) => member.symbol)
  );

// Keeps the rows that validateMarketBars (packages/db/src/server/market-bars.ts) accepts:
// low <= min(open, close) and high >= max(open, close). parsePriceCsv already drops rows with a
// missing or non-positive price. The rows are dropped, never repaired.
export const importableRows = (table: PriceTable): PriceTable => {
  const o = Array.from(table.bars.o);
  const h = Array.from(table.bars.h);
  const l = Array.from(table.bars.l);
  const c = Array.from(table.bars.c);
  const t = Array.from(table.bars.t);
  const keep = table.dates.flatMap((_, i) =>
    at(l, i) <= Math.min(at(o, i), at(c, i)) &&
    at(h, i) >= Math.max(at(o, i), at(c, i))
      ? [i]
      : []
  );
  const pick = (column: readonly number[]): Float64Array =>
    Float64Array.from(keep, (i) => at(column, i));
  return {
    adjClose: keep.map((i) => at(table.adjClose, i)),
    bars: { c: pick(c), h: pick(h), l: pick(l), o: pick(o), t: pick(t) },
    dates: keep.map((i) => at(table.dates, i)),
  };
};

/** Full-history price table of one daily CSV written by fetch_data.py. */
export const core7Table = (text: string): PriceTable =>
  importableRows(parsePriceCsv(text, "0000-01-01", "9999-12-31"));

// ---------------------------------------------------------------- equity series

const point = (t: string, equity: number): AnalyticsEquityPoint => ({
  equity,
  t,
});

export const buyAndHoldEquity = (table: PriceTable): AnalyticsEquityPoint[] =>
  table.dates.map((date, i) => point(date, at(table.adjClose, i)));

export const dslEquity = (
  table: PriceTable,
  definition: StrategyDefinition,
  costBps: number = CORE7_COST_BPS,
  runner: DslRunner = typescriptRunner
): AnalyticsEquityPoint[] => {
  const equity = runner(table.bars, definition, costBps);
  return table.dates.map((date, i) => point(date, at(equity, i)));
};

/** The points in [start, end], rebased so the first point is 1. */
export const rebased = (
  equity: readonly AnalyticsEquityPoint[],
  start: string,
  end: string
): AnalyticsEquityPoint[] => {
  const inside = equity.filter((p) => p.t >= start && p.t <= end);
  return inside.map((p) => point(p.t, p.equity / at(inside, 0).equity));
};

export const compact = (summary: SeriesSummary | null): Compact | null =>
  summary === null
    ? null
    : {
        cagr: summary.cagr,
        end: summary.end,
        maxDrawdown: summary.maxDrawdown,
        sharpe: summary.sharpe,
        start: summary.start,
        totalReturn: summary.totalReturn,
      };

// Equal-weight sleeves on the common window of all members (latest first date to earliest last
// date). The summary is null when the window is empty or too short to measure.
export const combinedRun = (
  sleeves: readonly (readonly AnalyticsEquityPoint[])[]
): Combined => {
  const firsts = sleeves.map((sleeve) => at(sleeve, 0).t).sort();
  const lasts = sleeves.map((sleeve) => at(sleeve, sleeve.length - 1).t).sort();
  const start = at(firsts, firsts.length - 1);
  const end = at(lasts, 0);
  const equity = combineSleeves(
    sleeves.map((sleeve) => rebased(sleeve, start, end))
  );
  return { summary: compact(summarize(equity)), window: { end, start } };
};

const universeRun = (
  universe: BacktestUniverse,
  equityOf: (symbol: string) => AnalyticsEquityPoint[]
): UniverseRun => {
  const sleeves = universe.members.map((member) => ({
    equity: equityOf(member.symbol),
    symbol: member.symbol,
  }));
  return {
    combined: combinedRun(sleeves.map((sleeve) => sleeve.equity)),
    id: universe.id,
    label: universe.label,
    symbols: sleeves.map((sleeve) => ({
      summary: compact(summarize(sleeve.equity)),
      symbol: sleeve.symbol,
    })),
  };
};

// ---------------------------------------------------------------- re-run assembly

const tableOf =
  (tables: ReadonlyMap<string, PriceTable>) =>
  (symbol: string): PriceTable => {
    const table = tables.get(symbol);
    if (table === undefined) throw new Error(`missing data for ${symbol}`);
    return table;
  };

export const rerunOnCore7 = (
  strategy: LibraryStrategy,
  tables: ReadonlyMap<string, PriceTable>,
  runner: DslRunner = typescriptRunner
): StrategyRun => {
  const { dsl, id, name } = strategy;
  if (dsl === null)
    return { id, name, reason: ADAPTER_REASON, status: "not-run" };
  if (strategy.granularity !== "1d")
    return { id, name, reason: HOURLY_REASON, status: "not-run" };
  const table = tableOf(tables);
  return {
    id,
    name,
    status: "run",
    universes: BACKTEST_UNIVERSES.map((universe) =>
      universeRun(universe, (symbol) =>
        dslEquity(table(symbol), dsl, CORE7_COST_BPS, runner)
      )
    ),
  };
};

/** Every engine run of the re-run: each daily DSL strategy on each Core 7 symbol. */
const core7Jobs = (
  library: LibraryDoc,
  tables: ReadonlyMap<string, PriceTable>
): DslJob[] =>
  library.strategies.flatMap(({ dsl, granularity }) =>
    dsl === null || granularity !== "1d"
      ? []
      : [...tables.values()].map((table) => ({
          bars: table.bars,
          costBps: CORE7_COST_BPS,
          definition: dsl,
        }))
  );

/**
 * Builds rerun-results.json from the library and the daily CSV text of each symbol. `prepare`
 * picks the engine; it gets every job first, so Nautilus runs one batch per symbol.
 */
export const buildCore7Results = (
  library: LibraryDoc,
  texts: ReadonlyMap<string, string>,
  meta: Readonly<{ files: ReadonlyMap<string, DataFile>; generated: string }>,
  prepare: (jobs: readonly DslJob[]) => PreparedEngine = typescriptEngine
): Core7Results => {
  const tables = new Map(
    core7Symbols().map((symbol) => {
      const text = texts.get(symbol);
      if (text === undefined) throw new Error(`missing data for ${symbol}`);
      return [symbol, core7Table(text)] as const;
    })
  );
  const table = tableOf(tables);
  const engine = prepare(core7Jobs(library, tables));
  const symbols = Object.fromEntries(
    [...tables].map(([symbol, t]) => {
      const file = meta.files.get(symbol);
      if (file === undefined) throw new Error(`missing manifest for ${symbol}`);
      return [
        symbol,
        {
          ...file,
          bars: t.dates.length,
          first: at(t.dates, 0),
          last: at(t.dates, t.dates.length - 1),
        },
      ];
    })
  );
  // IBKR rows in any symbol (manifest spans): label the data and method per symbol, else the old Yahoo texts.
  const ibkr = Object.values(symbols).some((file) =>
    spanNames(file.source ?? "").includes("ibkr")
  );
  return {
    buyAndHold: BACKTEST_UNIVERSES.map((universe) =>
      universeRun(universe, (symbol) => buyAndHoldEquity(table(symbol)))
    ),
    costBps: CORE7_COST_BPS,
    data: { source: ibkr ? MERGED_DATA_SOURCE : YAHOO_DATA_SOURCE, symbols },
    engine: engine.engine,
    engineParity: engine.parity,
    generated: meta.generated,
    method: methodLines(ibkr),
    promoted: [],
    researchOnly: true,
    strategies: library.strategies.map((strategy) =>
      rerunOnCore7(strategy, tables, engine.runner)
    ),
  };
};

// ---------------------------------------------------------------- files and CLI

const manifestSchema = z.object({
  normalizedSha256: z.string().regex(/^[0-9a-f]{64}$/),
  source: z.string().optional(),
  sourceSha256: z.string().regex(/^[0-9a-f]{64}$/),
  sources: z.unknown().optional(),
});

/** One import manifest's DataFile fields: the source label from `sources` (spans), else `source`, else the old Yahoo label. */
export const manifestDataFile = (
  text: string,
  manifestSha256: string
): DataFile => {
  const { normalizedSha256, source, sourceSha256, sources } =
    manifestSchema.parse(JSON.parse(text));
  return {
    manifestSha256,
    normalizedSha256,
    source: describeSpans(
      sourceSpans(sources),
      source ?? "Yahoo Finance via yfinance 0.2.66"
    ),
    sourceSha256,
  };
};

type Output = Readonly<{ write: (text: string) => unknown }>;

const USAGE =
  "usage: bun run research:core7 -- --data <dir> [--engine nautilus|typescript] [--python <path>]\n";
const FLAGS = ["--data", "--engine", "--python"];

export const runCore7RerunCli = async (
  args: readonly string[],
  io: Readonly<{
    now: () => Date;
    root: string;
    sha256: (text: string) => string;
    stderr: Output;
    stdout: Output;
    /** Python of the Nautilus lock when --python is absent (VERTEX_NAUTILUS_PYTHON; else python3). */
    defaultPython: string | undefined;
    nautilus: Omit<NautilusIo, "python" | "root">;
  }>
): Promise<number> => {
  const options = engineOptions(args, io.defaultPython);
  const pairs =
    args.length % 2 === 0 &&
    args.every(
      (arg, i) =>
        i % 2 === 1 ||
        (FLAGS.includes(arg) && args.indexOf(arg) === args.lastIndexOf(arg))
    );
  const dataIndex = args.indexOf("--data");
  if (options === null || !pairs || dataIndex === -1) {
    io.stderr.write(USAGE);
    return 2;
  }
  const data = at(args, dataIndex + 1);
  const library = await loadLibrary(io.root);
  const texts = new Map<string, string>();
  const files = new Map<string, DataFile>();
  for (const symbol of core7Symbols()) {
    texts.set(
      symbol,
      await readFile(join(data, "daily", `${symbol}.csv`), "utf8")
    );
    const manifest = await readFile(
      join(data, "import", `${symbol}-1d.manifest.json`),
      "utf8"
    );
    files.set(symbol, manifestDataFile(manifest, io.sha256(manifest)));
  }
  const results = catchNautilusErrors(
    () =>
      buildCore7Results(
        library,
        texts,
        { files, generated: io.now().toISOString() },
        prepareEngine(options.engine, {
          ...io.nautilus,
          python: options.python,
          root: io.root,
        })
      ),
    io.stderr
  );
  if (results === null) return 1;
  const failure = parityFailure(results.engineParity);
  if (failure !== null) {
    io.stderr.write(failure);
    return 1;
  }
  await writeFile(
    join(io.root, RESULTS_PATH),
    `${JSON.stringify(results, null, 2)}\n`,
    "utf8"
  );
  io.stdout.write(`wrote ${RESULTS_PATH} (${results.engine})\n`);
  return 0;
};
