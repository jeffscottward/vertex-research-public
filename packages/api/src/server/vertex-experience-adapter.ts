import type { SafePrincipal } from "@darkfactory/auth/types";
import type { Database } from "@darkfactory/db/server";
import {
  createVertexAuthorization,
  createVertexObjectMetadataRepository,
  createVertexStore,
  type VertexBoundary,
  type VertexClock,
  type VertexPrincipal,
  type VertexScope,
  type VertexStoreOptions,
} from "@darkfactory/db/server/vertex";
import type { StoragePort } from "@darkfactory/storage";
import {
  createVertexArtifactStorage,
  createVertexReadPort,
  type VertexArtifactStorageDependencies,
  type VertexObjectCapabilities,
  type VertexReadLookup,
} from "@darkfactory/storage/vertex";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { VERTEX_CONTRACT_SCHEMAS } from "../contracts/vertex.ts";
import {
  VERTEX_CONTROL_CONTRACT_SCHEMAS,
  VertexPortfolioGetInputSchema,
  parseExecutionProjection,
} from "../contracts/vertex-control.ts";
import {
  VERTEX_NATIVE_FACT_CONTRACT_SCHEMAS,
  parseNativeFactProjection,
} from "../contracts/vertex-native-facts.ts";
import { VERTEX_EPOCH_CONTRACT_SCHEMAS } from "../contracts/vertex-worker-epoch.ts";
import {
  VertexResearchChatThreadSchema,
  VertexResearchChatMessageSchema,
  VertexResearchChatSendMessageOutputSchema,
  VertexResearchChatCreateThreadInputSchema,
  VertexResearchChatSendMessageInputSchema,
  VertexResearchChatListThreadsInputSchema,
  VertexResearchChatReadThreadInputSchema,
  VertexResearchChatListMessagesInputSchema,
  VertexResearchChatReadTranscriptPageInputSchema,
  VertexResearchChatReadTranscriptPageOutputSchema,
  VertexResearchChatAgentReferenceMessageSchema,
} from "../contracts/vertex-research-chat.ts";
import {
  VertexResearchChatRequestResponseInputSchema,
  VertexResearchChatReadResponseInputSchema,
  VertexResearchChatResponseReceiptSchema,
  VertexResearchChatReadResponseOutputSchema,
} from "../contracts/vertex-research-chat-response.ts";
import {
  VertexResearchChatRequestCopyCleanupInputSchema,
  VertexResearchChatReadCopyCleanupInputSchema,
  VertexResearchChatCopyCleanupReceiptSchema,
} from "../contracts/vertex-research-chat-copy-cleanup.ts";
import {
  VertexResearchChatAppendResponseInputSchema,
  VertexResearchChatAppendResponseOutputSchema,
} from "../contracts/vertex-research-chat-conversation.ts";
import type {
  VertexReadDependencies,
  VertexReadPort,
} from "./vertex-service.ts";
import {
  authorizeVertex,
  failVertex,
  requireVertexScope,
  vertexActor,
  vertexInput,
  VertexExperienceServiceError,
  type VertexExperienceDependencies,
} from "./vertex-experience-core.ts";
import { present } from "./present.ts";

const schemas = {
  ...VERTEX_CONTRACT_SCHEMAS,
  ...VERTEX_CONTROL_CONTRACT_SCHEMAS,
  ...VERTEX_NATIVE_FACT_CONTRACT_SCHEMAS,
  ...VERTEX_EPOCH_CONTRACT_SCHEMAS,
  ResearchChatThread: VertexResearchChatThreadSchema,
  ResearchChatMessage: VertexResearchChatMessageSchema,
  ResearchChatSendMessageOutput: VertexResearchChatSendMessageOutputSchema,
  ResearchChatReadTranscriptPageOutput:
    VertexResearchChatReadTranscriptPageOutputSchema,
  ResearchChatResponseReceipt: VertexResearchChatResponseReceiptSchema,
  ResearchChatReadResponseOutput: VertexResearchChatReadResponseOutputSchema,
  ResearchChatCopyCleanupReceipt: VertexResearchChatCopyCleanupReceiptSchema,
  ResearchChatAgentReferenceMessage:
    VertexResearchChatAgentReferenceMessageSchema,
  ResearchChatAppendResponseOutput:
    VertexResearchChatAppendResponseOutputSchema,
};
const researchChatInputs = Object.freeze({
  createThread: VertexResearchChatCreateThreadInputSchema,
  sendMessage: VertexResearchChatSendMessageInputSchema,
  listThreads: VertexResearchChatListThreadsInputSchema,
  readThread: VertexResearchChatReadThreadInputSchema,
  listMessages: VertexResearchChatListMessagesInputSchema,
  readTranscriptPage: VertexResearchChatReadTranscriptPageInputSchema,
  requestResponse: VertexResearchChatRequestResponseInputSchema,
  readResponse: VertexResearchChatReadResponseInputSchema,
  appendResponse: VertexResearchChatAppendResponseInputSchema,
  requestCopyCleanup: VertexResearchChatRequestCopyCleanupInputSchema,
  readCopyCleanup: VertexResearchChatReadCopyCleanupInputSchema,
});
export const vertexPersistenceBoundary: VertexBoundary = Object.freeze({
  // biome-ignore lint/suspicious/useAwait: async keeps synchronous validation throws as promise rejections for callers
  validate: async (name, value, schemaVersion) => {
    if (schemaVersion !== "1.0.0")
      throw new TypeError("Unsupported Vertex schema");
    canonicalArtifactJson(value);
    if (name === "ExecutionProjection") return parseExecutionProjection(value);
    if (name === "NativeFactProjection")
      return parseNativeFactProjection(value);
    // NativeJournalProof's schema validates the named decoded record here.
    // appendNativeFactProjection separately binds its exact bytes to the
    // projection; its two-argument proof parser is not a shape validator.
    return schemas[name].parse(value);
  },
  // biome-ignore lint/suspicious/useAwait: async keeps synchronous validation throws as promise rejections for callers
  validateResearchChatInput: async (name, value) => {
    canonicalArtifactJson(value);
    if (!Object.hasOwn(researchChatInputs, name))
      throw new TypeError("Unsupported research chat input");
    return Object.freeze(researchChatInputs[name].parse(value));
  },
  encode: (value) => new TextEncoder().encode(canonicalArtifactJson(value)),
  digest: (bytes) => hashArtifact(bytes),
});

