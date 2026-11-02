import type { SafePrincipal } from "@darkfactory/auth/types";
import {
  VertexStoreError,
  type VertexAuthorizationRepository,
  type VertexRecord,
  type VertexStore,
} from "@darkfactory/db/server/vertex";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { describe, expect, it, vi } from "vitest";
import { vertexPersistenceBoundary } from "./server/vertex-experience-adapter.ts";
import type { VertexExperienceDependencies } from "./server/vertex-experience-core.ts";
import {
  requestResearchChatCopyCleanup,
  readResearchChatCopyCleanup,
} from "./server/vertex-research-chat.ts";

// Fake ports, real services and real configured persistence boundary only.
// No physical backend, database, policy materialization or model execution.
const principal: SafePrincipal = {
  userId: "fixture-member",
  role: "member",
  status: "active",
};
const scope = {
  accountAlias: "fixture-research",
  environment: "research" as const,
};
const input = {
  ...scope,
  threadId: "thread-a",
  responseRequestId: `response-${"a".repeat(64)}`,
  idempotencyKey: "original-cleanup-key",
};
const now = "2026-09-24T00:00:00Z";
const hash = (value: unknown) => hashArtifact(canonicalArtifactJson(value));
const validateCleanupInput = async (
  name: "requestCopyCleanup" | "readCopyCleanup",
  value: unknown
) => {
  const validate = vertexPersistenceBoundary.validateResearchChatInput;
  if (!validate) throw new Error("Configured chat input boundary is missing");
  return await validate(name, value);
};
const fixture = async () => {
  const requestSha256 = await hash({
    operation: "requestCopyCleanup",
    actorId: principal.userId,
    input,
  });
  const receipt = {
    ...input,
    schemaVersion: "1.0.0",
    executionAuthorized: false,
    status: "requested",
    ownerActorId: principal.userId,
    cleanupRequestId: `copy-cleanup-${requestSha256}`,
    requestSha256,
    recordedAt: now,
    targetKinds: ["context", "model-input", "derived-output"],
  };
  const forbidden = vi.fn(async () => {
    throw new Error("Cleanup must not consult processing or physical ports");
  });
  const request = vi.fn<VertexStore["requestResearchChatCopyCleanup"]>(
    async (value) => {
      await validateCleanupInput("requestCopyCleanup", {
        ...value.scope,
        threadId: value.threadId,
        responseRequestId: value.responseRequestId,
        idempotencyKey: value.idempotencyKey,
      });
      return await vertexPersistenceBoundary.validate(
        "ResearchChatCopyCleanupReceipt",
        receipt,
        "1.0.0"
      );
    }
  );
  const read = vi.fn<VertexStore["readResearchChatCopyCleanup"]>(
    async (_actor, selected, threadId, responseRequestId, idempotencyKey) => {
      await validateCleanupInput("readCopyCleanup", {
        ...selected,
        threadId,
        responseRequestId,
        idempotencyKey,
      });
      return await vertexPersistenceBoundary.validate(
        "ResearchChatCopyCleanupReceipt",
        receipt,
        "1.0.0"
      );
    }
  );
  const authorize = vi.fn(
    async (value: Parameters<VertexAuthorizationRepository["authorize"]>[0]) =>
      value.action === "cleanup-chat-copies" &&
      value.resourceId === `research-chat-copies:${input.responseRequestId}` &&
      value.collectionId === null
  );
  const store = {
    requestResearchChatCopyCleanup: request,
    readResearchChatCopyCleanup: read,
    readResearchChatThread: forbidden,
    listResearchChatMessages: forbidden,
    readResearchChatResponse: forbidden,
    readResearchChatTranscriptPage: forbidden,
    sendResearchChatMessage: forbidden,
    requestResearchChatResponse: forbidden,
  } as unknown as VertexStore;
  const dependencies: VertexExperienceDependencies = {
    store,
    authorization: {
      authorize,
      listAuthorizedScopes: forbidden,
      issueGrant: forbidden,
      revokeGrant: forbidden,
      discoverCleanupFamilies: forbidden,
      authorizeCleanupFamily: forbidden,
    },
    clock: { now: () => now },
    resolvePolicy: forbidden,
  };
  return { receipt, request, read, authorize, forbidden, dependencies };
};
const operations = [
  requestResearchChatCopyCleanup,
  readResearchChatCopyCleanup,
];
const rejection = async (promise: Promise<unknown>, code: string) => {
  return await expect(promise).rejects.toMatchObject({
    name: "VertexExperienceServiceError",
    code,
  });
};

