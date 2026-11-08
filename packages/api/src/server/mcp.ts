// Model Context Protocol endpoint for agents (Streamable HTTP transport, stateless JSON responses).
// Every tool forwards to an existing oRPC procedure with the caller's agent API key, so the
// procedure's operator check, read/write key access and validation stay the only authority.
// This module holds no credentials and performs no I/O itself; the route injects `call`.
import { z } from "zod";

import {
  AgentOpsSummaryInputSchema,
  AgentTaskAppendEventInputSchema,
  AgentTaskCreateInputSchema,
  AgentTaskGetInputSchema,
  AgentTaskListInputSchema,
  AgentTaskUpdateInputSchema,
  BacktestListInputSchema,
  BacktestRecordInputSchema,
  DeploymentStatusInputSchema,
  PapersAddFromArxivInputSchema,
  PapersAddInputSchema,
  PapersListInputSchema,
  PapersUpdateInputSchema,
} from "../contracts/agent-ops.ts";
import {
  StrategyCreateInputSchema,
  StrategyGetInputSchema,
  StrategyListInputSchema,
  StrategyPresetSaveInputSchema,
  StrategyUpdateInputSchema,
} from "../contracts/strategy-library.ts";
import {
  OptimizationListInputSchema,
  OptimizationRecordInputSchema,
} from "../contracts/optimizations.ts";
import { FlowSnapshotInputSchema } from "../contracts/flow.ts";
import {
  SemanticTermQueryInputSchema,
  SemanticTermsListInputSchema,
} from "../contracts/semantic-terms.ts";
import { MarketBarsInputSchema } from "../contracts/market-data.ts";
import type { OptionsAnalyticsOutput } from "../contracts/options-analytics.ts";
import {
  BacktestRunGetInputSchema,
  BacktestRunListInputSchema,
  BacktestRunSubmitInputSchema,
} from "../contracts/backtest-runs.ts";
import {
  BacktestSweepInputSchema,
  type BacktestSweepOutput,
} from "../contracts/backtest-sweep.ts";
import {
  AgentModelBenchmarkInputSchema,
  AgentModelRunAppendEventsInputSchema,
  AgentModelRunGetInputSchema,
  AgentModelRunListInputSchema,
  AgentModelRunRecordInputSchema,
  AgentModelRunSearchInputSchema,
  AgentModelRunUpdateInputSchema,
} from "../contracts/agent-model-runs.ts";
import type { McpTool } from "./mcp-tool.ts";
import { present } from "./present.ts";
import { ASSISTANT_ONLY_TOOLS, RESEARCH_TOOLS } from "./research-tools.ts";

export const MCP_SERVER_NAME = "vertex-research";
const MCP_SERVER_VERSION = "1.0.0";
export const MCP_PROTOCOL_VERSIONS = [
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
] as const;
const MCP_REQUEST_MAX_BYTES = 1024 * 1024;
const MCP_BATCH_MAX = 20;

export type ProcedureResult =
  | Readonly<{ ok: true; value: unknown }>
  | Readonly<{ ok: false; status: number; code: string; message: string }>;

// Calls one oRPC procedure (slash path such as "agentOps/tasks/list") with the caller's key.
export type CallProcedure = (
  procedure: string,
  input: unknown
) => Promise<ProcedureResult>;

const BacktestGetToolInputSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    includeSeries: z
      .boolean()
      .optional()
      .describe(
        "Include equity, drawdown, trades and benchmark points. Default false."
      ),
  })
  .strict();

// Large series are omitted by default to keep agent context small; analytics stay.
export const presentBacktest = (
  value: unknown,
  includeSeries: boolean
): unknown => {
  if (includeSeries || typeof value !== "object" || value === null)
    return value;
  const output = value as Record<string, unknown>;
  const backtest = output["backtest"];
  if (typeof backtest !== "object" || backtest === null) return value;
  const row = backtest as Record<string, unknown>;
  const { equity, drawdown, trades, benchmark, ...rest } = row;
  return {
    ...output,
    backtest: {
      ...rest,
      seriesOmitted: {
        equityPoints: Array.isArray(equity) ? equity.length : 0,
        drawdownPoints: Array.isArray(drawdown) ? drawdown.length : 0,
        trades: Array.isArray(trades) ? trades.length : 0,
        benchmarkLabel:
          typeof benchmark === "object" && benchmark !== null
            ? ((benchmark as Record<string, unknown>)["label"] ?? null)
            : null,
      },
    },
  };
};

const OptimizationGetToolInputSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    includeTrials: z
      .boolean()
      .optional()
      .describe("Include every stored trial row. Default false."),
  })
  .strict();

// Trial rows are omitted by default to keep agent context small; analytics, best, folds and the
// Pareto front stay.
export const presentOptimization = (
  value: unknown,
  includeTrials: boolean
): unknown => {
  if (includeTrials || typeof value !== "object" || value === null)
    return value;
  const output = value as Record<string, unknown>;
  const optimization = output["optimization"];
  if (typeof optimization !== "object" || optimization === null) return value;
  const { trials, ...rest } = optimization as Record<string, unknown>;
  return {
    ...output,
    optimization: {
      ...rest,
      trialsOmitted: { stored: Array.isArray(trials) ? trials.length : 0 },
    },
  };
};

const MarketBarsToolInputSchema = MarketBarsInputSchema.safeExtend({
  lastBars: z
    .number()
    .int()
    .min(1)
    .max(5000)
    .optional()
    .describe(
      "Return only the most recent N bars (count stays the full total). Default 500."
    ),
});

// Bars beyond the most recent N are dropped to keep agent context small; count and metadata stay.
export const presentMarketBars = (
  value: unknown,
  lastBars: number
): unknown => {
  if (typeof value !== "object" || value === null) return value;
  const output = value as Record<string, unknown>;
  const bars = output["bars"];
  if (!Array.isArray(bars) || bars.length <= lastBars) return value;
  return {
    ...output,
    bars: bars.slice(-lastBars),
    barsOmitted: bars.length - lastBars,
  };
};

const OptionsGexContextToolInputSchema = z
  .object({
    symbol: z
      .string()
      .trim()
      .min(1)
      .max(15)
      .describe("US stock or ETF symbol, e.g. AAPL or SPY."),
    flowHours: z
      .union([z.literal(1), z.literal(6), z.literal(24), z.literal(72)])
      .optional()
      .describe("Option-flow window in hours: 1, 6, 24 or 72. Default 24."),
  })
  .strict();

// The IV surface, skew, per-strike rows (strikeCount says how many) and flow events are dropped; the GEX headline, its
// context (levels, dealer Greeks, flow bias, freshness, expiry, IV regime, session, events,
// caveat factors) and the data notes stay.
export const presentGexContext = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return value;
  const output = value as OptionsAnalyticsOutput;
  if (
    typeof output.exposure !== "object" ||
    output.exposure === null ||
    typeof output.flow !== "object" ||
    output.flow === null
  )
    return value;
  return {
    context: output.context,
    exposure: {
      gexExpiry: output.exposure.gexExpiry,
      maxPain: output.exposure.maxPain,
      message: output.exposure.message,
      status: output.exposure.status,
      strikeCount: output.exposure.strikes.length,
      totalGex: output.exposure.totalGex,
    },
    flowStatus: output.flow.status,
    notes: output.notes,
    rateLimited: output.rateLimited,
    receivedAt: output.receivedAt,
    retryAfterSeconds: output.retryAfterSeconds,
    source: output.source,
    spot: output.spot,
    symbol: output.symbol,
  };
};

const BacktestSweepToolInputSchema = BacktestSweepInputSchema.safeExtend({
  includeCells: z
    .boolean()
    .optional()
    .describe("Return every grid cell. Default false (top 20 only)."),
});

const MCP_SWEEP_TOP = 20;

// The full grid can hold 1,000 cells; agents get the best-ranked cells and the spike list.
export const presentSweep = (
  value: unknown,
  includeCells: boolean
): unknown => {
  if (includeCells || typeof value !== "object" || value === null) return value;
  const { cells, ...rest } = value as BacktestSweepOutput;
  return {
    ...rest,
    cellsOmitted: cells.length,
    spikes: cells.flatMap((cell, index) =>
      cell.robustness.spike ? [index] : []
    ),
    top: rest.ranking
      .slice(0, MCP_SWEEP_TOP)
      .map((index) => ({ index, ...cells[index] })),
  };
};

