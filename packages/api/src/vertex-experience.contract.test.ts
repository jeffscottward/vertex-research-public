import { readFile } from "node:fs/promises";
import type { InferSchemaInput, InferSchemaOutput } from "@orpc/contract";
import {
  canonicalArtifactJson,
  hashArtifact,
} from "@darkfactory/shared/vertex";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import { appContract, VertexModulesListOutputSchema } from "./contract.ts";
import { buildVertexContractDocument } from "./contracts/vertex.ts";
import {
  AcceptedReviewSchema,
  VertexContinuityGetInputSchema,
  VertexPortfolioGetInputSchema,
} from "./contracts/vertex-control.ts";
import {
  VERTEX_EXPERIENCE_READONLY_OUTPUTS,
  VertexAgentArtifactSchema,
  VertexAgentsPageSchema,
  VertexAuditPageSchema,
  VertexCursorSchema,
  VertexDossierSchema,
  VertexGatewayGetInputSchema,
  VertexInboxPageSchema,
  VertexPageInputSchema,
  VertexResearchProposalInputSchema,
  VertexReviewDecisionInputSchema,
  VertexScopedArtifactInputSchema,
  VertexScopesInputSchema,
  VertexGatewaysInputSchema,
  VertexSimulationProposalInputSchema,
  VertexSimulationQueueReceiptSchema,
  VertexStrategiesPageSchema,
  vertexExperienceContract,
} from "./contracts/vertex-experience.ts";
import { buildOpenApiDocument } from "./openapi.ts";
import type { VertexExperienceService } from "./server/vertex-experience-service.ts";

const scope = { accountAlias: "fixture-paper", environment: "paper" } as const;
const digest = "a".repeat(64);
const review = {
  ...scope,
  artifactId: "artifact-1",
  artifactSha256: digest,
  strategyVersion: "strategy-1",
  decision: "accepted",
  purpose: "research",
  expectedReviewId: null,
  idempotencyKey: "review-1",
} as const;
const research = {
  ...scope,
  question: "Compare these synthetic observations",
  collectionId: "collection-1",
  evidenceIds: ["evidence-1"],
  role: "research",
  idempotencyKey: "research-1",
  proposalOnly: true,
  executionAuthorized: false,
} as const;
const simulation = {
  ...scope,
  admissionId: "admission-1",
  reviewId: "review-1",
  reviewVersion: "1.0.0",
  intentId: "intent-1",
  intentSha256: digest,
  strategyVersion: "strategy-1",
  idempotencyKey: "simulation-1",
  simulationOnly: true,
  brokerSubmissionAllowed: false,
  liveAuthorization: false,
} as const;
const routes = [
  ["scopes", "GET", "scopes"],
  ["gateways", "GET", "gateways"],
  ["portfolio", "GET", "portfolio"],
  ["continuity", "GET", "continuity"],
  ["inbox", "GET", "inbox"],
  ["strategies", "GET", "strategies"],
  ["dossier", "GET", "dossier"],
  ["agents", "GET", "agents"],
  ["agent", "GET", "agent"],
  ["audit", "GET", "audit"],
  ["gateway", "GET", "gateway"],
  ["decideReview", "POST", "reviews"],
  ["proposeResearch", "POST", "research-proposals"],
  ["proposeSimulation", "POST", "paper-simulations"],
] as const;
const inputs = [
  [VertexScopesInputSchema, {}],
  [VertexGatewaysInputSchema, {}],
  [VertexPortfolioGetInputSchema, scope],
  [VertexContinuityGetInputSchema, { ...scope, streamId: "stream-1" }],
  [VertexPageInputSchema, scope],
  [VertexScopedArtifactInputSchema, { ...scope, artifactId: "artifact-1" }],
  [
    VertexGatewayGetInputSchema,
    { gatewayId: "gateway-1", environment: "paper" },
  ],
  [VertexReviewDecisionInputSchema, review],
  [VertexResearchProposalInputSchema, research],
  [VertexSimulationProposalInputSchema, simulation],
] as const;

