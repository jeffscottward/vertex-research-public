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

export const VERTEX_EXPERIENCE_ERRORS = {
  BAD_REQUEST: { status: 400, message: "Invalid Vertex request" },
  UNAUTHORIZED: { status: 401, message: "Authentication required" },
  FORBIDDEN: { status: 403, message: "Vertex access denied" },
  NOT_FOUND: { status: 404, message: "Vertex record not found" },
  CONFLICT: { status: 409, message: "Vertex version conflict" },
  SERVICE_UNAVAILABLE: {
    status: 503,
    message: "Vertex capability unavailable",
  },
  INVALID_SOURCE: { status: 502, message: "Vertex source invalid" },
} as const;

export const VertexCursorSchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[A-Za-z0-9_-]+$/)
  .nullable();
export const VertexPageInputSchema = VertexPortfolioGetInputSchema.extend({
  limit: z.number().int().min(1).max(100).default(100),
  cursor: VertexCursorSchema.default(null),
}).strict();
export const VertexScopedArtifactInputSchema =
  VertexPortfolioGetInputSchema.extend({
    artifactId: IdentifierSchema,
  }).strict();
export const VertexGatewayGetInputSchema = z
  .object({
    gatewayId: IdentifierSchema,
    environment: z.enum(["paper", "live"]),
  })
  .strict();
export const VertexScopesInputSchema = z.object({}).strict();
export const VertexGatewaysInputSchema = z.object({}).strict();
// One configured broker gateway the caller may observe. Listing it grants
// nothing; the gateway read still authorizes the scope and the gateway.
export const VertexGatewayBindingSchema = z
  .object({
    gatewayId: IdentifierSchema,
    environment: z.enum(["paper", "live"]),
    accountAlias: IdentifierSchema,
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
    strategies: z.array(VertexStrategyArtifactSchema).max(100).readonly(),
    agents: z.array(VertexAgentArtifactSchema).max(100).readonly(),
    reviews: z.array(AcceptedReviewSchema).max(100).readonly(),
    continuity: VertexContinuityReadSchema,
    nextCursor: VertexCursorSchema,
  })
  .strict()
  .readonly();
export const VertexDossierSchema = z
  .object({
    strategy: VertexStrategyArtifactSchema,
    drafts: z.array(VertexDraftArtifactSchema).max(512).readonly(),
    evidence: z.array(ResearchEvidenceSchema).max(512).readonly(),
    datasets: z.array(DatasetManifestSchema).max(512).readonly(),
    backtests: z.array(VertexBacktestArtifactSchema).max(512).readonly(),
    reviews: z.array(AcceptedReviewSchema).max(512).readonly(),
    admissions: z.array(PaperSimulationAdmissionSchema).max(512).readonly(),
  })
  .strict()
  .readonly();
export const VertexReviewDecisionInputSchema =
  VertexPortfolioGetInputSchema.extend({
    artifactId: IdentifierSchema,
    artifactSha256: DigestSchema,
    strategyVersion: IdentifierSchema,
    decision: z.enum(["accepted", "rejected"]),
    purpose: z.enum(["research", "paper-simulation"]),
    expectedReviewId: IdentifierSchema.nullable(),
    idempotencyKey: IdentifierSchema,
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
    operation: z.literal("request-backtest"),
    taskContract: IdentifierSchema,
    bindingId: IdentifierSchema,
    strategy: BacktestExpectedArtifactSchema,
    plannedRun: BacktestExpectedArtifactSchema,
    recipe: BacktestExpectedArtifactSchema,
    policy: z
      .object({
        selectionId: IdentifierSchema,
        selectionSha256: DigestSchema,
        selectionRevision: z.string().regex(/^(0|[1-9]\d{0,29})$/),
      })
      .strict(),
  })
  .strict();
export type VertexBacktestExpectation = z.infer<
  typeof VertexBacktestExpectationSchema
>;
export const VertexResearchProposalInputSchema =
  VertexPortfolioGetInputSchema.extend({
    question: z
      .string()
      .min(10)
      .max(2000)
      .regex(/^[^\u0000-\u001f\u007f]+$/u),
    collectionId: IdentifierSchema,
    evidenceIds: z
      .array(IdentifierSchema)
      .max(32)
      .readonly()
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "Duplicate evidence",
      }),
    role: z.enum([
      "research",
      "paper-to-strategy",
      "backtest-review",
      "knowledge-import",
    ]),
    idempotencyKey: IdentifierSchema,
    proposalOnly: z.literal(true),
    executionAuthorized: z.literal(false),
    backtestExpectation: VertexBacktestExpectationSchema.optional(),
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
    environment: z.literal("paper"),
    admissionId: IdentifierSchema,
    reviewId: IdentifierSchema,
    reviewVersion: VersionSchema,
    intentId: IdentifierSchema,
    intentSha256: DigestSchema,
    strategyVersion: IdentifierSchema,
    idempotencyKey: IdentifierSchema,
    simulationOnly: z.literal(true),
    brokerSubmissionAllowed: z.literal(false),
    liveAuthorization: z.literal(false),
  })
  .strict();
