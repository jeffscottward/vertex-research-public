import type { Transaction } from "./client.ts";
import type {
  VertexRecord,
  VertexScope,
  VertexPrincipal,
} from "./vertex-primitives.ts";
import type { VertexResearchChatCopyOperations } from "./vertex-research-chat-copy-ports.ts";

// Internal persistence ports, not alternate public wire schemas. Domain payloads
// MUST pass the injected authoritative @darkfactory/api/vertex validators.
export type {
  VertexEnvironment,
  VertexPrincipal,
  VertexRecord,
  VertexScope,
} from "./vertex-primitives.ts";
export type VertexContractName =
  | "DatasetManifest"
  | "ResearchEvidence"
  | "KnowledgeImport"
  | "StrategySpec"
  | "BacktestRun"
  | "AgentRun"
  | "ModuleManifest"
  | "TradeIntent"
  | "EventEnvelope"
  | "PortfolioSnapshot"
  | "AcceptedReview"
  | "PaperSimulationAdmission"
  | "ExecutionProjection"
  | "NativeFactProjection"
  | "NativeJournalProof";
export type VertexBoundaryContractName =
  | VertexContractName
  | "PortfolioEpochTransition"
  | "NativeOutboxReplayGrant"
  | "NativeOutboxReplay"
  | "ResearchChatThread"
  | "ResearchChatMessage"
  | "ResearchChatAgentReferenceMessage"
  | "ResearchChatAppendResponseOutput"
  | "ResearchChatReadTranscriptPageOutput"
  | "ResearchChatSendMessageOutput"
  | "ResearchChatResponseReceipt"
  | "ResearchChatReadResponseOutput"
  | "ResearchChatCopyCleanupReceipt";
export type VertexResearchChatInputName =
  | "createThread"
  | "sendMessage"
  | "listThreads"
  | "readThread"
  | "listMessages"
  | "readTranscriptPage"
  | "requestResponse"
  | "readResponse"
  | "appendResponse"
  | "requestCopyCleanup"
  | "readCopyCleanup";
export type VertexBoundary = Readonly<{
  validate: (
    contractName: VertexBoundaryContractName,
    payload: unknown,
    schemaVersion: "1.0.0"
  ) => VertexRecord | Promise<VertexRecord>;
  // Optional for existing stores; all chat operations fail closed without the
  // exact API-owned input validators. No duplicate wire schemas in persistence.
  validateResearchChatInput?: (
    name: VertexResearchChatInputName,
    payload: unknown
  ) => VertexRecord | Promise<VertexRecord>;
  encode: (value: unknown) => Uint8Array;
  digest: (value: Uint8Array) => Promise<string>;
}>;
export type VertexClock = Readonly<{ now: () => string }>;
export type VertexAction =
  | "read"
  | "publish"
  | "review"
  | "admit-paper-simulation"
  | "project"
  | "manage-rights"
  | "dispatch-outbox"
  | "cleanup-chat-copies";
