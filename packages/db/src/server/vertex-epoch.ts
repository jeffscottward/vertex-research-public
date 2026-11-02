// Server-only composition boundary for the independently enrolled native epoch
// verifier. Reading evidence through these helpers grants NO authorization:
// callers still enforce current actor/scope/resource grants and immutable hash
// binding. No raw mutation/insert helper or default verifier is exported here.

export type {
  VertexEpochTransitionOptions,
  VertexNativeEpochTransitionVerifier,
} from "./vertex-epoch-store.ts";
export { createEpochTransitionOperations } from "./vertex-epoch-store.ts";
export type { VertexVerifiedNativeApproval } from "./vertex-native-approval-audit.ts";
export type {
  VertexNativeOutboxReplayOptions,
  VertexNativeOutboxReplayVerifier,
} from "./vertex-native-replay-store.ts";
export { createNativeOutboxReplayOperations } from "./vertex-native-replay-store.ts";
export type {
  PersistenceContext,
  VertexStoreOptions,
} from "./vertex-persistence-core.ts";
export {
  createPersistenceContext,
  digestString,
  object,
  one,
  rows,
  scopeWhere,
  sequence,
  string,
  time,
} from "./vertex-persistence-core.ts";
