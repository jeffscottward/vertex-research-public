import { describe, expect, it } from "vitest";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import {
  computeModelUseRequestHash,
  type ModelUseRequest,
} from "../contracts/vertex-model-use.ts";
import { VertexRuntimeModelPrivacyDecisionSchema } from "./vertex-runtime-model-evidence.ts";
import {
  ChatModelPrivacyReviewSchema,
  researchChatModelPrivacyResource,
  type ChatModelPrivacyReviewInput,
} from "./vertex-research-chat-model-privacy.ts";
import { ChatModelPrivacyReviewInputSchema } from "../contracts/vertex-model-privacy-rendezvous.ts";
import { chatWorkerFixture } from "./vertex-research-chat-worker-runtime.test-support.ts";

type Fixture = Awaited<ReturnType<typeof chatWorkerFixture>>;
const reviews = (f: Fixture) =>
  f.table("vertex_research_chat_model_privacy_reviews");
const dispatches = (f: Fixture) =>
  f.table("vertex_research_chat_model_dispatches");
const issue = (f: Fixture, input = f.privacyInput(f.tokenizeRequest)) =>
  f.privacy.recordResearchChatModelPrivacyReview(f.privacyReviewer, input);
const read = (f: Fixture, request = f.tokenizeRequest) =>
  f.db.transaction((tx) =>
    f.privacy.readForTransaction(tx, request, f.state.at)
  );
const changedRequest = async (
  request: ModelUseRequest,
  changes: Partial<ModelUseRequest>
): Promise<ModelUseRequest> => {
  const value = { ...request, ...changes };
  return { ...value, requestSha256: await computeModelUseRequestHash(value) };
};
const revoke = async (f: Fixture, grantId: string): Promise<void> => {
  const version = f
    .table("vertex_grant_versions")
    .find((row) => row["grant_id"] === grantId && row["version"] === "1.0.0")![
    "payload"
  ];
  await f.authorization.revokeGrant({
    principal: { actorId: version.recordedByActorId },
    scope: f.scope,
    collectionId: null,
    grantId,
    expectedVersion: "1.0.0",
    version: "2.0.0",
  });
};

