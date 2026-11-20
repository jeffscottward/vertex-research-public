import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type {
  VertexArtifactMetadata,
  VertexStore,
} from "@darkfactory/db/server/vertex";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { ORPCError } from "@orpc/client";
import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "./client.ts";
import { type ApiContext, createApiContext } from "./server/context.ts";
import { handleApiRequest } from "./server/handler.ts";
import { appRouter } from "./server/router.ts";
import {
  checkVertexCancellation,
  type VertexExperienceDependencies,
  VertexExperienceServiceError,
} from "./server/vertex-experience-core.ts";

const timestamp = "2026-09-21T14:00:00Z";
const now = new Date(timestamp);
const scope = { accountAlias: "fixture-paper", environment: "paper" } as const;
const actor = { actorId: "member-1" };
const digest = "a".repeat(64);
const session: SafeAuthSession = {
  principal: { role: "member", status: "active", userId: "member-1" },
  session: {
    createdAt: now,
    expiresAt: new Date("2026-09-23T14:00:00Z"),
    id: "session-1",
    ipAddress: null,
    updatedAt: now,
    userAgent: null,
    userId: "member-1",
  },
  user: {
    createdAt: now,
    email: "fixture@example.test",
    emailVerified: true,
    id: "member-1",
    image: null,
    name: "Synthetic member",
    role: "member",
    status: "active",
    updatedAt: now,
  },
};
const metadata: VertexArtifactMetadata = {
  artifactId: "artifact-1",
  artifactSha256: digest,
  byteLength: 10,
  collectionId: null,
  contentType: "application/json",
  contractName: "AgentRun",
  createdAt: timestamp,
  lineageArtifactIds: [],
  objectKey: "fixture/object-1",
  rights: {
    allowedUses: ["store", "read"],
    checkedAt: timestamp,
    expiresAt: null,
    policyId: "fixture-rights",
    retentionUntil: null,
    status: "granted",
    version: "1.0.0",
  },
  schemaVersion: "1.0.0",
  scope,
  sourceContentSha256: null,
};
const review = {
  ...scope,
  artifactId: "artifact-1",
  artifactSha256: digest,
  decision: "accepted",
  expectedReviewId: null,
  idempotencyKey: "review-1",
  purpose: "research",
  strategyVersion: "strategy-1",
} as const;
const research = {
  ...scope,
  collectionId: "collection-1",
  evidenceIds: [] as string[],
  executionAuthorized: false,
  idempotencyKey: "research-1",
  proposalOnly: true,
  question: "Compare these synthetic observations",
  role: "research",
} as const;
const simulation = {
  ...scope,
  admissionId: "admission-1",
  brokerSubmissionAllowed: false,
  idempotencyKey: "simulation-1",
  intentId: "intent-1",
  intentSha256: digest,
  liveAuthorization: false,
  reviewId: "review-1",
  reviewVersion: "1.0.0",
  simulationOnly: true,
  strategyVersion: "strategy-1",
} as const;

// Deliberately partial ports: an unexpected service dependency is a test failure,
// never a real DB/provider call. No service factory is replaced in this suite.
const dependencies = () => {
  const store = {
    findRecordArtifact: vi.fn<VertexStore["findRecordArtifact"]>(
      async () => metadata
    ),
    getContinuity: vi.fn<VertexStore["getContinuity"]>(async () => null),
    getPortfolioRead: vi.fn<VertexStore["getPortfolioRead"]>(async () => ({
      snapshot: null,
      streamRegistered: true,
    })),
    listArtifacts: vi.fn<VertexStore["listArtifacts"]>(async () => ({
      items: [],
      nextCursor: null,
    })),
    listExecutionProjections: vi.fn<VertexStore["listExecutionProjections"]>(
      async () => ({ items: [], nextCursor: null })
    ),
  };
  const authorization = {
    authorize: vi.fn(async () => true),
    authorizeCleanupFamily: vi.fn(),
    discoverCleanupFamilies: vi.fn(),
    issueGrant: vi.fn(),
    listAuthorizedScopes: vi.fn(async () => [scope]),
    revokeGrant: vi.fn(),
  };
  const getManifest = vi.fn(async () => {
    throw new Error("private storage text");
  });
  const storage = vi.fn(() => ({ getManifest }) as never);
  const clock = { now: vi.fn(() => timestamp) };
  const gateway = {
    listBindings: vi.fn(async () => [
      {
        accountAlias: scope.accountAlias,
        environment: scope.environment,
        gatewayId: "gateway-1",
      },
    ]),
    readStatus: vi.fn(async () => {
      throw new Error("private gateway text");
    }),
    resolveScope: vi.fn(async () => scope),
  };
  const ports: VertexExperienceDependencies = {
    authorization,
    clock,
    gateway,
    storage,
    store: store as unknown as VertexStore,
  };
  return { authorization, clock, gateway, getManifest, ports, storage, store };
};

