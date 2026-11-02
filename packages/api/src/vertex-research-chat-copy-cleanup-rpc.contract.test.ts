import {
  AuthAuthorizationError,
  AUTHORIZATION_ERROR_CODES,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
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
import type { ContractRouterClient, InferSchemaInput } from "@orpc/contract";
import { createRouterClient } from "@orpc/server";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { appContract } from "./contract.ts";
import { buildOpenApiDocument } from "./openapi.ts";
import * as publicVertex from "./vertex.ts";
import { VertexResearchChatErrors } from "./contracts/vertex-research-chat.ts";
import {
  vertexResearchChatCopyCleanupContract,
  VertexResearchChatRequestCopyCleanupRpcInputSchema,
  VertexResearchChatReadCopyCleanupRpcInputSchema,
} from "./contracts/vertex-research-chat-copy-cleanup-rpc.ts";
import {
  VertexResearchChatRequestCopyCleanupInputSchema,
  VertexResearchChatReadCopyCleanupInputSchema,
  VertexResearchChatCopyCleanupReceiptSchema,
  VertexResearchChatRequestCopyCleanupOutputSchema,
  VertexResearchChatReadCopyCleanupOutputSchema,
  type VertexResearchChatRequestCopyCleanupInput,
  type VertexResearchChatReadCopyCleanupInput,
} from "./contracts/vertex-research-chat-copy-cleanup.ts";
import {
  createApiContext,
  type ApiContextDependencies,
} from "./server/context.ts";
import { handleApiRequest, handleOpenApiRequest } from "./server/handler.ts";
import { appRouter } from "./server/router.ts";
import type { VertexExperienceDependencies } from "./server/vertex-experience-core.ts";

// Synthetic session and store ports. Session identity is not literal presence.
const now = "2026-09-24T00:00:00Z";
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
const session: SafeAuthSession = {
  user: {
    id: "fixture-member",
    name: "Fixture member",
    email: "fixture@example.test",
    emailVerified: true,
    image: null,
    createdAt: new Date(now),
    updatedAt: new Date(now),
    role: "member",
    status: "active",
  },
  session: {
    id: "fixture-session",
    userId: "fixture-member",
    expiresAt: new Date("2026-09-25T00:00:00Z"),
    createdAt: new Date(now),
    updatedAt: new Date(now),
    ipAddress: null,
    userAgent: null,
  },
  principal: { userId: "fixture-member", role: "member", status: "active" },
};
const fixture = async () => {
  const requestSha256 = await hashArtifact(
    canonicalArtifactJson({
      operation: "requestCopyCleanup",
      actorId: session.principal.userId,
      input,
    })
  );
  const receipt = {
    ...input,
    schemaVersion: "1.0.0",
    executionAuthorized: false,
    status: "requested",
    ownerActorId: session.principal.userId,
    cleanupRequestId: `copy-cleanup-${requestSha256}`,
    requestSha256,
    recordedAt: now,
    targetKinds: ["context", "model-input", "derived-output"],
  };
  const requestCleanup = vi.fn(async (): Promise<VertexRecord> => receipt);
  const readCleanup = vi.fn(async (): Promise<VertexRecord | null> => receipt);
  const forbidden = vi.fn(async () => {
    throw new Error(
      "No processing, policy, model, history or physical cleanup calls"
    );
  });
  const authorize = vi.fn(
    async (value: Parameters<VertexAuthorizationRepository["authorize"]>[0]) =>
      value.action === "cleanup-chat-copies" &&
      value.resourceId === `research-chat-copies:${input.responseRequestId}` &&
      value.collectionId === null
  );
  const vertexExperience: VertexExperienceDependencies = {
    store: {
      requestResearchChatCopyCleanup: requestCleanup,
      readResearchChatCopyCleanup: readCleanup,
      readResearchChatThread: forbidden,
      listResearchChatMessages: forbidden,
      readResearchChatResponse: forbidden,
      sendResearchChatMessage: forbidden,
    } as unknown as VertexStore,
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
  const requireSession = vi.fn<ApiContextDependencies["requireSession"]>(
    async () => session
  );
  const dependencies: ApiContextDependencies = {
    repositories: {} as never,
    capabilities: {
      ai: false,
      emailDelivery: false,
      analytics: false,
      telemetryExport: false,
    },
    requestId: "cleanup-contract-fixture",
    requireSession,
    requireRole: forbidden,
    vertexExperience,
  };
  return {
    receipt,
    requestCleanup,
    readCleanup,
    forbidden,
    authorize,
    requireSession,
    dependencies,
  };
};
const rpcRequest = (
  method: "requestCopyCleanup" | "readCopyCleanup",
  value: unknown,
  bearer = false
): Request =>
  new Request(
    `https://darkfactory.localhost/api/orpc/vertex/researchChat/${method}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://darkfactory.localhost",
        ...(bearer ? { authorization: "Bearer synthetic-worker-token" } : {}),
      },
      body: JSON.stringify({ json: value }),
    }
  );
const object = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Expected documented schema object");
  return value as Record<string, unknown>;
};
const jsonSchema = (value: unknown): Record<string, unknown> =>
  object(
    object(object(object(value)["content"])["application/json"])["schema"]
  );
const exactObject = (
  value: unknown,
  fields: readonly string[]
): Record<string, unknown> => {
  const schema = object(value);
  expect(schema["type"]).toBe("object");
  expect(schema["additionalProperties"]).toBe(false);
  expect(new Set(schema["required"] as string[])).toEqual(new Set(fields));
  expect(Object.keys(object(schema["properties"])).sort()).toEqual(
    [...fields].sort()
  );
  return object(schema["properties"]);
};

describe("account-only original cleanup ACK RPC", () => {
  it("registers two exact account routes, public DTOs and no worker method", () => {
    expect(Object.keys(vertexResearchChatCopyCleanupContract).sort()).toEqual([
      "readCopyCleanup",
      "requestCopyCleanup",
    ]);
    for (const [name, method, inputSchema, outputSchema] of [
      [
        "requestCopyCleanup",
        "POST",
        VertexResearchChatRequestCopyCleanupRpcInputSchema,
        VertexResearchChatRequestCopyCleanupOutputSchema,
      ],
      [
        "readCopyCleanup",
        "GET",
        VertexResearchChatReadCopyCleanupRpcInputSchema,
        VertexResearchChatReadCopyCleanupOutputSchema,
      ],
    ] as const) {
      const definition = appContract.vertex.researchChat[name]["~orpc"];
      expect(appContract.vertex.researchChat[name]).toBe(
        vertexResearchChatCopyCleanupContract[name]
      );
      expect(definition.inputSchema).toBe(inputSchema);
      expect(definition.outputSchema).toBe(outputSchema);
      expect(definition.errorMap).toEqual(VertexResearchChatErrors);
      expect(definition.route).toMatchObject({
        operationId: `vertex.researchChat.${name}`,
        method,
        path: "/vertex/research-chat/threads/{threadId}/copy-cleanup",
      });
      expect(Object.hasOwn(appContract.vertexWorker, name)).toBe(false);
      expect(Object.hasOwn(appRouter.vertexWorker, name)).toBe(false);
    }
    expect(publicVertex.vertexResearchChatCopyCleanupContract).toBe(
      vertexResearchChatCopyCleanupContract
    );
    expect(publicVertex.VertexResearchChatRequestCopyCleanupInputSchema).toBe(
      VertexResearchChatRequestCopyCleanupInputSchema
    );
    expect(publicVertex.VertexResearchChatReadCopyCleanupInputSchema).toBe(
      VertexResearchChatReadCopyCleanupInputSchema
    );
    expect(publicVertex.VertexResearchChatCopyCleanupReceiptSchema).toBe(
      VertexResearchChatCopyCleanupReceiptSchema
    );
    expect(VertexResearchChatRequestCopyCleanupRpcInputSchema.out).toBe(
      VertexResearchChatRequestCopyCleanupInputSchema
    );
    return expect(VertexResearchChatReadCopyCleanupRpcInputSchema.out).toBe(
      VertexResearchChatReadCopyCleanupInputSchema
    );
  });

  it("exposes exact required five-field client inputs instead of unknown", () => {
    type Client = ContractRouterClient<
      typeof appContract
    >["vertex"]["researchChat"];
    type RequestInput = Parameters<Client["requestCopyCleanup"]>[0];
    type ReadInput = Parameters<Client["readCopyCleanup"]>[0];
    expectTypeOf<RequestInput>().toEqualTypeOf<VertexResearchChatRequestCopyCleanupInput>();
    expectTypeOf<ReadInput>().toEqualTypeOf<VertexResearchChatReadCopyCleanupInput>();
    expectTypeOf<
      InferSchemaInput<
        typeof VertexResearchChatRequestCopyCleanupRpcInputSchema
      >
    >().toEqualTypeOf<RequestInput>();
    expectTypeOf<
      InferSchemaInput<typeof VertexResearchChatReadCopyCleanupRpcInputSchema>
    >().toEqualTypeOf<ReadInput>();
    expectTypeOf<unknown>().not.toExtend<RequestInput>();
    expectTypeOf<unknown>().not.toExtend<ReadInput>();
    expectTypeOf<
      Omit<RequestInput, "responseRequestId">
    >().not.toExtend<RequestInput>();
    return expectTypeOf<
      Omit<ReadInput, "idempotencyKey">
    >().not.toExtend<ReadInput>();
  });

  it("preserves hostile-data preflight in actual RPC validators without evaluating accessors", () => {
    for (const schema of [
      VertexResearchChatRequestCopyCleanupRpcInputSchema,
      VertexResearchChatReadCopyCleanupRpcInputSchema,
    ]) {
      const getter = vi.fn(() => input.threadId);
      const raw = Object.defineProperty({ ...input }, "threadId", {
        enumerable: true,
        get: getter,
      });
      expect(schema.safeParse(raw).success).toBe(false);
      expect(getter).not.toHaveBeenCalled();

      for (const change of [
        { human: true },
        { approved: true },
        { issuer: "caller" },
        { profile: "private" },
        { ttl: 10 },
        { targetKinds: ["context"] },
        { environment: "live" },
        { threadId: "thread-a\n" },
      ]) {
        expect(schema.safeParse({ ...input, ...change }).success).toBe(false);
      }
    }
  });

  it("requires the actual session middleware for both no-session and bearer-only calls", async () => {
    const h = await fixture();
    h.requireSession.mockRejectedValue(
      new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401)
    );
    for (const bearer of [false, true]) {
      for (const method of ["requestCopyCleanup", "readCopyCleanup"] as const) {
        const request = rpcRequest(method, input, bearer);
        const response = await handleApiRequest(
          request,
          createApiContext(request, h.dependencies)
        );
        expect(response.status).toBe(401);
        expect(await response.json()).toMatchObject({
          json: { code: "UNAUTHORIZED" },
        });
      }
    }
    expect(h.requireSession).toHaveBeenCalledTimes(4);
    expect(h.authorize).not.toHaveBeenCalled();
    expect(h.requestCleanup).not.toHaveBeenCalled();
    expect(h.readCleanup).not.toHaveBeenCalled();
    return expect(h.forbidden).not.toHaveBeenCalled();
  });

  it("uses the server session principal and succeeds with processing gates revoked", async () => {
    const h = await fixture();
    const request = rpcRequest("requestCopyCleanup", input);
    const response = await handleApiRequest(
      request,
      createApiContext(request, h.dependencies)
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ json: h.receipt });
    expect(h.requestCleanup).toHaveBeenCalledExactlyOnceWith({
      principal: { actorId: session.principal.userId },
      scope,
      threadId: input.threadId,
      responseRequestId: input.responseRequestId,
      idempotencyKey: input.idempotencyKey,
    });
    const readRequest = rpcRequest("readCopyCleanup", input);
    const client = createRouterClient(appRouter, {
      context: createApiContext(readRequest, h.dependencies),
    });
    const output = await client.vertex.researchChat.readCopyCleanup(input);
    expect(output).toEqual(h.receipt);
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.targetKinds)).toBe(true);
    expect(h.readCleanup).toHaveBeenCalledExactlyOnceWith(
      { actorId: session.principal.userId },
      scope,
      input.threadId,
      input.responseRequestId,
      input.idempotencyKey
    );
    expect(
      h.authorize.mock.calls.map(([value]) => [
        value.action,
        value.resourceId,
        value.collectionId,
      ])
    ).toEqual(
      [0, 1].map(() => [
        "cleanup-chat-copies",
        `research-chat-copies:${input.responseRequestId}`,
        null,
      ])
    );
    return expect(h.forbidden).not.toHaveBeenCalled();
  });

  it("rejects inactive sessions and dedicated cleanup denials before store calls", async () => {
    for (const method of ["requestCopyCleanup", "readCopyCleanup"] as const) {
      const h = await fixture();
      h.requireSession.mockResolvedValue({
        ...session,
        principal: { ...session.principal, status: "suspended" },
      });
      const inactive = rpcRequest(method, input);
      expect(
        (
          await handleApiRequest(
            inactive,
            createApiContext(inactive, h.dependencies)
          )
        ).status
      ).toBe(403);
      h.requireSession.mockResolvedValue(session);
      h.authorize.mockResolvedValue(false);
      const denied = rpcRequest(method, input);
      expect(
        (
          await handleApiRequest(
            denied,
            createApiContext(denied, h.dependencies)
          )
        ).status
      ).toBe(403);
      expect(h.requestCleanup).not.toHaveBeenCalled();
      expect(h.readCleanup).not.toHaveBeenCalled();
    }
  });

  it("rejects caller presence claims and body fields at the actual root without calling store", async () => {
    const h = await fixture();
    for (const method of ["requestCopyCleanup", "readCopyCleanup"] as const) {
      for (const change of [
        { human: true },
        { actorId: "other" },
        { body: "private" },
        { ttl: 1 },
      ]) {
        const request = rpcRequest(method, { ...input, ...change });
        expect(
          (
            await handleApiRequest(
              request,
              createApiContext(request, h.dependencies)
            )
          ).status
        ).toBe(400);
      }
    }
    expect(h.requestCleanup).not.toHaveBeenCalled();
    return expect(h.readCleanup).not.toHaveBeenCalled();
  });

  it("uses the same services for documented POST and GET original receipts", async () => {
    const h = await fixture();
    const { threadId, ...body } = input;
    const request = new Request(
      `https://darkfactory.localhost/api/openapi/vertex/research-chat/threads/${threadId}/copy-cleanup`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://darkfactory.localhost",
        },
        body: JSON.stringify(body),
      }
    );
    const response = await handleOpenApiRequest(
      request,
      createApiContext(request, h.dependencies)
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(h.receipt);
    const query = new URLSearchParams(body);
    const readRequest = new Request(`${request.url}?${query}`);
    const read = await handleOpenApiRequest(
      readRequest,
      createApiContext(readRequest, h.dependencies)
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(h.receipt);
    return expect(h.forbidden).not.toHaveBeenCalled();
  });

  it("fails closed for source substitutions, absence and unknown outcome without automatic retry", async () => {
    const h = await fixture();
    for (const method of ["requestCopyCleanup", "readCopyCleanup"] as const) {
      for (const change of [
        { ownerActorId: "other" },
        { threadId: "other" },
        {
          requestSha256: "c".repeat(64),
          cleanupRequestId: `copy-cleanup-${"c".repeat(64)}`,
        },
        { status: "complete" },
        { ready: true },
      ]) {
        h.requestCleanup.mockResolvedValue({ ...h.receipt, ...change });
        h.readCleanup.mockResolvedValue({ ...h.receipt, ...change });
        const request = rpcRequest(method, input);
        expect(
          (
            await handleApiRequest(
              request,
              createApiContext(request, h.dependencies)
            )
          ).status
        ).toBe(502);
      }
    }
    h.readCleanup.mockResolvedValue(null);
    const absentRequest = rpcRequest("readCopyCleanup", input);
    const absent = await handleApiRequest(
      absentRequest,
      createApiContext(absentRequest, h.dependencies)
    );
    expect(absent.status).toBe(404);
    expect(await absent.json()).toMatchObject({ json: { code: "NOT_FOUND" } });
    h.requestCleanup.mockClear();
    for (const [error, code, status] of [
      [new VertexStoreError("conflict"), "CONFLICT", 409],
      [new VertexStoreError("denied"), "FORBIDDEN", 403],
      [
        new Error("private committed acknowledgement lost"),
        "SERVICE_UNAVAILABLE",
        503,
      ],
    ] as const) {
      h.requestCleanup.mockRejectedValue(error);
      const request = rpcRequest("requestCopyCleanup", input);
      const response = await handleApiRequest(
        request,
        createApiContext(request, h.dependencies)
      );
      expect(response.status).toBe(status);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ json: { code } });
      expect(text).not.toContain("private committed acknowledgement lost");
    }
    expect(h.requestCleanup).toHaveBeenCalledTimes(3);
    return expect(h.forbidden).not.toHaveBeenCalled();
  });

  it("documents exact inputs and original receipt only, not current cleanup state", async () => {
    const document = await buildOpenApiDocument();
    const endpoint =
      document.paths?.["/vertex/research-chat/threads/{threadId}/copy-cleanup"];
    exactObject(jsonSchema(endpoint?.post?.requestBody), [
      "accountAlias",
      "environment",
      "responseRequestId",
      "idempotencyKey",
    ]);
    const parameters = endpoint?.get?.parameters ?? [];
    expect(parameters).toHaveLength(5);
    for (const name of [
      "accountAlias",
      "environment",
      "threadId",
      "responseRequestId",
      "idempotencyKey",
    ]) {
      expect(parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name,
            required: true,
            in: name === "threadId" ? "path" : "query",
          }),
        ])
      );
    }
    expect(endpoint?.get?.requestBody).toBeUndefined();

    for (const method of ["post", "get"] as const) {
      const properties = exactObject(
        jsonSchema(endpoint?.[method]?.responses?.["200"]),
        [
          "schemaVersion",
          "executionAuthorized",
          "status",
          "accountAlias",
          "environment",
          "threadId",
          "ownerActorId",
          "responseRequestId",
          "idempotencyKey",
          "cleanupRequestId",
          "requestSha256",
          "recordedAt",
          "targetKinds",
        ]
      );
      expect(properties["status"]).toMatchObject({ const: "requested" });
      expect(properties["executionAuthorized"]).toMatchObject({ const: false });
      expect(properties["environment"]).toMatchObject({ const: "research" });
      expect(Object.keys(endpoint?.[method]?.responses ?? {})).toEqual(
        expect.arrayContaining([
          "200",
          "400",
          "401",
          "403",
          "404",
          "409",
          "502",
          "503",
        ])
      );
    }
  });
});