// Only the module catalog read lacks account fields; a trusted resolver binds it.
export type VertexLegacyScopeLookup = Readonly<{ kind: "modules" }>;
export type VertexScopedObjects = Readonly<{
  objects: StoragePort;
  objectCapabilities: VertexObjectCapabilities;
}>;
export type VertexRequestOptions = Readonly<{
  // Borrow the established request-scoped resource. This composition never
  // creates a pool, releases a client or schedules work beyond that lifecycle.
  db: Database;
  clock?: VertexClock;
  maxProjectionAgeMs?: number;
  objects?: StoragePort;
  objectCapabilities?: VertexObjectCapabilities;
  objectsForScope?: (
    scope: VertexScope,
    collectionId: string | null,
    signal?: AbortSignal
  ) => VertexScopedObjects | Promise<VertexScopedObjects>;
  maximumContentBytes?: number;
  resolvePolicy?: VertexExperienceDependencies["resolvePolicy"];
  commandPolicy?: VertexStoreOptions["commandPolicy"];
  reviewPolicy?: VertexExperienceDependencies["reviewPolicy"];
  research?: VertexExperienceDependencies["research"];
  simulation?: VertexExperienceDependencies["simulation"];
  gateway?: VertexExperienceDependencies["gateway"];
  signal?: AbortSignal;
  // Existing read routes intentionally lack account fields. Only a trusted
  // server resolver may bind them; never choose the first granted account.
  legacyScope?: (
    principal: SafePrincipal,
    lookup: VertexLegacyScopeLookup
  ) => Promise<Readonly<{ scope: VertexScope; collectionId: string | null }>>;
}>;
export type VertexRequestDependencies = Readonly<{
  vertexExperience: VertexExperienceDependencies;
  vertexRead?: VertexReadDependencies;
}>;

const scopedObjectDependencies = (
  options: VertexRequestOptions,
  scope: VertexScope,
  collectionId: string | null
): Pick<
  VertexArtifactStorageDependencies,
  "objects" | "objectCapabilities"
> => {
  if (!options.objectsForScope)
    return {
      objects: options.objects,
      objectCapabilities: options.objectCapabilities,
    };
  let binding: Promise<VertexScopedObjects> | undefined;
  const resolve = (): Promise<VertexScopedObjects> => {
    if (options.signal?.aborted)
      return Promise.reject(
        new VertexExperienceServiceError("SERVICE_UNAVAILABLE")
      );
    // Called ONLY from a bounded backend capability, after the storage layer's
    // exact current actor/grant/rights checks. Cache a handle, never authority.
    binding ??= Promise.resolve(
      present(options.objectsForScope)(
        Object.freeze({ ...scope }),
        collectionId,
        options.signal
      )
    );
    return binding;
  };
  const unavailable = async () =>
    ({ status: "unavailable", state: "unconfigured" }) as const;
  return {
    // No ordinary overwrite, unbounded fetch or deletion fallback.
    objects: { put: unavailable, get: unavailable, delete: unavailable },
    objectCapabilities: {
      head: async (key) => {
        const port = (await resolve()).objectCapabilities.head;
        if (!port) return failVertex("SERVICE_UNAVAILABLE");
        return port(key);
      },
      getBounded: async (key, maximumBytes) => {
        const port = (await resolve()).objectCapabilities.getBounded;
        if (!port) return failVertex("SERVICE_UNAVAILABLE");
        return port(key, maximumBytes);
      },
      putIfAbsent: async (input) => {
        const port = (await resolve()).objectCapabilities.putIfAbsent;
        if (!port) return failVertex("SERVICE_UNAVAILABLE");
        return port(input);
      },
    },
  };
};

