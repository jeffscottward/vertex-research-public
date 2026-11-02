import type {
  VertexOutboxLease,
  VertexRecord,
} from "@darkfactory/db/server/vertex";
import type {
  WorkerDispatchBinding,
  WorkerServiceIdentity,
} from "@darkfactory/db/server/vertex-worker";
import type { NotificationDispatchEvent } from "@darkfactory/notifications/server/dispatch";

// Internal read-only port views, NOT public validators or alternate wire
// schemas. API composition injects the authoritative parsers and hash profile.
export type WorkerKind = WorkerDispatchBinding["kind"];
export type WorkerScope = Readonly<{
  accountAlias: string;
  environment: "research" | "paper";
}>;
export type WorkerLease = Readonly<{
  schemaVersion: "1.0.0";
  jobId: string;
  eventId: string;
  kind: WorkerKind;
  researchPrincipalId: string;
  accountAlias: string;
  environment: "research" | "paper";
  payloadArtifactId: string;
  payloadSha256: string;
  policySelectionId: string;
  policySelectionSha256: string;
  deadlineAt: string;
  leaseId: string;
  leaseEpoch: string;
  leaseExpiresAt: string;
  attempt: number;
}>;
export type WorkerClaimInput = Readonly<
  WorkerScope & {
    workerInstanceId: string;
    kinds: WorkerKind[];
    limit: number;
    leaseDurationMs: number;
  }
>;
export interface WorkerClaimOutput {
  status: "accepted" | "rejected";
  leases: WorkerLease[];
}
export type WorkerResult = Readonly<{
  status: "accepted" | "duplicate" | "unknown" | "completed" | "rejected";
  jobId: string;
  state:
    | "leased"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "unknown";
  lease: WorkerLease | null;
  outputArtifactIds: readonly string[];
  reason:
    | "stale-lease"
    | "denied"
    | "deadline"
    | "conflict"
    | "unavailable"
    | "not-found"
    | null;
}>;
export type EventEnvelope = Readonly<
  VertexRecord & {
    eventId: string;
    eventType: string;
    actorId: string;
    environment: string;
    occurredAt: string;
    payload: VertexRecord;
  }
>;
export type PaperAdmission = Readonly<
  VertexRecord & {
    accountAlias: string;
    environment: "paper";
    actorId: string;
    expiresAt: string;
  }
>;
export type NativeBootstrapCommand = Readonly<
  VertexRecord &
    WorkerScope & {
      researchPrincipalId: string;
      payloadArtifactId: string;
      payloadSha256: string;
      policySelectionId: string;
      policySelectionSha256: string;
      issuedAt: string;
      deadlineAt: string;
    }
>;
export type VertexWorkerBindingSelection = Omit<
  WorkerDispatchBinding,
  "workerInstanceId"
>;
export type VertexNotificationSelection = Readonly<{
  kind: NotificationDispatchEvent["kind"];
  expiresAt: string;
}>;
export interface VertexWorkerBoundaryValues {
  Identifier: string;
  Digest: string;
  Timestamp: string;
  WorkerScope: WorkerScope;
  WorkerServiceIdentity: WorkerServiceIdentity &
    Readonly<{ scope: WorkerScope }>;
  WorkerDispatchSelection: VertexWorkerBindingSelection;
  WorkerNotificationSelection: VertexNotificationSelection;
  VertexOutboxLease: VertexOutboxLease;
  EventEnvelope: EventEnvelope;
  PaperSimulationAdmission: PaperAdmission;
  WorkerBootstrapCommand: NativeBootstrapCommand;
  WorkerClaimInput: WorkerClaimInput;
  WorkerClaimOutput: WorkerClaimOutput;
  WorkerResult: WorkerResult;
}
export type VertexWorkerDispatchBoundary = Readonly<{
  validate: (name: keyof VertexWorkerBoundaryValues, value: unknown) => unknown;
  hash: (value: unknown) => Promise<string>;
  epochNanoseconds: (timestamp: string) => bigint;
}>;
