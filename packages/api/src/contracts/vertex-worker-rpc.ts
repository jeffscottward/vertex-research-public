import { oc } from "@orpc/contract";
import type { z } from "zod";
import { ProjectionContinuitySchema } from "./vertex-control.ts";
import { RuntimePolicySelectionSchema } from "./vertex-policy.ts";
import { MAX_NATIVE_OUTBOX_REPLAY_WIRE_BYTES } from "./vertex-worker-epoch.ts";
// biome-ignore lint/performance/noNamespaceImport: the worker RPC surface maps one-to-one onto the full vertex-worker schema module.
import * as worker from "./vertex-worker.ts";

// Public, data-only oRPC metadata. No service, database, credentials or worker
// runtime import may enter this module or its client-side dependency graph.
export const VERTEX_WORKER_REQUEST_MAX_BYTES = 2_097_152;
export const VERTEX_WORKER_REPLAY_REQUEST_MAX_BYTES =
  MAX_NATIVE_OUTBOX_REPLAY_WIRE_BYTES;
export const VERTEX_WORKER_RESPONSE_MAX_BYTES = 2_097_152;
export const VERTEX_WORKER_ARTIFACT_MAX_BYTES = 1_048_576;
const definition = <I extends z.ZodType, O extends z.ZodType>(
  input: I,
  output: O
) => Object.freeze({ input, output });
export const VERTEX_WORKER_METHOD_DEFINITIONS = Object.freeze({
  claim: definition(
    worker.WorkerClaimInputSchema,
    worker.WorkerClaimOutputSchema
  ),
  renew: definition(worker.WorkerRenewInputSchema, worker.WorkerResultSchema),
  complete: definition(
    worker.WorkerCompleteInputSchema,
    worker.WorkerResultSchema
  ),
  cancel: definition(worker.WorkerCancelInputSchema, worker.WorkerResultSchema),
  status: definition(worker.WorkerStatusInputSchema, worker.WorkerResultSchema),
  admitRun: definition(
    worker.WorkerAdmitRunInputSchema,
    worker.WorkerResultSchema
  ),
  readArtifact: definition(
    worker.WorkerReadArtifactInputSchema,
    worker.WorkerReadArtifactOutputSchema
  ),
  readExperiment: definition(
    worker.WorkerReadExperimentInputSchema,
    worker.WorkerReadExperimentOutputSchema
  ),
  readBacktestRun: definition(
    worker.WorkerReadBacktestRunInputSchema,
    worker.WorkerReadBacktestRunOutputSchema
  ),
  readDataset: definition(
    worker.WorkerReadDatasetInputSchema,
    worker.WorkerReadDatasetOutputSchema
  ),
  stageArtifact: definition(
    worker.WorkerStageArtifactInputSchema,
    worker.WorkerStageArtifactOutputSchema
  ),
  publishArtifact: definition(
    worker.WorkerPublishArtifactInputSchema,
    worker.WorkerResultSchema
  ),
  publishAgent: definition(
    worker.WorkerPublishAgentInputSchema,
    worker.WorkerResultSchema
  ),
  publishExperiment: definition(
    worker.WorkerPublishExperimentInputSchema,
    worker.WorkerPublishExperimentOutputSchema
  ),
  publishCollection: definition(
    worker.WorkerPublishCollectionInputSchema,
    worker.WorkerCollectionOutputSchema
  ),
  activateCollection: definition(
    worker.WorkerActivateCollectionInputSchema,
    worker.WorkerCollectionOutputSchema
  ),
  readCollection: definition(
    worker.WorkerReadCollectionInputSchema,
    worker.WorkerCollectionOutputSchema
  ),
  currentRights: definition(
    worker.WorkerCurrentRightsInputSchema,
    worker.WorkerCurrentRightsOutputSchema
  ),
  acceptedEvidence: definition(
    worker.WorkerAcceptedEvidenceInputSchema,
    worker.WorkerAcceptedEvidenceOutputSchema
  ),
  currentRightsObservation: definition(
    worker.WorkerCurrentRightsObservationInputSchema,
    worker.WorkerCurrentRightsObservationOutputSchema
  ),
  acceptedEvidenceObservation: definition(
    worker.WorkerAcceptedEvidenceObservationInputSchema,
    worker.WorkerAcceptedEvidenceObservationOutputSchema
  ),
  publishGenesis: definition(
    worker.WorkerPublishGenesisInputSchema,
    worker.WorkerProjectionAckSchema
  ),
  publishOrderProjection: definition(
    worker.WorkerPublishOrderProjectionInputSchema,
    worker.WorkerProjectionAckSchema
  ),
  publishNativeFacts: definition(
    worker.WorkerPublishNativeFactsInputSchema,
    worker.WorkerProjectionAckSchema
  ),
  readContinuity: definition(
    worker.WorkerReadContinuityInputSchema,
    ProjectionContinuitySchema
  ),
  readiness: definition(
    worker.WorkerReadinessInputSchema,
    worker.WorkerResultSchema
  ),
  policySelection: definition(
    worker.WorkerPolicySelectionInputSchema,
    RuntimePolicySelectionSchema
  ),
  currentPaperAdmission: definition(
    worker.WorkerCurrentPaperAdmissionInputSchema,
    worker.WorkerCurrentPaperAdmissionOutputSchema
  ),
  publishPortfolioSnapshot: definition(
    worker.WorkerPublishPortfolioSnapshotInputSchema,
    worker.WorkerProjectionAckSchema
  ),
  currentModelUse: definition(
    worker.WorkerCurrentModelUseInputSchema,
    worker.WorkerCurrentModelUseOutputSchema
  ),
  prepareModelPrivacyReview: definition(
    worker.WorkerPrepareModelPrivacyReviewInputSchema,
    worker.WorkerModelPrivacyReviewOutputSchema
  ),
  readModelPrivacyReview: definition(
    worker.WorkerReadModelPrivacyReviewInputSchema,
    worker.WorkerModelPrivacyReviewOutputSchema
  ),
  prepareNativeEvidencePhaseTwo: definition(
    worker.WorkerPrepareNativeEvidencePhaseTwoInputSchema,
    worker.WorkerPrepareNativeEvidencePhaseTwoOutputSchema
  ),
  publishEpochTransition: definition(
    worker.WorkerPublishEpochTransitionInputSchema,
    worker.WorkerProjectionAckSchema
  ),
  replayNativeOutbox: definition(
    worker.WorkerReplayNativeOutboxInputSchema,
    worker.WorkerProjectionAckSchema
  ),
});
export type VertexWorkerMethod = keyof typeof VERTEX_WORKER_METHOD_DEFINITIONS;
export type VertexWorkerInput<M extends VertexWorkerMethod> = z.infer<
  (typeof VERTEX_WORKER_METHOD_DEFINITIONS)[M]["input"]