export const VertexSimulationQueueReceiptSchema = z
  .object({
    jobId: IdentifierSchema,
    admissionId: IdentifierSchema,
    status: z.literal("queued"),
    simulationOnly: z.literal(true),
    brokerSubmissionAllowed: z.literal(false),
    liveAuthorization: z.literal(false),
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
  scopes: vertex
    .route({
      method: "GET",
      path: "/vertex/experience/scopes",
      tags: ["Vertex"],
      operationId: "vertex.experience.scopes",
    })
    .input(VertexScopesInputSchema)
    .output(readonlyOutput(VertexScopesOutputSchema)),
  gateways: vertex
    .route({
      method: "GET",
      path: "/vertex/experience/gateways",
      tags: ["Vertex"],
      operationId: "vertex.experience.gateways",
    })
    .input(VertexGatewaysInputSchema)
    .output(readonlyOutput(VertexGatewaysOutputSchema)),
  portfolio: vertex
    .route({
      method: "GET",
      path: "/vertex/experience/portfolio",
      tags: ["Vertex"],
      operationId: "vertex.experience.portfolio",
    })
    .input(VertexPortfolioGetInputSchema)
    .output(readonlyOutput(VertexPortfolioReadSchema)),
  continuity: vertex
    .route({
      method: "GET",
      path: "/vertex/experience/continuity",
      tags: ["Vertex"],
      operationId: "vertex.experience.continuity",
    })
    .input(VertexContinuityGetInputSchema)
    .output(readonlyOutput(VertexContinuityReadSchema)),
  inbox: vertex
    .route({
      method: "GET",
      path: "/vertex/experience/inbox",
      tags: ["Vertex"],
      operationId: "vertex.experience.inbox",
    })
    .input(VertexPageInputSchema)
    .output(readonlyOutput(VertexInboxPageSchema)),
  strategies: vertex
    .route({
      method: "GET",
      path: "/vertex/experience/strategies",
      tags: ["Vertex"],
      operationId: "vertex.experience.strategies",
    })
    .input(VertexPageInputSchema)
    .output(readonlyOutput(VertexStrategiesPageSchema)),
  dossier: vertex
    .route({
      method: "GET",
      path: "/vertex/experience/dossier",
      tags: ["Vertex"],
      operationId: "vertex.experience.dossier",
    })
    .input(VertexScopedArtifactInputSchema)
    .output(readonlyOutput(VertexDossierSchema)),
  agents: vertex
    .route({
      method: "GET",
      path: "/vertex/experience/agents",
      tags: ["Vertex"],
      operationId: "vertex.experience.agents",
    })
    .input(VertexPageInputSchema)
    .output(readonlyOutput(VertexAgentsPageSchema)),
  agent: vertex
    .route({
      method: "GET",
      path: "/vertex/experience/agent",
      tags: ["Vertex"],
      operationId: "vertex.experience.agent",
    })
    .input(VertexScopedArtifactInputSchema)
    .output(readonlyOutput(VertexAgentArtifactSchema)),
  audit: vertex
    .route({
      method: "GET",
      path: "/vertex/experience/audit",
      tags: ["Vertex"],
      operationId: "vertex.experience.audit",
    })
    .input(VertexPageInputSchema)
    .output(readonlyOutput(VertexAuditPageSchema)),
  gateway: vertex
    .route({
      method: "GET",
      path: "/vertex/experience/gateway",
      tags: ["Vertex"],
      operationId: "vertex.experience.gateway",
    })
    .input(VertexGatewayGetInputSchema)
    .output(readonlyOutput(BrokerRecoveryStatusSchema)),
  decideReview: vertex
    .route({
      method: "POST",
      path: "/vertex/experience/reviews",
      tags: ["Vertex"],
      operationId: "vertex.experience.decideReview",
    })
    .input(VertexReviewDecisionInputSchema)
    .output(readonlyOutput(AcceptedReviewSchema)),
  proposeResearch: vertex
    .route({
      method: "POST",
      path: "/vertex/experience/research-proposals",
      tags: ["Vertex"],
      operationId: "vertex.experience.proposeResearch",
    })
    .input(VertexResearchProposalInputSchema)
    .output(readonlyOutput(VertexAgentArtifactSchema)),
  proposeSimulation: vertex
    .route({
      method: "POST",
      path: "/vertex/experience/paper-simulations",
      tags: ["Vertex"],
      operationId: "vertex.experience.proposeSimulation",
    })
    .input(VertexSimulationProposalInputSchema)
    .output(readonlyOutput(VertexSimulationQueueReceiptSchema)),
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
