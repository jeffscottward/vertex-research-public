import type {
  VertexChatCopyBinding,
  VertexChatCopyKind,
  VertexChatCopyScope,
} from "@darkfactory/storage/chat-copies";
import type {
  VertexPrincipal,
  VertexRecord,
  VertexScope,
} from "./vertex-primitives.ts";

// Internal metadata only. None of these records grants content I/O, asserts body
// existence/backend qualification, or proves fencing, physical cleanup or erasure.
export type VertexResearchChatCopyRequestMetadata = Readonly<{
  accountAlias: string;
  environment: "research";
  threadId: string;
  parentMessageId: string;
  participantId: string;
  snapshotRevision: string;
  contextStartSequence: string;
  idempotencyKey: string;
}>;
export type VertexResearchChatCopyFamily = Readonly<{
  profile: "vertex-research-chat-copy-family-v1";
  accountAlias: string;
  environment: "research";
  ownerActorId: string;
  threadId: string;
  responseRequestId: string;
  requestSha256: string;
  requestMetadata: VertexResearchChatCopyRequestMetadata;
  storageProfileSha256: string;
  createdAt: string;
}>;
export type VertexResearchChatCopyAllocationBase = Readonly<{
  profile: "vertex-research-chat-copy-allocation-v1";
  scope: VertexChatCopyScope;
  ownerActorId: string;
  threadId: string;
  responseRequestId: string;
  requestSha256: string;
  copyId: string;
  copyIdempotencyKey: string;
  kind: VertexChatCopyKind;
  storageProfileSha256: string;
  maximumBytes: number;
  parentCopyIds: readonly string[];
}>;
export type VertexResearchChatCopyAllocation =
  VertexResearchChatCopyAllocationBase &
    Readonly<{
      reservationSha256: string;
      reservedAt: string;
      binding: VertexChatCopyBinding;
      objectKey: string;
    }>;
export type VertexResearchChatCopyContentBinding = Readonly<{
  profile: "vertex-research-chat-copy-content-binding-v1";
  scope: VertexChatCopyScope;
  responseRequestId: string;
  copyId: string;
  reservationSha256: string;
  content: Readonly<{ sha256: string; byteLength: number }>;
  boundAt: string;
}>;
export type VertexResearchChatCopyClosure = Readonly<{
  profile: "vertex-research-chat-copy-closure-v1";
  scope: VertexChatCopyScope;
  responseRequestId: string;
  closureId: string;
  closedByActorId: string;
  closedAt: string;
  inventorySha256: string;
  copyIds: readonly string[];
}>;
export type VertexResearchChatCopyInventory = Readonly<{
  family: VertexResearchChatCopyFamily;
  copies: readonly Readonly<{
    allocation: VertexResearchChatCopyAllocation;
    contentBinding: VertexResearchChatCopyContentBinding | null;
  }>[];
  closure: VertexResearchChatCopyClosure | null;
}>;
export type VertexResearchChatCopyCleanupMetadata = Readonly<{
  inventory: VertexResearchChatCopyInventory;
  // One verified original request, not an all-receipts list or erasure ACK.
  explicitIntent: VertexRecord | null;
}>;
export type VertexResearchChatCopyOperations = Readonly<{
  reserveResearchChatCopy: (
    input: Readonly<{
      principal: VertexPrincipal;
      scope: VertexScope;
      request: VertexRecord;
      kind: VertexChatCopyKind;
      copyIdempotencyKey: string;
      storageProfileSha256: string;
      maximumBytes: number;
      parentCopyIds: readonly string[];
    }>
  ) => Promise<VertexResearchChatCopyAllocation>;
  bindResearchChatCopyContent: (
    input: Readonly<{
      principal: VertexPrincipal;
      scope: VertexScope;
      responseRequestId: string;
      copyId: string;
      content: Readonly<{ sha256: string; byteLength: number }>;
    }>
  ) => Promise<VertexResearchChatCopyContentBinding>;
  closeResearchChatCopyFamily: (
    input: Readonly<{
      principal: VertexPrincipal;
      scope: VertexScope;
      responseRequestId: string;
    }>
  ) => Promise<VertexResearchChatCopyInventory>;
  readResearchChatCopyInventory: (
    principal: VertexPrincipal,
    scope: VertexScope,
    responseRequestId: string
  ) => Promise<VertexResearchChatCopyInventory | null>;
  // Account-originated explicit intent only; original ACK is not physical state.
  requestResearchChatCopyCleanup: (
    input: Readonly<{
      principal: VertexPrincipal;
      scope: VertexScope;
      threadId: string;
      responseRequestId: string;
      idempotencyKey: string;
    }>
  ) => Promise<VertexRecord>;
  readResearchChatCopyCleanup: (
    principal: VertexPrincipal,
    scope: VertexScope,
    threadId: string,
    responseRequestId: string,
    idempotencyKey: string
  ) => Promise<VertexRecord | null>;
}>;
