import type { AgentModelRunOutput } from "./contracts/agent-model-runs.ts";

// CSV export of agent model runs: fixed column order, RFC 4180 quoting (CRLF rows, quotes doubled,
// fields with a comma, quote or line break quoted). A cell that a spreadsheet could read as a
// formula (it starts with =, +, -, @, tab or carriage return, also after leading white space, or
// with a fullwidth = + - @) is prefixed with a single quote.

type Cell = string | number | boolean | Date | null;

const COLUMNS: readonly (readonly [
  string,
  (run: AgentModelRunOutput) => Cell,
])[] = [
  ["id", (run) => run.id],
  ["run_key", (run) => run.runKey],
  ["decision_date", (run) => run.decisionDate],
  ["ticker", (run) => run.ticker],
  ["framework", (run) => run.framework],
  ["framework_version", (run) => run.frameworkVersion],
  ["provider", (run) => run.provider],
  ["model", (run) => run.model],
  [
    "served_models",
    (run) => run.modelsServed.map((entry) => entry.served).join(";"),
  ],
  ["analysts", (run) => run.analysts.join(";")],
  ["rating", (run) => run.rating],
  ["rating_source", (run) => run.ratingSource],
  ["entry_price", (run) => run.entryPrice],
  ["stop_price", (run) => run.stopPrice],
  ["target_price", (run) => run.targetPrice],
  ["horizon", (run) => run.horizon],
  ["horizon_bucket", (run) => run.horizonBucket],
  ["status", (run) => run.status],
  ["error", (run) => run.error],
  ["input_tokens", (run) => run.inputTokens],
  ["output_tokens", (run) => run.outputTokens],
  ["llm_calls", (run) => run.llmCalls],
  ["tool_calls", (run) => run.toolCalls],
  ["cost_usd", (run) => run.costUsd],
  ["duration_ms", (run) => run.durationMs],
  ["flags", (run) => run.flags.join(";")],
  ["batch", (run) => run.batch],
  ["purpose", (run) => run.purpose],
  ["variant", (run) => run.variant],
  ["memory", (run) => run.memory],
  ["data_source", (run) => run.dataSource],
  ["task_id", (run) => run.taskId],
  ["started_at", (run) => run.startedAt],
  ["finished_at", (run) => run.finishedAt],
  ["created_at", (run) => run.createdAt],
  ["updated_at", (run) => run.updatedAt],
];

export const MODEL_RUN_CSV_COLUMNS: readonly string[] = COLUMNS.map(
  ([name]) => name
);

const FORMULA_START = /^\s*[=+\-@\t\r]|^[\uFF1D\uFF0B\uFF0D\uFF20]/u;
const NEEDS_QUOTES = /[",\r\n]/u;

export const csvCell = (value: Cell): string => {
  if (value === null) return "";
  const raw = value instanceof Date ? value.toISOString() : String(value);
  const safe = FORMULA_START.test(raw) ? `'${raw}` : raw;
  return NEEDS_QUOTES.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

export const modelRunsCsv = (runs: readonly AgentModelRunOutput[]): string =>
  [
    MODEL_RUN_CSV_COLUMNS.join(","),
    ...runs.map((run) =>
      COLUMNS.map(([, read]) => csvCell(read(run))).join(",")
    ),
  ]
    .map((line) => `${line}\r\n`)
    .join("");

export const modelRunsCsvFilename = (now: Date): string =>
  `agent-model-runs-${now.toISOString().slice(0, 19).replaceAll(/[-:]/gu, "").replace("T", "-")}.csv`;