type Auth = "member" | "admin" | "anonymous" | "denied";
const contextFor = (
  request: Request,
  vertexExperience?: VertexExperienceDependencies,
  auth: Auth = "member"
): ApiContext =>
  createApiContext(request, {
    capabilities: {
      ai: false,
      analytics: false,
      emailDelivery: false,
      telemetryExport: false,
    },
    repositories: {} as never,
    requestId: "vertex-experience-request",
    requireRole: async () => {
      throw new Error(
        "Role-only authorization must not replace a scoped grant"
      );
    },
    requireSession: async () => {
      if (auth === "anonymous")
        throw new AuthAuthorizationError(
          AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED,
          401
        );
      if (auth === "denied")
        throw new AuthAuthorizationError(
          AUTHORIZATION_ERROR_CODES.FORBIDDEN,
          403
        );
      return auth === "admin"
        ? {
            ...session,
            principal: { ...session.principal, role: "admin" },
            user: { ...session.user, role: "admin" },
          }
        : session;
    },
    ...(vertexExperience === undefined ? {} : { vertexExperience }),
  });
const clientFor = (
  ports?: VertexExperienceDependencies,
  auth: Auth = "member",
  responses: Response[] = [],
  contexts: ApiContext[] = []
) =>
  createApiClient({
    baseUrl: "https://darkfactory.localhost",
    fetch: async (request: Request) => {
      const context = contextFor(request, ports, auth);
      contexts.push(context);
      const response = await handleApiRequest(request, context);
      responses.push(response.clone());
      return response;
    },
  });
