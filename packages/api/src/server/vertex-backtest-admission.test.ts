import { describe, expect, it, vi } from "vitest";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import {
  parseRuntimePolicySelection,
  type RuntimePolicySelection,
} from "../contracts/vertex-policy.ts";
import {
  fixture,
  principal,
  actor,
  scope,
} from "./vertex-backtest-intent.test-support.ts";
import {
  type DeepMutable,
  mutableClone,
} from "./mutable-clone.test-support.ts";
import { createVertexRuntimeRecipes } from "./vertex-runtime-recipes.ts";

// Synthetic source rows and selected recipe bytes only. The admission owner,
// command recovery and fixture SQL transport are the real source owners.
const expectationFor = (h: Awaited<ReturnType<typeof fixture>>) =>
  structuredClone(h.input.backtestExpectation!);
type Binding = DeepMutable<RuntimePolicySelection["artifacts"][number]>;
const reselect = async (
  h: Awaited<ReturnType<typeof fixture>>,
  change: (binding: Binding) => void = () => undefined
) => {
  const { selectionSha256: omitted, ...body } = mutableClone(h.state.selection);
  body.artifacts[0]!.artifact.artifactSha256 = await hashArtifact(
    h.state.recipe
  );
  change(body.artifacts[0]!);
  h.state.selection = await parseRuntimePolicySelection({
    ...body,
    selectionSha256: await hashArtifact(body),
  });
  return {
    ...expectationFor(h),
    strategy: h.state.recipe.strategy,
    plannedRun: h.state.recipe.run,
    recipe: {
      artifactId: "recipe",
      sha256: await hashArtifact(h.state.recipe),
    },
    policy: {
      selectionId: h.state.selection.selectionId,
      selectionSha256: h.state.selection.selectionSha256,
      selectionRevision: h.state.selection.revision,
    },
  };
};