// Source-only authored tests. The imported fixture must queue/bind/admit using
// real owners and issue actual authorization/model grants; no privacy record,
// original owner, allow callback or fabricated accepted fixture is installed.
// These tests do NOT qualify real SQL isolation, triggers, provider effects or
// storage. The joined budget->dispatch scenario belongs to the worker suite.
// Each case builds the full real-owner chat worker fixture (~10s alone).
describe("research chat original model privacy issuer", {
  timeout: 120_000,
}, () => {
  it("owner consent and prepared copies alone never issue a model decision", async () => {
    const f = await chatWorkerFixture();
    expect(reviews(f)).toHaveLength(0);
    await expect(read(f)).rejects.toThrow();
    return expect(dispatches(f)).toHaveLength(0);
  });
  it("records canonical ORIGINAL decision bytes and all three original reviewer authorities", async () => {
    const f = await chatWorkerFixture(),
      input = f.privacyInput(f.tokenizeRequest);
    const review = await issue(f, input);
    expect(ChatModelPrivacyReviewSchema.parse(review)).toEqual(review);
    expect(review.request).toEqual(f.tokenizeRequest);
    expect(review.privacyDecision).toEqual(
      VertexRuntimeModelPrivacyDecisionSchema.parse({
        format: "vertex-model-privacy-decision-v1",
        request: f.tokenizeRequest,
        policyId: review.policyId,
        policyVersion: review.policyVersion,
        issuedByActorId: f.privacyReviewer.actorId,
        decidedAt: review.reviewedAt,
        expiresAt: review.expiresAt,
        decision: "allow-model-processing",
        executionAuthorized: false,
      })
    );
    expect(review.commandSha256).toBe(
      await hashArtifact({ principal: f.privacyReviewer, input })
    );
    expect(review.reviewId).toBe(`chat-privacy-${review.commandSha256}`);
    expect(
      review.reviewerGrants.map((pin) => [pin.resourceId, pin.action])
    ).toEqual([
      ["account-scope", "read"],
      [review.policyId, "review"],
      [
        researchChatModelPrivacyResource(
          review.responseRequestId,
          "model-tokenize"
        ),
        "review",
      ],
    ]);
    for (const pin of review.reviewerGrants) {
      const original = f
        .table("vertex_grant_versions")
        .find(
          (row) =>
            row["grant_id"] === pin.grantId && row["version"] === pin.version
        )!;
      expect(pin.recordSha256).toBe(await hashArtifact(original["payload"]));
      expect(pin.revision).toBe(original["revision"]);
      expect(pin.expiresAt).toBe(original["payload"].expiresAt);
    }
    expect(reviews(f)[0]!["decision_canonical"]).toBe(
      canonicalArtifactJson(review.privacyDecision)
    );
    expect(reviews(f)[0]!["decision_sha256"]).toBe(
      await hashArtifact(review.privacyDecision)
    );
    expect(await read(f)).toEqual({
      decision: review.privacyDecision,
      expiresAt: review.expiresAt,
    });
    return expect(dispatches(f)).toHaveLength(0);
  });
  it("replays exact authenticated input without a new review or dispatch", async () => {
    const f = await chatWorkerFixture(),
      input = f.privacyInput(f.tokenizeRequest);
    const first = await issue(f, input);
    expect(await issue(f, input)).toEqual(first);
    expect(reviews(f)).toHaveLength(1);
    expect(dispatches(f)).toHaveLength(0);
    await expect(
      issue(f, { ...input, decision: "rejected" })
    ).rejects.toThrow();
    return expect(reviews(f)).toHaveLength(1);
  });
  it("rejects request-supplied actor, plaintext, allow flags and model request extensions", async () => {
    const f = await chatWorkerFixture(),
      input = f.privacyInput(f.tokenizeRequest);
    for (const extra of [
      { reviewerActorId: f.privacyReviewer.actorId },
      { body: "DO_NOT_PERSIST" },
      { allowed: true },
      { privacyDecision: {} },
    ]) {
      const changed = { ...input, ...extra };
      expect(ChatModelPrivacyReviewInputSchema.safeParse(changed).success).toBe(
        false
      );
      await expect(
        issue(f, changed as unknown as ChatModelPrivacyReviewInput)
      ).rejects.toThrow();
    }
    await expect(
      issue(f, {
        ...input,
        request: { ...input.request, body: "DO_NOT_PERSIST" },
      } as unknown as ChatModelPrivacyReviewInput)
    ).rejects.toThrow();
    return expect(reviews(f)).toHaveLength(0);
  });
  it("requires the server-configured authenticated independent reviewer", async () => {
    const f = await chatWorkerFixture(),
      input = f.privacyInput(f.tokenizeRequest);
    await expect(
      f.privacy.recordResearchChatModelPrivacyReview(
        { actorId: f.tokenizeRequest.researchPrincipalId },
        input
      )
    ).rejects.toThrow();
    await expect(
      f.privacy.recordResearchChatModelPrivacyReview(
        { actorId: f.tokenizeRequest.consumerServiceId },
        input
      )
    ).rejects.toThrow();
    return expect(reviews(f)).toHaveLength(0);
  });
  it("requires exact original plan, response and realized request digest", async () => {
    const f = await chatWorkerFixture(),
      input = f.privacyInput(f.tokenizeRequest);
    for (const changed of [
      { ...input, responseRequestId: "different-response" },
      { ...input, planId: "different-plan" },
      { ...input, planSha256: "a".repeat(64) },
      {
        ...input,
        request: { ...input.request, requestSha256: "b".repeat(64) },
      },
    ])
      await expect(issue(f, changed)).rejects.toThrow();
    return expect(reviews(f)).toHaveLength(0);
  });
  it("caps issuance at original request, plan, lease and grant deadlines", async () => {
    const f = await chatWorkerFixture();
    await expect(
      issue(
        f,
        f.privacyInput(f.tokenizeRequest, { expiresAt: "2099-01-01T00:00:00Z" })
      )
    ).rejects.toThrow();
    return expect(reviews(f)).toHaveLength(0);
  });
  it("uses latest-head expectedReviewId CAS and immutable accepted/rejected history", async () => {
    const f = await chatWorkerFixture(),
      first = await issue(f);
    await expect(
      issue(
        f,
        f.privacyInput(f.tokenizeRequest, {
          idempotencyKey: "stale-head",
          expectedReviewId: null,
          decision: "rejected",
        })
      )
    ).rejects.toThrow();
    const rejected = await issue(
      f,
      f.privacyInput(f.tokenizeRequest, {
        idempotencyKey: "reject-head",
        expectedReviewId: first.reviewId,
        decision: "rejected",
      })
    );
    expect(rejected.privacyDecision).toBeNull();
    expect(rejected.supersedesReviewId).toBe(first.reviewId);
    expect(reviews(f)).toHaveLength(2);
    expect(reviews(f)[0]!["payload"]).toEqual(first);
    await expect(read(f)).rejects.toThrow();
    const accepted = await issue(
      f,
      f.privacyInput(f.tokenizeRequest, {
        idempotencyKey: "accept-new-head",
        expectedReviewId: rejected.reviewId,
      })
    );
    expect((await read(f)).decision).toEqual(accepted.privacyDecision);
    return expect(reviews(f)).toHaveLength(3);
  });
  it("serializes two different commands at the same expected head", async () => {
    const f = await chatWorkerFixture();
    const outcomes = await Promise.allSettled([
      issue(
        f,
        f.privacyInput(f.tokenizeRequest, { idempotencyKey: "cas-left" })
      ),
      issue(
        f,
        f.privacyInput(f.tokenizeRequest, { idempotencyKey: "cas-right" })
      ),
    ]);
    expect(
      outcomes.filter((entry) => entry.status === "fulfilled")
    ).toHaveLength(1);
    expect(
      outcomes.filter((entry) => entry.status === "rejected")
    ).toHaveLength(1);
    return expect(reviews(f)).toHaveLength(1);
  });
  for (const index of [0, 1, 2])
    it(`denies revoked original reviewer authority ${index} despite other scoped permissions`, async () => {
      const f = await chatWorkerFixture(),
        review = await issue(f);
      await revoke(f, review.reviewerGrants[index]!.grantId);
      await expect(read(f)).rejects.toThrow();
      return expect(dispatches(f)).toHaveLength(0);
    });
  for (const index of [0, 1, 2])
    it(`does not replace original reviewer grant ${index} with a later valid version`, async () => {
      const f = await chatWorkerFixture(),
        review = await issue(f),
        pin = review.reviewerGrants[index]!;
      const original = f
        .table("vertex_grant_versions")
        .find(
          (row) =>
            row["grant_id"] === pin.grantId && row["version"] === pin.version
        )!["payload"];
      await f.authorization.issueGrant({
        principal: { actorId: original.recordedByActorId },
        grantId: original.grantId,
        granteeActorId: original.granteeActorId,
        scope: original.scope,
        collectionId: original.collectionId,
        resourceId: original.resourceId,
        actions: original.actions,
        version: "2.0.0",
        expectedVersion: "1.0.0",
        validFrom: original.validFrom,
        expiresAt: "2099-01-01T00:00:00Z",
      });
      await expect(read(f)).rejects.toThrow();
      await expect(issue(f)).rejects.toThrow();
      return expect(reviews(f)[0]!["payload"]).toEqual(review);
    });
  it.each([
    [
      "record hash",
      (row: Record<string, any>) => {
        row["record_hash"] = "f".repeat(64);
      },
    ],
    [
      "projected request",
      (row: Record<string, any>) => {
        row["request_id"] = "other-request";
      },
    ],
    [
      "decision canonical bytes",
      (row: Record<string, any>) => {
        row["decision_canonical"] = "{}";
      },
    ],
    [
      "decision digest",
      (row: Record<string, any>) => {
        return (row["decision_sha256"] = "e".repeat(64));
      },
    ],
    [
      "original account-read grant",
      (row: Record<string, any>) => {
        row["account_read_grant_id"] = "different-authority";
      },
    ],
  ] as const)("fails closed on %s corruption", async (_name, mutation) => {
    const f = await chatWorkerFixture();
    await issue(f);
    mutation(reviews(f)[0]!);
    return await expect(read(f)).rejects.toThrow();
  });
  it("rejects grant pin substitution even with a recomputed enclosing record hash", async () => {
    const f = await chatWorkerFixture();
    await issue(f);
    const row = reviews(f)[0]!,
      value = structuredClone(row["payload"]);
    value.reviewerGrants[1].recordSha256 = "a".repeat(64);
    row["payload"] = value;
    row["record_hash"] = await hashArtifact(value);
    return await expect(read(f)).rejects.toThrow();
  });
  it("denies expiry crossed on the last awaited original grant SQL query", async () => {
    const f = await chatWorkerFixture(),
      review = await issue(f);
    let reads = 0;
    f.state.afterQuery = (query) => {
      if (
        query.sql.includes("from vertex_grant_bindings") &&
        query.params.includes(
          researchChatModelPrivacyResource(
            review.responseRequestId,
            "model-tokenize"
          )
        )
      ) {
        reads += 1;
        if (reads === 2) return (f.state.at = review.expiresAt);
        return;
      }
      return;
    };
    await expect(read(f)).rejects.toThrow();
    expect(reads).toBeGreaterThanOrEqual(2);
    return expect(dispatches(f)).toHaveLength(0);
  });
  it("rolls back a new review if a post-write await reaches its deadline", async () => {
    const f = await chatWorkerFixture(),
      input = f.privacyInput(f.tokenizeRequest);
    f.state.afterQuery = (query) => {
      if (
        /^insert into "?vertex_research_chat_model_privacy_reviews/.test(
          query.sql
        )
      )
        return (f.state.at = input.expiresAt);
      return;
    };
    await expect(issue(f, input)).rejects.toThrow();
    return expect(reviews(f)).toHaveLength(0);
  });
  it("does not backdate after an internally observed clock rollback", async () => {
    const f = await chatWorkerFixture(),
      review = await issue(f),
      before = f.state.at;
    const earlier = "2000-01-01T00:00:00Z";
    f.state.afterQuery = (query) => {
      if (
        query.sql.includes("from vertex_grant_bindings") &&
        query.params.includes(review.policyId)
      )
        return (f.state.at = earlier);
      return;
    };
    await expect(read(f)).rejects.toThrow();
    f.state.at = before;
    return expect(dispatches(f)).toHaveLength(0);
  });
  it("denies another realized request even when its self-digest is valid", async () => {
    const f = await chatWorkerFixture();
    await issue(f);
    const changed = await changedRequest(f.tokenizeRequest, {
      requestId: "another-realized-request",
    });
    return await expect(read(f, changed)).rejects.toThrow();
  });
  it("does not reuse tokenize authority for the completion operation", async () => {
    const f = await chatWorkerFixture();
    await issue(f);
    const completion = await f.completionRequest(1);
    await expect(read(f, completion)).rejects.toThrow();
    return expect(dispatches(f)).toHaveLength(0);
  });
  it("does not reserve dispatch when the real model-use proof lacks privacy authority", async () => {
    const f = await chatWorkerFixture();
    const result = await f.modelUseRequest(f.tokenizeRequest);
    expect(result.decision).toBe("denied");
    expect(result.externalDispatchAllowed).toBe(false);
    return expect(dispatches(f)).toHaveLength(0);
  });
  it("reserves only after real budget proof and permanently suppresses exact retries", async () => {
    const f = await chatWorkerFixture();
    await issue(f);
    const first = await f.modelUseRequest(f.tokenizeRequest);
    expect(first.decision).toBe("allowed");
    expect(first.externalDispatchAllowed).toBe(true);
    const row = structuredClone(dispatches(f)[0]!);
    const replay = await f.modelUseRequest(f.tokenizeRequest);
    expect(replay.externalDispatchAllowed).toBe(false);
    expect(dispatches(f)).toHaveLength(1);
    return expect(dispatches(f)[0]).toEqual(row);
  });
  it("review supersession never rearms or replaces a response-operation association", async () => {
    const f = await chatWorkerFixture(),
      first = await issue(f);
    expect(
      (await f.modelUseRequest(f.tokenizeRequest)).externalDispatchAllowed
    ).toBe(true);
    const original = structuredClone(dispatches(f)[0]!);
    await issue(
      f,
      f.privacyInput(f.tokenizeRequest, {
        idempotencyKey: "review-after-dispatch",
        expectedReviewId: first.reviewId,
      })
    );
    expect(
      (await f.modelUseRequest(f.tokenizeRequest)).externalDispatchAllowed
    ).toBe(false);
    const changed = await changedRequest(f.tokenizeRequest, {
      requestId: "changed-after-unknown-provider-outcome",
    });
    const [outcome] = await Promise.allSettled([f.modelUseRequest(changed)]);
    if (outcome!.status === "fulfilled")
      expect(outcome!.value.decision).toBe("denied");
    await expect(
      issue(
        f,
        f.privacyInput(changed, {
          idempotencyKey: "changed-after-dispatch",
          expectedReviewId: reviews(f)[1]!["review_id"],
        })
      )
    ).rejects.toThrow();
    expect(dispatches(f)).toHaveLength(1);
    return expect(dispatches(f)[0]).toEqual(original);
  });
});
