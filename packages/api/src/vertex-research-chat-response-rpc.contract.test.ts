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
  vertexResearchChatResponseContract,
  VertexResearchChatRequestResponseRpcInputSchema,
  VertexResearchChatReadResponseRpcInputSchema,
} from "./contracts/vertex-research-chat-response-rpc.ts";
import {
  VertexResearchChatRequestResponseInputSchema,
  VertexResearchChatReadResponseInputSchema,
  VertexResearchChatResponseReceiptSchema,
  VertexResearchChatRequestResponseOutputSchema,
  VertexResearchChatReadResponseOutputSchema,
  type VertexResearchChatRequestResponseInput,
  type VertexResearchChatReadResponseInput,
} from "./contracts/vertex-research-chat-response.ts";
import {
  createApiContext,
  type ApiContextDependencies,
} from "./server/context.ts";
import { handleApiRequest, handleOpenApiRequest } from "./server/handler.ts";
import { appRouter } from "./server/router.ts";
import type { VertexExperienceDependencies } from "./server/vertex-experience-core.ts";

// Synthetic sessions/ports only. No database, model, worker or network execution.
const now = "2026-09-24T00:00:00Z";
const scope = {
  accountAlias: "fixture-research",
  environment: "research" as const,
};
const input = {
  ...scope,
  threadId: "thread-a",
  parentMessageId: "message-a",
  participantId: "first-mate",
  snapshotRevision: "2",
  contextStartSequence: "1",
  retrievalQuery: "  Literal research question  ",
  idempotencyKey: "original-response-key",
};
const readInput = {
  ...scope,
  threadId: input.threadId,
  idempotencyKey: input.idempotencyKey,
};
const base = { schemaVersion: "1.0.0", executionAuthorized: false } as const;
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
const hash = (value: unknown) => hashArtifact(canonicalArtifactJson(value));
const fixture = async () => {
  const { retrievalQuery: _retrievalQuery, ...metadata } = input;
  const receipt = {
    ...base,
    ...metadata,
    ownerActorId: session.principal.userId,
    responseRequestId: `response-${await hash({ operation: "requestResponse", actorId: session.principal.userId, scope, threadId: input.threadId, idempotencyKey: input.idempotencyKey })}`,
    requestSha256: await hash({
      operation: "requestResponse",
      actorId: session.principal.userId,
      input,
    }),
    recordedAt: now,
    status: "unavailable",
    reasonCodes: ["research-runtime-unavailable"],
    jobId: null,
    admission: null,
  };
  const observation = {
    ...base,
    checkedAt: now,
    receipt,
    job: null,
    delivery: { status: "not-applicable" },
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
    store: {
      requestResearchChatResponse: requestResponse,
      readResearchChatResponse: readResponse,
      readResearchChatThread: forbidden,
      listResearchChatMessages: forbidden,
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
    requestId: "response-contract-fixture",
    requireSession,
    requireRole: forbidden,
    vertexExperience,
  };
  return {
    receipt,
    observation,
    requestResponse,
    readResponse,
    forbidden,
    authorize,
    requireSession,
    dependencies,
  };
};
const rpcRequest = (
  method: "requestResponse" | "readResponse",
  value: unknown
): Request =>
  new Request(
    `https://darkfactory.localhost/api/orpc/vertex/researchChat/${method}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://darkfactory.localhost",
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
        operationId: `vertex.researchChat.${name}`,
        method,
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
      principal: { actorId: session.principal.userId },
      scope,
      threadId: input.threadId,
      parentMessageId: input.parentMessageId,
      participantId: input.participantId,
      snapshotRevision: input.snapshotRevision,
      contextStartSequence: input.contextStartSequence,
      retrievalQuery: input.retrievalQuery,
      idempotencyKey: input.idempotencyKey,
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
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, snapshotRevision: "18" }),
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
    }
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
    expect(h.requestResponse).toHaveBeenCalledTimes(4);
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
      type: "string",
      minLength: 10,
      maxLength: 2000,
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
            name,
            required: true,
            in: name === "threadId" ? "path" : "query",
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
