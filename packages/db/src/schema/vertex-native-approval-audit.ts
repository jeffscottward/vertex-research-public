import { sql } from "drizzle-orm";
import {
  check,
  index,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// Shared across BOTH native approval purposes and ALL accounts. Neither scope
// nor action belongs in the nonce uniqueness key; rotation uses raw-key SHA.
export const vertexNativeApprovalAudit = pgTable(
  "vertex_native_approval_audit",
  {
    signerKeyId: text("signer_key_id").notNull(),
    signerKeySha256: text("signer_key_sha256").notNull(),
    approvalId: text("approval_id").notNull(),
    nonce: text("nonce").notNull(),
    approverActorId: text("approver_actor_id").notNull(),
    action: text("action").notNull(),
    subjectSha256: text("subject_sha256").notNull(),
    approvalSha256: text("approval_sha256").notNull(),
    statusRevision: numeric("status_revision", {
      precision: 30,
      scale: 0,
    }).notNull(),
    statusSha256: text("status_sha256").notNull(),
    expiresAt: text("expires_at").notNull(),
    accountAlias: text("account_alias").notNull(),
    environment: text("environment").notNull(),
    recipientActorId: text("recipient_actor_id").notNull(),
    streamId: text("stream_id").notNull(),
    requestId: text("request_id").notNull(),
    requestSha256: text("request_sha256").notNull(),
    approvalBase64: text("approval_base64").notNull(),
    outcome: jsonb("outcome")
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    recordedAt: text("recorded_at").notNull(),
    recordHash: text("record_hash").notNull(),
    payload: jsonb("payload")
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.signerKeySha256, t.approvalId] }),
    uniqueIndex("vertex_native_approval_nonce").on(t.signerKeySha256, t.nonce),
    uniqueIndex("vertex_native_approval_exact_request").on(
      t.signerKeySha256,
      t.approvalId,
      t.requestSha256
    ),
    index("vertex_native_approval_request").on(
      t.accountAlias,
      t.environment,
      t.recipientActorId,
      t.action,
      t.requestId
    ),
    check(
      "vertex_native_approval_purpose",
      sql`${t.environment} = 'paper' and ${t.action} in ('owner-epoch-transition','native-outbox-replay') and ${t.approverActorId} <> ${t.recipientActorId} and ${t.statusRevision} > 0`
    ),
    check(
      "vertex_native_approval_digests",
      sql`${t.signerKeySha256} ~ '^[0-9a-f]{64}$' and ${t.nonce} ~ '^[0-9a-f]{64}$' and ${t.subjectSha256} ~ '^[0-9a-f]{64}$' and ${t.approvalSha256} ~ '^[0-9a-f]{64}$' and ${t.statusSha256} ~ '^[0-9a-f]{64}$' and ${t.requestSha256} ~ '^[0-9a-f]{64}$' and ${t.recordHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "vertex_native_approval_proof",
      sql`length(${t.approvalBase64}) between 4 and 1398104 and ${t.approvalBase64} ~ '^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$' and octet_length(decode(${t.approvalBase64}, 'base64')) between 1 and 1048576 and replace(encode(decode(${t.approvalBase64}, 'base64'), 'base64'), E'\n', '') = ${t.approvalBase64}`
    ),
    check(
      "vertex_native_approval_binding",
      sql`(${t.payload}->>'accountAlias' = ${t.accountAlias} and ${t.payload}->>'environment' = ${t.environment} and ${t.payload}->>'recipientActorId' = ${t.recipientActorId} and ${t.payload}->>'streamId' = ${t.streamId} and ${t.payload}->>'requestId' = ${t.requestId} and ${t.payload}->>'requestSha256' = ${t.requestSha256} and ${t.payload}->>'approvalBase64' = ${t.approvalBase64} and ${t.payload}->>'recordedAt' = ${t.recordedAt} and ${t.payload}->'outcome' = ${t.outcome} and ${t.payload}->'receipt'->>'signerKeyId' = ${t.signerKeyId} and ${t.payload}->'receipt'->>'signerKeySha256' = ${t.signerKeySha256} and ${t.payload}->'receipt'->>'approvalId' = ${t.approvalId} and ${t.payload}->'receipt'->>'nonce' = ${t.nonce} and ${t.payload}->'receipt'->>'actorId' = ${t.approverActorId} and ${t.payload}->'receipt'->>'action' = ${t.action} and ${t.payload}->'receipt'->>'subjectSha256' = ${t.subjectSha256} and ${t.payload}->'receipt'->>'approvalSha256' = ${t.approvalSha256} and ${t.payload}->'receipt'->>'statusRevision' = ${t.statusRevision}::text and ${t.payload}->'receipt'->>'statusSha256' = ${t.statusSha256} and ${t.payload}->'receipt'->>'expiresAt' = ${t.expiresAt}) is true`
    ),
    check(
      "vertex_native_approval_outcome",
      sql`(${t.outcome}->>'status' in ('applied','duplicate','gap','epoch-mismatch','stale') and ${t.outcome}->>'highWaterSequence' ~ '^(0|[1-9][0-9]{0,29})$' and (${t.outcome}->'highWaterEventHash' = 'null'::jsonb or ${t.outcome}->>'highWaterEventHash' ~ '^[0-9a-f]{64}$')) is true`
    ),
  ]
);
