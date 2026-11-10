// QuantJourney strategy library: inventory schema, Vertex re-run analysis and multiple testing.
// Research only; nothing here creates, routes or simulates broker orders.
//
//   bun run research:quantjourney                     # render the inventory doc
//   bun run research:quantjourney -- --check          # exit 1 if the doc is out of date
//   bun run research:quantjourney -- --rerun --data <dir> --runs <dir>
//       [--engine nautilus|typescript] [--python <path>]
//                                                     # recompute results.json, then render
// The Vertex re-run uses NautilusTrader by default (switch plan step 3); a Nautilus re-run also
// runs each job on the TypeScript engine and writes nothing outside the parity tolerance.
//
// research/backtests/quantjourney/library.json is the inventory (source of truth); results.json
// holds the re-run summaries (no price series: the Yahoo data is not redistributable).
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  type AnalyticsEquityPoint,
  returnStats,
} from "../../packages/api/src/backtest-analytics.ts";
import type { BarColumns } from "../../packages/api/src/instant-backtest-engine.ts";
import { at, mean, stdev } from "../../packages/api/src/quant-arrays.ts";
import {
  type MultipleTesting,
  multipleTesting,
  type TrialReturns,
} from "../../packages/api/src/quant-multiple-testing.ts";
import { StrategyDefinitionSchema } from "../../packages/api/src/strategy-dsl.ts";
import {
  catchNautilusErrors,
  type DslJob,
  type DslRunner,
  engineOptions,
  type NautilusIo,
  type PreparedEngine,
  parityFailure,
  prepareEngine,
  typescriptEngine,
  typescriptRunner,
} from "./dsl-engine.ts";
import { MERGED_SOURCE, manifestSourceCounts } from "./fetch-sources.ts";
import { renderDoc } from "./quantjourney-render.ts";

export const RESEARCH_DIR = "research/backtests/quantjourney";
export const DOC_PATH = "docs/vertex-rebuild/quantjourney-library.md";
// The library is 50 strategies tested on one data set: every one counts as a trial.
export const TRIALS = 50;
// Vertex research cost: 10 bp per side, as in the 151 Strategies and FreeStockAlerts re-runs.
const VERTEX_COST_BPS = 10;
const DSR_MIN_PROBABILITY = 0.95;
const FDR_MAX_Q = 0.05;

const publishedSchema = z.object({
  benchmarkReturnPct: z.number().nullable(),
  beta: z.number().nullable(),
  cagrPct: z.number().nullable(),
  calmar: z.number().nullable(),
  maxDrawdownPct: z.number(),
  profitFactor: z.number().nullable(),
  profitFactorInfinite: z.boolean(),
  sharpe: z.number().nullable(),
  sortino: z.number().nullable(),
  totalReturnPct: z.number(),
  trades: z.number().nullable(),
  volatilityPct: z.number().nullable(),
  winRatePct: z.number().nullable(),
});

const strategySchema = z.object({
  assetClass: z.string().min(1),
  benchmark: z.string().min(1),
  category: z.enum(["orders", "weights", "walk-forward"]),
  costs: z.string().min(1),
  dashboard: z.url(),
  dsl: StrategyDefinitionSchema.nullable(),
  file: z.string().regex(/^example_[a-z0-9_]+\.py$/),
  github: z.url(),
  granularity: z.string().min(1),
  id: z.string().regex(/^(O|W|WF)\d{2}$/),
  mode: z.enum(["orders", "weights", "wf"]),
  name: z.string().min(1),
  orderType: z.string().nullable(),
  period: z.object({ end: z.string(), start: z.string() }),
  published: publishedSchema.nullable(),
  rebalance: z.string().nullable(),
  rerun: z.object({
    reason: z.string().nullable(),
    status: z.enum(["run", "no-data"]),
  }),
  rules: z.string().min(1),
  section: z.string().min(1).max(80),
  shortName: z.string().min(1),
  slug: z
    .string()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .max(80),
  strategyType: z.string().nullable(),
  styles: z.array(z.string()),
  summary: z.string().min(1),
  universe: z.array(z.string()).min(1),
});

