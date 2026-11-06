import type { Transaction } from "./client.ts";
import type { VertexPrincipal, VertexRecord } from "./vertex-ports.ts";
import type { ResearchChatWorkerOperations } from "./vertex-research-chat-worker-store.ts";
import type {
  ResearchChatSourceInputPort,
  ResearchChatSourceInputs,
  ResearchChatSourceRequest,
} from "./vertex-research-chat-source-ports.ts";
import type { WorkerServiceIdentity } from "./vertex-worker-credentials.ts";

// Private server composition only. The DB depends on the actual operations it
// consumes, never on the higher-layer API implementation or its declaration tree.
// These types issue no authority and replace no source/privacy/provenance checks.
type Scope = ResearchChatSourceRequest["scope"];
type Copies = ResearchChatWorkerOperations["copies"];
type Original = Exclude<
  NonNullable<
    Awaited<ReturnType<ResearchChatWorkerOperations["originalForTransaction"]>>
  >,
  { closed: true }
>;
export type ResearchChatOutputMetadata = VertexRecord &
  Readonly<{
    responseRequestId: string;
    planId: string;
    planSha256: string;
    copyId: string;
    contentSha256: string;
    byteLength: number;
  }>;
type Artifact = Readonly<{ artifactId: string; artifactSha256: string }>;
type Publication = Readonly<{
  run: VertexRecord;
  artifact: Artifact;
  advisory: Artifact;
  job: VertexRecord;
  publishedAt: string;
}>;
export type ResearchChatOutputPrepared = Readonly<{
  claim: NonNullable<
    Awaited<ReturnType<Copies["claimAdvisoryForTransaction"]>>
  >;
  metadata: ResearchChatOutputMetadata;
  request: VertexRecord;
  bytes: Uint8Array;
  duplicate: boolean;
  sourceInputs?: ResearchChatSourceInputs;
}>;
export type ResearchChatOutputPort = ResearchChatSourceInputPort &
  Readonly<{
    // External copy I/O; caller must authenticate and rejoin its fence in separate
    // transactions before and after this concrete original/privacy/provenance owner.
    prepareNativeEvidencePhaseTwo: (
      identity: WorkerServiceIdentity,
      raw: VertexRecord
    ) => Promise<VertexRecord>;
    prepareForTransaction: (
      tx: Transaction,
      identity: WorkerServiceIdentity,
      raw: unknown,
      completionInputBytes: Uint8Array,
      at: string,
      sourceInputs?: ResearchChatSourceInputs
    ) => Promise<ResearchChatOutputPrepared | null>;
    inspectForTransaction: (
      tx: Transaction,
      scope: Scope,
      responseRequestId: string,
      at: string
    ) => Promise<Readonly<{ metadata: ResearchChatOutputMetadata }> | null>;
    writeAndObserve: (
      prepared: ResearchChatOutputPrepared
    ) => ReturnType<Copies["settleAdvisoryForTransaction"]>;
    publicStageForTransaction: (
      tx: Transaction,
      identity: WorkerServiceIdentity,
      raw: unknown,
      at: string
    ) => Promise<VertexRecord | null>;
    expectedPublicRunForTransaction: (
      tx: Transaction,
      original: Original
    ) => Promise<VertexRecord>;
    publicationForTransaction: (
      tx: Transaction,
      scope: Scope,
      responseRequestId: string,
      at: string
    ) => Promise<
      | Readonly<{ closed: true; publication: null }>
      | Readonly<{ closed: false; publication: Publication | null }>
    >;
    readAdvisory: (
      principal: VertexPrincipal,
      scope: Scope,
      responseRequestId: string,
      sourceInputs?: ResearchChatSourceInputs
    ) => Promise<Uint8Array>;
  }>;
