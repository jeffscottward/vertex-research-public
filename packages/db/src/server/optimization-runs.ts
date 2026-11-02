// Optimization run normalization for the agent operations ledger.
// Values are whatever the reporting agent supplied (services/research/backtesting/optimizer.py output
// mapped to camelCase). This module only enforces shapes, bounds, finiteness, index ranges and the
// method/validation combinations the optimizer itself allows. Nothing derived is accepted or stored.
import {
  OPTIMIZATION_DIRECTIONS,
  OPTIMIZATION_METHODS,
  OPTIMIZATION_STOP_REASONS,
  OPTIMIZATION_VALIDATION_MODES,
  type OptimizationBest,
  type OptimizationDeflatedSharpe,
  type OptimizationDiagnostics,
  type OptimizationDirection,
  type OptimizationFold,
  type OptimizationMarketRank,
  type OptimizationMethod,
  type OptimizationMetricMap,
  type OptimizationObjective,
  type OptimizationOos,
  type OptimizationOosReport,
  type OptimizationParams,
  type OptimizationParetoPoint,
  type OptimizationPbo,
  type OptimizationStopReason,
  type OptimizationTrial,
  type OptimizationValidation,
  type OptimizationValidationMode,
  type OptimizationValidationParams,
  type OptimizationWindow,
} from "../schema/index.ts";

const OPTIMIZATION_OBJECTIVES_MAX = 8;
export const OPTIMIZATION_MARKETS_MAX = 40;
export const OPTIMIZATION_TRIALS_MAX = 5000;
const OPTIMIZATION_TRIAL_COUNT_MAX = 1_000_000;
export const OPTIMIZATION_PARETO_MAX = 500;
export const OPTIMIZATION_FOLDS_MAX = 100;
const OPTIMIZATION_TOP_K_MAX = 50;
const OPTIMIZATION_PARAMS_MAX_KEYS = 64;
const OPTIMIZATION_METRICS_MAX_KEYS = 40;
const OPTIMIZATION_NOTES_MAX_LENGTH = 4000;
const OPTIMIZATION_REASON_MAX_LENGTH = 300;
const OPTIMIZATION_MARKET_MAX_LENGTH = 64;
const OPTIMIZATION_PARAM_STRING_MAX_LENGTH = 200;
// JSON byte budgets (UTF-8 of JSON.stringify); the database checks allow headroom above these.
const OPTIMIZATION_TRIALS_MAX_BYTES = 8 * 1024 * 1024;
const OPTIMIZATION_FOLDS_MAX_BYTES = 2 * 1024 * 1024;
const OPTIMIZATION_PARETO_MAX_BYTES = 1024 * 1024;
const OPTIMIZATION_OOS_MAX_BYTES = 512 * 1024;

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$/;
const PBO_METRICS = ["sharpe", "mean"] as const;

export class OptimizationRunInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OptimizationRunInputError";
  }
}

const fail: (message: string) => never = (message) => {
  throw new OptimizationRunInputError(message);
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isSet = (value: unknown): boolean => {
  return value !== undefined && value !== null;
};

const record = (
  value: unknown,
  field: string,
  allowed: readonly string[]
): Record<string, unknown> => {
  if (!isRecord(value)) fail(`${field} must be an object`);
  const result = value as Record<string, unknown>;
  for (const key of Object.keys(result)) {
    if (!allowed.includes(key))
      fail(`${field}.${key.slice(0, 40)} is not a recognized field`);
  }
  return result;
};

const array = (value: unknown, field: string, max: number): unknown[] => {
  if (!isSet(value)) return [];
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  const rows = value as unknown[];
  if (rows.length > max) fail(`${field} must not exceed ${max} rows`);
  return rows;
};

const finite = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value))
    fail(`${field} must be a finite number`);
  return value as number;
};

const nullableFinite = (value: unknown, field: string): number | null => {
  return isSet(value) ? finite(value, field) : null;
};

