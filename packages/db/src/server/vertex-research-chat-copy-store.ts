import {
  MAX_VERTEX_CHAT_COPY_BYTES,
  snapshotVertexChatCopyBinding,
  type VertexChatCopyBinding,
  type VertexChatCopyKind,
  type VertexChatCopyScope,
  vertexChatCopyKey,
} from "@darkfactory/storage/chat-copies";
import { sql } from "drizzle-orm";
import type { Transaction } from "./client.ts";
import { required as requirePresent } from "./required.ts";
import {
  fail,
  insert,
  object,
  one,
  type PersistenceContext,
  type Row,
  rows,
  scopeWhere,
  time,
} from "./vertex-persistence-core.ts";
import type {
  VertexPrincipal,
  VertexRecord,
  VertexScope,
} from "./vertex-ports.ts";
import type {
  VertexResearchChatCopyAllocation,
  VertexResearchChatCopyAllocationBase,
  VertexResearchChatCopyClosure,
  VertexResearchChatCopyContentBinding,
  VertexResearchChatCopyFamily,
  VertexResearchChatCopyInventory,
  VertexResearchChatCopyOperations,
  VertexResearchChatCopyRequestMetadata,
} from "./vertex-research-chat-copy-ports.ts";
import {
  isNativeEvidencePlan,
  nativeEvidenceCopyKey,
  nativeEvidenceCopyPurposes,
} from "./vertex-research-chat-native-phase-store.ts";

// Private integration with the existing chat owner, NOT caller-supplied policy
// callbacks. No transport, content writer, lease, grant issuer or ready callback.
type ChatOwner = Readonly<{
  loadThread: (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    threadId: string
  ) => Promise<Readonly<{ current: VertexRecord }> | null>;
  verifyResponsePrefix: (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    thread: Readonly<{ current: VertexRecord }>,
    command: VertexRecord,
    at: string
  ) => Promise<void>;
  readResponse: (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    threadId: string,
    idempotencyKey: string
  ) => Promise<VertexRecord | null>;
}>;
type CleanupCommand = Readonly<{
  accountAlias: string;
  environment: "research";
  threadId: string;
  responseRequestId: string;
  idempotencyKey: string;
}>;
type CleanupIntent = Readonly<{
  profile: "vertex-research-chat-copy-explicit-cleanup-intent-v1";
  receipt: VertexRecord;
  closureId: string;
  inventorySha256: string;
}>;
const cleanupInputKeys = [
  "accountAlias",
  "environment",
  "threadId",
  "responseRequestId",
  "idempotencyKey",
] as const;
const cleanupReceiptKeys = [
  "schemaVersion",
  "executionAuthorized",
  "status",
  ...cleanupInputKeys,
  "ownerActorId",
  "cleanupRequestId",
  "requestSha256",
  "recordedAt",
  "targetKinds",
] as const;
const metadataKeys = [
  "accountAlias",
  "environment",
  "threadId",
  "parentMessageId",
  "participantId",
  "snapshotRevision",
  "contextStartSequence",
  "idempotencyKey",
] as const;
const baseKeys = [
  "profile",
  "scope",
  "ownerActorId",
  "threadId",
  "responseRequestId",
  "requestSha256",
  "copyId",
  "copyIdempotencyKey",
  "kind",
  "storageProfileSha256",
  "maximumBytes",
  "parentCopyIds",
] as const;
const exact = (value: unknown, names: readonly string[]): VertexRecord => {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail("invalid");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== names.length ||
    keys.some((key) => typeof key !== "string" || !names.includes(key))
  )
    return fail("invalid");
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (
      !(
        descriptor &&
        Object.hasOwn(descriptor, "value") &&
        descriptor.enumerable
      )
    )
      return fail("invalid");
  }
  return value as VertexRecord;
};
const matched = (value: unknown, pattern: RegExp): string => {
  if (typeof value !== "string" || pattern.exec(value)?.[0] !== value)
    return fail("invalid");
  return value;
};
const id = (value: unknown): string =>
  matched(value, /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const sha = (value: unknown): string => matched(value, /^[0-9a-f]{64}$/);
const responseId = (value: unknown): string =>
  matched(value, /^response-[0-9a-f]{64}$/);
const copyId = (value: unknown): string =>
  matched(value, /^chat-copy-[0-9a-f]{64}$/);
const timestamp = (value: unknown): string => {
  const result = matched(
    value,
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/
  );
  time(result);
  return result;
};
const bytes = (
  value: unknown,
  maximum = MAX_VERTEX_CHAT_COPY_BYTES
): number => {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  )
    return fail("invalid");
  return value;
};
const kindOf = (value: unknown): VertexChatCopyKind => {
  if (
    value !== "context" &&
    value !== "model-input" &&
    value !== "derived-output"
  )
    return fail("invalid");
  return value;
};
const scopeOf = (value: unknown): VertexChatCopyScope => {
  const scope = exact(value, ["accountAlias", "environment"]);
  if (scope["environment"] !== "research") return fail("invalid");
  return { accountAlias: id(scope["accountAlias"]), environment: "research" };
};
const actorOf = (value: unknown): VertexPrincipal => ({
  actorId: id(exact(value, ["actorId"])["actorId"]),
});
const sortedIds = (value: unknown, maximum: number): readonly string[] => {
  if (!Array.isArray(value) || value.length > maximum) return fail("invalid");
  const result: string[] = [];
  for (const candidate of value) {
    const current = copyId(candidate);
    if (
      result.length &&
      requirePresent(result.at(-1), "result[result.length - 1]") >= current
    )
      return fail("invalid");
    result.push(current);
  }
  return result;
};
const metadataOf = (value: unknown): VertexResearchChatCopyRequestMetadata => {
  const metadata = exact(value, metadataKeys);
  scopeOf({
    accountAlias: metadata["accountAlias"],
    environment: metadata["environment"],
  });
  for (const field of [
    "threadId",
    "parentMessageId",
    "participantId",
    "idempotencyKey",
  ])
    id(metadata[field]);
  const snapshot = BigInt(
    matched(metadata["snapshotRevision"], /^[1-9]\d{0,29}$/)
  );
  const start = BigInt(
    matched(metadata["contextStartSequence"], /^[1-9]\d{0,29}$/)
  );
  if (snapshot < 2n || snapshot - start < 1n || snapshot - start > 16n)
    return fail("invalid");
  return metadata as VertexResearchChatCopyRequestMetadata;
};
const freeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
};
const columns = (row: Row, expected: VertexRecord): void => {
  for (const [key, value] of Object.entries(expected)) {
    if (row[key] !== value) fail("integrity");
  }
};
const familyColumns = (family: VertexResearchChatCopyFamily): VertexRecord => ({
  account_alias: family.accountAlias,
  environment: family.environment,
  owner_actor_id: family.ownerActorId,
  thread_id: family.threadId,
  response_request_id: family.responseRequestId,
  request_sha256: family.requestSha256,
  storage_profile_sha256: family.storageProfileSha256,
  request_idempotency_key: family.requestMetadata.idempotencyKey,
  created_at: family.createdAt,
  created_at_ns: time(family.createdAt).toString(),
});
const allocationColumns = (
  allocation: VertexResearchChatCopyAllocation
): VertexRecord => ({
  account_alias: allocation.scope.accountAlias,
  environment: allocation.scope.environment,
  owner_actor_id: allocation.ownerActorId,
  thread_id: allocation.threadId,
  response_request_id: allocation.responseRequestId,
  request_sha256: allocation.requestSha256,
  copy_id: allocation.copyId,
  copy_idempotency_key: allocation.copyIdempotencyKey,
  kind: allocation.kind,
  storage_profile_sha256: allocation.storageProfileSha256,
  maximum_bytes: allocation.maximumBytes,
  reservation_sha256: allocation.reservationSha256,
  object_key: allocation.objectKey,
  reserved_at: allocation.reservedAt,
  reserved_at_ns: time(allocation.reservedAt).toString(),
});
const contentColumns = (
  pin: VertexResearchChatCopyContentBinding
): VertexRecord => ({
  account_alias: pin.scope.accountAlias,
  environment: pin.scope.environment,
  response_request_id: pin.responseRequestId,
  copy_id: pin.copyId,
  reservation_sha256: pin.reservationSha256,
  content_sha256: pin.content.sha256,
  byte_length: pin.content.byteLength,
  bound_at: pin.boundAt,
  bound_at_ns: time(pin.boundAt).toString(),
});
const closureColumns = (
  closure: VertexResearchChatCopyClosure
): VertexRecord => ({
  account_alias: closure.scope.accountAlias,
  environment: closure.scope.environment,
  response_request_id: closure.responseRequestId,
  closure_id: closure.closureId,
  closed_by_actor_id: closure.closedByActorId,
  closed_at: closure.closedAt,
  closed_at_ns: time(closure.closedAt).toString(),
  inventory_sha256: closure.inventorySha256,
});
const cleanupColumns = (intent: CleanupIntent): VertexRecord => ({
  account_alias: intent.receipt["accountAlias"],
  environment: intent.receipt["environment"],
  owner_actor_id: intent.receipt["ownerActorId"],
  thread_id: intent.receipt["threadId"],
  response_request_id: intent.receipt["responseRequestId"],
  idempotency_key: intent.receipt["idempotencyKey"],
  cleanup_request_id: intent.receipt["cleanupRequestId"],
  request_sha256: intent.receipt["requestSha256"],
  recorded_at: intent.receipt["recordedAt"],
  recorded_at_ns: time(intent.receipt["recordedAt"]).toString(),
  closure_id: intent.closureId,
  inventory_sha256: intent.inventorySha256,
});

