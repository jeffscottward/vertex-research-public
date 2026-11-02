import { hashArtifact } from "@darkfactory/shared/vertex";
import { describe, expect, it } from "vitest";
import { researchChatStorageReviewResource } from "./vertex-research-chat-execution-ports.ts";
import {
  CURRENT,
  EDGE,
  END,
  issuer,
  owner,
  reviewer,
  scope,
  timingFixture,
} from "./vertex-research-chat-timing.test-support.ts";

// Source/fake boundaries only. Accepted reviews below are produced by the real
// private review owner; no seeded accepted qualification or permission callback.
// Authored, deliberately NOT RUN by the timing-repair writer.
describe("private storage review retains all joined authority through final I/O", () => {
  it("records and re-reads an independently authorized exact-plan review", async () => {
    const f = await timingFixture();
    const review = await f.recordReview();
    expect(f.table("vertex_research_chat_storage_reviews")).toHaveLength(1);
    expect(review).toMatchObject({
      planId: f.plan.planId,
      planSha256: f.plan.planSha256,
      actorId: reviewer.actorId,
      issuerActorId: issuer.actorId,
      decision: "accepted",
      expiresAt: END,
    });
    f.state.at = CURRENT;
    expect(await f.readReview()).toEqual(review);
    expect(f.state.readIds).toEqual([
      "storage-evidence",
      "report-one",
      "report-two",
      "storage-evidence",
      "report-one",
      "report-two",
    ]);
    expect(
      f.calls
        .filter((q) => q.sql.includes("pg_advisory_xact_lock"))
        .some((q) => q.params[0] === "vertex-authorization:global")
    ).toBe(true);
    return expect(f.table("vertex_research_chat_execution_approvals")).toEqual(
      []
    );
  });

  it.each([
    "issuer-publish",
    "evidence-rights",
    "prior-report-rights",
    "prior-report-retention",
    "account-read",
    "evidence-read",
    "prior-report-read",
  ])(
    "denies %s expiring during the final report body read",
    async (authority) => {
      const f = await timingFixture();
      if (authority === "issuer-publish")
        await f.setGrant(
          issuer.actorId,
          f.evidence.pin.artifactId,
          ["publish"],
          { expiresAt: EDGE }
        );
      if (authority === "evidence-rights")
        await f.setRights(String(f.evidence.rights["policyId"]), {
          expiresAt: EDGE,
        });
      if (authority === "prior-report-rights")
        await f.setRights(String(f.reportOne.rights["policyId"]), {
          expiresAt: EDGE,
        });
      if (authority === "prior-report-retention")
        await f.setRights(String(f.reportOne.rights["policyId"]), {
          retentionUntil: EDGE,
        });
      if (authority === "account-read")
        await f.setGrant(reviewer.actorId, "account-scope", ["read"], {
          expiresAt: EDGE,
        });
      if (authority === "evidence-read")
        await f.setGrant(
          reviewer.actorId,
          f.evidence.pin.artifactId,
          ["read"],
          { expiresAt: EDGE }
        );
      if (authority === "prior-report-read")
        await f.setGrant(
          reviewer.actorId,
          f.reportOne.pin.artifactId,
          ["read"],
          { expiresAt: EDGE }
        );
      f.state.at = CURRENT;
      f.state.afterRead = (id) => {
        if (id === f.reportTwo.pin.artifactId) return (f.state.at = EDGE);
        return;
      };
      await expect(f.recordReview()).rejects.toMatchObject({ code: "stale" });
      expect(f.state.readIds).toEqual([
        "storage-evidence",
        "report-one",
        "report-two",
      ]);
      expect(f.table("vertex_research_chat_storage_reviews")).toEqual([]);
      return expect(f.lifecycle.at(-1)).toBe("rollback");
    }
  );

  it.each([
    "issuer-publish",
    "evidence-rights",
    "prior-report-rights",
    "prior-report-retention",
    "evidence-read",
    "prior-report-read",
  ])(
    "does not return an existing review after %s expires during the last report read",
    async (authority) => {
      const f = await timingFixture();
      const review = await f.recordReview();
      if (authority === "issuer-publish")
        await f.setGrant(
          issuer.actorId,
          f.evidence.pin.artifactId,
          ["publish"],
          { expiresAt: EDGE }
        );
      if (authority === "evidence-rights")
        await f.setRights(String(f.evidence.rights["policyId"]), {
          expiresAt: EDGE,
        });
      if (authority === "prior-report-rights")
        await f.setRights(String(f.reportOne.rights["policyId"]), {
          expiresAt: EDGE,
        });
      if (authority === "prior-report-retention")
        await f.setRights(String(f.reportOne.rights["policyId"]), {
          retentionUntil: EDGE,
        });
      if (authority === "evidence-read")
        await f.setGrant(owner.actorId, f.evidence.pin.artifactId, ["read"], {
          expiresAt: EDGE,
        });
      if (authority === "prior-report-read")
        await f.setGrant(owner.actorId, f.reportOne.pin.artifactId, ["read"], {
          expiresAt: EDGE,
        });
      f.state.at = CURRENT;
      f.state.readIds = [];
      f.state.afterRead = (id) => {
        if (id === f.reportTwo.pin.artifactId) return (f.state.at = EDGE);
        return;
      };
      await expect(f.readReview()).rejects.toMatchObject({ code: "stale" });
      expect(f.state.readIds).toEqual([
        "storage-evidence",
        "report-one",
        "report-two",
      ]);
      return expect(
        f
          .table("vertex_research_chat_storage_reviews")
          .map((row) => row["payload"])
      ).toEqual([review]);
    }
  );

  it("retains catalog-pinned rights even when the current policy expires later", async () => {
    const f = await timingFixture();
    const catalog = f
      .table("vertex_artifacts")
      .find((row) => row["artifact_id"] === f.reportOne.pin.artifactId)!;
    const metadata = structuredClone(catalog["payload"]) as Record<
      string,
      unknown
    >;
    metadata["rights"] = {
      ...(metadata["rights"] as Record<string, unknown>),
      expiresAt: EDGE,
    };
    catalog["payload"] = metadata;
    catalog["metadata_hash"] = await hashArtifact(metadata);
    f.state.at = CURRENT;
    f.state.afterRead = (id) => {
      if (id === f.reportTwo.pin.artifactId) return (f.state.at = EDGE);
      return;
    };
    await expect(f.recordReview()).rejects.toMatchObject({ code: "stale" });
    return expect(f.table("vertex_research_chat_storage_reviews")).toEqual([]);
  });

  it.each([
    "new-review",
    "reviewer-evidence",
    "issuer-publish",
    "evidence-rights",
  ])(
    "final-checks %s after the last reviewer grant query",
    async (authority) => {
      const f = await timingFixture();
      if (authority === "reviewer-evidence")
        await f.setGrant(
          reviewer.actorId,
          f.evidence.pin.artifactId,
          ["review"],
          { expiresAt: EDGE }
        );
      if (authority === "issuer-publish")
        await f.setGrant(
          issuer.actorId,
          f.evidence.pin.artifactId,
          ["publish"],
          { expiresAt: EDGE }
        );
      if (authority === "evidence-rights")
        await f.setRights(String(f.evidence.rights["policyId"]), {
          expiresAt: EDGE,
        });
      let retainedPrivateGrants = 0;
      const privateGrantStages: string[] = [];
      const privateTarget = researchChatStorageReviewResource(
        f.plan.responseRequestId
      );
      f.state.at = CURRENT;
      f.state.afterQuery = (query) => {
        if (
          query.sql.includes("from vertex_grant_bindings") &&
          query.params.includes(privateTarget)
        )
          privateGrantStages.push(
            query.sql.startsWith("select v.payload") ? "retain" : "authorize"
          );
        if (
          query.sql.startsWith("select v.payload") &&
          query.params.includes(privateTarget)
        ) {
          retainedPrivateGrants += 1;
          if (retainedPrivateGrants === 2) return (f.state.at = EDGE);
          return;
        }
        return;
      };
      const attempt = f.recordReview(
        authority === "new-review" ? { expiresAt: EDGE } : {}
      );
      const failure = await attempt.then(
        () => null,
        (error: unknown) => error
      );
      const failureCode = (failure as { code?: unknown } | null)?.code ?? null;
      // Keep the original stale-only assertion. Report the primitive code and
      // bounded hook trace separately: Vitest elides the nested error in JSON.
      expect(
        failureCode,
        JSON.stringify({
          authority,
          retainedPrivateGrants,
          privateGrantStages,
          at: f.state.at,
        })
      ).toBe("stale");
      await expect(attempt).rejects.toMatchObject({ code: "stale" });
      expect(retainedPrivateGrants).toBe(2);
      expect(privateGrantStages).toEqual([
        "authorize",
        "authorize",
        "authorize",
        "retain",
        "authorize",
        "retain",
      ]);
      expect(f.state.at).toBe(EDGE);
      expect(f.state.readIds).toEqual([
        "storage-evidence",
        "report-one",
        "report-two",
      ]);
      expect(f.table("vertex_research_chat_storage_reviews")).toEqual([]);
      expect(
        f.calls.some((query) =>
          query.sql.startsWith(
            'insert into "vertex_research_chat_storage_reviews"'
          )
        )
      ).toBe(false);
      return expect(f.lifecycle.at(-1)).toBe("rollback");
    }
  );

  it("rejects exact review expiry after external report I/O without changing its original receipt", async () => {
    const f = await timingFixture();
    const review = await f.recordReview({ expiresAt: EDGE });
    f.state.at = CURRENT;
    f.state.afterRead = (id) => {
      if (id === f.reportTwo.pin.artifactId) return (f.state.at = EDGE);
      return;
    };
    await expect(f.readReview()).rejects.toMatchObject({ code: "stale" });
    return expect(
      f.table("vertex_research_chat_storage_reviews")[0]!["payload"]
    ).toEqual(review);
  });

  it("rolls back if the new review expires during its final insert", async () => {
    const f = await timingFixture();
    f.state.at = CURRENT;
    f.state.afterQuery = (query) => {
      if (
        query.sql.startsWith(
          'insert into "vertex_research_chat_storage_reviews"'
        )
      )
        return (f.state.at = EDGE);
      return;
    };
    await expect(f.recordReview({ expiresAt: EDGE })).rejects.toMatchObject({
      code: "stale",
    });
    expect(
      f.calls.some((query) =>
        query.sql.startsWith(
          'insert into "vertex_research_chat_storage_reviews"'
        )
      )
    ).toBe(true);
    expect(f.table("vertex_research_chat_storage_reviews")).toEqual([]);
    return expect(f.lifecycle.at(-1)).toBe("rollback");
  });

  it("does not replay a receipt after earlier report rights expire in the prior-row lookup", async () => {
    const f = await timingFixture();
    const review = await f.recordReview();
    await f.setRights(String(f.reportOne.rights["policyId"]), {
      expiresAt: EDGE,
    });
    f.state.at = CURRENT;
    f.state.afterQuery = (query) => {
      if (
        query.sql.includes('from "vertex_research_chat_storage_reviews"') &&
        query.sql.includes("actor_id =")
      )
        return (f.state.at = EDGE);
      return;
    };
    await expect(f.recordReview()).rejects.toMatchObject({ code: "stale" });
    expect(
      f
        .table("vertex_research_chat_storage_reviews")
        .map((row) => row["payload"])
    ).toEqual([review]);
    return expect(f.lifecycle.at(-1)).toBe("rollback");
  });

  it.each(["accepted", "rejected"])(
    "replays a still-current %s receipt without changing its decision or expiry",
    async (decision) => {
      const f = await timingFixture();
      const command = { decision, expiresAt: EDGE };
      const review = await f.recordReview(command);
      f.state.at = CURRENT;
      expect(await f.recordReview(command)).toEqual(review);
      expect(f.table("vertex_research_chat_storage_reviews")).toHaveLength(1);
      if (decision === "rejected") {
        return await expect(f.readReview()).rejects.toMatchObject({
          code: "denied",
        });
      }
      return expect(await f.readReview()).toEqual(review);
    }
  );

  it.each(["accepted", "rejected"])(
    "does not replay an expired %s review while every source authority remains current",
    async (decision) => {
      const f = await timingFixture();
      const command = { decision, expiresAt: EDGE };
      const review = await f.recordReview(command);
      f.state.at = EDGE;
      await expect(f.recordReview(command)).rejects.toMatchObject({
        code: "stale",
      });
      expect(
        f
          .table("vertex_research_chat_storage_reviews")
          .map((row) => row["payload"])
      ).toEqual([review]);
      return expect(f.lifecycle.at(-1)).toBe("rollback");
    }
  );

  it.each(["accepted", "rejected"])(
    "retains original %s review expiry across the final prior-row lookup",
    async (decision) => {
      const f = await timingFixture();
      const command = { decision, expiresAt: EDGE };
      const review = await f.recordReview(command);
      f.state.at = CURRENT;
      f.state.afterQuery = (query) => {
        if (
          query.sql.includes('from "vertex_research_chat_storage_reviews"') &&
          query.sql.includes("actor_id =")
        )
          return (f.state.at = EDGE);
        return;
      };
      await expect(f.recordReview(command)).rejects.toMatchObject({
        code: "stale",
      });
      expect(
        f
          .table("vertex_research_chat_storage_reviews")
          .map((row) => row["payload"])
      ).toEqual([review]);
      return expect(f.lifecycle.at(-1)).toBe("rollback");
    }
  );

  it("rejects a self-consistent replay row whose decision no longer matches the original command", async () => {
    const f = await timingFixture();
    await f.recordReview();
    const row = f.table("vertex_research_chat_storage_reviews")[0]!;
    row["payload"] = {
      ...(row["payload"] as Record<string, unknown>),
      decision: "rejected",
    };
    row["decision"] = "rejected";
    row["record_hash"] = await hashArtifact(row["payload"]);
    f.state.at = CURRENT;
    await expect(f.recordReview()).rejects.toMatchObject({ code: "integrity" });
    return expect(f.table("vertex_research_chat_storage_reviews")).toHaveLength(
      1
    );
  });

  return it("does not treat the owner as the independent reviewer", async () => {
    const f = await timingFixture();
    await f.setGrant(
      owner.actorId,
      researchChatStorageReviewResource(f.plan.responseRequestId),
      ["review"]
    );
    await expect(
      f.operations.recordResearchChatStorageQualificationReview(owner, {
        ...scope,
        responseRequestId: f.plan.responseRequestId,
        planId: f.plan.planId,
        planSha256: f.plan.planSha256,
        evidence: f.evidence.pin,
        decision: "accepted",
        allowedCopyOperations: ["create", "inspect", "read", "fence"],
        expiresAt: END,
        expectedReviewId: null,
        idempotencyKey: "owner-review",
      })
    ).rejects.toMatchObject({ code: "denied" });
    return expect(f.table("vertex_research_chat_storage_reviews")).toEqual([]);
  });
});