export type VertexAuthorization = Readonly<{
  // Absence, throw, non-true and expired grants all deny. No role fallback.
  authorize: (
    input: Readonly<{
      principal: VertexPrincipal;
      scope: VertexScope;
      collectionId: string | null;
      resourceId: string;
      action: VertexAction;
      now: string;
    }>
  ) => Promise<boolean>;
}>;
export type VertexRightsRecord = Readonly<{
  policyId: string;
  version: string;
  status: "granted" | "denied" | "expired" | "unknown";
  allowedUses: readonly ("store" | "read" | "derive" | "export")[];
  checkedAt: string;
  expiresAt: string | null;
  retentionUntil: string | null;
}>;
export type VertexArtifactMetadata = Readonly<{
  artifactId: string;
  scope: VertexScope;
  collectionId: string | null;
  objectKey: string;
  artifactSha256: string;
  sourceContentSha256: string | null;
  byteLength: number;
  contentType: string;
  schemaVersion: "1.0.0";
  contractName: VertexContractName | "ModuleManifestList";
  rights: VertexRightsRecord;
  lineageArtifactIds: readonly string[];
  createdAt: string;
}>;
export type VertexArtifactReference = Readonly<{
  artifactId: string;
  artifactSha256: string;
}>;
export type VertexPublicationInput = Readonly<{
  principal: VertexPrincipal;
  scope: VertexScope;
  collectionId: string;
  expectedActiveSnapshotId: string | null;
  // 1..64 independently valid <=512-source shards, same collection/snapshot.
  // Unique global source IDs; one generation CAS activates ALL shards or none.
  imports: readonly Readonly<{
    record: unknown;
    artifact: VertexArtifactReference;
  }>[];
  // Every evidence/dataset is a validated immutable record plus its separately
  // sealed manifest reference. Source content hashes never become manifest hashes.
  evidence: readonly Readonly<{
    record: unknown;
    artifact: VertexArtifactReference;
  }>[];
  datasets: readonly Readonly<{
    record: unknown;
    artifact: VertexArtifactReference;
  }>[];
  idempotencyKey: string;
}>;
export type VertexPublicationResult = Readonly<{
  status: "published" | "duplicate";
  snapshotId: string;
  previousSnapshotId: string | null;
}>;
export type VertexImmutableInput = Readonly<{
  principal: VertexPrincipal;
  scope: VertexScope;
  collectionId: string | null;
  contractName:
    | "StrategySpec"
    | "BacktestRun"
    | "AgentRun"
    | "ModuleManifest"
    | "DatasetManifest"
    | "ResearchEvidence"
    | "TradeIntent";
  record: unknown;
  artifact: VertexArtifactReference;
  idempotencyKey: string;
}>;
export type VertexRecordResult = Readonly<{
  status: "recorded" | "duplicate";
  recordId: string;
  artifactId: string;
}>;
export type VertexProjectionResult = Readonly<{
  status: "applied" | "duplicate" | "gap" | "epoch-mismatch" | "stale";
  highWaterSequence: string;
  highWaterEventHash: string | null;
}>;
export type VertexOutboxLease = Readonly<{
  eventId: string;
  scope: VertexScope;
  collectionId: string | null;
  eventType: string;
  payload: VertexRecord;
  leaseOwner: string;
  leaseFence: string;
  leaseExpiresAt: string;
}>;
export type VertexPageOptions = Readonly<{
  limit: number;
  cursor: string | null;
}>;
export type VertexPage<T> = Readonly<{
  items: readonly T[];
  nextCursor: string | null;
}>;
export type VertexArtifactListInput = VertexPageOptions &
  Readonly<{
    contractName: VertexImmutableInput["contractName"];
    collectionId?: string | null;
    strategyVersion?: string;
  }>;
export type VertexRecordLookup = Readonly<{
  contractName?: VertexImmutableInput["contractName"];
  recordId?: string;
  artifactId?: string;
}>;
export type VertexScopedRecordListInput = VertexPageOptions &
  Readonly<{ strategyVersion?: string }>;
export type VertexCommandPolicyIdentity = Readonly<{
  selectionId: string;
  selectionSha256: string;
  selectionRevision: string;
  // Current policy-head CAS revision, distinct from the immutable selection.
  revision: string;
}>;
export type VertexCommandPolicyGuard = (
  tx: Transaction,
  input: Readonly<{
    principal: VertexPrincipal;
    scope: VertexScope;
    kind: VertexCommandKey["kind"];
    commandPolicy: VertexCommandPolicyIdentity;
    now: string;
  }>
) => Promise<boolean>;
export type VertexCommandKey = Readonly<{
  kind: "review" | "research" | "simulation";
  idempotencyKey: string;
  requestHash: string;
  command: VertexRecord;
  // Server-only pin, separate from the strict client command and request hash.
  commandPolicy?: VertexCommandPolicyIdentity;
}>;
export type VertexPreparedRecord = Readonly<{
  record: unknown;
  metadata: VertexArtifactMetadata;
}>;
export type VertexReviewedEvidenceInput = Readonly<{
  principal: VertexPrincipal;
  scope: VertexScope;
  review: unknown;
  // Review is an immutable overlay; derived acceptance-flag artifacts forbidden.
  acceptedEvidence: null;
  idempotencyKey: string;
  requestHash: string;
  command: VertexRecord;
  commandPolicy?: VertexCommandPolicyIdentity;
}>;
export type VertexResearchProposalInput = Readonly<{
  principal: VertexPrincipal;
  scope: VertexScope;
  collectionId: string;
  record: unknown;
  metadata: VertexArtifactMetadata;
  proposal: Readonly<{
    question: string;
    evidenceIds: readonly string[];
    role: string;
    proposalOnly: true;
    executionAuthorized: false;
  }>;
  idempotencyKey: string;
  requestHash: string;
  command: VertexRecord;
  commandPolicy?: VertexCommandPolicyIdentity;
}>;
export type VertexSimulationCommandInput = Readonly<{
  principal: VertexPrincipal;
  scope: VertexScope;
  admission: unknown;
  idempotencyKey: string;
  requestHash: string;
  command: VertexRecord;
  commandPolicy?: VertexCommandPolicyIdentity;
}>;
export type VertexAcceptedEvidence = Readonly<{
  artifact: VertexArtifactMetadata;
  evidence: VertexRecord;
  review: VertexRecord;
}>;

