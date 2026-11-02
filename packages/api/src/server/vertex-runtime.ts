import type { SafePrincipal } from "@darkfactory/auth/types";
import {
  createVertexWorkerStore,
  createVertexResearchChatCopyCleanupStore,
  type VertexWorkerOptions,
} from "@darkfactory/db/server/vertex-worker";
import { createPersistenceContext } from "@darkfactory/db/server/vertex-epoch";
import {
  VertexStoreError,
  type VertexClock,
  type VertexStoreOptions,
} from "@darkfactory/db/server/vertex";
import {
  createVertexWorkerDispatcher,
  type VertexWorkerDispatcherDependencies,
} from "./vertex-dispatch/index.ts";
import { timestampToEpochNanoseconds } from "@darkfactory/shared/vertex";
import { EventEnvelopeSchema } from "../contracts/vertex.ts";
import { VERTEX_WORKER_CONTRACT_SCHEMAS } from "../contracts/vertex-worker.ts";
import { WorkerExperimentHandoffSchema } from "../contracts/vertex-worker-experiment.ts";
import {
  createVertexRequestDependencies,
  vertexPersistenceBoundary,
  type VertexRequestOptions,
  type VertexRequestDependencies,
} from "./vertex-experience-adapter.ts";
import {
  createVertexWorkerDispatchBoundary,
  type VertexWorkerServiceDependencies,
} from "./vertex-worker-service.ts";
import { createVertexRuntimeObjectCapabilities } from "./vertex-runtime-objects.ts";
import {
  createVertexRuntimePolicy,
  type VertexRuntimePolicyOptions,
} from "./vertex-runtime-policy.ts";
import {
  createVertexRuntimeRecipes,
  type VertexRuntimeRecipesOptions,
} from "./vertex-runtime-recipes.ts";
import {
  createVertexRuntimeModelUse,
  type VertexRuntimeModelUseOptions,
} from "./vertex-runtime-model-use.ts";
import {
  createVertexRuntimeNativeProjectionPrincipal,
  type VertexNativeEmitterBinding,
} from "./vertex-runtime-native.ts";
import { createVertexRuntimeBootstrapAuthorization } from "./vertex-runtime-bootstrap.ts";
import { createVertexRuntimeEpochOperations } from "./vertex-runtime-epoch.ts";
import { createVertexRuntimeNativeOutboxReplay } from "./vertex-runtime-replay.ts";
import {
  createVertexRuntimeNotifications,
  type VertexRuntimeNotificationsOptions,
} from "./vertex-runtime-notifications.ts";
import {
  createVertexRuntimeGateway,
  type VertexRuntimeGatewayBinding,
} from "./vertex-runtime-gateway.ts";
import type { VertexChartReadDependencies } from "./vertex-chart-service.ts";
import type { VertexNotificationReadService } from "./vertex-notification-read-service.ts";
import { createVertexResearchChatCopyCleanupService } from "./vertex-research-chat-copy-cleanup-service.ts";
import {
  createVertexResearchChatExecutionRuntime,
  type VertexResearchChatExecutionRuntimeOptions,
} from "./vertex-research-chat-execution-runtime.ts";
import type { VertexResearchChatConversationService } from "./vertex-research-chat-conversation-runtime.ts";
import type { VertexModelPrivacyReviewer } from "./context.ts";
import { ModelUseRequestSchema } from "../contracts/vertex-model-use.ts";
import { present } from "./present.ts";

export type VertexPlatformContextDependencies = VertexRequestDependencies &
  Readonly<{
    vertexChartRead: VertexChartReadDependencies;
    vertexWorker?: VertexWorkerServiceDependencies;
    vertexNotificationRead?: VertexNotificationReadService;
    vertexResearchChatConversation?: VertexResearchChatConversationService;
    vertexModelPrivacyReviewer?: VertexModelPrivacyReviewer;
  }>;