export const MCP_TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "summary",
    title: "Ledger summary",
    description:
      "Counts of agent tasks by status, papers by stage, needs-review/running/recent tasks and latest events.",
    procedure: "agentOps/summary",
    input: AgentOpsSummaryInputSchema,
    readOnly: true,
  },
  {
    name: "tasks_list",
    title: "List tasks",
    description: "List agent tasks, optionally filtered by status or kind.",
    procedure: "agentOps/tasks/list",
    input: AgentTaskListInputSchema,
    readOnly: true,
  },
  {
    name: "tasks_get",
    title: "Get task",
    description: "One agent task with its event log.",
    procedure: "agentOps/tasks/get",
    input: AgentTaskGetInputSchema,
    readOnly: true,
  },
  {
    name: "tasks_create",
    title: "Create task",
    description:
      "Create an agent task (kind, agent, title, optional status, metrics, links, paperId). Needs a write key.",
    procedure: "agentOps/tasks/create",
    input: AgentTaskCreateInputSchema,
    readOnly: false,
  },
  {
    name: "tasks_update",
    title: "Update task",
    description:
      "Update a task's status, title, summary, metrics or links. Needs a write key.",
    procedure: "agentOps/tasks/update",
    input: AgentTaskUpdateInputSchema,
    readOnly: false,
  },
  {
    name: "tasks_append_event",
    title: "Append task event",
    description:
      "Append a log event (level, message) to a task. Needs a write key.",
    procedure: "agentOps/tasks/appendEvent",
    input: AgentTaskAppendEventInputSchema,
    readOnly: false,
  },
  {
    name: "papers_list",
    title: "List papers",
    description:
      "Research papers with stage, verdict, blockers and reported vs reproduced metrics.",
    procedure: "papers/list",
    input: PapersListInputSchema,
    readOnly: true,
  },
  {
    name: "papers_add",
    title: "Add paper",
    description:
      "Add a paper manually (title, source URL, identifier, authors, year). Needs a write key.",
    procedure: "papers/add",
    input: PapersAddInputSchema,
    readOnly: false,
  },
  {
    name: "papers_add_from_arxiv",
    title: "Add paper from arXiv",
    description:
      "Add a paper by arXiv id or URL; metadata comes from the official arXiv API. Needs a write key.",
    procedure: "papers/addFromArxiv",
    input: PapersAddFromArxivInputSchema,
    readOnly: false,
  },
  {
    name: "papers_update",
    title: "Update paper",
    description:
      "Update a paper's stage, verdict, blockers, notes or metrics. Needs a write key.",
    procedure: "papers/update",
    input: PapersUpdateInputSchema,
    readOnly: false,
  },
  {
    name: "backtests_list",
    title: "List backtests",
    description:
      "Backtest results without series: strategy, period, reported metrics, derived max drawdown, trade count.",
    procedure: "agentOps/backtests/list",
    input: BacktestListInputSchema,
    readOnly: true,
  },
  {
    name: "backtests_get",
    title: "Get backtest",
    description:
      "One backtest with server-derived analytics (returns, trades, drawdown periods, monthly returns, regimes, bootstrap intervals, Monte Carlo, benchmark). Series are omitted unless includeSeries is true.",
    procedure: "agentOps/backtests/get",
    input: BacktestGetToolInputSchema,
    readOnly: true,
    prepare: (args) => ({ id: args["id"] }),
    present: (value, args) =>
      presentBacktest(value, args["includeSeries"] === true),
  },
  {
    name: "backtests_record",
    title: "Record backtest",
    description:
      "Record an agent-reported backtest (equity, trades, folds, IS/OOS split, run config, benchmark) against a task; optional strategyId links it to a strategy library row. Optional ratingSeries {symbol, costBps (default 10), decisions: 2-520 {date YYYY-MM-DD strictly increasing, rating buy|overweight|hold|underweight|sell or null for a failed run, runId}} is replayed on stored daily bars against buy and hold, a 50/200-day MA rule and a shuffled-rating placebo. Ratings are research labels only and never place orders. Needs a write key.",
    procedure: "agentOps/backtests/record",
    input: BacktestRecordInputSchema,
    readOnly: false,
  },
  {
    name: "backtest_runs_submit",
    title: "Run backtest",
    description:
      "Queue a backtest of a long-only rule (smaCross fast/slow, breakout entryLookback/exitLookback/trendSma, or dsl with a version-1 strategy definition that carries its own stop, target and sizing) over stored bars for symbol, timeframe 1d|1m and a from/to date range, with optional stopLossPct, takeProfitPct, costBps, initialCapital and strategyId (ties the run to a SHA-256 revision of that strategy). A definition may read daily series (ivRank, vixTermStructure, volRegime and series filters, series expressions): the run loads them from the series store and fails when one is missing. A definition with an options block runs in the options runner on 1d only, with costBps 0, no costProfile, stopLossPct and takeProfitPct 0 and a symbol from portfolio.symbols (else one of SPY, QQQ, DIA, IWM, GLD, SLV, USO); its report adds the options book result. Returns the run; poll backtest_runs_get until it succeeds or fails. Research only, no orders. Needs a write key.",
    procedure: "backtestRuns/submit",
    input: BacktestRunSubmitInputSchema,
    readOnly: false,
  },
  {
    name: "backtest_runs_get",
    title: "Get backtest run",
    description:
      "One backtest run: status (queued, running, succeeded, failed), spec, strategy revision and, when succeeded, the report: metrics (net profit, gross profit/loss, profit factor, expected payoff, absolute and max drawdown in money and percent, Sharpe, Sortino, win rate, consecutive wins/losses), equity and drawdown series, price series and the trade list.",
    procedure: "backtestRuns/get",
    input: BacktestRunGetInputSchema,
    readOnly: true,
  },
  {
    name: "backtest_runs_list",
    title: "List backtest runs",
    description:
      "Backtest runs newest first without reports; optional strategyId filter and limit (1-100).",
    procedure: "backtestRuns/list",
    input: BacktestRunListInputSchema,
    readOnly: true,
  },
  {
    name: "backtest_runs_sweep",
    title: "Parameter sweep",
    description:
      "Run a grid of backtests over stored bars and rank each cell by robustness. Same rule, symbol, timeframe, from/to, stopLossPct, takeProfitPct and costBps as backtest_runs_submit, plus 1-4 dimensions {param, from, to, step} (param: fast|slow for smaCross; entryLookback|exitLookback|trendSma for breakout; stopLossPct|takeProfitPct for both; at most 50 values each and 1,000 cells; cells x bars at most 20,000,000) and metric (totalReturn|cagr|sharpe|sortino|profitFactor|winRate|maxDrawdown, default totalReturn). Each cell's robust score (worst) is the lowest metric value over the cell and its neighbours (one step in one parameter); spike = neighbour mean below 50% of a positive cell value. By default returns the 20 best-ranked cells (top), spike cell indexes and the full ranking; includeCells returns every cell. Nothing is stored. Research only, no orders.",
    procedure: "backtestRuns/sweep",
    input: BacktestSweepToolInputSchema,
    readOnly: true,
    prepare: (args) => {
      const { includeCells: _includeCells, ...rest } = args;
      return rest;
    },
    present: (value, args) =>
      presentSweep(value, args["includeCells"] === true),
  },
  {
    name: "deployment_status",
    title: "Deployment status",
    description:
      "Read-only QuantVPS trading-stack status: container services, plus session, positions, orders, fills, equity, risk (kill switch, limits, watchdog) and WARNING/ERROR logs when the tailnet snapshot is configured. Unavailable blocks carry a reason; snapshotError explains a v1 fallback. Its equity, positions and P&L belong to the exec-node account named in session.trading_mode (paper), not to the owner's IBKR account: for net liquidation, account P&L, positions or open risk use terms_query.",
    procedure: "agentOps/deployment/status",
    input: DeploymentStatusInputSchema,
    readOnly: true,
  },
  {
    name: "market_bars",
    title: "Market bars",
    description:
      "Read-only IBKR historical OHLCV bars from the QuantVPS history service (IB Gateway, client id 77): symbol, secType STK|FUT|CONTFUT, exchange (SMART for stocks; required for futures, e.g. CME), currency, barSize (1 min to 1 day), duration (daily <= 1 Y, intraday <= 1 M, 1 min <= 2 D), whatToShow TRADES|MIDPOINT, useRTH. Bars are {t epoch seconds UTC, o, h, l, c, v}; includes contract, asOf, fetchedAt and cache age. The service paces IBKR requests; PACED errors say when to retry.",
    procedure: "marketData/bars",
    input: MarketBarsToolInputSchema,
    readOnly: true,
    prepare: (args) => {
      const { lastBars: _lastBars, ...rest } = args;
      return rest;
    },
    present: (value, args) =>
      presentMarketBars(
        value,
        typeof args["lastBars"] === "number" ? args["lastBars"] : 500
      ),
  },
  {
    name: "options_gex_context",
    title: "Options GEX context",
    description:
      "Read-only estimated GEX for one US stock symbol (QuantData) and the context to read before trusting it: regime, gamma flip and call/put walls with distance in one-day implied moves, open-interest delta (DEX, holders' side), estimated dealer vanna and charm, flow bias (bullish vs bearish premium), OI freshness (previous session), expiry mix, IV term regime, New York session, next monthly OpEx and plain-text caveat factors. GEX, level, vanna and charm signs assume dealers long calls, short puts. Research only; not a trade signal.",
    procedure: "optionsAnalytics/snapshot",
    input: OptionsGexContextToolInputSchema,
    readOnly: true,
    present: (value) => presentGexContext(value),
  },
  {
    name: "terms_list",
    title: "List certified terms",
    description:
      "The certified business terms of the semantic layer: id, definition, synonyms, source (postgres, feed or none), unit, parameters and certified flag. Call it before terms_query when you are not sure which term fits.",
    procedure: "semanticTerms/list",
    input: SemanticTermsListInputSchema,
    readOnly: true,
  },
  {
    name: "terms_query",
    title: "Query a certified term",
    description:
      "Answer one certified term: { term, params }. Returns status (ok, unknown or not_available), answer, rows, the SQL or feed path that produced them (query), source, unit and asOf. Account terms (net_liquidation, pnl, position, open_risk) read the owner's live IBKR account (vertex-portfolio feed), never the paper exec node. status unknown or not_available means: give no value.",
    procedure: "semanticTerms/query",
    input: SemanticTermQueryInputSchema,
    readOnly: true,
  },
  {
    name: "flow_snapshot",
    title: "Order flow + options flow snapshot",
    description:
      "Read-only flow pipeline view for SPY or ES (minutes 15-390, default 120): per-minute sampled order flow (delta, CVD, VWAP, covered seconds), book pressure, QuantData options flow (call/put, bullish/bearish, ask/bid-side, sweep/block, OTM, 0DTE, opening, vol > OI premium and the largest prints), the newest GEX snapshot (ES uses SPX levels shifted by the ES - SPX basis), derived events (large and off-exchange prints, absorption, stacked imbalances, option sweeps/blocks), a confluence reading (agree/disagree) and per-source freshness. Ticks are sampled, not streamed. Research only; not a trade signal.",
    procedure: "flow/snapshot",
    input: FlowSnapshotInputSchema,
    readOnly: true,
  },
  {
    name: "strategies_list",
    title: "List strategies",
    description:
      "Strategy library rows with status, tags, section, params and the latest linked backtest's server-derived Sharpe and return. Filters: search, status, favorite, section (null = unsorted); sort: updated, name, sharpe, return.",
    procedure: "strategyLibrary/list",
    input: StrategyListInputSchema,
    readOnly: true,
  },
  {
    name: "strategies_get",
    title: "Get strategy",
    description:
      "One strategy with its params schema, presets and linked backtest summaries.",
    procedure: "strategyLibrary/get",
    input: StrategyGetInputSchema,
    readOnly: true,
  },
  {
    name: "strategies_create",
    title: "Create strategy",
    description:
      "Create a strategy (name, kind python|native|external, optional description, status, sourceRef repo path[@revision], tags, section, params). Needs a write key.",
    procedure: "strategyLibrary/create",
    input: StrategyCreateInputSchema,
    readOnly: false,
  },
  {
    name: "strategies_update",
    title: "Update strategy",
    description:
      "Update a strategy's name, description, status, sourceRef, tags, favorite, section or params schema (integer, decimal, boolean, choice). Needs a write key.",
    procedure: "strategyLibrary/update",
    input: StrategyUpdateInputSchema,
    readOnly: false,
  },
  {
    name: "strategy_presets_save",
    title: "Save strategy preset",
    description:
      "Create or replace a named preset; values are checked against the strategy's params schema. Needs a write key.",
    procedure: "strategyLibrary/presets/save",
    input: StrategyPresetSaveInputSchema,
    readOnly: false,
  },
  {
    name: "optimizations_list",
    title: "List optimizations",
    description:
      "Optimizer runs without trials: strategy, method, objectives, validation mode, markets, trial count, stop reason, best params and score, DSR and PBO diagnostics. Filters: taskId, strategyId.",
    procedure: "agentOps/optimizations/list",
    input: OptimizationListInputSchema,
    readOnly: true,
  },
  {
    name: "optimizations_get",
    title: "Get optimization",
    description:
      "One optimizer run with best params, OOS report, walk-forward folds, Pareto front, diagnostics and server-derived parameter importance, 1-D score profiles and a 2-D heatmap. Trial rows are omitted unless includeTrials is true.",
    procedure: "agentOps/optimizations/get",
    input: OptimizationGetToolInputSchema,
    readOnly: true,
    prepare: (args) => ({ id: args["id"] }),
    present: (value, args) =>
      presentOptimization(value, args["includeTrials"] === true),
  },
  {
    name: "optimizations_record",
    title: "Record optimization",
    description:
      "Record an optimizer run (services/research/backtesting/optimizer.py OptimizationResult.to_dict() mapped to camelCase: method, objectives, validation {mode, params}, markets, seed, trialCount, stopReason, best, trials, paretoFront, folds, oos, marketRanking, diagnostics) against a task; optional strategyId. Needs a write key.",
    procedure: "agentOps/optimizations/record",
    input: OptimizationRecordInputSchema,
    readOnly: false,
  },
  {
    name: "model_runs_list",
    title: "List model runs",
    description:
      "Agent model runs (framework, provider/model, ticker, decision date, research rating, levels, usage, status, flags), newest decision first, with facet counts. Filter by framework, provider, model, servedModel, ticker, rating (or unrated), status, flags, purpose, variant, horizonBucket, batch and decisionFrom/To; page with nextCursor.",
    procedure: "agentModelRuns/list",
    input: AgentModelRunListInputSchema,
    readOnly: true,
  },
  {
    name: "model_runs_get",
    title: "Get model run",
    description:
      "One agent model run by id with its first 500 events (seq order), nextSeq and done.",
    procedure: "agentModelRuns/get",
    input: AgentModelRunGetInputSchema,
    readOnly: true,
  },
  {
    name: "model_runs_search",
    title: "Search model runs",
    description:
      "Full-text search over run event text (titles and bodies). Returns up to 50 runs with up to 3 highlighted snippets each; the list filters apply.",
    procedure: "agentModelRuns/search",
    input: AgentModelRunSearchInputSchema,
    readOnly: true,
  },
  {
    name: "model_runs_benchmark",
    title: "Benchmark model runs",
    description:
      "Compare arms of runs (armBy model, servedModel, provider_model, framework or variant) on shared (ticker, decision date) cells: coverage, rating mix, rerun agreement, agreement with a baseline arm, a pairwise agreement matrix and, with pair {control, treatment}, directional hits on the 5-day forward return with an exact sign test. The list filters apply (at most 5000 runs). Research labels only.",
    procedure: "agentModelRuns/benchmark",
    input: AgentModelBenchmarkInputSchema,
    readOnly: true,
  },
  {
    name: "model_runs_record",
    title: "Record model run",
    description:
      "Record one framework run on one ticker and decision date (runKey makes it idempotent: a repeated key returns the first run unchanged). The rating and levels are research labels only; they never place or size an order. Never include API keys or secrets. Needs a write key.",
    procedure: "agentModelRuns/record",
    input: AgentModelRunRecordInputSchema,
    readOnly: false,
  },
  {
    name: "model_runs_update",
    title: "Update model run",
    description:
      "Report a run's status, error, rating, levels, horizon, usage totals, cost, flags or served models. A terminal status (succeeded, failed, cancelled) is final. Needs a write key.",
    procedure: "agentModelRuns/update",
    input: AgentModelRunUpdateInputSchema,
    readOnly: false,
  },
  {
    name: "model_runs_append_events",
    title: "Append model run events",
    description:
      "Append up to 200 events to a run (seq, agent, kind llm_call|tool_call|tool_result|reasoning|message|decision|status|flag, title, optional body up to 16000 characters, model, toolName, tokens, cost, duration). An existing seq is kept as it was. A flag event (title = slug) also adds the slug to the run's flags. Plain text only; text with secrets is refused. Needs a write key.",
    procedure: "agentModelRuns/appendEvents",
    input: AgentModelRunAppendEventsInputSchema,
    readOnly: false,
  },
  ...RESEARCH_TOOLS,
] as McpTool[]);

