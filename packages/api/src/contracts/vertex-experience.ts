import { oc } from "@orpc/contract";
import { z } from "zod";
import {
  AgentRunSchema,
  BacktestRunSchema,
  BrokerRecoveryStatusSchema,
  DatasetManifestSchema,
  DigestSchema,
  IdentifierSchema,
  ResearchEvidenceSchema,
  StrategySpecSchema,
  TradeIntentSchema,
  VersionSchema,
} from "./vertex.ts";
import {
  AcceptedReviewSchema,
  ExecutionProjectionSchema,
  PaperSimulationAdmissionSchema,
  VertexContinuityGetInputSchema,
  VertexContinuityReadSchema,
  VertexPortfolioGetInputSchema,
  VertexPortfolioReadSchema,
} from "./vertex-control.ts";
import { NativeFactProjectionSchema } from "./vertex-native-facts.ts";

// Why a 503 was returned. Optional and additive: a server that does not know
// the cause omits it, and a reader must then show the cause as not reported.
export const VertexUnavailableReasonSchema = z.enum([
  "not-configured",
  "request-cancelled",
]);
export type VertexUnavailableReason = z.infer<
  typeof VertexUnavailableReasonSchema
>;
// A cause this reader does not know yet (a newer server) is read as not
// reported, so the error still validates and stays a typed 503.
export const VertexUnavailableDataSchema = z
  .object({ reason: VertexUnavailableReasonSchema.optional().catch(undefined) })
  .optional();

export const VERTEX_EXPERIENCE_ERRORS = {
  BAD_REQUEST: { message: "Invalid Vertex request", status: 400 },
  CONFLICT: { message: "Vertex version conflict", status: 409 },
  FORBIDDEN: { message: "Vertex access denied", status: 403 },
  INVALID_SOURCE: { message: "Vertex source invalid", status: 502 },
  NOT_FOUND: { message: "Vertex record not found", status: 404 },
  SERVICE_UNAVAILABLE: {
    data: VertexUnavailableDataSchema,
    message: "Vertex capability unavailable",
    status: 503,
  },
  UNAUTHORIZED: { message: "Authentication required", status: 401 },
} as const;

export const VertexCursorSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[A-Za-z0-9_-]+$/)
  .nullable();
export const VertexPageInputSchema = VertexPortfolioGetInputSchema.extend({
  cursor: VertexCursorSchema.default(null),
  limit: z.number().int().min(1).max(100).default(100),
}).strict();
export const VertexScopedArtifactInputSchema =
  VertexPortfolioGetInputSchema.extend({
    artifactId: IdentifierSchema,
  }).strict();
export const VertexGatewayGetInputSchema = z
  .object({
    environment: z.enum(["paper", "live"]),
    gatewayId: IdentifierSchema,
  })
  .strict();
export const VertexScopesInputSchema = z.object({}).strict();
export const VertexGatewaysInputSchema = z.object({}).strict();
// One configured broker gateway the caller may observe. Listing it grants
// nothing; the gateway read still authorizes the scope and the gateway.
export const VertexGatewayBindingSchema = z
  .object({
    accountAlias: IdentifierSchema,
    environment: z.enum(["paper", "live"]),
    gatewayId: IdentifierSchema,
  })
  .strict();
export const VertexGatewaysOutputSchema = z
  .array(VertexGatewayBindingSchema)
  .max(128)
  .readonly();
export const VertexScopesOutputSchema = z
  .array(VertexPortfolioGetInputSchema)
  .max(512)
  .readonly();

const immutable = <S extends z.ZodType>(schema: S) =>
  z
    .object({
      artifactId: IdentifierSchema,
      sha256: DigestSchema,
      value: schema,
    })
    .strict()
    .readonly();
const page = <S extends z.ZodType>(schema: S) =>
  z
    .object({
      items: z.array(schema).max(100).readonly(),
      nextCursor: VertexCursorSchema,
    })
    .strict()
    .readonly();