const integer = (
  value: unknown,
  field: string,
  min: number,
  max: number
): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    fail(`${field} must be an integer`);
  const number = value as number;
  if (number < min || number > max)
    fail(`${field} must be between ${min} and ${max}`);
  return number;
};

const nullableInteger = (
  value: unknown,
  field: string,
  min: number,
  max: number
): number | null => {
  return isSet(value) ? integer(value, field, min, max) : null;
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
  if (!isSet(value)) return null;
  if (typeof value !== "string") fail(`${field} must be a string`);
  const trimmed = (value as string).trim();
  if (trimmed === "") return null;
  if (trimmed.length > max) fail(`${field} must not exceed ${max} characters`);
  return trimmed;
};

const oneOf = <T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[]
): T => {
  if (typeof value !== "string" || !allowed.includes(value as T))
    fail(`${field} must be one of ${allowed.join(", ")}`);
  return value as T;
};

const jsonBytes = (value: unknown): number => {
  return new TextEncoder().encode(JSON.stringify(value)).length;
};

const withinBytes = <T>(value: T, field: string, max: number): T => {
  if (jsonBytes(value) > max)
    fail(`${field} must not exceed ${max} bytes of JSON`);
  return value;
};

const name = (value: string, field: string): string => {
  if (!NAME_PATTERN.test(value))
    fail(`${field} key ${value.slice(0, 40)} is invalid`);
  return value;
};

// Parameter values: finite numbers, booleans, short strings or null (choice parameters allow None).
const normalizeOptimizationParams = (
  value: unknown,
  field: string
): OptimizationParams => {
  if (!isRecord(value)) fail(`${field} must be an object`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > OPTIMIZATION_PARAMS_MAX_KEYS)
    fail(`${field} must not exceed ${OPTIMIZATION_PARAMS_MAX_KEYS} keys`);
  const result: OptimizationParams = {};
  for (const [key, entry] of entries) {
    name(key, field);
    if (entry === null || typeof entry === "boolean") {
      result[key] = entry;
    } else if (typeof entry === "number") {
      result[key] = finite(entry, `${field}.${key}`);
    } else if (typeof entry === "string") {
      if (entry.length > OPTIMIZATION_PARAM_STRING_MAX_LENGTH)
        fail(
          `${field}.${key} must not exceed ${OPTIMIZATION_PARAM_STRING_MAX_LENGTH} characters`
        );
      result[key] = entry;
    } else {
      fail(`${field}.${key} must be a number, boolean, string or null`);
    }
  }
  return result;
};

// Flat metric map of finite numbers only.
const normalizeOptimizationMetrics = (
  value: unknown,
  field: string
): OptimizationMetricMap => {
  if (!isSet(value)) return {};
  if (!isRecord(value)) fail(`${field} must be an object`);
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > OPTIMIZATION_METRICS_MAX_KEYS)
    fail(`${field} must not exceed ${OPTIMIZATION_METRICS_MAX_KEYS} keys`);
  const result: OptimizationMetricMap = {};
  for (const [key, entry] of entries) {
    result[name(key, field)] = finite(entry, `${field}.${key}`);
  }
  return result;
};

const normalizeWindow = (value: unknown, field: string): OptimizationWindow => {
  const row = record(value, field, ["start", "end"]);
  const start = integer(
    row["start"],
    `${field}.start`,
    0,
    Number.MAX_SAFE_INTEGER
  );
  const end = integer(row["end"], `${field}.end`, 0, Number.MAX_SAFE_INTEGER);
  if (!(start < end)) fail(`${field}.start must precede end`);
  return { start, end };
};

