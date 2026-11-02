import { normalizeStrategyParams } from "@darkfactory/db/server";
import { describe, expect, it } from "vitest";

import {
  AUTOPILOT_LIBRARY_SECTION,
  autopilotDefinitionId,
  autopilotLibraryStrategy,
  autopilotLiveReadiness,
  nautilusPaperConfig,
} from "./autopilot-handoff.ts";
import {
  STRATEGY_TEMPLATES,
  StrategyDefinitionSchema,
} from "./strategy-dsl.ts";

const candidate = {
  campaignId: "camp-1",
  id: "cand-1",
  label: "trendSma(200)",
};
const campaign = {
  gateVersion: "autopilot-gate-v1",
  symbol: "SPY",
  timeframe: "1d",
};
const sha = "a".repeat(64);

describe("autopilot hand-off", () => {
  it("builds a library strategy the library repository accepts", () => {
    const strategy = autopilotLibraryStrategy(candidate, campaign, sha);
    expect(strategy).toMatchObject({
      kind: "external",
      name: "Autopilot SPY trendSma(200)",
      section: AUTOPILOT_LIBRARY_SECTION,
      slug: "autopilot-cand-1",
      status: "paper",
      tags: ["autopilot"],
    });
    expect(strategy).not.toHaveProperty("sourceRef");
    const params = normalizeStrategyParams(strategy.params);
    expect(params.map((param) => [param.name, param.default])).toEqual([
      ["definitionId", autopilotDefinitionId("cand-1")],
      ["definitionSha256", sha],
      ["autopilotCandidate", "cand-1"],
      ["nautilusFormat", "vertex-nautilus-dsl-strategy-v1"],
    ]);
  });

  it("builds an unarmed paper Nautilus config", () => {
    const definition = StrategyDefinitionSchema.parse(
      STRATEGY_TEMPLATES.smaCross
    );
    const config = nautilusPaperConfig(candidate, campaign, definition, sha);
    expect(config).toMatchObject({
      armed: false,
      autopilot: { campaignId: "camp-1", candidateId: "cand-1" },
      instrument: { symbol: "SPY", timeframe: "1d" },
      mode: "paper",
      strategy: { definition, definitionSha256: sha },
    });
  });

  it("never allows live", () => {
    const ready = autopilotLiveReadiness({
      paperRequestId: "r1",
      verified: true,
    });
    expect(ready.allowed).toBe(false);
    expect(
      ready.checks
        .filter((check) => check.status === "conflict")
        .map((check) => check.id)
    ).toEqual(["paper", "optionsOnly", "ownerApproval"]);
  });
});
