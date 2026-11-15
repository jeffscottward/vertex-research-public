// Golden backtest battery: proves the Vertex backtest engine and indicator code against an
// independent pandas implementation and TA-Lib, on frozen SPY and QQQ daily bars.
// Research only. Nothing here creates, routes or simulates broker orders.
//
// Inputs (all committed): tests/fixtures/golden/{SPY,QQQ}-1d.csv, manifest.json and
// golden-reference.json (written by services/research/tests/golden/make_golden_reference.py).
// Outputs: docs/golden-battery/results.json (machine-readable) and summary.md.
// Usage: bun run vertex:golden-battery -- write|check
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

import {
  adx,
  atr,
  bollinger,
  ema,
  type Line,
  lwma,
  macd,
  parabolicSar,
  sma,
  smma,
  stochastic,
} from "../../apps/web/src/features/charts/indicator-math.ts";
import {
  type BarColumns,
  type InstantTrade,
  rollingMean,
  runInstantBacktest,
  wilderRsi,
} from "../../packages/api/src/instant-backtest-engine.ts";

const FIXTURE_DIR = "tests/fixtures/golden";
export const RESULTS_PATH = "docs/golden-battery/results.json";
export const SUMMARY_PATH = "docs/golden-battery/summary.md";
export const FIXTURE_HEADER = "date,open,high,low,close,adj_close,volume";

/**
 * One tolerance for every compared number: |vertex − reference| ≤ TOLERANCE · max(1, |reference|).
 * The two paths do the same arithmetic in a different order, so only rounding may differ
 * (observed: below 1e-11 for backtest values, about 1e-13 relative for indicator values).
 * A logic difference (one trade more, a fill one bar late) moves values by 1e-4 or more.
 */
export const TOLERANCE = 1e-9;

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/u);
const nullableNumber = z.number().nullable();
const index = z.number().int().nonnegative();

const RuleSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("smaCross"),
    fast: z.number().int(),
    slow: z.number().int(),
  }),
  z.object({
    kind: z.literal("rsiReversion"),
    period: z.number().int(),
    oversold: z.number(),
    overbought: z.number(),
  }),
]);

const TradeSchema = z.object({
  entryIndex: index,
  exitIndex: index,
  entryPrice: z.number(),
  exitPrice: z.number(),
  netReturn: z.number(),
  pnl: z.number(),
  exitReason: z.enum(["signal", "stop", "target", "end", "sessionClose"]),
});

const StatsSchema = z.object({
  bars: index,
  finalEquity: z.number(),
  totalReturn: z.number(),
  cagr: z.number(),
  maxDrawdown: z.number(),
  sharpe: nullableNumber,
  sortino: nullableNumber,
  trades: index,
  winRate: nullableNumber,
  profitFactor: nullableNumber,
  exposure: z.number(),
  buyHoldReturn: z.number(),
  buyHoldMaxDrawdown: z.number(),
});

const ParitySchema = z.object({
  comparedBars: index,
  missingBars: index,
  maxAbsDiff: z.number(),
  maxRelDiff: z.number(),
});

export const GoldenReferenceSchema = z.object({
  generator: z.string(),
  backtestReference: z.string(),
  indicatorReference: z.string(),
  fixtures: z.record(z.string(), sha256Hex),
  cases: z.array(
    z.object({
      id: z.string(),
      symbol: z.string(),
      rule: RuleSchema,
      costBps: z.number(),
      trades: z.array(TradeSchema),
      stats: StatsSchema,
    })
  ),
  indicatorCheckpoints: z.record(
    z.string(),
    z.object({
      indexes: z.array(index),
      dates: z.array(z.string()),
      firstDefined: z.record(z.string(), index),
      values: z.record(z.string(), z.array(nullableNumber)),
    })
  ),
  pythonLibraryParity: z.record(z.string(), z.record(z.string(), ParitySchema)),
});

export const GoldenManifestSchema = z.object({
  provider: z.string(),
  fetchedAt: z.string(),
  generator: z.string(),
  range: z.object({ start: z.string(), end: z.string() }),
  fields: z.record(z.string(), z.string()),
  adjustment: z.string(),
  delay: z.string(),
  license: z.string(),
  files: z.record(
    z.string(),
    z.object({
      file: z.string(),
      sha256: sha256Hex,
      downloadSha256: sha256Hex,
      rows: index,
      first: z.string(),
      last: z.string(),
    })
  ),
});

