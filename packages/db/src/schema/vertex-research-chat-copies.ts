import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { vertexResearchChatThreads } from "./vertex-research-chat.ts";

// Metadata only; no body, query, grant, backend readiness or physical-cleanup
// receipt. Canonical hashes, ns time, reference DAG and aggregate capacity are
// verified by the existing locked store. 0012 also forbids UPDATE/DELETE on all
// five append-only tables; there is no mutable closed flag or reopen operation.
const domain = () => ({
  accountAlias: text("account_alias").notNull(),
  environment: text("environment").notNull(),
  responseRequestId: text("response_request_id").notNull(),
});
const record = () => ({
  payload: jsonb("payload")
    .$type<Readonly<Record<string, unknown>>>()
    .notNull(),
  recordHash: text("record_hash").notNull(),
});
const ns = (name: string) =>
  numeric(name, { precision: 30, scale: 0 }).notNull();

export const vertexResearchChatCopyFamilies = pgTable(
  "vertex_research_chat_copy_families",
  {
    ...domain(),
    ...record(),
    ownerActorId: text("owner_actor_id").notNull(),
    threadId: text("thread_id").notNull(),
    requestIdempotencyKey: text("request_idempotency_key").notNull(),
    requestSha256: text("request_sha256").notNull(),
    storageProfileSha256: text("storage_profile_sha256").notNull(),
    createdAt: text("created_at").notNull(),
    createdAtNs: ns("created_at_ns"),
  },
  (t) => [
    primaryKey({
      name: "vertex_copy_family_pk",
      columns: [t.responseRequestId],
    }),
    uniqueIndex("vertex_copy_family_scope").on(
      t.accountAlias,
      t.environment,
      t.responseRequestId
    ),
    uniqueIndex("vertex_copy_family_owner").on(
      t.accountAlias,
      t.environment,
      t.responseRequestId,
      t.ownerActorId,
      t.threadId,
      t.requestSha256,
      t.storageProfileSha256
    ),
    uniqueIndex("vertex_copy_family_request").on(
      t.accountAlias,
      t.environment,
      t.ownerActorId,
      t.threadId,
      t.requestIdempotencyKey
    ),
    uniqueIndex("vertex_copy_family_cleanup_owner").on(
      t.accountAlias,
      t.environment,
      t.responseRequestId,
      t.ownerActorId,
      t.threadId
    ),
    foreignKey({
      name: "vertex_copy_family_thread",
      columns: [t.accountAlias, t.environment, t.ownerActorId, t.threadId],
      foreignColumns: [
        vertexResearchChatThreads.accountAlias,
        vertexResearchChatThreads.environment,
        vertexResearchChatThreads.ownerActorId,
        vertexResearchChatThreads.threadId,
      ],
    }).onDelete("restrict"),
    check(
      "vertex_copy_family_scope_check",
      sql`${t.environment} = 'research' and ${t.responseRequestId} ~ '^response-[0-9a-f]{64}$' and length(${t.responseRequestId}) = 73 and ${t.ownerActorId} ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and ${t.ownerActorId} !~ '[^A-Za-z0-9_.:-]' and ${t.requestIdempotencyKey} ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and ${t.requestIdempotencyKey} !~ '[^A-Za-z0-9_.:-]'`
    ),
    check(
      "vertex_copy_family_hashes",
      sql`${t.requestSha256} ~ '^[0-9a-f]{64}$' and length(${t.requestSha256}) = 64 and ${t.storageProfileSha256} ~ '^[0-9a-f]{64}$' and length(${t.storageProfileSha256}) = 64 and ${t.recordHash} ~ '^[0-9a-f]{64}$' and length(${t.recordHash}) = 64`
    ),
    check(
      "vertex_copy_family_payload",
      sql`(${t.payload} = jsonb_build_object('profile','vertex-research-chat-copy-family-v1','accountAlias',${t.accountAlias},'environment',${t.environment},'ownerActorId',${t.ownerActorId},'threadId',${t.threadId},'responseRequestId',${t.responseRequestId},'requestSha256',${t.requestSha256},'storageProfileSha256',${t.storageProfileSha256},'createdAt',${t.createdAt},'requestMetadata',jsonb_build_object('accountAlias',${t.accountAlias},'environment',${t.environment},'threadId',${t.threadId},'idempotencyKey',${t.requestIdempotencyKey},'parentMessageId',${t.payload} #> '{requestMetadata,parentMessageId}','participantId',${t.payload} #> '{requestMetadata,participantId}','snapshotRevision',${t.payload} #> '{requestMetadata,snapshotRevision}','contextStartSequence',${t.payload} #> '{requestMetadata,contextStartSequence}')) and jsonb_typeof(${t.payload} #> '{requestMetadata,parentMessageId}') = 'string' and (${t.payload} #>> '{requestMetadata,parentMessageId}') ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and (${t.payload} #>> '{requestMetadata,parentMessageId}') !~ '[^A-Za-z0-9_.:-]' and jsonb_typeof(${t.payload} #> '{requestMetadata,participantId}') = 'string' and (${t.payload} #>> '{requestMetadata,participantId}') ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and (${t.payload} #>> '{requestMetadata,participantId}') !~ '[^A-Za-z0-9_.:-]' and jsonb_typeof(${t.payload} #> '{requestMetadata,snapshotRevision}') = 'string' and jsonb_typeof(${t.payload} #> '{requestMetadata,contextStartSequence}') = 'string' and case when (${t.payload} #>> '{requestMetadata,snapshotRevision}') ~ '^[1-9][0-9]{0,29}$' and (${t.payload} #>> '{requestMetadata,snapshotRevision}') !~ '[^0-9]' and (${t.payload} #>> '{requestMetadata,contextStartSequence}') ~ '^[1-9][0-9]{0,29}$' and (${t.payload} #>> '{requestMetadata,contextStartSequence}') !~ '[^0-9]' then (${t.payload} #>> '{requestMetadata,snapshotRevision}')::numeric >= 2 and (${t.payload} #>> '{requestMetadata,snapshotRevision}')::numeric - (${t.payload} #>> '{requestMetadata,contextStartSequence}')::numeric between 1 and 16 else false end) is true`
    ),
  ]
);