describe("selected backtest admission owner", () => {
  it("admits the exact reviewed selection without writes", async () => {
    const h = await fixture();
    h.calls.length = 0;
    await expect(
      h.recipes.validateBacktestRequest(actor, scope, "ssrn", expectationFor(h))
    ).resolves.toBeUndefined();
    expect(h.calls.every((query) => /^select\b/i.test(query.sql.trim()))).toBe(
      true
    );
    expect(h.staged).not.toHaveBeenCalled();
    return expect(h.table("vertex_outbox")).toHaveLength(0);
  });
  it.each([
    ["unconfigured route", "unavailable"],
    ["paper scope", "unavailable"],
    ["expired selection", "denied"],
  ] as const)("refuses %s before any source read", async (kind, code) => {
    const h = await fixture();
    const expectation = expectationFor(h);
    if (kind === "unconfigured route")
      expectation.taskContract = "unconfigured-task";
    if (kind === "expired selection") h.access.at = h.state.selection.expiresAt;
    await expect(
      h.recipes.validateBacktestRequest(
        actor,
        kind === "paper scope" ? { ...scope, environment: "paper" } : scope,
        "ssrn",
        expectation
      )
    ).rejects.toMatchObject({ code });
    return expect(h.objects.size).toBe(2);
  });
  it.each(["strategy", "planned"])(
    "rejects a newly selected recipe whose %s pin differs from the committed source",
    async (kind) => {
      const h = await fixture();
      if (kind === "strategy") h.state.recipe.strategy.sha256 = "b".repeat(64);
      if (kind === "planned") h.state.recipe.run.sha256 = "b".repeat(64);
      const expectation = await reselect(h);
      return await expect(
        h.recipes.validateBacktestRequest(actor, scope, "ssrn", expectation)
      ).rejects.toMatchObject({ code: "integrity" });
    }
  );
  it.each(["strategy-original", "planned-original"])(
    "rejects changed stored bytes for %s",
    async (artifactId) => {
      const h = await fixture();
      h.objects.get(artifactId)!.bytes[0] = 0;
      return await expect(
        h.recipes.validateBacktestRequest(
          actor,
          scope,
          "ssrn",
          expectationFor(h)
        )
      ).rejects.toMatchObject({ code: "integrity" });
    }
  );
  it.each(["review", "rights"])(
    "rechecks the current %s of the selected strategy",
    async (kind) => {
      const h = await fixture();
      if (kind === "review") h.table("vertex_reviews").length = 0;
      if (kind === "rights") h.table("vertex_rights_versions").length = 0;
      return await expect(
        h.recipes.validateBacktestRequest(
          actor,
          scope,
          "ssrn",
          expectationFor(h)
        )
      ).rejects.toBeDefined();
    }
  );
  it("denies a strategy whose current rights version moved past its sealed metadata", async () => {
    const h = await fixture(),
      rights = h.objects.get("strategy-original")!.metadata.rights;
    await h.store.putRights(actor, scope, "ssrn", {
      ...rights,
      version: "2.0.0",
    });
    return await expect(
      h.recipes.validateBacktestRequest(actor, scope, "ssrn", expectationFor(h))
    ).rejects.toMatchObject({ code: "denied" });
  });
  it("denies when the current research review of the strategy is a rejection", async () => {
    const h = await fixture(),
      original = h.table("vertex_reviews")[0]!["payload"];
    h.access.at = "2026-09-22T12:00:01Z";
    await h.store.recordReview(actor, scope, {
      ...original,
      reviewId: "synthetic-rejection",
      decision: "rejected",
      reviewedAt: h.access.at,
      supersedesReviewId: original.reviewId,
    });
    return await expect(
      h.recipes.validateBacktestRequest(actor, scope, "ssrn", expectationFor(h))
    ).rejects.toMatchObject({ code: "denied" });
  });
  it("rejects selected recipe bytes that no longer match the selected pin", async () => {
    const h = await fixture();
    h.state.recipe.plannedAt = "2026-09-22T11:00:00Z";
    return await expect(
      h.recipes.validateBacktestRequest(actor, scope, "ssrn", expectationFor(h))
    ).rejects.toMatchObject({ code: "integrity" });
  });
  it("reports a missing stored strategy original as unavailable", async () => {
    const h = await fixture();
    h.objects.delete("strategy-original");
    return await expect(
      h.recipes.validateBacktestRequest(actor, scope, "ssrn", expectationFor(h))
    ).rejects.toMatchObject({ code: "unavailable" });
  });
  it.each([
    ["a non-engine role", "unavailable"],
    ["a non-recipe contract", "invalid"],
  ] as const)(
    "refuses a selected backtest binding with %s",
    async (kind, code) => {
      const h = await fixture();
      const expectation = await reselect(h, (binding) => {
        if (kind === "a non-engine role") binding.role = "tool-config";
        if (kind === "a non-recipe contract")
          binding.artifact.contractName = "SyntheticFixture";
      });
      return await expect(
        h.recipes.validateBacktestRequest(actor, scope, "ssrn", expectation)
      ).rejects.toMatchObject({ code });
    }
  );
});

