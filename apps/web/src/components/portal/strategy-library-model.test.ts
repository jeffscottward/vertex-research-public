import type { StrategyVertexStudy } from "@darkfactory/api";
import { describe, expect, it } from "vitest";

import {
  FAILED_TAG,
  strategyBadges,
  VERDICT_LABELS,
  vertexResultBadgeFor,
} from "./strategy-library-model.ts";

const CLAIM = {
  sourceUrl: "https://example.test/claim",
  sourceTitle: "Fictional claim",
  sourceAuthor: "Fictional author",
  publishedOn: "2026-09-24",
  claimedMethod: "Fictional method.",
  claimedMetrics: [{ label: "Rank", value: "1" }],
};

const label = (
  vertexStudy: StrategyVertexStudy | null | undefined,
  tags: string[] = ["backtest-study"]
) =>
  vertexResultBadgeFor({
    tags,
    ...(vertexStudy === undefined ? {} : { vertexStudy }),
  })?.label;

describe("Vertex result badge", () => {
  it("labels every study verdict", () => {
    expect(VERDICT_LABELS).toEqual({
      edge: "Edge",
      "needs-more-data": "Needs more data",
      "no-edge": "No edge",
    });
    expect(label({ kind: "strategy-backtest", verdict: "edge" })).toBe(
      "Vertex study: Edge"
    );
    expect(label({ kind: "strategy-backtest", verdict: "no-edge" })).toBe(
      "Vertex study: No edge"
    );
    expect(
      label({ kind: "strategy-backtest", verdict: "needs-more-data" })
    ).toBe("Vertex study: Needs more data");
    expect(
      label({ kind: "qc-port", verdict: "PASS" }, ["quantconnect-idea"])
    ).toBe("Vertex backtest: PASS");
    expect(
      label({ kind: "qc-port", verdict: "FAIL" }, ["quantconnect-idea"])
    ).toBe("Vertex backtest: FAIL");
  });

  it("gives a study badge its source, verdict attribute, neutral variant and texts", () => {
    const badge = vertexResultBadgeFor({
      tags: ["backtest-study"],
      vertexStudy: { kind: "strategy-backtest", verdict: "no-edge" },
    });
    expect(badge).toEqual({
      dataAttributes: {
        "data-strategy-vertex-result": "no-edge",
        "data-strategy-vertex-result-source": "study",
      },
      hint: "Vertex's own backtest study of this strategy. A research result: it gives no trading authority. Details on the Backtests tab.",
      key: "vertex-result",
      label: "Vertex study: No edge",
      srText: " (Vertex research result, not a trading signal)",
      variant: "outline",
    });
  });

  it("notes a positive verdict that disagrees with the failed tag; a negative one needs no note", () => {
    for (const study of [
      { kind: "strategy-backtest", verdict: "edge" },
      { kind: "qc-port", verdict: "PASS" },
    ] as const) {
      const badge = vertexResultBadgeFor({
        tags: [FAILED_TAG, "backtest-study", "quantconnect-idea"],
        vertexStudy: study,
      });
      expect(badge?.hint.endsWith(" Also tagged failed.")).toBe(true);
      expect(badge?.srText).toBe(
        " (Vertex research result, not a trading signal) Also tagged failed."
      );
    }
    expect(
      vertexResultBadgeFor({
        tags: [FAILED_TAG, "backtest-study"],
        vertexStudy: { kind: "strategy-backtest", verdict: "no-edge" },
      })?.srText
    ).toBe(" (Vertex research result, not a trading signal)");
  });

  it("falls back to the failed tag, then to the study tag, then to nothing", () => {
    expect(
      vertexResultBadgeFor({
        tags: [FAILED_TAG, "backtest-study"],
        vertexStudy: null,
      })
    ).toMatchObject({
      dataAttributes: {
        "data-strategy-vertex-result": "failed",
        "data-strategy-vertex-result-source": "tag",
      },
      label: "Tested, failed",
      srText: " (Vertex result from the failed tag)",
    });
    expect(
      vertexResultBadgeFor({ tags: ["quantconnect-idea"], vertexStudy: null })
    ).toMatchObject({
      dataAttributes: {
        "data-strategy-vertex-result": "see-backtests-tab",
        "data-strategy-vertex-result-source": "tag",
      },
      hint: "This strategy has a Vertex study. Its result could not be shown here; open the Backtests tab.",
      label: "Vertex study: see Backtests tab",
    });
    expect(
      vertexResultBadgeFor({ tags: ["regime"], vertexStudy: null })
    ).toBeNull();
  });

  it("treats a missing vertexStudy field (an older server) as no verdict", () => {
    expect(label(undefined)).toBe("Vertex study: see Backtests tab");
    expect(label(undefined, ["regime"])).toBeUndefined();
  });

  it("orders high priority, the Vertex result, then the external claim", () => {
    expect(
      strategyBadges({
        externalValidation: CLAIM,
        priority: "high",
        tags: ["backtest-study"],
        vertexStudy: { kind: "strategy-backtest", verdict: "no-edge" },
      }).map((badge) => [badge.key, badge.variant, badge.dataAttributes])
    ).toEqual([
      ["high-priority", "default", { "data-strategy-priority": "high" }],
      [
        "vertex-result",
        "outline",
        {
          "data-strategy-vertex-result": "no-edge",
          "data-strategy-vertex-result-source": "study",
        },
      ],
      [
        "externally-pre-validated",
        "outline",
        { "data-strategy-external-validation": "" },
      ],
    ]);
  });
});
