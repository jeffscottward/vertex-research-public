import {
  owner,
  scope,
} from "./vertex-research-chat-execution-runtime.test-support.ts";
import { describe, expect, it } from "vitest";
import {
  canonicalArtifactJson,
  decimalUnits,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import {
  VertexResearchChatNativeEvidenceProtocolSchema,
  VertexResearchChatNativeEvidenceRequestSchema,
  VertexResearchChatNativeEvidenceApproveInputSchema,
} from "../contracts/vertex-research-chat-native-evidence.ts";
import { VertexResearchChatExecutionRequestSchema } from "../contracts/vertex-research-chat-execution.ts";
import { RuntimeResearchConfigurationSchema } from "../contracts/vertex-policy.ts";
import {
  consumeNativeEvidence,
  nativeProtocolFixture,
  nativeTables,
} from "./native-evidence.test-support.ts";
import {
  completeResponse,
  prepareFixture,
  readSelector,
} from "./vertex-research-chat-conversation-runtime.test-support.ts";
import {
  pinnedPython,
  RESEARCH_SDK_DISTRIBUTIONS,
} from "./research-python.test-support.ts";
import { scaledTimeout } from "../../../../scripts/lib/test-timeout-scale.ts";

const TIMEOUT = scaledTimeout(180_000);
// consumeNativeEvidence runs the real SDK invoke path in a Python child; it
// cannot run without the pinned research SDK stack, so those cases skip.
const requireNativeSdk = (
  skip: (condition: boolean, note?: string) => void
): void => {
  const sdk = pinnedPython(RESEARCH_SDK_DISTRIBUTIONS);
  skip(sdk.skip, sdk.note);
};
const history = (f: Awaited<ReturnType<typeof nativeProtocolFixture>>) =>
  f.store.readResearchChatTranscriptPage(owner, scope, f.request.threadId, {
    limit: 100,
    cursor: null,
  });
const noPublishedNativeAnswer = async (
  f: Awaited<ReturnType<typeof nativeProtocolFixture>>,
  expired = false
): Promise<void> => {
  if (expired) {
    await expect(history(f)).rejects.toMatchObject({ code: "denied" });
    expect(
      f
        .table("vertex_research_chat_messages")
        .filter(
          (row) =>
            row["thread_id"] === f.request.threadId &&
            row["payload"]?.author?.kind === "agent"
        )
    ).toHaveLength(0);
    return;
  }
  const page = await history(f);
  if (!page) throw new Error("Transcript page absent");
  const items = page["items"] as readonly { author: { kind: string } }[];
  expect(items.every((item) => item.author.kind === "user")).toBe(true);
};

describe("FirstMate bounded native evidence real-owner composition", () => {
  it(
    "connects exact consent/storage/nine copies/same job through two native completions, one local result, independent phase-two authority, four conservative charges and private bodyless publication",
    async ({ skip }) => {
      requireNativeSdk(skip);
      const observed: string[] = [];
      const f = await nativeProtocolFixture({
        observeOperation: async (
          label: string,
          operation: () => Promise<unknown>
        ) => {
          observed.push(label);
          return operation();
        },
      });
      expect(f.prepared?.status).toBe("prepared");
      expect(f.approvalReceipt?.status).toBe("recorded");
      expect(observed.indexOf("previewPrepare")).toBeLessThan(
        observed.indexOf("storageReview")
      );
      expect(observed.indexOf("storageReview")).toBeLessThan(
        observed.indexOf("approvalAdmission")
      );
      expect(f.approveInput).toMatchObject({
        consent: "approve-bounded-native-evidence-protocol-v1",
        request: { protocol: "first-mate-read-reviewed-evidence-v1" },
      });
      expect(f.recipe.profile).toBe(
        "vertex-research-chat-native-evidence-job-v1"
      );
      expect(f.selection.research?.allowedTools).toEqual(["read-evidence"]);
      expect(Object.keys(f.recipe.copies).sort()).toEqual(
        [
          "advisory",
          "completionInput",
          "context",
          "evidenceBundle",
          "phaseOneResponse",
          "phaseTwoCompletionInput",
          "phaseTwoTokenizeInput",
          "tokenizeInput",
          "toolResult",
        ].sort()
      );
      expect(f.table(nativeTables.charges)).toHaveLength(0);
      expect(f.table(nativeTables.phases)).toHaveLength(1);
      const beforeHistory = canonicalArtifactJson(await history(f));
      const done = await consumeNativeEvidence(f);
      expect(done.denied).toBeNull();
      expect(done.outcome).toMatchObject({
        status: "completed",
        outputArtifactIds: [f.plan.runId],
        executionAuthorized: false,
      });
      expect(done.completions).toBe(2);
      expect(done.tokenizers).toBe(2);
      expect(done.sends.map((send: { path: string }) => send.path)).toEqual([
        "/tokenize",
        "/v1/chat/completions",
        "/tokenize",
        "/v1/chat/completions",
      ]);
      expect(
        done.methods.filter(
          (method: string) => method === "prepareNativeEvidencePhaseTwo"
        )
      ).toHaveLength(1);
      expect(done.prepared).toHaveLength(1);
      const phases = f
        .table(nativeTables.phases)
        .map((row) => row["payload"])
        .sort((a, b) => a.phaseOrdinal - b.phaseOrdinal);
      expect(phases).toHaveLength(2);
      expect(phases[0]).toMatchObject({
        responseRequestId: f.responseRequestId,
        planSha256: f.plan.planSha256,
        phaseOrdinal: 1,
        derivation: null,
      });
      expect(phases[1]).toMatchObject({
        responseRequestId: f.responseRequestId,
        planSha256: f.plan.planSha256,
        phaseOrdinal: 2,
        derivation: { toolName: "read_reviewed_evidence" },
      });
      expect(phases[0].completionInput.sha256).not.toBe(
        phases[1].completionInput.sha256
      );
      expect(done.sends.map((send: { sha256: string }) => send.sha256)).toEqual(
        [
          phases[0].tokenizeInput.sha256,
          phases[0].completionInput.sha256,
          phases[1].tokenizeInput.sha256,
          phases[1].completionInput.sha256,
        ]
      );
      expect(done.prepared[0].copies.toolResult.sha256).toBe(
        phases[1].derivation.toolResultSha256
      );
      const finalOrigin = f
        .table("vertex_research_chat_advisory_origins")
        .find((row) => row["response_request_id"] === f.responseRequestId)![
        "payload"
      ];
      expect(finalOrigin).toMatchObject({
        profile: "vertex-research-chat-native-evidence-advisory-origin-v1",
        jobId: f.lease.jobId,
        nativeChain: {
          phaseTwoSha256: phases[1].phaseSha256,
          derivationSha256: await hashArtifact(phases[1].derivation),
        },
      });
      expect(finalOrigin.modelUseRequestSha256).toBe(
        done.reviewed[3].review.request.requestSha256
      );
      expect(
        done.reviewed.map((entry: any) => [
          entry.review.nativePhase.phaseOrdinal,
          entry.review.request.operation,
        ])
      ).toEqual([
        [1, "model-tokenize"],
        [1, "model-completion"],
        [2, "model-tokenize"],
        [2, "model-completion"],
      ]);
      expect(
        new Set(done.reviewed.map((entry: any) => entry.candidateId)).size
      ).toBe(4);
      for (const entry of done.reviewed) {
        expect(entry.review.request).toMatchObject({
          ...f.fence,
          researchPrincipalId: owner.actorId,
        });
        expect(entry.review.nativePhase.phaseSha256).toBe(
          phases[entry.review.nativePhase.phaseOrdinal - 1].phaseSha256
        );
        const resourceId = `research-chat-model-privacy:${f.responseRequestId}:phase-${entry.review.nativePhase.phaseOrdinal}:${entry.review.request.operation}`;
        expect(
          f
            .table("vertex_grant_bindings")
            .some(
              (row) =>
                row["grantee_actor_id"] === f.privacyReviewer.actorId &&
                row["resource_id"] === resourceId
            )
        ).toBe(true);
      }
      expect(f.table(nativeTables.candidates)).toHaveLength(4);
      expect(f.table(nativeTables.dispatches)).toHaveLength(4);
      const charges = f.table(nativeTables.charges);
      expect(charges).toHaveLength(4);
      expect(
        new Set(charges.map((row) => row["payload"].request.jobId))
      ).toEqual(new Set([f.lease.jobId]));
      expect(new Set(charges.map((row) => row["request_sha256"])).size).toBe(4);
      expect(
        charges.reduce((sum, row) => sum + BigInt(row["token_charge"]), 0n)
      ).toBe(768n);
      expect(
        charges.reduce((sum, row) => sum + BigInt(row["cost_charge_units"]), 0n)
      ).toBe(decimalUnits("0.22"));
      for (const row of charges) {
        expect(row["token_charge"].toString()).toBe(
          row["payload"].request.operation === "model-tokenize" ? "128" : "256"
        );
        expect(BigInt(row["cost_charge_units"])).toBe(
          decimalUnits(row["payload"].grant.maximumCostUsd)
        );
        expect(await hashArtifact(row["payload"])).toBe(row["record_hash"]);
      }
      expect(canonicalArtifactJson(await history(f))).toBe(beforeHistory);
      await completeResponse(f);
      const cleaner = await f.grantCleanup();
      const cleanup = await f.runtime.drainApprovedCopyCleanup(
        cleaner,
        f.selector
      );
      expect(cleanup).toHaveLength(8);
      expect(cleanup.every((result) => result.status === "fenced")).toBe(true);
      const appended = await f.runtime.conversation.appendResponse(owner, {
        ...f.selector,
        expectedRevision: "2",
      });
      expect(appended.status).toBe("appended");
      if (appended.status !== "appended")
        throw new Error("Native advisory was not appended");
      const content = await f.runtime.conversation.readResponseContent(owner, {
        ...f.selector,
        messageId: appended.message.messageId,
      });
      expect(content.status).toBe("available");
      if (content.status !== "available")
        throw new Error("Native private content unavailable");
      expect(content.profile).toMatchObject({
        profile: "vertex-research-chat-native-evidence-advisory-v1",
        responseRequestId: f.responseRequestId,
        planSha256: f.plan.planSha256,
        modelUseRequestSha256: done.reviewed[3].review.request.requestSha256,
        executionAuthorized: false,
      });
      expect(await hashArtifact(content.profile)).toBe(content.sha256);
      const other = { actorId: "native-other-owner" };
      await f.grant(other.actorId, "account-scope", ["read"]);
      await f.grant(other.actorId, "research-chat", ["read"]);
      await expect(
        f.runtime.conversation.readResponseContent(other, {
          ...f.selector,
          messageId: appended.message.messageId,
        })
      ).rejects.toMatchObject({ code: "denied" });
      await expect(
        f.runtime.conversation.readResponseContent(owner, {
          ...f.selector,
          threadId: "unrelated-thread",
          messageId: appended.message.messageId,
        })
      ).rejects.toMatchObject({ code: "denied" });
      const transcript = canonicalArtifactJson(await history(f));
      for (const hidden of [
        "Synthetic bounded finding.",
        "synthetic-reviewed-call",
        "tool_calls",
        "contentBase64",
        "phaseTwoCompletionInput",
        "toolResult",
      ])
        expect(transcript).not.toContain(hidden);
      return expect(f.table(nativeTables.charges)).toHaveLength(4);
    },
    TIMEOUT
  );
  it(
    "rejects profile and consent drift while ordinary FirstMate prepare remains unchanged",
    async () => {
      const f = await prepareFixture("first-mate");
      const unavailable =
        await f.runtime.conversation.prepareResearchChatNativeEvidence(owner, {
          ...f.request,
          protocol: "first-mate-read-reviewed-evidence-v1",
        });
      expect(unavailable.status).toBe("unavailable");
      expect(f.copies.calls).toHaveLength(0);
      const ordinary = await f.runtime.conversation.prepareResponse(
        owner,
        f.request
      );
      expect(ordinary.status).toBe("prepared");
      expect(VertexResearchChatExecutionRequestSchema.parse(f.request)).toEqual(
        f.request
      );
      expect(f.selection.research?.allowedTools).toEqual([]);
      expect(
        RuntimeResearchConfigurationSchema.safeParse({
          ...f.selection.research,
          allowedTools: ["read-evidence"],
        }).success
      ).toBe(true);
      expect(
        RuntimeResearchConfigurationSchema.safeParse({
          ...f.selection.research,
          allowedTools: ["read_reviewed_evidence"],
        }).success
      ).toBe(false);
      expect(
        VertexResearchChatNativeEvidenceRequestSchema.safeParse(f.request)
          .success
      ).toBe(false);
      expect(
        VertexResearchChatNativeEvidenceApproveInputSchema.safeParse({
          planId: "plan",
          planSha256: "a".repeat(64),
          request: {
            ...f.request,
            protocol: "first-mate-read-reviewed-evidence-v1",
          },
        }).success
      ).toBe(false);
      expect(
        VertexResearchChatNativeEvidenceProtocolSchema.safeParse({
          profile: "vertex-first-mate-review-rendezvous-adapter-config-v1",
        }).success
      ).toBe(false);
      expect(f.table(nativeTables.phases)).toHaveLength(0);
      expect(f.table(nativeTables.charges)).toHaveLength(0);
      return expect(
        await f.runtime.conversation.readResponse(owner, readSelector(f))
      ).toBeNull();
    },
    TIMEOUT
  );
  it.for([
    "phase-drift",
    "input-drift",
    "missing-authority",
    "reused-authority",
    "revocation",
    "expiry",
  ] as const)(
    "blocks phase-two %s without a second completion or published answer",
    { timeout: TIMEOUT },
    async (scenario, { skip }) => {
      requireNativeSdk(skip);
      const f = await nativeProtocolFixture(),
        done = await consumeNativeEvidence(f, scenario);
      expect(done.outcome.status).not.toBe("completed");
      expect(done.completions).toBe(1);
      expect(done.tokenizers).toBeLessThanOrEqual(2);
      expect(done.prepared).toHaveLength(1);
      expect(f.table(nativeTables.phases)).toHaveLength(2);
      // The privacy owner rejoins every reviewer grant when the worker
      // submits a candidate, so absent phase-two authority denies the phase-two
      // prepare itself; later losses deny the worker's review poll instead.
      expect(done.denied).toMatchObject({
        method:
          scenario === "input-drift" || scenario === "missing-authority"
            ? "prepareModelPrivacyReview"
            : "readModelPrivacyReview",
        status: expect.any(Number),
      });
      expect(f.table(nativeTables.charges)).toHaveLength(2);
      expect(
        done.reviewed.filter(
          (entry: any) => entry.review.nativePhase.phaseOrdinal === 2
        )
      ).toHaveLength(0);
      return await noPublishedNativeAnswer(f, scenario === "expiry");
    }
  );
  it.for(["invalid-call", "multiple-calls", "forged-proof"] as const)(
    "rejects %s before any local result or phase-two dispatch",
    { timeout: TIMEOUT },
    async (scenario, { skip }) => {
      requireNativeSdk(skip);
      const f = await nativeProtocolFixture(),
        done = await consumeNativeEvidence(f, scenario);
      expect(done.outcome.status).not.toBe("completed");
      expect(done.completions).toBe(1);
      expect(done.prepared).toHaveLength(0);
      if (scenario === "forged-proof")
        expect(done.denied).toMatchObject({
          method: "prepareNativeEvidencePhaseTwo",
          status: expect.any(Number),
        });
      expect(f.table(nativeTables.phases)).toHaveLength(1);
      expect(f.table(nativeTables.charges)).toHaveLength(2);
      return await noPublishedNativeAnswer(f);
    }
  );
  it(
    "retains unknown charges and rejects same-job replay without a replacement provider send",
    async ({ skip }) => {
      requireNativeSdk(skip);
      const f = await nativeProtocolFixture(),
        first = await consumeNativeEvidence(f, "unknown-outcome");
      expect(first.outcome.status).toBe("unknown");
      expect(first.completions).toBe(1);
      const charges = canonicalArtifactJson(f.table(nativeTables.charges));
      expect(f.table(nativeTables.charges)).toHaveLength(2);
      const replay = await consumeNativeEvidence(f, "unknown-outcome");
      expect(replay.outcome.status).not.toBe("completed");
      expect(replay.sends).toHaveLength(0);
      expect(canonicalArtifactJson(f.table(nativeTables.charges))).toBe(
        charges
      );
      return await noPublishedNativeAnswer(f);
    },
    TIMEOUT
  );
  it(
    "refuses the fourth charge at the same-job conservative budget ceiling",
    async ({ skip }) => {
      requireNativeSdk(skip);
      const f = await nativeProtocolFixture({
          nativeEvidence: "bounded-budget",
        }),
        done = await consumeNativeEvidence(f, "budget-exhaustion");
      expect(done.outcome.status).not.toBe("completed");
      expect(done.completions).toBe(1);
      expect(f.table(nativeTables.charges)).toHaveLength(3);
      expect(
        f
          .table(nativeTables.charges)
          .reduce((sum, row) => sum + BigInt(row["cost_charge_units"]), 0n)
      ).toBe(decimalUnits("0.12"));
      return await noPublishedNativeAnswer(f);
    },
    TIMEOUT
  );
  it.for(["undelivered-citation", "further-call"] as const)(
    "rejects final %s after phase-two HTTP while retaining all four charges",
    { timeout: TIMEOUT },
    async (scenario, { skip }) => {
      requireNativeSdk(skip);
      const f = await nativeProtocolFixture(),
        done = await consumeNativeEvidence(f, scenario);
      expect(done.outcome.status).not.toBe("completed");
      expect(done.completions).toBe(2);
      expect(f.table(nativeTables.charges)).toHaveLength(4);
      return await noPublishedNativeAnswer(f);
    }
  );
  it.for(["forged-final-proof", "missing-phase-one-audit"] as const)(
    "denies final provenance %s after both completions without publishing or releasing charges",
    { timeout: TIMEOUT },
    async (scenario, { skip }) => {
      requireNativeSdk(skip);
      const f = await nativeProtocolFixture(),
        done = await consumeNativeEvidence(f, scenario);
      expect(done.finalFaults).toEqual([scenario]);
      expect(done.completions).toBe(2);
      expect(done.reviewed).toHaveLength(4);
      expect(done.prepared).toHaveLength(1);
      expect(done.denied).toMatchObject({
        method: "stageArtifact",
        status: expect.any(Number),
      });
      expect(done.outcome.status).not.toBe("completed");
      expect(f.table(nativeTables.charges)).toHaveLength(4);
      expect(f.table("vertex_research_chat_advisory_origins")).toHaveLength(0);
      return await noPublishedNativeAnswer(f);
    }
  );
});