>;
export type VertexWorkerOutput<M extends VertexWorkerMethod> = z.infer<
  (typeof VERTEX_WORKER_METHOD_DEFINITIONS)[M]["output"]
>;
export const VERTEX_WORKER_METHODS = Object.freeze(
  Object.keys(VERTEX_WORKER_METHOD_DEFINITIONS) as VertexWorkerMethod[]
);
export const VERTEX_WORKER_PATHS = Object.freeze(
  VERTEX_WORKER_METHODS.map((method) => `/api/orpc/vertexWorker/${method}`)
);
export const isVertexWorkerPath = (pathname: string): boolean =>
  VERTEX_WORKER_PATHS.includes(pathname);
export const VERTEX_WORKER_OPENAPI_PATHS = Object.freeze(
  VERTEX_WORKER_METHODS.map((method) => `/api/openapi/vertex-worker/${method}`)
);
export const isVertexWorkerRequestPath = (pathname: string): boolean => {
  return (
    isVertexWorkerPath(pathname) ||
    VERTEX_WORKER_OPENAPI_PATHS.includes(pathname)
  );
};
export const vertexWorkerRequestMaxBytes = (
  pathname: string
): number | undefined => {
  // Replay is a bounded immutable native journal bundle, not an exemption for
  // other worker methods or similarly prefixed routes.
  if (
    pathname === "/api/orpc/vertexWorker/replayNativeOutbox" ||
    pathname === "/api/openapi/vertex-worker/replayNativeOutbox"
  ) {
    return VERTEX_WORKER_REPLAY_REQUEST_MAX_BYTES;
  }
  return isVertexWorkerRequestPath(pathname)
    ? VERTEX_WORKER_REQUEST_MAX_BYTES
    : undefined;
};
export const VERTEX_WORKER_SERVICE_ERRORS = Object.freeze({
  BAD_REQUEST: Object.freeze({
    status: 400,
    message: "Invalid worker request",
  }),
  UNAUTHORIZED: Object.freeze({
    status: 401,
    message: "Worker authentication required",
  }),
  FORBIDDEN: Object.freeze({ status: 403, message: "Worker operation denied" }),
  CONFLICT: Object.freeze({
    status: 409,
    message: "Worker identity or lease conflict",
  }),
  PAYLOAD_TOO_LARGE: Object.freeze({
    status: 413,
    message: "Worker payload exceeds limit",
  }),
  SERVICE_UNAVAILABLE: Object.freeze({
    status: 503,
    message: "Worker service unavailable",
  }),
  INVALID_SOURCE: Object.freeze({
    status: 502,
    message: "Invalid worker service response",
  }),
});
export type VertexWorkerServiceErrorCode =
  keyof typeof VERTEX_WORKER_SERVICE_ERRORS;