const normalizeObjectives = (value: unknown): OptimizationObjective[] => {
  const rows = array(value, "objectives", OPTIMIZATION_OBJECTIVES_MAX);
  if (rows.length === 0) fail("objectives must not be empty");
  const seen = new Set<string>();
  return rows.map((entry, index) => {
    const field = `objectives[${index}]`;
    const row = record(entry, field, ["metric", "direction"]);
    const metric = text(row["metric"], `${field}.metric`, 64);
    name(metric, field);
    if (seen.has(metric)) fail(`${field}.metric must be unique`);
    seen.add(metric);
    return {
      metric,
      direction: oneOf(
        row["direction"] ?? "maximize",
        `${field}.direction`,
        OPTIMIZATION_DIRECTIONS
      ) as OptimizationDirection,
    };
  });
};

const normalizeValidation = (value: unknown): OptimizationValidation => {
  const row = record(value, "validation", ["mode", "params"]);
  const mode = oneOf(
    row["mode"],
    "validation.mode",
    OPTIMIZATION_VALIDATION_MODES
  ) as OptimizationValidationMode;
  const raw: Record<string, unknown> = isSet(row["params"])
    ? record(row["params"], "validation.params", [
        "nObservations",
        "isFraction",
        "trainLength",
        "testLength",
        "step",
        "anchored",
        "topK",
      ])
    : {};
  const params: OptimizationValidationParams = {};
  for (const key of [
    "nObservations",
    "trainLength",
    "testLength",
    "step",
    "topK",
  ] as const) {
    if (isSet(raw[key]))
      params[key] = integer(
        raw[key],
        `validation.params.${key}`,
        1,
        Number.MAX_SAFE_INTEGER
      );
  }
  if (isSet(raw["isFraction"])) {
    const fraction = finite(raw["isFraction"], "validation.params.isFraction");
    if (!(fraction > 0 && fraction < 1))
      fail("validation.params.isFraction must be between 0 and 1");
    params.isFraction = fraction;
  }
  if (isSet(raw["anchored"])) {
    if (typeof raw["anchored"] !== "boolean")
      fail("validation.params.anchored must be a boolean");
    params.anchored = raw["anchored"] as boolean;
  }
  return { mode, params };
};

const normalizeMarkets = (value: unknown): string[] => {
  const rows = array(value, "markets", OPTIMIZATION_MARKETS_MAX);
  if (rows.length === 0) fail("markets must not be empty");
  const markets = rows.map((entry, index) =>
    text(entry, `markets[${index}]`, OPTIMIZATION_MARKET_MAX_LENGTH)
  );
  if (new Set(markets).size !== markets.length) fail("markets must be unique");
  return markets;
};

const trialIndex = (
  value: unknown,
  field: string,
  trialCount: number
): number => {
  if (trialCount === 0)
    fail(`${field} cannot reference a trial when trialCount is 0`);
  return integer(value, field, 0, trialCount - 1);
};

const nullableTrialIndex = (
  value: unknown,
  field: string,
  trialCount: number
): number | null => {
  return isSet(value) ? trialIndex(value, field, trialCount) : null;
};

const trialStatus = (value: unknown, field: string) => {
  return oneOf(value, field, ["ok", "failed"] as const);
};

const normalizeTrials = (
  value: unknown,
  trialCount: number
): OptimizationTrial[] => {
  const rows = array(value, "trials", OPTIMIZATION_TRIALS_MAX);
  if (rows.length > trialCount) fail("trials must not exceed trialCount");
  const seen = new Set<number>();
  const trials = rows.map((entry, position) => {
    const field = `trials[${position}]`;
    const row = record(entry, field, [
      "index",
      "params",
      "score",
      "status",
      "metrics",
      "fold",
      "reason",
    ]);
    const index = trialIndex(row["index"], `${field}.index`, trialCount);
    if (seen.has(index)) fail(`${field}.index must be unique`);
    seen.add(index);
    const status = trialStatus(row["status"], `${field}.status`);
    const score = nullableFinite(row["score"], `${field}.score`);
    if (status === "failed" && score !== null)
      fail(`${field}.score must be null for a failed trial`);
    const trial: OptimizationTrial = {
      index,
      params: normalizeOptimizationParams(row["params"], `${field}.params`),
      score,
      status,
    };
    if (isSet(row["metrics"])) {
      trial.metrics = normalizeOptimizationMetrics(
        row["metrics"],
        `${field}.metrics`
      );
    }
    const fold = nullableInteger(
      row["fold"],
      `${field}.fold`,
      0,
      OPTIMIZATION_FOLDS_MAX - 1
    );
    if (fold !== null) trial.fold = fold;
    const reason = optionalText(
      row["reason"],
      `${field}.reason`,
      OPTIMIZATION_REASON_MAX_LENGTH
    );
    if (reason !== null) trial.reason = reason;
    return trial;
  });
  return withinBytes(trials, "trials", OPTIMIZATION_TRIALS_MAX_BYTES);
};

