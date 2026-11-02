import { describe, expect, it } from "vitest";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { createVertexResearchChatExecutionRuntime } from "./vertex-research-chat-execution-runtime.ts";
import { chatWorkerFixture } from "./vertex-research-chat-worker-runtime.test-support.ts";
import {
  AT,
  END,
  owner,
  scope,
} from "./vertex-research-chat-execution-runtime.test-support.ts";
import {
  prepareFixture,
  consumeAndStageAdvisory,
  publishAdvisory,
  completeResponse,
  fenceInputs,
} from "./vertex-research-chat-conversation-runtime.test-support.ts";
import { decodeResearchChatAdvisoryOutput } from "./vertex-research-chat-output-parser.ts";
import { getResearchChatRoster } from "./vertex-research-chat.ts";
import {
  VertexResearchChatFirstMateConfigurationV1Schema,
  VertexResearchChatExpertConfigurationV1Schema,
  VertexResearchChatParticipantConfigurationV1Schema,
  VertexResearchChatPlanV1Schema,
} from "../contracts/vertex-research-chat-execution.ts";
import {
  VertexResearchChatAdvisoryAvailabilitySchema,
  VertexResearchChatRosterEntrySchema,
} from "../contracts/vertex-research-chat.ts";
import {
  VertexResearchChatAppendResponseOutputSchema,
  VertexResearchChatReadResponseContentOutputSchema,
} from "../contracts/vertex-research-chat-conversation.ts";
import { VertexResearchChatDebateConfigurationV1Schema } from "../contracts/vertex-research-chat-debate.ts";
import { ResearchEvidenceSchema } from "../contracts/vertex.ts";

// Source-only composition: real input/admission/approval/privacy/copy/parser and
// publication/read owners, synthetic SQL/object/provider transport and history.
// No operational Agno, provider, DB, worker host or scientific acceptance claim.
const TIMEOUT = 120_000;
const encode = (value: unknown) =>
  new TextEncoder().encode(canonicalArtifactJson(value));

