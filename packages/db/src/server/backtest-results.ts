// Backtest result normalization for the agent operations ledger.
// Values are whatever the reporting agent supplied; this module only enforces bounds, numeric
// finiteness and chronological order, and derives the drawdown series from equity. A client-supplied
// drawdown is never accepted.
import {
  type AgentMetrics,
  BACKTEST_RATING_VALUES,
  type BacktestBenchmark,
  type BacktestDrawdownPoint,
  type BacktestEquityPoint,
  type BacktestFillModel,
  type BacktestFold,
  type BacktestIsSplit,
  type BacktestRating,
  type BacktestRatingDecision,
  type BacktestRatingSeries,
  type BacktestRunConfig,
  type BacktestSplitWindow,
  type BacktestTrade,
} from "../schema/index.ts";

export const BACKTEST_EQUITY_MAX_POINTS = 5000;
export const BACKTEST_TRADES_MAX = 2000;
export const BACKTEST_FOLDS_MAX = 100;
const BACKTEST_METRICS_MAX_KEYS = 40;
const BACKTEST_LABEL_MAX_LENGTH = 200;
const BACKTEST_INSTRUMENTS_MAX_LENGTH = 500;
const BACKTEST_DATA_SOURCE_MAX_LENGTH = 300;
const BACKTEST_NOTES_MAX_LENGTH = 4000;
const BACKTEST_FOLD_LABEL_MAX_LENGTH = 64;
const BACKTEST_FILL_MODELS = ["bar", "tick", "l2"] as const;
const BACKTEST_TRADE_LABEL_MAX_LENGTH = 40;
const BACKTEST_BENCHMARK_LABEL_MAX_LENGTH = 120;
const BACKTEST_TIMEFRAME_MAX_LENGTH = 16;
const BACKTEST_RATING_DECISIONS_MIN = 2;
const BACKTEST_RATING_DECISIONS_MAX = 520;
const BACKTEST_RATING_COST_BPS_MAX = 500;
const BACKTEST_RATING_SYMBOL_MAX_LENGTH = 32;
const BACKTEST_RATING_TIMEFRAMES = ["1d"] as const;
const RATING_RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,39}$/;

const METRIC_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const METRIC_STRING_MAX_LENGTH = 200;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2}))?$/;

export class BacktestResultInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BacktestResultInputError";
  }
}

const fail: (message: string) => never = (message) => {
  throw new BacktestResultInputError(message);
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const exactKeys = (
  value: Record<string, unknown>,
  allowed: readonly string[],
  field: string
): void => {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      fail(`${field}.${key} is not a recognized field`);
  }
};

// Accepts YYYY-MM-DD or an ISO 8601 datetime with an explicit zone. Returns epoch ms for ordering.
const parseBacktestTime = (value: unknown, field: string): number => {
  if (typeof value !== "string" || !TIME_PATTERN.test(value))
    fail(`${field} must be an ISO date or zoned ISO datetime`);
  const text = value as string;
  const ms = Date.parse(DATE_PATTERN.test(text) ? `${text}T00:00:00Z` : text);
  if (!Number.isFinite(ms)) fail(`${field} is not a valid time`);
  // Reject calendar overflow such as 2024-02-31, which Date.parse silently rolls over.
  if (
    new Date(ms).toISOString().slice(0, 10) !== text.slice(0, 10) &&
    !/[+-]\d{2}:\d{2}$/.test(text)
  ) {
    fail(`${field} is not a valid calendar date`);
  }
  return ms;
};

const parseBacktestDate = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !DATE_PATTERN.test(value))
    fail(`${field} must be YYYY-MM-DD`);
  parseBacktestTime(value, field);
  return value as string;
};

const finite = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value))
    fail(`${field} must be a finite number`);
  return value as number;
};

const text = (value: unknown, field: string, max: number): string => {
  if (typeof value !== "string") fail(`${field} must be a string`);
  const trimmed = (value as string).trim();
  if (trimmed === "") fail(`${field} must not be blank`);
  if (trimmed.length > max) fail(`${field} must not exceed ${max} characters`);
  return trimmed;
};

const optionalText = (
  value: unknown,
  field: string,
  max: number
): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") fail(`${field} must be a string`);
  const trimmed = (value as string).trim();
  if (trimmed === "") return null;
  if (trimmed.length > max) fail(`${field} must not exceed ${max} characters`);
  return trimmed;
};

