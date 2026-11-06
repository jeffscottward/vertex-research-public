// What: research-chat source-input port types (prepare, recheck and dispose selected sources).
// Used by: vertex-research-chat-output-ports.ts, the research-chat stores and vertex-research-chat-runtime.ts (re-export).
import type { Transaction } from "./client.ts";
import type { VertexRecord } from "./vertex-primitives.ts";

type Scope = Readonly<{ accountAlias: string; environment: "research" }>;
// Invocation-private reference capability. Its shape is not authority: only the
// concrete output owner's WeakMap recognizes references that it issued live.
export type ResearchChatPreparedSources = Readonly<{
  kind: "research-chat-prepared-sources-v1";
}>;
export type ResearchChatSourceRequest = Readonly<{
  scope: Scope;
  ownerActorId: string;
  requesterActorId: string;
  threadId: string;
  responseRequestId: string;
  requestSha256: string;
  planSha256: string | null;
  planExpiresAt: string | null;
  purpose: string;
  predecessors: readonly VertexRecord[];
}>;
export type ResearchChatSourceInputs = Readonly<{
  request: ResearchChatSourceRequest;
  token: ResearchChatPreparedSources;
}>;
export type ResearchChatSourceRecheck = Readonly<{
  expiresAt: string;
  sources: readonly Readonly<{
    pin: VertexRecord;
    expiresAt: string;
    bytes?: Uint8Array;
  }>[];
}>;
export type ResearchChatSourceInputPort = Readonly<{
  prepareSourceInputs: (
    request: ResearchChatSourceRequest
  ) => Promise<ResearchChatPreparedSources>;
  recheckSourceInputsForTransaction: (
    tx: Transaction,
    request: ResearchChatSourceRequest,
    token: ResearchChatPreparedSources,
    at: string,
    includeBytes?: boolean
  ) => Promise<ResearchChatSourceRecheck>;
  disposeSourceInputs: (token: ResearchChatPreparedSources) => void;
}>;
