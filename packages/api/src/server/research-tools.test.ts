import { readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { STRATEGY_TEMPLATES } from "../strategy-dsl.ts";
import { MCP_TOOLS, listMcpTools } from "./mcp.ts";
import {
  ASSISTANT_CONFIRM_TOOLS,
  ASSISTANT_SWEEP_MAX_CELLS,
  RESEARCH_TOOLS,
  assistantActionProblem,
  describeAssistantAction,
  presentDriftMonitor,
  sweepCellCount,
} from "./research-tools.ts";

const sweepArgs = (fastTo: number, slowTo: number) => ({
  dimensions: [
    { from: 1, param: "fast" as const, step: 1, to: fastTo },
    { from: 20, param: "slow" as const, step: 1, to: slowTo },
  ],
  from: "2020-01-01",
  metric: "sharpe",
  rule: { fast: 5, kind: "smaCross", slow: 30 },
  symbol: "TEST",
  timeframe: "1d",
  to: "2024-12-31",
});

describe("research tool registry", () => {
  it("is part of the MCP catalogue with object input schemas", () => {
    const listed = new Map(
      listMcpTools().map((entry) => [entry["name"] as string, entry])
    );
    expect(RESEARCH_TOOLS.map((tool) => tool.name)).toEqual([
      "strategy_definition_validate",
      "strategy_definitions_list",
      "strategy_definitions_get",
      "strategy_definition_save",
      "drift_status",
      "drift_monitor_get",
    ]);
    for (const tool of RESEARCH_TOOLS) {
      expect(MCP_TOOLS).toContain(tool);
      const schema = listed.get(tool.name)?.["inputSchema"] as {
        type: string;
        properties: Record<string, unknown>;
      };
      expect(schema.type).toBe("object");
      expect(tool.description.length).toBeGreaterThan(40);
    }
    const save = listed.get("strategy_definition_save")?.["inputSchema"] as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(Object.keys(save.properties).sort()).toEqual([
      "definition",
      "id",
      "note",
    ]);
    expect(save.required).toEqual(["definition"]);
  });

  it("only the save tool writes; drift tools are read-only", () => {
    expect(
      RESEARCH_TOOLS.filter((tool) => !tool.readOnly).map((tool) => tool.name)
    ).toEqual(["strategy_definition_save"]);
  });

  it("validates tool inputs with the contract schemas", () => {
    const save = RESEARCH_TOOLS.find(
      (tool) => tool.name === "strategy_definition_save"
    );
    expect(
      save?.input.safeParse({ definition: STRATEGY_TEMPLATES.smaCross }).success
    ).toBe(true);
    expect(save?.input.safeParse({ definition: {} }).success).toBe(false);
    const drift = RESEARCH_TOOLS.find((tool) => tool.name === "drift_status");
    expect(drift?.input.safeParse({ limit: 101 }).success).toBe(false);
  });

  it("omits paper and baseline series from one drift monitor", () => {
    const monitor = {
      baseline: {
        engineVersion: "instant-2",
        equity: [
          { equity: 1, t: 0 },
          { equity: 2, t: 1 },
        ],
        initialCapital: 10_000,
        label: "TEST",
        seriesSha256: "f".repeat(64),
      },
      checks: [{ key: "sharpe" }],
      id: "m-1",
      points: [{ equity: 1, t: 0 }],
      trades: [],
    };
    expect(presentDriftMonitor(monitor)).toEqual({
      baseline: {
        engineVersion: "instant-2",
        initialCapital: 10_000,
        label: "TEST",
        seriesSha256: "f".repeat(64),
      },
      checks: [{ key: "sharpe" }],
      id: "m-1",
      seriesOmitted: { baselineEquityPoints: 2, points: 1, trades: 0 },
    });
  });
});

describe("assistant confirm policy", () => {
  it("names the three mutating research tools", () => {
    expect([...ASSISTANT_CONFIRM_TOOLS]).toEqual([
      "strategy_definition_save",
      "backtest_runs_submit",
      "backtest_runs_sweep",
    ]);
  });

  it("limits an assistant sweep to 100 cells", () => {
    expect(ASSISTANT_SWEEP_MAX_CELLS).toBe(100);
    const atLimit = sweepArgs(10, 29);
    expect(sweepCellCount(atLimit)).toBe(100);
    expect(assistantActionProblem("backtest_runs_sweep", atLimit)).toBeNull();
    const over = sweepArgs(10, 30);
    expect(sweepCellCount(over)).toBe(110);
    expect(assistantActionProblem("backtest_runs_sweep", over)).toMatch(
      /at most 100 cells; this one has 110/u
    );
    expect(assistantActionProblem("backtest_runs_submit", over)).toBeNull();
  });

  it("describes each proposed action in one line", () => {
    const definition = STRATEGY_TEMPLATES.smaCross;
    expect(
      describeAssistantAction("strategy_definition_save", { definition })
    ).toBe(
      `Save strategy definition "${definition.name}" as a new definition (revision 1)`
    );
    expect(
      describeAssistantAction("strategy_definition_save", {
        definition,
        id: "def-1",
      })
    ).toBe(
      `Save strategy definition "${definition.name}" as the next revision of def-1`
    );
    expect(
      describeAssistantAction("backtest_runs_submit", {
        from: "2020-01-01",
        rule: { definition, kind: "dsl" },
        symbol: "TEST",
        timeframe: "1d",
        to: "2024-12-31",
      })
    ).toBe(
      `Run a backtest of definition "${definition.name}" on TEST 1d, 2020-01-01 to 2024-12-31`
    );
    expect(
      describeAssistantAction("backtest_runs_sweep", sweepArgs(2, 21))
    ).toBe(
      "Run a parameter sweep of smaCross on TEST 1d, 2020-01-01 to 2024-12-31: fast x slow, 4 cells, metric sharpe"
    );
  });
});

// ---------------------------------------------------------------------------
// Guard: the research tool registry never reaches an order, broker or deployment module.

// Static imports and re-exports (type-only ones are erased), side-effect imports and dynamic imports.
const RUNTIME_IMPORTS = [
  /^\s*(?:import|export)\s+(?!type\b)[^;]*?\bfrom\s+["']([^"']+)["']/gmu,
  /^\s*import\s+["']([^"']+)["']/gmu,
  /\bimport\(\s*["']([^"']+)["']\s*\)/gu,
];

const specifiersIn = (text: string): string[] =>
  RUNTIME_IMPORTS.flatMap((pattern) =>
    [...text.matchAll(pattern)].map((match) => match[1] as string)
  );
const FORBIDDEN_MODULE =
  /order|broker|ibkr|deploy|vertex-worker|execution|gateway|quant-?vps|portfolio-monitor|paper-forward/iu;
const ALLOWED_PACKAGES = new Set(["zod", "@orpc/contract"]);

const importClosure = (entry: string) => {
  const files = new Set<string>();
  const packages = new Set<string>();
  const walk = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    for (const specifier of specifiersIn(readFileSync(file, "utf8"))) {
      if (specifier.startsWith(".")) walk(resolve(dirname(file), specifier));
      else packages.add(specifier);
    }
  };
  walk(entry);
  return { files, packages };
};