const normalizeBest = (
  value: unknown,
  trialCount: number
): OptimizationBest | null => {
  if (!isSet(value)) return null;
  const row = record(value, "best", [
    "trialIndex",
    "params",
    "score",
    "metrics",
  ]);
  return {
    trialIndex: nullableTrialIndex(
      row["trialIndex"],
      "best.trialIndex",
      trialCount
    ),
    params: normalizeOptimizationParams(row["params"], "best.params"),
    score: nullableFinite(row["score"], "best.score"),
    metrics: normalizeOptimizationMetrics(row["metrics"], "best.metrics"),
  };
};

const normalizeParetoFront = (
  value: unknown,
  objectives: readonly OptimizationObjective[],
  trialCount: number
): OptimizationParetoPoint[] => {
  const metrics = objectives.map((objective) => objective.metric);
  const seen = new Set<number>();
  const rows = array(value, "paretoFront", OPTIMIZATION_PARETO_MAX).map(
    (entry, position) => {
      const field = `paretoFront[${position}]`;
      const row = record(entry, field, ["trialIndex", "params", "values"]);
      const index = trialIndex(
        row["trialIndex"],
        `${field}.trialIndex`,
        trialCount
      );
      if (seen.has(index)) fail(`${field}.trialIndex must be unique`);
      seen.add(index);
      const values = normalizeOptimizationMetrics(
        row["values"],
        `${field}.values`
      );
      for (const key of Object.keys(values)) {
        if (!metrics.includes(key))
          fail(`${field}.values.${key} is not an objective metric`);
      }
      return {
        trialIndex: index,
        params: normalizeOptimizationParams(row["params"], `${field}.params`),
        values,
      };
    }
  );
  return withinBytes(rows, "paretoFront", OPTIMIZATION_PARETO_MAX_BYTES);
};

const normalizeOosReport = (
  value: unknown,
  field: string,
  trialCount: number
): OptimizationOosReport => {
  const row = record(value, field, [
    "trialIndex",
    "params",
    "inSampleScore",
    "score",
    "degradation",
    "status",
    "reason",
    "window",
  ]);
  const report: OptimizationOosReport = {
    trialIndex: trialIndex(
      row["trialIndex"],
      `${field}.trialIndex`,
      trialCount
    ),
    params: normalizeOptimizationParams(row["params"], `${field}.params`),
    inSampleScore: nullableFinite(
      row["inSampleScore"],
      `${field}.inSampleScore`
    ),
    score: nullableFinite(row["score"], `${field}.score`),
    degradation: nullableFinite(row["degradation"], `${field}.degradation`),
    status: trialStatus(row["status"], `${field}.status`),
  };
  const reason = optionalText(
    row["reason"],
    `${field}.reason`,
    OPTIMIZATION_REASON_MAX_LENGTH
  );
  if (reason !== null) report.reason = reason;
  if (isSet(row["window"]))
    report.window = normalizeWindow(row["window"], `${field}.window`);
  return report;
};

const nullableOosReport = (
  value: unknown,
  field: string,
  trialCount: number
): OptimizationOosReport | null => {
  return isSet(value) ? normalizeOosReport(value, field, trialCount) : null;
};

