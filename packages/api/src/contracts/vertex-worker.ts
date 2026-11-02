import { z } from "zod";
import {
  deepFreezeArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import {
  AgentRunSchema,
  BacktestRunSchema,
  DatasetManifestSchema,
  DigestSchema,
  IdentifierSchema,
  KnowledgeImportSchema,
  ResearchEvidenceSchema,
  SchemaVersionSchema,
  SourceIdentitySchema,
  StrategySpecSchema,
  TimestampSchema,
  TradeIntentSchema,
} from "./vertex.ts";
import {
  AcceptedReviewSchema,
  ExecutionProjectionSchema,
  PaperSimulationAdmissionSchema,
  PortfolioSnapshotSchema,
  ProjectionSequenceSchema,
} from "./vertex-control.ts";
import { NativeFactProjectionSchema } from "./vertex-native-facts.ts";
import {
  ModelUseRequestSchema,
  ModelUseProofSchema,
} from "./vertex-model-use.ts";
import {
  PortfolioEpochTransitionSchema,
  NativeOutboxReplaySchema,
} from "./vertex-worker-epoch.ts";
import { WorkerExperimentDependencyPinSchema } from "./vertex-worker-experiment.ts";
import { ModelPrivacyCandidateStatusSchema } from "./vertex-model-privacy-rendezvous.ts";

// Transport acceptance is not engine completion, publication, or broker delivery.
// This is the sole authoritative public worker contract source.
export const WorkerEnvironmentSchema = z.enum(["research", "paper"]);
export const WorkerKindSchema = z.enum([
  "research-run",
  "dataset-ingest",
  "knowledge-import",
  "backtest",
  "paper-simulation",
  "native-bootstrap",
]);
export const WorkerOperationSchema = z.enum([
  "claim",
  "renew",
  "complete",
  "cancel",
  "status",
  "admitRun",
  "readArtifact",
  "readExperiment",
  "readBacktestRun",
  "readDataset",
  "stageArtifact",
  "publishArtifact",
  "publishAgent",
  "publishExperiment",
  "publishCollection",
  "activateCollection",
  "readCollection",
  "currentRights",
  "acceptedEvidence",
  "currentRightsObservation",
  "acceptedEvidenceObservation",
  "currentPaperAdmission",
  "currentModelUse",
  "prepareModelPrivacyReview",
  "readModelPrivacyReview",
  "prepareNativeEvidencePhaseTwo",
  "publishGenesis",
  "publishPortfolioSnapshot",
  "publishEpochTransition",
  "replayNativeOutbox",
  "publishOrderProjection",
  "publishNativeFacts",
  "readContinuity",
  "readiness",
  "policySelection",
]);
// Bootstrap is a separately granted capability, never a public RPC or order grant.
export const WorkerPermissionSchema = z.union([
  WorkerOperationSchema,
  z.literal("native-bootstrap"),
  z.literal("chat-copy-cleanup-discovery"),
]);
export const WorkerEpochSchema = z.string().regex(/^[1-9][0-9]{0,29}$/);
export const WorkerScopeSchema = z
  .object({
    accountAlias: IdentifierSchema,
    environment: WorkerEnvironmentSchema,
  })
  .strict();
const scope = WorkerScopeSchema.shape;
const ids = z
  .array(IdentifierSchema)
  .max(64)
  .refine((items) => new Set(items).size === items.length, {
    message: "Duplicate identity",
  });
const ordered = (a: string, b: string): boolean =>
  timestampToEpochNanoseconds(a) < timestampToEpochNanoseconds(b);
export const WorkerLeaseSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    jobId: IdentifierSchema,
    eventId: IdentifierSchema,
    kind: WorkerKindSchema,
    researchPrincipalId: IdentifierSchema,
    ...scope,
    payloadArtifactId: IdentifierSchema,
    payloadSha256: DigestSchema,
    policySelectionId: IdentifierSchema,
    policySelectionSha256: DigestSchema,
    deadlineAt: TimestampSchema,
    leaseId: IdentifierSchema,
    leaseEpoch: WorkerEpochSchema,
    leaseExpiresAt: TimestampSchema,
    attempt: z.number().int().min(1).max(32),
  })
  .strict()
  .refine((value) => !ordered(value.deadlineAt, value.leaseExpiresAt), {
    message: "Lease exceeds job deadline",
  })
  .readonly()
  .transform(deepFreezeArtifact);
