import { z } from "zod";
import {
  type DeepReadonly,
  deepFreezeArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import type {
  VertexResearchChatCopyCleanupStore,
  WorkerServiceIdentity,
} from "@darkfactory/db/server/vertex-worker";
import { MAX_VERTEX_CHAT_COPY_BYTES } from "@darkfactory/storage/chat-copies";
import { TimestampSchema } from "../contracts/vertex.ts";
import { VertexResearchChatCopyCleanupReceiptSchema } from "../contracts/vertex-research-chat-copy-cleanup.ts";
import {
  VertexWorkerServiceError,
  boundedJson,
  parse,
  authenticateVertexWorkerRequest,
  sourceFailure,
  type VertexWorkerRequestContext,
} from "./vertex-worker-auth.ts";

// Server-only metadata views. No public contract, endpoint, context dependency,
// body field, processing callback or cleanup execution method is added.
const id = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/)
  .refine((value) => value.trim() === value);
const digest = z
  .string()
  .length(64)
  .regex(/^[0-9a-f]{64}$/);
const timestamp = z
  .string()
  .refine((value) => value.trim() === value)
  .pipe(TimestampSchema);
const responseId = z
  .string()
  .length(73)
  .regex(/^response-[0-9a-f]{64}$/);
const copyId = z
  .string()
  .length(74)
  .regex(/^chat-copy-[0-9a-f]{64}$/);
const scope = z
  .object({ accountAlias: id, environment: z.literal("research") })
  .strict();
const cursor = z.object({ ...scope.shape, afterGrantId: id }).strict();
const discoverInput = z
  .object({
    ...scope.shape,
    cursor: cursor.nullable(),
    limit: z.number().int().min(1).max(64),
  })
  .strict();
const readInput = z
  .object({ ...scope.shape, responseRequestId: responseId })
  .strict();
const page = z
  .object({
    responseRequestIds: z
      .array(responseId)
      .max(64)
      .refine((ids) => new Set(ids).size === ids.length),
    nextCursor: cursor.nullable(),
  })
  .strict();
const kinds = z.enum(["context", "model-input", "derived-output"]);
const byteLength = z.number().int().min(1).max(MAX_VERTEX_CHAT_COPY_BYTES);
const pin = z.object({ sha256: digest, byteLength }).strict();
const metadata = z
  .object({
    ...scope.shape,
    threadId: id,
    parentMessageId: id,
    participantId: id,
    snapshotRevision: z.string().regex(/^[1-9][0-9]{0,29}$/),
    contextStartSequence: z.string().regex(/^[1-9][0-9]{0,29}$/),
    idempotencyKey: id,
  })
  .strict();
const bindingFields = {
  scope,
  ownerActorId: id,
  threadId: id,
  responseRequestId: responseId,
  copyId,
  kind: kinds,
  storageProfileSha256: digest,
  maximumBytes: byteLength,
  reservationSha256: digest,
};
const allocation = z
  .object({
    ...bindingFields,
    profile: z.literal("vertex-research-chat-copy-allocation-v1"),
    requestSha256: digest,
    copyIdempotencyKey: id,
    parentCopyIds: z.array(copyId).max(63),
    reservedAt: timestamp,
    binding: z.object({ ...bindingFields, content: z.null() }).strict(),
    objectKey: z.string().min(1).max(2048),
  })
  .strict();
const contentBinding = z
  .object({
    profile: z.literal("vertex-research-chat-copy-content-binding-v1"),
    scope,
    responseRequestId: responseId,
    copyId,
    reservationSha256: digest,
    content: pin,
    boundAt: timestamp,
  })
  .strict();
const inventory = z
  .object({
    family: z
      .object({
        profile: z.literal("vertex-research-chat-copy-family-v1"),
        ...scope.shape,
        ownerActorId: id,
        threadId: id,
        responseRequestId: responseId,
        requestSha256: digest,
        requestMetadata: metadata,
        storageProfileSha256: digest,
        createdAt: timestamp,
      })
      .strict(),
    copies: z
      .array(
        z
          .object({ allocation, contentBinding: contentBinding.nullable() })
          .strict()
      )
      .min(1)
      .max(64),
    closure: z
      .object({
        profile: z.literal("vertex-research-chat-copy-closure-v1"),
        scope,
        responseRequestId: responseId,
        closureId: z
          .string()
          .length(77)
          .regex(/^copy-closure-[0-9a-f]{64}$/),
        closedByActorId: id,
        closedAt: timestamp,
        inventorySha256: digest,
        copyIds: z.array(copyId).max(64),
      })
      .strict()
      .nullable(),
  })
  .strict();
