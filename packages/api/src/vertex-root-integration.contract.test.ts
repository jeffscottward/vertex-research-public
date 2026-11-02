import type { InferSchemaInput, InferSchemaOutput } from "@orpc/contract";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import { build } from "vite";
import { appContract } from "./contract.ts";
import { ProjectionContinuitySchema } from "./contracts/vertex-control.ts";
import { vertexExperienceContract } from "./contracts/vertex-experience.ts";
import { RuntimePolicySelectionSchema } from "./contracts/vertex-policy.ts";
import { VertexResearchChatReadResponseContentOutputSchema } from "./contracts/vertex-research-chat-conversation.ts";
import { VertexResearchChatRequestResponseRpcInputSchema } from "./contracts/vertex-research-chat-response-rpc.ts";
import {
  VERTEX_READ_ERRORS,
  VertexModulesListOutputSchema,
  vertexReadContract,
} from "./contracts/vertex-read.ts";
import {
  VertexScopedModulesInputSchema,
  vertexChartReadContract,
} from "./contracts/vertex-chart-read.ts";
import {
  VertexNotificationDeliveryInputSchema,
  VertexNotificationDeliveryOutputSchema,
  vertexNotificationReadContract,
} from "./contracts/vertex-notification-read.ts";
import * as worker from "./contracts/vertex-worker.ts";
import { MAX_NATIVE_OUTBOX_REPLAY_WIRE_BYTES } from "./contracts/vertex-worker-epoch.ts";
import {
  VERTEX_WORKER_METHOD_DEFINITIONS,
  VERTEX_WORKER_METHODS,
  VERTEX_WORKER_PATHS,
  VERTEX_WORKER_OPENAPI_PATHS,
  VERTEX_WORKER_READONLY_OUTPUTS,
  VERTEX_WORKER_SERVICE_ERRORS,
  isVertexWorkerPath,
  isVertexWorkerRequestPath,
  VERTEX_WORKER_REQUEST_MAX_BYTES,
  VERTEX_WORKER_REPLAY_REQUEST_MAX_BYTES,
  VERTEX_WORKER_RESPONSE_MAX_BYTES,
  vertexWorkerRequestMaxBytes,
  vertexWorkerContract,
  type VertexWorkerOutput,
} from "./contracts/vertex-worker-rpc.ts";
import { buildOpenApiDocument } from "./openapi.ts";

