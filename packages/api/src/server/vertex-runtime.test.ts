import type { SafePrincipal } from "@darkfactory/auth/types";
import type { Database } from "@darkfactory/db/server";
import { createVertexWorkerStore } from "@darkfactory/db/server/vertex-worker";
import { createVertexWorkerDispatcher } from "./vertex-dispatch/index.ts";
import {
  createVertexArtifactStorage,
  vertexQualifiedObjectKey,
} from "@darkfactory/storage/vertex";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createVertexPlatformRequestDependencies,
  type VertexPlatformRequestOptions,
} from "./vertex-runtime.ts";
import { createVertexRuntimeNotifications } from "./vertex-runtime-notifications.ts";
import { EventEnvelopeSchema } from "../contracts/vertex.ts";

// Authored only, not executed. These spies delegate to actual constructors: no
// substitute request adapter, policy registry, worker store or dispatcher. Every
// external operation is a rejecting/recording fixture; no real DB or provider.
vi.mock("@darkfactory/storage/vertex", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@darkfactory/storage/vertex")>();
  return {
    ...actual,
    createVertexArtifactStorage: vi.fn(actual.createVertexArtifactStorage),
  };
});
vi.mock("@darkfactory/db/server/vertex-worker", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@darkfactory/db/server/vertex-worker")
    >();
  return {
    ...actual,
    createVertexWorkerStore: vi.fn(actual.createVertexWorkerStore),
  };
});
vi.mock("./vertex-dispatch/index.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./vertex-dispatch/index.ts")>();
  return {
    ...actual,
    createVertexWorkerDispatcher: vi.fn(actual.createVertexWorkerDispatcher),
  };
});
vi.mock("./vertex-runtime-notifications.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./vertex-runtime-notifications.ts")>();
  return {
    ...actual,
    createVertexRuntimeNotifications: vi.fn(
      actual.createVertexRuntimeNotifications
    ),
  };
});

const clock = { now: () => "2026-09-22T12:00:00.000Z" };
const scope = { accountAlias: "account-1", environment: "paper" as const };
const actor = { actorId: "member-1" };
const principal: SafePrincipal = {
  userId: "member-1",
  role: "member",
  status: "active",
};
const database = () => {
  const execute = vi.fn(async () => {
    throw new Error("Unexpected DB operation");
  });
  const transaction = vi.fn(async () => {
    throw new Error("Unexpected transaction");
  });
  const dispose = vi.fn(async () => undefined);
  return {
    db: { execute, transaction, dispose } as unknown as Database,
    execute,
    transaction,
    dispose,
  };
};
const objects = () => {
  const unavailable = { status: "unavailable", state: "unconfigured" } as const;
  const put = vi.fn(async () => unavailable);
  const get = vi.fn(async () => unavailable);
  const remove = vi.fn(async () => unavailable);
  const head = vi.fn(async () => unavailable);
  const getBounded = vi.fn(async () => unavailable);
  const putIfAbsent = vi.fn(async () => unavailable);
  return {
    objects: { put, get, delete: remove },
    objectCapabilities: { head, getBounded, putIfAbsent },
    calls: [put, get, remove, head, getBounded, putIfAbsent],
  };
};
const worker = () => ({
  routes: [],
  emitterBindings: [],
  serverPrincipal: vi.fn(
    async (_context: unknown): Promise<SafePrincipal | null> => null
  ),
  authorizeGrantAdministration: vi.fn(async () => false),
});
const policy = () => ({
  consumerServiceId: "fixture-service",
  components: [],
  jobModules: [],
  privilegedAuthorization: { authorize: vi.fn(async () => false) },
});

beforeEach(() => vi.clearAllMocks());