export type GoldenReference = z.infer<typeof GoldenReferenceSchema>;
export type GoldenManifest = z.infer<typeof GoldenManifestSchema>;
type ReferenceCase = GoldenReference["cases"][number];
type Checkpoints = GoldenReference["indicatorCheckpoints"][string];

/** Parses the fixture CSV into total-return bars: open, high, low and close times adj_close/close. */
export const parseFixtureCsv = (text: string): BarColumns => {
  const lines = text.trim().split("\n");
  if (lines[0] !== FIXTURE_HEADER) {
    throw new Error(`fixture must start with the header ${FIXTURE_HEADER}`);
  }
  const rows = lines.slice(1);
  const columns = {
    t: new Float64Array(rows.length),
    o: new Float64Array(rows.length),
    h: new Float64Array(rows.length),
    l: new Float64Array(rows.length),
    c: new Float64Array(rows.length),
  };
  for (const [row, line] of rows.entries()) {
    const [date, ...fields] = line.split(",");
    const numbers = fields.map(Number);
    const time = Date.parse(`${date}T00:00:00Z`);
    if (
      numbers.length !== 6 ||
      !numbers.every((value) => Number.isFinite(value) && value > 0) ||
      Number.isNaN(time)
    ) {
      throw new Error(`fixture line ${row + 2} is not a valid bar`);
    }
    const [open, high, low, close, adjusted] = numbers as [
      number,
      number,
      number,
      number,
      number,
    ];
    const factor = adjusted / close;
    columns.t[row] = time;
    columns.o[row] = open * factor;
    columns.h[row] = high * factor;
    columns.l[row] = low * factor;
    columns.c[row] = close * factor;
  }
  return columns;
};

export const withinTolerance = (
  actual: number | null,
  expected: number | null
): boolean =>
  actual === null || expected === null
    ? actual === expected
    : Math.abs(actual - expected) <=
      TOLERANCE * Math.max(1, Math.abs(expected));

const METRICS = [
  "finalEquity",
  "totalReturn",
  "cagr",
  "maxDrawdown",
  "sharpe",
  "sortino",
  "profitFactor",
  "winRate",
  "exposure",
  "buyHoldReturn",
  "buyHoldMaxDrawdown",
] as const;

type MetricName = (typeof METRICS)[number];

export type MetricComparison = Readonly<{
  name: MetricName;
  vertex: number | null;
  reference: number | null;
  absDiff: number | null;
  pass: boolean;
}>;

export type TradeComparison = Readonly<{
  vertexCount: number;
  referenceCount: number;
  sameBarsAndReasons: boolean;
  maxPriceDiff: number;
  maxPnlDiff: number;
  pass: boolean;
}>;

export type CaseResult = Readonly<{
  id: string;
  symbol: string;
  rule: ReferenceCase["rule"];
  costBps: number;
  pass: boolean;
  trades: TradeComparison;
  metrics: readonly MetricComparison[];
}>;

export const compareTrades = (
  vertex: readonly InstantTrade[],
  reference: readonly ReferenceCase["trades"][number][]
): TradeComparison => {
  let sameBarsAndReasons = vertex.length === reference.length;
  let maxPriceDiff = 0;
  let maxPnlDiff = 0;
  let valuesPass = true;
  for (const [position, expected] of reference.entries()) {
    const actual = vertex[position];
    if (actual === undefined) break;
    sameBarsAndReasons &&=
      actual.entryIndex === expected.entryIndex &&
      actual.exitIndex === expected.exitIndex &&
      actual.exitReason === expected.exitReason;
    maxPriceDiff = Math.max(
      maxPriceDiff,
      Math.abs(actual.entryPrice - expected.entryPrice),
      Math.abs(actual.exitPrice - expected.exitPrice)
    );
    maxPnlDiff = Math.max(
      maxPnlDiff,
      Math.abs(actual.pnl - expected.pnl),
      Math.abs(actual.netReturn - expected.netReturn)
    );
    valuesPass &&=
      withinTolerance(actual.entryPrice, expected.entryPrice) &&
      withinTolerance(actual.exitPrice, expected.exitPrice) &&
      withinTolerance(actual.pnl, expected.pnl) &&
      withinTolerance(actual.netReturn, expected.netReturn);
  }
  return {
    vertexCount: vertex.length,
    referenceCount: reference.length,
    sameBarsAndReasons,
    maxPriceDiff,
    maxPnlDiff,
    pass: sameBarsAndReasons && valuesPass,
  };
};