// Enumerated independently: deriving expectations from the production list would
// silently bless an accidental broker/recovery/grant-administration procedure.
const workerSchemas = {
  claim: [worker.WorkerClaimInputSchema, worker.WorkerClaimOutputSchema],
  renew: [worker.WorkerRenewInputSchema, worker.WorkerResultSchema],
  complete: [worker.WorkerCompleteInputSchema, worker.WorkerResultSchema],
  cancel: [worker.WorkerCancelInputSchema, worker.WorkerResultSchema],
  status: [worker.WorkerStatusInputSchema, worker.WorkerResultSchema],
  admitRun: [worker.WorkerAdmitRunInputSchema, worker.WorkerResultSchema],
  readArtifact: [
    worker.WorkerReadArtifactInputSchema,
    worker.WorkerReadArtifactOutputSchema,
  ],
  readExperiment: [
    worker.WorkerReadExperimentInputSchema,
    worker.WorkerReadExperimentOutputSchema,
  ],
  readBacktestRun: [
    worker.WorkerReadBacktestRunInputSchema,
    worker.WorkerReadBacktestRunOutputSchema,
  ],
  readDataset: [
    worker.WorkerReadDatasetInputSchema,
    worker.WorkerReadDatasetOutputSchema,
  ],
  stageArtifact: [
    worker.WorkerStageArtifactInputSchema,
    worker.WorkerStageArtifactOutputSchema,
  ],
  publishArtifact: [
    worker.WorkerPublishArtifactInputSchema,
    worker.WorkerResultSchema,
  ],
  publishAgent: [
    worker.WorkerPublishAgentInputSchema,
    worker.WorkerResultSchema,
  ],
  publishExperiment: [
    worker.WorkerPublishExperimentInputSchema,
    worker.WorkerPublishExperimentOutputSchema,
  ],
  publishCollection: [
    worker.WorkerPublishCollectionInputSchema,
    worker.WorkerCollectionOutputSchema,
  ],
  activateCollection: [
    worker.WorkerActivateCollectionInputSchema,
    worker.WorkerCollectionOutputSchema,
  ],
  readCollection: [
    worker.WorkerReadCollectionInputSchema,
    worker.WorkerCollectionOutputSchema,
  ],
  currentRights: [
    worker.WorkerCurrentRightsInputSchema,
    worker.WorkerCurrentRightsOutputSchema,
  ],
  acceptedEvidence: [
    worker.WorkerAcceptedEvidenceInputSchema,
    worker.WorkerAcceptedEvidenceOutputSchema,
  ],
  currentRightsObservation: [
    worker.WorkerCurrentRightsObservationInputSchema,
    worker.WorkerCurrentRightsObservationOutputSchema,
  ],
  acceptedEvidenceObservation: [
    worker.WorkerAcceptedEvidenceObservationInputSchema,
    worker.WorkerAcceptedEvidenceObservationOutputSchema,
  ],
  publishGenesis: [
    worker.WorkerPublishGenesisInputSchema,
    worker.WorkerProjectionAckSchema,
  ],
  publishOrderProjection: [
    worker.WorkerPublishOrderProjectionInputSchema,
    worker.WorkerProjectionAckSchema,
  ],
  publishNativeFacts: [
    worker.WorkerPublishNativeFactsInputSchema,
    worker.WorkerProjectionAckSchema,
  ],
  readContinuity: [
    worker.WorkerReadContinuityInputSchema,
    ProjectionContinuitySchema,
  ],
  readiness: [worker.WorkerReadinessInputSchema, worker.WorkerResultSchema],
  policySelection: [
    worker.WorkerPolicySelectionInputSchema,
    RuntimePolicySelectionSchema,
  ],
  currentPaperAdmission: [
    worker.WorkerCurrentPaperAdmissionInputSchema,
    worker.WorkerCurrentPaperAdmissionOutputSchema,
  ],
  publishPortfolioSnapshot: [
    worker.WorkerPublishPortfolioSnapshotInputSchema,
    worker.WorkerProjectionAckSchema,
  ],
  currentModelUse: [
    worker.WorkerCurrentModelUseInputSchema,
    worker.WorkerCurrentModelUseOutputSchema,
  ],
  prepareModelPrivacyReview: [
    worker.WorkerPrepareModelPrivacyReviewInputSchema,
    worker.WorkerModelPrivacyReviewOutputSchema,
  ],
  readModelPrivacyReview: [
    worker.WorkerReadModelPrivacyReviewInputSchema,
    worker.WorkerModelPrivacyReviewOutputSchema,
  ],
  // Research-only native phase two: consumes an already-returned completion
  // and its non-dispatching proof; the output pins executionAuthorized: false.
  prepareNativeEvidencePhaseTwo: [
    worker.WorkerPrepareNativeEvidencePhaseTwoInputSchema,
    worker.WorkerPrepareNativeEvidencePhaseTwoOutputSchema,
  ],
  publishEpochTransition: [
    worker.WorkerPublishEpochTransitionInputSchema,
    worker.WorkerProjectionAckSchema,
  ],
  replayNativeOutbox: [
    worker.WorkerReplayNativeOutboxInputSchema,
    worker.WorkerProjectionAckSchema,
  ],
} as const;
const workerMethods = Object.keys(
  workerSchemas
) as (keyof typeof workerSchemas)[];
const scopedRoutes = [
  {
    method: "modules",
    path: "/vertex/scoped/modules",
    input: VertexScopedModulesInputSchema,
    output: VertexModulesListOutputSchema,
  },
] as const;