describe("Vertex platform request composition", () => {
  it("borrows the existing database and constructs an inert deny-by-default runtime without policy", async () => {
    const h = database();
    const storage = objects();
    const objectsForScope = vi.fn(() => storage);
    const configuredWorker = worker();
    const dependencies = createVertexPlatformRequestDependencies({
      db: h.db,
      clock,
      ...storage,
      objectsForScope,
      worker: configuredWorker,
    });
    expect(Object.isFrozen(dependencies)).toBe(true);
    expect(Object.isFrozen(dependencies.administration)).toBe(true);
    expect(Object.isFrozen(dependencies.contextDependencies)).toBe(true);
    expect("administration" in dependencies.contextDependencies).toBe(false);
    expect(
      dependencies.contextDependencies.vertexExperience.store
    ).toBeDefined();
    expect(dependencies.contextDependencies.vertexChartRead).toBeDefined();
    expect(dependencies.contextDependencies.vertexWorker).toBeUndefined();
    expect(
      dependencies.contextDependencies.vertexNotificationRead
    ).toBeUndefined();
    expect(dependencies.administration.policy).toBeUndefined();
    expect(dependencies.contextDependencies.vertexRead).toBeUndefined();
    expect(createVertexWorkerStore).not.toHaveBeenCalled();
    expect(createVertexWorkerDispatcher).not.toHaveBeenCalled();
    expect(createVertexRuntimeNotifications).not.toHaveBeenCalled();
    expect(configuredWorker.serverPrincipal).not.toHaveBeenCalled();
    expect(
      configuredWorker.authorizeGrantAdministration
    ).not.toHaveBeenCalled();
    expect(objectsForScope).not.toHaveBeenCalled();
    for (const call of storage.calls) expect(call).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
    return expect(h.dispose).not.toHaveBeenCalled();
  });

  it("creates a distinct chart storage view fixed at one MiB regardless of publication configuration", () => {
    const h = database();
    const storage = objects();
    const dependencies = createVertexPlatformRequestDependencies({
      db: h.db,
      clock,
      ...storage,
      maximumContentBytes: 4_194_304,
    });
    expect(dependencies.contextDependencies.vertexChartRead).not.toBe(
      dependencies.contextDependencies.vertexExperience
    );
    expect(dependencies.contextDependencies.vertexChartRead.storage).not.toBe(
      dependencies.contextDependencies.vertexExperience.storage
    );
    const publication = dependencies.contextDependencies.vertexExperience
      .storage!(actor, scope, null);
    const chart = dependencies.contextDependencies.vertexChartRead.storage!(
      actor,
      scope,
      null
    );
    expect(chart).not.toBe(publication);
    const calls = vi.mocked(createVertexArtifactStorage).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]?.[0]?.maximumContentBytes).toBe(4_194_304);
    expect(calls[1]?.[0]?.maximumContentBytes).toBe(1_048_576);
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
    for (const call of storage.calls) expect(call).not.toHaveBeenCalled();
  });

  it("does not fall back to static object capabilities when the exact scoped binding is unavailable", async () => {
    const h = database();
    const staticStorage = objects();
    const objectsForScope = vi.fn(async () => {
      throw new Error("Scope has no configured backend");
    });
    const signal = new AbortController().signal;
    const dependencies = createVertexPlatformRequestDependencies({
      db: h.db,
      clock,
      ...staticStorage,
      objectsForScope,
      signal,
    });
    dependencies.contextDependencies.vertexChartRead.storage!(
      actor,
      scope,
      "collection-1"
    );
    const captured = vi.mocked(createVertexArtifactStorage).mock.calls[0]![0]!;
    const key = vertexQualifiedObjectKey(
      scope,
      "collection-1",
      "content",
      "a".repeat(64)
    );
    // Inspect the composed bounded backend capability, not a storage admission.
    // No authorization is granted and no artifact read is performed here.
    await expect(
      captured.objectCapabilities!.getBounded!(key, 1_048_576)
    ).rejects.toThrow("Scope has no configured backend");
    expect(objectsForScope).toHaveBeenCalledWith(scope, "collection-1", signal);
    for (const call of staticStorage.calls) expect(call).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    return expect(h.transaction).not.toHaveBeenCalled();
  });

  it("builds one existing dispatcher only when worker and explicit policy are both configured", () => {
    const h = database();
    const configuredWorker = worker();
    const configuredPolicy = policy();
    const dependencies = createVertexPlatformRequestDependencies({
      db: h.db,
      clock,
      worker: configuredWorker,
      policy: configuredPolicy,
    });
    expect(createVertexWorkerStore).toHaveBeenCalledTimes(1);
    expect(createVertexWorkerDispatcher).toHaveBeenCalledTimes(1);
    const store = vi.mocked(createVertexWorkerStore).mock.results[0]!.value;
    const dispatcher = vi.mocked(createVertexWorkerDispatcher).mock.results[0]!
      .value;
    const dispatchOptions = vi.mocked(createVertexWorkerDispatcher).mock
      .calls[0]![0];
    expect(dispatchOptions.workerStore).toBe(store);
    expect(dispatchOptions.outboxStore).toBe(
      dependencies.contextDependencies.vertexExperience.store
    );
    expect(dependencies.contextDependencies.vertexWorker?.store).toBe(store);
    expect(dependencies.contextDependencies.vertexWorker?.claim).toBe(
      dispatcher.claim
    );
    expect("administration" in dependencies.contextDependencies).toBe(false);
    // The no-worker branch omits `worker`; widen the union to read it.
    const administration: Readonly<{
      policy?: unknown;
      worker?: Readonly<Record<string, unknown>>;
    }> = dependencies.administration;
    expect(administration.worker?.["issueGrant"]).toBe(store.issueGrant);
    expect(administration.worker?.["revokeGrant"]).toBe(store.revokeGrant);
    expect(administration.worker?.["enqueueNativeBootstrap"]).toBe(
      store.enqueueNativeBootstrap
    );
    expect(configuredWorker.serverPrincipal).not.toHaveBeenCalled();
    expect(
      configuredWorker.authorizeGrantAdministration
    ).not.toHaveBeenCalled();
    expect(
      configuredPolicy.privilegedAuthorization.authorize
    ).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.transaction).not.toHaveBeenCalled();
    return expect(h.dispose).not.toHaveBeenCalled();
  });

  it("forwards the actual notification read service and separate grant administration without enabling sends", async () => {
    const h = database();
    const serverContext = vi.fn(
      async (_principal: SafePrincipal): Promise<{ session: string } | null> =>
        null
    );
    const authenticate = vi.fn(async () => null);
    const authorize = vi.fn(async () => false);
    const admissionAuthorization = vi.fn(async () => false);
    const signal = new AbortController().signal;
    const dependencies = createVertexPlatformRequestDependencies({
      db: h.db,
      clock,
      signal,
      notifications: {
        authority: { authenticate, authorize },
        admissionAuthorization,
        configuration: null,
        serverContext,
        enabled: true,
      },
    });
    expect(createVertexRuntimeNotifications).toHaveBeenCalledTimes(1);
    const composition = vi.mocked(createVertexRuntimeNotifications).mock
      .results[0]!.value;
    const passed = vi.mocked(createVertexRuntimeNotifications).mock
      .calls[0]![0];
    expect(passed.db).toBe(h.db);
    expect(passed.signal).toBe(signal);
    expect(passed.clock.now()).toBe(Date.parse(clock.now()));
    expect(dependencies.contextDependencies.vertexNotificationRead).toBe(
      composition.vertexNotificationRead
    );
    expect(dependencies.administration.notifications).toBe(composition.grants);
    expect(createVertexWorkerDispatcher).not.toHaveBeenCalled();
    await expect(
      dependencies.contextDependencies.vertexNotificationRead!.delivery(
        principal,
        { ...scope, grantId: "grant-1", version: "1", eventId: "event-1" }
      )
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(serverContext).toHaveBeenCalledWith(principal);
    expect(authenticate).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
    expect(admissionAuthorization).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    return expect(h.transaction).not.toHaveBeenCalled();
  });

  it("wires notifications onto that same dispatcher rather than creating an independent outbox claimant", () => {
    const h = database();
    const contextFor = vi.fn(() => null);
    const options: VertexPlatformRequestOptions = {
      db: h.db,
      clock,
      worker: worker(),
      policy: policy(),
      notifications: {
        authority: {
          authenticate: async () => null,
          authorize: async () => false,
        },
        admissionAuthorization: async () => false,
        configuration: null,
        serverContext: async () => null,
        dispatcher: { contextFor, routes: [], dryRun: true },
      },
    };
    createVertexPlatformRequestDependencies(options);
    expect(createVertexWorkerDispatcher).toHaveBeenCalledTimes(1);
    const notificationComposition = vi.mocked(createVertexRuntimeNotifications)
      .mock.results[0]!.value;
    const dispatchOptions = vi.mocked(createVertexWorkerDispatcher).mock
      .calls[0]![0];
    expect(dispatchOptions.notifications?.dispatch).toBe(
      notificationComposition.dispatch
    );
    expect(dispatchOptions.notifications?.contextFor).toBe(contextFor);
    expect(dispatchOptions.notifications?.dryRun).toBe(true);
    expect(contextFor).not.toHaveBeenCalled();
    expect(h.execute).not.toHaveBeenCalled();
    return expect(h.transaction).not.toHaveBeenCalled();
  });

  it("validates worker contracts only through the authoritative parsers and leaves unconfigured backends unavailable", async () => {
    const h = database();
    createVertexPlatformRequestDependencies({
      db: h.db,
      clock,
      worker: worker(),
      policy: policy(),
    });
    const options = vi.mocked(createVertexWorkerStore).mock.calls[0]![1];
    const fence = {
      accountAlias: "account-1",
      environment: "research",
      jobId: "job-1",
    };
    expect(await options.validateWorker("WorkerStatusInput", fence)).toEqual(
      fence
    );
    await expect(
      options.validateWorker("WorkerStatusInput", { ...fence, extra: true })
    ).rejects.toBeDefined();
    await expect(
      options.validateWorker("WorkerExperimentHandoff", {})
    ).rejects.toBeDefined();
    await expect(
      options.validateWorker("NotAWorkerContract", fence)
    ).rejects.toMatchObject({ code: "unavailable" });
    for (const backend of [
      options.modelUse,
      options.epochTransition,
      options.nativeOutboxReplay,
    ])
      await expect((backend as () => Promise<unknown>)()).rejects.toMatchObject(
        { code: "unavailable" }
      );
    expect(h.execute).not.toHaveBeenCalled();
    return expect(h.transaction).not.toHaveBeenCalled();
  });

  it("rejects invalid notification route configuration at construction", () => {
    const h = database();
    const route = {
      eventType: "agent.recorded",
      kind: "research-completed" as const,
      ttlMilliseconds: 1000,
    };
    const build = (
      routes: NonNullable<
        NonNullable<VertexPlatformRequestOptions["notifications"]>["dispatcher"]
      >["routes"]
    ) =>
      createVertexPlatformRequestDependencies({
        db: h.db,
        clock,
        worker: worker(),
        policy: policy(),
        notifications: {
          authority: {
            authenticate: async () => null,
            authorize: async () => false,
          },
          admissionAuthorization: async () => false,
          configuration: null,
          serverContext: async () => null,
          dispatcher: { contextFor: () => null, routes, dryRun: true },
        },
      });
    for (const routes of [
      Array.from({ length: 129 }, (_, index) => ({
        ...route,
        eventType: `event-${index}`,
      })),
      [route, route],
      [{ ...route, eventType: "" }],
      [{ ...route, kind: "trade-alert" as never }],
      [{ ...route, ttlMilliseconds: 0 }],
      [{ ...route, ttlMilliseconds: 86_400_001 }],
    ])
      expect(() => build(routes)).toThrowError(
        "Invalid Vertex runtime configuration"
      );
    expect(() => build([route])).not.toThrow();
    return expect(h.execute).not.toHaveBeenCalled();
  });

  it("selects only the routed event type and never a future or already expired event", async () => {
    const h = database();
    createVertexPlatformRequestDependencies({
      db: h.db,
      clock,
      worker: worker(),
      policy: policy(),
      notifications: {
        authority: {
          authenticate: async () => null,
          authorize: async () => false,
        },
        admissionAuthorization: async () => false,
        configuration: null,
        serverContext: async () => null,
        dispatcher: {
          contextFor: () => null,
          routes: [
            {
              eventType: "agent.recorded",
              kind: "operational-alert",
              ttlMilliseconds: 1000,
            },
            {
              eventType: "quote.observed",
              kind: "market-alert",
              ttlMilliseconds: 1000,
            },
          ],
          dryRun: true,
        },
      },
    });
    const select = vi.mocked(createVertexWorkerDispatcher).mock.calls.at(-1)![0]
      .notifications!.select;
    const event = (occurredAt: string) =>
      EventEnvelopeSchema.parse({
        schemaVersion: "1.0.0",
        eventId: `event-${"a".repeat(64)}`,
        eventType: "agent.recorded",
        occurredAt,
        receivedAt: occurredAt,
        effectiveAt: occurredAt,
        correlationId: "correlation-1",
        causationId: null,
        actorId: principal.userId,
        moduleId: "module-1",
        moduleVersion: "1.0.0",
        environment: "research",
        idempotencyKey: "key-1",
        payload: {
          schemaVersion: "1.0.0",
          runId: "run-1",
          agentRole: "research",
          taskContract: "research-1",
          allowedTools: [],
          modelVersion: null,
          inputEvidenceIds: [],
          outputArtifactIds: [],
          tokenBudget: 100,
          costBudgetUsd: "1",
          status: "running",
          errors: [],
          approvalRequests: [],
          executionAuthorized: false,
        },
      });
    const choose = (occurredAt: string) =>
      select({
        event: event(occurredAt),
        signal: new AbortController().signal,
      } as unknown as Parameters<typeof select>[0]);
    // The market route never matches an agent event; the operational one does.
    expect(await choose(clock.now())).toEqual({
      kind: "operational-alert",
      expiresAt: "2026-09-22T12:00:01.000Z",
    });
    expect(await choose("2026-09-22T12:00:05.000Z")).toBeNull();
    return expect(await choose("2026-09-22T11:59:59.000Z")).toBeNull();
  });

  return it("matches actual completed/failed agent outcomes and refuses ambiguous notification routing", async () => {
    const h = database();
    const route = {
      eventType: "agent.recorded",
      kind: "research-completed" as const,
      ttlMilliseconds: 1000,
    };
    const failedRoute = { ...route, kind: "research-failed" as const };
    const buildSelector = (
      routes: NonNullable<
        NonNullable<VertexPlatformRequestOptions["notifications"]>["dispatcher"]
      >["routes"]
    ) => {
      createVertexPlatformRequestDependencies({
        db: h.db,
        clock,
        worker: worker(),
        policy: policy(),
        notifications: {
          authority: {
            authenticate: async () => null,
            authorize: async () => false,
          },
          admissionAuthorization: async () => false,
          configuration: null,
          serverContext: async () => null,
          dispatcher: { contextFor: () => null, routes, dryRun: true },
        },
      });
      const calls = vi.mocked(createVertexWorkerDispatcher).mock.calls;
      return calls.at(-1)![0].notifications!.select;
    };
    const event = (status: "completed" | "failed" | "running") =>
      EventEnvelopeSchema.parse({
        schemaVersion: "1.0.0",
        eventId: `event-${"a".repeat(64)}`,
        eventType: "agent.recorded",
        occurredAt: clock.now(),
        receivedAt: clock.now(),
        effectiveAt: clock.now(),
        correlationId: "correlation-1",
        causationId: null,
        actorId: principal.userId,
        moduleId: "module-1",
        moduleVersion: "1.0.0",
        environment: "research",
        idempotencyKey: "key-1",
        payload: {
          schemaVersion: "1.0.0",
          runId: "run-1",
          agentRole: "research",
          taskContract: "research-1",
          allowedTools: [],
          modelVersion: null,
          inputEvidenceIds: [],
          outputArtifactIds: status === "completed" ? ["artifact-1"] : [],
          tokenBudget: 100,
          costBudgetUsd: "1",
          status,
          errors: [],
          approvalRequests: [],
          executionAuthorized: false,
        },
      });
    const select = buildSelector([route, failedRoute]);
    const choose = (
      selector: typeof select,
      status: "completed" | "failed" | "running",
      signal = new AbortController().signal
    ) => {
      // This closure consumes only an already-validated event and cancellation.
      // Identity/lease authority remains separately tested at dispatcher/store.
      return selector({ event: event(status), signal } as unknown as Parameters<
        typeof select
      >[0]);
    };
    expect(await choose(select, "completed")).toEqual({
      kind: "research-completed",
      expiresAt: "2026-09-22T12:00:01.000Z",
    });
    expect(await choose(select, "failed")).toEqual({
      kind: "research-failed",
      expiresAt: "2026-09-22T12:00:01.000Z",
    });
    expect(await choose(select, "running")).toBeNull();
    const completedOnly = buildSelector([route]);
    expect(await choose(completedOnly, "failed")).toBeNull();
    const ambiguous = buildSelector([
      route,
      { ...route, kind: "operational-alert" },
    ]);
    expect(await choose(ambiguous, "completed")).toBeNull();
    const marketOnly = buildSelector([{ ...route, kind: "market-alert" }]);
    expect(await choose(marketOnly, "completed")).toBeNull();
    const controller = new AbortController();
    controller.abort();
    expect(await choose(select, "completed", controller.signal)).toBeNull();
    expect(h.execute).not.toHaveBeenCalled();
    return expect(h.transaction).not.toHaveBeenCalled();
  });
});