export const WorkerFenceSchema = z
  .object({
    ...scope,
    jobId: IdentifierSchema,
    leaseId: IdentifierSchema,
    leaseEpoch: WorkerEpochSchema,
  })
  .strict();
const fence = WorkerFenceSchema.shape;
export const WorkerClaimInputSchema = z
  .object({
    ...scope,
    workerInstanceId: IdentifierSchema,
    kinds: z.array(WorkerKindSchema).min(1).max(6),
    limit: z.number().int().min(1).max(16),
    leaseDurationMs: z.number().int().min(1000).max(300_000),
  })
  .strict();
export const WorkerClaimOutputSchema = z
  .object({
    status: z.enum(["accepted", "rejected"]),
    leases: z.array(WorkerLeaseSchema).max(16),
  })
  .strict();
export const WorkerRenewInputSchema = z
  .object({ ...fence, leaseExpiresAt: TimestampSchema })
  .strict();
export const WorkerCompleteInputSchema = z
  .object({
    ...fence,
    outcome: z.enum(["succeeded", "failed", "cancelled", "unknown"]),
    outcomeSha256: DigestSchema,
    outputArtifactIds: ids,
  })
  .strict();
export const WorkerCancelInputSchema = z
  .object({
    ...fence,
    reason: z.enum(["requested", "deadline", "shutdown", "policy-revoked"]),
  })
  .strict();
export const WorkerStatusInputSchema = z
  .object({ ...scope, jobId: IdentifierSchema })
  .strict();
// admittedAt is emitted only by admitRun: durable job-input capture, NOT completion.
export const WorkerResultSchema = z
  .object({
    status: z.enum([
      "accepted",
      "duplicate",
      "unknown",
      "completed",
      "rejected",
    ]),
    jobId: IdentifierSchema,
    state: z.enum([
      "leased",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "unknown",
    ]),
    lease: WorkerLeaseSchema.nullable(),
    outputArtifactIds: ids,
    reason: z
      .enum([
        "stale-lease",
        "denied",
        "deadline",
        "conflict",
        "unavailable",
        "not-found",
      ])
      .nullable(),
    admittedAt: TimestampSchema.optional(),
  })
  .strict()
  .readonly()
  .transform(deepFreezeArtifact);
export const WorkerAdmitRunInputSchema = z
  .object({ ...fence, runId: IdentifierSchema, requestSha256: DigestSchema })
  .strict();
export const WorkerArtifactRefSchema = z
  .object({ artifactId: IdentifierSchema, artifactSha256: DigestSchema })
  .strict();
export const WorkerReadArtifactInputSchema = z
  .object({
    ...fence,
    collectionId: IdentifierSchema.nullable(),
    artifactId: IdentifierSchema,
  })
  .strict();
export const WorkerBytesSchema = z
  .string()
  .max(1_398_104)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
export const WorkerReadArtifactOutputSchema = z
  .object({
    artifact: WorkerArtifactRefSchema,
    contentBase64: WorkerBytesSchema,
    contentSha256: DigestSchema,
    canonicalSha256: DigestSchema.nullable(),
    contentType: z.string().min(3).max(128),
  })
  .strict();
// Only this operation establishes an exact committed private experiment binding.
export const WorkerReadExperimentInputSchema = z
  .object({
    ...fence,
    collectionId: IdentifierSchema,
    experimentId: IdentifierSchema,
    artifact: WorkerArtifactRefSchema,
  })
  .strict();
export const WorkerReadExperimentOutputSchema = z
  .object({
    ...WorkerReadArtifactOutputSchema.shape,
    jobId: IdentifierSchema,
    collectionId: IdentifierSchema,
    experimentId: IdentifierSchema,
    canonicalSha256: DigestSchema,
    contentType: z.literal("application/json"),
  })
  .strict();
// This read proves a committed completed run and its originating fenced job.
// jobId in the output is that PRODUCER, never the caller's consuming fence.
const backtestReadRefs = {
  plannedRun: WorkerArtifactRefSchema,
  results: WorkerArtifactRefSchema,
  recipe: WorkerArtifactRefSchema,
};
// Omission preserves the existing reader. Supply => mandatory original
// experiment -> planned run -> producer causal proof; never a fallback mode.
const backtestReadExperiment = z
  .object({ experimentId: IdentifierSchema, artifact: WorkerArtifactRefSchema })
  .strict();
