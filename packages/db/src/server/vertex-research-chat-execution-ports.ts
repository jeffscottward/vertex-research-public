import type { VertexChatCopyCapabilities } from "@darkfactory/storage/chat-copies";
import type { Transaction } from "./client.ts";
import type { PersistenceContext } from "./vertex-persistence-core.ts";
import type {
  VertexPrincipal,
  VertexRecord,
  VertexScope,
} from "./vertex-ports.ts";
import type { createResearchChatDebateOperations } from "./vertex-research-chat-debate-store.ts";
import type { ResearchChatSourceInputs } from "./vertex-research-chat-source-ports.ts";

export type ChatExecutionContract =
  | "plan"
  | "planInput"
  | "approveInput"
  | "approval"
  | "storageEvidence"
  | "storageReviewInput"
  | "storageReview"
  | "selector"
  | "delivery"
  | "configuration";
export type ChatPreparedInputs = Readonly<{
  fields: VertexRecord;
  context: Uint8Array;
  tokenizeInput: Uint8Array;
  completionInput: Uint8Array;
  evidenceBundle?: Uint8Array;
}>;
export type ChatStorageIdentity = Readonly<{
  capabilityReferenceId: string;
  backendDeploymentId: string;
  storageProfileSha256: string;
  implementationSha256: string;
  contractSha256: string;
}>;
export type ChatExpertPin = Readonly<{
  participantId: string;
  artifact: VertexRecord;
}>;
// Server construction only. No permission callbacks: policy/artifact readers
// return original evidence, while this owner joins persisted grants and state.
export type VertexResearchChatExecutionOptions = Readonly<{
  validate: (
    name: ChatExecutionContract,
    value: unknown
  ) => Promise<VertexRecord> | VertexRecord;
  experts: readonly ChatExpertPin[];
  firstMate?: Readonly<{ artifact: VertexRecord }>;
  nativeEvidence?: Readonly<{ artifact: VertexRecord }>;
  debate?: ReturnType<typeof createResearchChatDebateOperations>;
  storage: ChatStorageIdentity &
    Readonly<{
      evidence: VertexRecord;
      reviewerActorId: string;
      capabilities: VertexChatCopyCapabilities;
    }>;
  readSelectedArtifact: (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    pin: VertexRecord
  ) => Promise<Uint8Array>;
  readCollectionArtifact: (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    collectionId: string,
    pin: VertexRecord
  ) => Promise<Uint8Array>;
  readSelection: (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope
  ) => Promise<VertexRecord>;
  readRetention: (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    selection: VertexRecord,
    nativeEvidence?: boolean
  ) => Promise<VertexRecord>;
  // Internal concrete API composition loads original selected policy bytes,
  // then calls its pure canonical producer. Not a caller authority callback.
  prepareInputs: (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    input: Readonly<{
      request: VertexRecord;
      ownerActorId: string;
      responseRequestId: string;
      configuration: VertexRecord;
      participantConfiguration: VertexRecord;
      messages: readonly VertexRecord[];
      evidence: readonly VertexRecord[];
      selection: VertexRecord;
      debatePrepared?: Awaited<
        ReturnType<
          ReturnType<
            typeof createResearchChatDebateOperations
          >["prepareForTransaction"]
        >
      >;
    }>
  ) => Promise<ChatPreparedInputs>;
}>;
export type ChatCopyPurpose =
  | "context"
  | "tokenizeInput"
  | "completionInput"
  | "evidenceBundle"
  | "phaseOneResponse"
  | "toolResult"
  | "phaseTwoTokenizeInput"
  | "phaseTwoCompletionInput"
  | "advisory";
export type ChatInputPurpose = Exclude<ChatCopyPurpose, "advisory">;
export type ChatApprovedInputs = Readonly<{
  scope: Readonly<{ accountAlias: string; environment: "research" }>;
  request: VertexRecord;
  plan: VertexRecord;
  approval: VertexRecord;
  prepared: ChatPreparedInputs;
  expiresAt: string;
}>;
// Only the concrete execution owner implements this transaction-bound join.
// It is not a permission callback accepted at the runtime construction boundary.
export type ChatApprovedInputOwner = Readonly<{
  readApprovedForTransaction: (
    tx: Transaction,
    principal: VertexPrincipal,
    supplied: unknown,
    at: string,
    sourceInputs?: ResearchChatSourceInputs
  ) => Promise<ChatApprovedInputs>;
  withSourceInputs?: <T>(
    principal: VertexPrincipal,
    supplied: unknown,
    purpose: string,
    operation: (inputs?: ResearchChatSourceInputs) => Promise<T>
  ) => Promise<T>;
  readCurrentOriginalForTransaction?: (
    tx: Transaction,
    scope: VertexScope,
    responseRequestId: string,
    at: string
  ) => Promise<
    Readonly<{
      plan: VertexRecord;
      approval: VertexRecord;
      configuration: VertexRecord;
      selection: VertexRecord;
      expiresAt: string;
    }>
  >;
}>;
export const researchChatStorageReviewResource = (
  responseRequestId: string
): string => `research-chat-storage-qualification:${responseRequestId}`;
export const researchChatContextUseResource = (
  responseRequestId: string
): string => `research-chat-context-use:${responseRequestId}`;
// Borrowed context never acquires a nested pool/transaction or drops permission
// checks. The outer owner already holds authorization -> policy -> scope locks.
export const chatExecutionTransactionContext = (
  ctx: PersistenceContext,
  tx: Transaction,
  at: string
): PersistenceContext => ({
  ...ctx,
  run: async (principal, scope, collection, resource, action, operation) => {
    await ctx.authorize(
      principal,
      scope,
      collection,
      resource,
      action,
      ctx.now()
    );
    return operation(tx, at);
  },
});