export type VertexStore = VertexResearchChatCopyOperations &
  Readonly<{
    putRights: (
      principal: VertexPrincipal,
      scope: VertexScope,
      collectionId: string | null,
      rights: VertexRightsRecord
    ) => Promise<void>;
    getRights: (
      principal: VertexPrincipal,
      scope: VertexScope,
      collectionId: string | null,
      policyId: string
    ) => Promise<VertexRightsRecord | null>;
    registerArtifact: (
      principal: VertexPrincipal,
      artifact: VertexArtifactMetadata
    ) => Promise<"recorded" | "duplicate">;
    findArtifact: (
      principal: VertexPrincipal,
      scope: VertexScope,
      collectionId: string | null,
      artifactId: string
    ) => Promise<VertexArtifactMetadata | null>;
    publishCollectionSnapshot: (
      input: VertexPublicationInput
    ) => Promise<VertexPublicationResult>;
    getActiveCollectionSnapshot: (
      principal: VertexPrincipal,
      scope: VertexScope,
      collectionId: string
    ) => Promise<Readonly<{
      snapshotId: string;
      importArtifacts: readonly VertexArtifactReference[];
    }> | null>;
    recordImmutable: (
      input: VertexImmutableInput
    ) => Promise<VertexRecordResult>;
    findDataset: (
      principal: VertexPrincipal,
      scope: VertexScope,
      datasetId: string,
      collectionId?: string | null
    ) => Promise<VertexArtifactMetadata | null>;
    findEvidence: (
      principal: VertexPrincipal,
      scope: VertexScope,
      collectionId: string,
      evidenceId: string
    ) => Promise<VertexArtifactMetadata | null>;
    findModuleCatalog: (
      principal: VertexPrincipal,
      scope: VertexScope
    ) => Promise<VertexArtifactMetadata | null>;
    recordReview: (
      principal: VertexPrincipal,
      scope: VertexScope,
      review: unknown
    ) => Promise<"recorded" | "duplicate">;
    listReviews: (
      principal: VertexPrincipal,
      scope: VertexScope,
      artifactId: string
    ) => Promise<readonly VertexRecord[]>;
    admitPaperSimulation: (
      principal: VertexPrincipal,
      scope: VertexScope,
      admission: unknown
    ) => Promise<"admitted" | "duplicate">;
    appendExecutionProjection: (
      principal: VertexPrincipal,
      scope: VertexScope,
      projection: unknown
    ) => Promise<VertexProjectionResult>;
    appendNativeFactProjection: (
      principal: VertexPrincipal,
      scope: VertexScope,
      projection: unknown,
      proofBytes: Uint8Array
    ) => Promise<VertexProjectionResult>;
    recordPortfolioSnapshot: (
      principal: VertexPrincipal,
      scope: VertexScope,
      snapshot: unknown
    ) => Promise<"recorded" | "duplicate">;
    getPortfolioSnapshot: (
      principal: VertexPrincipal,
      scope: VertexScope
    ) => Promise<VertexRecord | null>;
    getContinuity: (
      principal: VertexPrincipal,
      scope: VertexScope,
      streamId: string
    ) => Promise<VertexRecord | null>;
    enqueueEvent: (
      principal: VertexPrincipal,
      scope: VertexScope,
      collectionId: string | null,
      event: unknown
    ) => Promise<"recorded" | "duplicate">;
    claimOutbox: (
      principal: VertexPrincipal,
      scope: VertexScope,
      input: Readonly<{
        leaseOwner: string;
        limit: number;
        leaseExpiresAt: string;
      }>
    ) => Promise<readonly VertexOutboxLease[]>;
    settleOutbox: (
      principal: VertexPrincipal,
      scope: VertexScope,
      input: Readonly<{
        eventId: string;
        leaseOwner: string;
        leaseFence: string;
        result: "published" | "retry";
        availableAt: string;
      }>
    ) => Promise<boolean>;
    listArtifacts: (
      principal: VertexPrincipal,
      scope: VertexScope,
      input: VertexArtifactListInput
    ) => Promise<VertexPage<VertexArtifactMetadata>>;
    findRecordArtifact: (
      principal: VertexPrincipal,
      scope: VertexScope,
      input: VertexRecordLookup
    ) => Promise<VertexArtifactMetadata | null>;
    getAcceptedEvidence: (
      principal: VertexPrincipal,
      scope: VertexScope,
      collectionId: string,
      evidenceId: string
    ) => Promise<VertexAcceptedEvidence | null>;
    listScopeReviews: (
      principal: VertexPrincipal,
      scope: VertexScope,
      input: VertexScopedRecordListInput
    ) => Promise<VertexPage<VertexRecord>>;
    listPaperAdmissions: (
      principal: VertexPrincipal,
      scope: VertexScope,
      input: VertexScopedRecordListInput
    ) => Promise<VertexPage<VertexRecord>>;
    listExecutionProjections: (
      principal: VertexPrincipal,
      scope: VertexScope,
      input: VertexScopedRecordListInput
    ) => Promise<VertexPage<VertexRecord>>;
    getCommandReceipt: (
      principal: VertexPrincipal,
      scope: VertexScope,
      key: VertexCommandKey
    ) => Promise<VertexRecord | null>;
    recordReviewedEvidence: (
      input: VertexReviewedEvidenceInput
    ) => Promise<VertexRecord>;
    enqueueResearchProposal: (
      input: VertexResearchProposalInput
    ) => Promise<VertexRecord>;
    queuePaperSimulation: (
      input: VertexSimulationCommandInput
    ) => Promise<VertexRecord>;
    // Human-only transcript persistence does not resolve a selected research
    // policy or require any model/corpus/runtime readiness.
    listResearchChatThreads: (
      principal: VertexPrincipal,
      scope: VertexScope,
      page: VertexPageOptions
    ) => Promise<VertexPage<VertexRecord>>;
    createResearchChatThread: (
      input: Readonly<{
        principal: VertexPrincipal;
        scope: VertexScope;
        title: string;
        participantIds: readonly string[];
        idempotencyKey: string;
      }>
    ) => Promise<VertexRecord>;
    readResearchChatThread: (
      principal: VertexPrincipal,
      scope: VertexScope,
      threadId: string
    ) => Promise<VertexRecord | null>;
    listResearchChatMessages: (
      principal: VertexPrincipal,
      scope: VertexScope,
      threadId: string,
      page: VertexPageOptions
    ) => Promise<VertexPage<VertexRecord>>;
    readResearchChatTranscriptPage: (
      principal: VertexPrincipal,
      scope: VertexScope,
      threadId: string,
      page: VertexPageOptions
    ) => Promise<VertexRecord | null>;
    sendResearchChatMessage: (
      input: Readonly<{
        principal: VertexPrincipal;
        scope: VertexScope;
        threadId: string;
        expectedRevision: string;
        idempotencyKey: string;
        body: string;
        requestedParticipantIds: readonly string[];
        mode: "discuss" | "debate";
      }>
    ) => Promise<VertexRecord>;
    // Metadata-only unavailable acknowledgements, not model/job admission.
    requestResearchChatResponse: (
      input: Readonly<{
        principal: VertexPrincipal;
        scope: VertexScope;
        threadId: string;
        parentMessageId: string;
        participantId: string;
        snapshotRevision: string;
        contextStartSequence: string;
        retrievalQuery: string;
        idempotencyKey: string;
      }>
    ) => Promise<VertexRecord>;
    readResearchChatResponse: (
      principal: VertexPrincipal,
      scope: VertexScope,
      threadId: string,
      idempotencyKey: string
    ) => Promise<VertexRecord | null>;
  }>;

export class VertexStoreError extends Error {
  readonly code:
    | "unavailable"
    | "denied"
    | "invalid"
    | "conflict"
    | "integrity"
    | "stale";
  constructor(code: VertexStoreError["code"]) {
    super(`Vertex persistence ${code}`);
    this.name = "VertexStoreError";
    this.code = code;
  }
}
