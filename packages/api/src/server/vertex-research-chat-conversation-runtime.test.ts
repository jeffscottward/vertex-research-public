import { describe, expect, it } from "vitest";
import {
  canonicalArtifactJson,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import {
  reviewer,
  SENTINELS,
  owner,
  scope,
} from "./vertex-research-chat-execution-runtime.test-support.ts";
import {
  VertexResearchChatPrepareResponseOutputSchema,
  VertexResearchChatReadResponseContentOutputSchema,
} from "../contracts/vertex-research-chat-conversation.ts";
import {
  answerText,
  prepareFixture,
  readSelector,
  reviewModel,
  consumeAndStageAdvisory,
  publishAdvisory,
  completeResponse,
  fenceInputs,
  revokeGrant,
} from "./vertex-research-chat-conversation-runtime.test-support.ts";
import {
  TIMEOUT,
  append,
  closures,
  contentInput,
  conversationFixture,
  eligibleResponse,
  head,
  history,
  inputIds,
  messages,
  observations,
  preparedPlan,
} from "./vertex-research-chat-conversation-runtime-suite.test-support.ts";

// SOURCE ONLY: no execution, PostgreSQL concurrency, live provider/storage or
// operational qualification claim. All positive conversation authority below
// comes from the original owners, never fabricated agent/history/authority rows.
// Preparing must be useful BEFORE future storage/model qualification exists.
describe("original conversation preparation and exact consent", () => {
  it(
    "prepares meaningful bound metadata without legacy unavailable receipt, copy, model or review effects",
    async () => {
      const f = await prepareFixture(),
        beforeOutbox = f.table("vertex_outbox").length;
      expect(
        await f.runtime.conversation.readResponse(owner, readSelector(f))
      ).toBeNull();
      const result = VertexResearchChatPrepareResponseOutputSchema.parse(
        await f.runtime.conversation.prepareResponse(owner, f.request)
      );
      expect(result.status).toBe("prepared");
      if (result.status !== "prepared")
        throw new Error("Original preapproval planning did not prepare");
      const plan = preparedPlan(f),
        preview = result.preview;
      expect(preview).toMatchObject({
        responseRequestId: f.responseRequestId,
        planId: plan.planId,
        planSha256: plan.planSha256,
        request: f.request,
        context: {
          messageIds: [f.request.parentMessageId],
          messageCount: 1,
          snapshotRevision: "2",
          contextStartSequence: "1",
          highWaterSequence: "1",
        },
        expert: { participantId: "jan-smolen" },
        corpus: {
          collectionId: "corpus",
          snapshotId: "snapshot",
          reviewPins: plan.reviewPins,
        },
        model: {
          providerId: "fixture-provider",
          modelVersion: "fixture-model",
          destination: {
            scheme: "https",
            hostname: "model.example.com",
            port: "",
          },
        },
        retention: {
          policyId: "chat-retention",
          guaranteedDeletionDeadline: null,
        },
        storage: {
          storageProfileSha256: plan.storageProfileSha256,
          namespace: "vertex/chat-copy/v1",
        },
      });
      expect(timestampToEpochNanoseconds(preview.checkedAt)).toBeLessThan(
        timestampToEpochNanoseconds(preview.notAfter)
      );
      const safe = canonicalArtifactJson(preview);
      for (const hidden of [
        SENTINELS.human,
        SENTINELS.excerpt,
        SENTINELS.persona,
        "credential-reference-only",
        "objectKey",
        "contentBase64",
      ])
        expect(safe).not.toContain(hidden);
      expect(f.copies.calls).toHaveLength(0);
      for (const table of [
        "vertex_research_chat_storage_reviews",
        "vertex_research_chat_execution_approvals",
        "vertex_research_chat_model_privacy_reviews",
        "vertex_research_chat_model_dispatches",
        "vertex_model_use_budget_reservations",
        "vertex_research_chat_worker_origins",
      ])
        expect(f.table(table)).toHaveLength(0);
      expect(f.table("vertex_outbox")).toHaveLength(beforeOutbox);
      expect(
        await f.runtime.conversation.readResponse(owner, readSelector(f))
      ).toBeNull();
      return expect(
        await f.runtime.conversation.prepareResponse(owner, f.request)
      ).toEqual(result);
    },
    TIMEOUT
  );
  for (const qualification of ["missing", "rejected"] as const)
    it(
      `${qualification} independent storage qualification blocks approval, not prepare`,
      async () => {
        const f = await prepareFixture(),
          prepared = await f.runtime.conversation.prepareResponse(
            owner,
            f.request
          );
        expect(prepared.status).toBe("prepared");
        const plan = preparedPlan(f);
        if (qualification === "rejected")
          await f.runtime.recordResearchChatStorageQualificationReview(
            reviewer,
            { ...f.reviewInput(plan), decision: "rejected" }
          );
        expect(
          await f.runtime.conversation.approveAndRequestResponse(
            owner,
            f.approveInput(plan)
          )
        ).toMatchObject({
          status: "blocked",
          reasonCodes: ["model-input-approval-unavailable"],
        });
        expect(f.copies.calls).toHaveLength(0);
        expect(
          f.table("vertex_research_chat_execution_approvals")
        ).toHaveLength(0);
        expect(
          f.table("vertex_research_chat_model_privacy_reviews")
        ).toHaveLength(0);
        expect(f.table("vertex_research_chat_model_dispatches")).toHaveLength(
          0
        );
        return expect(
          await f.runtime.conversation.readResponse(owner, readSelector(f))
        ).toBeNull();
      },
      TIMEOUT
    );
  for (const changed of ["plan-digest", "request"] as const)
    it(
      `rejects changed consent ${changed} before the first approval/copy effect`,
      async () => {
        const f = await prepareFixture();
        await f.runtime.conversation.prepareResponse(owner, f.request);
        const plan = preparedPlan(f),
          input = f.approveInput(plan);
        await f.runtime.recordResearchChatStorageQualificationReview(
          reviewer,
          f.reviewInput(plan)
        );
        const attempted =
          changed === "plan-digest"
            ? { ...input, planSha256: "f".repeat(64) }
            : {
                ...input,
                request: {
                  ...f.request,
                  retrievalQuery: "not-the-reviewed-preview",
                },
              };
        await expect(
          f.runtime.conversation.approveAndRequestResponse(owner, attempted)
        ).rejects.toMatchObject({
          code: changed === "plan-digest" ? "integrity" : "conflict",
        });
        expect(f.copies.calls).toHaveLength(0);
        expect(
          f.table("vertex_research_chat_execution_approvals")
        ).toHaveLength(0);
        return expect(
          await f.runtime.conversation.readResponse(owner, readSelector(f))
        ).toBeNull();
      },
      TIMEOUT
    );
  it(
    "rejects exact request/preview plan-pin drift and replays only its original admitted receipt",
    async () => {
      const f = await conversationFixture(),
        copies = f.copies.calls.length,
        outbox = f.table("vertex_outbox").length;
      expect(f.prepared).toMatchObject({ status: "prepared" });
      expect(f.approvalReceipt).toMatchObject({
        status: "recorded",
        receipt: f.admitted,
      });
      expect(f.admitted.status).toBe("admitted");
      for (const attempted of [
        { ...f.approveInput, planSha256: "f".repeat(64) },
        { ...f.approveInput, planId: "another-plan" },
        {
          ...f.approveInput,
          request: { ...f.request, retrievalQuery: "changed-after-consent" },
        },
        { ...f.approveInput, request: { ...f.request, snapshotRevision: "3" } },
      ])
        await expect(
          f.runtime.conversation.approveAndRequestResponse(owner, attempted)
        ).rejects.toMatchObject({ code: "conflict" });
      expect(
        await f.runtime.conversation.approveAndRequestResponse(
          owner,
          f.approveInput
        )
      ).toEqual(f.approvalReceipt);
      expect(f.copies.calls).toHaveLength(copies);
      expect(f.table("vertex_outbox")).toHaveLength(outbox);
      expect(f.table("vertex_research_chat_execution_approvals")).toHaveLength(
        1
      );
      expect(f.table("vertex_research_chat_worker_origins")).toHaveLength(1);
      expect(f.table("vertex_research_chat_model_dispatches")).toHaveLength(0);
      return expect(
        f.table("vertex_research_chat_model_privacy_reviews")
      ).toHaveLength(0);
    },
    TIMEOUT
  );
  it(
    "treats corrupted original preview plan hash as integrity, not a fresh consent or generic unavailable",
    async () => {
      const f = await prepareFixture();
      await f.runtime.conversation.prepareResponse(owner, f.request);
      f.table("vertex_research_chat_execution_plans")[0]!["record_hash"] =
        "e".repeat(64); // Negative external SQL corruption.
      await expect(
        f.runtime.conversation.approveAndRequestResponse(
          owner,
          f.approveInput(preparedPlan(f))
        )
      ).rejects.toMatchObject({ code: "integrity" });
      return expect(f.copies.calls).toHaveLength(0);
    },
    TIMEOUT
  );
  for (const qualification of ["missing", "rejected"] as const)
    it(
      `${qualification} per-operation model privacy review leaves admission real but dispatch and budget unconsumed`,
      async () => {
        const f = await conversationFixture();
        expect(f.admitted.status).toBe("admitted");
        expect(f.runAdmission).toMatchObject({
          status: "accepted",
          state: "running",
        });
        if (qualification === "rejected")
          await reviewModel(f, f.tokenizeRequest, "rejected");
        const [proof] = await Promise.allSettled([
          f.modelUseRequest(f.tokenizeRequest),
        ]);
        if (proof!.status === "fulfilled")
          expect(proof!.value).toMatchObject({
            decision: "denied",
            externalDispatchAllowed: false,
          });
        expect(f.table("vertex_research_chat_model_dispatches")).toHaveLength(
          0
        );
        expect(f.table("vertex_model_use_budget_reservations")).toHaveLength(0);
        return expect(
          f.copies.calls.filter(
            (call) =>
              call.operation === "create" &&
              call.copyId === f.recipe.copies.advisory.copyId
          )
        ).toHaveLength(0);
      },
      TIMEOUT
    );
});

describe("genuine worker output, explicit owner append and CAS", () => {
  it(
    "joins actual consent, grants, model audits, fourth copy, publication, terminal and three fences before an explicit bodyless append",
    async () => {
      const f = await eligibleResponse(),
        beforeMessages = f.table(messages).length,
        beforeHead = head(f);
      expect(f.advisory.providerCalls).toEqual([
        "model-tokenize",
        "model-completion",
      ]);
      expect(f.table("vertex_research_chat_model_dispatches")).toHaveLength(2);
      expect(f.table("vertex_model_use_budget_reservations")).toHaveLength(2);
      expect(
        f
          .table("vertex_worker_agent_publications")
          .filter((row) => row["run_id"] === f.plan.runId)
      ).toHaveLength(1);
      expect(
        f
          .table(observations)
          .filter((row) => row["operation"] === "fence")
          .map((row) => row["copy_id"])
          .sort()
      ).toEqual(inputIds(f).sort());
      for (let read = 0; read < 2; read += 1)
        expect(
          await f.runtime.conversation.readResponse(owner, readSelector(f))
        ).toMatchObject({
          receipt: f.admitted,
          job: { state: "succeeded" },
          delivery: { status: "eligible" },
        });
      expect(f.table(messages)).toHaveLength(beforeMessages);
      expect(head(f)).toBe(beforeHead);
      const appended = await append(f);
      expect(appended).toMatchObject({
        status: "appended",
        threadRevision: "3",
        message: {
          kind: "advisory-reference",
          sequence: "2",
          replyToMessageId: f.request.parentMessageId,
          parentMessageId: f.request.parentMessageId,
          author: {
            kind: "agent",
            participantId: "jan-smolen",
            runId: f.plan.runId,
          },
        },
      });
      expect(appended.message).not.toHaveProperty("body");
      expect(canonicalArtifactJson(appended)).not.toContain(answerText);
      const body = VertexResearchChatReadResponseContentOutputSchema.parse(
        await f.runtime.conversation.readResponseContent(
          owner,
          contentInput(f, appended.message.messageId)
        )
      );
      expect(body.status).toBe("available");
      if (body.status !== "available")
        throw new Error("Current private body unavailable");
      expect(body.sha256).toBe(f.advisory.contentSha256);
      expect(await hashArtifact(body.profile)).toBe(body.sha256);
      expect(body.byteLength).toBe(f.advisory.decoded.bytes.byteLength);
      expect(canonicalArtifactJson(body.profile)).toContain(answerText);
      expect(Object.keys(body.profile)).toHaveLength(13);
      expect(timestampToEpochNanoseconds(body.checkedAt)).toBeLessThan(
        timestampToEpochNanoseconds(body.notAfter)
      );
      expect(
        await f.runtime.conversation.readResponse(owner, readSelector(f))
      ).toMatchObject({
        delivery: {
          status: "appended",
          message: {
            messageId: appended.message.messageId,
            sequence: "2",
            threadRevision: "3",
          },
        },
      });
      expect(
        await f.runtime.conversation.appendResponse(owner, {
          ...f.selector,
          expectedRevision: "999",
        })
      ).toEqual(appended);
      expect(head(f)).toBe("3");
      expect(f.table(messages)).toHaveLength(beforeMessages + 1);
      return expect(
        f.copies.calls.filter(
          (call) =>
            call.operation === "create" &&
            call.copyId === f.recipe.copies.advisory.copyId
        )
      ).toHaveLength(1);
    },
    TIMEOUT
  );
  it(
    "does not append staged-only, unpublished, nonterminal or unfenced output",
    async () => {
      const f = await conversationFixture(),
        advisory = await consumeAndStageAdvisory(f);
      const denied = async () => {
        const result = await f.runtime.conversation.appendResponse(owner, {
          ...f.selector,
          expectedRevision: "2",
        });
        expect(result).toMatchObject({
          status: "unavailable",
          reasonCodes: ["projection-unavailable"],
        });
        expect(head(f)).toBe("2");
        return expect(f.table(messages)).toHaveLength(1);
      };
      await denied();
      await publishAdvisory(f, advisory);
      await denied();
      await completeResponse(f);
      await denied();
      await expect(
        f.runtime.drainApprovedCopyCleanup(owner, f.selector)
      ).rejects.toThrow();
      await fenceInputs(f);
      return expect((await append(f)).threadRevision).toBe("3");
    },
    TIMEOUT
  );
  it(
    "does not infer publication from a succeeded job, retained bytes and three real fence ACKs",
    async () => {
      const f = await eligibleResponse(),
        publications = f.table("vertex_worker_agent_publications");
      const index = publications.findIndex(
        (row) => row["run_id"] === f.plan.runId
      );
      expect(index).toBeGreaterThanOrEqual(0);
      publications.splice(index, 1); // Negative loss of the actual publication row.
      expect(
        await f.runtime.conversation.appendResponse(owner, {
          ...f.selector,
          expectedRevision: "2",
        })
      ).toMatchObject({
        status: "unavailable",
        reasonCodes: ["projection-unavailable"],
      });
      expect(head(f)).toBe("2");
      return expect(f.table(messages)).toHaveLength(1);
    },
    TIMEOUT
  );
  for (const index of [0, 1, 2])
    it(
      `requires real durable fence acknowledgement ${index + 1}, not just all external tombstones`,
      async () => {
        const f = await eligibleResponse(),
          id = inputIds(f)[index]!,
          acknowledgements = f.table(observations);
        const lost = acknowledgements.findIndex(
          (row) => row["operation"] === "fence" && row["copy_id"] === id
        );
        expect(lost).toBeGreaterThanOrEqual(0);
        acknowledgements.splice(lost, 1); // Negative missing original SQL ACK, no manufactured positive join.
        expect(
          await f.runtime.conversation.appendResponse(owner, {
            ...f.selector,
            expectedRevision: "2",
          })
        ).toMatchObject({ status: "unavailable" });
        expect(head(f)).toBe("2");
        return expect(f.table(messages)).toHaveLength(1);
      },
      TIMEOUT
    );
  it(
    "denies succeeded-unappended status and append when publish is revoked even though caller read remains authorized",
    async () => {
      const f = await eligibleResponse();
      expect(
        await f.runtime.conversation.readResponse(owner, readSelector(f))
      ).toMatchObject({ delivery: { status: "eligible" } });
      await f.grant(owner.actorId, "research-chat", ["read"]);
      await revokeGrant(f, "research-chat");
      for (const action of ["read", "publish"] as const)
        expect(
          await f.authorization.authorize({
            principal: owner,
            scope,
            collectionId: null,
            resourceId: "research-chat",
            action,
            now: f.state.at,
          })
        ).toBe(action === "read");
      expect(
        await f.store.readResearchChatThread(owner, scope, f.request.threadId)
      ).not.toBeNull();
      expect(await history(f)).toMatchObject({
        items: [{ sequence: "1", author: { kind: "user" } }],
      });
      await expect(
        f.runtime.conversation.readResponse(owner, readSelector(f))
      ).rejects.toMatchObject({ code: "denied" });
      await expect(
        f.runtime.conversation.appendResponse(owner, {
          ...f.selector,
          expectedRevision: "2",
        })
      ).rejects.toMatchObject({ code: "denied" });
      expect(head(f)).toBe("2");
      expect(f.table(messages)).toHaveLength(1);
      return expect(f.table(closures).map((row) => row["domain"])).toEqual([
        "inputs",
      ]);
    },
    TIMEOUT
  );
  it(
    "retries the same original operation after stale CAS; reply parent is not chronological predecessor",
    async () => {
      const f = await eligibleResponse(),
        h2 = await f.append("2", "human-between-response-and-append");
      await expect(
        f.runtime.conversation.appendResponse(owner, {
          ...f.selector,
          expectedRevision: "2",
        })
      ).rejects.toMatchObject({ code: "conflict" });
      expect(head(f)).toBe("3");
      const appended = await append(f, "3");
      expect(appended.message).toMatchObject({
        sequence: "3",
        replyToMessageId: f.request.parentMessageId,
        parentMessageId: (h2["message"] as { messageId: string }).messageId,
      });
      expect(appended.message.replyToMessageId).not.toBe(
        appended.message.parentMessageId
      );
      expect(
        await f.runtime.conversation.appendResponse(owner, {
          ...f.selector,
          expectedRevision: "2",
        })
      ).toEqual(appended);
      expect(head(f)).toBe("4");
      return expect(f.table(messages)).toHaveLength(3);
    },
    TIMEOUT
  );
});

describe("mixed history uses actual immutable agent references and original contiguous human windows", () => {
  it(
    "H1 A2 H3 H4 at head5 permits explicitly selected start3/snapshot5/parentH4",
    async () => {
      const f = await eligibleResponse(),
        agent = await append(f);
      const h3 = await f.append("3", "human-three"),
        h4 = await f.append("4", "human-four");
      expect(head(f)).toBe("5");
      const prepared = await f.runtime.conversation.prepareResponse(owner, {
        ...f.request,
        idempotencyKey: "after-reference",
        snapshotRevision: "5",
        contextStartSequence: "3",
        parentMessageId: (h4["message"] as { messageId: string }).messageId,
      });
      expect(prepared).toMatchObject({
        status: "prepared",
        preview: {
          context: {
            messageCount: 2,
            snapshotRevision: "5",
            contextStartSequence: "3",
            messageIds: [
              (h3["message"] as { messageId: string }).messageId,
              (h4["message"] as { messageId: string }).messageId,
            ],
          },
        },
      });
      const page = await history(f);
      return expect(page).toMatchObject({
        snapshotRevision: "5",
        highWaterSequence: "4",
        items: [
          { sequence: "1", author: { kind: "user" } },
          agent.message,
          { sequence: "3", author: { kind: "user" } },
          { sequence: "4", author: { kind: "user" } },
        ],
      });
    },
    TIMEOUT
  );
  it(
    "H1 H2 A3 at head4 permits historic human-ending snapshot3/H2 but rejects snapshot4/H2",
    async () => {
      const f = await eligibleResponse(),
        h2 = await f.append("2", "human-two");
      await append(f, "3");
      const selected = {
        ...f.request,
        idempotencyKey: "historic-human-context",
        snapshotRevision: "3",
        parentMessageId: (h2["message"] as { messageId: string }).messageId,
      };
      expect(
        await f.runtime.conversation.prepareResponse(owner, selected)
      ).toMatchObject({
        status: "prepared",
        preview: { context: { snapshotRevision: "3", messageCount: 2 } },
      });
      await expect(
        f.runtime.conversation.prepareResponse(owner, {
          ...selected,
          idempotencyKey: "invalid-agent-ending-context",
          snapshotRevision: "4",
        })
      ).rejects.toThrow();
      return expect(head(f)).toBe("4");
    },
    TIMEOUT
  );
  for (const corruption of ["record-hash", "provenance"] as const)
    it(
      `${corruption} damage is integrity failure, never an agent bypass`,
      async () => {
        const f = await eligibleResponse(),
          agent = await append(f);
        const row = f
          .table(messages)
          .find((entry) => entry["message_id"] === agent.message.messageId)!;
        if (corruption === "record-hash") {
          row["record_hash"] = "c".repeat(64);
        } else {
          // Change a true row, recomputing only its local hash. Original provenance
          // owners must still reject it; no positive fabricated agent is supplied.
          row["payload"] = {
            ...row["payload"],
            response: {
              ...row["payload"].response,
              planSha256: "d".repeat(64),
            },
          };
          row["record_hash"] = await hashArtifact(row["payload"]);
        }
        await expect(history(f)).rejects.toMatchObject({
          code: "integrity",
        });
        return await expect(
          f.runtime.conversation.readResponseContent(
            owner,
            contentInput(f, agent.message.messageId)
          )
        ).rejects.toMatchObject({ code: "integrity" });
      },
      TIMEOUT
    );
});