// Transaction-local verification only: no account impersonation or chat owner.
export const createResearchChatCopyMetadata = (
  ctx: Pick<
    PersistenceContext,
    "capture" | "hash" | "validate" | "validateResearchChatInput"
  >
) => {
  const responseIdentity = (
    principal: VertexPrincipal,
    scope: VertexScope,
    metadata: VertexResearchChatCopyRequestMetadata
  ): Promise<string> => {
    return ctx
      .hash({
        operation: "requestResponse",
        actorId: principal.actorId,
        scope,
        threadId: metadata.threadId,
        idempotencyKey: metadata.idempotencyKey,
      })
      .then((digest) => `response-${sha(digest)}`);
  };
  const allocationIdentity = (
    base: Omit<VertexResearchChatCopyAllocationBase, "profile" | "copyId">
  ): Promise<string> => {
    return ctx
      .hash({
        operation: "reserveResearchChatCopy",
        actorId: base.ownerActorId,
        scope: base.scope,
        threadId: base.threadId,
        responseRequestId: base.responseRequestId,
        kind: base.kind,
        copyIdempotencyKey: base.copyIdempotencyKey,
      })
      .then((digest) => `chat-copy-${sha(digest)}`);
  };
  const closureIdentity = async (
    scope: VertexScope,
    responseRequestId: string
  ): Promise<string> =>
    `copy-closure-${sha(await ctx.hash({ operation: "closeResearchChatCopyFamily", scope, responseRequestId }))}`;
  const checkedHash = async (
    value: unknown,
    expected: unknown
  ): Promise<void> => {
    if (sha(await ctx.hash(value)) !== sha(expected)) fail("integrity");
  };
  const query = async (
    tx: Transaction,
    table: string,
    scope: VertexScope,
    responseRequestId: string,
    maximum: number
  ): Promise<Row[]> => {
    const result = await rows(
      tx,
      sql`select * from ${sql.identifier(table)} where ${scopeWhere(scope)} and response_request_id = ${responseRequestId} limit ${maximum + 1}`
    );
    if (result.length > maximum) return fail("integrity");
    return result;
  };
  const bindingOf = (
    base: VertexResearchChatCopyAllocationBase,
    reservationSha256: string
  ): VertexChatCopyBinding =>
    snapshotVertexChatCopyBinding({
      scope: base.scope,
      ownerActorId: base.ownerActorId,
      threadId: base.threadId,
      responseRequestId: base.responseRequestId,
      copyId: base.copyId,
      kind: base.kind,
      storageProfileSha256: base.storageProfileSha256,
      maximumBytes: base.maximumBytes,
      reservationSha256,
      content: null,
    });
  const parentsValid = (
    allocation: VertexResearchChatCopyAllocationBase,
    copies: readonly Readonly<{
      allocation: VertexResearchChatCopyAllocation;
    }>[]
  ): void => {
    if (allocation.kind === "context" && allocation.parentCopyIds.length !== 0)
      fail("invalid");
    if (allocation.kind !== "context" && allocation.parentCopyIds.length === 0)
      fail("invalid");
    let model = false;
    for (const parentId of allocation.parentCopyIds) {
      const parent = copies.find(
        (entry) => entry.allocation.copyId === parentId
      )?.allocation;
      if (
        !parent ||
        parentId === allocation.copyId ||
        parent.kind === "derived-output" ||
        parent.ownerActorId !== allocation.ownerActorId ||
        parent.responseRequestId !== allocation.responseRequestId ||
        parent.scope.accountAlias !== allocation.scope.accountAlias ||
        parent.scope.environment !== allocation.scope.environment ||
        parent.storageProfileSha256 !== allocation.storageProfileSha256
      )
        fail("invalid");
      if (parent.kind === "model-input") model = true;
    }
    if (allocation.kind === "derived-output" && !model) fail("invalid");
  };
  const load = async (
    tx: Transaction,
    scope: VertexChatCopyScope,
    responseRequestId: string
  ): Promise<VertexResearchChatCopyInventory | null> => {
    try {
      // All bounded queries are inside the SAME existing scope lock, including
      // absence. Lookahead detects overflow; no truncated cleanup inventory.
      const families = await query(
        tx,
        "vertex_research_chat_copy_families",
        scope,
        responseRequestId,
        1
      );
      const allocations = await query(
        tx,
        "vertex_research_chat_copy_allocations",
        scope,
        responseRequestId,
        64
      );
      const pins = await query(
        tx,
        "vertex_research_chat_copy_content_bindings",
        scope,
        responseRequestId,
        64
      );
      const edges = await query(
        tx,
        "vertex_research_chat_copy_dependencies",
        scope,
        responseRequestId,
        2016
      );
      const closures = await query(
        tx,
        "vertex_research_chat_copy_closures",
        scope,
        responseRequestId,
        1
      );
      if (!families.length) {
        if (
          allocations.length ||
          pins.length ||
          edges.length ||
          closures.length
        )
          return fail("integrity");
        return null;
      }
      const familyRow = requirePresent(families[0], "families[0]");
      const family = exact(ctx.capture(familyRow["payload"]), [
        "profile",
        "accountAlias",
        "environment",
        "ownerActorId",
        "threadId",
        "responseRequestId",
        "requestSha256",
        "requestMetadata",
        "storageProfileSha256",
        "createdAt",
      ]) as VertexResearchChatCopyFamily;
      if (
        family.profile !== "vertex-research-chat-copy-family-v1" ||
        family.accountAlias !== scope.accountAlias ||
        family.environment !== scope.environment ||
        family.responseRequestId !== responseRequestId
      )
        return fail("integrity");
      id(family.ownerActorId);
      id(family.threadId);
      sha(family.requestSha256);
      sha(family.storageProfileSha256);
      timestamp(family.createdAt);
      const metadata = metadataOf(family.requestMetadata);
      if (
        metadata.accountAlias !== scope.accountAlias ||
        metadata.environment !== scope.environment ||
        metadata.threadId !== family.threadId ||
        responseRequestId !==
          (await responseIdentity(
            { actorId: family.ownerActorId },
            scope,
            metadata
          ))
      )
        return fail("integrity");
      columns(familyRow, familyColumns(family));
      await checkedHash(family, familyRow["record_hash"]);
      const copies: {
        allocation: VertexResearchChatCopyAllocation;
        contentBinding: VertexResearchChatCopyContentBinding | null;
      }[] = [];
      const identities = new Set<string>();
      const keys = new Set<string>();
      let total = 0;
      for (const row of allocations) {
        const allocation = exact(ctx.capture(row["payload"]), [
          ...baseKeys,
          "reservationSha256",
          "reservedAt",
          "binding",
          "objectKey",
        ]) as VertexResearchChatCopyAllocation;
        const { reservationSha256, reservedAt, binding, objectKey, ...base } =
          allocation;
        scopeOf(base.scope);
        id(base.copyIdempotencyKey);
        copyId(base.copyId);
        kindOf(base.kind);
        bytes(base.maximumBytes);
        sortedIds(base.parentCopyIds, 63);
        if (
          base.profile !== "vertex-research-chat-copy-allocation-v1" ||
          base.scope.accountAlias !== scope.accountAlias ||
          base.ownerActorId !== family.ownerActorId ||
          base.threadId !== family.threadId ||
          base.responseRequestId !== responseRequestId ||
          base.requestSha256 !== family.requestSha256 ||
          base.storageProfileSha256 !== family.storageProfileSha256 ||
          base.copyId !== (await allocationIdentity(base))
        )
          return fail("integrity");
        await checkedHash(base, reservationSha256);
        const expectedBinding = bindingOf(base, reservationSha256);
        if (
          (await ctx.hash(binding)) !== (await ctx.hash(expectedBinding)) ||
          objectKey !== vertexChatCopyKey(expectedBinding)
        )
          return fail("integrity");
        if (
          time(timestamp(reservedAt)) < time(family.createdAt) ||
          identities.has(base.copyId) ||
          keys.has(objectKey)
        )
          return fail("integrity");
        identities.add(base.copyId);
        keys.add(objectKey);
        total += base.maximumBytes;
        columns(row, allocationColumns(allocation));
        await checkedHash(allocation, row["record_hash"]);
        copies.push({ allocation, contentBinding: null });
      }
      if (!copies.length || total > MAX_VERTEX_CHAT_COPY_BYTES)
        return fail("integrity");
      copies.sort((a, b) =>
        a.allocation.copyId < b.allocation.copyId ? -1 : 1
      );
      const expectedEdges = new Set<string>();
      for (const entry of copies) {
        parentsValid(entry.allocation, copies);
        for (const parent of entry.allocation.parentCopyIds)
          expectedEdges.add(JSON.stringify([entry.allocation.copyId, parent]));
      }
      const seenEdges = new Set<string>();
      for (const edge of edges) {
        columns(edge, {
          account_alias: scope.accountAlias,
          environment: scope.environment,
          response_request_id: responseRequestId,
        });
        const pair = JSON.stringify([
          copyId(edge["child_copy_id"]),
          copyId(edge["parent_copy_id"]),
        ]);
        if (!expectedEdges.has(pair) || seenEdges.has(pair))
          return fail("integrity");
        seenEdges.add(pair);
      }
      if (seenEdges.size !== expectedEdges.size) return fail("integrity");
      const visiting = new Set<string>();
      const visited = new Set<string>();
      const visit = (current: string): void => {
        if (visiting.has(current)) fail("integrity");
        if (visited.has(current)) return;
        visiting.add(current);
        const entry = copies.find(
          (candidate) => candidate.allocation.copyId === current
        );
        if (!entry) fail("integrity");
        for (const parent of entry.allocation.parentCopyIds) visit(parent);
        visiting.delete(current);
        visited.add(current);
      };
      for (const entry of copies) visit(entry.allocation.copyId);
      for (const row of pins) {
        const pin = exact(ctx.capture(row["payload"]), [
          "profile",
          "scope",
          "responseRequestId",
          "copyId",
          "reservationSha256",
          "content",
          "boundAt",
        ]) as VertexResearchChatCopyContentBinding;
        scopeOf(pin.scope);
        const entry = copies.find(
          (candidate) => candidate.allocation.copyId === pin.copyId
        );
        if (
          !entry ||
          entry.contentBinding ||
          pin.profile !== "vertex-research-chat-copy-content-binding-v1" ||
          pin.scope.accountAlias !== scope.accountAlias ||
          pin.responseRequestId !== responseRequestId ||
          pin.reservationSha256 !== entry.allocation.reservationSha256
        )
          return fail("integrity");
        exact(pin.content, ["sha256", "byteLength"]);
        sha(pin.content.sha256);
        bytes(pin.content.byteLength, entry.allocation.maximumBytes);
        if (time(timestamp(pin.boundAt)) < time(entry.allocation.reservedAt))
          return fail("integrity");
        columns(row, contentColumns(pin));
        await checkedHash(pin, row["record_hash"]);
        entry.contentBinding = pin;
      }
      for (const entry of copies) {
        for (const parentId of entry.allocation.parentCopyIds) {
          const parent = requirePresent(
            copies.find(
              (candidate) => candidate.allocation.copyId === parentId
            ),
            "copies.find( (candidate) => candidate.allocation.copyId === parentId )"
          );
          if (
            time(parent.allocation.reservedAt) >
            time(entry.allocation.reservedAt)
          )
            return fail("integrity");
          if (
            entry.contentBinding &&
            (!parent.contentBinding ||
              time(parent.contentBinding.boundAt) >
                time(entry.contentBinding.boundAt))
          )
            return fail("integrity");
        }
      }
      let closure: VertexResearchChatCopyClosure | null = null;
      if (closures.length) {
        const row = requirePresent(closures[0], "closures[0]");
        closure = exact(ctx.capture(row["payload"]), [
          "profile",
          "scope",
          "responseRequestId",
          "closureId",
          "closedByActorId",
          "closedAt",
          "inventorySha256",
          "copyIds",
        ]) as VertexResearchChatCopyClosure;
        scopeOf(closure.scope);
        id(closure.closedByActorId);
        sortedIds(closure.copyIds, 64);
        if (
          closure.profile !== "vertex-research-chat-copy-closure-v1" ||
          closure.scope.accountAlias !== scope.accountAlias ||
          closure.responseRequestId !== responseRequestId ||
          closure.closureId !==
            (await closureIdentity(scope, responseRequestId))
        )
          return fail("integrity");
        await checkedHash({ family, copies }, closure.inventorySha256);
        if (
          (await ctx.hash(closure.copyIds)) !==
          (await ctx.hash(copies.map((entry) => entry.allocation.copyId)))
        )
          return fail("integrity");
        const closed = time(timestamp(closure.closedAt));
        if (
          copies.some(
            (entry) =>
              closed <
              time(entry.contentBinding?.boundAt ?? entry.allocation.reservedAt)
          )
        )
          return fail("integrity");
        columns(row, closureColumns(closure));
        await checkedHash(closure, row["record_hash"]);
      }
      return freeze({ family, copies, closure });
    } catch {
      return fail("integrity");
    }
  };
  const cleanupCommand = async (
    name: "requestCopyCleanup" | "readCopyCleanup",
    scope: VertexChatCopyScope,
    threadId: unknown,
    responseRequestId: unknown,
    idempotencyKey: unknown
  ): Promise<CleanupCommand> => {
    const command = {
      ...scope,
      threadId: id(threadId),
      responseRequestId: responseId(responseRequestId),
      idempotencyKey: id(idempotencyKey),
    };
    return (await ctx.validateResearchChatInput(
      name,
      command
    )) as CleanupCommand;
  };
  const cleanupDigest = async (
    principal: VertexPrincipal,
    command: CleanupCommand
  ): Promise<string> => {
    return sha(
      await ctx.hash({
        operation: "requestCopyCleanup",
        actorId: principal.actorId,
        input: command,
      })
    );
  };
  const cleanupReceipt = (
    principal: VertexPrincipal,
    command: CleanupCommand,
    requestSha256: string,
    recordedAt: string
  ): VertexRecord => {
    return {
      schemaVersion: "1.0.0",
      executionAuthorized: false,
      status: "requested",
      ...command,
      ownerActorId: principal.actorId,
      cleanupRequestId: `copy-cleanup-${requestSha256}`,
      requestSha256,
      recordedAt,
      targetKinds: ["context", "model-input", "derived-output"],
    };
  };
  const checkedCleanupReceipt = async (
    value: unknown,
    expected: VertexRecord
  ): Promise<VertexRecord> => {
    const receipt = exact(ctx.capture(value), cleanupReceiptKeys);
    timestamp(receipt["recordedAt"]);
    await checkedHash(receipt, await ctx.hash(expected));
    const parsed = await ctx.validate(
      "ResearchChatCopyCleanupReceipt",
      receipt
    );
    await checkedHash(parsed, await ctx.hash(receipt));
    return freeze(parsed);
  };
  const cleanupChronology = (
    inventory: VertexResearchChatCopyInventory,
    recordedAt: string,
    code: "integrity" | "stale"
  ): void => {
    const recorded = time(timestamp(recordedAt));
    if (
      recorded < time(inventory.family.createdAt) ||
      (inventory.closure && recorded < time(inventory.closure.closedAt)) ||
      inventory.copies.some(
        (entry) =>
          recorded <
          time(entry.contentBinding?.boundAt ?? entry.allocation.reservedAt)
      )
    )
      fail(code);
  };
  const originalCleanup = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexChatCopyScope,
    command: CleanupCommand,
    requestSha256: string,
    inventory: VertexResearchChatCopyInventory
  ): Promise<VertexRecord | null> => {
    // Owner/thread are checked against the complete stored family first, then
    // again against every persisted intent column, never trusted from the caller.
    const found = await rows(
      tx,
      sql`select * from ${sql.identifier("vertex_research_chat_copy_cleanup_intents")} where ${scopeWhere(scope)} and response_request_id = ${command.responseRequestId} and idempotency_key = ${command.idempotencyKey} limit 2`
    );
    const byIdentity = await rows(
      tx,
      sql`select * from ${sql.identifier("vertex_research_chat_copy_cleanup_intents")} where cleanup_request_id = ${`copy-cleanup-${requestSha256}`} limit 2`
    );
    if (!(found.length || byIdentity.length)) return null;
    try {
      if (found.length !== 1 || byIdentity.length !== 1 || !inventory.closure)
        return fail("integrity");
      const row = requirePresent(found[0], "found[0]");
      // A corrupted indexed tuple must not masquerade as an absent original.
      await checkedHash(row, await ctx.hash(byIdentity[0]));
      const intent = exact(ctx.capture(row["payload"]), [
        "profile",
        "receipt",
        "closureId",
        "inventorySha256",
      ]) as CleanupIntent;
      if (
        intent.profile !==
          "vertex-research-chat-copy-explicit-cleanup-intent-v1" ||
        intent.closureId !== inventory.closure.closureId ||
        intent.inventorySha256 !== inventory.closure.inventorySha256
      )
        return fail("integrity");
      const recordedAt = timestamp(
        exact(intent.receipt, cleanupReceiptKeys)["recordedAt"]
      );
      const receipt = await checkedCleanupReceipt(
        intent.receipt,
        cleanupReceipt(principal, command, requestSha256, recordedAt)
      );
      cleanupChronology(inventory, recordedAt, "integrity");
      columns(row, cleanupColumns(intent));
      await checkedHash(intent, row["record_hash"]);
      return receipt;
    } catch {
      return fail("integrity");
    }
  };
  const readCleanupMetadata = async (
    tx: Transaction,
    rawScope: VertexChatCopyScope,
    rawResponseRequestId: string
  ) => {
    const scope = scopeOf(ctx.capture(rawScope));
    const responseRequestId = responseId(rawResponseRequestId);
    const inventory = await load(tx, scope, responseRequestId);
    // Exactly one deterministic candidate. This is not an all-intents listing.
    const selected = await rows(
      tx,
      sql`select * from ${sql.identifier("vertex_research_chat_copy_cleanup_intents")} where ${scopeWhere(scope)} and response_request_id = ${responseRequestId} order by cleanup_request_id collate "C" limit 1`
    );
    if (selected.length > 1 || (!inventory && selected.length))
      return fail("integrity");
    if (!inventory) return null;
    if (!selected.length) return freeze({ inventory, explicitIntent: null });
    const row = requirePresent(selected[0], "selected[0]");
    // Original owner reconstructs immutable commitments ONLY. It is never used
    // for service authentication or resource authorization.
    const owner = { actorId: inventory.family.ownerActorId };
    const command = await cleanupCommand(
      "readCopyCleanup",
      scope,
      inventory.family.threadId,
      responseRequestId,
      row["idempotency_key"]
    );
    const requestSha256 = await cleanupDigest(owner, command);
    const receipt = await originalCleanup(
      tx,
      owner,
      scope,
      command,
      requestSha256,
      inventory
    );
    if (!receipt) return fail("integrity");
    const intent = exact(ctx.capture(row["payload"]), [
      "profile",
      "receipt",
      "closureId",
      "inventorySha256",
    ]) as CleanupIntent;
    await checkedHash(intent.receipt, await ctx.hash(receipt));
    columns(row, cleanupColumns(intent));
    await checkedHash(intent, row["record_hash"]);
    return freeze({ inventory, explicitIntent: receipt });
  };
  // INTERNAL, transaction-bound allocation primitive. The lifecycle owner first
  // rejoins current authority and supplies the persisted plan+approval, never a
  // caller's content. Existing public reserve/bind semantics remain unchanged.
  const reserveApprovedInputsForTransaction = async (
    tx: Transaction,
    plan: VertexRecord,
    approval: VertexRecord,
    at: string
  ): Promise<VertexResearchChatCopyInventory> => {
    const scope = scopeOf({
      accountAlias: plan["accountAlias"],
      environment: plan["environment"],
    });
    const responseRequestId = responseId(plan["responseRequestId"]);
    const storedPlan = await one(
      tx,
      "vertex_research_chat_execution_plans",
      scope,
      sql`response_request_id = ${responseRequestId}`
    );
    const storedApproval = await one(
      tx,
      "vertex_research_chat_execution_approvals",
      scope,
      sql`response_request_id = ${responseRequestId}`
    );
    if (!(storedPlan && storedApproval)) return fail("denied");
    await checkedHash(plan, storedPlan["record_hash"]);
    await checkedHash(approval, storedApproval["record_hash"]);
    if (
      storedPlan["plan_sha256"] !== plan["planSha256"] ||
      storedApproval["plan_sha256"] !== plan["planSha256"] ||
      storedApproval["owner_actor_id"] !== plan["ownerActorId"] ||
      approval["responseRequestId"] !== responseRequestId ||
      approval["planId"] !== plan["planId"] ||
      approval["ownerActorId"] !== plan["ownerActorId"] ||
      approval["requestSha256"] !== plan["requestSha256"]
    )
      return fail("integrity");
    if (
      time(timestamp(at)) < time(approval["approvedAt"]) ||
      time(at) >= time(plan["expiresAt"])
    )
      return fail("stale");
    const metadata = metadataOf(
      Object.fromEntries(metadataKeys.map((key) => [key, plan[key]]))
    );
    const principal = { actorId: id(plan["ownerActorId"]) };
    if (
      (await responseIdentity(principal, scope, metadata)) !== responseRequestId
    )
      return fail("integrity");
    const inventory = await load(tx, scope, responseRequestId);
    if (inventory?.closure) return fail("conflict");
    const family: VertexResearchChatCopyFamily = inventory?.family ?? {
      profile: "vertex-research-chat-copy-family-v1",
      ...scope,
      ownerActorId: principal.actorId,
      threadId: metadata.threadId,
      responseRequestId,
      requestSha256: sha(plan["requestSha256"]),
      requestMetadata: metadata,
      storageProfileSha256: sha(plan["storageProfileSha256"]),
      createdAt: at,
    };
    if (
      family.ownerActorId !== principal.actorId ||
      family.requestSha256 !== plan["requestSha256"] ||
      family.storageProfileSha256 !== plan["storageProfileSha256"] ||
      (await ctx.hash(family.requestMetadata)) !== (await ctx.hash(metadata))
    )
      return fail("conflict");
    const save = async (
      table: string,
      value: VertexRecord,
      indexed: VertexRecord
    ): Promise<void> => {
      await insert(tx, table, scope, {
        ...indexed,
        payload: value,
        record_hash: sha(await ctx.hash(value)),
      });
    };
    const copies: {
      allocation: VertexResearchChatCopyAllocation;
      contentBinding: VertexResearchChatCopyContentBinding | null;
    }[] = [];
    const native = isNativeEvidencePlan(plan);
    const selectedPurposes = native
      ? nativeEvidenceCopyPurposes
      : (["context", "tokenizeInput", "completionInput", "advisory"] as const);
    for (const purpose of selectedPurposes) {
      const kind: VertexChatCopyKind =
        purpose === "context"
          ? "context"
          : purpose === "advisory"
            ? "derived-output"
            : "model-input";
      const content =
        purpose === "advisory" ||
        (native &&
          [
            "phaseOneResponse",
            "toolResult",
            "phaseTwoTokenizeInput",
            "phaseTwoCompletionInput",
          ].includes(purpose))
          ? null
          : object(
              purpose === "evidenceBundle"
                ? object(plan["nativeEvidence"])["bundle"]
                : plan[purpose]
            );
      if (content) exact(content, ["sha256", "byteLength"]);
      const maximumBytes = bytes(
        content
          ? content["byteLength"]
          : purpose === "advisory"
            ? plan["advisoryMaximumBytes"]
            : object(plan["nativeEvidence"])["maximumIntermediateBytes"]
      );
      const parentCopyIds = (
        purpose === "context"
          ? []
          : purpose === "advisory" || (native && !content)
            ? copies.map((entry) => entry.allocation.copyId)
            : [requirePresent(copies[0], "copies[0]").allocation.copyId]
      ).sort();
      const identity = {
        scope,
        ownerActorId: principal.actorId,
        threadId: metadata.threadId,
        responseRequestId,
        requestSha256: family.requestSha256,
        kind,
        copyIdempotencyKey: native
          ? nativeEvidenceCopyKey(purpose)
          : `one-expert-${purpose}-v1`,
        storageProfileSha256: family.storageProfileSha256,
        maximumBytes,
        parentCopyIds,
      };
      const base: VertexResearchChatCopyAllocationBase = {
        profile: "vertex-research-chat-copy-allocation-v1",
        ...identity,
        copyId: await allocationIdentity(identity),
      };
      parentsValid(base, copies);
      const reservationSha256 = sha(await ctx.hash(base)),
        binding = bindingOf(base, reservationSha256);
      const prior = inventory?.copies.find(
        (entry) => entry.allocation.copyId === base.copyId
      );
      if (prior && prior.allocation.reservationSha256 !== reservationSha256)
        return fail("conflict");
      const allocation = prior?.allocation ?? {
        ...base,
        reservationSha256,
        reservedAt: at,
        binding,
        objectKey: vertexChatCopyKey(binding),
      };
      const pin: VertexResearchChatCopyContentBinding | null = content
        ? {
            profile: "vertex-research-chat-copy-content-binding-v1",
            scope,
            responseRequestId,
            copyId: base.copyId,
            reservationSha256,
            content: {
              sha256: sha(content["sha256"]),
              byteLength: bytes(content["byteLength"], maximumBytes),
            },
            boundAt: prior?.contentBinding?.boundAt ?? at,
          }
        : native
          ? (prior?.contentBinding ?? null)
          : null;
      if (
        prior &&
        (await ctx.hash(prior.contentBinding)) !== (await ctx.hash(pin))
      )
        return fail("conflict");
      copies.push({ allocation, contentBinding: pin });
    }
    if (
      copies.reduce((sum, entry) => sum + entry.allocation.maximumBytes, 0) >
      MAX_VERTEX_CHAT_COPY_BYTES
    )
      return fail("invalid");
    if (inventory) {
      if (
        inventory.copies.length !== selectedPurposes.length ||
        copies.some(
          (entry) =>
            !inventory.copies.some(
              (prior) => prior.allocation.copyId === entry.allocation.copyId
            )
        )
      )
        return fail("conflict");
      return inventory;
    }
    await save(
      "vertex_research_chat_copy_families",
      family,
      familyColumns(family)
    );
    for (const entry of copies) {
      await save(
        "vertex_research_chat_copy_allocations",
        entry.allocation,
        allocationColumns(entry.allocation)
      );
      for (const parent of entry.allocation.parentCopyIds)
        await insert(tx, "vertex_research_chat_copy_dependencies", scope, {
          response_request_id: responseRequestId,
          child_copy_id: entry.allocation.copyId,
          parent_copy_id: parent,
        });
      if (entry.contentBinding)
        await save(
          "vertex_research_chat_copy_content_bindings",
          entry.contentBinding,
          contentColumns(entry.contentBinding)
        );
    }
    const result = await load(tx, scope, responseRequestId);
    if (!result) return fail("integrity");
    return result;
  };
  // Private transaction-local continuation of the ORIGINAL fourth reservation.
  // The lifecycle/output owners prove current authority and the actual completed
  // response before invoking this; this metadata writer grants no body access.
  const bindAdvisoryContentForTransaction = async (
    tx: Transaction,
    rawPlan: VertexRecord,
    rawContent: unknown,
    at: string
  ): Promise<VertexResearchChatCopyContentBinding> => {
    const plan = ctx.capture(rawPlan),
      scope = scopeOf({
        accountAlias: plan["accountAlias"],
        environment: plan["environment"],
      }),
      responseRequestId = responseId(plan["responseRequestId"]);
    exact(rawContent, ["sha256", "byteLength"]);
    const content = {
      sha256: sha(object(rawContent)["sha256"]),
      byteLength: bytes(object(rawContent)["byteLength"]),
    };
    const storedPlan = (
      await query(
        tx,
        "vertex_research_chat_execution_plans",
        scope,
        responseRequestId,
        1
      )
    )[0];
    const storedApproval = (
      await query(
        tx,
        "vertex_research_chat_execution_approvals",
        scope,
        responseRequestId,
        1
      )
    )[0];
    if (!(storedPlan && storedApproval)) return fail("denied");
    await checkedHash(plan, storedPlan["record_hash"]);
    if (
      storedPlan["plan_sha256"] !== plan["planSha256"] ||
      storedApproval["plan_sha256"] !== plan["planSha256"] ||
      storedApproval["owner_actor_id"] !== plan["ownerActorId"]
    )
      return fail("integrity");
    const inventory = await load(tx, scope, responseRequestId);
    if (
      !inventory ||
      inventory.closure ||
      inventory.family.ownerActorId !== plan["ownerActorId"] ||
      inventory.family.requestSha256 !== plan["requestSha256"]
    )
      return fail("denied");
    const entry = inventory.copies.find(
      (copy) =>
        copy.allocation.copyIdempotencyKey ===
        (isNativeEvidencePlan(plan)
          ? nativeEvidenceCopyKey("advisory")
          : "one-expert-advisory-v1")
    );
    if (
      entry?.allocation.kind !== "derived-output" ||
      entry.allocation.maximumBytes !== plan["advisoryMaximumBytes"] ||
      inventory.copies.length !== (isNativeEvidencePlan(plan) ? 9 : 4)
    )
      return fail("integrity");
    bytes(content.byteLength, entry.allocation.maximumBytes);
    if (entry.contentBinding) {
      if (
        (await ctx.hash(entry.contentBinding.content)) !==
        (await ctx.hash(content))
      )
        return fail("conflict");
      return entry.contentBinding;
    }
    if (
      time(timestamp(at)) < time(entry.allocation.reservedAt) ||
      time(at) >= time(plan["expiresAt"])
    )
      return fail("stale");
    const parents = inventory.copies.filter(
      (copy) => copy.allocation.copyId !== entry.allocation.copyId
    );
    if (
      (await ctx.hash(parents.map((copy) => copy.allocation.copyId).sort())) !==
      (await ctx.hash(entry.allocation.parentCopyIds))
    )
      return fail("integrity");
    for (const parent of parents) {
      if (!parent.contentBinding) return fail("conflict");
      if (time(at) < time(parent.contentBinding.boundAt)) return fail("stale");
    }
    const pin: VertexResearchChatCopyContentBinding = {
      profile: "vertex-research-chat-copy-content-binding-v1",
      scope,
      responseRequestId,
      copyId: entry.allocation.copyId,
      reservationSha256: entry.allocation.reservationSha256,
      content,
      boundAt: at,
    };
    await insert(tx, "vertex_research_chat_copy_content_bindings", scope, {
      ...contentColumns(pin),
      payload: pin,
      record_hash: sha(await ctx.hash(pin)),
    });
    return freeze(pin);
  };
  const bindNativeContentForTransaction = async (
    tx: Transaction,
    plan: VertexRecord,
    purpose: string,
    rawContent: unknown,
    at: string
  ): Promise<VertexResearchChatCopyContentBinding> => {
    if (
      !(
        isNativeEvidencePlan(plan) &&
        [
          "phaseOneResponse",
          "toolResult",
          "phaseTwoTokenizeInput",
          "phaseTwoCompletionInput",
        ].includes(purpose)
      )
    )
      return fail("invalid");
    const scope = scopeOf({
        accountAlias: plan["accountAlias"],
        environment: plan["environment"],
      }),
      responseRequestId = responseId(plan["responseRequestId"]);
    exact(rawContent, ["sha256", "byteLength"]);
    const content = {
      sha256: sha(object(rawContent)["sha256"]),
      byteLength: bytes(object(rawContent)["byteLength"]),
    };
    const stored = await one(
      tx,
      "vertex_research_chat_execution_plans",
      scope,
      sql`response_request_id = ${responseRequestId}`
    );
    if (!stored) return fail("denied");
    await checkedHash(plan, stored["record_hash"]);
    const inventory = await load(tx, scope, responseRequestId);
    if (
      !inventory ||
      inventory.closure ||
      inventory.copies.length !== 9 ||
      inventory.family.ownerActorId !== plan["ownerActorId"] ||
      inventory.family.requestSha256 !== plan["requestSha256"]
    )
      return fail("denied");
    const entry = inventory.copies.find(
      (copy) =>
        copy.allocation.copyIdempotencyKey === nativeEvidenceCopyKey(purpose)
    );
    if (
      entry?.allocation.kind !== "model-input" ||
      entry.allocation.maximumBytes !==
        object(plan["nativeEvidence"])["maximumIntermediateBytes"]
    )
      return fail("integrity");
    bytes(content.byteLength, entry.allocation.maximumBytes);
    if (
      time(timestamp(at)) < time(entry.allocation.reservedAt) ||
      time(at) >= time(plan["expiresAt"])
    )
      return fail("stale");
    if (entry.contentBinding) {
      if (
        (await ctx.hash(entry.contentBinding.content)) !==
        (await ctx.hash(content))
      )
        return fail("conflict");
      return entry.contentBinding;
    }
    for (const parentId of entry.allocation.parentCopyIds) {
      const parent = inventory.copies.find(
        (copy) => copy.allocation.copyId === parentId
      );
      if (
        !parent?.contentBinding ||
        time(parent.contentBinding.boundAt) > time(at)
      )
        return fail("conflict");
    }
    const pin: VertexResearchChatCopyContentBinding = {
      profile: "vertex-research-chat-copy-content-binding-v1",
      scope,
      responseRequestId,
      copyId: entry.allocation.copyId,
      reservationSha256: entry.allocation.reservationSha256,
      content,
      boundAt: at,
    };
    await insert(tx, "vertex_research_chat_copy_content_bindings", scope, {
      ...contentColumns(pin),
      payload: pin,
      record_hash: sha(await ctx.hash(pin)),
    });
    return freeze(pin);
  };
  return {
    responseIdentity,
    allocationIdentity,
    closureIdentity,
    checkedHash,
    query,
    bindingOf,
    parentsValid,
    load,
    cleanupCommand,
    cleanupDigest,
    cleanupReceipt,
    checkedCleanupReceipt,
    cleanupChronology,
    originalCleanup,
    readCleanupMetadata,
    reserveApprovedInputsForTransaction,
    bindAdvisoryContentForTransaction,
    bindNativeContentForTransaction,
  };
};

