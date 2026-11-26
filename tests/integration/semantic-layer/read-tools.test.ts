import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ASSISTANT_CHART_TOOLS } from "../../../packages/api/src/server/assistant-chart-tools.ts";
import {
  ASSISTANT_TOOL_RESULT_MAX_CHARS,
  assistantToolsFor,
} from "../../../packages/api/src/server/assistant-runtime.ts";
import {
  callMcpTool,
  MCP_TOOLS,
} from "../../../packages/api/src/server/mcp.ts";
import { type EvalBackend, startEvalBackend } from "./harness.ts";

// Calls every read tool that the Plan-mode assistant has, once, on the eval backend (fixture.sql and the
// synthetic feeds). The recorded eval only proves the tools that a recorded trial calls; a tool that no
// trial calls could answer a server error on the fixture and no test would show it. Each tool must answer
// exactly what READ_TOOL_CALLS says: a result, or the refusal that the eval backend gives by its setup.
// Limit: a tool with a refusal in the table is proven to refuse, not to return a result.

type Answer =
  /** The tool returns a result. */
  | "ok"
  /**
   * The tool reads an outside service. startEvalBackend passes no configuration for it to
   * createApiContext, which reads no environment variable, so the tool refuses on every machine.
   */
  | "NOT_CONFIGURED (503)";

type ReadToolCall = Readonly<{ args: unknown; answer: Answer }>;

const ok = (args: unknown = {}): ReadToolCall => ({ answer: "ok", args });

/** One call for every read tool of the Plan-mode assistant; the ids are rows of fixture.sql or seeds. */
const READ_TOOL_CALLS: Readonly<Record<string, ReadToolCall>> = {
  backtest_runs_get: ok({ id: "br_vix_1" }),
  backtest_runs_list: ok(),
  backtests_get: ok({ id: "bt_mom_nb" }),
  backtests_list: ok(),
  deployment_status: ok(),
  drift_monitor_get: ok({ id: "m_orb" }),
  drift_status: ok(),
  flow_control: ok({ group: "sp500" }),
  flow_snapshot: ok({ symbol: "SPY" }),
  market_bars: { answer: "NOT_CONFIGURED (503)", args: { symbol: "SPY" } },
  // The eval backend answers master_rules_search only for a search frozen in master-rules.fixture.json.
  master_rules_search: ok({
    limit: 5,
    query: "short-dated options premium cap 2% of NLV",
  }),
  model_runs_benchmark: ok({ armBy: "model" }),
  model_runs_get: ok({ id: "mr_nvda_1" }),
  model_runs_list: ok(),
  model_runs_search: ok({ query: "support" }),
  openbb_13f_changes: ok(),
  openbb_congress_trades: ok(),
  openbb_insider_clusters: ok(),
  openbb_sec: ok({ symbol: "NVDA" }),
  openbb_shorts: ok({ symbol: "NVDA" }),
  openbb_smart_money_ranking: ok(),
  openbb_status: ok(),
  optimizations_get: ok({ id: "opt_orb_1" }),
  optimizations_list: ok(),
  options_gex_context: {
    answer: "NOT_CONFIGURED (503)",
    args: { symbol: "SPY" },
  },
  papers_list: ok(),
  strategies_get: ok({ id: "strategy-seed-volume-spike-breakout" }),
  strategies_list: ok(),
  strategy_definition_validate: ok({ definition: {} }),
  strategy_definitions_get: ok({ id: "qc-asset-class-trend" }),
  strategy_definitions_list: ok(),
  summary: ok(),
  tasks_get: ok({ id: "t_bt_2" }),
  tasks_list: ok(),
  terms_list: ok(),
  terms_query: ok({ term: "net_liquidation" }),
};

/** Parameters for the terms that refuse a query without one (terms_list marks them `required`). */
const REQUIRED_TERM_PARAMS: Readonly<Record<string, unknown>> = {
  position: { symbol: "NVDA" },
  short_volume: { symbol: "NVDA" },
};

/**
 * The terms that give a value on the eval backend (certified, with a source), sorted. Every other term
 * of terms_list answers "not_available". A term that loses its certification on the eval database
 * would agree with terms_list and pass the status rule below; this list makes the test fail for it.
 */
const ANSWERING_TERMS: readonly string[] = [
  "backtest_max_drawdown",
  "backtest_sharpe",
  "congress_trades",
  "deployment_request",
  "drift_level",
  "insider_cluster_buys",
  "institutional_13f_changes",
  "large_options_premium_ranking",
  "net_liquidation",
  "open_risk",
  "pnl",
  "position",
  "short_volume",
  "strategy_gate_pass",
];

