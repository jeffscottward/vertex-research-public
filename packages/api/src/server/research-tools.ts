// Research tool registry for the AI strategy builder flow: saved strategy definitions and forward
// drift status, plus the assistant's confirm policy for the mutating research tools (save a
// definition, run a backtest, run a parameter sweep). The MCP catalogue (mcp.ts) includes these
// tools. Research and backtest use only: every procedure here is a backtestRuns.* research
// procedure. This module and its imports never reach an order, broker or deployment module; a
// guard test (research-tools.test.ts) checks that import graph.
import type { z } from "zod";

import { sweepValueCount } from "../backtest-sweep-grid.ts";
import { BacktestRunSubmitInputSchema } from "../contracts/backtest-runs.ts";
import { BacktestSweepInputSchema } from "../contracts/backtest-sweep.ts";
import {
  type ForwardDriftMonitor,
  ForwardDriftGetInputSchema,
  ForwardDriftListInputSchema,
} from "../contracts/forward-drift.ts";
import {
  StrategyDefinitionGetInputSchema,
  StrategyDefinitionListInputSchema,
  StrategyDefinitionSaveInputSchema,
  StrategyDefinitionValidateInputSchema,
} from "../contracts/strategy-definitions.ts";
import type { McpTool } from "./mcp-tool.ts";

/**
 * New mutating tools that exist only as assistant confirm cards. The external MCP endpoint neither
 * lists nor runs them, so no agent key can write through them without an operator approval.
 */
export const ASSISTANT_ONLY_TOOLS: readonly string[] = Object.freeze([
  "strategy_definition_save",
]);

/** Most grid cells in one assistant-proposed sweep (the API allows 1,000). */
export const ASSISTANT_SWEEP_MAX_CELLS = 100;

/**
 * Assistant tools that change stored data or start compute. The assistant never runs them in a
 * turn: each call becomes a confirm card that runs only after the operator approves it.
 */
export const ASSISTANT_CONFIRM_TOOLS: readonly string[] = Object.freeze([
  "strategy_definition_save",
  "backtest_runs_submit",
  "backtest_runs_sweep",
]);

// Paper series are omitted to keep agent context small; checks, alerts and counts stay. The value
// is the procedure output, already checked against ForwardDriftMonitorSchema.
export const presentDriftMonitor = (value: unknown): unknown => {
  const { points, trades, baseline, ...rest } = value as ForwardDriftMonitor;
  const { equity, ...baselineRest } = baseline;
  return {
    ...rest,
    baseline: baselineRest,
    seriesOmitted: {
      baselineEquityPoints: equity.length,
      points: points.length,
      trades: trades.length,
    },
  };
};

