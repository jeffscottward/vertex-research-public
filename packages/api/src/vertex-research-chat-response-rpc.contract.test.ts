import {
  AUTHORIZATION_ERROR_CODES,
  AuthAuthorizationError,
  type SafeAuthSession,
} from "@darkfactory/auth/server";
import {
  type VertexAuthorizationRepository,
  type VertexRecord,
  type VertexStore,
  VertexStoreError,
} from "@darkfactory/db/server/vertex";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import type { ContractRouterClient, InferSchemaInput } from "@orpc/contract";
import { createRouterClient } from "@orpc/server";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { appContract } from "./contract.ts";
import { VertexResearchChatErrors } from "./contracts/vertex-research-chat.ts";
import {
  type VertexResearchChatReadResponseInput,
  VertexResearchChatReadResponseInputSchema,
  VertexResearchChatReadResponseOutputSchema,
  type VertexResearchChatRequestResponseInput,
  VertexResearchChatRequestResponseInputSchema,
  VertexResearchChatRequestResponseOutputSchema,
  VertexResearchChatResponseReceiptSchema,
} from "./contracts/vertex-research-chat-response.ts";
import {
  VertexResearchChatReadResponseRpcInputSchema,
  VertexResearchChatRequestResponseRpcInputSchema,
  vertexResearchChatResponseContract,
} from "./contracts/vertex-research-chat-response-rpc.ts";
import { buildOpenApiDocument } from "./openapi.ts";
import {
  type ApiContextDependencies,
  createApiContext,
} from "./server/context.ts";
import { handleApiRequest, handleOpenApiRequest } from "./server/handler.ts";
import { appRouter } from "./server/router.ts";
import {
  type VertexExperienceDependencies,
  VertexExperienceServiceError,
} from "./server/vertex-experience-core.ts";
import * as publicVertex from "./vertex.ts";

