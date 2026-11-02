import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import type {
  VertexArtifactMetadata,
  VertexAuthorizationRepository,
  VertexRightsRecord,
  VertexStore,
} from "@darkfactory/db/server/vertex";
import type {
  VertexWorkerStore,
  WorkerServiceIdentity,
} from "@darkfactory/db/server/vertex-worker";
import type { VertexArtifactStorage } from "@darkfactory/storage/vertex";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { createHash } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import { WorkerResultSchema } from "./contracts/vertex-worker.ts";
import {
  createApiContext,
  type ApiContext,
  type ApiContextDependencies,
} from "./server/context.ts";
import { handleApiRequest, handleOpenApiRequest } from "./server/handler.ts";
import { appRouter } from "./server/router.ts";
import type { VertexChartReadDependencies } from "./server/vertex-chart-service.ts";
import type { VertexWorkerServiceDependencies } from "./server/vertex-worker-service.ts";
import type { VertexNotificationReadService } from "./server/vertex-notification-read-service.ts";
import { VertexReadServiceError } from "./server/vertex-service.ts";

const NOW = "2026-09-22T12:00:00.000Z";
const BEFORE = "2026-09-22T11:59:59.000Z";
const AFTER = "2026-09-22T13:00:00.000Z";
const scope = { accountAlias: "fixture-paper", environment: "paper" as const };
const statusInput = { ...scope, jobId: "job-1" };
const statusOutput = {
  status: "unknown" as const,
  jobId: "job-1",
  state: "unknown" as const,
  lease: null,
  outputArtifactIds: [],
  reason: "unavailable" as const,
};
const identity: WorkerServiceIdentity = Object.freeze({
  grantId: "grant-1",
  servicePrincipalId: "service-1",
  scope: Object.freeze({ ...scope }),
  expiresAt: AFTER,
});
// Deterministic public test bytes, never an issued service credential.
const token = Buffer.from(
  "fixture-worker-opaque-token-0123456789abcdefghijklmnopqrs"
).toString("base64url");
const authorization = `Bearer ${token}`;
const tokenDigest = createHash("sha256").update(token).digest("hex");
const capabilities = {
  ai: false,
  emailDelivery: false,
  analytics: false,
  telemetryExport: false,
};
const session: SafeAuthSession = {
  user: {
    id: "browser-member",
    name: "Fixture member",
    email: "fixture@example.test",
    emailVerified: true,
    image: null,
    createdAt: new Date(BEFORE),
    updatedAt: new Date(BEFORE),
    role: "member",
    status: "active",
  },
  session: {
    id: "session-1",
    userId: "browser-member",
    expiresAt: new Date(AFTER),
    createdAt: new Date(BEFORE),
    updatedAt: new Date(BEFORE),
    ipAddress: null,
    userAgent: null,
  },
  principal: { userId: "browser-member", role: "member", status: "active" },
};
const adminSession: SafeAuthSession = {
  ...session,
  user: { ...session.user, role: "admin" },
  principal: { ...session.principal, role: "admin" },
};
const contextFor = (
  request: Request,
  overrides: Partial<ApiContextDependencies> = {}
): ApiContext =>
  createApiContext(request, {
    repositories: {} as never,
    capabilities,
    requestId: "vertex-root-integration",
    requireSession: async () => {
      throw new Error("Worker must not consult a browser session");
    },
    requireRole: async () => {
      throw new Error("Worker must not consult a browser role");
    },
    ...overrides,
  });