describe("research tool registry guard", () => {
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { files, packages } = importClosure(
    resolve(sourceRoot, "server/research-tools.ts")
  );
  const modules = [...files].map((file) => relative(sourceRoot, file));

  it("imports no order, broker, deployment or procedure module", () => {
    expect(modules.length).toBeGreaterThan(3);
    expect(modules.filter((file) => FORBIDDEN_MODULE.test(file))).toEqual([]);
    // Only the registry itself lives in server/: no procedure implementation and no app contract.
    expect(modules.filter((file) => file.startsWith("server/"))).toEqual([
      "server/research-tools.ts",
    ]);
    expect(modules).not.toContain("contract.ts");
    expect([...packages].filter((name) => !ALLOWED_PACKAGES.has(name))).toEqual(
      []
    );
  });

  it("detects a forbidden import when one exists", () => {
    expect(FORBIDDEN_MODULE.test("server/deployment-requests.ts")).toBe(true);
    expect(FORBIDDEN_MODULE.test("contracts/ibkr-monitor.ts")).toBe(true);
    expect(
      specifiersIn(
        [
          "import { x } from './a.ts';",
          "import type { y } from './b.ts';",
          "import './c.ts';",
          "const z = await import('./d.ts');",
          "export { w } from './e.ts';",
        ].join("\n")
      ).sort()
    ).toEqual(["./a.ts", "./c.ts", "./d.ts", "./e.ts"]);
  });

  it("reaches only research procedures, never drift writes", () => {
    const byName = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));
    const procedures = [
      ...RESEARCH_TOOLS.map((tool) => tool.procedure),
      ...ASSISTANT_CONFIRM_TOOLS.map((name) => byName.get(name)?.procedure),
    ];
    for (const procedure of procedures) {
      expect(procedure).toMatch(/^backtestRuns\//u);
      expect(procedure).not.toMatch(FORBIDDEN_MODULE);
      expect(procedure).not.toMatch(
        /drift\/(create|record|acknowledge|paperSet|paperTick)$/u
      );
    }
  });
});