export const VertexStrategyArtifactSchema = immutable(StrategySpecSchema);
export const VertexAgentArtifactSchema = immutable(AgentRunSchema);
export const VertexDraftArtifactSchema = immutable(TradeIntentSchema);
export const VertexBacktestArtifactSchema = immutable(BacktestRunSchema);
export const VertexStrategiesPageSchema = page(VertexStrategyArtifactSchema);
export const VertexAgentsPageSchema = page(VertexAgentArtifactSchema);
export const VertexAuditEntrySchema = z.union([
  ExecutionProjectionSchema,
  NativeFactProjectionSchema,
]);
export const VertexAuditPageSchema = page(VertexAuditEntrySchema);
export const VertexInboxPageSchema = z
  .object({
    agents: z.array(VertexAgentArtifactSchema).max(100).readonly(),
    continuity: VertexContinuityReadSchema,
    nextCursor: VertexCursorSchema,
    reviews: z.array(AcceptedReviewSchema).max(100).readonly(),
    strategies: z.array(VertexStrategyArtifactSchema).max(100).readonly(),
  })
  .strict()
  .readonly();
export const VertexDossierSchema = z
  .object({
    admissions: z.array(PaperSimulationAdmissionSchema).max(512).readonly(),
    backtests: z.array(VertexBacktestArtifactSchema).max(512).readonly(),
    datasets: z.array(DatasetManifestSchema).max(512).readonly(),
    drafts: z.array(VertexDraftArtifactSchema).max(512).readonly(),
    evidence: z.array(ResearchEvidenceSchema).max(512).readonly(),
    reviews: z.array(AcceptedReviewSchema).max(512).readonly(),
    strategy: VertexStrategyArtifactSchema,
  })
  .strict()
  .readonly();
export const VertexReviewDecisionInputSchema =
  VertexPortfolioGetInputSchema.extend({
    artifactId: IdentifierSchema,
    artifactSha256: DigestSchema,
    decision: z.enum(["accepted", "rejected"]),
    expectedReviewId: IdentifierSchema.nullable(),
    idempotencyKey: IdentifierSchema,
    purpose: z.enum(["research", "paper-simulation"]),
    strategyVersion: IdentifierSchema,
  })
    .strict()
    .refine(
      (value) =>
        value.environment !== "live" &&
        (value.purpose !== "paper-simulation" || value.environment === "paper"),
      { message: "Review scope is not permitted" }
    );
const BacktestExpectedArtifactSchema = z
  .object({ artifactId: IdentifierSchema, sha256: DigestSchema })
  .strict();
// Human expectation only. Server-selected policy, source rights, reviews and
// the existing worker admission remain the authority for any later computation.
export const VertexBacktestExpectationSchema = z
  .object({
    bindingId: IdentifierSchema,
    operation: z.literal("request-backtest"),
    plannedRun: BacktestExpectedArtifactSchema,
    policy: z
      .object({
        selectionId: IdentifierSchema,
        selectionRevision: z.string().regex(/^(0|[1-9]\d{0,29})$/),
        selectionSha256: DigestSchema,
      })
      .strict(),
    recipe: BacktestExpectedArtifactSchema,
    strategy: BacktestExpectedArtifactSchema,
    taskContract: IdentifierSchema,
  })
  .strict();
export type VertexBacktestExpectation = z.infer<
  typeof VertexBacktestExpectationSchema
>;
export const VertexResearchProposalInputSchema =
  VertexPortfolioGetInputSchema.extend({
    backtestExpectation: VertexBacktestExpectationSchema.optional(),
    collectionId: IdentifierSchema,
    evidenceIds: z
      .array(IdentifierSchema)
      .max(32)
      .readonly()
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Duplicate evidence",
      }),
    executionAuthorized: z.literal(false),
    idempotencyKey: IdentifierSchema,
    proposalOnly: z.literal(true),
    question: z
      .string()
      .min(10)
      .max(2000)
      .regex(/^[^\u0000-\u001f\u007f]+$/u),
    role: z.enum([
      "research",
      "paper-to-strategy",
      "backtest-review",
      "knowledge-import",
    ]),
  })
    .strict()
    .refine(
      (value) =>
        value.environment !== "live" &&
        (!Object.hasOwn(value, "backtestExpectation") ||
          (value.backtestExpectation !== undefined &&
            value.environment === "research" &&
            value.role === "research")),
      { message: "Research cannot authorize live execution" }
    );