export const RESEARCH_TOOLS: readonly McpTool[] = Object.freeze([
  {
    name: "strategy_definition_validate",
    title: "Validate strategy definition",
    description:
      "Check a version-1 strategy definition (the definition of a backtest_runs_submit dsl rule: name, entry.all conditions and optional entry.any conditions (at least one must hold), exit.any conditions, sizing (riskPct sizing takes an optional maxLeverage 1-50), stopLoss, takeProfit, optional management (breakevenR and an ATR trail that raise the stop), optional session) without storing it. Returns ok true with the definition (defaults applied) and its SHA-256, or ok false with every issue and its dot path.",
    procedure: "backtestRuns/definitions/validate",
    input: StrategyDefinitionValidateInputSchema,
    readOnly: true,
  },
  {
    name: "strategy_definitions_list",
    title: "List strategy definitions",
    description:
      "Saved strategy definitions with the latest revision number, SHA-256, name and time, most recently changed first; optional limit 1-100.",
    procedure: "backtestRuns/definitions/list",
    input: StrategyDefinitionListInputSchema,
    readOnly: true,
  },
  {
    name: "strategy_definitions_get",
    title: "Get strategy definition",
    description:
      "One saved strategy definition: the requested revision (latest when revision is omitted) with the full definition, and the revision history (number, SHA-256, name, note), newest first.",
    procedure: "backtestRuns/definitions/get",
    input: StrategyDefinitionGetInputSchema,
    readOnly: true,
  },
  {
    name: "strategy_definition_save",
    title: "Save strategy definition",
    description:
      "Save a version-1 strategy definition as a revision. Without id it starts a new definition at revision 1; with id it stores the next revision, or returns the latest revision unchanged when the content is equal (created false). Optional note (at most 500 characters). Research only. Needs a write key.",
    procedure: "backtestRuns/definitions/save",
    input: StrategyDefinitionSaveInputSchema,
    readOnly: false,
  },
  {
    name: "drift_status",
    title: "Forward drift status",
    description:
      "Forward drift monitors, newest first (label, level ok|warn|alert|insufficient, baseline run, strategy revision, paper runner status, point and trade counts, thresholds), plus the newest open alerts. Paper data only; optional limit 1-100.",
    procedure: "backtestRuns/drift/list",
    input: ForwardDriftListInputSchema,
    readOnly: true,
  },
  {
    name: "drift_monitor_get",
    title: "Get drift monitor",
    description:
      "One forward drift monitor with its evaluated checks (drawdown, losing streak, profit factor, Sharpe, win rate: forward and baseline values, ratio, level, reason) and alerts. Paper and baseline series are omitted; their counts stay.",
    procedure: "backtestRuns/drift/get",
    input: ForwardDriftGetInputSchema,
    readOnly: true,
    present: presentDriftMonitor,
  },
] as McpTool[]);

type SweepArgs = z.output<typeof BacktestSweepInputSchema>;
type SubmitArgs = z.output<typeof BacktestRunSubmitInputSchema>;

/** Grid cells of a sweep. */
export const sweepCellCount = (args: Pick<SweepArgs, "dimensions">): number =>
  args.dimensions.reduce(
    (cells, dimension) => cells * sweepValueCount(dimension),
    1
  );

/**
 * Why the assistant may not propose this call, or null. `args` already passed the tool's input
 * schema, so they parse again without error.
 */
export const assistantActionProblem = (
  tool: string,
  args: unknown
): string | null => {
  if (tool !== "backtest_runs_sweep") return null;
  const cells = sweepCellCount(BacktestSweepInputSchema.parse(args));
  return cells > ASSISTANT_SWEEP_MAX_CELLS
    ? `An assistant sweep may have at most ${ASSISTANT_SWEEP_MAX_CELLS} cells; this one has ${cells}. Use fewer values or a larger step.`
    : null;
};

const ruleText = (rule: SubmitArgs["rule"] | SweepArgs["rule"]): string =>
  rule.kind === "dsl" ? `definition "${rule.definition.name}"` : rule.kind;

const marketText = (args: SubmitArgs | SweepArgs): string =>
  `${args.symbol} ${args.timeframe}, ${args.from} to ${args.to}`;

/**
 * One-line, human-readable description of a proposed action for its confirm card. `args` already
 * passed the tool's input schema.
 */
export const describeAssistantAction = (
  tool: string,
  args: unknown
): string => {
  if (tool === "strategy_definition_save") {
    const save = StrategyDefinitionSaveInputSchema.parse(args);
    return save.id === undefined
      ? `Save strategy definition "${save.definition.name}" as a new definition (revision 1)`
      : `Save strategy definition "${save.definition.name}" as the next revision of ${save.id}`;
  }
  if (tool === "backtest_runs_submit") {
    const submit = BacktestRunSubmitInputSchema.parse(args);
    return `Run a backtest of ${ruleText(submit.rule)} on ${marketText(submit)}`;
  }
  const sweep = BacktestSweepInputSchema.parse(args);
  const params = sweep.dimensions.map((dimension) => dimension.param);
  return `Run a parameter sweep of ${ruleText(sweep.rule)} on ${marketText(sweep)}: ${params.join(" x ")}, ${sweepCellCount(sweep)} cells, metric ${sweep.metric}`;
};