describe("Vertex experience contracts", () => {
  it("adds only the flat experience surface without replacing legacy reads or account/email routes", () => {
    expect(appContract.vertex.experience).toBe(vertexExperienceContract);
    expect(Object.keys(appContract.vertex.experience).sort()).toEqual(
      routes.map(([name]) => name).sort()
    );
    expect(appContract.vertex.modules.list["~orpc"].outputSchema).toBe(
      VertexModulesListOutputSchema
    );
    expect(appContract.vertex.modules.list["~orpc"].route).toMatchObject({
      method: "GET",
      path: "/vertex/modules",
    });
    expect(appContract.account.profile.get).toBeDefined();
    expect(appContract.dashboard.summary).toBeDefined();
    expect(appContract.contact.submit).toBeDefined();
    for (const [name, method, suffix] of routes) {
      expect(appContract.vertex.experience[name]["~orpc"].route).toMatchObject({
        method,
        path: `/vertex/experience/${suffix}`,
        operationId: `vertex.experience.${name}`,
      });
    }
    return;
  });

  it("rejects client actor, policy, expiry and authority extras on every input", () => {
    for (const [schema, input] of inputs) {
      expect(schema.safeParse(input).success).toBe(true);
      for (const extra of [
        { actorId: "other" },
        { principal: { userId: "other", role: "admin" } },
        { policyVersion: "1.0.0" },
        { reviewPolicy: {} },
        { expiresAt: "2026-09-23T14:00:00Z" },
        { ownerId: "other" },
        { acceptedEvidenceArtifactId: "replacement" },
      ]) {
        expect(schema.safeParse({ ...input, ...extra }).success).toBe(false);
      }
    }
    return;
  });

  it("forbids live review/research and paper-simulation review outside paper", () => {
    expect(
      VertexReviewDecisionInputSchema.safeParse({
        ...review,
        environment: "live",
      }).success
    ).toBe(false);
    expect(
      VertexResearchProposalInputSchema.safeParse({
        ...research,
        environment: "live",
      }).success
    ).toBe(false);
    expect(
      VertexReviewDecisionInputSchema.safeParse({
        ...review,
        purpose: "paper-simulation",
      }).success
    ).toBe(true);
    expect(
      VertexReviewDecisionInputSchema.safeParse({
        ...review,
        purpose: "paper-simulation",
        environment: "research",
      }).success
    ).toBe(false);
    expect(
      VertexResearchProposalInputSchema.safeParse({
        ...research,
        proposalOnly: false,
      }).success
    ).toBe(false);
    expect(
      VertexResearchProposalInputSchema.safeParse({
        ...research,
        executionAuthorized: true,
      }).success
    ).toBe(false);
    expect(
      VertexResearchProposalInputSchema.safeParse({
        ...research,
        evidenceIds: ["same", "same"],
      }).success
    ).toBe(false);
    return expect(
      VertexResearchProposalInputSchema.safeParse({
        ...research,
        evidenceIds: Array.from(
          { length: 33 },
          (_, index) => `evidence-${index}`
        ),
      }).success
    ).toBe(false);
  });

  it("requires exact nonbroker simulation flags rather than coercing or defaulting them", () => {
    expect(VertexSimulationProposalInputSchema.parse(simulation)).toEqual(
      simulation
    );
    for (const field of [
      "simulationOnly",
      "brokerSubmissionAllowed",
      "liveAuthorization",
    ] as const) {
      const { [field]: omitted, ...missing } = simulation;
      expect(omitted).toBeDefined();
      expect(
        VertexSimulationProposalInputSchema.safeParse(missing).success
      ).toBe(false);
      for (const value of [!simulation[field], "false", 0, null]) {
        expect(
          VertexSimulationProposalInputSchema.safeParse({
            ...simulation,
            [field]: value,
          }).success
        ).toBe(false);
      }
    }
    for (const extra of [
      { environment: "live" },
      { environment: "research" },
      { executionAuthorized: true },
      { brokerAccount: "broker-1" },
      { submitToBroker: true },
    ]) {
      expect(
        VertexSimulationProposalInputSchema.safeParse({
          ...simulation,
          ...extra,
        }).success
      ).toBe(false);
    }
    return;
  });

  it("bounds pagination without accepting opaque authority or coercing limits", () => {
    expect(VertexPageInputSchema.parse(scope)).toEqual({
      ...scope,
      limit: 100,
      cursor: null,
    });
    for (const limit of [1, 100]) {
      expect(VertexPageInputSchema.safeParse({ ...scope, limit }).success).toBe(
        true
      );
    }
    for (const limit of [0, -1, 101, 1.5, "10", null]) {
      expect(VertexPageInputSchema.safeParse({ ...scope, limit }).success).toBe(
        false
      );
    }
    for (const cursor of [null, "a_-09", "a".repeat(4096)]) {
      expect(VertexCursorSchema.safeParse(cursor).success).toBe(true);
    }
    for (const cursor of [
      "",
      "a".repeat(4097),
      "../scope",
      "abc=",
      "x y",
      "é",
      1,
    ]) {
      expect(
        VertexPageInputSchema.safeParse({ ...scope, cursor }).success
      ).toBe(false);
    }
    for (const schema of [
      VertexStrategiesPageSchema,
      VertexAgentsPageSchema,
      VertexAuditPageSchema,
    ]) {
      expect(schema.safeParse({ items: [], nextCursor: null }).success).toBe(
        true
      );
      expect(schema.safeParse({ items: [], nextCursor: "" }).success).toBe(
        false
      );
      expect(
        schema.safeParse({ items: [], nextCursor: null, total: 1 }).success
      ).toBe(false);
    }
    return;
  });

  it("retains exact readonly output validators and handler input/output types", () => {
    type ReviewOutput = NonNullable<
      (typeof appContract.vertex.experience.decideReview)["~orpc"]["outputSchema"]
    >;
    type DossierOutput = NonNullable<
      (typeof appContract.vertex.experience.dossier)["~orpc"]["outputSchema"]
    >;
    expectTypeOf<
      Awaited<ReturnType<VertexExperienceService["decideReview"]>>
    >().toExtend<InferSchemaInput<ReviewOutput>>();
    expectTypeOf<
      Awaited<ReturnType<VertexExperienceService["dossier"]>>
    >().toExtend<InferSchemaInput<DossierOutput>>();
    expectTypeOf<InferSchemaOutput<ReviewOutput>>().toEqualTypeOf<
      z.output<typeof AcceptedReviewSchema>
    >();
    expectTypeOf<InferSchemaOutput<DossierOutput>>().toEqualTypeOf<
      z.output<typeof VertexDossierSchema>
    >();
    expectTypeOf<{ artifactId: string }>().not.toExtend<
      InferSchemaInput<DossierOutput>
    >();
    expect(
      appContract.vertex.experience.decideReview["~orpc"].outputSchema
    ).toBe(AcceptedReviewSchema);
    expect(appContract.vertex.experience.dossier["~orpc"].outputSchema).toBe(
      VertexDossierSchema
    );
    expect(
      appContract.vertex.experience.proposeResearch["~orpc"].outputSchema
    ).toBe(VertexAgentArtifactSchema);
    expect(
      appContract.vertex.experience.proposeSimulation["~orpc"].outputSchema
    ).toBe(VertexSimulationQueueReceiptSchema);
    expect(VERTEX_EXPERIENCE_READONLY_OUTPUTS).not.toContain(
      VertexReviewDecisionInputSchema
    );
    expect(VERTEX_EXPERIENCE_READONLY_OUTPUTS).not.toContain(
      VertexResearchProposalInputSchema
    );
    return expect(VERTEX_EXPERIENCE_READONLY_OUTPUTS).not.toContain(
      VertexSimulationProposalInputSchema
    );
  });

  it("preserves the original artifact schema document and hashes", async () => {
    const original = JSON.parse(
      await readFile(
        new URL("../../../docs/vertex-contracts.json", import.meta.url),
        "utf8"
      )
    );
    const current = buildVertexContractDocument();
    expect(canonicalArtifactJson(current)).toBe(
      canonicalArtifactJson(original)
    );
    return expect(await hashArtifact(current)).toBe(
      await hashArtifact(original)
    );
  });

  it("documents only declared operations with narrow freeze-only output requiredness", async () => {
    const document = await buildOpenApiDocument();
    const paths = Object.keys(document.paths ?? {}).filter((path) =>
      path.startsWith("/vertex/experience/")
    );
    expect(paths.sort()).toEqual(
      routes.map(([, , suffix]) => `/vertex/experience/${suffix}`).sort()
    );
    for (const [name, method, suffix] of routes) {
      const item = document.paths?.[`/vertex/experience/${suffix}`];
      const operation = method === "GET" ? item?.get : item?.post;
      expect(operation?.operationId).toBe(`vertex.experience.${name}`);
      expect(Object.keys(operation?.responses ?? {})).toEqual(
        expect.arrayContaining([
          "200",
          "400",
          "401",
          "403",
          "409",
          "502",
          "503",
        ])
      );
      expect(method === "GET" ? item?.post : item?.get).toBeUndefined();
      expect(item?.patch).toBeUndefined();
      expect(item?.put).toBeUndefined();
      expect(item?.delete).toBeUndefined();
    }
    expect(paths.some((path) => /recovery|live|broker/.test(path))).toBe(false);
    expect(
      document.paths?.["/vertex/experience/reviews"]?.post?.responses?.["200"]
    ).toMatchObject({
      content: {
        "application/json": {
          schema: {
            type: "object",
            additionalProperties: false,
            required: expect.arrayContaining([
              "artifactSha256",
              "actorId",
              "policyVersion",
              "expiresAt",
              "executionAuthorized",
            ]),
            properties: {
              artifactSha256: { type: "string" },
              executionAuthorized: { const: false },
            },
          },
        },
      },
    });
    expect(
      document.paths?.["/vertex/experience/dossier"]?.get?.responses?.["200"]
    ).toMatchObject({
      content: {
        "application/json": {
          schema: {
            type: "object",
            additionalProperties: false,
            required: expect.arrayContaining([
              "strategy",
              "drafts",
              "evidence",
              "datasets",
              "backtests",
              "reviews",
              "admissions",
            ]),
            properties: {
              evidence: {
                type: "array",
                items: {
                  type: "object",
                  required: expect.arrayContaining([
                    "contentHash",
                    "acceptanceStatus",
                    "untrustedContent",
                  ]),
                },
              },
            },
          },
        },
      },
    });
    expect(
      document.paths?.["/vertex/experience/paper-simulations"]?.post
        ?.responses?.["200"]
    ).toMatchObject({
      content: {
        "application/json": {
          schema: {
            type: "object",
            additionalProperties: false,
            required: expect.arrayContaining([
              "jobId",
              "admissionId",
              "status",
              "simulationOnly",
              "brokerSubmissionAllowed",
              "liveAuthorization",
            ]),
            properties: {
              simulationOnly: { const: true },
              brokerSubmissionAllowed: { const: false },
              liveAuthorization: { const: false },
            },
          },
        },
      },
    });
    expect(
      document.paths?.["/vertex/experience/inbox"]?.get?.responses?.["200"]
    ).toMatchObject({
      content: {
        "application/json": {
          schema: {
            required: expect.arrayContaining([
              "strategies",
              "agents",
              "reviews",
              "continuity",
              "nextCursor",
            ]),
            properties: {
              strategies: { type: "array", maxItems: 100 },
              reviews: { type: "array", maxItems: 100 },
            },
          },
        },
      },
    });
    return expect(VertexInboxPageSchema).toBe(
      appContract.vertex.experience.inbox["~orpc"].outputSchema
    );
  });
});