const normalizeDeflatedSharpe = (
  value: unknown,
  field: string
): OptimizationDeflatedSharpe | null => {
  if (!isSet(value)) return null;
  const row = record(value, field, [
    "sharpe",
    "nTrials",
    "sharpeVariance",
    "nObservations",
    "skew",
    "kurtosis",
    "expectedMaxSharpe",
    "z",
    "probability",
  ]);
  const probability = finite(row["probability"], `${field}.probability`);
  if (probability < 0 || probability > 1)
    fail(`${field}.probability must be between 0 and 1`);
  const sharpeVariance = finite(
    row["sharpeVariance"],
    `${field}.sharpeVariance`
  );
  if (sharpeVariance < 0) fail(`${field}.sharpeVariance must not be negative`);
  return {
    sharpe: finite(row["sharpe"], `${field}.sharpe`),
    nTrials: integer(
      row["nTrials"],
      `${field}.nTrials`,
      2,
      OPTIMIZATION_TRIAL_COUNT_MAX
    ),
    sharpeVariance,
    nObservations: integer(
      row["nObservations"],
      `${field}.nObservations`,
      2,
      Number.MAX_SAFE_INTEGER
    ),
    skew: finite(row["skew"], `${field}.skew`),
    kurtosis: finite(row["kurtosis"], `${field}.kurtosis`),
    expectedMaxSharpe: finite(
      row["expectedMaxSharpe"],
      `${field}.expectedMaxSharpe`
    ),
    z: finite(row["z"], `${field}.z`),
    probability,
  };
};

const normalizePbo = (
  value: unknown,
  field: string
): OptimizationPbo | null => {
  if (!isSet(value)) return null;
  const row = record(value, field, [
    "pbo",
    "nTrials",
    "nPeriodsUsed",
    "nPartitions",
    "nCombinations",
    "metric",
  ]);
  const pbo = finite(row["pbo"], `${field}.pbo`);
  if (pbo < 0 || pbo > 1) fail(`${field}.pbo must be between 0 and 1`);
  const partitions = integer(row["nPartitions"], `${field}.nPartitions`, 2, 16);
  if (partitions % 2 !== 0) fail(`${field}.nPartitions must be even`);
  return {
    pbo,
    nTrials: integer(
      row["nTrials"],
      `${field}.nTrials`,
      2,
      OPTIMIZATION_TRIAL_COUNT_MAX
    ),
    nPeriodsUsed: integer(
      row["nPeriodsUsed"],
      `${field}.nPeriodsUsed`,
      1,
      Number.MAX_SAFE_INTEGER
    ),
    nPartitions: partitions,
    nCombinations: integer(
      row["nCombinations"],
      `${field}.nCombinations`,
      1,
      12_870
    ),
    metric: oneOf(row["metric"], `${field}.metric`, PBO_METRICS),
  };
};

// DSR and PBO are each either an object or null with a reason (the optimizer's convention).
const normalizeOptimizationDiagnostics = (
  value: unknown,
  field: string
): OptimizationDiagnostics | null => {
  if (!isSet(value)) return null;
  const row = record(value, field, [
    "deflatedSharpe",
    "deflatedSharpeReason",
    "pbo",
    "pboReason",
  ]);
  const deflatedSharpe = normalizeDeflatedSharpe(
    row["deflatedSharpe"],
    `${field}.deflatedSharpe`
  );
  const pbo = normalizePbo(row["pbo"], `${field}.pbo`);
  const deflatedSharpeReason = optionalText(
    row["deflatedSharpeReason"],
    `${field}.deflatedSharpeReason`,
    OPTIMIZATION_REASON_MAX_LENGTH
  );
  const pboReason = optionalText(
    row["pboReason"],
    `${field}.pboReason`,
    OPTIMIZATION_REASON_MAX_LENGTH
  );
  if (deflatedSharpe === null && deflatedSharpeReason === null)
    fail(
      `${field}.deflatedSharpeReason is required when deflatedSharpe is null`
    );
  if (pbo === null && pboReason === null)
    fail(`${field}.pboReason is required when pbo is null`);
  return {
    deflatedSharpe,
    deflatedSharpeReason: deflatedSharpe === null ? deflatedSharpeReason : null,
    pbo,
    pboReason: pbo === null ? pboReason : null,
  };
};

