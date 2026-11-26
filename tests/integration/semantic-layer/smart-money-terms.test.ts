import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type AssistantCompletion,
  type AssistantModelClient,
  runAssistantTurn,
} from "../../../packages/api/src/server/assistant-runtime.ts";
import { callMcpTool } from "../../../packages/api/src/server/mcp.ts";
import { EVAL_NOW } from "./fixtures.ts";
import { type EvalBackend, startEvalBackend } from "./harness.ts";

// End-to-end integration proof for card vertex-smart-money-assistant-terms:
// 1. All five smart-money terms are listed as certified in terms_list and answer with source, as_of and data_delay.
// 2. openbb_status (sources[].overdue) and openbb_13f_changes (rows) answer on the eval backend (read-tools.test.ts
//    sweeps all seven smart-money read tools in Plan mode).
// 3. Real Plan-mode runAssistantTurn executes both certified semantic-layer terms and smart-money read tools
//    for the three acceptance questions without any write/order access.

const SMART_MONEY_TERM_IDS = [
  "congress_trades",
  "insider_cluster_buys",
  "institutional_13f_changes",
  "large_options_premium_ranking",
  "short_volume",
] as const;

type ListedTerm = Readonly<{
  id: string;
  source: string;
  certified: boolean;
  description: string;
}>;

let backend: EvalBackend;

const scriptedClient = (
  replies: readonly AssistantCompletion[]
): AssistantModelClient => {
  let step = 0;
  return {
    complete: async () => {
      const next = replies[step++];
      if (next === undefined) throw new Error(`unexpected model step ${step}`);
      return next;
    },
    model: "scripted-test-model",
  };
};

const toolCall = (
  id: string,
  name: string,
  args: Record<string, unknown>
): AssistantCompletion => ({
  content: "",
  finishReason: "tool_calls",
  inputTokens: 100,
  outputTokens: 30,
  toolCalls: [
    {
      function: { arguments: JSON.stringify(args), name },
      id,
      type: "function",
    },
  ],
});

const finalReply = (content: string): AssistantCompletion => ({
  content,
  finishReason: "stop",
  inputTokens: 150,
  outputTokens: 50,
  toolCalls: [],
});