// Flat metric map: bounded keys, finite numbers or short strings. No nesting.
const normalizeBacktestMetrics = (
  value: unknown,
  field: string
): AgentMetrics => {
  if (value === undefined || value === null) return {};
  if (!isRecord(value)) fail(`${field} must be an object`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > BACKTEST_METRICS_MAX_KEYS)
    fail(`${field} must not exceed ${BACKTEST_METRICS_MAX_KEYS} keys`);
  const result: AgentMetrics = {};
  for (const [key, entry] of entries) {
    if (!METRIC_KEY_PATTERN.test(key))
      fail(`${field} key ${key.slice(0, 40)} is invalid`);
    if (typeof entry === "number") {
      result[key] = finite(entry, `${field}.${key}`);
    } else if (typeof entry === "string") {
      if (entry.length > METRIC_STRING_MAX_LENGTH)
        fail(
          `${field}.${key} must not exceed ${METRIC_STRING_MAX_LENGTH} characters`
        );
      result[key] = entry;
    } else {
      fail(`${field}.${key} must be a finite number or a string`);
    }
  }
  return result;
};

// Strictly increasing timestamps; equity strictly positive so drawdown against the running peak is defined.
const normalizeBacktestEquity = (value: unknown): BacktestEquityPoint[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail("equity must be an array");
  const points = value as unknown[];
  if (points.length > BACKTEST_EQUITY_MAX_POINTS)
    fail(`equity must not exceed ${BACKTEST_EQUITY_MAX_POINTS} points`);
  let previous = Number.NEGATIVE_INFINITY;
  return points.map((point, index) => {
    const field = `equity[${index}]`;
    if (!isRecord(point)) fail(`${field} must be an object`);
    exactKeys(point as Record<string, unknown>, ["t", "equity"], field);
    const record = point as Record<string, unknown>;
    const ms = parseBacktestTime(record["t"], `${field}.t`);
    if (ms <= previous) fail(`${field}.t must be after the previous point`);
    previous = ms;
    const equity = finite(record["equity"], `${field}.equity`);
    if (equity <= 0) fail(`${field}.equity must be positive`);
    return { t: record["t"] as string, equity };
  });
};

// drawdown_i = equity_i / max(equity_0..i) - 1, so 0 at a new peak and negative below it.
export const deriveBacktestDrawdown = (
  equity: readonly BacktestEquityPoint[]
): BacktestDrawdownPoint[] => {
  let peak = 0;
  return equity.map((point) => {
    peak = Math.max(peak, point.equity);
    const drawdown = point.equity / peak - 1;
    return { t: point.t, drawdown: Object.is(drawdown, -0) ? 0 : drawdown };
  });
};

export const maxBacktestDrawdown = (
  drawdown: readonly BacktestDrawdownPoint[]
): number | null => {
  if (drawdown.length === 0) return null;
  return drawdown.reduce(
    (lowest, point) => Math.min(lowest, point.drawdown),
    0
  );
};

// Trades ordered by entry time (non-decreasing); each exit at or after its entry.
const normalizeBacktestTrades = (value: unknown): BacktestTrade[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail("trades must be an array");
  const trades = value as unknown[];
  if (trades.length > BACKTEST_TRADES_MAX)
    fail(`trades must not exceed ${BACKTEST_TRADES_MAX} rows`);
  let previousEntry = Number.NEGATIVE_INFINITY;
  return trades.map((trade, index) => {
    const field = `trades[${index}]`;
    if (!isRecord(trade)) fail(`${field} must be an object`);
    const record = trade as Record<string, unknown>;
    exactKeys(
      record,
      [
        "entry_t",
        "exit_t",
        "side",
        "qty",
        "entry_px",
        "exit_px",
        "pnl",
        "sl",
        "tp",
        "commission",
        "regime",
        "symbol",
      ],
      field
    );
    const entry = parseBacktestTime(record["entry_t"], `${field}.entry_t`);
    const exit = parseBacktestTime(record["exit_t"], `${field}.exit_t`);
    if (exit < entry) fail(`${field}.exit_t must not precede entry_t`);
    if (entry < previousEntry)
      fail(`${field}.entry_t must not precede the previous trade entry`);
    previousEntry = entry;
    if (record["side"] !== "long" && record["side"] !== "short")
      fail(`${field}.side must be long or short`);
    const qty = finite(record["qty"], `${field}.qty`);
    if (qty <= 0) fail(`${field}.qty must be positive`);
    const entryPx = finite(record["entry_px"], `${field}.entry_px`);
    const exitPx = finite(record["exit_px"], `${field}.exit_px`);
    if (entryPx <= 0 || exitPx <= 0) fail(`${field} prices must be positive`);
    return {
      entry_t: record["entry_t"] as string,
      exit_t: record["exit_t"] as string,
      side: record["side"] as BacktestTrade["side"],
      qty,
      entry_px: entryPx,
      exit_px: exitPx,
      pnl: finite(record["pnl"], `${field}.pnl`),
      ...optionalTradeFields(record, field),
    };
  });
};