/** Runs one golden case on the Vertex engine (no stop, no target) and compares it. */
export const runGoldenCase = (
  bars: BarColumns,
  reference: ReferenceCase
): CaseResult => {
  const run = runInstantBacktest(bars, {
    rule: reference.rule,
    stopLossPct: 0,
    takeProfitPct: 0,
    costBps: reference.costBps,
  });
  const vertex: Record<MetricName, number | null> = {
    ...run.stats,
    finalEquity: run.equity.at(-1) as number,
  };
  const metrics = METRICS.map((name): MetricComparison => {
    const actual = vertex[name];
    const expected = reference.stats[name];
    return {
      name,
      vertex: actual,
      reference: expected,
      absDiff:
        actual === null || expected === null
          ? null
          : Math.abs(actual - expected),
      pass: withinTolerance(actual, expected),
    };
  });
  const trades = compareTrades(run.trades, reference.trades);
  return {
    id: reference.id,
    symbol: reference.symbol,
    rule: reference.rule,
    costBps: reference.costBps,
    pass:
      run.stats.bars === reference.stats.bars &&
      trades.pass &&
      metrics.every((metric) => metric.pass),
    trades,
    metrics,
  };
};

export type IndicatorLayer = "engine" | "chart" | "python";

export type IndicatorCheck = Readonly<{
  layer: IndicatorLayer;
  symbol: string;
  indicator: string;
  scope: "checkpoints" | "all bars";
  comparedBars: number;
  missingBars: number;
  maxAbsDiff: number;
  /** First bar with a value, Vertex and expected. Null for the Python rows (checked in pytest). */
  warmup: Readonly<{ firstBar: number | null; expected: number }> | null;
  pass: boolean;
}>;

/**
 * First bar where Vertex deliberately starts before TA-Lib (docs/indicators.md): the MACD line at
 * bar slow−1 and Stochastic %K at bar k+s−2. Every other series starts on the TA-Lib bar.
 */
const EARLY_START: Readonly<Record<string, number>> = {
  macd: 25,
  stoch_k: 15,
};

export const firstFiniteBar = (
  series: ArrayLike<number | null>
): number | null => {
  for (let bar = 0; bar < series.length; bar += 1) {
    const value = series[bar];
    if (typeof value === "number" && Number.isFinite(value)) return bar;
  }
  return null;
};

/** Compares a full series with reference values at the checkpoint bars the reference defines. */
export const checkpointParity = (
  series: ArrayLike<number | null>,
  expected: readonly (number | null)[],
  indexes: readonly number[]
): Pick<
  IndicatorCheck,
  "comparedBars" | "missingBars" | "maxAbsDiff" | "pass"
> => {
  let comparedBars = 0;
  let missingBars = 0;
  let maxAbsDiff = 0;
  let pass = true;
  for (const [position, bar] of indexes.entries()) {
    const want = expected[position] ?? null;
    if (want === null) continue;
    const got = series[bar] ?? null;
    if (got === null || Number.isNaN(got)) {
      missingBars += 1;
      continue;
    }
    comparedBars += 1;
    maxAbsDiff = Math.max(maxAbsDiff, Math.abs(got - want));
    pass &&= withinTolerance(got, want);
  }
  return {
    comparedBars,
    missingBars,
    maxAbsDiff,
    pass: pass && comparedBars > 0 && missingBars === 0,
  };
};

/** Indicator series the backtest engine uses for its rules. */
const engineSeries = (bars: BarColumns): Record<string, ArrayLike<number>> => ({
  sma_20: rollingMean(bars.c, 20),
  sma_50: rollingMean(bars.c, 50),
  rsi_14: wilderRsi(bars.c, 14),
});

/** Chart overlay series (apps/web indicator math) with the chart-study parameters. */
const chartSeries = (bars: BarColumns): Record<string, Line> => {
  const ohlc = {
    high: Array.from(bars.h),
    low: Array.from(bars.l),
    close: Array.from(bars.c),
  };
  const bands = bollinger(ohlc.close, 20, 2);
  const lines = macd(ohlc.close, 12, 26, 9);
  const stoch = stochastic(ohlc, 14, 3, 3);
  const trend = adx(ohlc, 14);
  return {
    sma_20: sma(ohlc.close, 20),
    sma_50: sma(ohlc.close, 50),
    ema_20: ema(ohlc.close, 20),
    smma_20: smma(ohlc.close, 20),
    lwma_20: lwma(ohlc.close, 20),
    atr_14: atr(ohlc, 14),
    bollinger_upper: bands.upper,
    bollinger_middle: bands.middle,
    bollinger_lower: bands.lower,
    sar: parabolicSar(ohlc, 0.02, 0.2),
    macd: lines.macd,
    macd_signal: lines.signal,
    macd_histogram: lines.histogram,
    stoch_k: stoch.k,
    stoch_d: stoch.d,
    plus_di: trend.plusDi,
    minus_di: trend.minusDi,
    adx: trend.adx,
  };
};