export type VertexRuntimeNotificationRoute = Readonly<{
  eventType: string;
  kind:
    | "market-alert"
    | "research-completed"
    | "research-failed"
    | "operational-alert";
  ttlMilliseconds: number;
}>;
export type VertexPlatformRequestOptions<NotificationContext = unknown> = Omit<
  VertexRequestOptions,
  | "reviewPolicy"
  | "research"
  | "simulation"
  | "resolvePolicy"
  | "commandPolicy"
  | "gateway"
> &
  Readonly<{
    policy?: Omit<
      VertexRuntimePolicyOptions,
      "db" | "clock" | "objectCapabilities" | "signal"
    >;
    gateway?: readonly VertexRuntimeGatewayBinding[];
    worker?: Readonly<{
      routes: VertexRuntimeRecipesOptions["routes"];
      emitterBindings: readonly VertexNativeEmitterBinding[];
      serverPrincipal: (context: unknown) => Promise<SafePrincipal | null>;
      // Independent administrative authorization, never worker bearer authority.
      authorizeGrantAdministration: VertexWorkerOptions["authorizeGrantAdministration"];
    }>;
    modelUse?: Omit<
      VertexRuntimeModelUseOptions,
      | "db"
      | "clock"
      | "objectCapabilities"
      | "policySelection"
      | "readSelectedArtifact"
      | "signal"
      | "chat"
    >;
    researchChat?: Pick<
      VertexResearchChatExecutionRuntimeOptions,
      | "experts"
      | "firstMate"
      | "nativeEvidence"
      | "storage"
      | "privacyReviewerActorId"
    >;
    nativeEpoch?: Omit<
      Parameters<typeof createVertexRuntimeEpochOperations>[1],
      "objectCapabilities" | "signal"
    >;
    notifications?: Omit<
      VertexRuntimeNotificationsOptions<NotificationContext>,
      "db" | "clock" | "signal"
    > &
      Readonly<{
        dispatcher?: Readonly<{
          contextFor: NonNullable<
            VertexWorkerDispatcherDependencies<NotificationContext>["notifications"]
          >["contextFor"];
          routes: readonly VertexRuntimeNotificationRoute[];
          dryRun: boolean;
        }>;
      }>;
  }>;
const unavailable = (): never => {
  throw new VertexStoreError("unavailable");
};
const noPolicy = async () => Object.freeze({});
const notificationSelection = <Context>(
  routes: readonly VertexRuntimeNotificationRoute[],
  clock: VertexClock
): NonNullable<
  VertexWorkerDispatcherDependencies<Context>["notifications"]
>["select"] => {
  const selected = new Map<string, VertexRuntimeNotificationRoute>();
  if (routes.length > 128)
    throw new TypeError("Invalid Vertex runtime configuration");
  for (const entry of routes) {
    const key = `${entry.eventType}:${entry.kind}`;
    if (
      typeof entry.eventType !== "string" ||
      entry.eventType.length < 1 ||
      entry.eventType.length > 128 ||
      selected.has(key) ||
      ![
        "market-alert",
        "research-completed",
        "research-failed",
        "operational-alert",
      ].includes(entry.kind) ||
      !Number.isSafeInteger(entry.ttlMilliseconds) ||
      entry.ttlMilliseconds < 1 ||
      entry.ttlMilliseconds > 86_400_000
    )
      throw new TypeError("Invalid Vertex runtime configuration");
    selected.set(key, Object.freeze({ ...entry }));
  }
  // biome-ignore lint/suspicious/useAwait: async keeps synchronous validation throws as promise rejections for callers
  return async ({ event, signal }) => {
    if (signal.aborted) return null;
    const envelope = EventEnvelopeSchema.parse(event);
    const candidates = [...selected.values()].filter((candidate) => {
      if (candidate.eventType !== envelope.eventType) return false;
      if (candidate.kind === "research-completed")
        return (
          envelope.eventType === "agent.recorded" &&
          envelope.payload.status === "completed"
        );
      if (candidate.kind === "research-failed")
        return (
          envelope.eventType === "agent.recorded" &&
          envelope.payload.status === "failed"
        );
      if (candidate.kind === "market-alert")
        return [
          "quote.observed",
          "candle.observed",
          "trade-flow.observed",
          "volume-profile.observed",
        ].includes(envelope.eventType);
      return true;
    });
    // Ambiguous configured mappings are not permission to choose an alert.
    if (candidates.length !== 1) return null;
    const route = present(candidates[0]);
    const expiry =
      timestampToEpochNanoseconds(envelope.occurredAt) +
      BigInt(route.ttlMilliseconds) * 1_000_000n;
    const now = timestampToEpochNanoseconds(clock.now());
    if (timestampToEpochNanoseconds(envelope.occurredAt) > now || expiry <= now)
      return null;
    return Object.freeze({
      kind: route.kind,
      expiresAt: new Date(Number(expiry / 1_000_000n)).toISOString(),
    });
  };
};