describe("original backtest request recovery", () => {
  it("recovers the exact committed expectation for the requesting actor only", async () => {
    const h = await fixture(),
      request = await h.service.proposeResearch(principal, h.input);
    expect(
      (await h.worker.readResearchProposal(actor, scope, request.artifactId))?.[
        "backtestExpectation"
      ]
    ).toEqual(h.input.backtestExpectation);
    return expect(
      await h.worker.readResearchProposal(
        { actorId: "other-human" },
        scope,
        request.artifactId
      )
    ).toBeNull();
  });
  it("recovers an ordinary proposal without inventing a backtest expectation", async () => {
    const h = await fixture(),
      { backtestExpectation: omitted, ...generic } = h.input,
      request = await h.service.proposeResearch(principal, generic);
    const recovered = await h.worker.readResearchProposal(
      actor,
      scope,
      request.artifactId
    );
    expect(recovered).toMatchObject({ question: generic.question });
    return expect(recovered).not.toHaveProperty("backtestExpectation");
  });
  it.each([
    "request",
    "question",
    "role",
    "run-record",
    "evidence-link",
    "receipt",
    "receipt-missing",
    "receipt-duplicate",
  ])("rejects a corrupt or ambiguous original %s", async (kind) => {
    const h = await fixture(),
      request = await h.service.proposeResearch(principal, h.input);
    const proposal = h.table("vertex_research_proposals")[0]!,
      receipts = h.table("vertex_command_receipts");
    if (kind === "request")
      proposal["payload"].backtestExpectation.recipe.sha256 = "b".repeat(64);
    if (kind === "question") {
      proposal["payload"].question = "A different synthetic question.";
      proposal["proposal_hash"] = await hashArtifact(proposal["payload"]);
    }
    if (kind === "role") {
      proposal["payload"].role = "risk";
      proposal["role"] = "risk";
      proposal["proposal_hash"] = await hashArtifact(proposal["payload"]);
    }
    if (kind === "run-record") {
      const run = h
        .table("vertex_records")
        .find((row) => row["artifact_id"] === request.artifactId)!;
      run["record_hash"] = "b".repeat(64);
    }
    if (kind === "evidence-link")
      h.table("vertex_research_proposal_evidence").push({
        account_alias: scope.accountAlias,
        environment: scope.environment,
        artifact_id: request.artifactId,
        ordinal: 0,
        evidence_id: "unlisted-evidence",
      });
    if (kind === "receipt") receipts[0]!["request_hash"] = "b".repeat(64);
    if (kind === "receipt-missing") receipts.length = 0;
    if (kind === "receipt-duplicate")
      receipts.push(structuredClone(receipts[0]!));
    return await expect(
      h.worker.readResearchProposal(actor, scope, request.artifactId)
    ).rejects.toMatchObject({ code: "integrity" });
  });
});

describe("original backtest event lease", () => {
  it("records a retry settlement without publishing or losing the claim receipt", async () => {
    const h = await fixture();
    await h.service.proposeResearch(principal, h.input);
    const end = h.state.selection.expiresAt;
    const claims = await h.store.claimOutbox(actor, scope, {
      leaseOwner: "fixture-worker",
      limit: 1,
      leaseExpiresAt: end,
    });
    expect(claims).toHaveLength(1);
    const claim = claims[0]!;
    expect(
      await h.store.settleOutbox(actor, scope, {
        eventId: claim.eventId,
        leaseOwner: claim.leaseOwner,
        leaseFence: claim.leaseFence,
        result: "retry",
        availableAt: h.access.at,
      })
    ).toBe(true);
    const settled = h.table("vertex_outbox")[0]!;
    expect(settled).toMatchObject({
      published_at: null,
      lease_owner: claim.leaseOwner,
      lease_fence: claim.leaseFence,
      lease_expires_at: end,
    });
    expect(settled["settlement_hash"]).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await h.store.settleOutbox(actor, scope, {
        eventId: claim.eventId,
        leaseOwner: claim.leaseOwner,
        leaseFence: claim.leaseFence,
        result: "published",
        availableAt: h.access.at,
      })
    ).toBe(false);
    return expect(h.table("vertex_outbox")[0]!["published_at"]).toBeNull();
  });
});

const quantRecipe = (handoffSha256: string) => ({
  profile: "vertex-quant-experiment-recipe-v1",
  module_id: "module",
  task_contract: "quant-task",
  collection_id: "ssrn",
  experiment_id: "synthetic-experiment",
  handoff: { artifactId: "synthetic-handoff", sha256: handoffSha256 },
  dependency_pins: [
    {
      artifactId: "synthetic-dependency",
      artifactSha256: "d".repeat(64),
      reviewId: "synthetic-dependency-review",
      reviewVersion: "1.0.0",
      rightsPolicyId: "policy-licensing-rights",
      rightsVersion: "1.0.0",
    },
  ],
  publication: {
    account_alias: scope.accountAlias,
    environment: "research",
    collection_id: "ssrn",
    rights_policy_id: "policy-licensing-rights",
    rights_version: "1.0.0",
  },
});
// The same fixture transports with explicitly varied selected-source owners.
const recipesWith = (
  h: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<Parameters<typeof createVertexRuntimeRecipes>[0]>
) =>
  createVertexRuntimeRecipes({
    db: h.db,
    store: h.store,
    workerStore: {
      readResearchProposal: h.worker.readResearchProposal,
      prepareOutboxPayload: h.staged,
    },
    objectCapabilities: h.objectCapabilities as never,
    clock: h.options.clock,
    consumerServiceId: "fixture-service",
    routes: [
      {
        taskContract: "backtest-task",
        kind: "backtest",
        bindingId: "backtest",
        ttlMilliseconds: 10_000,
      },
    ],
    readSelectedArtifact: async () =>
      new TextEncoder().encode(canonicalArtifactJson(h.state.recipe)),
    policyRegistry: {
      readHead: async () => {
        throw new Error("Head is not read by these owners");
      },
      materialize: async () => h.state.selection,
    },
    ...overrides,
  });