const layerChecks = (
  layer: IndicatorLayer,
  symbol: string,
  series: Record<string, ArrayLike<number | null>>,
  checkpoints: Checkpoints
): IndicatorCheck[] =>
  Object.entries(series).map(([indicator, values]) => {
    const expected = checkpoints.values[indicator];
    const referenceFirst = checkpoints.firstDefined[indicator];
    if (expected === undefined || referenceFirst === undefined) {
      throw new Error(`reference has no checkpoints for ${indicator}`);
    }
    const parity = checkpointParity(values, expected, checkpoints.indexes);
    const warmup = {
      firstBar: firstFiniteBar(values),
      expected: EARLY_START[indicator] ?? referenceFirst,
    };
    return {
      layer,
      symbol,
      indicator,
      scope: "checkpoints",
      ...parity,
      warmup,
      pass: parity.pass && warmup.firstBar === warmup.expected,
    };
  });

export type FixtureFile = Readonly<{ text: string; sha256: string }>;

export type GoldenInputs = Readonly<{
  manifest: GoldenManifest;
  reference: GoldenReference;
  fixtures: Readonly<Record<string, FixtureFile>>;
}>;

type FixtureRecord = Readonly<{
  path: string;
  sha256: string;
  rows: number;
  first: string;
  last: string;
}>;

export type GoldenResults = Readonly<{
  schema: "vertex-golden-battery/v1";
  note: string;
  pass: boolean;
  summary: Readonly<{
    cases: number;
    casesPassed: number;
    indicatorChecks: number;
    indicatorChecksPassed: number;
  }>;
  dataSource: Readonly<
    Pick<
      GoldenManifest,
      | "provider"
      | "fetchedAt"
      | "range"
      | "fields"
      | "adjustment"
      | "delay"
      | "license"
    > & { files: Readonly<Record<string, FixtureRecord>> }
  >;
  implementations: Readonly<Record<string, string>>;
  tolerance: Readonly<{ value: number; rule: string }>;
  cases: readonly CaseResult[];
  indicators: readonly IndicatorCheck[];
}>;

export const buildGoldenResults = ({
  manifest,
  reference,
  fixtures,
}: GoldenInputs): GoldenResults => {
  const symbols = Object.keys(reference.fixtures);
  const bars = new Map<string, BarColumns>();
  const files: Record<string, FixtureRecord> = {};
  for (const symbol of symbols) {
    const fixture = fixtures[symbol];
    const listed = manifest.files[symbol];
    if (
      fixture === undefined ||
      listed === undefined ||
      fixture.sha256 !== listed.sha256 ||
      fixture.sha256 !== reference.fixtures[symbol]
    ) {
      throw new Error(
        `${symbol} fixture does not match manifest.json and golden-reference.json`
      );
    }
    bars.set(symbol, parseFixtureCsv(fixture.text));
    files[symbol] = {
      path: `${FIXTURE_DIR}/${listed.file}`,
      sha256: listed.sha256,
      rows: listed.rows,
      first: listed.first,
      last: listed.last,
    };
  }
  const barsOf = (symbol: string): BarColumns => {
    const found = bars.get(symbol);
    if (found === undefined) throw new Error(`no fixture for ${symbol}`);
    return found;
  };
  const cases = reference.cases.map((item) =>
    runGoldenCase(barsOf(item.symbol), item)
  );
  const indicators: IndicatorCheck[] = [];
  for (const symbol of symbols) {
    const checkpoints = reference.indicatorCheckpoints[symbol];
    if (checkpoints === undefined) {
      throw new Error(`reference has no indicator checkpoints for ${symbol}`);
    }
    indicators.push(
      ...layerChecks(
        "engine",
        symbol,
        engineSeries(barsOf(symbol)),
        checkpoints
      ),
      ...layerChecks("chart", symbol, chartSeries(barsOf(symbol)), checkpoints)
    );
    for (const [indicator, parity] of Object.entries(
      reference.pythonLibraryParity[symbol] ?? {}
    )) {
      indicators.push({
        layer: "python",
        symbol,
        indicator,
        scope: "all bars",
        comparedBars: parity.comparedBars,
        missingBars: parity.missingBars,
        maxAbsDiff: parity.maxAbsDiff,
        warmup: null,
        pass:
          parity.comparedBars > 0 &&
          parity.missingBars === 0 &&
          (parity.maxAbsDiff <= TOLERANCE || parity.maxRelDiff <= TOLERANCE),
      });
    }
  }
  const casesPassed = cases.filter((item) => item.pass).length;
  const indicatorsPassed = indicators.filter((item) => item.pass).length;
  return {
    schema: "vertex-golden-battery/v1",
    note: "Research and backtest evidence only. No result authorizes a trade.",
    pass:
      casesPassed === cases.length && indicatorsPassed === indicators.length,
    summary: {
      cases: cases.length,
      casesPassed,
      indicatorChecks: indicators.length,
      indicatorChecksPassed: indicatorsPassed,
    },
    dataSource: {
      provider: manifest.provider,
      fetchedAt: manifest.fetchedAt,
      range: manifest.range,
      fields: manifest.fields,
      adjustment: manifest.adjustment,
      delay: manifest.delay,
      license: manifest.license,
      files,
    },
    implementations: {
      vertexBacktest: "packages/api/src/instant-backtest-engine.ts",
      vertexChartIndicators: "apps/web/src/features/charts/indicator-math.ts",
      vertexPythonIndicators: "services/research/indicators/core.py",
      referenceBacktest: reference.backtestReference,
      referenceIndicators: reference.indicatorReference,
      referenceGenerator: reference.generator,
    },
    tolerance: {
      value: TOLERANCE,
      rule: "|vertex - reference| <= value * max(1, |reference|) for every price, P&L, return, ratio and indicator value; trade count, entry bar, exit bar and exit reason must be equal",
    },
    cases,
    indicators,
  };
};