export const vertexResearchChatCopyAllocations = pgTable(
  "vertex_research_chat_copy_allocations",
  {
    ...domain(),
    ...record(),
    ownerActorId: text("owner_actor_id").notNull(),
    threadId: text("thread_id").notNull(),
    requestSha256: text("request_sha256").notNull(),
    copyId: text("copy_id").notNull(),
    copyIdempotencyKey: text("copy_idempotency_key").notNull(),
    kind: text("kind").notNull(),
    storageProfileSha256: text("storage_profile_sha256").notNull(),
    maximumBytes: integer("maximum_bytes").notNull(),
    reservationSha256: text("reservation_sha256").notNull(),
    objectKey: text("object_key").notNull(),
    reservedAt: text("reserved_at").notNull(),
    reservedAtNs: ns("reserved_at_ns"),
  },
  (t) => [
    primaryKey({ name: "vertex_copy_allocation_pk", columns: [t.copyId] }),
    uniqueIndex("vertex_copy_allocation_scope").on(
      t.accountAlias,
      t.environment,
      t.responseRequestId,
      t.copyId
    ),
    uniqueIndex("vertex_copy_allocation_reservation").on(
      t.accountAlias,
      t.environment,
      t.responseRequestId,
      t.copyId,
      t.reservationSha256
    ),
    uniqueIndex("vertex_copy_allocation_logical").on(
      t.accountAlias,
      t.environment,
      t.ownerActorId,
      t.threadId,
      t.responseRequestId,
      t.kind,
      t.copyIdempotencyKey
    ),
    uniqueIndex("vertex_copy_allocation_object").on(t.objectKey),
    foreignKey({
      name: "vertex_copy_allocation_family",
      columns: [
        t.accountAlias,
        t.environment,
        t.responseRequestId,
        t.ownerActorId,
        t.threadId,
        t.requestSha256,
        t.storageProfileSha256,
      ],
      foreignColumns: [
        vertexResearchChatCopyFamilies.accountAlias,
        vertexResearchChatCopyFamilies.environment,
        vertexResearchChatCopyFamilies.responseRequestId,
        vertexResearchChatCopyFamilies.ownerActorId,
        vertexResearchChatCopyFamilies.threadId,
        vertexResearchChatCopyFamilies.requestSha256,
        vertexResearchChatCopyFamilies.storageProfileSha256,
      ],
    }).onDelete("restrict"),
    check(
      "vertex_copy_allocation_shape",
      sql`${t.environment} = 'research' and ${t.copyId} ~ '^chat-copy-[0-9a-f]{64}$' and length(${t.copyId}) = 74 and ${t.copyIdempotencyKey} ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and ${t.copyIdempotencyKey} !~ '[^A-Za-z0-9_.:-]' and ${t.kind} in ('context','model-input','derived-output') and ${t.maximumBytes} between 1 and 16777216 and octet_length(${t.objectKey}) between 1 and 1024 and ${t.objectKey} like 'vertex/chat-copy/v1/%' and ${t.reservationSha256} ~ '^[0-9a-f]{64}$' and length(${t.reservationSha256}) = 64 and ${t.recordHash} ~ '^[0-9a-f]{64}$' and length(${t.recordHash}) = 64`
    ),
    check(
      "vertex_copy_allocation_payload",
      sql`(${t.payload} = jsonb_build_object('profile','vertex-research-chat-copy-allocation-v1','scope',jsonb_build_object('accountAlias',${t.accountAlias},'environment',${t.environment}),'ownerActorId',${t.ownerActorId},'threadId',${t.threadId},'responseRequestId',${t.responseRequestId},'requestSha256',${t.requestSha256},'copyId',${t.copyId},'copyIdempotencyKey',${t.copyIdempotencyKey},'kind',${t.kind},'storageProfileSha256',${t.storageProfileSha256},'maximumBytes',${t.maximumBytes},'parentCopyIds',${t.payload}->'parentCopyIds','reservationSha256',${t.reservationSha256},'reservedAt',${t.reservedAt},'objectKey',${t.objectKey},'binding',jsonb_build_object('scope',jsonb_build_object('accountAlias',${t.accountAlias},'environment',${t.environment}),'ownerActorId',${t.ownerActorId},'threadId',${t.threadId},'responseRequestId',${t.responseRequestId},'copyId',${t.copyId},'kind',${t.kind},'reservationSha256',${t.reservationSha256},'storageProfileSha256',${t.storageProfileSha256},'maximumBytes',${t.maximumBytes},'content',null)) and jsonb_typeof(${t.payload}->'parentCopyIds') = 'array' and jsonb_array_length(${t.payload}->'parentCopyIds') between 0 and 63 and ((${t.kind} = 'context' and ${t.payload}->'parentCopyIds' = '[]'::jsonb) or (${t.kind} <> 'context' and jsonb_array_length(${t.payload}->'parentCopyIds') > 0)) and not jsonb_path_exists(${t.payload}->'parentCopyIds', '$[*] ? (@.type() != "string" || !(@ like_regex "^chat-copy-[0-9a-f]{64}$"))')) is true`
    ),
  ]
);

