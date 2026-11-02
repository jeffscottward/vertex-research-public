import { readFileSync } from "node:fs";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { describe, expect, it, vi } from "vitest";
import { createVertexResearchChatExecutionRuntime } from "../../../api/src/server/vertex-research-chat-execution-runtime.ts";
import {
  AT,
  END,
  LATER,
  owner,
  reviewer,
  SENTINELS,
  scope,
} from "../../../api/src/server/vertex-research-chat-execution-runtime.test-support.ts";
import {
  deferred,
  lifecycleFixture,
} from "./vertex-research-chat-copy-lifecycle.test-support.ts";

// Authored SOURCE scenarios, not executed by this writer. No actual database,
// deployment/storage qualification, worker admission, model call or AI output.
// The real positive SOURCE scenario measured ~9s. Scope the finite allowance
// to this test file; do not change project defaults or replace real owners.
vi.setConfig({ testTimeout: 30_000 });
const effects = "vertex_research_chat_copy_effects";
const observations = "vertex_research_chat_copy_effect_observations";
const closures = "vertex_research_chat_copy_domain_closures";
const metadataTables = [
  "vertex_research_chat_execution_plans",
  "vertex_research_chat_storage_reviews",
  "vertex_research_chat_execution_approvals",
  "vertex_research_chat_copy_families",
  "vertex_research_chat_copy_allocations",
  "vertex_research_chat_copy_content_bindings",
  "vertex_research_chat_copy_dependencies",
  effects,
  observations,
  closures,
];
const approved = async () => {
  const f = await lifecycleFixture();
  return { ...f, ...(await f.approve()) };
};
const calls = (f: Awaited<ReturnType<typeof lifecycleFixture>>, name: string) =>
  f.copies.calls.filter((call) => call.operation === name);
