import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { WorkerExperimentDependencyPinSchema } from "../contracts/vertex-worker-experiment.ts";
import {
  GammaResearchRecipeSchema,
  PaperLabRecipeSchema,
} from "./vertex-runtime-recipe-profiles.ts";

// Pure private-profile validation. All identities and digests are synthetic.
const collection = "profile-collection";
const snapshot = "profile-snapshot";
const digest = (character: string) => character.repeat(64);
const review = (evidenceId: string, artifactId = `${evidenceId}-record`) => ({
  collectionId: collection,
  evidenceId,
  artifactId,
  artifactSha256: digest("a"),
  reviewId: `${evidenceId}-review`,
  reviewVersion: "1.0.0",
  rightsPolicyId: "rights-policy",
  rightsVersion: "1.0.0",
});
const publication = {
  evidenceId: "profile-publication",
  collectionId: collection,
  snapshotId: snapshot,
  sourceUri: "https://example.test/profile",
  sourceIdentity: {
    provider: "synthetic-fixture",
    sourceId: "profile-source",
    snapshotId: snapshot,
  },
  sourceLocator: "Synthetic locator",
  attribution: "Synthetic fixture",
  publishedAt: null,
  claim: "Synthetic profile claim",
  limitations: ["Synthetic only"],
  rightsPolicyId: "rights-policy",
};
const pin = (artifactId: string, character: string) => ({
  artifactId,
  artifactSha256: digest(character),
  reviewId: `${artifactId}-review`,
  reviewVersion: "1.0.0",
  rightsPolicyId: "rights-policy",
  rightsVersion: "1.0.0",
});

describe("paper lab recipe profile", () => {
  const recipe = {
    profile: "vertex-paper-lab-recipe-v1",
    module_id: "paper-lab-module",
    task_contract: "paper-lab-task",
    operation: "map-claims",
    collection_id: collection,
    snapshot_id: snapshot,
    implementation: {
      artifactId: "paper-lab-implementation",
      sha256: digest("b"),
    },
    request: {
      binding: { artifactId: "paper-lab-request", sha256: digest("c") },
      review: review("request-evidence"),
    },
    inputs: [
      {
        name: "paper",
        binding: { artifactId: "paper-lab-paper", sha256: digest("d") },
        review: review("paper-evidence"),
      },
    ],
    dependency_pins: [] as z.infer<
      typeof WorkerExperimentDependencyPinSchema
    >[],
    publication,
  };
  it("accepts distinct reviewed sources with operation-specific dependency pins", () => {
    expect(PaperLabRecipeSchema.safeParse(recipe).success).toBe(true);
    expect(
      PaperLabRecipeSchema.safeParse({
        ...recipe,
        operation: "freeze-experiment",
        dependency_pins: [pin("first-pin", "e"), pin("second-pin", "f")],
      }).success
    ).toBe(true);
    return expect(
      PaperLabRecipeSchema.safeParse({
        ...recipe,
        operation: "map-backtest",
        dependency_pins: [pin("first-pin", "e")],
      }).success
    ).toBe(true);
  });
  return it.each([
    ["freeze without pins", { operation: "freeze-experiment" }],
    [
      "pins outside freeze or backtest",
      { operation: "review-gates", dependency_pins: [pin("first-pin", "e")] },
    ],
    [
      "duplicate pin digests",
      {
        operation: "map-backtest",
        dependency_pins: [pin("first-pin", "e"), pin("second-pin", "e")],
      },
    ],
    [
      "foreign source collection",
      {
        inputs: [
          {
            ...recipe.inputs[0],
            review: { ...review("paper-evidence"), collectionId: "foreign" },
          },
        ],
      },
    ],
    [
      "a binding that is the publication",
      {
        inputs: [
          {
            ...recipe.inputs[0],
            binding: {
              artifactId: publication.evidenceId,
              sha256: digest("d"),
            },
          },
        ],
      },
    ],
  ])("rejects %s", (_label, change) => {
    return expect(
      PaperLabRecipeSchema.safeParse({ ...recipe, ...change }).success
    ).toBe(false);
  });
});

describe("gamma research recipe profile", () => {
  const input = (role: string, evidenceId: string) => ({
    role,
    review: review(evidenceId),
    binding: { artifactId: `${evidenceId}-binding`, sha256: digest("b") },
  });
  const recipe = {
    profile: "vertex-gamma-recipe-v1",
    module_id: "gamma-module",
    collection_id: collection,
    snapshot_id: snapshot,
    as_of: "2026-09-22T12:00:00Z",
    max_input_age_ns: "86400000000000",
    inputs: [input("rows", "rows-evidence"), input("spy_rows", "spy-evidence")],
    conversion: {
      policy_id: "conversion-policy",
      version: "1.0.0",
      basis: "binary64-shortest-roundtrip-decimal",
      rounding: "ROUND_HALF_EVEN",
      rules: [
        {
          path_pattern: "$.close",
          quantum: "0.01",
          maximum_absolute_error: "0",
        },
      ],
    },
    publication: { ...publication, capturedAt: "2026-09-22T12:00:00Z" },
    operation: "momentum",
    parameters: { ticker: "SYNTH" },
  };
  return it("requires authored roles and reviewed sources in the selected collection", () => {
    expect(GammaResearchRecipeSchema.safeParse(recipe).success).toBe(true);
    expect(
      GammaResearchRecipeSchema.safeParse({
        ...recipe,
        inputs: [input("spy_rows", "spy-evidence")],
      }).success
    ).toBe(false);
    expect(
      GammaResearchRecipeSchema.safeParse({
        ...recipe,
        inputs: [input("rows", "rows-evidence"), input("payload", "payload")],
      }).success
    ).toBe(false);
    return expect(
      GammaResearchRecipeSchema.safeParse({
        ...recipe,
        inputs: [
          input("rows", "rows-evidence"),
          {
            ...input("spy_rows", "spy-evidence"),
            review: { ...review("spy-evidence"), collectionId: "foreign" },
          },
        ],
      }).success
    ).toBe(false);
  });
});