// Synthetic sessions/ports only. No database, model, worker or network execution.
const now = "2026-09-24T00:00:00Z";
const scope = {
  accountAlias: "fixture-research",
  environment: "research" as const,
};
const input = {
  ...scope,
  contextStartSequence: "1",
  idempotencyKey: "original-response-key",
  parentMessageId: "message-a",
  participantId: "first-mate",
  retrievalQuery: "  Literal research question  ",
  snapshotRevision: "2",
  threadId: "thread-a",
};
const readInput = {
  ...scope,
  idempotencyKey: input.idempotencyKey,
  threadId: input.threadId,
};
const base = { executionAuthorized: false, schemaVersion: "1.0.0" } as const;
const session: SafeAuthSession = {
  principal: { role: "member", status: "active", userId: "fixture-member" },
  session: {
    createdAt: new Date(now),
    expiresAt: new Date("2026-09-25T00:00:00Z"),
    id: "fixture-session",
    ipAddress: null,
    updatedAt: new Date(now),
    userAgent: null,
    userId: "fixture-member",
  },
  user: {
    createdAt: new Date(now),
    email: "fixture@example.test",
    emailVerified: true,
    id: "fixture-member",
    image: null,
    name: "Fixture member",
    role: "member",
    status: "active",
    updatedAt: new Date(now),
  },
};
const hash = (value: unknown) => hashArtifact(canonicalArtifactJson(value));
const fixture = async () => {
  const { retrievalQuery: _retrievalQuery, ...metadata } = input;
  const receipt = {
    ...base,
    ...metadata,
    admission: null,
    jobId: null,
    ownerActorId: session.principal.userId,
    reasonCodes: ["research-runtime-unavailable"],
    recordedAt: now,
    requestSha256: await hash({
      actorId: session.principal.userId,
      input,
      operation: "requestResponse",
    }),
    responseRequestId: `response-${await hash({ actorId: session.principal.userId, idempotencyKey: input.idempotencyKey, operation: "requestResponse", scope, threadId: input.threadId })}`,
    status: "unavailable",
  };
  const observation = {
    ...base,
    checkedAt: now,
    delivery: { status: "not-applicable" },
    job: null,
    receipt,
  };
  const requestResponse = vi.fn(async (): Promise<VertexRecord> => receipt);
  const readResponse = vi.fn(
    async (): Promise<VertexRecord | null> => observation
  );
  const forbidden = vi.fn(async () => {
    throw new Error("No roster, policy, model or history pre-gate");
  });
  const authorize = vi.fn(
    async (
      _request: Parameters<VertexAuthorizationRepository["authorize"]>[0]
    ) => true
  );
  const vertexExperience: VertexExperienceDependencies = {
    authorization: {
      authorize,
      authorizeCleanupFamily: forbidden,
      discoverCleanupFamilies: forbidden,
      issueGrant: forbidden,
      listAuthorizedScopes: forbidden,
      revokeGrant: forbidden,
    },
    clock: { now: () => now },
    resolvePolicy: forbidden,
    store: {
      listResearchChatMessages: forbidden,
      readResearchChatResponse: readResponse,
      readResearchChatThread: forbidden,
      requestResearchChatResponse: requestResponse,
      sendResearchChatMessage: forbidden,
    } as unknown as VertexStore,
  };
  const requireSession = vi.fn<ApiContextDependencies["requireSession"]>(
    async () => session
  );
  const dependencies: ApiContextDependencies = {
    capabilities: {
      ai: false,
      analytics: false,
      emailDelivery: false,
      telemetryExport: false,
    },
    repositories: {} as never,
    requestId: "response-contract-fixture",
    requireRole: forbidden,
    requireSession,
    vertexExperience,
  };
  return {
    authorize,
    dependencies,
    forbidden,
    observation,
    readResponse,
    receipt,
    requestResponse,
    requireSession,
  };
};
const rpcRequest = (
  method: "requestResponse" | "readResponse",
  value: unknown
): Request =>
  new Request(
    `https://darkfactory.localhost/api/orpc/vertex/researchChat/${method}`,
    {
      body: JSON.stringify({ json: value }),
      headers: {
        "content-type": "application/json",
        origin: "https://darkfactory.localhost",
      },
      method: "POST",
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
  expect(schema["required"]).toEqual(expect.arrayContaining([...fields]));
  expect(new Set(schema["required"] as string[])).toEqual(new Set(fields));
  expect(Object.keys(object(schema["properties"])).sort()).toEqual(
    [...fields].sort()
  );
  return object(schema["properties"]);
};
const receiptFields = [
  "schemaVersion",
  "executionAuthorized",
  "accountAlias",
  "environment",
  "threadId",
  "ownerActorId",
  "responseRequestId",
  "parentMessageId",
  "participantId",
  "idempotencyKey",
  "requestSha256",
  "recordedAt",
  "snapshotRevision",
  "contextStartSequence",
  "jobId",
  "status",
  "reasonCodes",
  "admission",
];
const checkReceiptDocumentation = (value: unknown): void => {
  const variants = object(value)["anyOf"];
  expect(Array.isArray(variants)).toBe(true);
  if (!Array.isArray(variants))
    throw new TypeError("Expected receipt variants");
  expect(variants).toHaveLength(2);
  for (const variant of variants) {
    const properties = exactObject(variant, receiptFields);
    expect(properties["jobId"]).toMatchObject({ type: "null" });
    expect(properties["executionAuthorized"]).toMatchObject({ const: false });
    expect(properties["environment"]).toMatchObject({ const: "research" });
    if (object(properties["status"])["const"] === "unavailable") {
      expect(properties["admission"]).toMatchObject({ type: "null" });
    } else {
      expect(properties["status"]).toMatchObject({ const: "admitted" });
      const admission = exactObject(properties["admission"], [
        "bindingSha256",
        "contextSha256",
        "participantConfigSha256",
        "collectionId",
        "proposal",
        "runId",
        "eventId",
      ]);
      exactObject(admission["proposal"], ["artifactId", "sha256"]);
    }
  }
};

describe("additive durable response RPC contracts", () => {
  // The durable response surface grew (2bf4c34/f30459c) to prepare/approve,
  // append/content, debate, native-evidence and model-privacy operations; the
  // set stays enumerated independently so no operation appears unreviewed.
  it("registers only the exact authenticated-operation contracts and public DTO identities", () => {
    expect(Object.keys(vertexResearchChatResponseContract).sort()).toEqual([
      "appendResponse",
      "approveAndRequestDebateStep",
      "approveAndRequestNativeEvidence",
      "approveAndRequestResponse",
      "prepareDebateStep",
      "prepareNativeEvidence",
      "prepareResponse",
      "readDebateRun",
      "readModelPrivacyReviewRequest",
      "readNativeModelPrivacyReviewRequest",
      "readResponse",
      "readResponseContent",
      "recordModelPrivacyReview",
      "recordNativeModelPrivacyReview",
      "requestResponse",
    ]);
    const cases = [
      [
        "requestResponse",
        "POST",
        VertexResearchChatRequestResponseRpcInputSchema,
        VertexResearchChatRequestResponseOutputSchema,
      ],
      [
        "readResponse",
        "GET",
        VertexResearchChatReadResponseRpcInputSchema,
        VertexResearchChatReadResponseOutputSchema,
      ],
    ] as const;
    for (const [name, method, inputSchema, outputSchema] of cases) {
      const definition = appContract.vertex.researchChat[name]["~orpc"];
      expect(appContract.vertex.researchChat[name]).toBe(
        vertexResearchChatResponseContract[name]
      );
      expect(definition.inputSchema).toBe(inputSchema);
      expect(definition.outputSchema).toBe(outputSchema);
      expect(definition.errorMap).toEqual(VertexResearchChatErrors);
      expect(definition.route).toMatchObject({
        method,
        operationId: `vertex.researchChat.${name}`,
        path: "/vertex/research-chat/threads/{threadId}/responses",
      });
    }
    expect(publicVertex.vertexResearchChatResponseContract).toBe(
      vertexResearchChatResponseContract
    );
    expect(publicVertex.VertexResearchChatRequestResponseInputSchema).toBe(
      VertexResearchChatRequestResponseInputSchema
    );
    expect(publicVertex.VertexResearchChatReadResponseInputSchema).toBe(
      VertexResearchChatReadResponseInputSchema
    );
    expect(publicVertex.VertexResearchChatResponseReceiptSchema).toBe(
      VertexResearchChatResponseReceiptSchema
    );
    expect(publicVertex.VertexResearchChatReadResponseOutputSchema).toBe(
      VertexResearchChatReadResponseOutputSchema
    );
    expect(
      vertexResearchChatResponseContract.readResponse["~orpc"].route.description
    ).toContain("absence at read time only");
    expect(VertexResearchChatRequestResponseRpcInputSchema.out).toBe(
      VertexResearchChatRequestResponseInputSchema
    );
    expect(VertexResearchChatReadResponseRpcInputSchema.out).toBe(
      VertexResearchChatReadResponseInputSchema
    );
    expect(publicVertex.VertexResearchChatRequestResponseRpcInputSchema).toBe(
      VertexResearchChatRequestResponseRpcInputSchema
    );
    return expect(
      publicVertex.VertexResearchChatReadResponseRpcInputSchema
    ).toBe(VertexResearchChatReadResponseRpcInputSchema);
  });

  it("exposes exact required public client wire inputs instead of canonical-preflight unknown", () => {
    type Client = ContractRouterClient<
      typeof appContract
    >["vertex"]["researchChat"];
    type RequestInput = Parameters<Client["requestResponse"]>[0];
    type ReadInput = Parameters<Client["readResponse"]>[0];
    expectTypeOf<RequestInput>().toEqualTypeOf<VertexResearchChatRequestResponseInput>();
    expectTypeOf<ReadInput>().toEqualTypeOf<VertexResearchChatReadResponseInput>();
    expectTypeOf<
      InferSchemaInput<typeof VertexResearchChatRequestResponseRpcInputSchema>
    >().toEqualTypeOf<RequestInput>();
    expectTypeOf<
      InferSchemaInput<typeof VertexResearchChatReadResponseRpcInputSchema>
    >().toEqualTypeOf<ReadInput>();
    expectTypeOf<unknown>().not.toExtend<RequestInput>();
    expectTypeOf<unknown>().not.toExtend<ReadInput>();
    expectTypeOf<
      Omit<RequestInput, "retrievalQuery">
    >().not.toExtend<RequestInput>();
    expectTypeOf<
      Omit<RequestInput, "snapshotRevision">
    >().not.toExtend<RequestInput>();
    expectTypeOf<
      Omit<RequestInput, "idempotencyKey">
    >().not.toExtend<RequestInput>();
    expectTypeOf<Omit<ReadInput, "idempotencyKey">>().not.toExtend<ReadInput>();
    return expectTypeOf<
      Omit<ReadInput, "threadId">
    >().not.toExtend<ReadInput>();
  });

  it("keeps canonical preflight, bounded-range refinement and deep freeze in actual RPC validators", async () => {
    const h = await fixture();
    const requestSchema =
      vertexResearchChatResponseContract.requestResponse["~orpc"].inputSchema!;
    const outputSchema =
      vertexResearchChatResponseContract.readResponse["~orpc"].outputSchema!;
    expect(
      requestSchema.safeParse({ ...input, snapshotRevision: "18" }).success
    ).toBe(false);
    expect(
      requestSchema.safeParse({ ...input, model: "injected" }).success
    ).toBe(false);
    const getter = vi.fn(() => input.retrievalQuery);
    const raw = { ...input };
    Object.defineProperty(raw, "retrievalQuery", {
      enumerable: true,
      get: getter,
    });
    expect(requestSchema.safeParse(raw).success).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    const output = outputSchema.parse(h.observation);
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.receipt)).toBe(true);
    expect(Object.isFrozen(output.receipt.reasonCodes)).toBe(true);
    expect(
      outputSchema.safeParse({
        ...h.observation,
        checkedAt: "2026-09-23T00:00:00Z",
      }).success
    ).toBe(false);
    const readSchema =
      vertexResearchChatResponseContract.readResponse["~orpc"].inputSchema!;
    expect(
      readSchema.safeParse({
        ...readInput,
        retrievalQuery: input.retrievalQuery,
      }).success
    ).toBe(false);
    const readGetter = vi.fn(() => input.idempotencyKey);
    const readRaw = { ...readInput };
    Object.defineProperty(readRaw, "idempotencyKey", {
      enumerable: true,
      get: readGetter,
    });
    expect(readSchema.safeParse(readRaw).success).toBe(false);
    return expect(readGetter).not.toHaveBeenCalled();
  });

  it("requires the established verified session for both root routes before touching ports", async () => {
    const h = await fixture();
    h.requireSession.mockRejectedValue(
      new AuthAuthorizationError(AUTHORIZATION_ERROR_CODES.AUTH_REQUIRED, 401)
    );
    for (const [name, value] of [
      ["requestResponse", input],
      ["readResponse", readInput],
    ] as const) {
      const request = rpcRequest(name, value);
      const response = await handleApiRequest(
        request,
        createApiContext(request, h.dependencies)
      );
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        json: { code: "UNAUTHORIZED" },
      });
    }
    expect(h.requireSession).toHaveBeenCalledTimes(2);
    expect(h.authorize).not.toHaveBeenCalled();
    expect(h.requestResponse).not.toHaveBeenCalled();
    return expect(h.readResponse).not.toHaveBeenCalled();
  });

  it("forwards the original key through the real root RPC handlers and preserves immutable output", async () => {
    const h = await fixture();
    const request = rpcRequest("requestResponse", input);
    const response = await handleApiRequest(
      request,
      createApiContext(request, h.dependencies)
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ json: h.receipt });
    expect(h.requestResponse).toHaveBeenCalledExactlyOnceWith({
      contextStartSequence: input.contextStartSequence,
      idempotencyKey: input.idempotencyKey,
      parentMessageId: input.parentMessageId,
      participantId: input.participantId,
      principal: { actorId: session.principal.userId },
      retrievalQuery: input.retrievalQuery,
      scope,
      snapshotRevision: input.snapshotRevision,
      threadId: input.threadId,
    });
    const readRequest = rpcRequest("readResponse", readInput);
    const client = createRouterClient(appRouter, {
      context: createApiContext(readRequest, h.dependencies),
    });
    const output = await client.vertex.researchChat.readResponse(readInput);
    expect(output).toEqual(h.observation);
    expect(Object.isFrozen(output)).toBe(true);
    expect(Object.isFrozen(output.receipt.reasonCodes)).toBe(true);
    expect(h.readResponse).toHaveBeenCalledExactlyOnceWith(
      { actorId: session.principal.userId },
      scope,
      input.threadId,
      input.idempotencyKey
    );
    return expect(h.forbidden).not.toHaveBeenCalled();
  });

  it("uses the same exact services for documented POST and GET without a structural-only runtime validator", async () => {
    const h = await fixture();
    const { threadId, ...body } = input;
    const request = new Request(
      `https://darkfactory.localhost/api/openapi/vertex/research-chat/threads/${threadId}/responses`,
      {
        body: JSON.stringify(body),
        headers: {
          "content-type": "application/json",
          origin: "https://darkfactory.localhost",
        },
        method: "POST",
      }
    );
    const response = await handleOpenApiRequest(
      request,
      createApiContext(request, h.dependencies)
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(h.receipt);
    const query = new URLSearchParams({
      accountAlias: scope.accountAlias,
      environment: scope.environment,
      idempotencyKey: input.idempotencyKey,
    });
    const readRequest = new Request(
      `https://darkfactory.localhost/api/openapi/vertex/research-chat/threads/${threadId}/responses?${query}`
    );
    const readResponse = await handleOpenApiRequest(
      readRequest,
      createApiContext(readRequest, h.dependencies)
    );
    expect(readResponse.status).toBe(200);
    expect(await readResponse.json()).toEqual(h.observation);
    expect(h.readResponse).toHaveBeenCalledExactlyOnceWith(
      { actorId: session.principal.userId },
      scope,
      threadId,
      input.idempotencyKey
    );
    const invalid = new Request(request.url, {
      body: JSON.stringify({ ...body, snapshotRevision: "18" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(
      (
        await handleOpenApiRequest(
          invalid,
          createApiContext(invalid, h.dependencies)
        )
      ).status
    ).toBe(400);
    expect(h.requestResponse).toHaveBeenCalledTimes(1);
    return expect(h.forbidden).not.toHaveBeenCalled();
  });

  it("redacts store errors and rejects cross-owner source output at the root boundary", async () => {
    const h = await fixture();
    for (const [error, code, status] of [
      [new VertexStoreError("conflict"), "CONFLICT", 409],
      [new VertexStoreError("denied"), "FORBIDDEN", 403],
      [new Error("private response details"), "SERVICE_UNAVAILABLE", 503],
    ] as const) {
      h.requestResponse.mockRejectedValue(error);
      const request = rpcRequest("requestResponse", input);
      const response = await handleApiRequest(
        request,
        createApiContext(request, h.dependencies)
      );
      expect(response.status).toBe(status);
      const text = await response.text();
      expect(JSON.parse(text)).toMatchObject({ json: { code } });
      expect(text).not.toContain("private response details");
      // An exception the service did not classify proves no cause: none is sent.
      expect(text).not.toContain("reason");
    }
    // A typed 503 cause reaches the wire; chat still sends its own message.
    h.requestResponse.mockRejectedValue(
      new VertexExperienceServiceError("SERVICE_UNAVAILABLE", "not-configured")
    );
    const typedRequest = rpcRequest("requestResponse", input);
    const typed = await handleApiRequest(
      typedRequest,
      createApiContext(typedRequest, h.dependencies)
    );
    expect(typed.status).toBe(503);
    expect(await typed.json()).toMatchObject({
      json: {
        code: "SERVICE_UNAVAILABLE",
        data: { reason: "not-configured" },
        message: "Vertex research chat service unavailable",
      },
    });
    h.requestResponse.mockResolvedValue({
      ...h.receipt,
      ownerActorId: "other",
    });
    const request = rpcRequest("requestResponse", input);
    expect(
      (
        await handleApiRequest(
          request,
          createApiContext(request, h.dependencies)
        )
      ).status
    ).toBe(502);
    h.readResponse.mockResolvedValue(null);
    const readRequest = rpcRequest("readResponse", readInput);
    const absent = await handleApiRequest(
      readRequest,
      createApiContext(readRequest, h.dependencies)
    );
    expect(absent.status).toBe(404);
    expect(await absent.json()).toMatchObject({ json: { code: "NOT_FOUND" } });
    expect(h.requestResponse).toHaveBeenCalledTimes(5);
    return expect(h.forbidden).not.toHaveBeenCalled();
  });

  it("documents required exact request fields and original-key-only GET selectors", async () => {
    const document = await buildOpenApiDocument();
    const endpoint =
      document.paths?.["/vertex/research-chat/threads/{threadId}/responses"];
    expect(endpoint?.post?.operationId).toBe(
      "vertex.researchChat.requestResponse"
    );
    expect(endpoint?.get?.operationId).toBe("vertex.researchChat.readResponse");
    expect(endpoint?.post?.requestBody).toMatchObject({ required: true });
    const properties = exactObject(jsonSchema(endpoint?.post?.requestBody), [
      "accountAlias",
      "environment",
      "parentMessageId",
      "participantId",
      "snapshotRevision",
      "contextStartSequence",
      "retrievalQuery",
      "idempotencyKey",
    ]);
    expect(properties["retrievalQuery"]).toMatchObject({
      maxLength: 2000,
      minLength: 10,
      type: "string",
    });
    expect(properties["environment"]).toMatchObject({ const: "research" });
    expect(endpoint?.post?.parameters).toEqual([
      expect.objectContaining({ in: "path", name: "threadId", required: true }),
    ]);
    const parameters = endpoint?.get?.parameters ?? [];
    expect(parameters).toHaveLength(4);
    for (const name of [
      "accountAlias",
      "environment",
      "threadId",
      "idempotencyKey",
    ]) {
      expect(parameters).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            in: name === "threadId" ? "path" : "query",
            name,
            required: true,
          }),
        ])
      );
    }
    expect(endpoint?.get?.requestBody).toBeUndefined();
    return expect(endpoint?.get?.description).toContain(
      "absence at read time only"
    );
  });

  it("documents required no-extra-field receipts and observations rather than unconstrained transform schemas", async () => {
    const document = await buildOpenApiDocument();
    const endpoint =
      document.paths?.["/vertex/research-chat/threads/{threadId}/responses"];
    checkReceiptDocumentation(jsonSchema(endpoint?.post?.responses?.["200"]));
    const properties = exactObject(
      jsonSchema(endpoint?.get?.responses?.["200"]),
      [
        "schemaVersion",
        "executionAuthorized",
        "checkedAt",
        "receipt",
        "job",
        "delivery",
      ]
    );
    expect(properties["executionAuthorized"]).toMatchObject({ const: false });
    expect(properties["checkedAt"]).toMatchObject({ type: "string" });
    checkReceiptDocumentation(properties["receipt"]);
    const deliveries = object(properties["delivery"])["anyOf"];
    expect(Array.isArray(deliveries)).toBe(true);
    if (!Array.isArray(deliveries))
      throw new TypeError("Expected delivery variants");
    // not-applicable, pending, eligible, unavailable and appended.
    expect(deliveries).toHaveLength(5);
    for (const delivery of deliveries) {
      const status = object(object(object(delivery)["properties"])["status"])[
        "const"
      ];
      const fields =
        status === "unavailable"
          ? ["status", "reasonCodes"]
          : status === "appended"
            ? ["status", "message"]
            : ["status"];
      const deliveryProperties = exactObject(delivery, fields);
      if (status === "appended")
        exactObject(deliveryProperties["message"], [
          "messageId",
          "sequence",
          "threadRevision",
        ]);
    }

    for (const method of ["post", "get"] as const) {
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