const toolByName = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));

const inputSchemaOf = (tool: McpTool): Record<string, unknown> => {
  const schema = z.toJSONSchema(tool.input, {
    io: "input",
    unrepresentable: "any",
  }) as Record<string, unknown>;
  const { $schema: _ignored, ...rest } = schema;
  return rest["type"] === "object" ? rest : { type: "object", properties: {} };
};

export const listMcpTools = (): Record<string, unknown>[] => {
  return MCP_TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: inputSchemaOf(tool),
    annotations: {
      title: tool.title,
      readOnlyHint: tool.readOnly,
      destructiveHint: false,
      idempotentHint: tool.readOnly,
      openWorldHint: false,
    },
  }));
};

// ---------------------------------------------------------------------------
// JSON-RPC 2.0

type JsonRpcId = string | number | null;
type JsonRpcResponse = Record<string, unknown>;

const rpcError = (
  id: JsonRpcId,
  code: number,
  message: string
): JsonRpcResponse => {
  return { jsonrpc: "2.0", id, error: { code, message } };
};

const rpcResult = (id: JsonRpcId, result: unknown): JsonRpcResponse => {
  return { jsonrpc: "2.0", id, result };
};

const toolText = (
  value: unknown,
  isError: boolean
): Record<string, unknown> => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const result: Record<string, unknown> = {
    content: [{ type: "text", text }],
    isError,
  };
  if (
    !isError &&
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  )
    result["structuredContent"] = value;
  return result;
};