const normalizeFolds = (
  value: unknown,
  trialCount: number
): OptimizationFold[] => {
  let previousTest = -1;
  const folds = array(value, "folds", OPTIMIZATION_FOLDS_MAX).map(
    (entry, position) => {
      const field = `folds[${position}]`;
      const row = record(entry, field, [
        "index",
        "train",
        "test",
        "seed",
        "stopReason",
        "trialCount",
        "bestTrialIndex",
        "params",
        "oos",
        "diagnostics",
      ]);
      const index = integer(
        row["index"],
        `${field}.index`,
        0,
        OPTIMIZATION_FOLDS_MAX - 1
      );
      if (index !== position) fail(`${field}.index must equal its position`);
      const train = normalizeWindow(row["train"], `${field}.train`);
      const test = normalizeWindow(row["test"], `${field}.test`);
      if (test.start < train.end)
        fail(`${field}.test must start at or after train ends`);
      if (test.start <= previousTest)
        fail(`${field}.test must start after the previous fold's test`);
      previousTest = test.start;
      const bestTrialIndex = nullableTrialIndex(
        row["bestTrialIndex"],
        `${field}.bestTrialIndex`,
        trialCount
      );
      const params = isSet(row["params"])
        ? normalizeOptimizationParams(row["params"], `${field}.params`)
        : null;
      if ((bestTrialIndex === null) !== (params === null))
        fail(
          `${field}.params and bestTrialIndex must both be set or both be null`
        );
      const fold: OptimizationFold = {
        index,
        train,
        test,
        stopReason: oneOf(
          row["stopReason"],
          `${field}.stopReason`,
          OPTIMIZATION_STOP_REASONS
        ) as OptimizationStopReason,
        trialCount: integer(
          row["trialCount"],
          `${field}.trialCount`,
          0,
          trialCount
        ),
        bestTrialIndex,
        params,
        oos: nullableOosReport(row["oos"], `${field}.oos`, trialCount),
      };
      const seed = nullableInteger(
        row["seed"],
        `${field}.seed`,
        Number.MIN_SAFE_INTEGER,
        Number.MAX_SAFE_INTEGER
      );
      if (seed !== null) fold.seed = seed;
      const diagnostics = normalizeOptimizationDiagnostics(
        row["diagnostics"],
        `${field}.diagnostics`
      );
      if (diagnostics !== null) fold.diagnostics = diagnostics;
      return fold;
    }
  );
  return withinBytes(folds, "folds", OPTIMIZATION_FOLDS_MAX_BYTES);
};

const runMarket = (
  value: unknown,
  field: string,
  markets: readonly string[]
): string => {
  const market = text(value, field, OPTIMIZATION_MARKET_MAX_LENGTH);
  if (!markets.includes(market)) fail(`${field} is not a run market`);
  return market;
};