// Optional per-trade fields. Absent or null values are omitted, never stored as null.
const optionalTradeFields = (
  record: Record<string, unknown>,
  field: string
): Partial<BacktestTrade> => {
  const result: Partial<BacktestTrade> = {};
  for (const key of ["sl", "tp"] as const) {
    if (record[key] !== undefined && record[key] !== null) {
      const price = finite(record[key], `${field}.${key}`);
      if (price <= 0) fail(`${field}.${key} must be positive`);
      result[key] = price;
    }
  }
  if (record["commission"] !== undefined && record["commission"] !== null) {
    const commission = finite(record["commission"], `${field}.commission`);
    if (commission < 0) fail(`${field}.commission must not be negative`);
    result.commission = commission;
  }
  const regime = optionalText(
    record["regime"],
    `${field}.regime`,
    BACKTEST_TRADE_LABEL_MAX_LENGTH
  );
  if (regime !== null) result.regime = regime;
  const symbol = optionalText(
    record["symbol"],
    `${field}.symbol`,
    BACKTEST_TRADE_LABEL_MAX_LENGTH
  );
  if (symbol !== null) result.symbol = symbol;
  return result;
};

// Run assumptions: every field optional; amounts non-negative, capital and leverage positive.
const normalizeBacktestRunConfig = (
  value: unknown
): BacktestRunConfig | null => {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) fail("runConfig must be an object");
  const record = value as Record<string, unknown>;
  exactKeys(
    record,
    [
      "initialCapital",
      "commissionPerContract",
      "commissionPerTrade",
      "commissionPercent",
      "slippagePercent",
      "timeframe",
      "fillModel",
      "leverage",
    ],
    "runConfig"
  );
  const result: BacktestRunConfig = {};
  for (const key of ["initialCapital", "leverage"] as const) {
    if (record[key] !== undefined && record[key] !== null) {
      const amount = finite(record[key], `runConfig.${key}`);
      if (amount <= 0) fail(`runConfig.${key} must be positive`);
      result[key] = amount;
    }
  }
  for (const key of [
    "commissionPerContract",
    "commissionPerTrade",
    "commissionPercent",
    "slippagePercent",
  ] as const) {
    if (record[key] !== undefined && record[key] !== null) {
      const amount = finite(record[key], `runConfig.${key}`);
      if (amount < 0) fail(`runConfig.${key} must not be negative`);
      result[key] = amount;
    }
  }
  const timeframe = optionalText(
    record["timeframe"],
    "runConfig.timeframe",
    BACKTEST_TIMEFRAME_MAX_LENGTH
  );
  if (timeframe !== null) result.timeframe = timeframe;
  if (record["fillModel"] !== undefined && record["fillModel"] !== null) {
    if (
      !BACKTEST_FILL_MODELS.includes(record["fillModel"] as BacktestFillModel)
    )
      fail("runConfig.fillModel must be bar, tick or l2");
    result.fillModel = record["fillModel"] as BacktestFillModel;
  }
  return Object.keys(result).length === 0 ? null : result;
};

// Benchmark equity: same point rules as the strategy equity.
const normalizeBacktestBenchmark = (
  value: unknown
): BacktestBenchmark | null => {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) fail("benchmark must be an object");
  const record = value as Record<string, unknown>;
  exactKeys(record, ["label", "points"], "benchmark");
  const points = normalizeBacktestEquity(record["points"]);
  if (points.length === 0) fail("benchmark.points must not be empty");
  return {
    label: text(
      record["label"],
      "benchmark.label",
      BACKTEST_BENCHMARK_LABEL_MAX_LENGTH
    ),
    points,
  };
};

const normalizeRatingDecision = (
  value: unknown,
  field: string
): BacktestRatingDecision => {
  if (!isRecord(value)) fail(`${field} must be an object`);
  const record = value as Record<string, unknown>;
  exactKeys(record, ["date", "rating", "runId"], field);
  const rating = record["rating"] ?? null;
  if (
    rating !== null &&
    !BACKTEST_RATING_VALUES.includes(rating as BacktestRating)
  )
    fail(
      `${field}.rating must be buy, overweight, hold, underweight, sell or null`
    );
  const decision: BacktestRatingDecision = {
    date: parseBacktestDate(record["date"], `${field}.date`),
    rating: rating as BacktestRating | null,
  };
  const runId = record["runId"];
  if (runId === undefined || runId === null) return decision;
  if (typeof runId !== "string" || !RATING_RUN_ID_PATTERN.test(runId))
    fail(`${field}.runId must be 1-40 letters, digits, '.', '_', ':' or '-'`);
  return { ...decision, runId: runId as string };
};

