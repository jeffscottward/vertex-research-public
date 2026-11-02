import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { ORPCError } from "@orpc/client";
import { createRouterClient } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import { createApiClient } from "./client.ts";
import { createApiContext, type ApiContext } from "./server/context.ts";
import {
  ORPC_OPENAPI_PREFIX,
  handleApiRequest,
  handleOpenApiRequest,
} from "./server/handler.ts";
import { appRouter } from "./server/router.ts";
import * as vertexService from "./server/vertex-service.ts";
import type {
  VertexReadDependencies,
  VertexStoredArtifact,
} from "./server/vertex-service.ts";

const now = new Date("2026-09-21T14:00:00Z");
const session: SafeAuthSession = {
  user: {
    id: "member-1",
    name: "Synthetic member",
    email: "fixture@example.test",
    emailVerified: true,
    image: null,
    createdAt: now,
    updatedAt: now,
    role: "member",
    status: "active",
  },
  session: {
    id: "session-1",
    userId: "member-1",
    expiresAt: new Date("2026-09-23T14:00:00Z"),
    createdAt: now,
    updatedAt: now,
    ipAddress: null,
    userAgent: null,
  },
  principal: { userId: "member-1", role: "member", status: "active" },
};
const digest = "a".repeat(64);
const moduleManifest = {
  schemaVersion: "1.0.0",
  moduleId: "gamma-research",
  version: "1.0.0",
  inputSchemaVersion: "1.0.0",
  outputSchemaVersion: "1.0.0",
  capabilities: ["research"],
  dataRequirements: [],
  supportedInstruments: ["equity"],
  riskPolicyVersion: "1.0.0",
  artifactDigest: digest,
  lifecycleState: "unavailable",
  runtime: "python-external",
  reasonCodes: ["adapter-not-validated"],
};

const stored = async (
  value: unknown,
  identity: VertexStoredArtifact["identity"]
): Promise<VertexStoredArtifact> => {
  const bytes = new TextEncoder().encode(canonicalArtifactJson(value));
  return { bytes, artifactSha256: await hashArtifact(bytes), identity };
};

const dependencies = () => ({
  read: {
    listModules: vi.fn(async () =>
      stored([moduleManifest], { kind: "modules" })
    ),
  },
  authorization: {
    canListModules: vi.fn(async () => true),
  },
});

const contextFor = (
  request: Request,
  vertexRead?: VertexReadDependencies,
  auth: "member" | "anonymous" | "denied" = "member"
): ApiContext =>
  createApiContext(request, {
    repositories: {} as never,
    capabilities: {
      ai: false,
      emailDelivery: false,
      analytics: false,
      telemetryExport: false,
    },
    requestId: "vertex-read-request",
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
      return session;
    },
    requireRole: async () => {
      throw new Error(
        "Vertex reads must not substitute role-only authorization"
      );
    },
    ...(vertexRead === undefined ? {} : { vertexRead }),
  });

const clientFor = (
  vertexRead?: VertexReadDependencies,
  auth: "member" | "anonymous" | "denied" = "member",
  responses: Response[] = []
) =>
  createApiClient({
    baseUrl: "https://darkfactory.localhost",
    fetch: async (request: Request) => {
      const response = await handleApiRequest(
        request,
        contextFor(request, vertexRead, auth)
      );
      responses.push(response.clone());
      return response;
    },
  });

const listModules = (client: ReturnType<typeof clientFor>) =>
  client.vertex.modules.list({});

const expectError = async (
  operation: Promise<unknown>,
  code: string,
  status: number
): Promise<void> => {
  try {
    await operation;
    throw new Error("Expected Vertex read failure");
  } catch (error) {
    expect(error).toBeInstanceOf(ORPCError);
    expect(error).toMatchObject({ code, status, defined: true });
    expect(JSON.stringify(error)).not.toContain("private provider secret");
  }
};

