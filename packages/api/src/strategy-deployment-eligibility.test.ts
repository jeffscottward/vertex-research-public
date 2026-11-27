import { describe, expect, it } from "vitest";

import type { StrategyVertexStudy } from "./contracts/strategy-library.ts";
import {
  FAILED_TAG,
  RESEARCH_ONLY_TAG,
  strategyDeploymentBlock,
} from "./strategy-deployment-eligibility.ts";

const backtest = (
  verdict: "edge" | "no-edge" | "needs-more-data"
): StrategyVertexStudy => ({ kind: "strategy-backtest", verdict });
const port = (verdict: "PASS" | "FAIL"): StrategyVertexStudy => ({
  kind: "qc-port",
  verdict,
});

describe("strategyDeploymentBlock", () => {
  it("blocks a strategy whose Vertex study found no edge", () => {
    const block = strategyDeploymentBlock({
      tags: ["backtest-study", "failed"],
      vertexStudy: backtest("no-edge"),
    });
    expect(block).toEqual({
      code: "study-no-edge",
      label: "No edge: no paper deployment",
      reason:
        "The Vertex study of this strategy found no edge; a paper deployment cannot be requested for it.",
    });
  });

  it("blocks a strategy whose Vertex backtest failed its pass rule", () => {
    expect(
      strategyDeploymentBlock({
        tags: ["quantconnect-idea"],
        vertexStudy: port("FAIL"),
      })
    ).toMatchObject({
      code: "study-failed",
      label: "Failed backtest: no paper deployment",
    });
  });

  it("blocks the research-only tag before any study verdict", () => {
    expect(RESEARCH_ONLY_TAG).toBe("research-only");
    expect(
      strategyDeploymentBlock({ tags: ["research-only"], vertexStudy: null })
    ).toMatchObject({
      code: "research-only",
      label: "Research only: no deployment",
    });
    expect(
      strategyDeploymentBlock({
        tags: ["research-only"],
        vertexStudy: backtest("no-edge"),
      })?.code
    ).toBe("research-only");
  });

  it("blocks the tag failed only when no study verdict is shown", () => {
    expect(FAILED_TAG).toBe("failed");
    const tagged = {
      code: "tagged-failed",
      label: "Tested, failed: no paper deployment",
      reason:
        "This strategy is tagged failed (Vertex tested it and it failed); a paper deployment cannot be requested for it.",
    };
    expect(
      strategyDeploymentBlock({ tags: ["failed"], vertexStudy: null })
    ).toEqual(tagged);
    // An older server sends no vertexStudy field.
    expect(strategyDeploymentBlock({ tags: ["failed"] })).toEqual(tagged);
    // The stored study wins over the tag, as on the badge: a stale failed tag does not block an
    // edge or open study, and a negative study gives its own reason.
    expect(
      strategyDeploymentBlock({
        tags: ["failed", "backtest-study"],
        vertexStudy: backtest("edge"),
      })
    ).toBeNull();
    expect(
      strategyDeploymentBlock({
        tags: ["failed", "backtest-study"],
        vertexStudy: backtest("needs-more-data"),
      })
    ).toBeNull();
    expect(
      strategyDeploymentBlock({
        tags: ["failed", "backtest-study"],
        vertexStudy: backtest("no-edge"),
      })?.code
    ).toBe("study-no-edge");
  });

  it("does not block edge, PASS, needs-more-data or a strategy with no study and no failed tag", () => {
    expect(
      strategyDeploymentBlock({ tags: [], vertexStudy: backtest("edge") })
    ).toBeNull();
    expect(
      strategyDeploymentBlock({ tags: [], vertexStudy: port("PASS") })
    ).toBeNull();
    expect(
      strategyDeploymentBlock({
        tags: [],
        vertexStudy: backtest("needs-more-data"),
      })
    ).toBeNull();
    expect(
      strategyDeploymentBlock({ tags: ["alerts"], vertexStudy: null })
    ).toBeNull();
    expect(strategyDeploymentBlock({ tags: [] })).toBeNull();
  });

  it("gives each block a different label and a full-sentence reason", () => {
    const blocks = [
      strategyDeploymentBlock({ tags: ["research-only"] }),
      strategyDeploymentBlock({ tags: [], vertexStudy: backtest("no-edge") }),
      strategyDeploymentBlock({ tags: [], vertexStudy: port("FAIL") }),
      strategyDeploymentBlock({ tags: ["failed"] }),
    ];
    expect(new Set(blocks.map((block) => block?.label)).size).toBe(4);
    for (const block of blocks)
      expect(block?.reason).toMatch(
        /a paper deployment cannot be requested for it\.$/u
      );
  });
});