// Agent rating decisions: dates strictly increasing, research stance labels only (never an order).
const normalizeBacktestRatingSeries = (
  value: unknown
): BacktestRatingSeries | null => {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) fail("ratingSeries must be an object");
  const record = value as Record<string, unknown>;
  exactKeys(
    record,
    ["symbol", "timeframe", "costBps", "decisions"],
    "ratingSeries"
  );
  const timeframe = record["timeframe"] ?? "1d";
  if (!BACKTEST_RATING_TIMEFRAMES.includes(timeframe as "1d"))
    fail("ratingSeries.timeframe must be 1d");
  const costBps = finite(record["costBps"] ?? 10, "ratingSeries.costBps");
  if (costBps < 0 || costBps > BACKTEST_RATING_COST_BPS_MAX)
    fail(
      `ratingSeries.costBps must be between 0 and ${BACKTEST_RATING_COST_BPS_MAX}`
    );
  const decisions = record["decisions"];
  if (
    !Array.isArray(decisions) ||
    decisions.length < BACKTEST_RATING_DECISIONS_MIN ||
    decisions.length > BACKTEST_RATING_DECISIONS_MAX
  )
    fail(
      `ratingSeries.decisions must be an array of ${BACKTEST_RATING_DECISIONS_MIN} to ${BACKTEST_RATING_DECISIONS_MAX} decisions`
    );
  const normalized = (decisions as unknown[]).map((decision, index) =>
    normalizeRatingDecision(decision, `ratingSeries.decisions[${index}]`)
  );
  normalized.forEach((decision, index) => {
    const previous = normalized[index - 1];
    if (previous !== undefined && decision.date <= previous.date)
      fail("ratingSeries.decisions dates must be strictly increasing");
  });
  return {
    costBps,
    decisions: normalized,
    symbol: text(
      record["symbol"],
      "ratingSeries.symbol",
      BACKTEST_RATING_SYMBOL_MAX_LENGTH
    ),
    timeframe: timeframe as string,
  };
};

// Walk-forward folds: train_start < train_end <= test_start < test_end; folds ordered by test_start.
const normalizeBacktestFolds = (value: unknown): BacktestFold[] => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail("folds must be an array");
  const folds = value as unknown[];
  if (folds.length > BACKTEST_FOLDS_MAX)
    fail(`folds must not exceed ${BACKTEST_FOLDS_MAX} rows`);
  let previousTest = Number.NEGATIVE_INFINITY;
  return folds.map((fold, index) => {
    const field = `folds[${index}]`;
    if (!isRecord(fold)) fail(`${field} must be an object`);
    const record = fold as Record<string, unknown>;
    exactKeys(
      record,
      [
        "label",
        "train_start",
        "train_end",
        "test_start",
        "test_end",
        "metrics",
      ],
      field
    );
    const trainStart = parseBacktestTime(
      record["train_start"],
      `${field}.train_start`
    );
    const trainEnd = parseBacktestTime(
      record["train_end"],
      `${field}.train_end`
    );
    const testStart = parseBacktestTime(
      record["test_start"],
      `${field}.test_start`
    );
    const testEnd = parseBacktestTime(record["test_end"], `${field}.test_end`);
    if (!(trainStart < trainEnd))
      fail(`${field}.train_start must precede train_end`);
    if (!(trainEnd <= testStart))
      fail(`${field}.test_start must not precede train_end`);
    if (!(testStart < testEnd))
      fail(`${field}.test_start must precede test_end`);
    if (testStart < previousTest)
      fail(`${field}.test_start must not precede the previous fold`);
    previousTest = testStart;
    return {
      label: text(
        record["label"],
        `${field}.label`,
        BACKTEST_FOLD_LABEL_MAX_LENGTH
      ),
      train_start: record["train_start"] as string,
      train_end: record["train_end"] as string,
      test_start: record["test_start"] as string,
      test_end: record["test_end"] as string,
      metrics: normalizeBacktestMetrics(record["metrics"], `${field}.metrics`),
    };
  });
};