describe("First Mate governed single-turn advisory", () => {
  it(
    "uses actual admission, tool-free producer, independent reviews, parser and owned private read",
    async () => {
      const f = await chatWorkerFixture({
        admissionPath: "conversation",
        participantId: "first-mate",
      });
      const evidence = ResearchEvidenceSchema.parse(f.corpus.value);
      const citation = {
        evidence_id: evidence.evidenceId,
        source_id: evidence.sourceIdentity.sourceId,
        source_snapshot_id: evidence.sourceIdentity.snapshotId,
        content_hash: evidence.contentHash,
        excerpt_digest: await hashArtifact(
          new TextEncoder().encode(evidence.claim)
        ),
        quote: evidence.claim.slice(0, 32),
      };
      const proposal = {
        proposal_id: "first-mate-backtest-intent",
        kind: "backtest-request",
        title: "Review the configured historical backtest",
        rationale: {
          text: "A hypothetical backtest could examine this research question.",
          kind: "hypothesis",
          citations: [citation],
        },
        execution_authorized: false,
      };
      expect(f.runtimeOptions.experts).toEqual([]);
      expect(
        VertexResearchChatFirstMateConfigurationV1Schema.parse(f.config.value)
      ).toMatchObject({
        participantId: "first-mate",
        mode: "single-turn-advisory",
      });
      expect(f.prepared).toMatchObject({
        status: "prepared",
        preview: { expert: { participantId: "first-mate" } },
      });
      expect(f.admitted).toMatchObject({
        status: "admitted",
        participantId: "first-mate",
      });
      expect(f.plan.format).toBe("vertex-research-chat-plan-v1");
      // Real admission is not model-use permission: no independent privacy review yet.
      const [unreviewed] = await Promise.allSettled([
        f.modelUseRequest(f.tokenizeRequest),
      ]);
      if (unreviewed!.status === "fulfilled")
        expect(unreviewed!.value).toMatchObject({
          decision: "denied",
          externalDispatchAllowed: false,
        });
      expect(f.table("vertex_research_chat_model_dispatches")).toHaveLength(0);
      expect(f.table("vertex_model_use_budget_reservations")).toHaveLength(0);
      const advisory = await consumeAndStageAdvisory(f, undefined, [proposal]);
      const completion = JSON.parse(
        new TextDecoder().decode(advisory.completionInputBytes)
      );
      const content = JSON.parse(completion.messages[1].content);
      expect(completion.tool_choice).toBe("none");
      expect(completion).not.toHaveProperty("tools");
      expect(content.inert_tool_names).toEqual([]);
      expect(content.data.tool_results).toEqual([]);
      expect(content.data.human_context.participant_id).toBe("first-mate");
      expect(advisory.request.tools).toEqual([]);
      expect(advisory.decoded.profile).toMatchObject({
        responseRequestId: f.responseRequestId,
        planSha256: f.plan.planSha256,
        output: { proposals: [proposal], execution_authorized: false },
        executionAuthorized: false,
      });
      expect(advisory.decoded.profile).not.toHaveProperty("tool_requests");
      expect(advisory.decoded.profile).not.toHaveProperty("tool_results");
      expect(advisory.providerCalls).toEqual([
        "model-tokenize",
        "model-completion",
      ]);
      expect(f.table("vertex_research_chat_model_dispatches")).toHaveLength(2);
      expect(f.table("vertex_model_use_budget_reservations")).toHaveLength(2);
      // Same real parser still rejects native calls and inert request transport.
      const parserInput = {
        plan: f.plan,
        configuration: VertexResearchChatParticipantConfigurationV1Schema.parse(
          f.config.value
        ),
        request: advisory.request,
        responseBytes: advisory.responseBytes,
        completionInputBytes: advisory.completionInputBytes,
        modelPolicy: f.modelPolicy.value,
      };
      const native = JSON.parse(
        new TextDecoder().decode(advisory.responseBytes)
      );
      native.choices[0].message.tool_calls = [
        {
          id: "untrusted",
          type: "function",
          function: { name: "request-backtest", arguments: "{}" },
        },
      ];
      await expect(
        decodeResearchChatAdvisoryOutput({
          ...parserInput,
          responseBytes: encode(native),
        })
      ).rejects.toThrow();
      const inert = JSON.parse(
        new TextDecoder().decode(advisory.responseBytes)
      );
      const inertBody = JSON.parse(inert.choices[0].message.content);
      inertBody.tool_requests = [
        { tool_name: "request-backtest", arguments: {} },
      ];
      inert.choices[0].message.content = canonicalArtifactJson(inertBody);
      await expect(
        decodeResearchChatAdvisoryOutput({
          ...parserInput,
          responseBytes: encode(inert),
        })
      ).rejects.toThrow();
      await publishAdvisory(f, advisory);
      await completeResponse(f);
      await fenceInputs(f);
      const appended = VertexResearchChatAppendResponseOutputSchema.parse(
        await f.runtime.conversation.appendResponse(owner, {
          ...f.selector,
          expectedRevision: "2",
        })
      );
      expect(appended.status).toBe("appended");
      if (appended.status !== "appended")
        throw new Error("Actual First Mate reference was not appended");
      expect(appended.message.author).toMatchObject({
        kind: "agent",
        participantId: "first-mate",
      });
      expect(appended.message).not.toHaveProperty("body");
      const input = { ...f.selector, messageId: appended.message.messageId };
      const body = VertexResearchChatReadResponseContentOutputSchema.parse(
        await f.runtime.conversation.readResponseContent(owner, input)
      );
      expect(body.status).toBe("available");
      if (body.status !== "available")
        throw new Error("Actual private First Mate output unavailable");
      expect(body.sha256).toBe(advisory.contentSha256);
      expect(await hashArtifact(body.profile)).toBe(body.sha256);
      expect(body.profile).toMatchObject({
        responseRequestId: f.responseRequestId,
        planSha256: f.plan.planSha256,
        output: { proposals: [proposal] },
        executionAuthorized: false,
      });
      await expect(
        f.runtime.conversation.readResponseContent(
          { actorId: "unrelated-actor" },
          input
        )
      ).rejects.toThrow();
      await expect(
        f.runtime.conversation.readResponseContent(owner, {
          ...input,
          threadId: "wrong-thread",
        })
      ).rejects.toThrow();
      const transcript = await f.store.readResearchChatTranscriptPage(
        owner,
        scope,
        f.request.threadId,
        { limit: 100, cursor: null }
      );
      expect(canonicalArtifactJson(transcript)).not.toContain(
        proposal.proposal_id
      );
      return expect(
        f
          .table("vertex_worker_jobs")
          .filter(
            (row) =>
              row["kind"] === "backtest-run" ||
              row["payload"]?.kind === "backtest-run"
          )
      ).toHaveLength(0);
    },
    TIMEOUT
  );
  it(
    "observes explicit configuration without readiness or context consent and denies absent pins, invalid role, scope and expiry",
    async () => {
      const f = await prepareFixture("first-mate");
      const beforeOutbox = f.table("vertex_outbox").length;
      expect(
        await f.runtime.conversation.readFirstMateAdvisoryConfiguration(
          owner,
          scope
        )
      ).toEqual({
        status: "configured",
        authorization: "requires-governed-prepare",
        reasonCodes: ["governed-prepare-required"],
      });
      const roster = await getResearchChatRoster(
        {
          store: f.store,
          authorization: f.authorization,
          clock: f.runtimeOptions.clock,
        },
        { userId: owner.actorId, role: "member", status: "active" },
        scope,
        f.runtime.conversation
      );
      expect(
        roster.participants.find(
          (entry) => entry.participantId === "first-mate"
        )
      ).toMatchObject({
        kind: "first-mate",
        availability: "unavailable",
        corpus: { status: "unknown" },
        advisory: {
          status: "configured",
          authorization: "requires-governed-prepare",
        },
      });
      expect(
        roster.participants
          .filter((entry) => entry.kind === "expert")
          .every(
            (entry) =>
              entry.advisory === undefined &&
              entry.availability === "unavailable"
          )
      ).toBe(true);
      expect(f.table("vertex_research_chat_execution_plans")).toHaveLength(0);
      expect(f.table("vertex_research_chat_execution_approvals")).toHaveLength(
        0
      );
      expect(f.copies.calls).toHaveLength(0);
      const { firstMate: omitted, ...withoutMate } = f.runtimeOptions;
      expect(omitted).toBeDefined();
      const missing = createVertexResearchChatExecutionRuntime({
        ...withoutMate,
        db: f.db,
        experts: [{ participantId: "first-mate", artifact: f.config.pin }],
      });
      expect(
        await missing.conversation.readFirstMateAdvisoryConfiguration(
          owner,
          scope
        )
      ).toMatchObject({ status: "unavailable" });
      await expect(
        missing.planResearchChatResponse(owner, f.request)
      ).rejects.toThrow();
      const configs = [
        {
          label: "wrong-scope",
          value: { ...f.config.value, accountAlias: "other-account" },
        },
        { label: "expired", value: { ...f.config.value, expiresAt: AT } },
        {
          label: "wrong-participant",
          value: { ...f.config.value, participantId: "jan-smolen" },
        },
        { label: "wrong-mode", value: { ...f.config.value, mode: "debate" } },
        {
          label: "expert-format",
          value: {
            ...f.config.value,
            format: "vertex-research-chat-expert-configuration-v1",
          },
        },
      ];
      for (const entry of configs) {
        const artifact = await f.artifact(
          `first-mate-${entry.label}`,
          entry.value,
          "ResearchChatFirstMateConfiguration"
        );
        const runtime = createVertexResearchChatExecutionRuntime({
          ...f.runtimeOptions,
          db: f.db,
          firstMate: { artifact: artifact.pin },
        });
        expect(
          await runtime.conversation.readFirstMateAdvisoryConfiguration(
            owner,
            scope
          )
        ).toMatchObject({ status: "unavailable" });
        await expect(
          runtime.planResearchChatResponse(owner, f.request)
        ).rejects.toThrow();
      }
      for (const artifact of [
        { ...f.config.pin, artifactId: "missing-config" },
        { ...f.config.pin, artifactSha256: "f".repeat(64) },
      ]) {
        const runtime = createVertexResearchChatExecutionRuntime({
          ...f.runtimeOptions,
          db: f.db,
          firstMate: { artifact },
        });
        expect(
          await runtime.conversation.readFirstMateAdvisoryConfiguration(
            owner,
            scope
          )
        ).toMatchObject({ status: "unavailable" });
        await expect(
          runtime.planResearchChatResponse(owner, f.request)
        ).rejects.toThrow();
      }
      expect(f.table("vertex_research_chat_execution_plans")).toHaveLength(0);
      expect(f.table("vertex_research_chat_execution_approvals")).toHaveLength(
        0
      );
      expect(f.table("vertex_outbox")).toHaveLength(beforeOutbox);
      expect(f.copies.calls).toHaveLength(0);
      const prepared = await f.runtime.conversation.prepareResponse(
        owner,
        f.request
      );
      expect(prepared.status).toBe("prepared");
      const plan = VertexResearchChatPlanV1Schema.parse(
        f.table("vertex_research_chat_execution_plans")[0]!["payload"]
      );
      // Negative branch probes use the real owner, not fabricated source authority.
      await expect(
        f.db.transaction((tx) =>
          f.runtime.output.recheckSourceInputsForPlan(
            tx,
            owner,
            plan,
            {} as never,
            AT
          )
        )
      ).rejects.toMatchObject({ code: "denied" });
      await expect(
        f.db.transaction((tx) =>
          f.runtime.output.recheckSourceInputsForPlan(
            tx,
            owner,
            { ...plan, format: "vertex-research-chat-plan-v2" },
            undefined,
            AT
          )
        )
      ).rejects.toMatchObject({ code: "denied" });
      expect(
        await f.runtime.conversation.approveAndRequestResponse(
          owner,
          f.approveInput(plan)
        )
      ).toMatchObject({ status: "blocked" });
      expect(f.table("vertex_research_chat_execution_approvals")).toHaveLength(
        0
      );
      return expect(f.copies.calls).toHaveLength(0);
    },
    TIMEOUT
  );
  it(
    "keeps expert contracts strict, rejects First Mate debate and labels configuration as non-authority",
    async () => {
      const f = await prepareFixture();
      expect(
        VertexResearchChatExpertConfigurationV1Schema.parse(f.config.value)
      ).toEqual(
        VertexResearchChatParticipantConfigurationV1Schema.parse(f.config.value)
      );
      expect(f.runtimeOptions).not.toHaveProperty("firstMate");
      expect(
        VertexResearchChatExpertConfigurationV1Schema.safeParse({
          ...f.config.value,
          participantId: "first-mate",
        }).success
      ).toBe(false);
      expect(
        VertexResearchChatFirstMateConfigurationV1Schema.safeParse(
          f.config.value
        ).success
      ).toBe(false);
      expect(
        await f.runtime.conversation.readFirstMateAdvisoryConfiguration(
          owner,
          scope
        )
      ).toMatchObject({ status: "unavailable" });
      expect(
        await f.runtime.conversation.prepareResponse(owner, f.request)
      ).toMatchObject({
        status: "prepared",
        preview: { expert: { participantId: "jan-smolen" } },
      });
      const advisory = VertexResearchChatAdvisoryAvailabilitySchema.parse({
        status: "configured",
        authorization: "requires-governed-prepare",
        reasonCodes: ["governed-prepare-required"],
      });
      const roster = {
        participantId: "first-mate",
        displayName: "First Mate",
        specialty: "Single-turn advisory",
        kind: "first-mate",
        availability: "unavailable",
        reasonCodes: ["tools-not-integrated"],
        corpus: {
          status: "unknown",
          collectionId: null,
          snapshotSha256: null,
          reviewId: null,
        },
        advisory,
      };
      expect(
        VertexResearchChatRosterEntrySchema.safeParse(roster).success
      ).toBe(true);
      expect(
        VertexResearchChatRosterEntrySchema.safeParse({
          ...roster,
          availability: "ready",
        }).success
      ).toBe(false);
      expect(
        VertexResearchChatRosterEntrySchema.safeParse({
          ...roster,
          kind: "expert",
          participantId: "jan-smolen",
        }).success
      ).toBe(false);
      expect(
        VertexResearchChatAdvisoryAvailabilitySchema.safeParse({
          ...advisory,
          reasonCodes: ["first-mate-configuration-unavailable"],
        }).success
      ).toBe(false);
      // The existing debate participant field continues to reject this role.
      const debate = VertexResearchChatDebateConfigurationV1Schema.parse({
        profile: "vertex-research-chat-debate-configuration-v1",
        ...scope,
        configurationId: "expert-debate",
        participantIds: ["jan-smolen", "imre-gams"],
        synthesizerId: "jan-smolen",
        turnTokens: 100,
        turnCostUsd: "0.1",
        aggregateTokens: 500,
        aggregateCostUsd: "0.5",
        expiresAt: END,
      });
      return expect(
        VertexResearchChatDebateConfigurationV1Schema.safeParse({
          ...debate,
          participantIds: ["first-mate", "jan-smolen"],
          synthesizerId: "first-mate",
        }).success
      ).toBe(false);
    },
    TIMEOUT
  );
});