describe("explicit copy cleanup service", () => {
  it("requests and reads the original ACK using only exact dedicated cleanup authority", async () => {
    const h = await fixture();
    const requested = await requestResearchChatCopyCleanup(
      h.dependencies,
      principal,
      input
    );
    const read = await readResearchChatCopyCleanup(
      h.dependencies,
      principal,
      input
    );
    expect(requested).toEqual(h.receipt);
    expect(read).toEqual(requested);
    expect(Object.isFrozen(requested)).toBe(true);
    expect(Object.isFrozen(read.targetKinds)).toBe(true);
    expect(h.request).toHaveBeenCalledExactlyOnceWith({
      principal: { actorId: principal.userId },
      scope,
      threadId: input.threadId,
      responseRequestId: input.responseRequestId,
      idempotencyKey: input.idempotencyKey,
    });
    expect(h.read).toHaveBeenCalledExactlyOnceWith(
      { actorId: principal.userId },
      scope,
      input.threadId,
      input.responseRequestId,
      input.idempotencyKey
    );
    expect(h.authorize.mock.calls.map(([value]) => value)).toEqual(
      [0, 1].map(() => ({
        principal: { actorId: principal.userId },
        scope,
        resourceId: `research-chat-copies:${input.responseRequestId}`,
        action: "cleanup-chat-copies",
        collectionId: null,
        now,
      }))
    );
    return expect(h.forbidden).not.toHaveBeenCalled();
  });

  it("registers exact input names and the receipt in the actual persistence boundary", async () => {
    const h = await fixture();
    for (const name of ["requestCopyCleanup", "readCopyCleanup"] as const) {
      expect(await validateCleanupInput(name, input)).toEqual(input);
      await expect(
        validateCleanupInput(name, { ...input, human: true })
      ).rejects.toThrow();
    }
    expect(
      await vertexPersistenceBoundary.validate(
        "ResearchChatCopyCleanupReceipt",
        h.receipt,
        "1.0.0"
      )
    ).toEqual(h.receipt);
    return await expect(
      vertexPersistenceBoundary.validate(
        "ResearchChatCopyCleanupReceipt",
        { ...h.receipt, ready: true },
        "1.0.0"
      )
    ).rejects.toThrow();
  });

  it("does not promote processing grants or inactive principals to cleanup authority", async () => {
    for (const operation of operations) {
      const h = await fixture();
      h.authorize.mockImplementation(
        async (value) => value.action === "read" || value.action === "publish"
      );
      await rejection(operation(h.dependencies, principal, input), "FORBIDDEN");
      await rejection(
        operation(h.dependencies, { ...principal, status: "suspended" }, input),
        "FORBIDDEN"
      );
      expect(h.request).not.toHaveBeenCalled();
      expect(h.read).not.toHaveBeenCalled();
      expect(h.forbidden).not.toHaveBeenCalled();
    }
  });

  it("captures exact detached input and server actor before the first await", async () => {
    for (const operation of operations) {
      const h = await fixture();
      let release: (allowed: boolean) => void = () => {
        throw new Error("Authorization has not started");
      };
      h.authorize.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            return (release = resolve);
          })
      );
      const raw = { ...input };
      const mutablePrincipal = { ...principal };
      const pending = operation(h.dependencies, mutablePrincipal, raw);
      raw.accountAlias = "other-account";
      raw.threadId = "other-thread";
      raw.responseRequestId = `response-${"b".repeat(64)}`;
      raw.idempotencyKey = "new-key";
      mutablePrincipal.userId = "other-actor";
      release(true);
      expect(await pending).toEqual(h.receipt);
      expect(h.authorize.mock.calls[0]?.[0]).toMatchObject({
        principal: { actorId: principal.userId },
        scope,
        resourceId: `research-chat-copies:${input.responseRequestId}`,
      });
    }
  });

  it("rejects malformed or extra authority input before authorization and persistence", async () => {
    for (const operation of operations) {
      const h = await fixture();
      const getter = vi.fn(() => input.threadId);
      const accessor = Object.defineProperty({ ...input }, "threadId", {
        enumerable: true,
        get: getter,
      });
      for (const raw of [
        accessor,
        { ...input, human: true },
        { ...input, body: "private" },
        { ...input, environment: "paper" },
        { ...input, threadId: "thread-a\n" },
      ]) {
        await rejection(
          operation(h.dependencies, principal, raw),
          "BAD_REQUEST"
        );
      }
      expect(getter).not.toHaveBeenCalled();
      expect(h.authorize).not.toHaveBeenCalled();
      expect(h.request).not.toHaveBeenCalled();
      expect(h.read).not.toHaveBeenCalled();
    }
  });

  it("independently rejects every substituted source identity, target or authority field", async () => {
    const changes: Record<string, unknown>[] = [
      { ownerActorId: "other-owner" },
      { accountAlias: "other-account" },
      { environment: "paper" },
      { threadId: "other-thread" },
      { responseRequestId: `response-${"b".repeat(64)}` },
      { idempotencyKey: "other-key" },
      {
        requestSha256: "c".repeat(64),
        cleanupRequestId: `copy-cleanup-${"c".repeat(64)}`,
      },
      { cleanupRequestId: `copy-cleanup-${"d".repeat(64)}` },
      { status: "complete" },
      { executionAuthorized: true },
      { targetKinds: ["context", "model-input"] },
      { targetKinds: ["derived-output", "model-input", "context"] },
      { recordedAt: "2026-02-30T00:00:00Z" },
      { recordedAt: `${now}\n` },
      { ready: true },
      { profile: "private" },
    ];

    for (const operation of operations) {
      const h = await fixture();
      for (const change of changes) {
        const substituted: VertexRecord = { ...h.receipt, ...change };
        h.request.mockResolvedValue(substituted);
        h.read.mockResolvedValue(substituted);
        await rejection(
          operation(h.dependencies, principal, input),
          "INVALID_SOURCE"
        );
      }
      const getter = vi.fn(() => principal.userId);
      const hostile = Object.defineProperty({ ...h.receipt }, "ownerActorId", {
        enumerable: true,
        get: getter,
      });
      h.request.mockResolvedValue(hostile);
      h.read.mockResolvedValue(hostile);
      await rejection(
        operation(h.dependencies, principal, input),
        "INVALID_SOURCE"
      );
      expect(getter).not.toHaveBeenCalled();
      expect(h.forbidden).not.toHaveBeenCalled();
    }
  });

  it("returns NOT_FOUND only for absent original ACK and never manufactures a physical status", async () => {
    const h = await fixture();
    h.read.mockResolvedValue(null);
    await rejection(
      readResearchChatCopyCleanup(h.dependencies, principal, input),
      "NOT_FOUND"
    );
    expect(h.request).not.toHaveBeenCalled();
    expect(h.read).toHaveBeenCalledTimes(1);
    return expect(h.forbidden).not.toHaveBeenCalled();
  });

  it("preserves unknown outcomes and never retries writes or supplies a fresh key", async () => {
    const h = await fixture();
    h.request.mockRejectedValueOnce(
      new Error("committed but acknowledgement lost")
    );
    await rejection(
      requestResearchChatCopyCleanup(h.dependencies, principal, input),
      "SERVICE_UNAVAILABLE"
    );
    expect(h.request).toHaveBeenCalledTimes(1);
    expect(h.read).not.toHaveBeenCalled();
    expect(
      await readResearchChatCopyCleanup(h.dependencies, principal, input)
    ).toEqual(h.receipt);
    expect(h.request).toHaveBeenCalledTimes(1);
    return expect(h.forbidden).not.toHaveBeenCalled();
  });

  it("maps store denials/conflicts/integrity and infrastructure failures without source disclosure", async () => {
    for (const operation of operations) {
      const h = await fixture();

      for (const [error, code] of [
        [new VertexStoreError("denied"), "FORBIDDEN"],
        [new VertexStoreError("conflict"), "CONFLICT"],
        [new VertexStoreError("integrity"), "INVALID_SOURCE"],
        [new Error("private"), "SERVICE_UNAVAILABLE"],
      ] as const) {
        h.request.mockRejectedValue(error);
        h.read.mockRejectedValue(error);
        await rejection(operation(h.dependencies, principal, input), code);
      }
    }
  });

  it("does not turn cancellation before or after persistence into a successful ACK", async () => {
    for (const operation of operations) {
      const h = await fixture();
      const controller = new AbortController();
      const dependencies = { ...h.dependencies, signal: controller.signal };
      h.request.mockImplementation(async () => {
        controller.abort();
        return h.receipt;
      });
      h.read.mockImplementation(async () => {
        controller.abort();
        return h.receipt;
      });
      await rejection(
        operation(dependencies, principal, input),
        "SERVICE_UNAVAILABLE"
      );
      await rejection(
        operation(dependencies, principal, input),
        "SERVICE_UNAVAILABLE"
      );
      expect(h.request.mock.calls.length + h.read.mock.calls.length).toBe(1);
      expect(h.forbidden).not.toHaveBeenCalled();
    }
  });
});