export const createVertexRequestDependencies = (
  options: VertexRequestOptions
): VertexRequestDependencies => {
  const clock = options.clock ?? { now: () => new Date().toISOString() };
  const authorization = createVertexAuthorization(options.db, { clock });
  const store = createVertexStore(options.db, {
    authorization,
    boundary: vertexPersistenceBoundary,
    clock,
    maxProjectionAgeMs: options.maxProjectionAgeMs ?? 60_000,
    ...(options.commandPolicy === undefined
      ? {}
      : { commandPolicy: options.commandPolicy }),
  });
  const storageDependencies = (
    principal: VertexPrincipal,
    scope: VertexScope,
    collectionId: string | null
  ): VertexArtifactStorageDependencies => ({
    ...scopedObjectDependencies(options, scope, collectionId),
    metadata: createVertexObjectMetadataRepository(options.db, {
      principal,
      scope,
      collectionId,
      authorization,
      clock,
      ...(options.maximumContentBytes === undefined
        ? {}
        : { maximumContentBytes: options.maximumContentBytes }),
    }),
    catalog: store,
    rights: {
      resolveRights: (actor, selection, collection, policyId) =>
        store.getRights(actor, selection, collection, policyId),
    },
    authorization: {
      authorize: async (request) => {
        // Export requires a distinct future grant capability. A read grant
        // cannot be silently promoted to export or broker authority.
        if (request.action === "export") return false;
        return await authorization.authorize({
          ...request,
          action: request.action,
        });
      },
    },
    boundary: vertexPersistenceBoundary,
    clock,
    ...(options.maximumContentBytes === undefined
      ? {}
      : { maximumContentBytes: options.maximumContentBytes }),
  });
  const storage = (
    principal: VertexPrincipal,
    scope: VertexScope,
    collectionId: string | null
  ) =>
    createVertexArtifactStorage(
      storageDependencies(principal, scope, collectionId)
    );
  const vertexExperience: VertexExperienceDependencies = {
    store,
    authorization,
    clock,
    storage,
    prepareManifest: (input) =>
      storage(input.principal, input.scope, input.collectionId).stageManifest(
        input
      ),
    ...(options.resolvePolicy === undefined
      ? {}
      : { resolvePolicy: options.resolvePolicy }),
    ...(options.reviewPolicy === undefined
      ? {}
      : { reviewPolicy: options.reviewPolicy }),
    ...(options.research === undefined ? {} : { research: options.research }),
    ...(options.simulation === undefined
      ? {}
      : { simulation: options.simulation }),
    ...(options.gateway === undefined ? {} : { gateway: options.gateway }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  if (!options.legacyScope) return Object.freeze({ vertexExperience });
  const resolve = async (
    principal: SafePrincipal,
    lookup: VertexLegacyScopeLookup
  ) => {
    const resolved = await present(options.legacyScope)(principal, lookup);
    const scope = vertexInput(VertexPortfolioGetInputSchema, resolved.scope);
    const actor = await requireVertexScope(vertexExperience, principal, scope);
    if (resolved.collectionId !== null) return failVertex("FORBIDDEN");
    return { scope, actor, collectionId: resolved.collectionId };
  };
  const reader = async (principal: SafePrincipal, lookup: VertexReadLookup) => {
    const resolved = await resolve(principal, lookup);
    return createVertexReadPort<SafePrincipal>({
      ...storageDependencies(
        resolved.actor,
        resolved.scope,
        resolved.collectionId
      ),
      catalog: store,
      mapPrincipal: vertexActor,
      // Frozen per lookup; a resolver cannot switch account mid-read.
      resolveScope: async () => ({
        scope: resolved.scope,
        collectionId: resolved.collectionId,
      }),
    });
  };
  const read: VertexReadPort = {
    listModules: async (principal) =>
      (await reader(principal, { kind: "modules" })).listModules(principal),
  };
  const allowed = async (
    principal: SafePrincipal,
    lookup: VertexLegacyScopeLookup,
    resourceId: string
  ) => {
    try {
      const selected = await resolve(principal, lookup);
      await authorizeVertex(
        vertexExperience,
        selected.actor,
        selected.scope,
        resourceId,
        "read",
        selected.collectionId
      );
      return true;
    } catch (error) {
      // Preserve the original read service's false=>FORBIDDEN contract.
      if (
        error instanceof VertexExperienceServiceError &&
        error.code === "FORBIDDEN"
      )
        return false;
      throw error;
    }
  };
  return Object.freeze({
    vertexExperience,
    vertexRead: {
      read,
      authorization: {
        canListModules: (principal) =>
          allowed(principal, { kind: "modules" }, "modules"),
      },
    },
  });
};