describe("root Vertex worker and scoped browser contract integration", () => {
  it("mounts the canonical worker operation set without cloning or widening runtime validators", () => {
    const operations = new Set(worker.WorkerOperationSchema.options);
    expect(new Set(workerMethods)).toEqual(operations);
    expect(new Set(VERTEX_WORKER_METHODS)).toEqual(operations);
    expect(new Set(Object.keys(VERTEX_WORKER_METHOD_DEFINITIONS))).toEqual(
      operations
    );
    expect(new Set(Object.keys(appContract.vertexWorker))).toEqual(operations);
    expect(appContract.vertexWorker).toBe(vertexWorkerContract);
    for (const method of workerMethods) {
      const [input, output] = workerSchemas[method];
      const procedure = appContract.vertexWorker[method]["~orpc"];
      expect(VERTEX_WORKER_METHOD_DEFINITIONS[method].input).toBe(input);
      expect(VERTEX_WORKER_METHOD_DEFINITIONS[method].output).toBe(output);
      expect(procedure.inputSchema).toBe(input);
      expect(procedure.outputSchema).toBe(output);
      expect(procedure.route).toMatchObject({
        method: "POST",
        path: `/vertex-worker/${method}`,
        operationId: `vertexWorker.${method}`,
      });
    }
    return expect(new Set(VERTEX_WORKER_READONLY_OUTPUTS)).toEqual(
      new Set(Object.values(workerSchemas).map((schemas) => schemas[1]))
    );
  });

  it("pins both native RPC and documented OpenAPI paths without prefix exemptions", () => {
    expect(new Set(VERTEX_WORKER_PATHS)).toEqual(
      new Set(workerMethods.map((method) => `/api/orpc/vertexWorker/${method}`))
    );
    expect(new Set(VERTEX_WORKER_OPENAPI_PATHS)).toEqual(
      new Set(
        workerMethods.map((method) => `/api/openapi/vertex-worker/${method}`)
      )
    );
    for (const path of VERTEX_WORKER_PATHS) {
      expect(isVertexWorkerPath(path)).toBe(true);
      expect(isVertexWorkerRequestPath(path)).toBe(true);
    }
    for (const path of VERTEX_WORKER_OPENAPI_PATHS) {
      expect(isVertexWorkerPath(path)).toBe(false);
      expect(isVertexWorkerRequestPath(path)).toBe(true);
    }

    for (const path of [
      "/api/orpc/vertexWorker",
      "/api/orpc/vertexWorker/status/",
      "/api/orpc/vertexWorker/status/extra",
      "/api/orpc/vertexWorker/%73tatus",
      "/api/orpc/vertexWorker/Status",
      "/api/orpc/vertexWorker/status?x=1",
      "/api/orpc/vertexWorker/issueGrant",
      "/api/orpc/vertexWorker/revokeGrant",
      "/api/orpc/vertexWorker/recover",
      "/api/orpc/vertexWorker/submitOrder",
      "/api/orpc/vertexWorker/__proto__",
      "/api/orpc/vertex/scoped/snapshot",
      "/api/openapi/vertex-worker",
      "/api/openapi/vertex-worker/status/",
      "/api/openapi/vertex-worker/status/extra",
      "/api/openapi/vertex-worker/%73tatus",
      "/api/openapi/vertex-worker/issueGrant",
      "/api/openapi/vertex-worker/recover",
      "/prefix/api/openapi/vertex-worker/status",
      "/api/openapi/vertex-worker/status?x=1",
      "/prefix/api/orpc/vertexWorker/status",
      "/api/openapi/vertex-worker/submitOrder",
    ]) {
      expect(isVertexWorkerPath(path)).toBe(false);
      expect(isVertexWorkerRequestPath(path)).toBe(false);
    }
  });

  it("grants the larger replay wire ceiling only to its two exact registered paths", () => {
    expect(MAX_NATIVE_OUTBOX_REPLAY_WIRE_BYTES).toBe(12_582_912);
    expect(VERTEX_WORKER_REPLAY_REQUEST_MAX_BYTES).toBe(
      MAX_NATIVE_OUTBOX_REPLAY_WIRE_BYTES
    );
    expect(VERTEX_WORKER_REQUEST_MAX_BYTES).toBe(2_097_152);
    expect(VERTEX_WORKER_RESPONSE_MAX_BYTES).toBe(2_097_152);
    for (const path of [
      ...VERTEX_WORKER_PATHS,
      ...VERTEX_WORKER_OPENAPI_PATHS,
    ]) {
      const replay =
        path === "/api/orpc/vertexWorker/replayNativeOutbox" ||
        path === "/api/openapi/vertex-worker/replayNativeOutbox";
      expect(vertexWorkerRequestMaxBytes(path)).toBe(
        replay
          ? VERTEX_WORKER_REPLAY_REQUEST_MAX_BYTES
          : VERTEX_WORKER_REQUEST_MAX_BYTES
      );
    }

    for (const prefix of [
      "/api/orpc/vertexWorker",
      "/api/openapi/vertex-worker",
    ]) {
      for (const path of [
        prefix,
        `${prefix}/unknown`,
        `${prefix}/replayNativeOutbox/`,
        `${prefix}/replayNativeOutbox/extra`,
        `${prefix}/replayNativeOutbox-extra`,
        `${prefix}/ReplayNativeOutbox`,
        `${prefix}/replaynativeoutbox`,
        `${prefix}/%72eplayNativeOutbox`,
        `${prefix}/replayNativeOutbox%2F`,
        `${prefix}/replayNativeOutbox?x=1`,
        `${prefix}/replayNativeOutbox#fragment`,
        `/prefix${prefix}/replayNativeOutbox`,
        `${prefix}/replayNativeOutbox/../status`,
      ]) {
        expect(isVertexWorkerRequestPath(path)).toBe(false);
        expect(vertexWorkerRequestMaxBytes(path)).toBeUndefined();
      }
    }
  });

  it("adds only the scoped modules browser read and preserves every remaining Vertex namespace", () => {
    expect(Object.keys(appContract.vertex)).toEqual(
      expect.arrayContaining(["experience", "modules", "scoped"])
    );
    expect(Object.keys(appContract.vertex)).not.toContain("datasets");
    expect(Object.keys(appContract.vertex)).not.toContain("evidence");
    expect(appContract.vertex.modules).toBe(vertexReadContract.modules);
    expect(appContract.vertex.experience).toBe(vertexExperienceContract);
    expect(appContract.vertex.scoped).toBe(vertexChartReadContract);
    expect(Object.keys(appContract.vertex.scoped)).toEqual(["modules"]);
    expect(Object.keys(appContract.vertex.experience)).toEqual([
      "scopes",
      "gateways",
      "portfolio",
      "continuity",
      "inbox",
      "strategies",
      "dossier",
      "agents",
      "agent",
      "audit",
      "gateway",
      "decideReview",
      "proposeResearch",
      "proposeSimulation",
    ]);
    expect(appContract.vertex.modules.list["~orpc"].route.path).toBe(
      "/vertex/modules"
    );
    expect(appContract.dashboard.summary).toBeDefined();
    expect(appContract.featureItems.create).toBeDefined();
    return expect(appContract.account.profile.get).toBeDefined();
  });

  it.each(scopedRoutes)(
    "shares exact scoped $method validators and a read-only OpenAPI route",
    ({ method, path, input, output }) => {
      const procedure = appContract.vertex.scoped[method]["~orpc"];
      expect(procedure.inputSchema).toBe(input);
      expect(procedure.outputSchema).toBe(output);
      return expect(procedure.route).toMatchObject({
        method: "GET",
        path,
        operationId: `vertex.scoped.${method}`,
      });
    }
  );

  it("keeps readonly handler results assignable without permitting partial outputs", () => {
    type StatusSchema = NonNullable<
      (typeof appContract.vertexWorker.status)["~orpc"]["outputSchema"]
    >;
    expectTypeOf<VertexWorkerOutput<"status">>().toExtend<
      InferSchemaInput<StatusSchema>
    >();
    expectTypeOf<
      InferSchemaOutput<StatusSchema>
    >().toEqualTypeOf<worker.WorkerResult>();
    return expectTypeOf<{ jobId: string }>().not.toExtend<
      InferSchemaInput<StatusSchema>
    >();
  });

  it("retains the exact worker error statuses and secret-safe messages", () =>
    expect(VERTEX_WORKER_SERVICE_ERRORS).toEqual({
      BAD_REQUEST: { status: 400, message: "Invalid worker request" },
      UNAUTHORIZED: { status: 401, message: "Worker authentication required" },
      FORBIDDEN: { status: 403, message: "Worker operation denied" },
      CONFLICT: { status: 409, message: "Worker identity or lease conflict" },
      PAYLOAD_TOO_LARGE: {
        status: 413,
        message: "Worker payload exceeds limit",
      },
      SERVICE_UNAVAILABLE: {
        status: 503,
        message: "Worker service unavailable",
      },
      INVALID_SOURCE: {
        status: 502,
        message: "Invalid worker service response",
      },
    }));

  it("publishes only canonical worker POST routes and the scoped modules GET route", async () => {
    const document = await buildOpenApiDocument();
    const paths = Object.keys(document.paths ?? {});
    expect(
      paths.filter((path) => path.startsWith("/vertex-worker/")).sort()
    ).toEqual(workerMethods.map((method) => `/vertex-worker/${method}`).sort());
    expect(
      paths.filter((path) => path.startsWith("/vertex/scoped/")).sort()
    ).toEqual(scopedRoutes.map((entry) => entry.path).sort());
    for (const method of workerMethods) {
      const item = document.paths?.[`/vertex-worker/${method}`];
      expect(item?.post?.operationId).toBe(`vertexWorker.${method}`);
      expect(Object.keys(item?.post?.responses ?? {})).toEqual(
        expect.arrayContaining([
          "200",
          "400",
          "401",
          "403",
          "409",
          "413",
          "502",
          "503",
        ])
      );
      for (const verb of ["get", "put", "patch", "delete"] as const) {
        expect(item?.[verb]).toBeUndefined();
      }
    }

    for (const { method, path } of scopedRoutes) {
      const item = document.paths?.[path];
      expect(item?.get?.operationId).toBe(`vertex.scoped.${method}`);
      expect(Object.keys(item?.get?.responses ?? {})).toEqual(
        expect.arrayContaining([
          "200",
          "400",
          "401",
          "403",
          "404",
          "502",
          "503",
        ])
      );

      for (const verb of ["post", "put", "patch", "delete"] as const) {
        expect(item?.[verb]).toBeUndefined();
      }
    }
  });

  it("preserves required output fields for exact readonly worker schemas in OpenAPI", async () => {
    const document = await buildOpenApiDocument();
    return expect(
      document.paths?.["/vertex-worker/status"]?.post?.responses?.["200"]
    ).toMatchObject({
      content: {
        "application/json": {
          schema: {
            type: "object",
            additionalProperties: false,
            required: expect.arrayContaining([
              "status",
              "jobId",
              "state",
              "lease",
              "outputArtifactIds",
              "reason",
            ]),
            properties: {
              jobId: { type: "string" },
              outputArtifactIds: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    });
  });

  it("fails closed when a registered response documentation schema cannot be resolved", async () => {
    const originalGet = Map.prototype.get;
    // Only the documentation map holds both exact chat RPC/output identities.
    const get = vi.spyOn(Map.prototype, "get").mockImplementation(function (
      this: Map<unknown, unknown>,
      key
    ) {
      if (
        this.has(VertexResearchChatRequestResponseRpcInputSchema) &&
        this.has(VertexResearchChatReadResponseContentOutputSchema)
      )
        return;
      return originalGet.call(this, key);
    });
    try {
      await expect(buildOpenApiDocument()).rejects.toThrow(
        "Missing OpenAPI documentation schema"
      );
    } finally {
      get.mockRestore();
    }
    return expect((await buildOpenApiDocument()).paths).toBeDefined();
  });

  it("keeps the worker metadata wrapper a pure contract module", async () => {
    const source = await readFile(
      new URL("./contracts/vertex-worker-rpc.ts", import.meta.url),
      "utf8"
    );
    const imports = [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map(
      (match) => match[1]
    );
    expect(imports).toEqual([
      "@orpc/contract",
      "zod",
      "./vertex-control.ts",
      "./vertex-policy.ts",
      "./vertex-worker-epoch.ts",
      "./vertex-worker.ts",
    ]);
    expect(source).not.toMatch(/\b(?:import\s*\(|require\s*\()/);
    return expect(source).not.toMatch(
      /from\s+["'][^"']*(?:\/server|@darkfactory\/db|@darkfactory\/jobs)/
    );
  });

  // Authored for the final verification phase; this does not run an alternate
  // server/client and writes no build output when the regression is executed.
  it("keeps the root contract browser bundle free of API server and database modules", async () => {
    const modules: string[] = [];
    const result = await build({
      configFile: false,
      logLevel: "silent",
      plugins: [
        {
          name: "capture-root-contract-boundary",
          generateBundle() {
            modules.push(...this.getModuleIds());
            return;
          },
        },
      ],
      resolve: { conditions: ["browser"] },
      build: {
        target: "esnext",
        write: false,
        minify: false,
        lib: {
          entry: fileURLToPath(new URL("./contract.ts", import.meta.url)),
          formats: ["es"],
          fileName: "root-contract",
        },
      },
    });
    const builds = Array.isArray(result) ? result : [result];
    const chunks = builds.flatMap((entry) => {
      if (!("output" in entry))
        throw new Error("Expected completed in-memory contract bundle");
      return entry.output.filter((output) => output.type === "chunk");
    });
    expect(
      modules.some((id) =>
        /\/contracts\/vertex-worker-rpc\.ts(?:\?.*)?$/.test(id)
      )
    ).toBe(true);
    expect(
      modules.some((id) =>
        /\/contracts\/vertex-chart-read\.ts(?:\?.*)?$/.test(id)
      )
    ).toBe(true);
    expect(
      modules.some((id) =>
        /\/contracts\/vertex-notification-read\.ts(?:\?.*)?$/.test(id)
      )
    ).toBe(true);
    expect(
      modules.filter((id) =>
        /\/packages\/(?:db|jobs)\/|\/packages\/api\/src\/server\/|@darkfactory\/(?:db|jobs)(?:\/|$)/.test(
          id
        )
      )
    ).toEqual([]);
    expect(chunks.map((chunk) => chunk.code).join("\n")).not.toContain(
      "createVertexWorkerService"
    );
    expect(chunks.map((chunk) => chunk.code).join("\n")).not.toContain(
      "createVertexChartReadService"
    );
    expect(chunks.map((chunk) => chunk.code).join("\n")).not.toContain(
      "createVertexNotificationReadService"
    );
    expect(chunks.map((chunk) => chunk.code).join("\n")).not.toContain(
      "createVertexResearchChatCopyCleanupService"
    );
    return expect(chunks.map((chunk) => chunk.code).join("\n")).not.toContain(
      "createVertexWorkerCredentials"
    );
  });
});

describe("root notification historical-delivery contract", () => {
  it("adds only the delivery GET and shares authoritative schemas and read errors", async () => {
    expect(appContract.vertex.notifications).toBe(
      vertexNotificationReadContract
    );
    expect(Object.keys(appContract.vertex.notifications)).toEqual(["delivery"]);
    const procedure = appContract.vertex.notifications.delivery["~orpc"];
    expect(procedure.inputSchema).toBe(VertexNotificationDeliveryInputSchema);
    expect(procedure.outputSchema).toBe(VertexNotificationDeliveryOutputSchema);
    expect(procedure.errorMap).toEqual(VERTEX_READ_ERRORS);
    expect(procedure.route).toMatchObject({
      method: "GET",
      path: "/vertex/notifications/delivery",
      operationId: "vertex.notifications.delivery",
    });
    const document = await buildOpenApiDocument();
    const item = document.paths?.["/vertex/notifications/delivery"];
    expect(item?.get?.operationId).toBe("vertex.notifications.delivery");
    expect(Object.keys(item?.get?.responses ?? {})).toEqual(
      expect.arrayContaining(["200", "400", "401", "403", "404", "502", "503"])
    );

    for (const verb of ["post", "put", "patch", "delete"] as const) {
      expect(item?.[verb]).toBeUndefined();
    }
  });

  it("accepts only scoped grant/version/event lookup and never recipients or send bodies", () => {
    const input = {
      accountAlias: "fixture-paper",
      environment: "paper",
      grantId: "grant-1",
      version: "1",
      eventId: "event-1",
    };
    expect(VertexNotificationDeliveryInputSchema.parse(input)).toEqual(input);
    for (const extra of [
      { target: "fixture-recipient" },
      { body: "do not send" },
      { principal: { userId: "admin" } },
      { retry: true },
      { channel: "email" },
    ]) {
      expect(
        VertexNotificationDeliveryInputSchema.safeParse({ ...input, ...extra })
          .success
      ).toBe(false);
    }
    for (const version of ["0", "01", "-1", "1.0", 1, null]) {
      expect(
        VertexNotificationDeliveryInputSchema.safeParse({ ...input, version })
          .success
      ).toBe(false);
    }
    return expect(
      VertexNotificationDeliveryInputSchema.safeParse({
        ...input,
        environment: "live",
      }).success
    ).toBe(false);
  });

  it("keeps epoch-millisecond history separate from confirmed receipt or retry authority", () => {
    const admittedAt = Date.parse("2026-09-22T12:00:00.000Z");
    const record = {
      status: "accepted",
      admittedAt,
      expiresAt: admittedAt + 60_000,
      outcomeAt: admittedAt + 1,
      receipt: "unconfirmed",
      retryable: false,
    };
    expect(VertexNotificationDeliveryOutputSchema.parse(record)).toEqual(
      record
    );
    expect(
      VertexNotificationDeliveryOutputSchema.parse({
        ...record,
        status: "pending",
        outcomeAt: null,
      })
    ).toMatchObject({ status: "pending", outcomeAt: null });
    expect(
      VertexNotificationDeliveryOutputSchema.parse({
        status: "not-found",
        receipt: "unconfirmed",
        retryable: false,
      })
    ).toEqual({
      status: "not-found",
      receipt: "unconfirmed",
      retryable: false,
    });

    for (const invalid of [
      { ...record, admittedAt: "2026-09-22T12:00:00.000Z" },
      { ...record, admittedAt: -0 },
      { ...record, admittedAt: admittedAt + 0.5 },
      { ...record, expiresAt: admittedAt },
      { ...record, expiresAt: admittedAt + 86_400_001 },
      { ...record, outcomeAt: null },
      { ...record, receipt: "confirmed" },
      { ...record, retryable: true },
      { ...record, target: "private-recipient" },
    ]) {
      expect(
        VertexNotificationDeliveryOutputSchema.safeParse(invalid).success
      ).toBe(false);
    }
  });
});
