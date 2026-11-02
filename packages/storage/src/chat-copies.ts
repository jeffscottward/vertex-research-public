// Internal storage primitives, NOT inventory, consent, retention qualification or
// authorization. No runtime caller is wired. Copying/expert execution stays denied
// until a durable owner enforces reservation, family closure and current access.
export const VERTEX_CHAT_COPY_PROFILE = "vertex-chat-copy-v1" as const;
export const VERTEX_CHAT_COPY_FENCE_PROFILE =
  "vertex-chat-copy-fence-v1" as const;
export const MAX_VERTEX_CHAT_COPY_BYTES = 16 * 1_048_576;
export const MAX_VERTEX_CHAT_COPY_MARKER_BYTES = 4096;
export type VertexChatCopyKind = "context" | "model-input" | "derived-output";
export type VertexChatCopyScope = Readonly<{
  accountAlias: string;
  environment: "research";
}>;
export type VertexChatCopyBinding = Readonly<{
  scope: VertexChatCopyScope;
  ownerActorId: string;
  threadId: string;
  responseRequestId: string;
  copyId: string;
  kind: VertexChatCopyKind;
  reservationSha256: string;
  storageProfileSha256: string;
  maximumBytes: number;
  content: Readonly<{ sha256: string; byteLength: number }> | null;
}>;
export type VertexChatCopyProof = Readonly<{
  key: string;
  state: "live" | "fenced";
  bindingSha256: string;
  reservationSha256: string;
  storageProfileSha256: string;
  sha256: string;
  byteLength: number;
  etag: string;
  version: string;
  uploadedAt: string;
}>;
export type VertexChatCopyInvalid = Readonly<{ status: "invalid" }>;
export type VertexChatCopyConflict = Readonly<{ status: "conflict" }>;
export type VertexChatCopyUnavailable = Readonly<{
  status: "unavailable";
  reason: "cancelled" | "timeout" | "backend";
}>;
// Unknown means a dispatched mutation may have committed. Neither abort nor
// deadline cancels a provider PUT; never treat this as absence/no effect.
export type VertexChatCopyUnknown = Readonly<{ status: "unknown" }>;
export type VertexChatCopyMissing = Readonly<{ status: "missing" }>;
export type VertexChatCopyLive = Readonly<{
  status: "live";
  proof: VertexChatCopyProof;
}>;
export type VertexChatCopyFenced = Readonly<{
  status: "fenced";
  proof: VertexChatCopyProof;
}>;
export type VertexChatCopyFailure =
  | VertexChatCopyInvalid
  | VertexChatCopyConflict
  | VertexChatCopyUnavailable;
export type VertexChatCopyInspection =
  | VertexChatCopyLive
  | VertexChatCopyFenced
  | VertexChatCopyMissing
  | VertexChatCopyFailure;
// A known conditional miss proves occupancy; later absence is a namespace
// conflict, never a mutation result from which a caller may infer no effect.
export type VertexChatCopyCreation =
  | VertexChatCopyLive
  | VertexChatCopyFenced
  | VertexChatCopyFailure
  | VertexChatCopyUnknown;
export type VertexChatCopyRead =
  | Readonly<{ status: "live"; proof: VertexChatCopyProof; bytes: Uint8Array }>
  | VertexChatCopyFenced
  | VertexChatCopyMissing
  | VertexChatCopyFailure;
export type VertexChatCopyFence =
  | VertexChatCopyFenced
  | VertexChatCopyFailure
  | VertexChatCopyUnknown;
export interface VertexChatCopyCapabilities {
  createCopy: (
    binding: VertexChatCopyBinding,
    bytes: Uint8Array
  ) => Promise<VertexChatCopyCreation>;
  inspectCopy: (
    binding: VertexChatCopyBinding
  ) => Promise<VertexChatCopyInspection>;
  readCopy: (binding: VertexChatCopyBinding) => Promise<VertexChatCopyRead>;
  fenceCopy: (binding: VertexChatCopyBinding) => Promise<VertexChatCopyFence>;
}