const readOutput = z
  .object({
    inventory,
    explicitIntent: VertexResearchChatCopyCleanupReceiptSchema.nullable(),
  })
  .strict()
  .nullable();
export type VertexResearchChatCopyCleanupServiceDependencies = Readonly<{
  store: VertexResearchChatCopyCleanupStore;
  clock: Readonly<{ now: () => string }>;
}>;

export const createVertexResearchChatCopyCleanupService = (
  dependencies: VertexResearchChatCopyCleanupServiceDependencies
) => {
  const authenticate = async (
    context: VertexWorkerRequestContext,
    inputScope: z.infer<typeof scope>
  ): Promise<WorkerServiceIdentity> => {
    if (!(dependencies?.store && dependencies.clock) || context.signal?.aborted)
      throw new VertexWorkerServiceError("SERVICE_UNAVAILABLE");
    return await authenticateVertexWorkerRequest(
      context,
      inputScope,
      "chat-copy-cleanup-discovery",
      dependencies.store,
      dependencies.clock
    );
  };
  const finish = <T>(
    context: VertexWorkerRequestContext,
    identity: WorkerServiceIdentity,
    raw: unknown,
    schema: z.ZodType<T>
  ): DeepReadonly<T> => {
    boundedJson(raw, 1_048_576, "INVALID_SOURCE");
    const envelope = parse(
      z
        .object({
          value: z.unknown(),
          checkedAt: timestamp,
          expiresAt: timestamp,
        })
        .strict(),
      raw,
      "INVALID_SOURCE"
    );
    const result = deepFreezeArtifact(
      parse(schema, envelope.value, "INVALID_SOURCE")
    );
    const now = timestampToEpochNanoseconds(
      parse(timestamp, dependencies.clock.now(), "SERVICE_UNAVAILABLE")
    );
    if (context.signal?.aborted)
      throw new VertexWorkerServiceError("SERVICE_UNAVAILABLE");
    // SQL/commit, schema traversal and copying may have crossed either expiry.
    // Authority windows stay private; only the bounded metadata value leaves.
    if (
      now < timestampToEpochNanoseconds(envelope.checkedAt) ||
      now >= timestampToEpochNanoseconds(envelope.expiresAt) ||
      now >= timestampToEpochNanoseconds(identity.expiresAt)
    )
      throw new VertexWorkerServiceError("FORBIDDEN");
    return result;
  };
  const discover = async (
    context: VertexWorkerRequestContext,
    raw: unknown
  ) => {
    try {
      boundedJson(raw, 8192, "BAD_REQUEST");
      const input = parse(discoverInput, raw, "BAD_REQUEST");
      if (
        input.cursor &&
        (input.cursor.accountAlias !== input.accountAlias ||
          input.cursor.environment !== input.environment)
      )
        throw new VertexWorkerServiceError("BAD_REQUEST");
      const identity = await authenticate(context, {
        accountAlias: input.accountAlias,
        environment: input.environment,
      });
      const result = await dependencies.store.discover(identity, {
        cursor: input.cursor,
        limit: input.limit,
      });
      const output = finish(context, identity, result, page);
      if (
        output.responseRequestIds.length > input.limit ||
        (output.nextCursor &&
          (output.nextCursor.accountAlias !== input.accountAlias ||
            output.nextCursor.environment !== input.environment ||
            (input.cursor &&
              output.nextCursor.afterGrantId <= input.cursor.afterGrantId)))
      )
        throw new VertexWorkerServiceError("INVALID_SOURCE");
      return output;
    } catch (error) {
      return sourceFailure(error);
    }
  };
  const read = async (context: VertexWorkerRequestContext, raw: unknown) => {
    try {
      boundedJson(raw, 8192, "BAD_REQUEST");
      const input = parse(readInput, raw, "BAD_REQUEST");
      const identity = await authenticate(context, {
        accountAlias: input.accountAlias,
        environment: input.environment,
      });
      const result = await dependencies.store.read(
        identity,
        input.responseRequestId
      );
      const output = finish(context, identity, result, readOutput);
      if (
        output &&
        (output.inventory.family.accountAlias !== input.accountAlias ||
          output.inventory.family.environment !== input.environment ||
          output.inventory.family.responseRequestId !== input.responseRequestId)
      )
        throw new VertexWorkerServiceError("INVALID_SOURCE");
      return output;
    } catch (error) {
      return sourceFailure(error);
    }
  };
  return Object.freeze({ discover, read });
};
