import { describe, expect, it } from "vitest";
import { hashArtifact } from "@darkfactory/shared/vertex";
import { VertexResearchProposalInputSchema } from "../contracts/vertex-experience.ts";
import { parseRuntimePolicySelection } from "../contracts/vertex-policy.ts";
import { createVertexExperienceCommands } from "./vertex-experience-commands.ts";
import {
  fixture,
  principal,
  actor,
  scope,
} from "./vertex-backtest-intent.test-support.ts";
import { mutableClone } from "./mutable-clone.test-support.ts";

describe("exact backtest intent owner chain", () => {
  it("retains original pins through durable command recovery and selected backtest dispatch", async () => {
    const h = await fixture(),
      result = await h.service.proposeResearch(principal, h.input);
    const requestHash = await hashArtifact({
      actorId: actor.actorId,
      kind: "research",
      input: h.input,
    });
    expect(result.value.runId).toBe(`backtest-request-${requestHash}`);
    expect(
      (await h.worker.readResearchProposal(actor, scope, result.artifactId))?.[
        "backtestExpectation"
      ]
    ).toEqual(h.input.backtestExpectation);
    expect(await h.dispatch()).toMatchObject({
      kind: "backtest",
      researchPrincipalId: actor.actorId,
      policySelectionId: h.input.backtestExpectation!.policy.selectionId,
      policySelectionSha256:
        h.input.backtestExpectation!.policy.selectionSha256,
    });
    return expect(
      JSON.parse(new TextDecoder().decode(h.staged.mock.calls[0]![2].bytes))
    ).toEqual({
      format: "vertex-backtest-job-v1",
      recipeArtifactId: "recipe",
      recipeSha256: h.input.backtestExpectation!.recipe.sha256,
    });
  });
  it("passes only the recovered exact backtest selection into the existing dispatcher bind port", async () => {
    const h = await fixture();
    await h.service.proposeResearch(principal, h.input);
    expect(await h.dispatchClaimed()).toMatchObject({
      status: "admitted",
      lease: { kind: "backtest", researchPrincipalId: actor.actorId },
    });
    expect(h.bindOutbox).toHaveBeenCalledTimes(1);
    expect(h.bindOutbox.mock.calls[0]![2]).toMatchObject({
      kind: "backtest",
      workerInstanceId: "fixture-worker",
      policySelectionSha256:
        h.input.backtestExpectation!.policy.selectionSha256,
    });
    const proposal = h.table("vertex_research_proposals")[0]!;
    delete proposal["payload"].backtestExpectation;
    proposal["proposal_hash"] = await hashArtifact(proposal["payload"]);
    expect(await h.dispatchClaimed()).toMatchObject({ lease: null });
    return expect(h.bindOutbox).toHaveBeenCalledTimes(1);
  });
  it("reconciles duplicate and lost acknowledgement with one original event and rejects changed pins", async () => {
    const h = await fixture(),
      enqueue = h.store.enqueueResearchProposal;
    h.store.enqueueResearchProposal = async (input) => {
      await enqueue(input);
      throw new Error("Synthetic lost acknowledgement");
    };
    await expect(
      h.service.proposeResearch(principal, h.input)
    ).rejects.toBeDefined();
    h.store.enqueueResearchProposal = enqueue;
    const recovered = await h.service.proposeResearch(principal, h.input);
    expect(await h.service.proposeResearch(principal, h.input)).toEqual(
      recovered
    );
    expect(h.table("vertex_research_proposals")).toHaveLength(1);
    expect(h.table("vertex_outbox")).toHaveLength(1);
    const changed = structuredClone(h.input);
    changed.backtestExpectation!.plannedRun.sha256 = "b".repeat(64);
    await expect(
      h.service.proposeResearch(principal, changed)
    ).rejects.toBeDefined();
    await expect(
      h.store.getCommandReceipt(actor, scope, {
        kind: "research",
        command: changed,
        idempotencyKey: changed.idempotencyKey,
        requestHash: await hashArtifact({
          actorId: actor.actorId,
          kind: "research",
          input: changed,
        }),
        commandPolicy: {
          ...h.input.backtestExpectation!.policy,
          revision: "1",
        },
      })
    ).rejects.toMatchObject({ code: "conflict" });
    return expect(h.table("vertex_outbox")).toHaveLength(1);
  });
  it.each([
    "strategy",
    "plannedRun",
    "recipe",
    "policy",
    "actor",
    "collection",
    "missing",
    "null",
    "review",
    "rights",
  ])("denies %s drift without staging or generic fallback", async (kind) => {
    const h = await fixture();
    await h.service.proposeResearch(principal, h.input);
    const proposal = h.table("vertex_research_proposals")[0]!;
    if (["strategy", "plannedRun", "recipe"].includes(kind))
      proposal["payload"].backtestExpectation[kind].sha256 = "b".repeat(64);
    if (kind === "policy")
      h.state.selection = {
        ...h.state.selection,
        selectionId: "other-selection",
      };
    if (kind === "actor") proposal["actor_id"] = "other-actor";
    if (kind === "collection") proposal["collection_id"] = "other-collection";
    if (kind === "missing") delete proposal["payload"].backtestExpectation;
    if (kind === "null") proposal["payload"].backtestExpectation = null;
    if (kind === "review") h.table("vertex_reviews").length = 0;
    if (kind === "rights") h.table("vertex_rights_versions").length = 0;
    proposal["proposal_hash"] = await hashArtifact(proposal["payload"]);
    await expect(h.dispatch()).rejects.toBeDefined();
    return expect(h.staged).not.toHaveBeenCalled();
  });
  it.each(["strategy", "run", "actor", "collection", "selection", "recipe"])(
    "rejects newly selected valid %s bytes after the original command",
    async (kind) => {
      const h = await fixture();
      await h.service.proposeResearch(principal, h.input);
      if (kind === "strategy") h.state.recipe.strategy.sha256 = "b".repeat(64);
      if (kind === "run") h.state.recipe.run.sha256 = "b".repeat(64);
      if (kind === "actor") h.state.recipe.publication.actorId = "other-actor";
      if (kind === "collection")
        h.state.recipe.publication.collectionId = "other-collection";
      const { selectionSha256: omitted, ...body } = mutableClone(
        h.state.selection
      );
      if (kind === "selection") body.selectionId = "new-selection";
      if (kind === "recipe")
        body.artifacts[0]!.artifact.artifactId = "new-recipe";
      body.artifacts[0]!.artifact.artifactSha256 = await hashArtifact(
        h.state.recipe
      );
      h.state.selection = await parseRuntimePolicySelection({
        ...body,
        selectionSha256: await hashArtifact(body),
      });
      await expect(h.dispatch()).rejects.toBeDefined();
      return expect(h.staged).not.toHaveBeenCalled();
    }
  );
  it("fails human submission closed when selected owner or current policy is unavailable", async () => {
    const h = await fixture(),
      { validateBacktestRequest: omitted, ...withoutOwner } = h.deps;
    await expect(
      createVertexExperienceCommands(withoutOwner as never).proposeResearch(
        principal,
        h.input
      )
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    h.state.unavailable = true;
    await expect(
      h.service.proposeResearch(principal, h.input)
    ).rejects.toBeDefined();
    expect(h.table("vertex_research_proposals")).toHaveLength(0);
    return expect(h.staged).not.toHaveBeenCalled();
  });
  it("keeps ordinary proposal identity and payload bytes compatible and rejects malformed explicit variants", async () => {
    const h = await fixture(),
      { backtestExpectation: omitted, ...generic } = h.input;
    const result = await h.service.proposeResearch(principal, generic);
    expect(result.value.runId).toBe(
      `run-${await hashArtifact({ actorId: actor.actorId, kind: "research", input: generic })}`
    );
    expect(h.table("vertex_research_proposals")[0]!["payload"]).toEqual({
      question: generic.question,
      evidenceIds: [],
      role: "research",
      proposalOnly: true,
      executionAuthorized: false,
    });
    for (const malformed of [
      null,
      undefined,
      {},
      { ...omitted, operation: "backtest-review" },
    ])
      expect(
        VertexResearchProposalInputSchema.safeParse({
          ...generic,
          backtestExpectation: malformed,
        }).success
      ).toBe(false);
  });
});
