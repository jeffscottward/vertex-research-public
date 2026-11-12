import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  AGENT_FRAMEWORKS,
  VIBE_TRADING_TOOLS_ALLOWED,
  VIBE_TRADING_TOOLS_EXCLUDED,
} from "./agent-frameworks.ts";
import { AgentFrameworksOutputSchema } from "./contracts/agent-model-runs.ts";

const DRIVER = new URL(
  "../../../services/vibe-trading/driver/vt_driver.py",
  import.meta.url
);

// A Python tuple of string literals assigned to `name` in the driver source.
const pythonTuple = (source: string, name: string): string[] => {
  const match = new RegExp(`^${name} = \\(([^)]*)\\)`, "mu").exec(source);
  if (match === null) throw new Error(`${name} not found`);
  return [...(match[1] ?? "").matchAll(/"([^"]+)"/gu)].map(
    (literal) => literal[1] ?? ""
  );
};

describe("agent framework catalog", () => {
  it("matches the frameworks output contract", () => {
    expect(
      AgentFrameworksOutputSchema.parse({ frameworks: [...AGENT_FRAMEWORKS] })
        .frameworks
    ).toHaveLength(4);
    const ids = AGENT_FRAMEWORKS.map((framework) => framework.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.isFrozen(AGENT_FRAMEWORKS)).toBe(true);
  });

  it("describes how each framework is wired into Vertex", () => {
    const byId = new Map(
      AGENT_FRAMEWORKS.map((framework) => [framework.id, framework])
    );
    expect(byId.get("tradingagents")).toMatchObject({
      benchName: null,
      status: "reimplemented",
    });
    expect(byId.get("tradingagents")?.stages).toHaveLength(5);
    // Gamma Forge was the owner's earlier version of Vertex, not an upstream:
    // the TradingAgents desks are Vertex's own code.
    expect(JSON.stringify(AGENT_FRAMEWORKS)).not.toMatch(/gamma forge/iu);
    expect(byId.get("tradingagents")).toMatchObject({
      license:
        "Upstream: Apache License 2.0. Vertex code: Vertex's own adapter; no upstream code is copied.",
      version: "Not pinned: Vertex's own adapter, no upstream code",
    });
    expect(byId.get("ai_hedge_fund")).toMatchObject({
      benchName: null,
      status: "adapted",
    });
    const langalpha = byId.get("langalpha");
    expect(langalpha).toMatchObject({
      benchName: null,
      code: ["scripts/agent-desk/pitch.ts"],
      license:
        "Apache-2.0, Copyright 2025 Ginlix AI (ideas and structure only; no LangAlpha code is included).",
      name: "LangAlpha (trade pitch structure)",
      status: "adapted",
      toolsAllowed: [],
      version:
        "Ideas adapted from commit e102a783; LangAlpha itself does not run in Vertex",
    });
    expect(langalpha?.stages.map((stage) => stage.name)).toEqual([
      "Posture",
      "Scenario tree",
      "Exit levels and monitoring",
    ]);
    expect(langalpha?.links.map((link) => link.href)).toEqual([
      "https://github.com/ginlix-ai/LangAlpha/tree/e102a7838225157f7b3beca3fc274b26be852154",
    ]);
    expect(
      langalpha?.dataSources.every((source) => source.pointInTime === "yes")
    ).toBe(true);
    expect(langalpha?.summary).toContain("not integrated as a harness");
    expect(langalpha?.summary).not.toContain("container");
    expect(langalpha?.stages[0]?.summary).toContain(
      "decision-grade, is deliberately not used"
    );
    expect(langalpha?.stages[2]?.summary).toContain("SMA exit reference");
    expect(langalpha?.guards).toContain(
      "The pitch agent does not read scenario probabilities, so no probability-weighted figure is given."
    );
    expect(AGENT_FRAMEWORKS.map((framework) => framework.id)).toEqual([
      "tradingagents",
      "ai_hedge_fund",
      "vibe_trading",
      "langalpha",
    ]);
    const vibe = byId.get("vibe_trading");
    expect(vibe).toMatchObject({
      benchName: "vibe_trading",
      status: "external",
      version: "0.1.18 (commit 66eb576)",
    });
    expect(vibe?.license).toContain("MIT");
    expect(vibe?.stages.map((stage) => stage.name).slice(0, 4)).toEqual([
      "bull_advocate",
      "bear_advocate",
      "risk_officer",
      "portfolio_manager",
    ]);
    expect(
      vibe?.dataSources.every((source) => source.pointInTime === "no")
    ).toBe(true);
  });

  it("lists the same Vibe-Trading tools as the driver", () => {
    const source = readFileSync(DRIVER, "utf8");
    expect([...VIBE_TRADING_TOOLS_ALLOWED]).toEqual(
      pythonTuple(source, "TOOL_ALLOWLIST")
    );
    const prefixes = pythonTuple(source, "DENIED_PREFIXES").map(
      (prefix) => `${prefix}*`
    );
    expect([...VIBE_TRADING_TOOLS_EXCLUDED]).toEqual([
      ...pythonTuple(source, "TOOL_DENYLIST"),
      ...prefixes,
    ]);
    for (const tool of VIBE_TRADING_TOOLS_ALLOWED) {
      expect(VIBE_TRADING_TOOLS_EXCLUDED).not.toContain(tool);
      expect(
        prefixes.some((prefix) => tool.startsWith(prefix.slice(0, -1)))
      ).toBe(false);
    }
    expect(() => pythonTuple(source, "NO_SUCH_TUPLE")).toThrow(
      "NO_SUCH_TUPLE not found"
    );
  });
});
