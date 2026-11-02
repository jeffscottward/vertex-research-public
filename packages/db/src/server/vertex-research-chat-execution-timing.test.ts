import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { describe, expect, it } from "vitest";
import {
  CURRENT,
  EDGE,
  ns,
  owner,
  PLANNED,
  PROGRESSED,
  timingFixture,
} from "./vertex-research-chat-timing.test-support.ts";

// Honest fixture boundary: the descriptive persisted plan is synthetic; the
// private accepted review is created by the real review owner. Real approval,
// current ACL and human-prefix code must reach the deliberately missing selected
// policy/input-builder composition. There is NO positive approval, pure-builder
// substitute, copied body, dispatched job or full-chain acceptance in this file.
// Authored, deliberately NOT RUN by the timing-repair writer.
describe("approval observes current thread/grants without rebasing immutable plan", () => {
  it.each(["thread", "grant", "thread-and-grant"])(
    "accepts valid %s progression at the real prefix boundary",
    async (progression) => {
      const f = await timingFixture();
      const selected = await f.operations.planResearchChatResponse(
        owner,
        f.request
      );
      expect(selected).toEqual(f.plan);
      const before = canonicalArtifactJson(
        f.table("vertex_research_chat_execution_plans")
      );
      const review = await f.recordReview();
      f.state.at = PROGRESSED;
      if (progression !== "grant") await f.append("2", "later-message");
      if (progression !== "thread") {
        await f.setGrant(owner.actorId, "research-chat", ["publish", "read"], {
          version: "2.0.0",
          revision: "2",
          validFrom: PROGRESSED,
          recordedAt: PROGRESSED,
        });
      }
      f.state.at = CURRENT;
      f.calls.length = 0;
      await expect(
        f.operations.approveResearchChatResponse(owner, f.approveInput)
      ).rejects.toMatchObject({ code: "unavailable" });
      // Only the deliberate external selection boundary yields unavailable here.
      // The pre-repair historical plannedAt instead denied/staled BEFORE it.
      expect(f.state.selectionReads).toBe(1);
      expect(f.table("vertex_research_chat_execution_approvals")).toEqual([]);
      expect(
        canonicalArtifactJson(f.table("vertex_research_chat_execution_plans"))
      ).toBe(before);
      expect(
        f.table("vertex_research_chat_storage_reviews")[0]!["payload"]
      ).toEqual(review);
      expect(f.plan.plannedAt).toBe(PLANNED);
      expect(selected).toMatchObject({
        planId: f.plan.planId,
        planSha256: f.plan.planSha256,
        requestSha256: f.plan.requestSha256,
        parentMessageId: f.request.parentMessageId,
        snapshotRevision: "2",
        contextStartSequence: "1",
        participantConfiguration: f.configurationArtifact.pin,
        storageEvidence: f.evidence.pin,
      });
      const prefix = f.calls.filter(
        (query) =>
          query.sql.includes('from "vertex_research_chat_messages"') &&
          query.sql.includes("sequence >=")
      );
      expect(prefix).toHaveLength(1);
      expect(prefix[0]!.params.slice(-2)).toEqual(["1", "1"]);
      const chatGrants = f.calls.filter(
        (query) =>
          query.sql.includes("from vertex_grant_bindings") &&
          query.params.includes("research-chat")
      );
      expect(chatGrants.length).toBeGreaterThan(0);
      expect(
        chatGrants.every(
          (query) =>
            query.params.includes(ns(CURRENT)) &&
            !query.params.includes(ns(PLANNED))
        )
      ).toBe(true);
      const persistence = canonicalArtifactJson([
        ...f.table("vertex_research_chat_execution_plans"),
        ...f.table("vertex_research_chat_storage_reviews"),
        ...f.table("vertex_research_chat_execution_approvals"),
      ]);
      expect(persistence).not.toContain(f.request.retrievalQuery);
      return expect(persistence).not.toContain("Synthetic original human body");
    }
  );

  it("still rejects grants expired at actual time; the defect was false staleness, not an expired-grant bypass", async () => {
    const f = await timingFixture();
    await f.recordReview();
    await f.setGrant(owner.actorId, "research-chat", ["publish", "read"], {
      expiresAt: EDGE,
    });
    f.state.at = EDGE;
    await expect(
      f.operations.approveResearchChatResponse(owner, f.approveInput)
    ).rejects.toMatchObject({ code: "denied" });
    expect(f.state.selectionReads).toBe(0);
    return expect(f.table("vertex_research_chat_execution_approvals")).toEqual(
      []
    );
  });

  it.each([
    { retrievalQuery: "A changed retrieval query" },
    { snapshotRevision: "3" },
    { parentMessageId: "another-parent" },
    { participantId: "another-expert" },
  ])(
    "rejects changed original request bytes before reconstruction: %s",
    async (change) => {
      const f = await timingFixture();
      await f.recordReview();
      const before = canonicalArtifactJson(
        f.table("vertex_research_chat_execution_plans")
      );
      f.state.at = CURRENT;
      f.state.readIds = [];
      await expect(
        f.operations.approveResearchChatResponse(owner, {
          ...f.approveInput,
          request: { ...f.request, ...change },
        })
      ).rejects.toMatchObject({ code: "conflict" });
      expect(f.state.selectionReads).toBe(0);
      expect(f.state.readIds).toEqual([]);
      return expect(
        canonicalArtifactJson(f.table("vertex_research_chat_execution_plans"))
      ).toBe(before);
    }
  );

  it("does not relax original prefix integrity when the current thread is newer", async () => {
    const f = await timingFixture();
    await f.recordReview();
    f.state.at = PROGRESSED;
    await f.append("2", "later-message");
    const original = f.table("vertex_research_chat_messages")[0]!;
    original["payload"] = {
      ...(original["payload"] as Record<string, unknown>),
      body: "Changed original transcript body",
    };
    original["record_hash"] = await hashArtifact(original["payload"]);
    f.state.at = CURRENT;
    await expect(
      f.operations.approveResearchChatResponse(owner, f.approveInput)
    ).rejects.toMatchObject({ code: "integrity" });
    expect(f.state.selectionReads).toBe(0);
    return expect(f.table("vertex_research_chat_execution_approvals")).toEqual(
      []
    );
  });

  return it("does not accept an altered selected configuration pin", async () => {
    const f = await timingFixture();
    await f.recordReview();
    const catalog = f
      .table("vertex_artifacts")
      .find(
        (row) => row["artifact_id"] === f.configurationArtifact.pin.artifactId
      )!;
    catalog["payload"] = {
      ...(catalog["payload"] as Record<string, unknown>),
      artifactSha256: "0".repeat(64),
    };
    catalog["metadata_hash"] = await hashArtifact(catalog["payload"]);
    f.state.at = CURRENT;
    await expect(
      f.operations.approveResearchChatResponse(owner, f.approveInput)
    ).rejects.toThrow();
    expect(f.state.selectionReads).toBe(0);
    return expect(f.table("vertex_research_chat_execution_approvals")).toEqual(
      []
    );
  });
});