const normalizeOos = (
  value: unknown,
  mode: OptimizationValidationMode,
  markets: readonly string[],
  trialCount: number
): OptimizationOos | null => {
  if (!isSet(value)) return null;
  const row = record(value, "oos", [
    "mode",
    "inSample",
    "outOfSample",
    "selected",
    "topK",
    "stitchedScore",
    "stitchedMetrics",
    "droppedMarkets",
    "reason",
  ]);
  const oosMode = oneOf(row["mode"], "oos.mode", [
    "is_oos",
    "walk_forward",
  ] as const);
  if (oosMode !== mode) fail("oos.mode must match validation.mode");
  const oos: OptimizationOos = { mode: oosMode };
  if (oosMode === "is_oos") {
    for (const key of [
      "stitchedScore",
      "stitchedMetrics",
      "droppedMarkets",
    ] as const) {
      if (isSet(row[key])) fail(`oos.${key} applies to walk_forward only`);
    }
    if (isSet(row["inSample"]))
      oos.inSample = normalizeWindow(row["inSample"], "oos.inSample");
    if (isSet(row["outOfSample"]))
      oos.outOfSample = normalizeWindow(row["outOfSample"], "oos.outOfSample");
    if (
      oos.inSample !== undefined &&
      oos.outOfSample !== undefined &&
      oos.outOfSample.start < oos.inSample.end
    ) {
      fail("oos.outOfSample must start at or after inSample ends");
    }
    oos.selected = nullableOosReport(
      row["selected"],
      "oos.selected",
      trialCount
    );
    oos.topK = array(row["topK"], "oos.topK", OPTIMIZATION_TOP_K_MAX).map(
      (entry, index) =>
        normalizeOosReport(entry, `oos.topK[${index}]`, trialCount)
    );
  } else {
    for (const key of [
      "inSample",
      "outOfSample",
      "selected",
      "topK",
    ] as const) {
      if (isSet(row[key])) fail(`oos.${key} applies to is_oos only`);
    }
    oos.stitchedScore = nullableFinite(
      row["stitchedScore"],
      "oos.stitchedScore"
    );
    const stitched: Record<string, OptimizationMetricMap> = {};
    if (isSet(row["stitchedMetrics"])) {
      if (!isRecord(row["stitchedMetrics"]))
        fail("oos.stitchedMetrics must be an object");
      for (const [market, metrics] of Object.entries(
        row["stitchedMetrics"] as Record<string, unknown>
      )) {
        runMarket(
          market,
          `oos.stitchedMetrics.${market.slice(0, 40)}`,
          markets
        );
        stitched[market] = normalizeOptimizationMetrics(
          metrics,
          `oos.stitchedMetrics.${market}`
        );
      }
    }
    oos.stitchedMetrics = stitched;
    oos.droppedMarkets = array(
      row["droppedMarkets"],
      "oos.droppedMarkets",
      OPTIMIZATION_MARKETS_MAX
    ).map((entry, index) =>
      runMarket(entry, `oos.droppedMarkets[${index}]`, markets)
    );
  }
  oos.reason = optionalText(
    row["reason"],
    "oos.reason",
    OPTIMIZATION_REASON_MAX_LENGTH
  );
  return withinBytes(oos, "oos", OPTIMIZATION_OOS_MAX_BYTES);
};

const normalizeMarketRanking = (
  value: unknown,
  markets: readonly string[]
): OptimizationMarketRank[] => {
  const seen = new Set<string>();
  return array(value, "marketRanking", OPTIMIZATION_MARKETS_MAX).map(
    (entry, position) => {
      const field = `marketRanking[${position}]`;
      const row = record(entry, field, [
        "rank",
        "market",
        "status",
        "value",
        "reason",
      ]);
      const market = runMarket(row["market"], `${field}.market`, markets);
      if (seen.has(market)) fail(`${field}.market must be unique`);
      seen.add(market);
      const status = trialStatus(row["status"], `${field}.status`);
      const rank = nullableInteger(
        row["rank"],
        `${field}.rank`,
        1,
        OPTIMIZATION_MARKETS_MAX
      );
      const rankValue = nullableFinite(row["value"], `${field}.value`);
      if (status === "ok" && (rank === null || rankValue === null))
        fail(`${field} needs rank and value when ok`);
      if (status === "failed" && (rank !== null || rankValue !== null))
        fail(`${field} must not rank a failed market`);
      const result: OptimizationMarketRank = {
        rank,
        market,
        status,
        value: rankValue,
      };
      const reason = optionalText(
        row["reason"],
        `${field}.reason`,
        OPTIMIZATION_REASON_MAX_LENGTH
      );
      if (reason !== null) result.reason = reason;
      return result;
    }
  );
};