const rpcRequest = (
  path: string,
  input: unknown,
  bearer: string | null = authorization,
  signal?: AbortSignal
): Request => {
  const headers = new Headers({
    "content-type": "application/json",
    origin: "https://darkfactory.localhost",
    cookie: "fixture-browser-session=not-service-authority",
    "x-user-id": "browser-admin",
    "x-admin": "true",
  });
  if (bearer !== null) headers.set("authorization", bearer);
  return new Request(`https://darkfactory.localhost/api/orpc/${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ json: input }),
    ...(signal === undefined ? {} : { signal }),
  });
};
const post = (
  request: Request,
  dependencies: Partial<ApiContextDependencies> = {}
): Promise<Response> =>
  handleApiRequest(request, contextFor(request, dependencies));
const expectRpcError = async (
  response: Response,
  code: string,
  status: number
): Promise<void> => {
  expect(response.status).toBe(status);
  const text = await response.text();
  expect(JSON.parse(text)).toMatchObject({
    json: { code, status, defined: true },
  });
  expect(text).not.toContain("private worker detail");
  expect(text).not.toContain("private chart detail");
  expect(text).not.toContain(token);
  expect(text).not.toContain(tokenDigest);
};

const workerFixture = () => {
  const authenticate = vi.fn<VertexWorkerStore["authenticate"]>(
    async () => identity
  );
  const invoke = vi.fn<VertexWorkerStore["invoke"]>(async () => statusOutput);
  const claim = vi.fn<VertexWorkerServiceDependencies["claim"]>(async () => ({
    status: "accepted",
    leases: [],
  }));
  const requireSession = vi.fn<ApiContextDependencies["requireSession"]>(
    async () => {
      throw new Error("Browser session poison");
    }
  );
  const requireRole = vi.fn<ApiContextDependencies["requireRole"]>(async () => {
    throw new Error("Browser role poison");
  });
  const worker: VertexWorkerServiceDependencies = {
    store: { authenticate, invoke },
    claim,
    clock: { now: () => NOW },
  };
  const dependencies = { vertexWorker: worker, requireSession, requireRole };
  return {
    authenticate,
    invoke,
    claim,
    requireSession,
    requireRole,
    worker,
    dependencies,
  };
};

describe("native bearer worker through the existing root oRPC handler", () => {
  it("accepts the native POST json envelope using the actual service and exact DB-issued identity", async () => {
    const f = workerFixture();
    const request = rpcRequest("vertexWorker/status", statusInput);
    const response = await post(request, f.dependencies);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ json: statusOutput });
    expect(f.authenticate).toHaveBeenCalledExactlyOnceWith(
      tokenDigest,
      scope,
      "status"
    );
    expect(f.invoke).toHaveBeenCalledExactlyOnceWith(
      identity,
      "status",
      statusInput
    );
    // DB tracks issued identity references in a WeakSet: deep equality alone is
    // insufficient and would miss a schema parser cloning away its provenance.
    expect(f.invoke.mock.calls[0]?.[0]).toBe(identity);
    expect(f.claim).not.toHaveBeenCalled();
    expect(f.requireSession).not.toHaveBeenCalled();
    expect(f.requireRole).not.toHaveBeenCalled();
    expect(JSON.stringify(f.authenticate.mock.calls)).not.toContain(token);
    return expect(JSON.stringify(f.invoke.mock.calls)).not.toContain(
      session.principal.userId
    );
  });

  it("snapshots request headers and binds the real request abort signal only on the server", async () => {
    const f = workerFixture();
    const controller = new AbortController();
    const request = rpcRequest(
      "vertexWorker/status",
      statusInput,
      authorization,
      controller.signal
    );
    const context = contextFor(request, f.dependencies);
    expect(context.vertexWorker).toBe(f.worker);
    expect(context.workerRequest?.headers).not.toBe(request.headers);
    expect(context.workerRequest?.headers.get("authorization")).toBe(
      authorization
    );
    expect(context.workerRequest?.signal).toBe(request.signal);
    request.headers.set("authorization", "Bearer malformed-after-binding");
    expect((await handleApiRequest(request, context)).status).toBe(200);
    expect(f.authenticate).toHaveBeenCalledWith(tokenDigest, scope, "status");
    controller.abort();
    return expect(context.workerRequest?.signal?.aborted).toBe(true);
  });

  it.each([
    null,
    "",
    "Basic fixture",
    "Bearer short",
    `bearer ${token}`,
    `Bearer  ${token}`,
    `Bearer ${token}, Bearer ${token}`,
    `Bearer ${"a".repeat(42)}`,
    `Bearer ${"a".repeat(172)}`,
    `Bearer ${"A".repeat(42)}B`,
  ])(
    "denies missing or malformed bearer %s before any database call despite an admin cookie/session",
    async (bearer) => {
      const f = workerFixture();
      f.requireSession.mockResolvedValue(adminSession);
      f.requireRole.mockResolvedValue(adminSession);
      await expectRpcError(
        await post(
          rpcRequest("vertexWorker/status", statusInput, bearer),
          f.dependencies
        ),
        "UNAUTHORIZED",
        401
      );
      expect(f.authenticate).not.toHaveBeenCalled();
      expect(f.invoke).not.toHaveBeenCalled();
      expect(f.claim).not.toHaveBeenCalled();
      expect(f.requireSession).not.toHaveBeenCalled();
      return expect(f.requireRole).not.toHaveBeenCalled();
    }
  );

  it.each([
    { principal: session.principal },
    { servicePrincipalId: "service-from-payload" },
    { role: "admin" },
    { headers: { authorization } },
    { token },
    { workerRequest: { headers: { authorization } } },
  ])(
    "rejects payload authority rather than replacing server request provenance: %j",
    async (extra) => {
      const f = workerFixture();
      await expectRpcError(
        await post(
          rpcRequest("vertexWorker/status", { ...statusInput, ...extra }),
          f.dependencies
        ),
        "BAD_REQUEST",
        400
      );
      expect(f.authenticate).not.toHaveBeenCalled();
      return expect(f.invoke).not.toHaveBeenCalled();
    }
  );

  it("forwards each requested scope and operation to fresh authentication and never caches revoked grants", async () => {
    const f = workerFixture();
    expect(
      (
        await post(
          rpcRequest("vertexWorker/status", statusInput),
          f.dependencies
        )
      ).status
    ).toBe(200);
    f.authenticate.mockRejectedValueOnce(
      new Error("private worker detail: revoked grant")
    );
    await expectRpcError(
      await post(
        rpcRequest("vertexWorker/status", statusInput),
        f.dependencies
      ),
      "UNAUTHORIZED",
      401
    );
    const otherScope = {
      accountAlias: "other-account",
      environment: "research" as const,
    };
    f.authenticate.mockRejectedValueOnce(
      new Error("private worker detail: wrong scope")
    );
    await expectRpcError(
      await post(
        rpcRequest("vertexWorker/status", { ...otherScope, jobId: "job-1" }),
        f.dependencies
      ),
      "UNAUTHORIZED",
      401
    );
    expect(f.authenticate.mock.calls).toEqual([
      [tokenDigest, scope, "status"],
      [tokenDigest, scope, "status"],
      [tokenDigest, otherScope, "status"],
    ]);
    return expect(f.invoke).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...identity, expiresAt: NOW },
    { ...identity, scope: { ...scope, accountAlias: "another-account" } },
    { ...identity, scope: { ...scope, environment: "research" as const } },
  ])(
    "denies expired or mismatched authenticated identity without store invocation",
    async (issued) => {
      const f = workerFixture();
      f.authenticate.mockResolvedValue(issued);
      await expectRpcError(
        await post(
          rpcRequest("vertexWorker/status", statusInput),
          f.dependencies
        ),
        "UNAUTHORIZED",
        401
      );
      expect(f.authenticate).toHaveBeenCalledWith(tokenDigest, scope, "status");
      return expect(f.invoke).not.toHaveBeenCalled();
    }
  );

  it.each([
    { storeCode: "denied", code: "FORBIDDEN", status: 403 },
    { storeCode: "conflict", code: "CONFLICT", status: 409 },
    { storeCode: "stale", code: "CONFLICT", status: 409 },
    { storeCode: "unavailable", code: "SERVICE_UNAVAILABLE", status: 503 },
  ])(
    "redacts transaction-time $storeCode errors, including grant revocation after authentication",
    async ({ storeCode, code, status }) => {
      const f = workerFixture();
      f.invoke.mockRejectedValue(
        Object.assign(new Error(`private worker detail: ${token}`), {
          code: storeCode,
          cause: new Error("private worker detail"),
        })
      );
      await expectRpcError(
        await post(
          rpcRequest("vertexWorker/status", statusInput),
          f.dependencies
        ),
        code,
        status
      );
      expect(f.authenticate).toHaveBeenCalledTimes(1);
      expect(f.invoke.mock.calls[0]?.[0]).toBe(identity);
      return expect(f.requireSession).not.toHaveBeenCalled();
    }
  );

  it("rejects malformed or cross-job service output rather than leaking source fields", async () => {
    const f = workerFixture();
    f.invoke.mockResolvedValueOnce({
      ...statusOutput,
      privateValue: "private worker detail",
    });
    await expectRpcError(
      await post(
        rpcRequest("vertexWorker/status", statusInput),
        f.dependencies
      ),
      "INVALID_SOURCE",
      502
    );
    f.invoke.mockResolvedValueOnce({ ...statusOutput, jobId: "different-job" });
    return await expectRpcError(
      await post(
        rpcRequest("vertexWorker/status", statusInput),
        f.dependencies
      ),
      "INVALID_SOURCE",
      502
    );
  });

  it.each([
    "unknown",
    "issueGrant",
    "revokeGrant",
    "submitOrder",
    "recover",
    "status/extra",
  ])("does not mount worker operation %s", async (method) => {
    const f = workerFixture();
    const response = await post(
      rpcRequest(`vertexWorker/${method}`, statusInput),
      f.dependencies
    );
    expect(response.status).toBe(404);
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(f.invoke).not.toHaveBeenCalled();
    expect(f.requireSession).not.toHaveBeenCalled();
    return expect(f.requireRole).not.toHaveBeenCalled();
  });

  it("returns unavailable when worker dependencies or bound request context are missing", async () => {
    const f = workerFixture();
    await expectRpcError(
      await post(rpcRequest("vertexWorker/status", statusInput)),
      "SERVICE_UNAVAILABLE",
      503
    );
    const request = rpcRequest("vertexWorker/status", statusInput);
    const { workerRequest: omitted, ...withoutRequest } = contextFor(
      request,
      f.dependencies
    );
    expect(omitted).toBeDefined();
    await expectRpcError(
      await handleApiRequest(request, withoutRequest),
      "SERVICE_UNAVAILABLE",
      503
    );
    expect(f.authenticate).not.toHaveBeenCalled();
    expect(f.invoke).not.toHaveBeenCalled();
    return expect(f.requireSession).not.toHaveBeenCalled();
  });

  it("propagates the native request signal and exact identity into the shared claim port", async () => {
    const f = workerFixture();
    const controller = new AbortController();
    const input = {
      ...scope,
      workerInstanceId: "worker-1",
      kinds: ["research-run"],
      limit: 1,
      leaseDurationMs: 1000,
    };
    const request = rpcRequest(
      "vertexWorker/claim",
      input,
      authorization,
      controller.signal
    );
    const response = await post(request, f.dependencies);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      json: { status: "accepted", leases: [] },
    });
    expect(f.authenticate).toHaveBeenCalledExactlyOnceWith(
      tokenDigest,
      scope,
      "claim"
    );
    expect(f.claim).toHaveBeenCalledExactlyOnceWith(identity, input, {
      signal: request.signal,
    });
    expect(f.claim.mock.calls[0]?.[0]).toBe(identity);
    controller.abort();
    expect(f.claim.mock.calls[0]?.[2].signal?.aborted).toBe(true);
    expect(f.invoke).not.toHaveBeenCalled();
    return expect(f.requireSession).not.toHaveBeenCalled();
  });

  it("blocks a pre-aborted worker request before mutation and maps it to unavailable", async () => {
    const f = workerFixture();
    const controller = new AbortController();
    controller.abort();
    const request = rpcRequest(
      "vertexWorker/status",
      statusInput,
      authorization,
      controller.signal
    );
    await expectRpcError(
      await post(request, f.dependencies),
      "SERVICE_UNAVAILABLE",
      503
    );
    expect(f.invoke).not.toHaveBeenCalled();
    return expect(f.claim).not.toHaveBeenCalled();
  });

  it("retains worker readonly output through the root in-process router", async () => {
    const f = workerFixture();
    const request = rpcRequest("vertexWorker/status", statusInput);
    const client = createRouterClient(appRouter, {
      context: contextFor(request, f.dependencies),
    });
    const output = await client.vertexWorker.status(statusInput);
    expect(WorkerResultSchema.parse(output)).toEqual(statusOutput);
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.outputArtifactIds)).toBe(true);
    return expect(f.invoke.mock.calls[0]?.[0]).toBe(identity);
  });

  it("uses the same bearer-only boundary for the documented worker POST route", async () => {
    const f = workerFixture();
    const request = new Request(
      "https://darkfactory.localhost/api/openapi/vertex-worker/status",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://darkfactory.localhost",
          authorization,
        },
        body: JSON.stringify(statusInput),
      }
    );
    const response = await handleOpenApiRequest(
      request,
      contextFor(request, f.dependencies)
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(statusOutput);
    expect(f.invoke.mock.calls[0]?.[0]).toBe(identity);
    expect(f.requireSession).not.toHaveBeenCalled();
    return expect(f.requireRole).not.toHaveBeenCalled();
  });
});

// A real chart-service fixture: canonical artifacts, current rights and verified
// digests. Only dependency ports are mocked.
const chartFixture = async () => {
  const rights: VertexRightsRecord = {
    policyId: "fixture-rights",
    version: "1.0.0",
    status: "granted",
    allowedUses: ["store", "read", "derive"],
    checkedAt: BEFORE,
    expiresAt: AFTER,
    retentionUntil: AFTER,
  };
  const entries = new Map<
    string,
    { bytes: Uint8Array; metadata: VertexArtifactMetadata }
  >();
  const add = async (
    artifactId: string,
    contractName: VertexArtifactMetadata["contractName"],
    value: unknown,
    collectionId: string | null,
    sourceContentSha256: string | null
  ) => {
    const bytes = new TextEncoder().encode(canonicalArtifactJson(value));
    const metadata: VertexArtifactMetadata = {
      artifactId,
      contractName,
      scope,
      collectionId,
      objectKey: `fixture/${artifactId}`,
      artifactSha256: await hashArtifact(bytes),
      sourceContentSha256,
      byteLength: bytes.byteLength,
      contentType: "application/json",
      schemaVersion: "1.0.0",
      rights,
      lineageArtifactIds: [],
      createdAt: NOW,
    };
    entries.set(artifactId, { bytes, metadata });
    return metadata;
  };
  const moduleMetadata = await add(
    "modules-artifact",
    "ModuleManifestList",
    [],
    null,
    null
  );
  const authorize = vi.fn<VertexAuthorizationRepository["authorize"]>(
    async () => true
  );
  const findModuleCatalog = vi.fn<VertexStore["findModuleCatalog"]>(
    async () => moduleMetadata
  );
  const getRights = vi.fn<VertexStore["getRights"]>(async () => rights);
  const getManifest = vi.fn<VertexArtifactStorage["getManifest"]>(
    async (input) => entries.get(input.artifactId) ?? null
  );
  const storage = vi.fn(
    () => ({ getManifest }) as unknown as VertexArtifactStorage
  );
  const dependencies: VertexChartReadDependencies = {
    store: {
      findModuleCatalog,
      getRights,
    } as unknown as VertexStore,
    authorization: { authorize } as unknown as VertexAuthorizationRepository,
    storage,
    clock: { now: () => NOW },
  };
  return {
    dependencies,
    rights,
    authorize,
    findModuleCatalog,
    getRights,
    getManifest,
    storage,
  };
};

const chartOperations = [
  {
    method: "modules",
    input: scope,
    resourceId: "module-catalog",
    collectionId: null,
  },
] as const;
const modulesInput = chartOperations[0].input;

describe("scoped browser chart reads remain session and rights authorized", () => {
  it.each(chartOperations)(
    "$method requires a browser session and never accepts a valid worker bearer instead",
    async ({ method, input }) => {
      const f = await chartFixture();
      const w = workerFixture();
      const requireSession = vi.fn<ApiContextDependencies["requireSession"]>(
        async () => {
          throw new AuthAuthorizationError(
            AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED,
            401
          );
        }
      );
      await expectRpcError(
        await post(rpcRequest(`vertex/scoped/${method}`, input), {
          ...w.dependencies,
          vertexChartRead: f.dependencies,
          requireSession,
        }),
        "UNAUTHORIZED",
        401
      );
      expect(requireSession).toHaveBeenCalledTimes(1);
      expect(f.authorize).not.toHaveBeenCalled();
      expect(f.getManifest).not.toHaveBeenCalled();
      expect(w.authenticate).not.toHaveBeenCalled();
      expect(w.invoke).not.toHaveBeenCalled();
      return expect(w.requireRole).not.toHaveBeenCalled();
    }
  );

  it.each(chartOperations)(
    "$method reads actual validated artifacts using the server session principal without bearer",
    async ({ method, input, resourceId, collectionId }) => {
      const f = await chartFixture();
      const w = workerFixture();
      const requireSession = vi.fn<ApiContextDependencies["requireSession"]>(
        async () => session
      );
      const request = rpcRequest(`vertex/scoped/${method}`, input, null);
      const response = await post(request, {
        ...w.dependencies,
        vertexChartRead: f.dependencies,
        requireSession,
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { json: unknown };
      expect(body.json).toEqual([]);
      expect(requireSession).toHaveBeenCalledWith(request.headers);
      expect(f.authorize).toHaveBeenCalledWith({
        principal: { actorId: session.principal.userId },
        scope,
        resourceId: "account-scope",
        collectionId: null,
        action: "read",
        now: NOW,
      });
      expect(f.authorize).toHaveBeenCalledWith({
        principal: { actorId: session.principal.userId },
        scope,
        resourceId,
        collectionId,
        action: "read",
        now: NOW,
      });
      expect(f.getRights).toHaveBeenCalledWith(
        { actorId: session.principal.userId },
        scope,
        collectionId,
        f.rights.policyId
      );
      expect(w.authenticate).not.toHaveBeenCalled();
      expect(w.invoke).not.toHaveBeenCalled();
      return expect(w.requireRole).not.toHaveBeenCalled();
    }
  );

  it.each(chartOperations)(
    "$method has no implicit experience/storage fallback when explicit chart dependencies are absent",
    async ({ method, input }) => {
      const f = await chartFixture();
      const requireSession = vi.fn<ApiContextDependencies["requireSession"]>(
        async () => session
      );
      const request = rpcRequest(`vertex/scoped/${method}`, input);
      const context = contextFor(request, {
        requireSession,
        vertexExperience: f.dependencies,
      });
      expect(context).not.toHaveProperty("vertexChartRead");
      await expectRpcError(
        await handleApiRequest(request, context),
        "SERVICE_UNAVAILABLE",
        503
      );
      expect(requireSession).toHaveBeenCalledTimes(1);
      expect(f.authorize).not.toHaveBeenCalled();
      expect(f.storage).not.toHaveBeenCalled();
      return expect(f.getManifest).not.toHaveBeenCalled();
    }
  );

  it.each(chartOperations)(
    "$method denies unknown current rights even to an authenticated admin",
    async ({ method, input }) => {
      const f = await chartFixture();
      f.getRights.mockResolvedValue({ ...f.rights, status: "unknown" });
      await expectRpcError(
        await post(rpcRequest(`vertex/scoped/${method}`, input), {
          vertexChartRead: f.dependencies,
          requireSession: async () => adminSession,
        }),
        "FORBIDDEN",
        403
      );
      return expect(f.getRights).toHaveBeenCalledWith(
        { actorId: adminSession.principal.userId },
        scope,
        null,
        f.rights.policyId
      );
    }
  );

  it.each(chartOperations)(
    "$method denies scope or collection permission before storage, with no admin bypass",
    async ({ method, input }) => {
      const f = await chartFixture();
      f.authorize.mockResolvedValue(false);
      await expectRpcError(
        await post(rpcRequest(`vertex/scoped/${method}`, input), {
          vertexChartRead: f.dependencies,
          requireSession: async () => adminSession,
        }),
        "FORBIDDEN",
        403
      );
      expect(f.findModuleCatalog).not.toHaveBeenCalled();
      return expect(f.storage).not.toHaveBeenCalled();
    }
  );

  it("reauthorizes current rights on every scoped modules request", async () => {
    const f = await chartFixture();
    const input = modulesInput;
    const dependencies = {
      vertexChartRead: f.dependencies,
      requireSession: async () => session,
    };
    expect(
      (
        await post(
          rpcRequest("vertex/scoped/modules", input, null),
          dependencies
        )
      ).status
    ).toBe(200);
    f.getRights.mockResolvedValue({ ...f.rights, status: "denied" });
    await expectRpcError(
      await post(
        rpcRequest("vertex/scoped/modules", input, null),
        dependencies
      ),
      "FORBIDDEN",
      403
    );
    return expect(f.getRights).toHaveBeenCalledTimes(2);
  });

  it("rejects caller-supplied chart principal fields before authorization", async () => {
    const f = await chartFixture();
    const input = {
      ...modulesInput,
      principal: { userId: "other-user", role: "admin" },
    };
    await expectRpcError(
      await post(rpcRequest("vertex/scoped/modules", input), {
        vertexChartRead: f.dependencies,
        requireSession: async () => session,
      }),
      "BAD_REQUEST",
      400
    );
    expect(f.authorize).not.toHaveBeenCalled();
    return expect(f.getManifest).not.toHaveBeenCalled();
  });

  it("redacts chart source failures rather than reflecting provider details", async () => {
    const f = await chartFixture();
    f.getManifest.mockRejectedValue(new Error("private chart detail"));
    return await expectRpcError(
      await post(rpcRequest("vertex/scoped/modules", modulesInput), {
        vertexChartRead: f.dependencies,
        requireSession: async () => session,
      }),
      "SERVICE_UNAVAILABLE",
      503
    );
  });

  it("binds the request signal over a supplied chart signal and stops aborted reads", async () => {
    const f = await chartFixture();
    const staleController = new AbortController();
    const controller = new AbortController();
    const request = rpcRequest(
      "vertex/scoped/modules",
      modulesInput,
      null,
      controller.signal
    );
    const context = contextFor(request, {
      vertexChartRead: { ...f.dependencies, signal: staleController.signal },
      requireSession: async () => session,
    });
    expect(context.vertexChartRead?.signal).toBe(request.signal);
    controller.abort();
    await expectRpcError(
      await handleApiRequest(request, context),
      "SERVICE_UNAVAILABLE",
      503
    );
    expect(f.authorize).not.toHaveBeenCalled();
    return expect(f.getManifest).not.toHaveBeenCalled();
  });
});

const notificationInput = {
  ...scope,
  grantId: "grant-1",
  version: "1",
  eventId: "event-1",
};
const notificationOutput = {
  status: "accepted" as const,
  admittedAt: Date.parse(NOW),
  expiresAt: Date.parse(AFTER),
  outcomeAt: Date.parse(NOW) + 1,
  receipt: "unconfirmed" as const,
  retryable: false as const,
};
const notificationFixture = () => {
  const delivery = vi.fn<VertexNotificationReadService["delivery"]>(
    async () => notificationOutput
  );
  const service: VertexNotificationReadService = { delivery };
  const requireSession = vi.fn<ApiContextDependencies["requireSession"]>(
    async () => session
  );
  const requireRole = vi.fn<ApiContextDependencies["requireRole"]>(async () => {
    throw new Error(
      "Notification read must not substitute browser role authorization"
    );
  });
  return {
    delivery,
    service,
    requireSession,
    requireRole,
    dependencies: {
      vertexNotificationRead: service,
      requireSession,
      requireRole,
    },
  };
};

describe("root historical notification delivery read boundary", () => {
  it("injects only an explicitly supplied service and passes the exact server-session principal", async () => {
    const f = notificationFixture();
    const w = workerFixture();
    const request = rpcRequest(
      "vertex/notifications/delivery",
      notificationInput,
      null
    );
    const context = contextFor(request, {
      ...w.dependencies,
      ...f.dependencies,
    });
    expect(context.vertexNotificationRead).toBe(f.service);
    const response = await handleApiRequest(request, context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ json: notificationOutput });
    expect(f.requireSession).toHaveBeenCalledExactlyOnceWith(request.headers);
    expect(f.delivery).toHaveBeenCalledExactlyOnceWith(
      session.principal,
      notificationInput
    );
    expect(f.delivery.mock.calls[0]?.[0]).toBe(session.principal);
    expect(f.requireRole).not.toHaveBeenCalled();
    expect(w.authenticate).not.toHaveBeenCalled();
    return expect(w.invoke).not.toHaveBeenCalled();
  });

  it("requires the browser session before service access even with a valid worker bearer", async () => {
    const f = notificationFixture();
    const w = workerFixture();
    f.requireSession.mockRejectedValue(
      new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401)
    );
    await expectRpcError(
      await post(
        rpcRequest("vertex/notifications/delivery", notificationInput),
        { ...w.dependencies, ...f.dependencies }
      ),
      "UNAUTHORIZED",
      401
    );
    expect(f.requireSession).toHaveBeenCalledTimes(1);
    expect(f.delivery).not.toHaveBeenCalled();
    expect(f.requireRole).not.toHaveBeenCalled();
    expect(w.authenticate).not.toHaveBeenCalled();
    return expect(w.invoke).not.toHaveBeenCalled();
  });

  it("returns unavailable for a missing notification binding after session authentication", async () => {
    const f = notificationFixture();
    const request = rpcRequest(
      "vertex/notifications/delivery",
      notificationInput,
      null
    );
    const context = contextFor(request, {
      requireSession: f.requireSession,
      requireRole: f.requireRole,
    });
    expect(context).not.toHaveProperty("vertexNotificationRead");
    await expectRpcError(
      await handleApiRequest(request, context),
      "SERVICE_UNAVAILABLE",
      503
    );
    expect(f.requireSession).toHaveBeenCalledTimes(1);
    return expect(f.delivery).not.toHaveBeenCalled();
  });

  it.each([
    { target: "fixture-recipient" },
    { body: "do not send" },
    { retry: true },
    { userId: "other" },
    { principal: { userId: "other", role: "admin" } },
    { serverContext: { authority: "invented" } },
  ])(
    "rejects payload recipient/body/authority fields before notification service invocation: %j",
    async (extra) => {
      const f = notificationFixture();
      await expectRpcError(
        await post(
          rpcRequest("vertex/notifications/delivery", {
            ...notificationInput,
            ...extra,
          }),
          f.dependencies
        ),
        "BAD_REQUEST",
        400
      );
      expect(f.delivery).not.toHaveBeenCalled();
      return expect(f.requireRole).not.toHaveBeenCalled();
    }
  );

  it("keeps an actual service rights denial forbidden even for an authenticated admin", async () => {
    const f = notificationFixture();
    f.requireSession.mockResolvedValue(adminSession);
    f.delivery.mockRejectedValue(new VertexReadServiceError("FORBIDDEN"));
    await expectRpcError(
      await post(
        rpcRequest("vertex/notifications/delivery", notificationInput, null),
        f.dependencies
      ),
      "FORBIDDEN",
      403
    );
    expect(f.delivery.mock.calls[0]?.[0]).toBe(adminSession.principal);
    return expect(f.requireRole).not.toHaveBeenCalled();
  });

  it("redacts unexpected source exceptions and forged error codes to unavailable", async () => {
    const f = notificationFixture();
    f.delivery.mockRejectedValue(
      Object.assign(new Error("private notification detail"), {
        code: "FORBIDDEN",
        cause: new Error(token),
      })
    );
    const response = await post(
      rpcRequest("vertex/notifications/delivery", notificationInput, null),
      f.dependencies
    );
    const copy = response.clone();
    await expectRpcError(response, "SERVICE_UNAVAILABLE", 503);
    return expect(await copy.text()).not.toContain(
      "private notification detail"
    );
  });

  it("rejects a pre-aborted request without calling the notification service", async () => {
    const f = notificationFixture();
    const controller = new AbortController();
    controller.abort();
    const request = rpcRequest(
      "vertex/notifications/delivery",
      notificationInput,
      null,
      controller.signal
    );
    await expectRpcError(
      await post(request, f.dependencies),
      "SERVICE_UNAVAILABLE",
      503
    );
    return expect(f.delivery).not.toHaveBeenCalled();
  });

  it("rechecks request cancellation after the notification service resolves", async () => {
    const f = notificationFixture();
    const controller = new AbortController();
    f.delivery.mockImplementation(async () => {
      controller.abort();
      return notificationOutput;
    });
    const request = rpcRequest(
      "vertex/notifications/delivery",
      notificationInput,
      null,
      controller.signal
    );
    await expectRpcError(
      await post(request, f.dependencies),
      "SERVICE_UNAVAILABLE",
      503
    );
    return expect(f.delivery).toHaveBeenCalledTimes(1);
  });

  it("serves historical delivery through GET without bearer authority or send/receipt promotion", async () => {
    const f = notificationFixture();
    const url = new URL(
      "https://darkfactory.localhost/api/openapi/vertex/notifications/delivery"
    );
    for (const [name, value] of Object.entries(notificationInput)) {
      url.searchParams.set(name, value);
    }
    const request = new Request(url, {
      headers: { cookie: "fixture-browser-session=browser-authority" },
    });
    const response = await handleOpenApiRequest(
      request,
      contextFor(request, f.dependencies)
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(notificationOutput);
    expect(f.delivery).toHaveBeenCalledExactlyOnceWith(
      session.principal,
      notificationInput
    );
    return expect(f.requireRole).not.toHaveBeenCalled();
  });
});
