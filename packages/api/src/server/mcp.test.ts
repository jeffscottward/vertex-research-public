import { describe, expect, it, vi } from "vitest";

import {
  MCP_TOOLS,
  callMcpTool,
  handleMcpHttp,
  handleMcpMessage,
  listMcpTools,
  presentBacktest,
  presentedApiKey,
  presentSweep,
  procedureResultFromResponse,
  type CallProcedure,
} from "./mcp.ts";

const ORIGIN = "http://vertex.localhost";

const okCall = (
  value: unknown = { tasks: [] }
): CallProcedure & ReturnType<typeof vi.fn> => {
  return vi.fn(async () => ({
    ok: true as const,
    value,
  })) as unknown as CallProcedure & ReturnType<typeof vi.fn>;
};

const post = (
  body: unknown,
  headers: Record<string, string> = { "x-api-key": "vrk_test" }
) => {
  return new Request(`${ORIGIN}/api/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
};

describe("MCP tool registry", () => {
  it("describes every tool with an object input schema and a read-only hint", () => {
    const tools = listMcpTools();
    expect(tools.map((tool) => tool["name"])).toEqual(
      MCP_TOOLS.map((tool) => tool.name)
    );
    for (const tool of tools) {
      expect((tool["inputSchema"] as { type: string }).type).toBe("object");
    }
    const readOnly = tools
      .filter(
        (tool) =>
          (tool["annotations"] as { readOnlyHint: boolean }).readOnlyHint
      )
      .map((tool) => tool["name"]);
    return expect(readOnly).toEqual([
      "summary",
      "tasks_list",
      "tasks_get",
      "papers_list",
      "backtests_list",
      "backtests_get",
      "backtest_runs_get",
      "backtest_runs_list",
      "backtest_runs_sweep",
      "deployment_status",
      "market_bars",
      "strategies_list",
      "strategies_get",
      "optimizations_list",
      "optimizations_get",
      "model_runs_list",
      "model_runs_get",
      "model_runs_search",
      "model_runs_benchmark",
      "strategy_definition_validate",
      "strategy_definitions_list",
      "strategy_definitions_get",
      "drift_status",
      "drift_monitor_get",
    ]);
  });

  return it("omits backtest series unless asked", () => {
    const value = {
      backtest: {
        id: "b",
        equity: [{ t: "x", equity: 1 }],
        drawdown: [{}],
        trades: [{}, {}],
        benchmark: { label: "SPY", points: [] },
        analytics: { a: 1 },
      },
      task: null,
    };
    expect(presentBacktest(value, false)).toEqual({
      backtest: {
        id: "b",
        analytics: { a: 1 },
        seriesOmitted: {
          equityPoints: 1,
          drawdownPoints: 1,
          trades: 2,
          benchmarkLabel: "SPY",
        },
      },
      task: null,
    });
    return expect(presentBacktest(value, true)).toBe(value);
  });
});

describe("callMcpTool", () => {
  it("validates arguments before calling the procedure", async () => {
    const call = okCall();
    const result = await callMcpTool("tasks_get", {}, call);
    expect(result["isError"]).toBe(true);
    return expect(call).not.toHaveBeenCalled();
  });

  it("forwards valid arguments to the mapped procedure and returns text plus structured content", async () => {
    const call = okCall({ tasks: [{ id: "t1" }] });
    const result = await callMcpTool("tasks_list", { limit: 5 }, call);
    expect(call).toHaveBeenCalledWith("agentOps/tasks/list", { limit: 5 });
    return expect(result).toEqual({
      content: [{ type: "text", text: '{"tasks":[{"id":"t1"}]}' }],
      isError: false,
      structuredContent: { tasks: [{ id: "t1" }] },
    });
  });

  it("returns the deployment.status v2 shape unchanged from deployment_status", async () => {
    const value = {
      configured: true,
      services: [],
      session: { available: true, state: "stopped" },
      risk: { available: true, kill_switch: "clear" },
      positions: { available: false, reason: "withheld" },
    };
    const call = okCall(value);
    const result = await callMcpTool("deployment_status", {}, call);
    expect(call).toHaveBeenCalledWith("agentOps/deployment/status", {});
    return expect(result["structuredContent"]).toEqual(value);
  });

  it("strips the MCP-only includeSeries flag before calling backtests.get", async () => {
    const call = okCall({
      backtest: { id: "b", equity: [], trades: [] },
      task: null,
    });
    await callMcpTool("backtests_get", { id: "b", includeSeries: false }, call);
    return expect(call).toHaveBeenCalledWith("agentOps/backtests/get", {
      id: "b",
    });
  });

  it("strips includeCells, validates the sweep grid and returns the top cells by default", async () => {
    const cell = (spike: boolean, rank: number | null) => ({
      coordinates: [0],
      error: null,
      metrics: {},
      params: [5],
      robustness: {
        neighbourMean: 0.1,
        neighbours: 1,
        rank,
        spike,
        worst: 0.1,
      },
      trades: 3,
    });
    const cells = Array.from({ length: 25 }, (_, index) =>
      cell(index === 3, index + 1)
    );
    const ranking = cells.map((_, index) => index);
    const call = okCall({ cells, metric: "sharpe", ranking });
    const args = {
      dimensions: [{ from: 5, param: "fast", step: 5, to: 15 }],
      from: "2020-01-01",
      metric: "sharpe",
      rule: { fast: 5, kind: "smaCross", slow: 50 },
      symbol: "SPY",
      timeframe: "1d",
      to: "2020-12-31",
    };
    const result = await callMcpTool(
      "backtest_runs_sweep",
      { ...args, includeCells: false },
      call
    );
    expect(call).toHaveBeenCalledWith("backtestRuns/sweep", args);
    const shown = result["structuredContent"] as Record<string, unknown>;
    expect(shown["cells"]).toBeUndefined();
    expect(shown["cellsOmitted"]).toBe(25);
    expect(shown["spikes"]).toEqual([3]);
    expect(shown["top"]).toHaveLength(20);
    expect((shown["top"] as { index: number }[])[3]).toMatchObject({
      index: 3,
      robustness: { spike: true },
    });
    const all = await callMcpTool(
      "backtest_runs_sweep",
      { ...args, includeCells: true },
      okCall({ cells, ranking })
    );
    expect(
      (all["structuredContent"] as Record<string, unknown>)["cells"]
    ).toHaveLength(25);
    const invalid = await callMcpTool(
      "backtest_runs_sweep",
      {
        ...args,
        dimensions: [{ from: 5, param: "trendSma", step: 5, to: 15 }],
      },
      call
    );
    expect(invalid["isError"]).toBe(true);
    expect(JSON.stringify(invalid["content"])).toContain(
      "trendSma does not apply to the smaCross rule"
    );
    return expect(presentSweep(null, false)).toBeNull();
  });

  it("reports procedure failures, including read-only key refusals, as tool errors", async () => {
    const call: CallProcedure = async () => ({
      ok: false,
      status: 403,
      code: "FORBIDDEN",
      message: "This API key is read-only",
    });
    const result = await callMcpTool(
      "tasks_create",
      { kind: "ops", agent: "a", title: "t" },
      call
    );
    return expect(result).toMatchObject({
      isError: true,
      content: [
        { type: "text", text: "FORBIDDEN (403): This API key is read-only" },
      ],
    });
  });

  return it("rejects unknown tools", async () =>
    expect((await callMcpTool("orders_place", {}, okCall()))["isError"]).toBe(
      true
    ));
});

describe("handleMcpMessage", () => {
  it("negotiates the protocol version and advertises tools", async () => {
    const init = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-03-26" },
      },
      okCall()
    );
    expect(init).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "vertex-research" },
      },
    });
    const fallback = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 2,
        method: "initialize",
        params: { protocolVersion: "1999-01-01" },
      },
      okCall()
    );
    return expect(
      (fallback!["result"] as { protocolVersion: string }).protocolVersion
    ).toBe("2025-06-18");
  });

  it("keeps assistant-only confirm tools off the external endpoint", async () => {
    const call = okCall();
    const listed = await handleMcpMessage(
      { jsonrpc: "2.0", id: 5, method: "tools/list" },
      call
    );
    const names = (
      listed!["result"] as { tools: { name: string }[] }
    ).tools.map((tool) => tool.name);
    expect(names).not.toContain("strategy_definition_save");
    expect(names).toContain("strategy_definition_validate");
    expect(names).toContain("backtest_runs_submit");
    const refused = await handleMcpMessage(
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "strategy_definition_save",
          arguments: { definition: {} },
        },
      },
      call
    );
    expect(refused).toMatchObject({
      result: {
        isError: true,
        content: [
          {
            text: "Tool strategy_definition_save needs a confirm card in the Vertex assistant; it is not available on the MCP endpoint",
          },
        ],
      },
    });
    return expect(call).not.toHaveBeenCalled();
  });

  return it("returns nothing for notifications and errors for unknown methods and bad envelopes", async () => {
    expect(
      await handleMcpMessage(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        okCall()
      )
    ).toBeNull();
    expect(
      await handleMcpMessage(
        { jsonrpc: "2.0", id: 3, method: "resources/list" },
        okCall()
      )
    ).toMatchObject({ error: { code: -32_601 } });
    return expect(
      await handleMcpMessage({ id: 4, method: "ping" }, okCall())
    ).toMatchObject({ error: { code: -32_600 } });
  });
});

describe("handleMcpHttp", () => {
  const options = (call: CallProcedure = okCall()) => ({
    appOrigin: ORIGIN,
    callerFor: vi.fn(() => call),
  });

  it("requires POST, a matching Origin and an agent key", async () => {
    expect(
      (await handleMcpHttp(new Request(`${ORIGIN}/api/mcp`), options())).status
    ).toBe(405);
    expect(
      (
        await handleMcpHttp(
          post(
            { jsonrpc: "2.0", id: 1, method: "ping" },
            { "x-api-key": "k", origin: "https://evil.test" }
          ),
          options()
        )
      ).status
    ).toBe(403);
    const missing = await handleMcpHttp(
      post({ jsonrpc: "2.0", id: 1, method: "ping" }, {}),
      options()
    );
    expect(missing.status).toBe(401);
    return expect(missing.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("binds the caller to the presented key and answers single, batch and notification requests", async () => {
    const opts = options();
    const single = await handleMcpHttp(
      post(
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { authorization: "Bearer vrk_abc" }
      ),
      opts
    );
    expect(opts.callerFor).toHaveBeenCalledWith("vrk_abc");
    expect(await single.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    const batch = await handleMcpHttp(
      post([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
      ]),
      opts
    );
    expect(await batch.json()).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
    expect(
      (
        await handleMcpHttp(
          post({ jsonrpc: "2.0", method: "notifications/initialized" }),
          opts
        )
      ).status
    ).toBe(202);
    return expect((await handleMcpHttp(post("{not json"), opts)).status).toBe(
      400
    );
  });

  return it("reads the key from x-api-key first, then a bearer token", () => {
    expect(
      presentedApiKey(
        new Headers({ "x-api-key": " a ", authorization: "Bearer b" })
      )
    ).toBe("a");
    expect(presentedApiKey(new Headers({ authorization: "Bearer b" }))).toBe(
      "b"
    );
    return expect(
      presentedApiKey(new Headers({ authorization: "Basic b" }))
    ).toBeNull();
  });
});

describe("procedureResultFromResponse", () =>
  it("maps oRPC success and error bodies", async () => {
    expect(
      await procedureResultFromResponse(
        Response.json({ json: { a: 1 }, meta: [] })
      )
    ).toEqual({ ok: true, value: { a: 1 } });
    expect(
      await procedureResultFromResponse(
        Response.json(
          { json: { code: "FORBIDDEN", status: 403, message: "no" } },
          { status: 403 }
        )
      )
    ).toEqual({ ok: false, status: 403, code: "FORBIDDEN", message: "no" });
    return expect(
      await procedureResultFromResponse(new Response("x", { status: 502 }))
    ).toEqual({ ok: false, status: 502, code: "ERROR", message: "HTTP 502" });
  }));