export type OptimizationRunDraft = Readonly<{
  taskId: string;
  strategyId?: string | null;
  method: string;
  objectives: unknown;
  validation: unknown;
  markets: unknown;
  seed?: number | null;
  trialCount: number;
  stopReason: string;
  best?: unknown;
  paretoFront?: unknown;
  trials?: unknown;
  folds?: unknown;
  marketRanking?: unknown;
  oos?: unknown;
  diagnostics?: unknown;
  notes?: string | null;
}>;

export type NormalizedOptimizationRun = Readonly<{
  taskId: string;
  strategyId: string | null;
  method: OptimizationMethod;
  objectives: OptimizationObjective[];
  validation: OptimizationValidation;
  markets: string[];
  seed: number | null;
  trialCount: number;
  stopReason: OptimizationStopReason;
  best: OptimizationBest | null;
  paretoFront: OptimizationParetoPoint[];
  trials: OptimizationTrial[];
  folds: OptimizationFold[];
  marketRanking: OptimizationMarketRank[];
  oos: OptimizationOos | null;
  diagnostics: OptimizationDiagnostics | null;
  notes: string | null;
}>;

export const normalizeOptimizationRun = (
  input: OptimizationRunDraft
): NormalizedOptimizationRun => {
  const method = oneOf(
    input.method,
    "method",
    OPTIMIZATION_METHODS
  ) as OptimizationMethod;
  const objectives = normalizeObjectives(input.objectives);
  if (method === "pareto" && objectives.length < 2)
    fail("pareto runs need at least two objectives");
  if (method !== "pareto" && objectives.length !== 1)
    fail(`${method} runs need exactly one objective`);
  const validation = normalizeValidation(input.validation);
  if (
    (method === "pareto" || method === "market_only") &&
    validation.mode !== "single"
  ) {
    fail(`${method} runs support single validation only`);
  }
  const markets = normalizeMarkets(input.markets);
  const trialCount = integer(
    input.trialCount,
    "trialCount",
    0,
    OPTIMIZATION_TRIAL_COUNT_MAX
  );
  const paretoFront = normalizeParetoFront(
    input.paretoFront,
    objectives,
    trialCount
  );
  if (method !== "pareto" && paretoFront.length > 0)
    fail("paretoFront applies to pareto runs only");
  const best = normalizeBest(input.best, trialCount);
  if (method === "pareto" && best !== null)
    fail("pareto runs report a front, not a best trial");
  const folds = normalizeFolds(input.folds, trialCount);
  if (validation.mode !== "walk_forward" && folds.length > 0)
    fail("folds apply to walk_forward validation only");
  const oos = normalizeOos(input.oos, validation.mode, markets, trialCount);
  const marketRanking = normalizeMarketRanking(input.marketRanking, markets);
  if (method !== "market_only" && marketRanking.length > 0)
    fail("marketRanking applies to market_only runs only");
  return {
    taskId: text(input.taskId, "taskId", 128),
    strategyId: optionalText(input.strategyId, "strategyId", 128),
    method,
    objectives,
    validation,
    markets,
    seed: nullableInteger(
      input.seed,
      "seed",
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER
    ),
    trialCount,
    stopReason: oneOf(
      input.stopReason,
      "stopReason",
      OPTIMIZATION_STOP_REASONS
    ) as OptimizationStopReason,
    best,
    paretoFront,
    trials: normalizeTrials(input.trials, trialCount),
    folds,
    marketRanking,
    oos,
    diagnostics: normalizeOptimizationDiagnostics(
      input.diagnostics,
      "diagnostics"
    ),
    notes: optionalText(input.notes, "notes", OPTIMIZATION_NOTES_MAX_LENGTH),
  };
};