export const callMcpTool = async (
  name: unknown,
  args: unknown,
  call: CallProcedure
): Promise<Record<string, unknown>> => {
  const tool = typeof name === "string" ? toolByName.get(name) : undefined;
  if (tool === undefined)
    return toolText(`Unknown tool: ${String(name).slice(0, 80)}`, true);
  const parsed = tool.input.safeParse(args ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 10)
      .map((issue) => `${issue.path.join(".") || "(input)"}: ${issue.message}`);
    return toolText(
      `Invalid arguments for ${tool.name}: ${issues.join("; ")}`,
      true
    );
  }
  const rawArgs = (
    typeof args === "object" && args !== null ? args : {}
  ) as Record<string, unknown>;
  const input =
    tool.prepare === undefined ? (args ?? {}) : tool.prepare(rawArgs);
  const result = await call(tool.procedure, input);
  if (!result.ok)
    return toolText(
      `${result.code} (${result.status}): ${result.message}`,
      true
    );
  return toolText(
    tool.present === undefined
      ? result.value
      : tool.present(result.value, rawArgs),
    false
  );
};

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

export const handleMcpMessage = async (
  message: unknown,
  call: CallProcedure
): Promise<JsonRpcResponse | null> => {
  if (
    !isRecord(message) ||
    message["jsonrpc"] !== "2.0" ||
    typeof message["method"] !== "string"
  ) {
    return rpcError(null, -32_600, "Invalid Request");
  }
  const hasId = Object.hasOwn(message, "id");
  const id = hasId ? (message["id"] as JsonRpcId) : null;
  if (
    hasId &&
    id !== null &&
    typeof id !== "string" &&
    typeof id !== "number"
  ) {
    return rpcError(null, -32_600, "Invalid Request");
  }
  const method = message["method"] as string;
  // Notifications (no id) never get a response body.
  if (!hasId) {
    return null;
  }
  const params = isRecord(message["params"]) ? message["params"] : {};
  switch (method) {
    case "initialize": {
      const requested = params["protocolVersion"];
      const version = (MCP_PROTOCOL_VERSIONS as readonly unknown[]).includes(
        requested
      )
        ? requested
        : MCP_PROTOCOL_VERSIONS[0];
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: {
          name: MCP_SERVER_NAME,
          title: "Vertex Research",
          version: MCP_SERVER_VERSION,
        },
        instructions:
          "Vertex Research agent ledger: tasks, papers, backtests, optimizer runs, the strategy library and read-only deployment status. Read keys can only list and get. Backtest and optimizer values are agent-reported; analytics are derived by the server.",
      });
    }
    case "ping": {
      return rpcResult(id, {});
    }
    case "tools/list": {
      return rpcResult(id, {
        tools: listMcpTools().filter(
          (tool) => !ASSISTANT_ONLY_TOOLS.includes(tool["name"] as string)
        ),
      });
    }
    case "tools/call": {
      const name = params["name"];
      if (typeof name === "string" && ASSISTANT_ONLY_TOOLS.includes(name))
        return rpcResult(
          id,
          toolText(
            `Tool ${name} needs a confirm card in the Vertex assistant; it is not available on the MCP endpoint`,
            true
          )
        );
      return rpcResult(id, await callMcpTool(name, params["arguments"], call));
    }
    default: {
      return rpcError(id, -32_601, `Method not found: ${method.slice(0, 80)}`);
    }
  }
};