const fixed = (value: number | null, digits = 4): string =>
  value === null ? "n/a" : value.toFixed(digits);

const percent = (value: number | null): string =>
  value === null ? "n/a" : `${(value * 100).toFixed(2)}%`;

const metricOf = (item: CaseResult, name: MetricName): MetricComparison => {
  const found = item.metrics.find((metric) => metric.name === name);
  if (found === undefined) throw new Error(`case ${item.id} lacks ${name}`);
  return found;
};

const verdict = (pass: boolean): string => (pass ? "pass" : "FAIL");

export const renderSummary = (results: GoldenResults): string => {
  const lines = [
    "# Golden backtest battery: results",
    "",
    "Generated by `bun run vertex:golden-battery -- write`. Do not edit by hand. Method, conventions and data terms: [README.md](README.md). Machine-readable results: [results.json](results.json).",
    "",
    `Overall: **${verdict(results.pass)}**. Backtest cases: ${results.summary.casesPassed} of ${results.summary.cases} pass. Indicator checks: ${results.summary.indicatorChecksPassed} of ${results.summary.indicatorChecks} pass. Tolerance: ${results.tolerance.value} (relative, absolute below 1).`,
    "",
    "Research and backtest evidence only. No result authorizes a trade.",
    "",
    "## Backtests: Vertex engine and pandas reference",
    "",
    "Values are from the Vertex engine. Max diff is the largest difference from the pandas reference over all compared numbers of the case.",
    "",
    "|Case|Trades (Vertex/pandas)|Final equity|CAGR|Max drawdown|Sharpe|Profit factor|Win rate|Max diff|Result|",
    "|---|---|---|---|---|---|---|---|---|---|",
  ];
  for (const item of results.cases) {
    const diff = Math.max(
      item.trades.maxPriceDiff,
      item.trades.maxPnlDiff,
      ...item.metrics.map((metric) => metric.absDiff ?? 0)
    );
    lines.push(
      `|${item.id}|${item.trades.vertexCount}/${item.trades.referenceCount}|${fixed(metricOf(item, "finalEquity").vertex)}|${percent(metricOf(item, "cagr").vertex)}|${percent(metricOf(item, "maxDrawdown").vertex)}|${fixed(metricOf(item, "sharpe").vertex, 3)}|${fixed(metricOf(item, "profitFactor").vertex, 3)}|${percent(metricOf(item, "winRate").vertex)}|${diff.toExponential(1)}|${verdict(item.pass)}|`
    );
  }
  lines.push(
    "",
    "## Indicators: Vertex code and reference values",
    "",
    "Engine and chart: compared at checkpoint bars (every 50th bar and the last bar) after a run over all bars, and the first bar with a value must equal the TA-Lib first bar (MACD line and Stochastic %K start earlier on purpose; see docs/indicators.md). Python: values recorded when the reference was generated, compared on every bar; this script does not run Python, and `services/research/tests/test_golden_battery.py` rechecks the library locally.",
    "",
    "|Layer|Symbol|Indicators|Compared bars|Max abs diff|Result|",
    "|---|---|---|---|---|---|"
  );
  const groups = new Map<string, IndicatorCheck[]>();
  for (const check of results.indicators) {
    const key = `${check.layer}|${check.symbol}`;
    groups.set(key, [...(groups.get(key) ?? []), check]);
  }
  for (const checks of groups.values()) {
    const first = checks[0] as IndicatorCheck;
    lines.push(
      `|${first.layer}|${first.symbol}|${checks.map((check) => check.indicator).join(", ")}|${checks.reduce((total, check) => total + check.comparedBars, 0)}|${Math.max(...checks.map((check) => check.maxAbsDiff)).toExponential(1)}|${verdict(checks.every((check) => check.pass))}|`
    );
  }
  lines.push(
    "",
    "## Data",
    "",
    `- Provider: ${results.dataSource.provider}. Range ${results.dataSource.range.start} to ${results.dataSource.range.end}. Fetched ${results.dataSource.fetchedAt}.`,
    `- Adjustment: ${results.dataSource.adjustment}`,
    `- Delay: ${results.dataSource.delay}`,
    `- License: ${results.dataSource.license}`,
    ""
  );
  return lines.join("\n");
};