export const WorkerReadBacktestRunInputSchema = z
  .object({
    ...fence,
    collectionId: IdentifierSchema,
    artifact: WorkerArtifactRefSchema,
    ...backtestReadRefs,
    experiment: backtestReadExperiment.optional(),
  })
  .strict();
export const WorkerReadBacktestRunOutputSchema = z
  .object({
    ...WorkerReadArtifactOutputSchema.shape,
    jobId: IdentifierSchema,
    collectionId: IdentifierSchema,
    ...backtestReadRefs,
    receipt: WorkerArtifactRefSchema,
    isolation: WorkerArtifactRefSchema,
    experiment: backtestReadExperiment.optional(),
    canonicalSha256: DigestSchema,
    contentType: z.literal("application/json"),
  })
  .strict();
// Private chat consumes the exact already-returned completion and AFTER-return
// proof. This extension never grants dispatch and is forbidden on ordinary jobs.
const ChatCompletionStageSchema = z
  .object({
    request: ModelUseRequestSchema,
    responseBase64: WorkerBytesSchema,
    proof: ModelUseProofSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.request.operation === "model-completion" &&
      value.proof.operation === "model-completion" &&
      value.proof.decision === "allowed" &&
      value.proof.externalDispatchAllowed === false
  );
// Separate explicit worker capability. The native response is inert input to
// the original proof/copy owner; this method never issues model authority.
export const WorkerPrepareNativeEvidencePhaseTwoInputSchema = z
  .object({
    ...fence,
    request: ModelUseRequestSchema,
    responseBase64: WorkerBytesSchema,
    proof: ModelUseProofSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.environment === "research" &&
      value.request.operation === "model-completion" &&
      value.proof.operation === "model-completion" &&
      value.proof.decision === "allowed" &&
      value.proof.externalDispatchAllowed === false &&
      value.request.accountAlias === value.accountAlias &&
      value.request.environment === value.environment &&
      value.request.jobId === value.jobId &&
      value.request.leaseId === value.leaseId &&
      value.request.leaseEpoch === value.leaseEpoch &&
      value.proof.requestSha256 === value.request.requestSha256 &&
      value.proof.requestId === value.request.requestId
  );
const nativeContent = z
  .object({
    sha256: DigestSchema,
    byteLength: z.number().int().min(1).max(262_144),
  })
  .strict();
const nativeDerivation = z
  .object({
    profile: z.literal("reviewed-evidence-single-projection-v1"),
    phaseOneResponseSha256: DigestSchema,
    phaseOneRequestSha256: DigestSchema,
    phaseOneProofSha256: DigestSchema,
    callId: IdentifierSchema,
    toolName: z.literal("read_reviewed_evidence"),
    argumentsCanonical: z.string().max(256),
    evidenceId: IdentifierSchema,
    bundleSha256: DigestSchema,
    toolResultSha256: DigestSchema,
  })
  .strict()
  .refine(
    (value) =>
      value.argumentsCanonical ===
      JSON.stringify({ evidence_id: value.evidenceId })
  );
export const WorkerNativeEvidencePhaseSchema = z
  .object({
    profile: z.literal("vertex-research-chat-native-phase-v1"),
    accountAlias: IdentifierSchema,
    environment: z.literal("research"),
    responseRequestId: IdentifierSchema,
    planSha256: DigestSchema,
    phaseOrdinal: z.union([z.literal(1), z.literal(2)]),
    tokenizeInput: nativeContent,
    completionInput: nativeContent,
    derivation: nativeDerivation.nullable(),
    expiresAt: TimestampSchema,
    phaseSha256: DigestSchema,
  })
  .strict()
  .refine((value) => (value.phaseOrdinal === 1) === (value.derivation === null))
  .readonly()
  .transform(deepFreezeArtifact);
const nativeCopyHandle = z
  .object({
    copyId: IdentifierSchema,
    reservationSha256: DigestSchema,
    sha256: DigestSchema,
    byteLength: z.number().int().min(1).max(262_144),
  })
  .strict();
export const WorkerPrepareNativeEvidencePhaseTwoOutputSchema = z
  .object({
    phase: WorkerNativeEvidencePhaseSchema.refine(
      (value) => value.phaseOrdinal === 2
    ),
    copies: z
      .object({
        phaseTwoTokenizeInput: nativeCopyHandle,
        phaseTwoCompletionInput: nativeCopyHandle,
        toolResult: nativeCopyHandle,
      })
      .strict(),
    executionAuthorized: z.literal(false),
  })
  .strict()
  .readonly()
  .transform(deepFreezeArtifact);
export const WorkerStageArtifactInputSchema = z
  .object({
    ...fence,
    collectionId: IdentifierSchema.nullable(),
    artifactId: IdentifierSchema,
    contentBase64: WorkerBytesSchema,
    contentSha256: DigestSchema,
    canonicalSha256: DigestSchema.nullable(),
    contentType: z.string().min(3).max(128),
    rightsPolicyId: IdentifierSchema,
    rightsVersion: IdentifierSchema,
    lineageArtifactIds: ids,
    chatCompletion: ChatCompletionStageSchema.optional(),
  })
  .strict();
export const WorkerStageArtifactOutputSchema = z
  .object({
    status: z.enum(["accepted", "duplicate"]),
    artifact: WorkerArtifactRefSchema,
    contentSha256: DigestSchema,
    canonicalSha256: DigestSchema.nullable(),
  })
  .strict();
const publication = {
  ...fence,
  collectionId: IdentifierSchema.nullable(),
  artifact: WorkerArtifactRefSchema,
  idempotencyKey: IdentifierSchema,
};
export const WorkerReviewPinSchema = z
  .object({
    collectionId: IdentifierSchema,
    evidenceId: IdentifierSchema,
    artifactId: IdentifierSchema,
    artifactSha256: DigestSchema,
    reviewId: IdentifierSchema,
    reviewVersion: IdentifierSchema,
    rightsPolicyId: IdentifierSchema,
    rightsVersion: IdentifierSchema,
  })
  .strict();
// Exact committed root qualification, never arbitrary raw-stage access. Source
// identity selects a manifest member; its original digest is derived server-side.
const datasetReadMember = {
  manifest: WorkerArtifactRefSchema,
  member: z.enum(["content", "capture"]),
  source: SourceIdentitySchema.nullable(),
};
export const WorkerReadDatasetInputSchema = z
  .object({
    ...fence,
    collectionId: IdentifierSchema.nullable(),
    ...datasetReadMember,
    reviewPins: z.array(WorkerReviewPinSchema).min(1).max(64),
  })
  .strict()
  .refine((value) => (value.member === "content") === (value.source === null));
export const WorkerReadDatasetOutputSchema = z
  .object({
    ...WorkerReadArtifactOutputSchema.shape,
    producerJobId: IdentifierSchema,
    collectionId: IdentifierSchema.nullable(),
    ...datasetReadMember,
    canonicalSha256: z.null(),
  })
  .strict()
  .refine((value) => (value.member === "content") === (value.source === null));
// Expectations only: the committing server resolves the private experiment,
// reviewed original binding bytes and exact generic dependency identity set.
const experimentBacktestSource = z
  .object({
    experimentId: IdentifierSchema,
    experimentHash: DigestSchema,
    bindingSha256: DigestSchema,
    bindingReview: WorkerReviewPinSchema,
    dependencyPins: z.array(WorkerExperimentDependencyPinSchema).min(1).max(63),
  })
  .strict();
export const WorkerPublishArtifactInputSchema = z.discriminatedUnion(
  "contractName",
  [
    z
      .object({
        ...publication,
        contractName: z.literal("DatasetManifest"),
        record: DatasetManifestSchema,
      })
      .strict(),
    z
      .object({
        ...publication,
        contractName: z.literal("ResearchEvidence"),
        record: ResearchEvidenceSchema,
        reviewPins: z.array(WorkerReviewPinSchema).min(1).max(64).optional(),
      })
      .strict(),
    z
      .object({
        ...publication,
        contractName: z.literal("StrategySpec"),
        record: StrategySpecSchema,
      })
      .strict(),
    z
      .object({
        ...publication,
        contractName: z.literal("BacktestRun"),
        record: BacktestRunSchema,
        experimentSource: experimentBacktestSource.optional(),
      })
      .strict(),
  ]
);
// Advisory profile stays private; the terminal public AgentRun is committed in the
// same transaction, with no dangling profile artifact or invented public schema.
export const WorkerPublishAgentInputSchema = z
  .object({
    ...publication,
    run: AgentRunSchema,
    advisoryProfileArtifact: WorkerArtifactRefSchema,
    reviewPins: z.array(WorkerReviewPinSchema).max(64),
  })
  .strict();
// Content is decoded only within the bounded private publication operation.
// No public artifact taxonomy is extended by this private profile.
export const WorkerPublishExperimentInputSchema = z
  .object({
    ...fence,
    collectionId: IdentifierSchema,
    experimentId: IdentifierSchema,
    contentBase64: WorkerBytesSchema,
    contentSha256: DigestSchema,
    rightsPolicyId: IdentifierSchema,
    rightsVersion: IdentifierSchema,
    dependencyPins: z.array(WorkerExperimentDependencyPinSchema).min(1).max(64),
    sourceReviewPins: z.array(WorkerReviewPinSchema).min(1).max(64).optional(),
  })
  .strict();
export const WorkerPublishExperimentOutputSchema = z
  .object({
    status: z.enum(["accepted", "duplicate"]),
    jobId: IdentifierSchema,
    collectionId: IdentifierSchema,
    experimentId: IdentifierSchema,
    artifact: WorkerArtifactRefSchema,
  })
  .strict()
  .readonly()
  .transform(deepFreezeArtifact);
export const WorkerRightsPinSchema = z
  .object({
    sourceId: IdentifierSchema,
    policyId: IdentifierSchema,
    version: IdentifierSchema,
  })
  .strict();
const collectionPublication = {
  reconstructionArtifact: WorkerArtifactRefSchema,
  manifestSha256: DigestSchema,
  rightsPins: z.array(WorkerRightsPinSchema).min(1).max(1024),
};
export const WorkerPublishCollectionInputSchema = z
  .object({
    ...fence,
    ...collectionPublication,
    collectionId: IdentifierSchema,
    expectedActiveSnapshotId: IdentifierSchema.nullable(),
    imports: z
      .array(
        z
          .object({
            record: KnowledgeImportSchema,
            artifact: WorkerArtifactRefSchema,
          })
          .strict()
      )
      .min(1)
      .max(64),
    evidence: z
      .array(
        z
          .object({
            record: ResearchEvidenceSchema,
            artifact: WorkerArtifactRefSchema,
          })
          .strict()
      )
      .max(512),
    datasets: z
      .array(
        z
          .object({
            record: DatasetManifestSchema,
            artifact: WorkerArtifactRefSchema,
          })
          .strict()
      )
      .max(512),
    idempotencyKey: IdentifierSchema,
  })
  .strict();
export const WorkerActivateCollectionInputSchema = z
  .object({
    ...fence,
    manifestSha256: DigestSchema,
    rightsPins: z.array(WorkerRightsPinSchema).min(1).max(1024),
    collectionId: IdentifierSchema,
    expectedActiveSnapshotId: IdentifierSchema,
    targetSnapshotId: IdentifierSchema,
    idempotencyKey: IdentifierSchema,
  })
  .strict();
export const WorkerReadCollectionInputSchema = z
  .object({
    ...fence,
    collectionId: IdentifierSchema,
    snapshotId: IdentifierSchema.nullable(),
  })
  .strict();
export const WorkerCollectionOutputSchema = z
  .object({
    status: z.enum(["published", "duplicate", "activated", "available"]),
    reconstructionArtifact: WorkerArtifactRefSchema,
    manifestSha256: DigestSchema,
    collectionId: IdentifierSchema,
    snapshotId: IdentifierSchema,
    previousSnapshotId: IdentifierSchema.nullable(),
    importArtifacts: z.array(WorkerArtifactRefSchema).max(64),
  })
  .strict();
export const WorkerCurrentRightsInputSchema = z
  .object({
    ...fence,
    collectionId: IdentifierSchema.nullable(),
    policyId: IdentifierSchema,
    use: z.enum(["store", "read", "derive", "export"]),
  })
  .strict();
export const WorkerCurrentRightsOutputSchema = z
  .object({
    policyId: IdentifierSchema,
    version: IdentifierSchema,
    status: z.enum(["granted", "denied", "expired", "unknown"]),
    allowedUses: z.array(z.enum(["store", "read", "derive", "export"])).max(4),
    checkedAt: TimestampSchema,
    expiresAt: TimestampSchema.nullable(),
    retentionUntil: TimestampSchema.nullable(),
  })
  .strict();
export const WorkerAcceptedEvidenceInputSchema = z
  .object({
    ...fence,
    collectionId: IdentifierSchema,
    evidenceId: IdentifierSchema,
  })
  .strict();
export const WorkerAcceptedEvidenceOutputSchema = z
  .object({
    artifact: WorkerArtifactRefSchema,
    contentBase64: WorkerBytesSchema,
    evidence: ResearchEvidenceSchema,
    review: AcceptedReviewSchema,
    rights: WorkerCurrentRightsOutputSchema,
  })
  .strict();
// Successful LOCAL final-check observations; immutable decision history stays
// nested unchanged. These are not licensing-provider issuance or dispatch grants.
/** @alias Named procedure schema kept distinct for the contract/OpenAPI surface. */
export const WorkerCurrentRightsObservationInputSchema =
  WorkerCurrentRightsInputSchema;
export const WorkerCurrentRightsObservationOutputSchema = z
  .object({
    format: z.literal("vertex-worker-current-rights-observation-v1"),
    observedAt: TimestampSchema,
    value: WorkerCurrentRightsOutputSchema,
  })
  .strict();
/** @alias Named procedure schema kept distinct for the contract/OpenAPI surface. */
export const WorkerAcceptedEvidenceObservationInputSchema =
  WorkerAcceptedEvidenceInputSchema;
export const WorkerAcceptedEvidenceObservationOutputSchema = z
  .object({
    format: z.literal("vertex-worker-accepted-evidence-observation-v1"),
    observedAt: TimestampSchema,
    value: WorkerAcceptedEvidenceOutputSchema,
  })
  .strict();
export const WorkerPublishGenesisInputSchema = z
  .object({ ...fence, snapshot: PortfolioSnapshotSchema })
  .strict();
export const WorkerPublishPortfolioSnapshotInputSchema = z
  .object({ ...fence, snapshot: PortfolioSnapshotSchema })
  .strict();
export const WorkerPublishOrderProjectionInputSchema = z
  .object({ ...fence, projection: ExecutionProjectionSchema })
  .strict();
export const WorkerPublishNativeFactsInputSchema = z
  .object({
    ...fence,
    projection: NativeFactProjectionSchema,
    proofBase64: WorkerBytesSchema,
  })
  .strict();
export const WorkerProjectionAckSchema = z
  .object({
    status: z.enum(["applied", "duplicate", "gap", "epoch-mismatch", "stale"]),
    highWaterSequence: ProjectionSequenceSchema,
    highWaterEventHash: DigestSchema.nullable(),
  })
  .strict();
export const WorkerReadContinuityInputSchema = z
  .object({ ...fence, streamId: IdentifierSchema })
  .strict();
export const WorkerReadinessInputSchema = z
  .object({
    ...fence,
    state: z.enum(["ready", "unavailable", "draining"]),
    capabilityIds: ids,
    observedAt: TimestampSchema,
  })
  .strict();
export const WorkerPolicySelectionInputSchema = z
  .object({
    ...fence,
    selectionId: IdentifierSchema,
    selectionSha256: DigestSchema,
  })
  .strict();
export const WorkerCurrentPaperAdmissionInputSchema = z
  .object({
    ...fence,
    intentArtifactId: IdentifierSchema,
    intentSha256: DigestSchema,
    admissionId: IdentifierSchema,
  })
  .strict();
export const WorkerCurrentPaperAdmissionOutputSchema = z
  .object({
    status: z.literal("allowed"),
    checkedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    admission: PaperSimulationAdmissionSchema,
    review: AcceptedReviewSchema,
    intentArtifact: WorkerArtifactRefSchema,
    intent: TradeIntentSchema,
  })
  .strict();
export const WorkerServiceGrantSchema = z
  .object({
    grantId: IdentifierSchema,
    servicePrincipalId: IdentifierSchema,
    ...scope,
    operations: z.array(WorkerPermissionSchema).min(1).max(28),
    issuedAt: TimestampSchema,
    expiresAt: TimestampSchema,
    revokedAt: TimestampSchema.nullable(),
  })
  .strict()
  .refine((value) => ordered(value.issuedAt, value.expiresAt), {
    message: "Invalid grant lifetime",
  });
export const WorkerBootstrapPayloadSchema = z
  .object({
    format: z.literal("vertex-native-bootstrap-job-v1"),
    journalIdentity: IdentifierSchema,
    simulatorId: IdentifierSchema,
    streamId: IdentifierSchema,
    selectionId: IdentifierSchema,
    selectionSha256: DigestSchema,
    mode: z.enum(["initialize", "restore"]),
  })
  .strict();
export const WorkerBootstrapCommandSchema = z
  .object({
    schemaVersion: SchemaVersionSchema,
    accountAlias: IdentifierSchema,
    environment: z.literal("paper"),
    researchPrincipalId: IdentifierSchema,
    payloadArtifactId: IdentifierSchema,
    payloadSha256: DigestSchema,
    policySelectionId: IdentifierSchema,
    policySelectionSha256: DigestSchema,
    rightsPolicyId: IdentifierSchema,
    rightsVersion: IdentifierSchema,
    issuedAt: TimestampSchema,
    deadlineAt: TimestampSchema,
    idempotencyKey: IdentifierSchema,
    payload: WorkerBootstrapPayloadSchema,
  })
  .strict()
  .refine(
    (value) =>
      ordered(value.issuedAt, value.deadlineAt) &&
      value.payload.selectionId === value.policySelectionId &&
      value.payload.selectionSha256 === value.policySelectionSha256,
    { message: "Bootstrap pins or lifetime mismatch" }
  );
export const WorkerCurrentModelUseInputSchema = ModelUseRequestSchema;
export const WorkerCurrentModelUseOutputSchema = ModelUseProofSchema;
export const WorkerPrepareModelPrivacyReviewInputSchema = ModelUseRequestSchema;
export const WorkerReadModelPrivacyReviewInputSchema = ModelUseRequestSchema;
export const WorkerModelPrivacyReviewOutputSchema =
  ModelPrivacyCandidateStatusSchema;
export const WorkerPublishEpochTransitionInputSchema = z
  .object({ ...fence, transition: PortfolioEpochTransitionSchema })
  .strict();
export const WorkerReplayNativeOutboxInputSchema = z
  .object({ ...fence, replay: NativeOutboxReplaySchema })
  .strict();
export type WorkerLease = z.infer<typeof WorkerLeaseSchema>;
export type WorkerFence = z.infer<typeof WorkerFenceSchema>;
export type WorkerOperation = z.infer<typeof WorkerOperationSchema>;
export type WorkerResult = z.infer<typeof WorkerResultSchema>;
export type WorkerServiceGrant = z.infer<typeof WorkerServiceGrantSchema>;
export const VERTEX_WORKER_CONTRACT_SCHEMAS = {
  WorkerCurrentRightsObservationInput:
    WorkerCurrentRightsObservationInputSchema,
  WorkerCurrentRightsObservationOutput:
    WorkerCurrentRightsObservationOutputSchema,
  WorkerAcceptedEvidenceObservationInput:
    WorkerAcceptedEvidenceObservationInputSchema,
  WorkerAcceptedEvidenceObservationOutput:
    WorkerAcceptedEvidenceObservationOutputSchema,
  WorkerPrepareModelPrivacyReviewInput:
    WorkerPrepareModelPrivacyReviewInputSchema,
  WorkerReadModelPrivacyReviewInput: WorkerReadModelPrivacyReviewInputSchema,
  WorkerModelPrivacyReviewOutput: WorkerModelPrivacyReviewOutputSchema,
  WorkerPrepareNativeEvidencePhaseTwoInput:
    WorkerPrepareNativeEvidencePhaseTwoInputSchema,
  WorkerPrepareNativeEvidencePhaseTwoOutput:
    WorkerPrepareNativeEvidencePhaseTwoOutputSchema,
  WorkerNativeEvidencePhase: WorkerNativeEvidencePhaseSchema,
  WorkerExperimentDependencyPin: WorkerExperimentDependencyPinSchema,
  WorkerPublishExperimentInput: WorkerPublishExperimentInputSchema,
  WorkerPublishExperimentOutput: WorkerPublishExperimentOutputSchema,
  WorkerReadExperimentInput: WorkerReadExperimentInputSchema,
  WorkerReadExperimentOutput: WorkerReadExperimentOutputSchema,
  WorkerReadBacktestRunInput: WorkerReadBacktestRunInputSchema,
  WorkerReadBacktestRunOutput: WorkerReadBacktestRunOutputSchema,
  WorkerReadDatasetInput: WorkerReadDatasetInputSchema,
  WorkerReadDatasetOutput: WorkerReadDatasetOutputSchema,
  WorkerReplayNativeOutboxInput: WorkerReplayNativeOutboxInputSchema,
  WorkerCurrentModelUseInput: WorkerCurrentModelUseInputSchema,
  WorkerCurrentModelUseOutput: WorkerCurrentModelUseOutputSchema,
  WorkerPublishEpochTransitionInput: WorkerPublishEpochTransitionInputSchema,
  WorkerBootstrapPayload: WorkerBootstrapPayloadSchema,
  WorkerBootstrapCommand: WorkerBootstrapCommandSchema,
  WorkerRightsPin: WorkerRightsPinSchema,
  WorkerPublishPortfolioSnapshotInput:
    WorkerPublishPortfolioSnapshotInputSchema,
  WorkerCurrentPaperAdmissionInput: WorkerCurrentPaperAdmissionInputSchema,
  WorkerCurrentPaperAdmissionOutput: WorkerCurrentPaperAdmissionOutputSchema,
  WorkerLease: WorkerLeaseSchema,
  WorkerFence: WorkerFenceSchema,
  WorkerClaimInput: WorkerClaimInputSchema,
  WorkerClaimOutput: WorkerClaimOutputSchema,
  WorkerRenewInput: WorkerRenewInputSchema,
  WorkerCompleteInput: WorkerCompleteInputSchema,
  WorkerCancelInput: WorkerCancelInputSchema,
  WorkerStatusInput: WorkerStatusInputSchema,
  WorkerResult: WorkerResultSchema,
  WorkerAdmitRunInput: WorkerAdmitRunInputSchema,
  WorkerArtifactRef: WorkerArtifactRefSchema,
  WorkerReadArtifactInput: WorkerReadArtifactInputSchema,
  WorkerReadArtifactOutput: WorkerReadArtifactOutputSchema,
  WorkerStageArtifactInput: WorkerStageArtifactInputSchema,
  WorkerStageArtifactOutput: WorkerStageArtifactOutputSchema,
  WorkerPublishArtifactInput: WorkerPublishArtifactInputSchema,
  WorkerPublishAgentInput: WorkerPublishAgentInputSchema,
  WorkerPublishCollectionInput: WorkerPublishCollectionInputSchema,
  WorkerActivateCollectionInput: WorkerActivateCollectionInputSchema,
  WorkerReadCollectionInput: WorkerReadCollectionInputSchema,
  WorkerCollectionOutput: WorkerCollectionOutputSchema,
  WorkerCurrentRightsInput: WorkerCurrentRightsInputSchema,
  WorkerCurrentRightsOutput: WorkerCurrentRightsOutputSchema,
  WorkerAcceptedEvidenceInput: WorkerAcceptedEvidenceInputSchema,
  WorkerAcceptedEvidenceOutput: WorkerAcceptedEvidenceOutputSchema,
  WorkerPublishGenesisInput: WorkerPublishGenesisInputSchema,
  WorkerPublishOrderProjectionInput: WorkerPublishOrderProjectionInputSchema,
  WorkerPublishNativeFactsInput: WorkerPublishNativeFactsInputSchema,
  WorkerProjectionAck: WorkerProjectionAckSchema,
  WorkerReadContinuityInput: WorkerReadContinuityInputSchema,
  WorkerReadinessInput: WorkerReadinessInputSchema,
  WorkerPolicySelectionInput: WorkerPolicySelectionInputSchema,
  WorkerServiceGrant: WorkerServiceGrantSchema,
} as const;
