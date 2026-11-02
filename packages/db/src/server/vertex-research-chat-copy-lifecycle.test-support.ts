import { hashArtifact } from "@darkfactory/shared/vertex";
import type {
  VertexChatCopyBinding,
  VertexChatCopyCapabilities,
  VertexChatCopyRead,
} from "@darkfactory/storage/chat-copies";
import { expect } from "vitest";
import {
  compositionFixture,
  owner,
  reviewer,
  scope,
} from "../../../api/src/server/vertex-research-chat-execution-runtime.test-support.ts";
import { createVertexResearchChatExecutionRuntime } from "../../../api/src/server/vertex-research-chat-execution-runtime.ts";
import type {
  VertexR2Bucket,
  VertexR2GetOptions,
  VertexR2Object,
  VertexR2PutOptions,
} from "../../../storage/src/r2.ts";
import { createVertexR2ChatCopyCapabilities } from "../../../storage/src/r2-chat-copies.ts";

export const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((accept) => {
    return (resolve = accept);
  });
  return { promise, resolve };
};
// Only PostgreSQL/object transport/clock boundaries are doubles. REAL concrete
// runtime, grants, rights, human prefix, producer, approval and copy primitives.
export const lifecycleFixture = async (
  fixtureOptions: Parameters<typeof compositionFixture>[0] = {}
) => {
  const f = await compositionFixture(fixtureOptions);
  const objects = new Map<
    string,
    { bytes: Uint8Array; object: VertexR2Object }
  >();
  const calls: { operation: string; copyId: string }[] = [];
  const state = {
    // Hook results are ignored; tests may return whatever their last step yields.
    createMode: "normal" as
      | "normal"
      | "unknown-before"
      | "unknown-after"
      | "throw-after",
    fenceMode: "normal" as "normal" | "unknown-before" | "unknown-after",
    inspectMissing: false,
    failure: null as null | Readonly<{
      operation: "create" | "inspect" | "read";
      status: "invalid" | "conflict";
    }>,
    readTransform: (value: VertexChatCopyRead): VertexChatCopyRead => value,
    afterCreate: async (_binding: VertexChatCopyBinding): Promise<unknown> =>
      undefined,
    afterRead: async (_binding: VertexChatCopyBinding): Promise<unknown> =>
      undefined,
    afterFence: async (_binding: VertexChatCopyBinding): Promise<unknown> =>
      undefined,
  };
  let serial = 0;
  const copyObject = (value: VertexR2Object): VertexR2Object => ({
    ...value,
    uploaded: new Date(value.uploaded.getTime()),
    checksums: { sha256: value.checksums.sha256?.slice(0) },
    httpMetadata: { ...value.httpMetadata },
    customMetadata: { ...value.customMetadata },
  });
  const bucket: VertexR2Bucket = {
    head: async (key: string) => {
      const value = objects.get(key);
      return value ? copyObject(value.object) : null;
    },
    put: async (
      key: string,
      supplied: Uint8Array,
      options: VertexR2PutOptions
    ) => {
      expect(f.state.inTransaction()).toBe(false);
      const bytes = new Uint8Array(supplied);
      expect(await hashArtifact(bytes)).toBe(options.sha256);
      const absent = options.onlyIf.get("If-None-Match"),
        header = options.onlyIf.get("If-Match");
      const match =
        header === null ? null : /^"([A-Za-z0-9_.:-]+)"$/.exec(header)?.[1];
      if (!((absent === "*" && header === null) || (absent === null && match)))
        throw new Error("Unsafe fixture conditional write");
      const prior = objects.get(key);
      if ((absent === "*" && prior) || (match && prior?.object.etag !== match))
        return null;
      serial += 1;
      const object: VertexR2Object = {
        key,
        size: bytes.byteLength,
        etag: `fixture-etag-${serial}`,
        version: `fixture-version-${serial}`,
        uploaded: new Date(f.state.at),
        checksums: {
          sha256: Uint8Array.from(options.sha256.match(/../g)!, (part) =>
            Number.parseInt(part, 16)
          ).buffer as ArrayBuffer,
        },
        httpMetadata: { ...options.httpMetadata },
        customMetadata: { ...options.customMetadata },
      };
      objects.set(key, { bytes, object });
      return copyObject(object);
    },
    get: async (key: string, options: VertexR2GetOptions) => {
      expect(f.state.inTransaction()).toBe(false);
      const value = objects.get(key);
      if (!value) return null;
      if (value.object.etag !== options.onlyIf.etagMatches)
        return copyObject(value.object);
      const bytes = value.bytes.slice(
        options.range.offset,
        options.range.offset + options.range.length
      );
      return {
        ...copyObject(value.object),
        range: { offset: 0, length: bytes.byteLength },
        body: new ReadableStream<Uint8Array>({
          start: (controller) => {
            controller.enqueue(bytes);
            return controller.close();
          },
        }),
      };
    },
  };
  const raw = createVertexR2ChatCopyCapabilities({
    bucket,
    scope,
    storageProfileSha256: f.runtimeOptions.storage.storageProfileSha256,
    maximumBytes: 1_048_576,
  });
  const boundary = (operation: string, binding: VertexChatCopyBinding) => {
    // Another concurrent request may own a transaction. The actual dispatching
    // async call must be outside its OWN active transaction.
    expect(f.state.inTransaction()).toBe(false);
    calls.push({ operation, copyId: binding.copyId });
    if (operation === "create" || operation === "fence")
      return expect(
        f
          .table("vertex_research_chat_copy_effects")
          .some(
            (row) =>
              row["copy_id"] === binding.copyId &&
              row["operation"] === operation
          )
      ).toBe(true);
    return;
  };
  const capabilities: VertexChatCopyCapabilities = {
    createCopy: async (binding, bytes) => {
      boundary("create", binding);
      if (state.failure?.operation === "create")
        return { status: state.failure.status };
      if (state.createMode === "unknown-before") {
        await state.afterCreate(binding);
        return { status: "unknown" };
      }
      const result = await raw.createCopy(binding, bytes);
      await state.afterCreate(binding);
      if (state.createMode === "throw-after")
        throw new Error("Lost external acknowledgement");
      return state.createMode === "unknown-after"
        ? { status: "unknown" }
        : result;
    },
    inspectCopy: async (binding) => {
      boundary("inspect", binding);
      if (state.failure?.operation === "inspect")
        return { status: state.failure.status };
      return state.inspectMissing
        ? { status: "missing" }
        : raw.inspectCopy(binding);
    },
    readCopy: async (binding) => {
      boundary("read", binding);
      if (state.failure?.operation === "read")
        return { status: state.failure.status };
      const result = await raw.readCopy(binding);
      await state.afterRead(binding);
      return state.readTransform(result);
    },
    fenceCopy: async (binding) => {
      boundary("fence", binding);
      if (state.fenceMode === "unknown-before") return { status: "unknown" };
      const result = await raw.fenceCopy(binding);
      await state.afterFence(binding);
      return state.fenceMode === "unknown-after"
        ? { status: "unknown" }
        : result;
    },
  };
  const runtime = createVertexResearchChatExecutionRuntime({
    ...f.runtimeOptions,
    storage: { ...f.runtimeOptions.storage, capabilities },
  });
  const selector = {
    ...scope,
    threadId: f.request.threadId,
    responseRequestId: f.responseRequestId,
  };
  const approve = async (reviewExpiresAt?: string) => {
    const plan = await runtime.planResearchChatResponse(owner, f.request);
    const review = await runtime.recordResearchChatStorageQualificationReview(
      reviewer,
      {
        ...f.reviewInput(plan),
        ...(reviewExpiresAt ? { expiresAt: reviewExpiresAt } : {}),
      }
    );
    const approval = await runtime.approveResearchChatResponse(
      owner,
      f.approveInput(plan)
    );
    return { plan, review, approval, input: f.approveInput(plan) };
  };
  const grantCleanup = async (
    actorId = "fixture-cleanup",
    expiresAt = "2026-09-25T13:00:00.000000001Z"
  ) => {
    await f.grant(actorId, "account-scope", ["read"], null, expiresAt);
    await f.grant(
      actorId,
      `research-chat-copies:${f.responseRequestId}`,
      ["cleanup-chat-copies"],
      null,
      expiresAt
    );
    return { actorId };
  };
  const revokeContext = async () => {
    const grantId = `grant-${await hashArtifact({ actorId: owner.actorId, resourceId: `research-chat-context-use:${f.responseRequestId}`, actions: ["publish"], collectionId: null })}`;
    return await f.authorization.revokeGrant({
      principal: { actorId: "fixture-grant-admin" },
      grantId,
      scope,
      collectionId: null,
      version: "2.0.0",
      expectedVersion: "1.0.0",
    });
  };
  return {
    ...f,
    runtime,
    copies: { objects, calls, state, capabilities },
    selector,
    approve,
    grantCleanup,
    revokeContext,
  };
};