// One borrowed request DB, one outbox dispatcher, explicitly configured backends.
// Construction opens no connection, reads no object, issues no grant, stages no
// job and sends no notification. Only contextDependencies enters the RPC
// context; administration is a separate server-only programmatic surface.
export const createVertexPlatformRequestDependencies = <
  NotificationContext = unknown,
>(
  options: VertexPlatformRequestOptions<NotificationContext>
) => {
  const clock: VertexClock = options.clock ?? {
    now: () => new Date().toISOString(),
  };
  const objectCapabilities = createVertexRuntimeObjectCapabilities(options);
  const policy = options.policy
    ? createVertexRuntimePolicy({
        ...options.policy,
        db: options.db,
        clock,
        objectCapabilities,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    : undefined;
  const gateway =
    options.gateway && policy
      ? createVertexRuntimeGateway({
          db: options.db,
          policy,
          consumerServiceId: present(options.policy).consumerServiceId,
          clock,
          bindings: options.gateway,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        })
      : undefined;
  const base = createVertexRequestDependencies({
    ...options,
    clock,
    gateway,
    resolvePolicy: policy?.resolvePolicy ?? noPolicy,
    ...(policy ? { commandPolicy: policy.commandPolicy } : {}),
  });
  // A distinct storage view, not an alias/fallback to a publication view that
  // may later permit larger content. Chart input allocation remains <=1 MiB.
  const chart = createVertexRequestDependencies({
    db: options.db,
    clock,
    maximumContentBytes: 1_048_576,
    ...(options.maxProjectionAgeMs === undefined
      ? {}
      : { maxProjectionAgeMs: options.maxProjectionAgeMs }),
    ...(options.objects === undefined ? {} : { objects: options.objects }),
    ...(options.objectCapabilities === undefined
      ? {}
      : { objectCapabilities: options.objectCapabilities }),
    ...(options.objectsForScope === undefined
      ? {}
      : { objectsForScope: options.objectsForScope }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    resolvePolicy: policy?.resolvePolicy ?? noPolicy,
  }).vertexExperience;
  const notifications = options.notifications
    ? createVertexRuntimeNotifications<NotificationContext>({
        ...options.notifications,
        db: options.db,
        clock: {
          now: () =>
            Number(timestampToEpochNanoseconds(clock.now()) / 1_000_000n),
        },
        signal: options.signal,
      })
    : undefined;
  const storeOptions: VertexStoreOptions = {
    boundary: vertexPersistenceBoundary,
    authorization: present(base.vertexExperience.authorization),
    clock,
    maxProjectionAgeMs: options.maxProjectionAgeMs ?? 60_000,
    ...(policy ? { commandPolicy: policy.commandPolicy } : {}),
  };
  const chatExecution =
    options.researchChat && options.policy
      ? createVertexResearchChatExecutionRuntime({
          ...options.researchChat,
          policy: options.policy,
          db: options.db,
          clock,
          objectCapabilities,
          maxProjectionAgeMs: options.maxProjectionAgeMs ?? 60_000,
          ...(options.signal ? { signal: options.signal } : {}),
        })
      : undefined;
  const modelUse =
    options.modelUse && policy
      ? createVertexRuntimeModelUse({
          ...options.modelUse,
          db: options.db,
          clock,
          objectCapabilities,
          policySelection: policy.policySelection,
          readSelectedArtifact: policy.readSelectedArtifact,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          ...(chatExecution?.privacy
            ? {
                chat: {
                  owner: chatExecution.workerModel,
                  privacy: chatExecution.privacy,
                },
              }
            : {}),
        })
      : undefined;
  const researchChat = chatExecution
    ? Object.freeze({
        planResearchChatResponse: chatExecution.planResearchChatResponse,
        approveResearchChatResponse: chatExecution.approveResearchChatResponse,
        recordResearchChatStorageQualificationReview:
          chatExecution.recordResearchChatStorageQualificationReview,
        writeApprovedInputs: chatExecution.writeApprovedInputs,
        reconcileApprovedInputs: chatExecution.reconcileApprovedInputs,
        readApprovedInput: chatExecution.readApprovedInput,
        closeApprovedInputs: chatExecution.closeApprovedInputs,
        drainApprovedCopyCleanup: chatExecution.drainApprovedCopyCleanup,
        admitApprovedResponse: chatExecution.admitApprovedResponse,
        recordResearchChatModelPrivacyReview:
          chatExecution.privacy?.recordResearchChatModelPrivacyReview,
        readPrivateAdvisory: chatExecution.output.readAdvisory,
        readPrivateDeliverySource:
          chatExecution.output.readPrivateDeliverySource,
      })
    : undefined;
  const epoch = options.nativeEpoch
    ? createVertexRuntimeEpochOperations(
        createPersistenceContext(options.db, storeOptions),
        {
          ...options.nativeEpoch,
          objectCapabilities,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }
      )
    : undefined;
  const replay = options.nativeEpoch
    ? createVertexRuntimeNativeOutboxReplay(
        createPersistenceContext(options.db, storeOptions),
        {
          ...options.nativeEpoch,
          objectCapabilities,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        }
      )
    : undefined;
  // biome-ignore lint/suspicious/useAwait: async keeps synchronous validation throws as promise rejections for callers
  const validateWorker: VertexWorkerOptions["validateWorker"] = async (
    name,
    value
  ) => {
    // Original authoritative parser, shared with the independent metadata owner.
    if (name === "WorkerExperimentHandoff")
      return WorkerExperimentHandoffSchema.parse(value);
    if (!Object.hasOwn(VERTEX_WORKER_CONTRACT_SCHEMAS, name))
      return unavailable();
    return VERTEX_WORKER_CONTRACT_SCHEMAS[
      name as keyof typeof VERTEX_WORKER_CONTRACT_SCHEMAS
    ].parse(value);
  };
  const chatCopyCleanup = options.worker
    ? createVertexResearchChatCopyCleanupService({
        store: createVertexResearchChatCopyCleanupStore(options.db, {
          boundary: vertexPersistenceBoundary,
          clock,
          validateWorker,
          authorizeGrantAdministration:
            options.worker.authorizeGrantAdministration,
        }),
        clock,
      })
    : undefined;
  if (!(options.worker && policy)) {
    const contextDependencies: VertexPlatformContextDependencies =
      Object.freeze({
        ...base,
        vertexChartRead: chart,
        ...(chatExecution
          ? { vertexResearchChatConversation: chatExecution.conversation }
          : {}),
        ...(chatExecution?.privacy
          ? { vertexModelPrivacyReviewer: chatExecution.privacy }
          : {}),
        ...(notifications
          ? { vertexNotificationRead: notifications.vertexNotificationRead }
          : {}),
      });
    return Object.freeze({
      contextDependencies,
      administration: Object.freeze({
        policy: policy?.registry,
        modelUse: modelUse?.grantAdministration,
        notifications: notifications?.grants,
        chatCopyCleanup,
        researchChat,
      }),
    });
  }
  const bootstrap = createVertexRuntimeBootstrapAuthorization({
    clock,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    serverPrincipal: options.worker.serverPrincipal,
    consumerServiceId: present(options.policy).consumerServiceId,
    materialize: policy.materializeForTransaction,
  });
  const nativeProjectionPrincipal =
    createVertexRuntimeNativeProjectionPrincipal({
      clock,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      emitterBindings: options.worker.emitterBindings,
      policySelection: policy.policySelection,
    });
  const workerStore = createVertexWorkerStore(options.db, {
    ...storeOptions,
    validateWorker,
    objectCapabilities,
    authorizeGrantAdministration: options.worker.authorizeGrantAdministration,
    policySelection: policy.policySelection,
    pinPolicySelection: policy.pinPolicySelection,
    ...bootstrap,
    modelUse: modelUse?.modelUse ?? (async () => unavailable()),
    ...(chatExecution ? { chatWorker: chatExecution.worker } : {}),
    ...(chatExecution?.privacy
      ? {
          chatOutput: chatExecution.output,
          chatModelPrivacyReview: (tx, operation, request, at, bytes) =>
            present(chatExecution.privacy).rendezvousForTransaction(
              tx,
              operation,
              ModelUseRequestSchema.parse(request),
              at,
              bytes
            ),
        }
      : {}),
    epochTransition: epoch?.epochTransition ?? (async () => unavailable()),
    nativeOutboxReplay: replay ?? (async () => unavailable()),
    nativeProjectionPrincipal,
  });
  const recipes = createVertexRuntimeRecipes({
    db: options.db,
    store: present(base.vertexExperience.store),
    workerStore,
    policyRegistry: policy.registry,
    readSelectedArtifact: policy.readSelectedArtifact,
    objectCapabilities,
    clock,
    consumerServiceId: present(options.policy).consumerServiceId,
    routes: options.worker.routes,
    ...(chatExecution ? { chatWorker: chatExecution.worker } : {}),
  });
  const dispatchNotifications = options.notifications?.dispatcher;
  const dispatcher = createVertexWorkerDispatcher<NotificationContext>({
    boundary: createVertexWorkerDispatchBoundary(),
    outboxStore: present(base.vertexExperience.store),
    workerStore,
    resolveBinding: recipes.resolveBinding,
    clock,
    ...(notifications && dispatchNotifications
      ? {
          notifications: {
            dispatch: notifications.dispatch,
            contextFor: dispatchNotifications.contextFor,
            select: notificationSelection<NotificationContext>(
              dispatchNotifications.routes,
              clock
            ),
            dryRun: dispatchNotifications.dryRun,
          },
        }
      : {}),
  });
  const vertexWorker: VertexWorkerServiceDependencies = Object.freeze({
    store: workerStore,
    claim: dispatcher.claim,
    clock,
  });
  const contextDependencies: VertexPlatformContextDependencies = Object.freeze({
    ...base,
    vertexExperience: Object.freeze({
      ...base.vertexExperience,
      validateBacktestRequest: recipes.validateBacktestRequest,
    }),
    vertexChartRead: chart,
    vertexWorker,
    ...(chatExecution
      ? { vertexResearchChatConversation: chatExecution.conversation }
      : {}),
    ...(chatExecution?.privacy
      ? { vertexModelPrivacyReviewer: chatExecution.privacy }
      : {}),
    ...(notifications
      ? { vertexNotificationRead: notifications.vertexNotificationRead }
      : {}),
  });
  return Object.freeze({
    contextDependencies,
    administration: Object.freeze({
      policy: policy.registry,
      modelUse: modelUse?.grantAdministration,
      notifications: notifications?.grants,
      chatCopyCleanup,
      researchChat,
      worker: Object.freeze({
        issueGrant: workerStore.issueGrant,
        revokeGrant: workerStore.revokeGrant,
        enqueueNativeBootstrap: workerStore.enqueueNativeBootstrap,
      }),
    }),
  });
};

export type VertexPlatformRequestDependencies = ReturnType<
  typeof createVertexPlatformRequestDependencies
>;