const catalogue = new Set(MCP_TOOLS.map((tool) => tool.name));
const planTools = assistantToolsFor("plan").map((tool) => tool.function.name);
/** The Plan-mode tools that call the API. */
const planReadTools = planTools.filter((name) => catalogue.has(name)).sort();

let backend: EvalBackend;

const call = async (
  name: string,
  args: unknown
): Promise<Readonly<{ failed: boolean; text: string }>> => {
  const result = await callMcpTool(name, args, backend.callProcedure);
  const [content] = result["content"] as readonly Readonly<{ text: string }>[];
  return { failed: result["isError"] === true, text: content?.text ?? "" };
};

describe("read tools on the eval backend", () => {
  beforeAll(async () => {
    backend = await startEvalBackend();
  }, 120_000);

  afterAll(async () => {
    await backend.close();
  });

  it("has one call for every read tool of the Plan-mode assistant", () => {
    expect(Object.keys(READ_TOOL_CALLS).sort()).toEqual(planReadTools);
    // Every other Plan-mode tool is a chart tool: it runs inside the turn and calls no API.
    expect(planTools.filter((name) => !catalogue.has(name)).sort()).toEqual(
      ASSISTANT_CHART_TOOLS.map((tool) => tool.name).sort()
    );
  });

  it.each(Object.entries(READ_TOOL_CALLS))(
    "%s answers as listed",
    async (name, { answer, args }) => {
      const { failed, text } = await call(name, args);
      if (answer === "ok") {
        // The error text shows in the failure message.
        expect(failed ? text : "ok").toBe("ok");
      } else {
        expect(failed).toBe(true);
        expect(text.startsWith(`${answer}: `), text).toBe(true);
      }
    }
  );

  it("keeps every certified term of terms_list inside the cut of an assistant tool result", async () => {
    const result = await callMcpTool("terms_list", {}, backend.callProcedure);
    const [content] = result["content"] as readonly Readonly<{
      text: string;
    }>[];
    const { terms } = result["structuredContent"] as Readonly<{
      terms: readonly Readonly<{ certified: boolean; id: string }>[];
    }>;
    const seen = content?.text.slice(0, ASSISTANT_TOOL_RESULT_MAX_CHARS) ?? "";
    expect(
      terms
        .filter((term) => term.certified)
        .filter((term) => !seen.includes(`"id":"${term.id}"`))
        .map((term) => term.id)
    ).toEqual([]);
  });

  it("answers terms_query for every term of terms_list with the status its catalog entry requires", async () => {
    const result = await callMcpTool("terms_list", {}, backend.callProcedure);
    const { terms } = result["structuredContent"] as Readonly<{
      terms: readonly Readonly<{
        certified: boolean;
        id: string;
        source: string;
      }>[];
    }>;
    expect(
      terms
        .filter((term) => term.certified && term.source !== "none")
        .map((term) => term.id)
        .sort()
    ).toEqual(ANSWERING_TERMS);
    const failures: string[] = [];
    for (const { certified, id, source } of terms) {
      const params = REQUIRED_TERM_PARAMS[id];
      const result = await callMcpTool(
        "terms_query",
        params === undefined ? { term: id } : { params, term: id },
        backend.callProcedure
      );
      const [content] = result["content"] as readonly Readonly<{
        text: string;
      }>[];
      const answer = result["structuredContent"] as
        | Readonly<{ status: string }>
        | undefined;
      // A certified term with a source must give a value. "unknown" there means that the feed was
      // unavailable or the query of the term failed. A term with no source or no certification
      // answers "not_available" by design. A certified feed term with no reader answers it too; the
      // test fails for it on purpose, because the catalog says certified and the term gives no value.
      const required = certified && source !== "none" ? "ok" : "not_available";
      if (result["isError"] === true) failures.push(`${id}: ${content?.text}`);
      else if (answer?.status !== required)
        failures.push(`${id}: ${answer?.status}, not ${required}`);
    }
    expect(failures).toEqual([]);
  });
  // "ok" proves only that a call did not fail; an empty list passes it too. These calls must return
  // the model run and the optimizer run that fixture.sql seeds.
  it.each([
    ["model_runs_list", {}, "mr_nvda_1"],
    ["model_runs_search", { query: "support" }, "mr_nvda_1"],
    ["model_runs_benchmark", { armBy: "model" }, "claude-opus"],
    ["optimizations_list", {}, "opt_orb_1"],
  ] as const)(
    "%s returns the seeded fixture row",
    async (name, args, expected) => {
      const { failed, text } = await call(name, args);
      expect(failed).toBe(false);
      expect(text).toContain(expected);
    }
  );
});