export const VertexSimulationProposalInputSchema = z
  .object({
    accountAlias: IdentifierSchema,
    admissionId: IdentifierSchema,
    brokerSubmissionAllowed: z.literal(false),
    environment: z.literal("paper"),
    idempotencyKey: IdentifierSchema,
    intentId: IdentifierSchema,
    intentSha256: DigestSchema,
    liveAuthorization: z.literal(false),
    reviewId: IdentifierSchema,
    reviewVersion: VersionSchema,
    simulationOnly: z.literal(true),
    strategyVersion: IdentifierSchema,
  })
  .strict();
export const VertexSimulationQueueReceiptSchema = z
  .object({
    admissionId: IdentifierSchema,
    brokerSubmissionAllowed: z.literal(false),
    jobId: IdentifierSchema,
    liveAuthorization: z.literal(false),
    simulationOnly: z.literal(true),
    status: z.literal("queued"),
  })
  .strict()
  .readonly();

// These exact validators only detach/freeze; accepting their parsed readonly
// output as handler input preserves ALL runtime validation and JSON structure.
const readonlyOutput = <S extends z.ZodType>(
  schema: S
): z.ZodType<z.output<S>, z.input<S> | z.output<S>> => {
  return schema as z.ZodType<z.output<S>, z.input<S> | z.output<S>>;
};
const vertex = oc.errors(VERTEX_EXPERIENCE_ERRORS);
export const vertexExperienceContract = {
  agent: vertex
    .route({
      method: "GET",
      operationId: "vertex.experience.agent",
      path: "/vertex/experience/agent",
      tags: ["Vertex"],
    })
    .input(VertexScopedArtifactInputSchema)
    .output(readonlyOutput(VertexAgentArtifactSchema)),
  agents: vertex
    .route({
      method: "GET",
      operationId: "vertex.experience.agents",
      path: "/vertex/experience/agents",
      tags: ["Vertex"],
    })
    .input(VertexPageInputSchema)
    .output(readonlyOutput(VertexAgentsPageSchema)),
  audit: vertex
    .route({
      method: "GET",
      operationId: "vertex.experience.audit",
      path: "/vertex/experience/audit",
      tags: ["Vertex"],
    })
    .input(VertexPageInputSchema)
    .output(readonlyOutput(VertexAuditPageSchema)),
  continuity: vertex
    .route({
      method: "GET",
      operationId: "vertex.experience.continuity",
      path: "/vertex/experience/continuity",
      tags: ["Vertex"],
    })
    .input(VertexContinuityGetInputSchema)
    .output(readonlyOutput(VertexContinuityReadSchema)),
  decideReview: vertex
    .route({
      method: "POST",
      operationId: "vertex.experience.decideReview",
      path: "/vertex/experience/reviews",
      tags: ["Vertex"],
    })
    .input(VertexReviewDecisionInputSchema)
    .output(readonlyOutput(AcceptedReviewSchema)),
  dossier: vertex
    .route({
      method: "GET",
      operationId: "vertex.experience.dossier",
      path: "/vertex/experience/dossier",
      tags: ["Vertex"],
    })
    .input(VertexScopedArtifactInputSchema)
    .output(readonlyOutput(VertexDossierSchema)),
  gateway: vertex
    .route({
      method: "GET",
      operationId: "vertex.experience.gateway",
      path: "/vertex/experience/gateway",
      tags: ["Vertex"],
    })
    .input(VertexGatewayGetInputSchema)
    .output(readonlyOutput(BrokerRecoveryStatusSchema)),
  gateways: vertex
    .route({
      method: "GET",
      operationId: "vertex.experience.gateways",
      path: "/vertex/experience/gateways",
      tags: ["Vertex"],
    })
    .input(VertexGatewaysInputSchema)
    .output(readonlyOutput(VertexGatewaysOutputSchema)),
  inbox: vertex
    .route({
      method: "GET",
      operationId: "vertex.experience.inbox",
      path: "/vertex/experience/inbox",
      tags: ["Vertex"],
    })
    .input(VertexPageInputSchema)
    .output(readonlyOutput(VertexInboxPageSchema)),
  portfolio: vertex
    .route({
      method: "GET",
      operationId: "vertex.experience.portfolio",
      path: "/vertex/experience/portfolio",
      tags: ["Vertex"],
    })
    .input(VertexPortfolioGetInputSchema)
    .output(readonlyOutput(VertexPortfolioReadSchema)),
  proposeResearch: vertex
    .route({
      method: "POST",
      operationId: "vertex.experience.proposeResearch",
      path: "/vertex/experience/research-proposals",
      tags: ["Vertex"],
    })
    .input(VertexResearchProposalInputSchema)
    .output(readonlyOutput(VertexAgentArtifactSchema)),
  proposeSimulation: vertex
    .route({
      method: "POST",
      operationId: "vertex.experience.proposeSimulation",
      path: "/vertex/experience/paper-simulations",
      tags: ["Vertex"],
    })
    .input(VertexSimulationProposalInputSchema)
    .output(readonlyOutput(VertexSimulationQueueReceiptSchema)),
  scopes: vertex
    .route({
      method: "GET",
      operationId: "vertex.experience.scopes",
      path: "/vertex/experience/scopes",
      tags: ["Vertex"],
    })
    .input(VertexScopesInputSchema)
    .output(readonlyOutput(VertexScopesOutputSchema)),
  strategies: vertex
    .route({
      method: "GET",
      operationId: "vertex.experience.strategies",
      path: "/vertex/experience/strategies",
      tags: ["Vertex"],
    })
    .input(VertexPageInputSchema)
    .output(readonlyOutput(VertexStrategiesPageSchema)),
};