const workerProcedure = oc.errors(VERTEX_WORKER_SERVICE_ERRORS);
const procedure = <I extends z.ZodType, O extends z.ZodType>(
  method: VertexWorkerMethod,
  schemas: Readonly<{ input: I; output: O }>
) => {
  // Only the static handler input admits an already-frozen valid output.
  // The exact authoritative runtime schema object remains unchanged.
  const output = schemas.output as z.ZodType<
    z.output<O>,
    z.input<O> | z.output<O>
  >;
  return workerProcedure
    .route({
      method: "POST",
      path: `/vertex-worker/${method}`,
      operationId: `vertexWorker.${method}`,
      tags: ["Vertex worker"],
      summary:
        "Invoke an explicitly scoped bearer-authenticated worker operation",
    })
    .input(schemas.input)
    .output(output);
};

export const vertexWorkerContract = {
  claim: procedure("claim", VERTEX_WORKER_METHOD_DEFINITIONS.claim),
  renew: procedure("renew", VERTEX_WORKER_METHOD_DEFINITIONS.renew),
  complete: procedure("complete", VERTEX_WORKER_METHOD_DEFINITIONS.complete),
  cancel: procedure("cancel", VERTEX_WORKER_METHOD_DEFINITIONS.cancel),
  status: procedure("status", VERTEX_WORKER_METHOD_DEFINITIONS.status),
  admitRun: procedure("admitRun", VERTEX_WORKER_METHOD_DEFINITIONS.admitRun),
  readArtifact: procedure(
    "readArtifact",
    VERTEX_WORKER_METHOD_DEFINITIONS.readArtifact
  ),
  readExperiment: procedure(
    "readExperiment",
    VERTEX_WORKER_METHOD_DEFINITIONS.readExperiment
  ),
  readBacktestRun: procedure(
    "readBacktestRun",
    VERTEX_WORKER_METHOD_DEFINITIONS.readBacktestRun
  ),
  readDataset: procedure(
    "readDataset",
    VERTEX_WORKER_METHOD_DEFINITIONS.readDataset
  ),
  stageArtifact: procedure(
    "stageArtifact",
    VERTEX_WORKER_METHOD_DEFINITIONS.stageArtifact
  ),
  publishArtifact: procedure(
    "publishArtifact",
    VERTEX_WORKER_METHOD_DEFINITIONS.publishArtifact
  ),
  publishAgent: procedure(
    "publishAgent",
    VERTEX_WORKER_METHOD_DEFINITIONS.publishAgent
  ),
  publishExperiment: procedure(
    "publishExperiment",
    VERTEX_WORKER_METHOD_DEFINITIONS.publishExperiment
  ),
  publishCollection: procedure(
    "publishCollection",
    VERTEX_WORKER_METHOD_DEFINITIONS.publishCollection
  ),
  activateCollection: procedure(
    "activateCollection",
    VERTEX_WORKER_METHOD_DEFINITIONS.activateCollection
  ),
  readCollection: procedure(
    "readCollection",
    VERTEX_WORKER_METHOD_DEFINITIONS.readCollection
  ),
  currentRights: procedure(
    "currentRights",
    VERTEX_WORKER_METHOD_DEFINITIONS.currentRights
  ),
  acceptedEvidence: procedure(
    "acceptedEvidence",
    VERTEX_WORKER_METHOD_DEFINITIONS.acceptedEvidence
  ),
  currentRightsObservation: procedure(
    "currentRightsObservation",
    VERTEX_WORKER_METHOD_DEFINITIONS.currentRightsObservation
  ),
  acceptedEvidenceObservation: procedure(
    "acceptedEvidenceObservation",
    VERTEX_WORKER_METHOD_DEFINITIONS.acceptedEvidenceObservation
  ),
  publishGenesis: procedure(
    "publishGenesis",
    VERTEX_WORKER_METHOD_DEFINITIONS.publishGenesis
  ),
  publishOrderProjection: procedure(
    "publishOrderProjection",
    VERTEX_WORKER_METHOD_DEFINITIONS.publishOrderProjection
  ),
  publishNativeFacts: procedure(
    "publishNativeFacts",
    VERTEX_WORKER_METHOD_DEFINITIONS.publishNativeFacts
  ),
  readContinuity: procedure(
    "readContinuity",
    VERTEX_WORKER_METHOD_DEFINITIONS.readContinuity
  ),
  readiness: procedure("readiness", VERTEX_WORKER_METHOD_DEFINITIONS.readiness),
  policySelection: procedure(
    "policySelection",
    VERTEX_WORKER_METHOD_DEFINITIONS.policySelection
  ),
  currentPaperAdmission: procedure(
    "currentPaperAdmission",
    VERTEX_WORKER_METHOD_DEFINITIONS.currentPaperAdmission
  ),
  publishPortfolioSnapshot: procedure(
    "publishPortfolioSnapshot",
    VERTEX_WORKER_METHOD_DEFINITIONS.publishPortfolioSnapshot
  ),
  currentModelUse: procedure(
    "currentModelUse",
    VERTEX_WORKER_METHOD_DEFINITIONS.currentModelUse
  ),
  prepareModelPrivacyReview: procedure(
    "prepareModelPrivacyReview",
    VERTEX_WORKER_METHOD_DEFINITIONS.prepareModelPrivacyReview
  ),
  readModelPrivacyReview: procedure(
    "readModelPrivacyReview",
    VERTEX_WORKER_METHOD_DEFINITIONS.readModelPrivacyReview
  ),
  prepareNativeEvidencePhaseTwo: procedure(
    "prepareNativeEvidencePhaseTwo",
    VERTEX_WORKER_METHOD_DEFINITIONS.prepareNativeEvidencePhaseTwo
  ),
  publishEpochTransition: procedure(
    "publishEpochTransition",
    VERTEX_WORKER_METHOD_DEFINITIONS.publishEpochTransition
  ),
  replayNativeOutbox: procedure(
    "replayNativeOutbox",
    VERTEX_WORKER_METHOD_DEFINITIONS.replayNativeOutbox
  ),
};

// All these exact named outputs only freeze/detach; no generic transform policy.
export const VERTEX_WORKER_READONLY_OUTPUTS: readonly z.ZodType[] =
  Object.freeze([
    ...new Set(
      Object.values(VERTEX_WORKER_METHOD_DEFINITIONS).map(
        (entry) => entry.output
      )
    ),
  ]);