export type GoldenBatteryIo = Readonly<{
  root: string;
  stdout: Readonly<{ write: (text: string) => unknown }>;
  stderr: Readonly<{ write: (text: string) => unknown }>;
  /** Defaults to node:fs; tests pass in-memory files. */
  readText?: (path: string) => string;
  writeText?: (path: string, text: string) => void;
}>;

const nodeReadText = (path: string): string => readFileSync(path, "utf8");

const nodeWriteText = (path: string, text: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

export const loadGoldenInputs = (io: GoldenBatteryIo): GoldenInputs => {
  const readText = io.readText ?? nodeReadText;
  const read = (relative: string) => readText(join(io.root, relative));
  const manifest = GoldenManifestSchema.parse(
    JSON.parse(read(`${FIXTURE_DIR}/manifest.json`))
  );
  const reference = GoldenReferenceSchema.parse(
    JSON.parse(read(`${FIXTURE_DIR}/golden-reference.json`))
  );
  const fixtures = Object.fromEntries(
    Object.entries(manifest.files).map(([symbol, file]) => {
      const text = read(`${FIXTURE_DIR}/${file.file}`);
      return [
        symbol,
        { text, sha256: createHash("sha256").update(text).digest("hex") },
      ];
    })
  );
  return { manifest, reference, fixtures };
};

/** `write` stores results.json and summary.md; `check` fails when they are stale or a check fails. */
export const runGoldenBatteryCli = (
  argv: readonly string[],
  io: GoldenBatteryIo
): number => {
  const [mode] = argv;
  if (mode !== "write" && mode !== "check") {
    io.stderr.write("usage: bun run vertex:golden-battery -- write|check\n");
    return 2;
  }
  const results = buildGoldenResults(loadGoldenInputs(io));
  const json = `${JSON.stringify(results, null, 2)}\n`;
  const summary = renderSummary(results);
  const resultsPath = join(io.root, RESULTS_PATH);
  const summaryPath = join(io.root, SUMMARY_PATH);
  if (mode === "write") {
    const writeText = io.writeText ?? nodeWriteText;
    writeText(resultsPath, json);
    writeText(summaryPath, summary);
  } else {
    const readText = io.readText ?? nodeReadText;
    const stale =
      JSON.stringify(JSON.parse(readText(resultsPath))) !==
        JSON.stringify(results) || readText(summaryPath) !== summary;
    if (stale) {
      io.stderr.write(
        `${RESULTS_PATH} or ${SUMMARY_PATH} is stale; run bun run vertex:golden-battery -- write\n`
      );
      return 1;
    }
  }
  io.stdout.write(
    `golden battery ${verdict(results.pass)}: ${results.summary.casesPassed}/${results.summary.cases} cases, ${results.summary.indicatorChecksPassed}/${results.summary.indicatorChecks} indicator checks\n`
  );
  return results.pass ? 0 : 1;
};