// ---------------------------------------------------------------------------
// HTTP

export type McpHttpOptions = Readonly<{
  appOrigin: string;
  // Builds a procedure caller bound to the presented agent API key.
  callerFor: (apiKey: string) => CallProcedure;
}>;

const json = (
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response => {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...headers,
    },
  });
};

export const presentedApiKey = (headers: Headers): string | null => {
  const direct = headers.get("x-api-key")?.trim() ?? "";
  if (direct.length > 0) return direct;
  const authorization = headers.get("authorization")?.trim() ?? "";
  const match = /^Bearer\s+(\S+)$/iu.exec(authorization);
  return match === null ? null : present(match[1]);
};

export const handleMcpHttp = async (
  request: Request,
  options: McpHttpOptions
): Promise<Response> => {
  if (request.method !== "POST") {
    return json(405, rpcError(null, -32_000, "Method not allowed; use POST"), {
      allow: "POST",
    });
  }
  // DNS-rebinding guard: a browser-sent Origin must be this app.
  const origin = request.headers.get("origin");
  if (origin !== null && origin !== options.appOrigin) {
    return json(403, rpcError(null, -32_000, "Origin not allowed"));
  }
  const apiKey = presentedApiKey(request.headers);
  if (apiKey === null) {
    return json(
      401,
      rpcError(
        null,
        -32_001,
        "Agent API key required (x-api-key or Authorization: Bearer)"
      ),
      { "www-authenticate": 'Bearer realm="vertex-research"' }
    );
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MCP_REQUEST_MAX_BYTES) {
    return json(413, rpcError(null, -32_000, "Request too large"));
  }
  const text = await request.text();
  if (text.length > MCP_REQUEST_MAX_BYTES) {
    return json(413, rpcError(null, -32_000, "Request too large"));
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return json(400, rpcError(null, -32_700, "Parse error"));
  }
  const call = options.callerFor(apiKey);
  if (Array.isArray(body)) {
    if (body.length === 0 || body.length > MCP_BATCH_MAX)
      return json(400, rpcError(null, -32_600, "Invalid Request"));
    const responses = (
      await Promise.all(body.map((message) => handleMcpMessage(message, call)))
    ).filter((entry) => entry !== null);
    return responses.length === 0
      ? new Response(null, { status: 202 })
      : json(200, responses);
  }
  const response = await handleMcpMessage(body, call);
  return response === null
    ? new Response(null, { status: 202 })
    : json(200, response);
};

// Parses an oRPC RPC-protocol response ({ json, meta }) into a ProcedureResult.
export const procedureResultFromResponse = async (
  response: Response
): Promise<ProcedureResult> => {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const payload = isRecord(body) ? body["json"] : undefined;
  if (response.ok) return { ok: true, value: payload ?? null };
  const error = isRecord(payload) ? payload : {};
  return {
    ok: false,
    status:
      typeof error["status"] === "number" ? error["status"] : response.status,
    code: typeof error["code"] === "string" ? error["code"] : "ERROR",
    message:
      typeof error["message"] === "string"
        ? error["message"]
        : `HTTP ${response.status}`,
  };
};