const operations = [
  {
    name: "scopes",
    run: (client: ReturnType<typeof clientFor>) =>
      client.vertex.experience.scopes({}),
  },
  {
    name: "portfolio",
    run: (client: ReturnType<typeof clientFor>) =>
      client.vertex.experience.portfolio(scope),
  },
  {
    name: "continuity",
    run: (client: ReturnType<typeof clientFor>) =>
      client.vertex.experience.continuity({ ...scope, streamId: "stream-1" }),
  },
  {
    name: "inbox",
    run: (client: ReturnType<typeof clientFor>) =>
      client.vertex.experience.inbox(scope),
  },
  {
    name: "strategies",
    run: (client: ReturnType<typeof clientFor>) =>
      client.vertex.experience.strategies(scope),
  },
  {
    name: "dossier",
    run: (client: ReturnType<typeof clientFor>) =>
      client.vertex.experience.dossier({ ...scope, artifactId: "strategy-1" }),
  },
  {
    name: "agents",
    run: (client: ReturnType<typeof clientFor>) =>
      client.vertex.experience.agents(scope),
  },
  {
    name: "agent",
    run: (client: ReturnType<typeof clientFor>) =>
      client.vertex.experience.agent({ ...scope, artifactId: "artifact-1" }),
  },
  {
    name: "audit",
    run: (client: ReturnType<typeof clientFor>) =>
      client.vertex.experience.audit(scope),
  },
  {
    name: "gateway",
    run: (client: ReturnType<typeof clientFor>) =>
      client.vertex.experience.gateway({
        environment: "paper",
        gatewayId: "gateway-1",
      }),
  },
  {
    name: "decideReview",
    run: (client: ReturnType<typeof clientFor>) =>
      client.vertex.experience.decideReview(review),
  },
  {
    name: "proposeResearch",
    run: (client: ReturnType<typeof clientFor>) =>
      client.vertex.experience.proposeResearch(research),
  },
  {
    name: "proposeSimulation",
    run: (client: ReturnType<typeof clientFor>) =>
      client.vertex.experience.proposeSimulation(simulation),
  },
] as const;
const expectError = async (
  operation: Promise<unknown>,
  code: string,
  status: number
): Promise<void> => {
  try {
    await operation;
    throw new Error("Expected experience failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code, defined: true, status });
    expect(JSON.stringify(error)).not.toMatch(
      /private storage text|private gateway text/
    );
  }
};
const expectNoStorage = (deps: ReturnType<typeof dependencies>): void => {
  for (const port of Object.values(deps.store))
    expect(port).not.toHaveBeenCalled();
  expect(deps.storage).not.toHaveBeenCalled();
  expect(deps.getManifest).not.toHaveBeenCalled();
  expect(deps.gateway.readStatus).not.toHaveBeenCalled();
};

describe("Vertex experience authenticated transport", () => {
  it.each(operations)(
    "$name authenticates before any authorization, clock, storage or gateway port",
    async ({ run }) => {
      for (const auth of ["anonymous", "denied"] as const) {
        const deps = dependencies();
        await expectError(
          run(clientFor(deps.ports, auth)),
          auth === "anonymous" ? "UNAUTHORIZED" : "FORBIDDEN",
          auth === "anonymous" ? 401 : 403
        );
        expect(deps.authorization.authorize).not.toHaveBeenCalled();
        expect(deps.authorization.listAuthorizedScopes).not.toHaveBeenCalled();
        expect(deps.clock.now).not.toHaveBeenCalled();
        expect(deps.gateway.resolveScope).not.toHaveBeenCalled();
        expectNoStorage(deps);
      }
      return;
    }
  );

  it.each(operations)(
    "$name returns truthful 503 without configured dependencies",
    async ({ run }) =>
      await expectError(run(clientFor()), "SERVICE_UNAVAILABLE", 503)
  );

  it.each(operations)(
    "$name honors actual scoped dependency denial even for an admin",
    async ({ run }) => {
      for (const auth of ["member", "admin"] as const) {
        const deps = dependencies();
        deps.authorization.authorize.mockResolvedValue(false);
        await expectError(run(clientFor(deps.ports, auth)), "FORBIDDEN", 403);
        expect(deps.authorization.authorize).toHaveBeenCalledWith({
          action: "read",
          collectionId: null,
          now: timestamp,
          principal: actor,
          resourceId: "account-scope",
          scope,
        });
        expectNoStorage(deps);
      }
      return;
    }
  );

  it("lists configured gateways only for an authenticated caller", async () => {
    const anonymous = dependencies();
    await expectError(
      clientFor(anonymous.ports, "anonymous").vertex.experience.gateways({}),
      "UNAUTHORIZED",
      401
    );
    expect(anonymous.gateway.listBindings).not.toHaveBeenCalled();
    const deps = dependencies();
    await expect(
      clientFor(deps.ports).vertex.experience.gateways({})
    ).resolves.toEqual([
      {
        accountAlias: scope.accountAlias,
        environment: scope.environment,
        gatewayId: "gateway-1",
      },
    ]);
    expect(deps.gateway.readStatus).not.toHaveBeenCalled();
  });

  it("passes only the session actor and exact scope to DB-backed authorized reads", async () => {
    const deps = dependencies();
    const client = clientFor(deps.ports);
    await expect(client.vertex.experience.scopes({})).resolves.toEqual([scope]);
    await expect(client.vertex.experience.portfolio(scope)).resolves.toEqual({
      checkedAt: timestamp,
      executionAuthorized: false,
      reason: "not-found",
      state: "not-yet-received",
      status: "unavailable",
    });
    deps.store.getPortfolioRead.mockResolvedValueOnce({
      snapshot: null,
      streamRegistered: false,
    });
    await expect(client.vertex.experience.portfolio(scope)).resolves.toEqual({
      checkedAt: timestamp,
      executionAuthorized: false,
      reason: "not-configured",
      status: "unavailable",
    });
    await expect(
      client.vertex.experience.continuity({ ...scope, streamId: "stream-1" })
    ).resolves.toEqual({
      checkedAt: timestamp,
      executionAuthorized: false,
      reason: "not-found",
      state: "not-yet-received",
      status: "unavailable",
    });
    await expect(
      client.vertex.experience.strategies({
        ...scope,
        cursor: "cursor_1",
        limit: 2,
      })
    ).resolves.toEqual({ items: [], nextCursor: null });
    await expect(client.vertex.experience.agents(scope)).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    await expect(client.vertex.experience.audit(scope)).resolves.toEqual({
      items: [],
      nextCursor: null,
    });
    expect(deps.authorization.listAuthorizedScopes).toHaveBeenCalledWith(actor);
    expect(deps.authorization.authorize).toHaveBeenCalledWith({
      action: "read",
      collectionId: null,
      now: timestamp,
      principal: actor,
      resourceId: "portfolio",
      scope,
    });
    expect(deps.store.getPortfolioRead).toHaveBeenCalledWith(actor, scope);
    expect(deps.store.getContinuity).toHaveBeenCalledWith(
      actor,
      scope,
      "stream-1"
    );
    expect(deps.store.listArtifacts).toHaveBeenCalledWith(actor, scope, {
      contractName: "StrategySpec",
      cursor: "cursor_1",
      limit: 2,
    });
    expect(deps.store.listArtifacts).toHaveBeenCalledWith(actor, scope, {
      contractName: "AgentRun",
      cursor: null,
      limit: 100,
    });
    return expect(deps.store.listExecutionProjections).toHaveBeenCalledWith(
      actor,
      scope,
      { cursor: null, limit: 100 }
    );
  });

  it("sends the typed 503 cause when the service knows it and omits it otherwise", async () => {
    const reasonOf = async (operation: Promise<unknown>): Promise<unknown> => {
      try {
        await operation;
      } catch (error) {
        expect(error).toMatchObject({
          code: "SERVICE_UNAVAILABLE",
          defined: true,
          status: 503,
        });
        return error instanceof ORPCError ? error.data : error;
      }
      throw new Error("Expected experience failure");
    };
    expect(
      await reasonOf(clientFor().vertex.experience.strategies(scope))
    ).toEqual({ reason: "not-configured" });
    const failing = dependencies();
    failing.store.getPortfolioRead.mockRejectedValue(
      new Error("private storage text")
    );
    expect(
      await reasonOf(
        clientFor(failing.ports).vertex.experience.portfolio(scope)
      )
    ).toBeUndefined();
    expect(() =>
      checkVertexCancellation({ signal: AbortSignal.abort() })
    ).toThrow(
      expect.objectContaining({
        code: "SERVICE_UNAVAILABLE",
        reason: "request-cancelled",
      })
    );
    expect(() => checkVertexCancellation({})).not.toThrow();
    // A 503 with no stated cause carries no data, and other codes never carry a cause.
    const plain = new VertexExperienceServiceError("SERVICE_UNAVAILABLE");
    expect(plain.reason).toBeUndefined();
    return expect(
      new VertexExperienceServiceError("NOT_FOUND").reason
    ).toBeUndefined();
  });

  it("does not treat missing storage as an empty successful artifact page", async () => {
    const deps = dependencies();
    const { storage: omitted, ...ports } = deps.ports;
    expect(omitted).toBeDefined();
    await expectError(
      clientFor(ports).vertex.experience.strategies(scope),
      "SERVICE_UNAVAILABLE",
      503
    );
    return expect(deps.store.listArtifacts).not.toHaveBeenCalled();
  });

  it("redacts unexpected artifact-storage and DB failure text from the wire", async () => {
    const deps = dependencies();
    deps.store.getPortfolioRead.mockRejectedValue(
      new Error("private storage text")
    );
    const responses: Response[] = [];
    const client = clientFor(deps.ports, "member", responses);
    await expectError(
      client.vertex.experience.portfolio(scope),
      "SERVICE_UNAVAILABLE",
      503
    );
    await expectError(
      client.vertex.experience.agent({ ...scope, artifactId: "artifact-1" }),
      "SERVICE_UNAVAILABLE",
      503
    );
    expect(deps.storage).toHaveBeenCalledWith(actor, scope, null);
    expect(deps.getManifest).toHaveBeenCalledWith({
      artifactId: "artifact-1",
      collectionId: null,
      principal: actor,
      scope,
    });
    for (const response of responses) {
      expect(response.status).toBe(503);
      expect(await response.text()).not.toMatch(
        /private storage text|fixture\/object-1/
      );
    }
    return;
  });

  it("rejects request-supplied actor/policy/expiry before service ports", async () => {
    const deps = dependencies();
    const client = clientFor(deps.ports);
    await expectError(
      client.vertex.experience.portfolio({
        ...scope,
        actorId: "other",
      } as never),
      "BAD_REQUEST",
      400
    );
    await expectError(
      client.vertex.experience.decideReview({
        ...review,
        policyVersion: "1.0.0",
      } as never),
      "BAD_REQUEST",
      400
    );
    await expectError(
      client.vertex.experience.proposeSimulation({
        ...simulation,
        expiresAt: timestamp,
      } as never),
      "BAD_REQUEST",
      400
    );
    await expectError(
      client.vertex.experience.proposeResearch({
        ...research,
        environment: "live",
      } as never),
      "BAD_REQUEST",
      400
    );
    expect(deps.authorization.authorize).not.toHaveBeenCalled();
    return expectNoStorage(deps);
  });

  it("inherits the request cancellation signal, never a supplied dependency signal", async () => {
    const requestAbort = new AbortController();
    const unrelatedAbort = new AbortController();
    const request = new Request(
      "https://darkfactory.localhost/api/orpc/vertex/experience/portfolio",
      { signal: requestAbort.signal }
    );
    const deps = dependencies();
    const context = contextFor(request, {
      ...deps.ports,
      signal: unrelatedAbort.signal,
    });
    expect(context.signal).toBe(request.signal);
    expect(context.vertexExperience?.signal).toBe(request.signal);
    expect(context.vertexExperience?.signal).not.toBe(unrelatedAbort.signal);
    expect(contextFor(request)).not.toHaveProperty("vertexExperience");
    requestAbort.abort();
    const client = createRouterClient(appRouter, { context });
    await expectError(
      client.vertex.experience.portfolio(scope),
      "SERVICE_UNAVAILABLE",
      503
    );
    expect(deps.authorization.authorize).not.toHaveBeenCalled();
    return expectNoStorage(deps);
  });

  it("propagates cancellation during authorization before subsequent DB access", async () => {
    const controller = new AbortController();
    const deps = dependencies();
    deps.authorization.authorize.mockImplementation(async () => {
      controller.abort();
      return true;
    });
    const request = new Request("https://darkfactory.localhost", {
      signal: controller.signal,
    });
    const client = createRouterClient(appRouter, {
      context: contextFor(request, deps.ports),
    });
    await expectError(
      client.vertex.experience.portfolio(scope),
      "SERVICE_UNAVAILABLE",
      503
    );
    return expectNoStorage(deps);
  });

  it("carries the same actor, environment and request signal into the observation-only gateway port", async () => {
    const deps = dependencies();
    const contexts: ApiContext[] = [];
    const responses: Response[] = [];
    const client = clientFor(deps.ports, "member", responses, contexts);
    await expectError(
      client.vertex.experience.gateway({
        environment: "paper",
        gatewayId: "gateway-1",
      }),
      "SERVICE_UNAVAILABLE",
      503
    );
    expect(deps.gateway.resolveScope).toHaveBeenCalledWith(
      "gateway-1",
      "paper"
    );
    expect(deps.gateway.readStatus).toHaveBeenCalledWith(
      actor,
      "gateway-1",
      "paper",
      contexts[0]?.signal
    );
    expect(contexts[0]?.vertexExperience?.signal).toBe(contexts[0]?.signal);
    return expect(await responses[0]?.text()).not.toContain(
      "private gateway text"
    );
  });

  it("keeps the original module read independently wired when experience is absent", async () => {
    const bytes = new TextEncoder().encode(canonicalArtifactJson([]));
    const artifactSha256 = await hashArtifact(bytes);
    const listModules = vi.fn(async () => ({
      artifactSha256,
      bytes,
      identity: { kind: "modules" as const },
    }));
    const canListModules = vi.fn(async () => true);
    const client = createApiClient({
      baseUrl: "https://darkfactory.localhost",
      fetch: async (request: Request) => {
        const context: ApiContext = {
          ...contextFor(request),
          vertexRead: {
            authorization: { canListModules },
            read: { listModules },
          },
        };
        return handleApiRequest(request, context);
      },
    });
    await expect(client.vertex.modules.list({})).resolves.toEqual([]);
    expect(canListModules).toHaveBeenCalledWith(session.principal);
    expect(listModules).toHaveBeenCalledWith(session.principal);
    return await expectError(
      client.vertex.experience.portfolio(scope),
      "SERVICE_UNAVAILABLE",
      503
    );
  });
});