const invalid = (): never => {
  throw new TypeError("Invalid Vertex chat copy binding");
};
const exact = (value: unknown, pattern: RegExp): value is string => {
  if (typeof value !== "string") return false;
  return pattern.exec(value)?.[0] === value;
};
const identifier = (value: unknown): string => {
  if (!exact(value, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/)) return invalid();
  return value;
};
const sha256 = (value: unknown): string => {
  if (!exact(value, /^[0-9a-f]{64}$/)) return invalid();
  return value;
};
const positive = (value: unknown, maximum: number): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0 ||
    value > maximum
  )
    return invalid();
  return value;
};
const record = (
  value: unknown,
  names: readonly string[]
): Record<string, unknown> => {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return invalid();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== names.length ||
    keys.some((key) => typeof key !== "string" || !names.includes(key))
  )
    return invalid();
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (
      !(
        descriptor &&
        Object.hasOwn(descriptor, "value") &&
        descriptor.enumerable
      )
    )
      return invalid();
    Object.defineProperty(result, name, {
      value: descriptor.value,
      enumerable: true,
    });
  }
  return result;
};

const keyOf = (binding: VertexChatCopyBinding): string => {
  const key = `vertex/chat-copy/v1/${binding.storageProfileSha256}/${encodeURIComponent(binding.scope.accountAlias)}/research/${encodeURIComponent(binding.ownerActorId)}/${encodeURIComponent(binding.threadId)}/${encodeURIComponent(binding.responseRequestId)}/${binding.kind}/${encodeURIComponent(binding.copyId)}`;
  if (new TextEncoder().encode(key).byteLength > 1024) return invalid();
  return key;
};

// Own-data snapshots reject getters, hidden/extra fields, unsupported prototypes
// and detected proxy inconsistencies. JavaScript has no portable transparent-
// Proxy detector: only the copied primitive fields are subsequently trusted.
export const snapshotVertexChatCopyBinding = (
  value: unknown
): VertexChatCopyBinding => {
  const data = record(value, [
    "scope",
    "ownerActorId",
    "threadId",
    "responseRequestId",
    "copyId",
    "kind",
    "reservationSha256",
    "storageProfileSha256",
    "maximumBytes",
    "content",
  ]);
  const suppliedScope = record(data["scope"], ["accountAlias", "environment"]);
  if (suppliedScope["environment"] !== "research") return invalid();
  const scope: VertexChatCopyScope = Object.freeze({
    accountAlias: identifier(suppliedScope["accountAlias"]),
    environment: "research",
  });
  const maximumBytes = positive(
    data["maximumBytes"],
    MAX_VERTEX_CHAT_COPY_BYTES
  );
  const kind = data["kind"];
  if (kind !== "context" && kind !== "model-input" && kind !== "derived-output")
    return invalid();
  let content: VertexChatCopyBinding["content"] = null;
  if (data["content"] !== null) {
    const supplied = record(data["content"], ["sha256", "byteLength"]);
    content = Object.freeze({
      sha256: sha256(supplied["sha256"]),
      byteLength: positive(supplied["byteLength"], maximumBytes),
    });
  }
  const binding: VertexChatCopyBinding = Object.freeze({
    scope,
    ownerActorId: identifier(data["ownerActorId"]),
    threadId: identifier(data["threadId"]),
    responseRequestId: identifier(data["responseRequestId"]),
    copyId: identifier(data["copyId"]),
    kind,
    reservationSha256: sha256(data["reservationSha256"]),
    storageProfileSha256: sha256(data["storageProfileSha256"]),
    maximumBytes,
    content,
  });
  keyOf(binding);
  return binding;
};

// No physical-key input/parser, aliases, normalization, content dedup or legacy
// namespace acceptance. Reservation and bound content share the same exact key.
export const vertexChatCopyKey = (binding: VertexChatCopyBinding): string =>
  keyOf(snapshotVertexChatCopyBinding(binding));