export const libraryDocSchema = z.object({
  count: z.number().int(),
  source: z.object({
    commit: z.string().regex(/^[0-9a-f]{40}$/),
    dashboards: z.url(),
    fetched: z.string(),
    framing: z.string(),
    license: z.string(),
    name: z.string(),
    repository: z.url(),
    site: z.url(),
    siteSnapshot: z.string(),
    siteSnapshotSha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  strategies: z.array(strategySchema),
});

const halfSchema = z.object({
  cagr: z.number(),
  sharpe: z.number().nullable(),
});

export const seriesSummarySchema = z.object({
  cagr: z.number(),
  end: z.string(),
  excessKurtosis: z.number().nullable(),
  firstHalf: halfSchema,
  maxDrawdown: z.number(),
  meanReturn: z.number(),
  periods: z.number().int(),
  periodsPerYear: z.number(),
  secondHalf: halfSchema,
  sharpe: z.number().nullable(),
  skew: z.number().nullable(),
  start: z.string(),
  stdReturn: z.number(),
  totalReturn: z.number(),
  volatility: z.number(),
});

const adapterRunSchema = z.object({
  qj: z.object({
    maxDrawdown: z.number().nullable(),
    sharpe: z.number().nullable(),
    totalReturn: z.number().nullable(),
  }),
  summary: seriesSummarySchema,
});

const gateSchema = z.object({
  beatsBenchmarkBothHalves: z.boolean(),
  deflatedSharpeProbability: z.number().nullable(),
  pass: z.boolean(),
  qValue: z.number().nullable(),
});

const resultSchema = z.object({
  adapter: adapterRunSchema.nullable(),
  adapterVertexCost: adapterRunSchema.nullable(),
  benchmark: seriesSummarySchema.nullable(),
  dsl: seriesSummarySchema.nullable(),
  flags: z.array(z.string()),
  gate: gateSchema.nullable(),
  id: z.string(),
  note: z.string().nullable(),
  primary: z.enum(["dsl", "adapter"]).nullable(),
  status: z.enum(["run", "no-data", "error"]),
});

export const resultsDocSchema = z.object({
  data: z.object({ manifestSha256: z.string(), source: z.string() }),
  // Engine of the Vertex re-run; absent in files written before 2026-11-08 (TypeScript engine).
  engine: z.string().optional(),
  engineParity: z
    .object({
      against: z.string(),
      equityRelTolerance: z.number(),
      jobs: z.number().int(),
      maxEquityRel: z.number(),
      pass: z.number().int(),
    })
    .nullable()
    .optional(),
  generated: z.string(),
  strategies: z.array(resultSchema),
  trials: z.number().int(),
  vertexCostBps: z.number(),
});

export type LibraryDoc = z.infer<typeof libraryDocSchema>;
export type LibraryStrategy = LibraryDoc["strategies"][number];
export type Published = z.infer<typeof publishedSchema>;
export type SeriesSummary = z.infer<typeof seriesSummarySchema>;
export type AdapterRun = z.infer<typeof adapterRunSchema>;
export type StrategyResult = z.infer<typeof resultSchema>;
export type ResultsDoc = z.infer<typeof resultsDocSchema>;

// ---------------------------------------------------------------- price data

export type PriceTable = Readonly<{
  dates: readonly string[];
  bars: BarColumns;
  adjClose: readonly number[];
}>;

const csvRowSchema = z.tuple([
  z.string().min(1),
  z.coerce.number(),
  z.coerce.number(),
  z.coerce.number(),
  z.coerce.number(),
  z.coerce.number(),
]);

// Parses a fetch_data.py CSV (date or timestamp, open, high, low, close, adj_close, volume) and
// returns OHLC adjusted for dividends: each price is scaled by adj_close / close of its row.
// Rows outside [start, end) and rows with a missing price are dropped.
export const parsePriceCsv = (
  text: string,
  start: string,
  end: string
): PriceTable => {
  const rows = text
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => csvRowSchema.parse(line.split(",").slice(0, 6)))
    .filter(
      ([stamp, open, high, low, close, adj]) =>
        stamp.slice(0, 10) >= start &&
        stamp.slice(0, 10) < end &&
        [open, high, low, close, adj].every(
          (value) => Number.isFinite(value) && value > 0
        )
    );
  const scale = rows.map(([, , , , close, adj]) => adj / close);
  const column = (index: 1 | 2 | 3 | 4): Float64Array =>
    Float64Array.from(rows, (row, i) => row[index] * at(scale, i));
  return {
    adjClose: rows.map((row) => row[5]),
    bars: {
      c: column(4),
      h: column(2),
      l: column(3),
      o: column(1),
      t: Float64Array.from(rows, (row) => Date.parse(row[0])),
    },
    dates: rows.map((row) => row[0]),
  };
};

// ---------------------------------------------------------------- series statistics

const point = (t: string, equity: number): AnalyticsEquityPoint => ({
  equity,
  t,
});

const half = (
  equity: readonly AnalyticsEquityPoint[]
): z.infer<typeof halfSchema> => {
  const stats = returnStats(equity);
  return { cagr: stats?.cagr ?? 0, sharpe: stats?.sharpe ?? null };
};

// Vertex statistics of one equity series (risk-free rate 0) plus both halves, split at the middle
// point as in the 151 Strategies re-run. Null when the series is too short to measure.
export const summarize = (
  equity: readonly AnalyticsEquityPoint[]
): SeriesSummary | null => {
  const stats = returnStats(equity);
  if (stats === null) return null;
  const returns = equity
    .slice(1)
    .map((p, i) => p.equity / at(equity, i).equity - 1);
  const middle = Math.floor(equity.length / 2);
  return {
    cagr: stats.cagr,
    end: at(equity, equity.length - 1).t,
    excessKurtosis: stats.excessKurtosis,
    firstHalf: half(equity.slice(0, middle + 1)),
    maxDrawdown: stats.maxDrawdown,
    meanReturn: mean(returns),
    periods: stats.periods,
    periodsPerYear: stats.periodsPerYear,
    secondHalf: half(equity.slice(middle)),
    sharpe: stats.sharpe,
    skew: stats.skew,
    start: at(equity, 0).t,
    stdReturn: stdev(returns),
    totalReturn: stats.totalReturn,
    volatility: stats.annualVolatility,
  };
};

// Equity (start 1) from per-period returns; the first return belongs to the first date.
export const equityFromReturns = (
  dates: readonly string[],
  returns: readonly (number | null)[]
): AnalyticsEquityPoint[] => {
  let equity = 1;
  return dates.map((date, i) => {
    equity *= 1 + (returns[i] ?? 0);
    return point(date, equity);
  });
};

// Buy-and-hold equity of the benchmark on the dates of a strategy series.
export const benchmarkEquity = (
  table: PriceTable,
  start: string,
  end: string
): AnalyticsEquityPoint[] => {
  const points: AnalyticsEquityPoint[] = [];
  table.dates.forEach((date, i) => {
    if (date >= start && date <= end) {
      points.push(point(date, at(table.adjClose, i)));
    }
  });
  return points;
};

// Equal starting capital per instrument sleeve, never rebalanced: the mean of the sleeve
// equities on the union of dates, each sleeve carried forward on days it does not trade.
export const combineSleeves = (
  sleeves: readonly (readonly AnalyticsEquityPoint[])[]
): AnalyticsEquityPoint[] => {
  const dates = [...new Set(sleeves.flatMap((s) => s.map((p) => p.t)))].sort();
  const cursors = sleeves.map(() => ({ index: -1 }));
  return dates.map((date) => {
    const values = sleeves.map((sleeve, k) => {
      const cursor = at(cursors, k);
      while (
        cursor.index + 1 < sleeve.length &&
        at(sleeve, cursor.index + 1).t <= date
      ) {
        cursor.index += 1;
      }
      return cursor.index < 0 ? 1 : at(sleeve, cursor.index).equity;
    });
    return point(date, mean(values));
  });
};

// Runs a Vertex DSL definition on each instrument and combines the sleeves.
export const runDslSleeves = (
  strategy: LibraryStrategy,
  tables: ReadonlyMap<string, PriceTable>,
  costBps: number,
  runner: DslRunner = typescriptRunner
): AnalyticsEquityPoint[] | null => {
  const definition = strategy.dsl;
  if (definition === null) return null;
  const sleeves = strategy.universe.map((symbol) => {
    const table = tables.get(symbol);
    if (table === undefined) throw new Error(`missing data for ${symbol}`);
    const equity = runner(table.bars, definition, costBps);
    return table.dates.map((date, i) => point(date, at(equity, i)));
  });
  return combineSleeves(sleeves);
};

// ---------------------------------------------------------------- comparison and gates

// Published numbers versus the QuantJourney engine on Vertex data (same engine, same costs,
// same Sharpe definition), so a flag points at the data or the period, not at the engine.
export const comparisonFlags = (
  published: Published | null,
  adapter: AdapterRun | null
): string[] => {
  if (published === null || adapter === null) return [];
  const flags: string[] = [];
  const ret = adapter.qj.totalReturn;
  if (ret !== null) {
    const gap = Math.abs(ret * 100 - published.totalReturnPct);
    if (gap > Math.max(10, 0.25 * Math.abs(published.totalReturnPct))) {
      flags.push("total return");
    }
  }
  const dd = adapter.qj.maxDrawdown;
  if (dd !== null && Math.abs(dd * 100 - published.maxDrawdownPct) > 5) {
    flags.push("max drawdown");
  }
  const sharpe = adapter.qj.sharpe;
  if (
    sharpe !== null &&
    published.sharpe !== null &&
    Math.abs(sharpe - published.sharpe) > 0.15
  ) {
    flags.push("Sharpe");
  }
  return flags;
};

const trialReturns = (id: string, s: SeriesSummary): TrialReturns => ({
  firstT: s.start,
  id,
  lastT: s.end,
  meanReturn: s.meanReturn,
  returns: s.periods,
  stdReturn: s.stdReturn,
});

export const primarySummary = (
  result: StrategyResult
): SeriesSummary | null => {
  if (result.primary === "dsl") return result.dsl;
  if (result.primary === "adapter")
    return result.adapterVertexCost?.summary ?? null;
  return null;
};

export const beatsBothHalves = (
  strategy: SeriesSummary,
  benchmark: SeriesSummary | null
): boolean => {
  if (benchmark === null) return false;
  const better = (
    s: z.infer<typeof halfSchema>,
    b: z.infer<typeof halfSchema>
  ): boolean =>
    s.cagr > b.cagr && s.sharpe !== null && (b.sharpe ?? -1e9) < s.sharpe;
  return (
    better(strategy.firstHalf, benchmark.firstHalf) &&
    better(strategy.secondHalf, benchmark.secondHalf)
  );
};

// Existing Vertex gates: CAGR and Sharpe above the benchmark in both halves (151 Strategies
// rule), plus the deflated Sharpe ratio and Benjamini-Hochberg q-value of
// packages/api/src/quant-multiple-testing.ts with all TRIALS strategies in the ledger.
export const applyGates = (
  results: readonly StrategyResult[],
  trials: number = TRIALS
): StrategyResult[] => {
  const usable = results.flatMap((result) => {
    const summary = primarySummary(result);
    return summary === null ? [] : [{ id: result.id, summary }];
  });
  return results.map((result) => {
    const own = usable.find((entry) => entry.id === result.id);
    if (own === undefined) return { ...result, gate: null };
    const testing: MultipleTesting = multipleTesting(
      {
        key: "quantjourney-library",
        others: usable
          .filter((entry) => entry.id !== result.id)
          .map((entry) => trialReturns(entry.id, entry.summary)),
        scope: "task",
        total: trials,
      },
      {
        excessKurtosis: own.summary.excessKurtosis ?? 0,
        periodsPerYear: own.summary.periodsPerYear,
        returns: trialReturns(own.id, own.summary),
        skew: own.summary.skew ?? 0,
      }
    );
    const dsr = testing.deflatedSharpe?.probability ?? null;
    const q = testing.benjaminiHochberg?.qValue ?? null;
    const halves = beatsBothHalves(own.summary, result.benchmark);
    return {
      ...result,
      gate: {
        beatsBenchmarkBothHalves: halves,
        deflatedSharpeProbability: dsr,
        pass:
          halves &&
          dsr !== null &&
          dsr >= DSR_MIN_PROBABILITY &&
          q !== null &&
          q <= FDR_MAX_Q,
        qValue: q,
      },
    };
  });
};

// ---------------------------------------------------------------- re-run assembly

const adapterFileSchema = z.object({
  index: z.array(z.string()),
  qj_summary: z.object({
    max_drawdown: z.number().nullable(),
    sharpe: z.number().nullable(),
    total_return: z.number().nullable(),
  }),
  returns: z.array(z.number().nullable()),
});

export const adapterRun = (raw: unknown): AdapterRun | null => {
  const parsed = adapterFileSchema.safeParse(raw);
  if (!parsed.success) return null;
  const dates = parsed.data.index.map((stamp) => stamp.slice(0, 10));
  const summary = summarize(equityFromReturns(dates, parsed.data.returns));
  if (summary === null) return null;
  return {
    qj: {
      maxDrawdown: parsed.data.qj_summary.max_drawdown,
      sharpe: parsed.data.qj_summary.sharpe,
      totalReturn: parsed.data.qj_summary.total_return,
    },
    summary,
  };
};

const failureSchema = z.object({ error: z.string() });

// Why the Vertex-cost adapter run is missing, from the adapter's error record when present.
export const failureNote = (raw: unknown): string => {
  const failure = failureSchema.safeParse(raw);
  return failure.success
    ? `The Vertex-cost run failed in the QuantJourney engine: ${failure.data.error}.`
    : "The adapter did not produce a usable Vertex-cost run.";
};

export type RerunInputs = Readonly<{
  // Adapter output for a strategy id and cost case ("" or ".cost10"), or undefined when absent.
  adapterFile: (id: string, suffix: string) => unknown;
  // Price table for a symbol at a granularity ("1d" or "1h") over a period.
  prices: (
    symbol: string,
    granularity: string,
    start: string,
    end: string
  ) => PriceTable;
}>;

/** Price tables of a strategy's DSL re-run (empty without a DSL definition). */
const dslTables = (
  strategy: LibraryStrategy,
  inputs: RerunInputs
): Map<string, PriceTable> => {
  const { start, end } = strategy.period;
  const gran = strategy.granularity === "1h" ? "1h" : "1d";
  return new Map(
    (strategy.dsl === null ? [] : strategy.universe).map((symbol) => [
      symbol,
      inputs.prices(symbol, gran, start, end),
    ])
  );
};

export const rerunStrategy = (
  strategy: LibraryStrategy,
  inputs: RerunInputs,
  runner: DslRunner = typescriptRunner
): StrategyResult => {
  if (strategy.rerun.status === "no-data") {
    return {
      adapter: null,
      adapterVertexCost: null,
      benchmark: null,
      dsl: null,
      flags: [],
      gate: null,
      id: strategy.id,
      note: strategy.rerun.reason,
      primary: null,
      status: "no-data",
    };
  }
  const { start, end } = strategy.period;
  const adapter = adapterRun(inputs.adapterFile(strategy.id, ""));
  const vertexCost = adapterRun(
    inputs.adapterFile(strategy.id, `.cost${VERTEX_COST_BPS}`)
  );
  const dslEquity = runDslSleeves(
    strategy,
    dslTables(strategy, inputs),
    VERTEX_COST_BPS,
    runner
  );
  const dsl = dslEquity === null ? null : summarize(dslEquity);
  let primary: StrategyResult["primary"] = null;
  if (dsl) primary = "dsl";
  else if (vertexCost) primary = "adapter";
  const reference = dsl ?? vertexCost?.summary ?? null;
  const benchmark =
    reference === null
      ? null
      : summarize(
          benchmarkEquity(
            inputs.prices(strategy.benchmark, "1d", start, end),
            reference.start.slice(0, 10),
            reference.end.slice(0, 10)
          )
        );
  return {
    adapter,
    adapterVertexCost: vertexCost,
    benchmark,
    dsl,
    flags: comparisonFlags(strategy.published, adapter),
    gate: null,
    id: strategy.id,
    note:
      primary === null
        ? failureNote(
            inputs.adapterFile(strategy.id, `.cost${VERTEX_COST_BPS}`)
          )
        : null,
    primary,
    // A run on the strategy's own costs counts as a re-run even when the Vertex-cost case failed.
    status: primary === null && adapter === null ? "error" : "run",
  };
};

// ---------------------------------------------------------------- files and CLI

export const loadLibrary = async (root: string): Promise<LibraryDoc> =>
  libraryDocSchema.parse(
    JSON.parse(await readFile(join(root, RESEARCH_DIR, "library.json"), "utf8"))
  );

const loadResults = async (root: string): Promise<ResultsDoc | null> => {
  const path = join(root, RESEARCH_DIR, "results.json");
  return existsSync(path)
    ? resultsDocSchema.parse(JSON.parse(await readFile(path, "utf8")))
    : null;
};

export const fileInputs = async (
  library: LibraryDoc,
  dataDir: string,
  runsDir: string
): Promise<RerunInputs> => {
  const adapterFiles = new Map<string, unknown>();
  for (const strategy of library.strategies) {
    for (const suffix of ["", `.cost${VERTEX_COST_BPS}`]) {
      const path = join(runsDir, `${strategy.id}${suffix}.json`);
      if (existsSync(path)) {
        adapterFiles.set(
          `${strategy.id}${suffix}`,
          JSON.parse(await readFile(path, "utf8")) as unknown
        );
      }
    }
  }
  const texts = new Map<string, string>();
  const symbols = new Set(
    library.strategies.flatMap((s) => [
      ...s.universe.map((u) => `${s.granularity === "1h" ? "1h" : "1d"}:${u}`),
      `1d:${s.benchmark}`,
    ])
  );
  for (const key of symbols) {
    const [gran, symbol] = key.split(":") as [string, string];
    const path = join(
      dataDir,
      gran === "1h" ? "hourly" : "daily",
      `${symbol}.csv`
    );
    if (existsSync(path)) texts.set(key, await readFile(path, "utf8"));
  }
  return {
    adapterFile: (id, suffix) => adapterFiles.get(`${id}${suffix}`),
    prices: (symbol, granularity, start, end) => {
      const text = texts.get(`${granularity}:${symbol}`);
      if (text === undefined) throw new Error(`missing data for ${symbol}`);
      return parsePriceCsv(text, start, end);
    },
  };
};

/**
 * The data source label of a re-run: daily IBKR first, Yahoo fills gaps (hourly Yahoo only), with the files
 * per source from manifest.json (`files.<file>.sources`) when the fetch recorded them.
 */
export const quantjourneySource = (manifestText: string): string => {
  const counts = manifestSourceCounts(manifestText);
  const base = `${MERGED_SOURCE} (research/backtests/quantjourney/fetch_data.py)`;
  return counts === undefined
    ? base
    : `${base}; daily files by source: ${counts}; hourly Yahoo`;
};

/**
 * Builds results.json. `prepare` picks the engine and gets every DSL job first, so Nautilus runs
 * one batch per price table; the price tables are cached so both passes use the same tables.
 */
export const buildResults = (
  library: LibraryDoc,
  inputs: RerunInputs,
  meta: Readonly<{ generated: string; source: string; manifestSha256: string }>,
  prepare: (jobs: readonly DslJob[]) => PreparedEngine = typescriptEngine
): ResultsDoc => {
  const cache = new Map<string, PriceTable>();
  const shared: RerunInputs = {
    adapterFile: inputs.adapterFile,
    prices: (symbol, granularity, start, end) => {
      const key = [symbol, granularity, start, end].join("|");
      const table =
        cache.get(key) ?? inputs.prices(symbol, granularity, start, end);
      cache.set(key, table);
      return table;
    },
  };
  const jobs = library.strategies.flatMap((strategy) => {
    const { dsl } = strategy;
    if (dsl === null || strategy.rerun.status === "no-data") return [];
    return [...dslTables(strategy, shared).values()].map((table) => ({
      bars: table.bars,
      costBps: VERTEX_COST_BPS,
      definition: dsl,
    }));
  });
  const engine = prepare(jobs);
  return {
    data: { manifestSha256: meta.manifestSha256, source: meta.source },
    engine: engine.engine,
    engineParity: engine.parity,
    generated: meta.generated,
    strategies: applyGates(
      library.strategies.map((strategy) =>
        rerunStrategy(strategy, shared, engine.runner)
      )
    ),
    trials: TRIALS,
    vertexCostBps: VERTEX_COST_BPS,
  };
};

type Output = Readonly<{ write: (text: string) => unknown }>;

const option = (args: readonly string[], name: string): string | null => {
  const index = args.indexOf(name);
  return index < 0 ? null : (args[index + 1] ?? null);
};

export const runQuantJourneyCli = async (
  args: readonly string[],
  io: Readonly<{
    root: string;
    stdout: Output;
    stderr: Output;
    now: () => Date;
    sha256: (text: string) => string;
    /** Python of the Nautilus lock when --python is absent (VERTEX_NAUTILUS_PYTHON; else python3). */
    defaultPython: string | undefined;
    nautilus: Omit<NautilusIo, "python" | "root">;
  }>
): Promise<number> => {
  const valued = ["--data", "--runs", "--engine", "--python"];
  const known = ["--check", "--rerun", ...valued];
  const unknown = args.filter(
    (arg, i) => !(known.includes(arg) || valued.includes(args[i - 1] ?? ""))
  );
  const options = engineOptions(args, io.defaultPython);
  const repeated = known.filter(
    (flag) => args.indexOf(flag) !== args.lastIndexOf(flag)
  );
  const engineFlags = args.includes("--engine") || args.includes("--python");
  if (options === null) {
    io.stderr.write(
      "--engine takes nautilus or typescript; --python takes a path\n"
    );
    return 2;
  }
  if (engineFlags && !args.includes("--rerun")) {
    io.stderr.write("--engine and --python go with --rerun only\n");
    return 2;
  }
  if (repeated.length > 0) {
    io.stderr.write(`repeated argument: ${repeated.join(" ")}\n`);
    return 2;
  }
  if (unknown.length > 0) {
    io.stderr.write(`unknown argument: ${unknown.join(" ")}\n`);
    return 2;
  }
  const library = await loadLibrary(io.root);
  if (args.includes("--rerun")) {
    const data = option(args, "--data");
    const runs = option(args, "--runs");
    if (data === null || runs === null) {
      io.stderr.write("--rerun needs --data <dir> and --runs <dir>\n");
      return 2;
    }
    const manifest = await readFile(join(data, "manifest.json"), "utf8");
    const inputs = await fileInputs(library, data, runs);
    const results = catchNautilusErrors(
      () =>
        buildResults(
          library,
          inputs,
          {
            generated: io.now().toISOString().slice(0, 10),
            manifestSha256: io.sha256(manifest),
            source: quantjourneySource(manifest),
          },
          prepareEngine(options.engine, {
            ...io.nautilus,
            python: options.python,
            root: io.root,
          })
        ),
      io.stderr
    );
    if (results === null) return 1;
    const failure = parityFailure(results.engineParity ?? null);
    if (failure !== null) {
      io.stderr.write(failure);
      return 1;
    }
    await writeFile(
      join(io.root, RESEARCH_DIR, "results.json"),
      `${JSON.stringify(results, null, 2)}\n`,
      "utf8"
    );
  }
  const doc = renderDoc(library, await loadResults(io.root));
  const path = join(io.root, DOC_PATH);
  if (args.includes("--check")) {
    const current = existsSync(path) ? await readFile(path, "utf8") : "";
    if (current !== doc) {
      io.stderr.write(`out of date: ${DOC_PATH}\n`);
      return 1;
    }
    io.stdout.write("ok\n");
    return 0;
  }
  await writeFile(path, doc, "utf8");
  io.stdout.write(`wrote ${DOC_PATH}\n`);
  return 0;
};