describe("selected-source owners with varied capabilities", () => {
  it("reports unavailable when the scoped object store cannot read bounded bytes", async () => {
    const h = await fixture();
    const recipes = recipesWith(h, { objectCapabilities: () => ({}) as never });
    return await expect(
      recipes.validateBacktestRequest(actor, scope, "ssrn", expectationFor(h))
    ).rejects.toMatchObject({ code: "unavailable" });
  });
  it("denies when the selection changes between the first and final policy reads", async () => {
    const h = await fixture(),
      original = h.state.selection;
    const { selectionSha256: omitted, ...body } = mutableClone(original);
    body.revision = "2";
    const replaced = await parseRuntimePolicySelection({
      ...body,
      selectionSha256: await hashArtifact(body),
    });
    const materialize = vi
      .fn(async () => replaced)
      .mockResolvedValueOnce(original);
    const recipes = recipesWith(h, {
      policyRegistry: {
        readHead: async () => {
          throw new Error("Head is not read by this owner");
        },
        materialize,
      } as never,
    });
    await expect(
      recipes.validateBacktestRequest(actor, scope, "ssrn", expectationFor(h))
    ).rejects.toMatchObject({ code: "denied" });
    return expect(materialize).toHaveBeenCalledTimes(2);
  });
  it("rejects a quant experiment whose selected handoff bytes differ from the pin", async () => {
    const h = await fixture();
    await h.service.proposeResearch(principal, h.input);
    const handoffSha256 = await hashArtifact({ synthetic: "handoff" });
    const recipe = quantRecipe(handoffSha256);
    const { selectionSha256: omitted, ...body } = mutableClone(
      h.state.selection
    );
    body.artifacts.push(
      {
        bindingId: "quant",
        role: "tool-config",
        artifact: {
          artifactId: "synthetic-quant-recipe",
          contractName: "QuantExperimentRecipe",
          schemaVersion: "1.0.0",
          artifactSha256: await hashArtifact(recipe),
        },
      },
      {
        bindingId: "quant-handoff",
        role: "tool-config",
        artifact: {
          artifactId: recipe.handoff.artifactId,
          contractName: "WorkerExperimentHandoff",
          schemaVersion: "1.0.0",
          artifactSha256: handoffSha256,
        },
      }
    );
    const selection = await parseRuntimePolicySelection({
      ...body,
      selectionSha256: await hashArtifact(body),
    });
    const reads: string[] = [];
    const recipes = recipesWith(h, {
      routes: [
        {
          taskContract: "quant-task",
          kind: "research-run",
          bindingId: "quant",
          ttlMilliseconds: 10_000,
        },
      ],
      readSelectedArtifact: async (_tx, _principal, _scope, pin) => {
        reads.push(pin.artifactId);
        return new TextEncoder().encode(
          canonicalArtifactJson(
            pin.artifactId === recipe.handoff.artifactId
              ? { synthetic: "changed-handoff" }
              : recipe
          )
        );
      },
    });
    const source = h.table("vertex_outbox")[0]!;
    const event = structuredClone(source["payload"]);
    event.payload.taskContract = "quant-task";
    await expect(
      recipes.prepareJob(
        {
          command: { kind: "queued-agent", event },
          lease: { scope, collectionId: "ssrn", eventId: source["event_id"] },
          identity: { scope },
          signal: new AbortController().signal,
        } as never,
        selection
      )
    ).rejects.toMatchObject({ code: "integrity" });
    expect(reads).toEqual(["synthetic-quant-recipe", "synthetic-handoff"]);
    return expect(h.staged).not.toHaveBeenCalled();
  });
});
