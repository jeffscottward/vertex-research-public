import { z } from "zod";
import {
  deepFreezeArtifact,
  hashArtifact,
  timestampToEpochNanoseconds,
} from "@darkfactory/shared/vertex";
import type {
  VertexWorkerStore,
  WorkerServiceIdentity,
} from "@darkfactory/db/server/vertex-worker";
import {
  DigestSchema,
  EventEnvelopeSchema,
  IdentifierSchema,
  TimestampSchema,
} from "../contracts/vertex.ts";
import { PaperSimulationAdmissionSchema } from "../contracts/vertex-control.ts";
import {
  WorkerBootstrapCommandSchema,
  WorkerClaimInputSchema,
  WorkerClaimOutputSchema,
  WorkerEpochSchema,
  WorkerKindSchema,
  type WorkerLease,
  WorkerResultSchema,
  WorkerScopeSchema,
} from "../contracts/vertex-worker.ts";
import { MAX_NATIVE_OUTBOX_REPLAY_WIRE_BYTES } from "../contracts/vertex-worker-epoch.ts";
import {
  VERTEX_WORKER_METHOD_DEFINITIONS,
  VERTEX_WORKER_REQUEST_MAX_BYTES,
  VERTEX_WORKER_RESPONSE_MAX_BYTES,
  VERTEX_WORKER_ARTIFACT_MAX_BYTES,
  type VertexWorkerMethod,
  type VertexWorkerInput,
  type VertexWorkerOutput,
  type VertexWorkerServiceErrorCode,
} from "../contracts/vertex-worker-rpc.ts";

import {
  VertexWorkerServiceError,
  IdentitySchema,
  boundedJson,
  parse,
  authenticateVertexWorkerRequest,
  sourceFailure,
  type VertexWorkerRequestContext,
} from "./vertex-worker-auth.ts";

export type VertexWorkerServiceDependencies = Readonly<{
  store: Pick<VertexWorkerStore, "authenticate" | "invoke">;
  claim: (
    identity: WorkerServiceIdentity,
    input: VertexWorkerInput<"claim">,
    options: Readonly<{ signal?: AbortSignal }>
  ) => Promise<VertexWorkerOutput<"claim">>;
  clock: Readonly<{ now: () => string }>;
}>;
export type VertexWorkerService = Readonly<{
  invoke: <M extends VertexWorkerMethod>(
    context: VertexWorkerRequestContext,
    method: M,
    input: unknown
  ) => Promise<VertexWorkerOutput<M>>;
}>;
// Private server port views only. Public worker/event validators below are the
// original authoritative objects, never a duplicated schema in Jobs.
const DispatchSelectionSchema = z
  .object({
    kind: WorkerKindSchema,
    researchPrincipalId: IdentifierSchema,
    payloadArtifactId: IdentifierSchema,
    payloadSha256: DigestSchema,
    policySelectionId: IdentifierSchema,
    policySelectionSha256: DigestSchema,
    deadlineAt: TimestampSchema,
  })
  .strict();
const OutboxLeaseSchema = z
  .object({
    eventId: IdentifierSchema,
    scope: WorkerScopeSchema,
    collectionId: IdentifierSchema.nullable(),
    eventType: z.string().min(1).max(128),
    payload: z.record(z.string(), z.unknown()),
    leaseOwner: IdentifierSchema,
    leaseFence: WorkerEpochSchema,
    leaseExpiresAt: TimestampSchema,
  })
  .strict();
const NotificationSelectionSchema = z
  .object({
    kind: z.enum([
      "market-alert",
      "research-completed",
      "research-failed",
      "operational-alert",
    ]),
    expiresAt: TimestampSchema,
  })
  .strict();
const dispatchSchemas = Object.freeze({
  Identifier: IdentifierSchema,
  Digest: DigestSchema,
  Timestamp: TimestampSchema,
  WorkerScope: WorkerScopeSchema,
  WorkerServiceIdentity: IdentitySchema,
  WorkerDispatchSelection: DispatchSelectionSchema,
  WorkerNotificationSelection: NotificationSelectionSchema,
  VertexOutboxLease: OutboxLeaseSchema,
  EventEnvelope: EventEnvelopeSchema,
  PaperSimulationAdmission: PaperSimulationAdmissionSchema,
  WorkerBootstrapCommand: WorkerBootstrapCommandSchema,
  WorkerClaimInput: WorkerClaimInputSchema,
  WorkerClaimOutput: WorkerClaimOutputSchema,
  WorkerResult: WorkerResultSchema,
});