describe("smart-money semantic terms and assistant read tools", () => {
  beforeAll(async () => {
    backend = await startEvalBackend();
  }, 120_000);

  afterAll(async () => {
    await backend.close();
  });

  it("lists all five smart-money terms as certified Postgres terms", async () => {
    const listed = await backend.callProcedure("semanticTerms/list", {});
    if (!listed.ok) throw new Error(listed.message);
    const { terms } = listed.value as { terms: readonly ListedTerm[] };
    expect(
      terms
        .filter((term) => SMART_MONEY_TERM_IDS.some((id) => id === term.id))
        .map((term) => [term.id, term.source, term.certified])
        .sort()
    ).toEqual(SMART_MONEY_TERM_IDS.map((id) => [id, "postgres", true]));
  });

  it("answers all five certified smart-money terms via terms_query with source, as_of and data_delay", async () => {
    const queries: readonly Readonly<{
      term: (typeof SMART_MONEY_TERM_IDS)[number];
      params?: Record<string, string | number>;
      expectSource: string;
    }>[] = [
      {
        expectSource: "QuantData",
        term: "large_options_premium_ranking",
      },
      {
        expectSource: "STOCK Act",
        params: { ticker: "NVDA" },
        term: "congress_trades",
      },
      {
        expectSource: "SEC EDGAR Form 4",
        term: "insider_cluster_buys",
      },
      {
        expectSource: "13F-HR",
        params: { ticker: "NVDA" },
        term: "institutional_13f_changes",
      },
      {
        expectSource: "FINRA Reg SHO",
        params: { symbol: "NVDA" },
        term: "short_volume",
      },
    ];

    for (const entry of queries) {
      const res = await backend.callProcedure("semanticTerms/query", {
        params: entry.params,
        term: entry.term,
      });
      if (!res.ok) throw new Error(`${entry.term}: ${res.message}`);
      const output = res.value as {
        status: string;
        certified: boolean;
        rows: readonly Record<string, unknown>[];
      };
      expect(output.status, entry.term).toBe("ok");
      expect(output.certified, entry.term).toBe(true);
      expect(output.rows.length, entry.term).toBeGreaterThan(0);
      const first = output.rows[0] ?? {};
      expect(String(first["source"]), entry.term).toContain(entry.expectSource);
      expect(first["as_of"], entry.term).toBeTruthy();
      expect(String(first["data_delay"]), entry.term).toMatch(/\S/);
    }
  });

  it("answers openbb_status with sources[].overdue and openbb_13f_changes with rows", async () => {
    const status = await callMcpTool(
      "openbb_status",
      {},
      backend.callProcedure
    );
    expect(status["isError"]).not.toBe(true);
    const statusBody = status["structuredContent"] as {
      sources: readonly { id: string; overdue: boolean; smartMoney: boolean }[];
    };
    expect(statusBody.sources.length).toBeGreaterThan(0);
    expect(
      statusBody.sources.every((source) => typeof source.overdue === "boolean")
    ).toBe(true);
    expect(statusBody.sources.some((source) => source.smartMoney)).toBe(true);

    const changes = await callMcpTool(
      "openbb_13f_changes",
      { ticker: "NVDA" },
      backend.callProcedure
    );
    expect(changes["isError"]).not.toBe(true);
    const changesBody = changes["structuredContent"] as {
      changes: readonly { ticker?: string; symbol?: string; change: string }[];
    };
    expect(changesBody.changes.length).toBeGreaterThan(0);
    expect(changesBody.changes[0]?.change).toBe("added");
  });

  it("runs real Plan-mode assistant turns across the three smart-money acceptance questions", async () => {
    const turns = [
      {
        calls: [
          toolCall("c1", "terms_query", {
            term: "large_options_premium_ranking",
          }),
          toolCall("c2", "openbb_smart_money_ranking", { sessions: 1 }),
        ],
        expectedTools: ["terms_query", "openbb_smart_money_ranking"],
        message: "What is big money buying today?",
        reply:
          "NVDA leads net bullish large-trade options premium at $3.2M (QuantData gainers-losers, session 2026-10-30, ~15 min intraday delay).",
      },
      {
        calls: [
          toolCall("c3", "terms_query", {
            params: { ticker: "NVDA" },
            term: "congress_trades",
          }),
          toolCall("c4", "openbb_congress_trades", { ticker: "NVDA" }),
        ],
        expectedTools: ["terms_query", "openbb_congress_trades"],
        message: "Who in Congress traded NVDA?",
        reply:
          "Fictional Rep. A. Rivera reported an NVDA purchase ($15,001 - $50,000) filed 2026-10-30 (U.S. House Clerk STOCK Act PTR; 10-day filing delay, up to 45 days allowed).",
      },
      {
        calls: [
          toolCall("c5", "terms_query", { term: "insider_cluster_buys" }),
          toolCall("c6", "openbb_insider_clusters", { days: 7 }),
        ],
        expectedTools: ["terms_query", "openbb_insider_clusters"],
        message: "Insider cluster buys this week?",
        reply:
          "EXMP (Example Systems Corp) shows 3 distinct insiders buying 2,300 shares ($116,800) through 2026-10-30 (SEC EDGAR Form 4 daily index; previous business day delay).",
      },
    ];

    for (const scenario of turns) {
      const result = await runAssistantTurn({
        budget: { record: () => Promise.resolve(), reserve: async () => true },
        callProcedure: backend.callProcedure,
        client: scriptedClient([...scenario.calls, finalReply(scenario.reply)]),
        clock: () => EVAL_NOW.getTime(),
        history: [],
        message: scenario.message,
        mode: "plan",
        now: () => EVAL_NOW,
      });
      expect(result.trace.map((entry) => entry.tool)).toEqual(
        scenario.expectedTools
      );
      expect(result.trace.every((entry) => entry.ok)).toBe(true);
      expect(result.content).toBe(scenario.reply);
    }
  });
});