export const vertexResearchChatCopyContentBindings = pgTable(
  "vertex_research_chat_copy_content_bindings",
  {
    ...domain(),
    ...record(),
    copyId: text("copy_id").notNull(),
    reservationSha256: text("reservation_sha256").notNull(),
    contentSha256: text("content_sha256").notNull(),
    byteLength: integer("byte_length").notNull(),
    boundAt: text("bound_at").notNull(),
    boundAtNs: ns("bound_at_ns"),
  },
  (t) => [
    primaryKey({ name: "vertex_copy_content_pk", columns: [t.copyId] }),
    foreignKey({
      name: "vertex_copy_content_allocation",
      columns: [
        t.accountAlias,
        t.environment,
        t.responseRequestId,
        t.copyId,
        t.reservationSha256,
      ],
      foreignColumns: [
        vertexResearchChatCopyAllocations.accountAlias,
        vertexResearchChatCopyAllocations.environment,
        vertexResearchChatCopyAllocations.responseRequestId,
        vertexResearchChatCopyAllocations.copyId,
        vertexResearchChatCopyAllocations.reservationSha256,
      ],
    }).onDelete("restrict"),
    check(
      "vertex_copy_content_shape",
      sql`${t.byteLength} between 1 and 16777216 and ${t.contentSha256} ~ '^[0-9a-f]{64}$' and length(${t.contentSha256}) = 64 and ${t.recordHash} ~ '^[0-9a-f]{64}$' and length(${t.recordHash}) = 64`
    ),
    check(
      "vertex_copy_content_payload",
      sql`(${t.payload} = jsonb_build_object('profile','vertex-research-chat-copy-content-binding-v1','scope',jsonb_build_object('accountAlias',${t.accountAlias},'environment',${t.environment}),'responseRequestId',${t.responseRequestId},'copyId',${t.copyId},'reservationSha256',${t.reservationSha256},'content',jsonb_build_object('sha256',${t.contentSha256},'byteLength',${t.byteLength}),'boundAt',${t.boundAt})) is true`
    ),
  ]
);