const validateBinaryFields = (
  value: unknown,
  code: VertexWorkerServiceErrorCode
): void => {
  if (value === null || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  for (const field of [
    "contentBase64",
    "proofBase64",
    "approvalBase64",
    "projectionBase64",
    "retainedEpochTransitionBase64",
  ]) {
    if (!(field in record) || record[field] === null) continue;
    try {
      const encoded = record[field];
      if (typeof encoded !== "string") throw new VertexWorkerServiceError(code);
      const decoded = atob(encoded);
      if (
        decoded.length > VERTEX_WORKER_ARTIFACT_MAX_BYTES ||
        btoa(decoded) !== encoded
      )
        throw new VertexWorkerServiceError(code);
    } catch {
      throw new VertexWorkerServiceError(code);
    }
  }
  for (const child of Object.values(record)) {
    if (child !== null && typeof child === "object")
      validateBinaryFields(child, code);
  }
};

export const createVertexWorkerDispatchBoundary = () =>
  Object.freeze({
    validate: (name: keyof typeof dispatchSchemas, value: unknown): unknown => {
      if (!Object.hasOwn(dispatchSchemas, name))
        throw new VertexWorkerServiceError("INVALID_SOURCE");
      boundedJson(value, VERTEX_WORKER_REQUEST_MAX_BYTES, "INVALID_SOURCE");
      return deepFreezeArtifact(
        parse(
          dispatchSchemas[name] as z.ZodType<unknown>,
          value,
          "INVALID_SOURCE"
        )
      );
    },
    hash: hashArtifact,
    epochNanoseconds: (timestamp: string): bigint =>
      timestampToEpochNanoseconds(
        parse(TimestampSchema, timestamp, "INVALID_SOURCE")
      ),
  });

const validateResponseBinding = async (
  method: VertexWorkerMethod,
  input: Record<string, unknown>,
  raw: unknown
): Promise<void> => {
  const output = raw as Record<string, unknown>;
  const invalid = (): never => {
    throw new VertexWorkerServiceError("INVALID_SOURCE");
  };
  if (method === "currentRightsObservation") {
    return validateResponseBinding("currentRights", input, output["value"]);
  }
  if (method === "acceptedEvidenceObservation") {
    const accepted = output["value"] as VertexWorkerOutput<"acceptedEvidence">;
    if (
      accepted.evidence.evidenceId !== input["evidenceId"] ||
      accepted.evidence.collectionId !== input["collectionId"] ||
      accepted.review.collectionId !== input["collectionId"] ||
      accepted.review.accountAlias !== input["accountAlias"] ||
      accepted.review.environment !== input["environment"] ||
      accepted.review.artifactId !== accepted.artifact.artifactId ||
      accepted.review.artifactSha256 !== accepted.artifact.artifactSha256
    )
      invalid();
    return validateResponseBinding("acceptedEvidence", input, accepted);
  }
  for (const field of [
    "jobId",
    "accountAlias",
    "environment",
    "collectionId",
  ]) {
    if (method === "readBacktestRun" && field === "jobId") continue;
    if (field in output && field in input && output[field] !== input[field])
      invalid();
  }
  if (output["lease"] !== undefined && output["lease"] !== null) {
    const lease = output["lease"] as WorkerLease;
    if (
      lease.jobId !== input["jobId"] ||
      lease.accountAlias !== input["accountAlias"] ||
      lease.environment !== input["environment"]
    )
      invalid();
    if (
      "leaseId" in input &&
      (lease.leaseId !== input["leaseId"] ||
        lease.leaseEpoch !== input["leaseEpoch"])
    )
      invalid();
  }
  if (method === "claim") {
    const claimInput = input as VertexWorkerInput<"claim">;
    const claimOutput = raw as VertexWorkerOutput<"claim">;
    if (
      claimOutput.leases.length > claimInput.limit ||
      (claimOutput.status === "rejected" && claimOutput.leases.length !== 0)
    )
      invalid();
    const jobs = new Set<string>();
    const events = new Set<string>();
    for (const lease of claimOutput.leases) {
      if (
        lease.accountAlias !== claimInput.accountAlias ||
        lease.environment !== claimInput.environment ||
        lease.leaseId !== claimInput.workerInstanceId ||
        !claimInput.kinds.includes(lease.kind) ||
        jobs.has(lease.jobId) ||
        events.has(lease.eventId)
      )
        invalid();
      jobs.add(lease.jobId);
      events.add(lease.eventId);
    }
  }
  if (
    (method === "readArtifact" || method === "stageArtifact") &&
    (output["artifact"] as { artifactId: string }).artifactId !==
      input["artifactId"]
  )
    invalid();
  if (method === "publishExperiment") {
    const artifact = output["artifact"] as {
      artifactId: string;
      artifactSha256: string;
    };
    if (
      output["experimentId"] !== input["experimentId"] ||
      artifact.artifactSha256 !== input["contentSha256"] ||
      artifact.artifactId !==
        `experiment-${await hashArtifact({ collectionId: input["collectionId"], experimentId: input["experimentId"] })}`
    )
      invalid();
  }
  if (method === "readExperiment") {
    const expected = input["artifact"] as {
      artifactId: string;
      artifactSha256: string;
    };
    const artifact = output["artifact"] as {
      artifactId: string;
      artifactSha256: string;
    };
    if (
      output["experimentId"] !== input["experimentId"] ||
      artifact.artifactId !== expected.artifactId ||
      artifact.artifactSha256 !== expected.artifactSha256 ||
      output["contentSha256"] !== expected.artifactSha256 ||
      output["canonicalSha256"] !== expected.artifactSha256 ||
      artifact.artifactId !==
        `experiment-${await hashArtifact({ collectionId: input["collectionId"], experimentId: input["experimentId"] })}`
    )
      invalid();
  }
  if (method === "readBacktestRun") {
    for (const field of ["artifact", "plannedRun", "results", "recipe"]) {
      const expected = input[field] as {
        artifactId: string;
        artifactSha256: string;
      };
      const actual = output[field] as {
        artifactId: string;
        artifactSha256: string;
      };
      if (
        actual.artifactId !== expected.artifactId ||
        actual.artifactSha256 !== expected.artifactSha256
      )
        invalid();
    }
    const artifact = output["artifact"] as { artifactSha256: string };
    if (
      output["contentSha256"] !== artifact.artifactSha256 ||
      output["canonicalSha256"] !== artifact.artifactSha256
    )
      invalid();
    if (
      (input["experiment"] === undefined) !==
      (output["experiment"] === undefined)
    )
      invalid();
    if (
      input["experiment"] !== undefined &&
      (await hashArtifact(input["experiment"])) !==
        (await hashArtifact(output["experiment"]))
    )
      invalid();
  }
  if (method === "readDataset") {
    const expected = input["manifest"] as {
      artifactId: string;
      artifactSha256: string;
    };
    const actual = output["manifest"] as {
      artifactId: string;
      artifactSha256: string;
    };
    const artifact = output["artifact"] as {
      artifactId: string;
      artifactSha256: string;
    };
    if (
      actual.artifactId !== expected.artifactId ||
      actual.artifactSha256 !== expected.artifactSha256 ||
      output["member"] !== input["member"] ||
      (await hashArtifact(output["source"])) !==
        (await hashArtifact(input["source"])) ||
      output["contentSha256"] !== artifact.artifactSha256 ||
      output["canonicalSha256"] !== null
    )
      invalid();
    if (input["member"] === "capture") {
      const source = input["source"] as { contentHash: string };
      if (
        artifact.artifactId !== `blob-${source.contentHash}` ||
        artifact.artifactSha256 !== source.contentHash
      )
        invalid();
    }
  }
  if (method === "currentRights" && output["policyId"] !== input["policyId"])
    invalid();
  if (method === "readContinuity" && output["streamId"] !== input["streamId"])
    invalid();
  if (method === "policySelection") {
    if (
      output["selectionId"] !== input["selectionId"] ||
      output["selectionSha256"] !== input["selectionSha256"]
    )
      invalid();
    const { selectionSha256: omittedDigest, ...body } = output;
    if ((await hashArtifact(body)) !== output["selectionSha256"]) invalid();
  }
  if (
    (method === "prepareModelPrivacyReview" ||
      method === "readModelPrivacyReview") &&
    (output["requestId"] !== input["requestId"] ||
      output["requestSha256"] !== input["requestSha256"])
  )
    invalid();
  if (method === "prepareNativeEvidencePhaseTwo") {
    const request = input["request"] as { requestSha256: string },
      phase = output["phase"] as {
        accountAlias: string;
        environment: string;
        phaseOrdinal: number;
        derivation: { phaseOneRequestSha256: string };
      };
    if (
      phase.accountAlias !== input["accountAlias"] ||
      phase.environment !== input["environment"] ||
      phase.phaseOrdinal !== 2 ||
      phase.derivation.phaseOneRequestSha256 !== request.requestSha256
    )
      invalid();
  }
  if (method === "currentModelUse") {
    for (const field of [
      "requestId",
      "requestSha256",
      "researchPrincipalId",
      "consumerServiceId",
      "selectionId",
      "selectionSha256",
      "grantId",
      "grantVersion",
      "operation",
      "leaseId",
      "leaseEpoch",
      "providerId",
      "modelVersion",
      "tokenizerArtifactId",
      "tokenizerSha256",
      "endpointReferenceId",
      "endpointSha256",
      "modelUsePolicyVersion",
    ]) {
      if (output[field] !== input[field]) invalid();
    }
    if (
      output["currentEvidenceSha256"] !==
      (await hashArtifact(input["evidence"]))
    )
      invalid();
  }
  if (method === "currentPaperAdmission") {
    const paper = raw as VertexWorkerOutput<"currentPaperAdmission">;
    if (
      paper.admission.admissionId !== input["admissionId"] ||
      paper.admission.accountAlias !== input["accountAlias"] ||
      paper.admission.environment !== input["environment"] ||
      paper.intentArtifact.artifactId !== input["intentArtifactId"] ||
      paper.intentArtifact.artifactSha256 !== input["intentSha256"] ||
      paper.admission.intentSha256 !== input["intentSha256"] ||
      paper.review.artifactSha256 !== input["intentSha256"]
    )
      invalid();
  }
  if (
    ["admitRun", "publishArtifact", "publishAgent", "readiness"].includes(
      method
    ) &&
    output["status"] === "completed"
  )
    invalid();
};

export const createVertexWorkerService = (
  dependencies: VertexWorkerServiceDependencies
): VertexWorkerService =>
  Object.freeze({
    invoke: async <M extends VertexWorkerMethod>(
      context: VertexWorkerRequestContext,
      method: M,
      raw: unknown
    ): Promise<VertexWorkerOutput<M>> => {
      try {
        if (!Object.hasOwn(VERTEX_WORKER_METHOD_DEFINITIONS, method))
          throw new VertexWorkerServiceError("BAD_REQUEST");
        boundedJson(
          raw,
          method === "replayNativeOutbox"
            ? MAX_NATIVE_OUTBOX_REPLAY_WIRE_BYTES
            : VERTEX_WORKER_REQUEST_MAX_BYTES,
          "PAYLOAD_TOO_LARGE"
        );
        const selected = VERTEX_WORKER_METHOD_DEFINITIONS[method];
        const input = parse(
          selected.input as z.ZodType<Record<string, unknown>>,
          raw,
          "BAD_REQUEST"
        );
        validateBinaryFields(input, "BAD_REQUEST");
        const scope = parse(
          WorkerScopeSchema,
          {
            accountAlias: input["accountAlias"],
            environment: input["environment"],
          },
          "BAD_REQUEST"
        );
        if (!(dependencies?.store && dependencies.clock && dependencies.claim))
          throw new VertexWorkerServiceError("SERVICE_UNAVAILABLE");
        const identity = await authenticateVertexWorkerRequest(
          context,
          scope,
          method,
          dependencies.store,
          dependencies.clock
        );
        // invoke rechecks current DB grant, scope, operation and lease fence in its
        // transaction. Authentication above is NEVER a cached authorization grant.
        const result =
          method === "claim"
            ? await dependencies.claim(
                identity,
                input as VertexWorkerInput<"claim">,
                {
                  ...(context.signal === undefined
                    ? {}
                    : { signal: context.signal }),
                }
              )
            : await dependencies.store.invoke(identity, method, input);
        boundedJson(result, VERTEX_WORKER_RESPONSE_MAX_BYTES, "INVALID_SOURCE");
        const output = parse(
          selected.output as z.ZodType<unknown>,
          result,
          "INVALID_SOURCE"
        ) as VertexWorkerOutput<M>;
        validateBinaryFields(output, "INVALID_SOURCE");
        await validateResponseBinding(method, input, output);
        return output;
      } catch (error) {
        return sourceFailure(error);
      }
    },
  });