// OpenAPI may use the input shape of ONLY these exact shape-preserving outputs.
export const VERTEX_EXPERIENCE_READONLY_OUTPUTS: readonly z.ZodType[] = [
  VertexScopesOutputSchema,
  VertexGatewaysOutputSchema,
  VertexPortfolioReadSchema,
  VertexContinuityReadSchema,
  VertexInboxPageSchema,
  VertexStrategiesPageSchema,
  VertexAgentsPageSchema,
  VertexDossierSchema,
  VertexAgentArtifactSchema,
  VertexAuditPageSchema,
  BrokerRecoveryStatusSchema,
  AcceptedReviewSchema,
  VertexSimulationQueueReceiptSchema,
];
export type VertexPageInput = z.infer<typeof VertexPageInputSchema>;
export type VertexGatewayBinding = z.infer<typeof VertexGatewayBindingSchema>;
export type VertexScopedArtifactInput = z.infer<
  typeof VertexScopedArtifactInputSchema
>;
export type VertexReviewDecisionInput = z.infer<
  typeof VertexReviewDecisionInputSchema
>;
export type VertexResearchProposalInput = z.infer<
  typeof VertexResearchProposalInputSchema
>;
export type VertexSimulationProposalInput = z.infer<
  typeof VertexSimulationProposalInputSchema
>;
export type VertexSimulationQueueReceipt = z.infer<
  typeof VertexSimulationQueueReceiptSchema
>;
export type VertexStrategyArtifact = z.infer<
  typeof VertexStrategyArtifactSchema
>;
export type VertexAgentArtifact = z.infer<typeof VertexAgentArtifactSchema>;
export type VertexDossier = z.infer<typeof VertexDossierSchema>;