export const vertexResearchChatCopyDependencies = pgTable(
  "vertex_research_chat_copy_dependencies",
  {
    ...domain(),
    childCopyId: text("child_copy_id").notNull(),
    parentCopyId: text("parent_copy_id").notNull(),
  },
  (t) => [
    primaryKey({
      name: "vertex_copy_dependency_pk",
      columns: [
        t.accountAlias,
        t.environment,
        t.responseRequestId,
        t.childCopyId,
        t.parentCopyId,
      ],
    }),
    foreignKey({
      name: "vertex_copy_dependency_child",
      columns: [
        t.accountAlias,
        t.environment,
        t.responseRequestId,
        t.childCopyId,
      ],
      foreignColumns: [
        vertexResearchChatCopyAllocations.accountAlias,
        vertexResearchChatCopyAllocations.environment,
        vertexResearchChatCopyAllocations.responseRequestId,
        vertexResearchChatCopyAllocations.copyId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "vertex_copy_dependency_parent",
      columns: [
        t.accountAlias,
        t.environment,
        t.responseRequestId,
        t.parentCopyId,
      ],
      foreignColumns: [
        vertexResearchChatCopyAllocations.accountAlias,
        vertexResearchChatCopyAllocations.environment,
        vertexResearchChatCopyAllocations.responseRequestId,
        vertexResearchChatCopyAllocations.copyId,
      ],
    }).onDelete("restrict"),
    check(
      "vertex_copy_dependency_distinct",
      sql`${t.childCopyId} <> ${t.parentCopyId}`
    ),
  ]
);

export const vertexResearchChatCopyClosures = pgTable(
  "vertex_research_chat_copy_closures",
  {
    ...domain(),
    ...record(),
    closureId: text("closure_id").notNull(),
    closedByActorId: text("closed_by_actor_id").notNull(),
    closedAt: text("closed_at").notNull(),
    closedAtNs: ns("closed_at_ns"),
    inventorySha256: text("inventory_sha256").notNull(),
  },
  (t) => [
    primaryKey({
      name: "vertex_copy_closure_pk",
      columns: [t.accountAlias, t.environment, t.responseRequestId],
    }),
    uniqueIndex("vertex_copy_closure_identity").on(t.closureId),
    uniqueIndex("vertex_copy_closure_cleanup_link").on(
      t.accountAlias,
      t.environment,
      t.responseRequestId,
      t.closureId,
      t.inventorySha256
    ),
    foreignKey({
      name: "vertex_copy_closure_family",
      columns: [t.accountAlias, t.environment, t.responseRequestId],
      foreignColumns: [
        vertexResearchChatCopyFamilies.accountAlias,
        vertexResearchChatCopyFamilies.environment,
        vertexResearchChatCopyFamilies.responseRequestId,
      ],
    }).onDelete("restrict"),
    check(
      "vertex_copy_closure_shape",
      sql`${t.closureId} ~ '^copy-closure-[0-9a-f]{64}$' and length(${t.closureId}) = 77 and ${t.closedByActorId} ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and ${t.closedByActorId} !~ '[^A-Za-z0-9_.:-]' and ${t.inventorySha256} ~ '^[0-9a-f]{64}$' and length(${t.inventorySha256}) = 64 and ${t.recordHash} ~ '^[0-9a-f]{64}$' and length(${t.recordHash}) = 64`
    ),
    check(
      "vertex_copy_closure_payload",
      sql`(${t.payload} = jsonb_build_object('profile','vertex-research-chat-copy-closure-v1','scope',jsonb_build_object('accountAlias',${t.accountAlias},'environment',${t.environment}),'responseRequestId',${t.responseRequestId},'closureId',${t.closureId},'closedByActorId',${t.closedByActorId},'closedAt',${t.closedAt},'inventorySha256',${t.inventorySha256},'copyIds',${t.payload}->'copyIds') and jsonb_typeof(${t.payload}->'copyIds') = 'array' and jsonb_array_length(${t.payload}->'copyIds') between 1 and 64 and not jsonb_path_exists(${t.payload}->'copyIds', '$[*] ? (@.type() != "string" || !(@ like_regex "^chat-copy-[0-9a-f]{64}$"))')) is true`
    ),
  ]
);

// SOURCE ONLY (0013). Explicit account-originated intent is separate from generic
// closure. An immutable requested receipt never asserts current physical state.
export const vertexResearchChatCopyCleanupIntents = pgTable(
  "vertex_research_chat_copy_cleanup_intents",
  {
    ...domain(),
    ...record(),
    ownerActorId: text("owner_actor_id").notNull(),
    threadId: text("thread_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    cleanupRequestId: text("cleanup_request_id").notNull(),
    requestSha256: text("request_sha256").notNull(),
    recordedAt: text("recorded_at").notNull(),
    recordedAtNs: ns("recorded_at_ns"),
    closureId: text("closure_id").notNull(),
    inventorySha256: text("inventory_sha256").notNull(),
  },
  (t) => [
    primaryKey({
      name: "vertex_copy_cleanup_pk",
      columns: [t.cleanupRequestId],
    }),
    uniqueIndex("vertex_copy_cleanup_request").on(
      t.accountAlias,
      t.environment,
      t.ownerActorId,
      t.threadId,
      t.responseRequestId,
      t.idempotencyKey
    ),
    foreignKey({
      name: "vertex_copy_cleanup_family",
      columns: [
        t.accountAlias,
        t.environment,
        t.responseRequestId,
        t.ownerActorId,
        t.threadId,
      ],
      foreignColumns: [
        vertexResearchChatCopyFamilies.accountAlias,
        vertexResearchChatCopyFamilies.environment,
        vertexResearchChatCopyFamilies.responseRequestId,
        vertexResearchChatCopyFamilies.ownerActorId,
        vertexResearchChatCopyFamilies.threadId,
      ],
    }).onDelete("restrict"),
    foreignKey({
      name: "vertex_copy_cleanup_closure",
      columns: [
        t.accountAlias,
        t.environment,
        t.responseRequestId,
        t.closureId,
        t.inventorySha256,
      ],
      foreignColumns: [
        vertexResearchChatCopyClosures.accountAlias,
        vertexResearchChatCopyClosures.environment,
        vertexResearchChatCopyClosures.responseRequestId,
        vertexResearchChatCopyClosures.closureId,
        vertexResearchChatCopyClosures.inventorySha256,
      ],
    }).onDelete("restrict"),
    check(
      "vertex_copy_cleanup_scope",
      sql`${t.environment} = 'research' and ${t.accountAlias} ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and ${t.accountAlias} !~ '[^A-Za-z0-9_.:-]' and ${t.ownerActorId} ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and ${t.ownerActorId} !~ '[^A-Za-z0-9_.:-]' and ${t.threadId} ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and ${t.threadId} !~ '[^A-Za-z0-9_.:-]' and ${t.idempotencyKey} ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and ${t.idempotencyKey} !~ '[^A-Za-z0-9_.:-]' and ${t.responseRequestId} ~ '^response-[0-9a-f]{64}$' and length(${t.responseRequestId}) = 73`
    ),
    check(
      "vertex_copy_cleanup_identity",
      sql`${t.requestSha256} ~ '^[0-9a-f]{64}$' and length(${t.requestSha256}) = 64 and ${t.cleanupRequestId} = 'copy-cleanup-' || ${t.requestSha256} and ${t.closureId} ~ '^copy-closure-[0-9a-f]{64}$' and length(${t.closureId}) = 77 and ${t.inventorySha256} ~ '^[0-9a-f]{64}$' and length(${t.inventorySha256}) = 64 and ${t.recordHash} ~ '^[0-9a-f]{64}$' and length(${t.recordHash}) = 64`
    ),
    check(
      "vertex_copy_cleanup_time",
      sql`${t.recordedAt} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$' and ${t.recordedAt} !~ '[^0-9TZ.:-]'`
    ),
    check(
      "vertex_copy_cleanup_payload",
      sql`(${t.payload} = jsonb_build_object('profile','vertex-research-chat-copy-explicit-cleanup-intent-v1','closureId',${t.closureId},'inventorySha256',${t.inventorySha256},'receipt',jsonb_build_object('schemaVersion','1.0.0','executionAuthorized',false,'status','requested','accountAlias',${t.accountAlias},'environment',${t.environment},'threadId',${t.threadId},'ownerActorId',${t.ownerActorId},'responseRequestId',${t.responseRequestId},'idempotencyKey',${t.idempotencyKey},'cleanupRequestId',${t.cleanupRequestId},'requestSha256',${t.requestSha256},'recordedAt',${t.recordedAt},'targetKinds',jsonb_build_array('context','model-input','derived-output')))) is true`
    ),
  ]
);