describe("Vertex authenticated read handlers", () => {
  it("injects only explicitly supplied dependencies into context", () => {
    const request = new Request(
      "https://darkfactory.localhost/api/orpc/vertex/modules/list"
    );
    const deps = dependencies();
    expect(contextFor(request, deps).vertexRead).toBe(deps);
    return expect(contextFor(request)).not.toHaveProperty("vertexRead");
  });

  it("requires authentication before authorization or storage", async () => {
    for (const auth of ["anonymous", "denied"] as const) {
      const deps = dependencies();
      await expectError(
        listModules(clientFor(deps, auth)),
        auth === "anonymous" ? "UNAUTHORIZED" : "FORBIDDEN",
        auth === "anonymous" ? 401 : 403
      );
      expect(deps.authorization.canListModules).not.toHaveBeenCalled();
      expect(deps.read.listModules).not.toHaveBeenCalled();
    }
    return;
  });

  it("returns the validated module list with server principal and no readiness promotion", async () => {
    const deps = dependencies();
    const client = clientFor(deps);
    await expect(client.vertex.modules.list({})).resolves.toEqual([
      moduleManifest,
    ]);
    expect(deps.authorization.canListModules).toHaveBeenCalledWith(
      session.principal
    );
    return expect(deps.read.listModules).toHaveBeenCalledWith(
      session.principal
    );
  });

  it("retains deep immutability through the in-process router boundary", async () => {
    const request = new Request("https://darkfactory.localhost");
    const client = createRouterClient(appRouter, {
      context: contextFor(request, dependencies()),
    });
    const modules = await client.vertex.modules.list({});
    expect(Object.isFrozen(modules)).toBe(true);
    return expect(Object.isFrozen(modules[0]?.reasonCodes)).toBe(true);
  });

  it("fails unavailable when production ports are missing", async () => {
    await expectError(listModules(clientFor()), "SERVICE_UNAVAILABLE", 503);
    const deps = dependencies();
    await expectError(
      listModules(clientFor({ read: deps.read })),
      "SERVICE_UNAVAILABLE",
      503
    );
    return await expectError(
      listModules(clientFor({ authorization: deps.authorization })),
      "SERVICE_UNAVAILABLE",
      503
    );
  });

  it("maps an actual deny before storage", async () => {
    const deps = dependencies();
    deps.authorization.canListModules.mockResolvedValue(false);
    await expectError(listModules(clientFor(deps)), "FORBIDDEN", 403);
    return expect(deps.read.listModules).not.toHaveBeenCalled();
  });

  it("sanitizes provider exceptions as unavailable", async () => {
    const deps = dependencies();
    deps.read.listModules.mockRejectedValue(
      new Error("private provider secret")
    );
    const responses: Response[] = [];
    await expectError(
      listModules(clientFor(deps, "member", responses)),
      "SERVICE_UNAVAILABLE",
      503
    );
    return expect(await responses[0]?.text()).not.toContain(
      "private provider secret"
    );
  });

  it("rejects malicious source data without leaking fields or promoting readiness", async () => {
    const deps = dependencies();
    deps.read.listModules.mockResolvedValue(
      await stored(
        [{ ...moduleManifest, privateValue: "private provider secret" }],
        { kind: "modules" }
      )
    );
    const responses: Response[] = [];
    await expectError(
      listModules(clientFor(deps, "member", responses)),
      "INVALID_SOURCE",
      502
    );
    for (const response of responses) {
      expect(await response.text()).not.toContain("private provider secret");
    }
    return;
  });

  it("rejects request-supplied identities before access decisions", async () => {
    const deps = dependencies();
    const client = clientFor(deps);
    await expectError(
      client.vertex.modules.list({ principal: { userId: "admin" } } as never),
      "BAD_REQUEST",
      400
    );
    await expectError(
      client.vertex.modules.list({ datasetId: "dataset-1" } as never),
      "BAD_REQUEST",
      400
    );
    expect(deps.authorization.canListModules).not.toHaveBeenCalled();
    return expect(deps.read.listModules).not.toHaveBeenCalled();
  });

  it("preserves unexpected internal errors for the transport's sanitized handling", async () => {
    const failure = new Error("private provider secret");
    const factory = vi
      .spyOn(vertexService, "createVertexReadService")
      .mockImplementation(() => {
        throw failure;
      });
    try {
      const request = new Request("https://darkfactory.localhost");
      const client = createRouterClient(appRouter, {
        context: contextFor(request),
      });
      return await expect(client.vertex.modules.list({})).rejects.toBe(failure);
    } finally {
      factory.mockRestore();
    }
  });

  it("serves the same authorization boundary through the GET OpenAPI route", async () => {
    const deps = dependencies();
    const request = new Request(
      `https://darkfactory.localhost${ORPC_OPENAPI_PREFIX}/vertex/modules`
    );
    const ok = await handleOpenApiRequest(request, contextFor(request, deps));
    expect(ok.status).toBe(200);
    const anonymous = await handleOpenApiRequest(
      request,
      contextFor(request, deps, "anonymous")
    );
    expect(anonymous.status).toBe(401);
    deps.authorization.canListModules.mockResolvedValue(false);
    const denied = await handleOpenApiRequest(
      request,
      contextFor(request, deps)
    );
    return expect(denied.status).toBe(403);
  });

  it("no longer routes removed dataset and evidence reads", async () => {
    const deps = dependencies();
    for (const path of [
      "/vertex/datasets/dataset-1",
      "/vertex/collections/collection-1/evidence/evidence-1",
    ]) {
      const request = new Request(
        `https://darkfactory.localhost${ORPC_OPENAPI_PREFIX}${path}`
      );
      const response = await handleOpenApiRequest(
        request,
        contextFor(request, deps)
      );
      expect(response.status).toBe(404);
    }
    expect(deps.authorization.canListModules).not.toHaveBeenCalled();
    return expect(deps.read.listModules).not.toHaveBeenCalled();
  });
});