const normalizeWindow = (
  value: unknown,
  field: string
): BacktestSplitWindow & {
  readonly startMs: number;
  readonly endMs: number;
} => {
  if (!isRecord(value)) fail(`${field} must be an object`);
  const record = value as Record<string, unknown>;
  exactKeys(record, ["start", "end", "metrics"], field);
  const startMs = parseBacktestTime(record["start"], `${field}.start`);
  const endMs = parseBacktestTime(record["end"], `${field}.end`);
  if (!(startMs < endMs)) fail(`${field}.start must precede end`);
  return {
    start: record["start"] as string,
    end: record["end"] as string,
    metrics: normalizeBacktestMetrics(record["metrics"], `${field}.metrics`),
    startMs,
    endMs,
  };
};

// In-sample window ends at or before the out-of-sample window starts.
const normalizeBacktestIsSplit = (value: unknown): BacktestIsSplit | null => {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) fail("isSplit must be an object");
  const record = value as Record<string, unknown>;
  exactKeys(record, ["in_sample", "out_of_sample"], "isSplit");
  const inSample = normalizeWindow(record["in_sample"], "isSplit.in_sample");
  const outOfSample = normalizeWindow(
    record["out_of_sample"],
    "isSplit.out_of_sample"
  );
  if (outOfSample.startMs < inSample.endMs)
    fail("isSplit.out_of_sample must start at or after in_sample ends");
  return {
    in_sample: {
      start: inSample.start,
      end: inSample.end,
      metrics: inSample.metrics,
    },
    out_of_sample: {
      start: outOfSample.start,
      end: outOfSample.end,
      metrics: outOfSample.metrics,
    },
  };
};

export type BacktestResultDraft = Readonly<{
  taskId: string;
  paperId?: string | null;
  strategyId?: string | null;
  strategy: string;
  instruments: string;
  periodStart: string;
  periodEnd: string;
  dataSource: string;
  isSplit?: unknown;
  metrics?: unknown;
  equity?: unknown;
  trades?: unknown;
  folds?: unknown;
  notes?: string | null;
  runConfig?: unknown;
  benchmark?: unknown;
  ratingSeries?: unknown;
}>;

export type NormalizedBacktestResult = Readonly<{
  taskId: string;
  paperId: string | null;
  strategyId: string | null;
  strategy: string;
  instruments: string;
  periodStart: string;
  periodEnd: string;
  dataSource: string;
  isSplit: BacktestIsSplit | null;
  metrics: AgentMetrics;
  equity: BacktestEquityPoint[];
  drawdown: BacktestDrawdownPoint[];
  maxDrawdown: number | null;
  trades: BacktestTrade[];
  tradeCount: number;
  folds: BacktestFold[];
  notes: string | null;
  runConfig: BacktestRunConfig | null;
  benchmark: BacktestBenchmark | null;
  ratingSeries: BacktestRatingSeries | null;
}>;

export const normalizeBacktestResult = (
  input: BacktestResultDraft
): NormalizedBacktestResult => {
  const taskId = text(input.taskId, "taskId", 128);
  const paperId = optionalText(input.paperId, "paperId", 128);
  const strategyId = optionalText(input.strategyId, "strategyId", 128);
  const periodStart = parseBacktestDate(input.periodStart, "periodStart");
  const periodEnd = parseBacktestDate(input.periodEnd, "periodEnd");
  if (periodEnd < periodStart) fail("periodEnd must not precede periodStart");
  const equity = normalizeBacktestEquity(input.equity);
  const drawdown = deriveBacktestDrawdown(equity);
  const trades = normalizeBacktestTrades(input.trades);
  return {
    taskId,
    paperId,
    strategyId,
    strategy: text(input.strategy, "strategy", BACKTEST_LABEL_MAX_LENGTH),
    instruments: text(
      input.instruments,
      "instruments",
      BACKTEST_INSTRUMENTS_MAX_LENGTH
    ),
    periodStart,
    periodEnd,
    dataSource: text(
      input.dataSource,
      "dataSource",
      BACKTEST_DATA_SOURCE_MAX_LENGTH
    ),
    isSplit: normalizeBacktestIsSplit(input.isSplit),
    metrics: normalizeBacktestMetrics(input.metrics, "metrics"),
    equity,
    drawdown,
    maxDrawdown: maxBacktestDrawdown(drawdown),
    ratingSeries: normalizeBacktestRatingSeries(input.ratingSeries),
    trades,
    tradeCount: trades.length,
    folds: normalizeBacktestFolds(input.folds),
    notes: optionalText(input.notes, "notes", BACKTEST_NOTES_MAX_LENGTH),
    runConfig: normalizeBacktestRunConfig(input.runConfig),
    benchmark: normalizeBacktestBenchmark(input.benchmark),
  };
};