export const createResearchChatCopyOperations = (
  ctx: PersistenceContext,
  chat: ChatOwner
): VertexResearchChatCopyOperations => {
  const {
    responseIdentity,
    allocationIdentity,
    closureIdentity,
    query,
    bindingOf,
    parentsValid,
    load,
    cleanupCommand,
    cleanupDigest,
    cleanupReceipt,
    checkedCleanupReceipt,
    cleanupChronology,
    originalCleanup,
  } = createResearchChatCopyMetadata(ctx);
  const save = async (
    tx: Transaction,
    table: string,
    scope: VertexScope,
    value: VertexRecord,
    indexed: VertexRecord
  ): Promise<void> => {
    await insert(tx, table, scope, {
      ...indexed,
      payload: value,
      record_hash: sha(await ctx.hash(value)),
    });
  };
  const processingThread = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    threadId: string,
    at: string
  ): Promise<Readonly<{ current: VertexRecord }>> => {
    await ctx.authorize(principal, scope, null, "research-chat", "read", at);
    const thread = await chat.loadThread(tx, principal, scope, threadId);
    if (!thread) return fail("denied");
    return thread;
  };
  const unsettled = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexScope,
    metadata: VertexResearchChatCopyRequestMetadata
  ): Promise<void> => {
    if (
      await chat.readResponse(
        tx,
        principal,
        scope,
        metadata.threadId,
        metadata.idempotencyKey
      )
    )
      fail("conflict");
  };

  const reserveResearchChatCopy: VertexResearchChatCopyOperations["reserveResearchChatCopy"] =
    async (raw) => {
      const captured = ctx.capture(raw);
      exact(captured, [
        "principal",
        "scope",
        "request",
        "kind",
        "copyIdempotencyKey",
        "storageProfileSha256",
        "maximumBytes",
        "parentCopyIds",
      ]);
      const principal = actorOf(captured.principal);
      const scope = scopeOf(captured.scope);
      const supplied = exact(captured.request, [
        ...metadataKeys,
        "retrievalQuery",
      ]);
      const metadata = metadataOf(
        Object.fromEntries(metadataKeys.map((key) => [key, supplied[key]]))
      );
      if (
        metadata.accountAlias !== scope.accountAlias ||
        metadata.environment !== scope.environment
      )
        return fail("invalid");
      const kind = kindOf(captured.kind);
      const copyIdempotencyKey = id(captured.copyIdempotencyKey);
      const storageProfileSha256 = sha(captured.storageProfileSha256);
      const maximumBytes = bytes(captured.maximumBytes);
      const parentCopyIds = sortedIds(captured.parentCopyIds, 63);
      const command = await ctx.validateResearchChatInput(
        "requestResponse",
        supplied
      );
      const requestSha256 = sha(
        await ctx.hash({
          operation: "requestResponse",
          actorId: principal.actorId,
          input: command,
        })
      );
      const responseRequestId = await responseIdentity(
        principal,
        scope,
        metadata
      );
      const identity = {
        scope,
        ownerActorId: principal.actorId,
        threadId: metadata.threadId,
        responseRequestId,
        requestSha256,
        kind,
        copyIdempotencyKey,
        storageProfileSha256,
        maximumBytes,
        parentCopyIds,
      };
      const base: VertexResearchChatCopyAllocationBase = {
        profile: "vertex-research-chat-copy-allocation-v1",
        ...identity,
        copyId: await allocationIdentity(identity),
      };
      const reservationSha256 = sha(await ctx.hash(base));
      return ctx.run(
        principal,
        scope,
        null,
        "research-chat",
        "publish",
        async (tx, at) => {
          timestamp(at);
          const thread = await processingThread(
            tx,
            principal,
            scope,
            metadata.threadId,
            at
          );
          const inventory = await load(tx, scope, responseRequestId);
          if (inventory?.closure) return fail("conflict");
          await unsettled(tx, principal, scope, metadata);
          if (
            inventory &&
            (inventory.family.requestSha256 !== requestSha256 ||
              inventory.family.ownerActorId !== principal.actorId ||
              inventory.family.storageProfileSha256 !== storageProfileSha256 ||
              (await ctx.hash(inventory.family.requestMetadata)) !==
                (await ctx.hash(metadata)))
          )
            return fail("conflict");
          const previous = inventory?.copies.find(
            (entry) => entry.allocation.copyId === base.copyId
          )?.allocation;
          if (previous) {
            if (previous.reservationSha256 !== reservationSha256)
              return fail("conflict");
            // Original allocation ACK never acquires a content pin on replay.
            return previous;
          }
          await chat.verifyResponsePrefix(
            tx,
            principal,
            scope,
            thread,
            command,
            at
          );
          const copies = inventory?.copies ?? [];
          parentsValid(base, copies);
          if (
            copies.length >= 64 ||
            copies.reduce(
              (sum, entry) => sum + entry.allocation.maximumBytes,
              maximumBytes
            ) > MAX_VERTEX_CHAT_COPY_BYTES
          )
            return fail("invalid");
          if (
            copies.some(
              (entry) =>
                time(at) <
                time(
                  entry.contentBinding?.boundAt ?? entry.allocation.reservedAt
                )
            )
          )
            return fail("stale");
          const family: VertexResearchChatCopyFamily = inventory?.family ?? {
            profile: "vertex-research-chat-copy-family-v1",
            ...scope,
            ownerActorId: principal.actorId,
            threadId: metadata.threadId,
            responseRequestId,
            requestSha256,
            requestMetadata: metadata,
            storageProfileSha256,
            createdAt: at,
          };
          const binding = bindingOf(base, reservationSha256);
          const allocation: VertexResearchChatCopyAllocation = {
            ...base,
            reservationSha256,
            reservedAt: at,
            binding,
            objectKey: vertexChatCopyKey(binding),
          };
          if (!inventory)
            await save(
              tx,
              "vertex_research_chat_copy_families",
              scope,
              family,
              familyColumns(family)
            );
          await save(
            tx,
            "vertex_research_chat_copy_allocations",
            scope,
            allocation,
            allocationColumns(allocation)
          );
          for (const parent of parentCopyIds)
            await insert(tx, "vertex_research_chat_copy_dependencies", scope, {
              response_request_id: responseRequestId,
              child_copy_id: base.copyId,
              parent_copy_id: parent,
            });
          return freeze(allocation);
        },
        true
      );
    };

  const bindResearchChatCopyContent: VertexResearchChatCopyOperations["bindResearchChatCopyContent"] =
    async (raw) => {
      const captured = ctx.capture(raw);
      exact(captured, [
        "principal",
        "scope",
        "responseRequestId",
        "copyId",
        "content",
      ]);
      const principal = actorOf(captured.principal);
      const scope = scopeOf(captured.scope);
      const responseRequestId = responseId(captured.responseRequestId);
      const selectedCopyId = copyId(captured.copyId);
      exact(captured.content, ["sha256", "byteLength"]);
      const content = {
        sha256: sha(captured.content.sha256),
        byteLength: bytes(captured.content.byteLength),
      };
      return await ctx.run(
        principal,
        scope,
        null,
        "research-chat",
        "publish",
        async (tx, at) => {
          timestamp(at);
          await ctx.authorize(
            principal,
            scope,
            null,
            "research-chat",
            "read",
            at
          );
          // Resolve only the stored owner/thread first; do not disclose any copy,
          // closure or pin existence before current owned-thread verification.
          const familyRows = await query(
            tx,
            "vertex_research_chat_copy_families",
            scope,
            responseRequestId,
            1
          );
          const familyRow = familyRows[0];
          if (!familyRow || familyRow["owner_actor_id"] !== principal.actorId)
            return fail("denied");
          const thread = await processingThread(
            tx,
            principal,
            scope,
            id(familyRow["thread_id"]),
            at
          );
          const inventory = await load(tx, scope, responseRequestId);
          if (!inventory || inventory.family.ownerActorId !== principal.actorId)
            return fail("denied");
          if (inventory.closure) return fail("conflict");
          await unsettled(
            tx,
            principal,
            scope,
            inventory.family.requestMetadata
          );
          const entry = inventory.copies.find(
            (candidate) => candidate.allocation.copyId === selectedCopyId
          );
          if (!entry) return fail("denied");
          bytes(content.byteLength, entry.allocation.maximumBytes);
          if (entry.contentBinding) {
            if (
              (await ctx.hash(entry.contentBinding.content)) !==
              (await ctx.hash(content))
            )
              return fail("conflict");
            return entry.contentBinding;
          }
          if (
            time(at) < time(thread.current["updatedAt"]) ||
            time(at) < time(entry.allocation.reservedAt)
          )
            return fail("stale");
          for (const parentId of entry.allocation.parentCopyIds) {
            const parent = requirePresent(
              inventory.copies.find(
                (candidate) => candidate.allocation.copyId === parentId
              ),
              "inventory.copies.find( (candidate) => candidate.allocation.copyId === parentId )"
            );
            if (!parent.contentBinding) return fail("conflict");
            if (time(at) < time(parent.contentBinding.boundAt))
              return fail("stale");
          }
          const pin: VertexResearchChatCopyContentBinding = {
            profile: "vertex-research-chat-copy-content-binding-v1",
            scope,
            responseRequestId,
            copyId: selectedCopyId,
            reservationSha256: entry.allocation.reservationSha256,
            content,
            boundAt: at,
          };
          await save(
            tx,
            "vertex_research_chat_copy_content_bindings",
            scope,
            pin,
            contentColumns(pin)
          );
          return freeze(pin);
        },
        true
      );
    };

  // Transaction-local closure owner shared by generic closure and explicit
  // intent. Never call the public close method from another ctx.run transaction.
  const closeInventory = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexChatCopyScope,
    responseRequestId: string,
    inventory: VertexResearchChatCopyInventory,
    at: string
  ): Promise<VertexResearchChatCopyInventory> => {
    if (inventory.closure) return inventory;
    const closed = time(timestamp(at));
    if (
      inventory.copies.some(
        (entry) =>
          closed <
          time(entry.contentBinding?.boundAt ?? entry.allocation.reservedAt)
      )
    )
      return fail("stale");
    const closure: VertexResearchChatCopyClosure = {
      profile: "vertex-research-chat-copy-closure-v1",
      scope,
      responseRequestId,
      closureId: await closureIdentity(scope, responseRequestId),
      closedByActorId: principal.actorId,
      closedAt: at,
      inventorySha256: sha(
        await ctx.hash({ family: inventory.family, copies: inventory.copies })
      ),
      copyIds: inventory.copies.map((entry) => entry.allocation.copyId),
    };
    await save(
      tx,
      "vertex_research_chat_copy_closures",
      scope,
      closure,
      closureColumns(closure)
    );
    // Allocation domain closed only. No observed object state/cleanup claims.
    return freeze({ ...inventory, closure });
  };

  const closeResearchChatCopyFamily: VertexResearchChatCopyOperations["closeResearchChatCopyFamily"] =
    async (raw) => {
      const captured = ctx.capture(raw);
      exact(captured, ["principal", "scope", "responseRequestId"]);
      const principal = actorOf(captured.principal);
      const scope = scopeOf(captured.scope);
      const responseRequestId = responseId(captured.responseRequestId);
      return await ctx.run(
        principal,
        scope,
        null,
        `research-chat-copies:${responseRequestId}`,
        "cleanup-chat-copies",
        async (tx, at) => {
          const inventory = await load(tx, scope, responseRequestId);
          if (!inventory) return fail("invalid");
          return closeInventory(
            tx,
            principal,
            scope,
            responseRequestId,
            inventory,
            at
          );
        },
        true
      );
    };

  const readResearchChatCopyInventory: VertexResearchChatCopyOperations["readResearchChatCopyInventory"] =
    async (rawPrincipal, rawScope, rawResponseRequestId) => {
      const captured = ctx.capture([
        rawPrincipal,
        rawScope,
        rawResponseRequestId,
      ] as const);
      const principal = actorOf(captured[0]);
      const scope = scopeOf(captured[1]);
      const responseRequestId = responseId(captured[2]);
      return await ctx.run(
        principal,
        scope,
        null,
        `research-chat-copies:${responseRequestId}`,
        "cleanup-chat-copies",
        async (tx) => load(tx, scope, responseRequestId),
        true
      );
    };

  const ownedCleanupInventory = async (
    tx: Transaction,
    principal: VertexPrincipal,
    scope: VertexChatCopyScope,
    command: CleanupCommand
  ): Promise<VertexResearchChatCopyInventory> => {
    const inventory = await load(tx, scope, command.responseRequestId);
    if (
      !inventory ||
      inventory.family.ownerActorId !== principal.actorId ||
      inventory.family.threadId !== command.threadId
    )
      return fail("denied");
    return inventory;
  };
  const requestResearchChatCopyCleanup: VertexResearchChatCopyOperations["requestResearchChatCopyCleanup"] =
    async (raw) => {
      const captured = ctx.capture(raw);
      exact(captured, [
        "principal",
        "scope",
        "threadId",
        "responseRequestId",
        "idempotencyKey",
      ]);
      const principal = actorOf(captured.principal);
      const scope = scopeOf(captured.scope);
      const command = await cleanupCommand(
        "requestCopyCleanup",
        scope,
        captured.threadId,
        captured.responseRequestId,
        captured.idempotencyKey
      );
      const requestSha256 = await cleanupDigest(principal, command);
      return ctx.run(
        principal,
        scope,
        null,
        `research-chat-copies:${command.responseRequestId}`,
        "cleanup-chat-copies",
        async (tx, at) => {
          const inventory = await ownedCleanupInventory(
            tx,
            principal,
            scope,
            command
          );
          // Reconcile first: the original ACK cannot be refreshed or upgraded.
          const previous = await originalCleanup(
            tx,
            principal,
            scope,
            command,
            requestSha256,
            inventory
          );
          if (previous) return previous;
          cleanupChronology(inventory, at, "stale");
          const closed = await closeInventory(
            tx,
            principal,
            scope,
            command.responseRequestId,
            inventory,
            at
          );
          if (!closed.closure) return fail("integrity");
          const receipt = await checkedCleanupReceipt(
            cleanupReceipt(principal, command, requestSha256, at),
            cleanupReceipt(principal, command, requestSha256, at)
          );
          const intent: CleanupIntent = {
            profile: "vertex-research-chat-copy-explicit-cleanup-intent-v1",
            receipt,
            closureId: closed.closure.closureId,
            inventorySha256: closed.closure.inventorySha256,
          };
          await save(
            tx,
            "vertex_research_chat_copy_cleanup_intents",
            scope,
            intent,
            cleanupColumns(intent)
          );
          return receipt;
        },
        true
      );
    };
  const readResearchChatCopyCleanup: VertexResearchChatCopyOperations["readResearchChatCopyCleanup"] =
    async (
      rawPrincipal,
      rawScope,
      rawThreadId,
      rawResponseRequestId,
      rawIdempotencyKey
    ) => {
      const captured = ctx.capture([
        rawPrincipal,
        rawScope,
        rawThreadId,
        rawResponseRequestId,
        rawIdempotencyKey,
      ] as const);
      const principal = actorOf(captured[0]);
      const scope = scopeOf(captured[1]);
      const command = await cleanupCommand(
        "readCopyCleanup",
        scope,
        captured[2],
        captured[3],
        captured[4]
      );
      const requestSha256 = await cleanupDigest(principal, command);
      return ctx.run(
        principal,
        scope,
        null,
        `research-chat-copies:${command.responseRequestId}`,
        "cleanup-chat-copies",
        async (tx) => {
          const inventory = await ownedCleanupInventory(
            tx,
            principal,
            scope,
            command
          );
          return originalCleanup(
            tx,
            principal,
            scope,
            command,
            requestSha256,
            inventory
          );
        },
        true
      );
    };
  return {
    reserveResearchChatCopy,
    bindResearchChatCopyContent,
    closeResearchChatCopyFamily,
    readResearchChatCopyInventory,
    requestResearchChatCopyCleanup,
    readResearchChatCopyCleanup,
  };
};