const closedDomains = (
  f: Awaited<ReturnType<typeof lifecycleFixture>>,
  cause: string
) => {
  expect(
    f
      .table(closures)
      .map((row) => row["domain"])
      .sort()
  ).toEqual(["derived", "inputs"]);
  expect(f.table(closures).every((row) => row["payload"].cause === cause)).toBe(
    true
  );
  const authority = f.table(closures)[0]!["payload"].authority;
  expect(authority.resourceId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
  const kind = cause.startsWith("storage-review-")
    ? "storage-review"
    : cause.startsWith("corpus-review-")
      ? "corpus-review"
      : cause.startsWith("original-authority-")
        ? "owner-context-grant"
        : "corpus-rights";
  expect(authority.kind).toBe(kind);
  return expect(f.table(closures)[1]!["payload"].authority).toEqual(authority);
};

describe("finite persisted approval to governed input copies and current reads", () => {
  it("uses REAL plan, private review, owner approval, raw storage operations and exact current reads", async () => {
    const f = await lifecycleFixture();
    const originals = canonicalArtifactJson(
      f.table("vertex_research_chat_messages")
    );
    const immutableObjects = new Map(
      [...f.objects].map(([key, value]) => [
        key,
        Buffer.from(value.body).toString("base64"),
      ])
    );
    const { plan, review, approval, input } = await f.approve();
    expect(approval).toMatchObject({
      planSha256: plan["planSha256"],
      storageReviewId: review["reviewId"],
      executionAuthorized: false,
    });
    const offset = f.calls.length;
    const result = await f.runtime.writeApprovedInputs(owner, input);
    expect(result.map((value) => value.status)).toEqual([
      "live",
      "live",
      "live",
    ]);
    expect(calls(f, "create")).toHaveLength(3);
    expect(f.table("vertex_research_chat_copy_allocations")).toHaveLength(4);
    expect(f.table("vertex_research_chat_copy_content_bindings")).toHaveLength(
      3
    );
    const advisory = f
      .table("vertex_research_chat_copy_allocations")
      .find((row) => row["kind"] === "derived-output")!;
    expect(advisory["payload"].binding.content).toBeNull();
    expect(
      f.table(effects).some((row) => row["copy_id"] === advisory["copy_id"])
    ).toBe(false);
    expect(f.table(effects)).toHaveLength(3);
    expect(f.table(observations)).toHaveLength(3);
    for (const purpose of [
      "context",
      "tokenizeInput",
      "completionInput",
    ] as const) {
      const bytes = await f.runtime.readApprovedInput(owner, input, purpose);
      expect({
        sha256: await hashArtifact(bytes),
        byteLength: bytes.byteLength,
      }).toEqual(plan[purpose]);
      expect(new TextDecoder().decode(bytes)).toContain(SENTINELS.human);
    }
    const persisted = canonicalArtifactJson(
      metadataTables.flatMap((name) => f.table(name))
    );
    const sqlWrites = canonicalArtifactJson(
      f.calls
        .slice(offset)
        .filter((q) => /^(insert|update)/.test(q.sql))
        .map((q) => q.params)
    );
    for (const sentinel of Object.values(SENTINELS)) {
      expect(persisted).not.toContain(sentinel);
      expect(sqlWrites).not.toContain(sentinel);
    }
    expect(persisted).not.toContain('"retrievalQuery"');
    expect(persisted).not.toContain('"dispatchedAt"');
    expect(
      f.table(effects).every((row) => row["payload"].intentCommittedAt === AT)
    ).toBe(true);
    expect(
      canonicalArtifactJson(f.table("vertex_research_chat_messages"))
    ).toBe(originals);
    expect(
      new Map(
        [...f.objects].map(([key, value]) => [
          key,
          Buffer.from(value.body).toString("base64"),
        ])
      )
    ).toEqual(immutableObjects);
    expect(
      f
        .table("vertex_outbox")
        .filter(
          (row) => row["payload"]?.responseRequestId === f.responseRequestId
        )
    ).toEqual([]);
    expect(
      (f.runtime as any).closeResponseAttemptInputsForTransaction
    ).toBeUndefined();
    return expect((f.runtime as any).capabilities).toBeUndefined();
  });
  it("requires actual persisted approval; neither plan nor accepted review dispatches", async () => {
    const f = await lifecycleFixture(),
      plan = await f.runtime.planResearchChatResponse(owner, f.request),
      input = f.approveInput(plan);
    await expect(f.runtime.writeApprovedInputs(owner, input)).rejects.toThrow();
    await f.runtime.recordResearchChatStorageQualificationReview(
      reviewer,
      f.reviewInput(plan)
    );
    await expect(f.runtime.writeApprovedInputs(owner, input)).rejects.toThrow();
    expect(f.table(effects)).toEqual([]);
    return expect(f.copies.calls).toEqual([]);
  });
  it("compares original request digest before using changed query echo", async () => {
    const f = await approved(),
      readIds: string[] = [];
    f.state.afterRead = (id) => {
      readIds.push(id);
    };
    await expect(
      f.runtime.writeApprovedInputs(owner, {
        ...f.input,
        request: { ...f.request, retrievalQuery: "Not approved" },
      })
    ).rejects.toThrow();
    expect(readIds).toEqual([]);
    return expect(f.copies.calls).toEqual([]);
  });
  it("rejects changed original policy bytes without reserving or dispatching", async () => {
    const f = await approved();
    f.objects.get(f.modelPolicy.key)!.body = new TextEncoder().encode(
      "Changed original policy bytes"
    );
    await expect(
      f.runtime.writeApprovedInputs(owner, f.input)
    ).rejects.toThrow();
    expect(f.table(effects)).toEqual([]);
    return expect(f.copies.calls).toEqual([]);
  });
  it("deduplicates concurrent dispatch and reconstructs only fixed original allocations", async () => {
    const f = await approved();
    await Promise.all([
      f.runtime.writeApprovedInputs(owner, f.input),
      f.runtime.writeApprovedInputs(owner, f.input),
    ]);
    await f.runtime.writeApprovedInputs(owner, f.input);
    expect(calls(f, "create")).toHaveLength(3);
    expect(new Set(calls(f, "create").map((call) => call.copyId)).size).toBe(3);
    expect(f.table(effects)).toHaveLength(3);
    expect(f.table("vertex_research_chat_copy_allocations")).toHaveLength(4);
    return expect(
      (await f.runtime.reconcileApprovedInputs(owner, f.input)).every(
        (value) => value.status === "live"
      )
    ).toBe(true);
  });
  it.each(["unknown-after", "throw-after"] as const)(
    "%s inspects before reading and never redispatches",
    async (mode) => {
      const f = await approved();
      f.copies.state.createMode = mode;
      expect(
        (await f.runtime.writeApprovedInputs(owner, f.input)).every(
          (value) => value.status === "live"
        )
      ).toBe(true);
      for (const copy of calls(f, "create"))
        expect(
          f.copies.calls
            .filter((call) => call.copyId === copy.copyId)
            .map((call) => call.operation)
        ).toEqual(["create", "inspect", "read"]);
      await f.runtime.reconcileApprovedInputs(owner, f.input);
      return expect(calls(f, "create")).toHaveLength(3);
    }
  );
  it("missing inspection of unknown create is not absence/no effect or a retry license", async () => {
    const f = await approved();
    f.copies.state.createMode = "unknown-before";
    expect(
      (await f.runtime.writeApprovedInputs(owner, f.input)).map(
        (value) => value.status
      )
    ).toEqual(["unknown", "unknown", "unknown"]);
    expect(calls(f, "read")).toHaveLength(0);
    f.copies.state.createMode = "normal";
    expect(
      (await f.runtime.writeApprovedInputs(owner, f.input)).every(
        (value) => value.status === "unknown"
      )
    ).toBe(true);
    expect(calls(f, "create")).toHaveLength(3);
    expect(f.copies.objects.size).toBe(0);
    expect(f.table(observations)).toEqual([]);
    return await expect(
      f.runtime.readApprovedInput(owner, f.input, "context")
    ).rejects.toThrow();
  });
  it("a lost SQL intent commit ACK cannot dispatch on replay even when storage is missing", async () => {
    const f = await approved();
    f.state.afterCommit = () => {
      if (f.table(effects).length === 1) {
        f.state.afterCommit = () => {
          return;
        };
        throw new Error("Commit result unknown");
      }
      return;
    };
    await expect(
      f.runtime.writeApprovedInputs(owner, f.input)
    ).rejects.toThrow();
    expect(f.table(effects)).toHaveLength(1);
    expect(calls(f, "create")).toHaveLength(0);
    const original = f.table(effects)[0]!["copy_id"];
    const result = await f.runtime.writeApprovedInputs(owner, f.input);
    expect(result[0]!.status).toBe("unknown");
    expect(calls(f, "create").some((call) => call.copyId === original)).toBe(
      false
    );
    return expect(
      f.copies.calls
        .filter((call) => call.copyId === original)
        .map((call) => call.operation)
    ).toEqual(["inspect"]);
  });
  it.each(["bytes", "binding", "profile", "length"] as const)(
    "rejects changed storage %s on current reads",
    async (kind) => {
      const f = await approved();
      await f.runtime.writeApprovedInputs(owner, f.input);
      f.copies.state.readTransform = (value) => {
        if (value.status !== "live") return value;
        if (kind === "bytes") {
          const bytes = new Uint8Array(value.bytes);
          // biome-ignore lint/suspicious/noBitwiseOperators: deliberate single-bit corruption of the first byte.
          bytes[0] = bytes[0]! ^ 1;
          return { ...value, bytes };
        }
        return {
          ...value,
          proof: {
            ...value.proof,
            ...(kind === "binding"
              ? { bindingSha256: "0".repeat(64) }
              : kind === "profile"
                ? { storageProfileSha256: "0".repeat(64) }
                : { byteLength: value.proof.byteLength + 1 }),
          },
        };
      };
      return await expect(
        f.runtime.readApprovedInput(owner, f.input, "context")
      ).rejects.toThrow();
    }
  );
  it("rejects a different principal, scope, thread and configured storage identity", async () => {
    const f = await approved();
    await f.runtime.writeApprovedInputs(owner, f.input);
    for (const input of [
      { ...f.input, request: { ...f.request, accountAlias: "other" } },
      { ...f.input, request: { ...f.request, threadId: "other" } },
    ])
      await expect(
        f.runtime.readApprovedInput(owner, input, "context")
      ).rejects.toThrow();
    await expect(
      f.runtime.readApprovedInput(reviewer, f.input, "context")
    ).rejects.toThrow();
    const other = createVertexResearchChatExecutionRuntime({
      ...f.runtimeOptions,
      storage: {
        ...f.runtimeOptions.storage,
        capabilities: f.copies.capabilities,
        storageProfileSha256: "9".repeat(64),
      },
    });
    await expect(
      other.readApprovedInput(owner, f.input, "context")
    ).rejects.toThrow();
    return expect(f.table(closures)).toEqual([]);
  });
  it("current read rechecks authority after external I/O and commits original revocation", async () => {
    const f = await approved();
    await f.runtime.writeApprovedInputs(owner, f.input);
    const originals = canonicalArtifactJson(
      f.table("vertex_research_chat_messages")
    );
    f.copies.state.afterRead = async () => {
      f.copies.state.afterRead = async () => {
        return;
      };
      f.state.at = LATER;
      return await f.revokeContext();
    };
    await expect(
      f.runtime.readApprovedInput(owner, f.input, "context")
    ).rejects.toThrow();
    closedDomains(f, "original-authority-revoked");
    return expect(
      canonicalArtifactJson(f.table("vertex_research_chat_messages"))
    ).toBe(originals);
  });
  it("expiry during CREATE cannot become visible even when its storage write is live", async () => {
    const f = await approved();
    f.copies.state.afterCreate = async () => {
      return (f.state.at = END);
    };
    await expect(
      f.runtime.writeApprovedInputs(owner, f.input)
    ).rejects.toThrow();
    expect(f.copies.objects.size).toBe(1);
    closedDomains(f, "corpus-review-expired");
    expect(f.table(observations)).toEqual([]);
    expect(calls(f, "read")).toHaveLength(0);
    expect(calls(f, "fence")).toHaveLength(0);
    return expect(
      f.table(effects).filter((row) => row["operation"] === "fence")
    ).toHaveLength(0);
  });
  it("expiry during current byte read commits closure and never returns expired bytes", async () => {
    const f = await approved();
    await f.runtime.writeApprovedInputs(owner, f.input);
    f.copies.state.afterRead = async () => {
      return (f.state.at = END);
    };
    await expect(
      f.runtime.readApprovedInput(owner, f.input, "context")
    ).rejects.toThrow();
    closedDomains(f, "corpus-review-expired");
    // The entry research-chat grant also expires at END; metadata-only observer
    // closes from the durable exact effect without bypassing byte-read authority.
    expect(calls(f, "fence")).toHaveLength(0);
    return expect(
      f.table(effects).filter((row) => row["operation"] === "fence")
    ).toHaveLength(0);
  });
  it.each(["corpus", "private"] as const)(
    "final observer metadata query expiry retains the %s root before capped review/plan deadlines",
    async (kind) => {
      const f = await lifecycleFixture(
        kind === "corpus" ? { corpusReviewExpiresAt: LATER } : {}
      );
      const privatePolicyId = "short-original-private-rights";
      if (kind === "private") {
        // This fixture's original private metadata is explicitly synthetic
        // historical SQL input, not a grant/approval/readiness substitute. Create
        // its rights with the REAL owner before plan/review/approval; bytes stay
        // unchanged and the current plan must actually retain this earlier end.
        const rights = {
          ...f.modelPolicy.metadata.rights,
          policyId: privatePolicyId,
          expiresAt: LATER,
        };
        await f.grant("fixture-grant-admin", privatePolicyId, [
          "manage-rights",
        ]);
        await f.store.putRights(
          { actorId: "fixture-grant-admin" },
          scope,
          null,
          rights
        );
        const row = f
          .table("vertex_artifacts")
          .find(
            (value) => value["artifact_id"] === f.modelPolicy.pin.artifactId
          )!;
        row["payload"] = { ...row["payload"], rights };
        row["rights_policy_id"] = rights.policyId;
        row["rights_version"] = rights.version;
        row["metadata_hash"] = await hashArtifact(row["payload"]);
      }
      const { input, plan, review } = await f.approve();
      expect(plan["expiresAt"]).toBe(LATER);
      expect(review["expiresAt"]).toBe(LATER);
      const human = canonicalArtifactJson(
        f.table("vertex_research_chat_messages")
      );
      const selection = f.selection;
      // One authority observation reads each current rights head once (the
      // transaction read cache reuses it for every pin): the corpus rights,
      // each selected licensing policy and, here, the original private rights.
      const finalRightsQuery =
        1 +
        new Set(
          selection.policies
            .filter((value) => value.role === "licensing-rights")
            .map((value) => value.policyId)
        ).size +
        (kind === "private" ? 1 : 0);
      let rightsQueries = 0,
        expiredOnFinalQuery = false;
      f.copies.state.afterCreate = async () => {
        // CREATE is already live. Advance only at the LAST metadata query of the
        // first post-I/O authority observation, not at its captured entry time.
        return (f.state.afterQuery = (query) => {
          if (!query.sql.includes("vertex_rights_versions")) return;
          rightsQueries += 1;
          if (rightsQueries === finalRightsQuery) {
            expiredOnFinalQuery = true;
            f.state.at = LATER;
            return (f.state.afterQuery = () => undefined);
          }
          return;
        });
      };
      await expect(
        f.runtime.writeApprovedInputs(owner, input)
      ).rejects.toThrow();
      expect(expiredOnFinalQuery).toBe(true);
      expect(rightsQueries).toBe(finalRightsQuery);
      expect(f.copies.objects.size).toBe(1);
      expect(
        f
          .table(closures)
          .map((row) => row["domain"])
          .sort()
      ).toEqual(["derived", "inputs"]);
      const loss =
        kind === "corpus"
          ? {
              cause: "corpus-review-expired",
              authority: {
                kind: "corpus-review",
                resourceId: f.corpusReview.reviewId,
                version: f.corpusReview.reviewVersion,
              },
            }
          : {
              cause: "rights-expiry",
              authority: {
                kind: "private-policy-rights",
                resourceId: privatePolicyId,
                version: "1.0.0",
              },
            };
      for (const row of f.table(closures))
        expect(row["payload"]).toMatchObject(loss);
      await expect(
        f.runtime.readApprovedInput(owner, input, "context")
      ).rejects.toThrow();
      expect(calls(f, "create")).toHaveLength(1);
      expect(calls(f, "read")).toHaveLength(0);
      expect(calls(f, "fence")).toHaveLength(0);
      expect(f.table(effects)).toHaveLength(1);
      expect(f.table(observations)).toHaveLength(0);
      return expect(
        canonicalArtifactJson(f.table("vertex_research_chat_messages"))
      ).toBe(human);
    }
  );
  it("caller read denial does not globally revoke either domain", async () => {
    const f = await approved();
    await f.runtime.writeApprovedInputs(owner, f.input);
    const grantId = `grant-${await hashArtifact({ actorId: owner.actorId, resourceId: "research-chat", actions: ["read", "publish"], collectionId: null })}`;
    await f.authorization.revokeGrant({
      principal: { actorId: "fixture-grant-admin" },
      grantId,
      scope,
      collectionId: null,
      version: "2.0.0",
      expectedVersion: "1.0.0",
    });
    await expect(
      f.runtime.readApprovedInput(owner, f.input, "context")
    ).rejects.toThrow();
    return expect(f.table(closures)).toEqual([]);
  });
});

describe("independent input closure and inspect-only cleanup", () => {
  it("requires exact cleanup grant, closes only inputs, preserves advisory and humans", async () => {
    const f = await approved();
    await f.runtime.writeApprovedInputs(owner, f.input);
    const original = canonicalArtifactJson(
      f.table("vertex_research_chat_messages")
    );
    await expect(
      f.runtime.closeApprovedInputs(owner, f.selector)
    ).rejects.toThrow();
    const cleaner = await f.grantCleanup();
    const closure = await f.runtime.closeApprovedInputs(cleaner, f.selector);
    expect(closure).toMatchObject({ domain: "inputs", cause: "explicit" });
    expect(f.table(closures)).toHaveLength(1);
    expect(f.table("vertex_research_chat_copy_closures")).toEqual([]);
    await expect(
      f.runtime.readApprovedInput(owner, f.input, "context")
    ).rejects.toThrow();
    const result = await f.runtime.drainApprovedCopyCleanup(
      cleaner,
      f.selector
    );
    expect(result).toHaveLength(3);
    expect(result.every((value) => value.status === "fenced")).toBe(true);
    expect(calls(f, "fence")).toHaveLength(3);
    expect(
      (await f.runtime.drainApprovedCopyCleanup(cleaner, f.selector)).every(
        (value) => value.status === "fenced"
      )
    ).toBe(true);
    expect(calls(f, "fence")).toHaveLength(3);
    expect(
      canonicalArtifactJson(f.table("vertex_research_chat_messages"))
    ).toBe(original);
    const advisory = f
      .table("vertex_research_chat_copy_allocations")
      .find((row) => row["kind"] === "derived-output")!;
    return expect(f.copies.objects.has(advisory["object_key"])).toBe(false);
  });
  it("whole-family closure is stronger than independent input closure and drains all four allocations", async () => {
    const f = await approved();
    await f.runtime.writeApprovedInputs(owner, f.input);
    await f.grant(
      owner.actorId,
      `research-chat-copies:${f.responseRequestId}`,
      ["cleanup-chat-copies"]
    );
    await f.store.requestResearchChatCopyCleanup({
      principal: owner,
      scope,
      threadId: f.request.threadId,
      responseRequestId: f.responseRequestId,
      idempotencyKey: "whole-family",
    });
    await expect(
      f.runtime.readApprovedInput(owner, f.input, "completionInput")
    ).rejects.toThrow();
    const cleaned = await f.runtime.drainApprovedCopyCleanup(owner, f.selector);
    expect(cleaned).toHaveLength(4);
    expect(cleaned.every((value) => value.status === "fenced")).toBe(true);
    return expect(
      f.table("vertex_research_chat_copy_content_bindings")
    ).toHaveLength(3);
  });
  it.each(["unknown-before", "unknown-after"] as const)(
    "unknown fence %s is inspect-only on restart",
    async (mode) => {
      const f = await approved();
      await f.runtime.writeApprovedInputs(owner, f.input);
      const cleaner = await f.grantCleanup();
      await f.runtime.closeApprovedInputs(cleaner, f.selector);
      f.copies.state.fenceMode = mode;
      expect(
        (await f.runtime.drainApprovedCopyCleanup(cleaner, f.selector)).every(
          (value) => value.status === "unknown"
        )
      ).toBe(true);
      f.copies.state.fenceMode = "normal";
      const result = await f.runtime.drainApprovedCopyCleanup(
        cleaner,
        f.selector
      );
      expect(
        result.every(
          (value) =>
            value.status === (mode === "unknown-after" ? "fenced" : "unknown")
        )
      ).toBe(true);
      return expect(calls(f, "fence")).toHaveLength(3);
    }
  );
  it("late CREATE settles after input closure without reopening; raw tombstone prevents resurrection", async () => {
    const f = await approved(),
      cleaner = await f.grantCleanup(),
      entered = deferred(),
      release = deferred();
    f.copies.state.afterCreate = async () => {
      entered.resolve();
      return await release.promise;
    };
    const pending = f.runtime.writeApprovedInputs(owner, f.input);
    const denied = expect(pending).rejects.toThrow();
    await entered.promise;
    await f.runtime.closeApprovedInputs(cleaner, f.selector);
    expect(
      (await f.runtime.drainApprovedCopyCleanup(cleaner, f.selector)).every(
        (value) => value.status === "fenced"
      )
    ).toBe(true);
    release.resolve();
    await denied;
    expect(f.table(closures)).toHaveLength(1);
    expect(
      f.table(observations).filter((row) => row["operation"] === "create")
    ).toHaveLength(0);
    await expect(
      f.runtime.readApprovedInput(owner, f.input, "context")
    ).rejects.toThrow();
    return expect(calls(f, "create")).toHaveLength(1);
  });
  it("cleanup remains available under independent authority after original context revocation", async () => {
    const f = await approved();
    await f.runtime.writeApprovedInputs(owner, f.input);
    const cleaner = await f.grantCleanup();
    f.state.at = LATER;
    await f.revokeContext();
    const result = await f.runtime.drainApprovedCopyCleanup(
      cleaner,
      f.selector
    );
    closedDomains(f, "original-authority-revoked");
    expect(result).toHaveLength(4);
    return expect(result.every((value) => value.status === "fenced")).toBe(
      true
    );
  });
  it("cleanup grant expiry during fence I/O cannot report settled or dispatch a replacement", async () => {
    const f = await approved();
    await f.runtime.writeApprovedInputs(owner, f.input);
    const cleaner = await f.grantCleanup("fixture-short-cleanup", LATER);
    await f.runtime.closeApprovedInputs(cleaner, f.selector);
    f.copies.state.afterFence = async () => {
      return (f.state.at = LATER);
    };
    await expect(
      f.runtime.drainApprovedCopyCleanup(cleaner, f.selector)
    ).rejects.toThrow();
    expect(calls(f, "fence")).toHaveLength(1);
    const other = await f.grantCleanup("fixture-recovery-cleanup");
    expect(
      (await f.runtime.drainApprovedCopyCleanup(other, f.selector)).every(
        (value) => value.status === "fenced"
      )
    ).toBe(true);
    return expect(calls(f, "fence")).toHaveLength(3);
  });
});

describe("verified original authority losses persist truthful monotone closure", () => {
  it.each(["accepted", "rejected"] as const)(
    "new private storage review %s cannot upgrade original approval",
    async (decision) => {
      const f = await approved();
      await f.runtime.writeApprovedInputs(owner, f.input);
      f.state.at = LATER;
      await f.runtime.recordResearchChatStorageQualificationReview(reviewer, {
        ...f.reviewInput(f.plan),
        decision,
        expectedReviewId: f.review["reviewId"],
        idempotencyKey: "replacement-storage-review",
      });
      await expect(
        f.runtime.readApprovedInput(owner, f.input, "context")
      ).rejects.toThrow();
      closedDomains(
        f,
        decision === "rejected"
          ? "storage-review-rejected"
          : "storage-review-superseded"
      );
      expect(f.table(closures)[0]!["payload"].authority.resourceId).toBe(
        f.table("vertex_research_chat_storage_reviews")[1]!["review_id"]
      );
      expect(f.table("vertex_research_chat_execution_approvals")).toHaveLength(
        1
      );
      return expect(
        f.table("vertex_research_chat_storage_reviews")
      ).toHaveLength(2);
    }
  );
  it.each(["superseded", "denied", "expired", "retention"] as const)(
    "exact corpus rights %s persists distinct loss cause and preserves originals",
    async (kind) => {
      const f = await approved();
      await f.runtime.writeApprovedInputs(owner, f.input);
      const human = canonicalArtifactJson(
        f.table("vertex_research_chat_messages")
      );
      f.state.at = LATER;
      const rights = {
        ...f.corpus.metadata.rights,
        version: "2.0.0",
        checkedAt: LATER,
        ...(kind === "denied"
          ? { status: "denied" as const }
          : kind === "expired"
            ? { status: "expired" as const, expiresAt: LATER }
            : kind === "retention"
              ? { retentionUntil: LATER }
              : {}),
      };
      await f.store.putRights(
        { actorId: "fixture-grant-admin" },
        scope,
        "corpus",
        rights
      );
      await expect(
        f.runtime.readApprovedInput(owner, f.input, "context")
      ).rejects.toThrow();
      closedDomains(
        f,
        kind === "superseded"
          ? "rights-superseded"
          : kind === "denied"
            ? "rights-denied"
            : kind === "expired"
              ? "rights-expiry"
              : "retention-ended"
      );
      expect(f.table(closures)[0]!["payload"].authority).toEqual({
        kind: "corpus-rights",
        resourceId: "corpus-rights",
        version: "2.0.0",
      });
      return expect(
        canonicalArtifactJson(f.table("vertex_research_chat_messages"))
      ).toBe(human);
    }
  );
  it("context grant expiry is not mislabeled as revocation", async () => {
    const f = await approved();
    await f.runtime.writeApprovedInputs(owner, f.input);
    const resourceId = `research-chat-context-use:${f.responseRequestId}`;
    const grantId = `grant-${await hashArtifact({ actorId: owner.actorId, resourceId, actions: ["publish"], collectionId: null })}`;
    await f.authorization.issueGrant({
      principal: { actorId: "fixture-grant-admin" },
      grantId,
      granteeActorId: owner.actorId,
      scope,
      collectionId: null,
      resourceId,
      actions: ["publish"],
      version: "2.0.0",
      expectedVersion: "1.0.0",
      validFrom: AT,
      expiresAt: LATER,
    });
    f.state.at = LATER;
    await expect(
      f.runtime.readApprovedInput(owner, f.input, "context")
    ).rejects.toThrow();
    closedDomains(f, "original-authority-expired");
    return expect(f.table(closures)[0]!["payload"].authority).toEqual({
      kind: "owner-context-grant",
      resourceId: grantId,
      version: "2.0.0",
    });
  });
  it.each(["accepted", "rejected"] as const)(
    "real newer corpus review %s closes original plan with exact cause",
    async (decision) => {
      const f = await approved();
      await f.runtime.writeApprovedInputs(owner, f.input);
      f.state.at = LATER;
      const command = {
        ...scope,
        artifactId: f.corpus.pin.artifactId,
        artifactSha256: f.corpus.pin.artifactSha256,
        strategyVersion: f.corpusReview.strategyVersion,
        decision,
        purpose: "research",
        expectedReviewId: f.corpusReview.reviewId,
        idempotencyKey: "replacement-corpus-review",
      };
      const requestHash = await hashArtifact({
        actorId: reviewer.actorId,
        kind: "review",
        input: command,
      });
      const review = {
        ...f.corpusReview,
        reviewId: `review-${requestHash}`,
        reviewVersion: "12.34.6",
        decision,
        reviewedAt: LATER,
        supersedesReviewId: f.corpusReview.reviewId,
      };
      await f.store.recordReviewedEvidence({
        principal: reviewer,
        scope,
        idempotencyKey: command.idempotencyKey,
        requestHash,
        command,
        review,
        acceptedEvidence: null,
      });
      await expect(
        f.runtime.readApprovedInput(owner, f.input, "context")
      ).rejects.toThrow();
      closedDomains(
        f,
        decision === "rejected"
          ? "corpus-review-rejected"
          : "corpus-review-superseded"
      );
      expect(f.table(closures)[0]!["payload"].authority).toEqual({
        kind: "corpus-review",
        resourceId: review.reviewId,
        version: "12.34.6",
      });
      return expect(f.table("vertex_reviews")).toHaveLength(2);
    }
  );
});

describe("remaining exact loss/status boundaries", () => {
  it.each(["denied", "expired", "superseded"] as const)(
    "private original selected-policy rights %s closes with private provenance",
    async (kind) => {
      const f = await approved();
      await f.runtime.writeApprovedInputs(owner, f.input);
      f.state.at = LATER;
      const rights = {
        ...f.config.metadata.rights,
        version: "2.0.0",
        checkedAt: LATER,
        ...(kind === "denied"
          ? { status: "denied" as const }
          : kind === "expired"
            ? { status: "expired" as const, expiresAt: LATER }
            : {}),
      };
      await f.store.putRights(
        { actorId: "fixture-grant-admin" },
        scope,
        null,
        rights
      );
      await expect(
        f.runtime.readApprovedInput(owner, f.input, "context")
      ).rejects.toThrow();
      expect(
        f
          .table(closures)
          .map((row) => row["domain"])
          .sort()
      ).toEqual(["derived", "inputs"]);
      for (const row of f.table(closures))
        expect(row["payload"]).toMatchObject({
          cause:
            kind === "denied"
              ? "rights-denied"
              : kind === "expired"
                ? "rights-expiry"
                : "rights-superseded",
          authority: {
            kind: "private-policy-rights",
            resourceId: "policy-rights",
            version: "2.0.0",
          },
        });
    }
  );
  it("private storage review can expire before all original corpus/grant deadlines", async () => {
    const f = await lifecycleFixture(),
      { input, review } = await f.approve(LATER);
    await f.runtime.writeApprovedInputs(owner, input);
    f.state.at = LATER;
    await expect(
      f.runtime.readApprovedInput(owner, input, "context")
    ).rejects.toThrow();
    closedDomains(f, "storage-review-expired");
    return expect(f.table(closures)[0]!["payload"].authority.resourceId).toBe(
      review["reviewId"]
    );
  });
  it("original corpus review expiry bounds the plan and retains its exact review provenance", async () => {
    const f = await lifecycleFixture({ corpusReviewExpiresAt: LATER }),
      { input, plan } = await f.approve();
    expect(plan["expiresAt"]).toBe(LATER);
    await f.runtime.writeApprovedInputs(owner, input);
    f.state.at = LATER;
    await expect(
      f.runtime.readApprovedInput(owner, input, "context")
    ).rejects.toThrow();
    // Storage approval inherits this deadline too; report the exact original
    // corpus source of that bound, not a guessed grant-revocation cause.
    closedDomains(f, "corpus-review-expired");
    return expect(f.table(closures)[0]!["payload"].authority).toEqual({
      kind: "corpus-review",
      resourceId: f.corpusReview.reviewId,
      version: f.corpusReview.reviewVersion,
    });
  });
  it.each(["create", "inspect", "read"] as const)(
    "definitive %s invalid/conflict is not unknown or another dispatch",
    async (operation) => {
      for (const status of ["invalid", "conflict"] as const) {
        const f = await approved();
        if (operation !== "create")
          await f.runtime.writeApprovedInputs(owner, f.input);
        const createdBefore = calls(f, "create").length;
        f.copies.state.failure = { operation, status };
        if (operation === "create") {
          await expect(
            f.runtime.writeApprovedInputs(owner, f.input)
          ).rejects.toMatchObject({
            code: status === "invalid" ? "integrity" : "conflict",
          });
          expect(calls(f, "create")).toHaveLength(1);
          expect(calls(f, "inspect")).toHaveLength(0);
          expect(f.table(effects)).toHaveLength(1);
          expect(f.table(observations)).toHaveLength(0);
          f.copies.state.failure = null;
          await f.runtime.writeApprovedInputs(owner, f.input);
          expect(calls(f, "create")).toHaveLength(3);
          expect(
            calls(f, "create").filter(
              (call) => call.copyId === f.table(effects)[0]!["copy_id"]
            )
          ).toHaveLength(1);
        } else {
          await expect(
            f.runtime.readApprovedInput(owner, f.input, "context")
          ).rejects.toMatchObject({
            code: status === "invalid" ? "integrity" : "conflict",
          });
          await expect(
            f.runtime.readApprovedInput(owner, f.input, "context")
          ).rejects.toThrow();
          expect(calls(f, "create")).toHaveLength(createdBefore);
        }
      }
    }
  );
  it("keeps append-only schema and source-only migration definitions in lockstep", () => {
    const schema = readFileSync(
      new URL("../schema/vertex-research-chat-execution.ts", import.meta.url),
      "utf8"
    );
    const migration = readFileSync(
      new URL(
        "../../migration-sources/research-chat-copy-lifecycle.sql",
        import.meta.url
      ),
      "utf8"
    );
    for (const name of [effects, observations, closures]) {
      expect(schema).toContain(name);
      expect(migration).toContain(`CREATE TABLE ${name}`);
    }
    for (const name of [
      "effect_shape",
      "effect_payload",
      "observation_shape",
      "observation_payload",
      "domain_shape",
      "domain_payload",
    ]) {
      expect(schema).toContain(`vertex_chat_copy_${name}`);
      expect(migration).toContain(`vertex_chat_copy_${name}`);
    }
    for (const cause of [
      "rights-denied",
      "rights-expiry",
      "rights-superseded",
      "retention-ended",
      "original-authority-expired",
      "storage-review-expired",
      "storage-review-superseded",
      "corpus-review-expired",
      "corpus-review-superseded",
    ]) {
      expect(schema).toContain(`'${cause}'`);
      expect(migration).toContain(`'${cause}'`);
    }
    expect(migration.match(/BEFORE UPDATE OR DELETE/g)).toHaveLength(3);
    expect(migration.match(/IS TRUE/g)).toHaveLength(3);
    expect(migration).toContain("intent_committed_at_ns");
    expect(migration).not.toContain("dispatched_at_ns");
    expect(schema).toContain('domain: text("domain")');
    return expect(migration).toContain("domain IN ('inputs','derived')");
  });
});
