import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { vertexAccountAliases } from "./vertex.ts";

// Same request-scoped PostgreSQL authority. No artifact, grant, model run or
// retention/deletion authority is created by a human conversation.
const ownerScope = () => ({
  accountAlias: text("account_alias").notNull(),
  environment: text("environment").notNull(),
  ownerActorId: text("owner_actor_id").notNull(),
});
const record = (name: string) =>
  jsonb(name).$type<Readonly<Record<string, unknown>>>().notNull();
const ordinal = (name: string) =>
  numeric(name, { precision: 30, scale: 0 }).notNull();

export const vertexResearchChatThreads = pgTable(
  "vertex_research_chat_threads",
  {
    ...ownerScope(),
    threadId: text("thread_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    revision: ordinal("revision"),
    lastSequence: ordinal("last_sequence"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    request: record("request"),
    requestHash: text("request_hash").notNull(),
    response: record("response"),
    responseHash: text("response_hash").notNull(),
    payload: record("payload"),
    recordHash: text("record_hash").notNull(),
  },
  (t) => [
    primaryKey({
      name: "vertex_chat_thread_identity",
      columns: [t.accountAlias, t.environment, t.ownerActorId, t.threadId],
    }),
    uniqueIndex("vertex_chat_thread_idempotency").on(
      t.accountAlias,
      t.environment,
      t.ownerActorId,
      t.idempotencyKey
    ),
    index("vertex_chat_thread_order").on(
      t.accountAlias,
      t.environment,
      t.ownerActorId,
      sql`${t.threadId} collate "C"`
    ),
    foreignKey({
      name: "vertex_chat_thread_account",
      columns: [t.accountAlias, t.environment],
      foreignColumns: [
        vertexAccountAliases.accountAlias,
        vertexAccountAliases.environment,
      ],
    }).onDelete("restrict"),
    check(
      "vertex_chat_thread_scope",
      sql`${t.environment} = 'research' and ${t.accountAlias} ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and ${t.ownerActorId} ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and ${t.threadId} ~ '^chat-[0-9a-f]{64}$' and ${t.idempotencyKey} ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'`
    ),
    check(
      "vertex_chat_thread_revision",
      sql`${t.revision} > 0 and ${t.lastSequence} >= 0 and ${t.revision} = ${t.lastSequence} + 1`
    ),
    check(
      "vertex_chat_thread_hashes",
      sql`${t.requestHash} ~ '^[0-9a-f]{64}$' and ${t.responseHash} ~ '^[0-9a-f]{64}$' and ${t.recordHash} ~ '^[0-9a-f]{64}$'`
    ),
    check(
      "vertex_chat_thread_request",
      sql`(jsonb_typeof(${t.request}) = 'object' and ${t.request}->>'operation' = 'createThread' and ${t.request}->>'actorId' = ${t.ownerActorId} and ${t.request}->'input'->>'accountAlias' = ${t.accountAlias} and ${t.request}->'input'->>'environment' = ${t.environment} and ${t.request}->'input'->>'idempotencyKey' = ${t.idempotencyKey}) is true`
    ),
    check(
      "vertex_chat_thread_payload",
      sql`(jsonb_typeof(${t.payload}) = 'object' and ${t.payload}->>'schemaVersion' = '1.0.0' and ${t.payload}->'executionAuthorized' = 'false'::jsonb and ${t.payload}->>'accountAlias' = ${t.accountAlias} and ${t.payload}->>'environment' = ${t.environment} and ${t.payload}->>'ownerActorId' = ${t.ownerActorId} and ${t.payload}->>'threadId' = ${t.threadId} and ${t.payload}->>'revision' = ${t.revision}::text and ${t.payload}->>'createdAt' = ${t.createdAt} and ${t.payload}->>'updatedAt' = ${t.updatedAt} and jsonb_typeof(${t.payload}->'title') = 'string' and ${t.payload}->'title' = ${t.request}->'input'->'title' and jsonb_typeof(${t.payload}->'participantIds') = 'array' and jsonb_array_length(${t.payload}->'participantIds') between 1 and 16 and ${t.payload}->'participantIds' = ${t.request}->'input'->'participantIds') is true`
    ),
    check(
      "vertex_chat_thread_original",
      sql`(${t.response} = jsonb_set(jsonb_set(${t.payload}, '{revision}', '"1"'::jsonb), '{updatedAt}', to_jsonb(${t.createdAt}))) is true`
    ),
  ]
);

export const vertexResearchChatMessages = pgTable(
  "vertex_research_chat_messages",
  {
    ...ownerScope(),
    threadId: text("thread_id").notNull(),
    messageId: text("message_id").notNull(),
    sequence: ordinal("sequence"),
    recordedAt: text("recorded_at").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    request: record("request"),
    requestHash: text("request_hash").notNull(),
    payload: record("payload"),
    recordHash: text("record_hash").notNull(),
    response: record("response"),
    responseHash: text("response_hash").notNull(),
  },
  (t) => [
    primaryKey({
      name: "vertex_chat_message_identity",
      columns: [
        t.accountAlias,
        t.environment,
        t.ownerActorId,
        t.threadId,
        t.messageId,
      ],
    }),
    uniqueIndex("vertex_chat_message_sequence").on(
      t.accountAlias,
      t.environment,
      t.ownerActorId,
      t.threadId,
      t.sequence
    ),
    uniqueIndex("vertex_chat_message_idempotency").on(
      t.accountAlias,
      t.environment,
      t.ownerActorId,
      t.threadId,
      t.idempotencyKey
    ),
    // Actual response identity, not the caller's human idempotency namespace.
    uniqueIndex("vertex_chat_message_original_response")
      .on(
        t.accountAlias,
        t.environment,
        sql`(${t.payload}->'response'->>'responseRequestId')`
      )
      .where(sql`${t.request}->>'operation' = 'appendResponse'`),
    foreignKey({
      name: "vertex_chat_message_thread",
      columns: [t.accountAlias, t.environment, t.ownerActorId, t.threadId],
      foreignColumns: [
        vertexResearchChatThreads.accountAlias,
        vertexResearchChatThreads.environment,
        vertexResearchChatThreads.ownerActorId,
        vertexResearchChatThreads.threadId,
      ],
    }).onDelete("restrict"),
    check(
      "vertex_chat_message_scope",
      sql`${t.environment} = 'research' and ${t.messageId} ~ '^message-[0-9a-f]{64}$' and ${t.idempotencyKey} ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'`
    ),
    check(
      "vertex_chat_message_sequence_bound",
      sql`${t.sequence} > 0 and ${t.sequence} < 999999999999999999999999999999`
    ),
    check(
      "vertex_chat_message_hashes",
      sql`${t.requestHash} ~ '^[0-9a-f]{64}$' and ${t.responseHash} ~ '^[0-9a-f]{64}$' and ${t.recordHash} ~ '^[0-9a-f]{64}$'`
    ),
    // The original human predicates remain verbatim as their own branches.
    check(
      "vertex_chat_message_request",
      sql`
    ((jsonb_typeof(${t.request}) = 'object' and ${t.request}->>'operation' = 'sendMessage' and ${t.request}->>'actorId' = ${t.ownerActorId} and ${t.request}->'input'->>'accountAlias' = ${t.accountAlias} and ${t.request}->'input'->>'environment' = ${t.environment} and ${t.request}->'input'->>'threadId' = ${t.threadId} and ${t.request}->'input'->>'idempotencyKey' = ${t.idempotencyKey} and ${t.request}->'input'->>'expectedRevision' = ${t.sequence}::text and ${t.request}->'input'->>'mode' in ('discuss','debate') and jsonb_typeof(${t.request}->'input'->'requestedParticipantIds') = 'array' and jsonb_array_length(${t.request}->'input'->'requestedParticipantIds') between 0 and 8) is true)
    or ((
      ${t.request} = jsonb_build_object('operation','appendResponse','actorId',${t.ownerActorId},'input',
        jsonb_build_object('accountAlias',${t.accountAlias},'environment',${t.environment},'threadId',${t.threadId},
          'responseRequestId',${t.payload} #>> '{response,responseRequestId}','expectedRevision',${t.sequence}::text))
      and ${t.idempotencyKey} = 'append-' || (${t.payload} #>> '{response,responseRequestId}')
      and ${t.payload} #>> '{response,responseRequestId}' ~ '^response-[0-9a-f]{64}$'
    ) is true)
  `
    ),
    check(
      "vertex_chat_message_payload",
      sql`
    (${t.request}->>'operation' = 'sendMessage' and
    ((jsonb_typeof(${t.payload}) = 'object' and ${t.payload}->>'schemaVersion' = '1.0.0' and ${t.payload}->'executionAuthorized' = 'false'::jsonb and ${t.payload}->>'threadId' = ${t.threadId} and ${t.payload}->>'messageId' = ${t.messageId} and ${t.payload}->>'sequence' = ${t.sequence}::text and ${t.payload}->'author' = jsonb_build_object('kind','user','actorId',${t.ownerActorId}) and ${t.payload}->>'kind' = 'statement' and jsonb_typeof(${t.payload}->'body') = 'string' and ${t.payload}->'body' = ${t.request}->'input'->'body' and ${t.payload}->'citations' = '[]'::jsonb and ${t.payload}->>'recordedAt' = ${t.recordedAt}) is true)
    )
    or ((
      ${t.request}->>'operation' = 'appendResponse'
      and ${t.payload} = jsonb_build_object(
        'schemaVersion','1.0.0','executionAuthorized',false,'threadId',${t.threadId},'messageId',${t.messageId},
        'sequence',${t.sequence}::text,'recordedAt',${t.recordedAt},'kind','advisory-reference',
        'author',jsonb_build_object('kind','agent','participantId',${t.payload} #>> '{author,participantId}','runId',${t.payload} #>> '{author,runId}'),
        'parentMessageId',${t.payload}->>'parentMessageId','replyToMessageId',${t.payload}->>'replyToMessageId',
        'response',jsonb_build_object(
          'responseRequestId',${t.payload} #>> '{response,responseRequestId}',
          'planId',${t.payload} #>> '{response,planId}','planSha256',${t.payload} #>> '{response,planSha256}',
          'requestSha256',${t.payload} #>> '{response,requestSha256}','contextSha256',${t.payload} #>> '{response,contextSha256}',
          'snapshotRevision',${t.payload} #>> '{response,snapshotRevision}','contextStartSequence',${t.payload} #>> '{response,contextStartSequence}',
          'jobId',${t.payload} #>> '{response,jobId}','traceId',${t.payload} #>> '{response,traceId}','eventId',${t.payload} #>> '{response,eventId}',
          'runArtifact',jsonb_build_object('artifactId',${t.payload} #>> '{author,runId}','artifactSha256',${t.payload} #>> '{response,runArtifact,artifactSha256}'),
          'advisoryArtifact',jsonb_build_object('artifactId',${t.payload} #>> '{response,advisoryArtifact,artifactId}','artifactSha256',${t.payload} #>> '{response,advisoryArtifact,artifactSha256}'),
          'fenceAcknowledgementsSha256',${t.payload} #>> '{response,fenceAcknowledgementsSha256}'))
      and ${t.sequence} > 1
      and ${t.payload}->>'parentMessageId' ~ '^message-[0-9a-f]{64}$'
      and ${t.payload}->>'replyToMessageId' ~ '^message-[0-9a-f]{64}$'
      and ${t.payload}->>'parentMessageId' <> ${t.messageId}
      and ${t.payload}->>'replyToMessageId' <> ${t.messageId}
      and ${t.payload} #>> '{author,participantId}' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      and ${t.payload} #>> '{author,runId}' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      and ${t.payload} #>> '{response,responseRequestId}' ~ '^response-[0-9a-f]{64}$'
      and ${t.payload} #>> '{response,planId}' = 'chat-plan-' || (${t.payload} #>> '{response,planSha256}')
      and ${t.payload} #>> '{response,planSha256}' ~ '^[0-9a-f]{64}$'
      and ${t.payload} #>> '{response,requestSha256}' ~ '^[0-9a-f]{64}$'
      and ${t.payload} #>> '{response,contextSha256}' ~ '^[0-9a-f]{64}$'
      and ${t.payload} #>> '{response,jobId}' ~ '^job-[0-9a-f]{64}$'
      and ${t.payload} #>> '{response,traceId}' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      and ${t.payload} #>> '{response,eventId}' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      and ${t.payload} #>> '{response,runArtifact,artifactSha256}' ~ '^[0-9a-f]{64}$'
      and ${t.payload} #>> '{response,advisoryArtifact,artifactId}' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      and ${t.payload} #>> '{response,advisoryArtifact,artifactSha256}' ~ '^[0-9a-f]{64}$'
      and ${t.payload} #>> '{response,fenceAcknowledgementsSha256}' ~ '^[0-9a-f]{64}$'
      and ${t.payload} #>> '{response,snapshotRevision}' ~ '^[1-9][0-9]{0,29}$'
      and ${t.payload} #>> '{response,contextStartSequence}' ~ '^[1-9][0-9]{0,29}$'
      and (${t.payload} #>> '{response,snapshotRevision}')::numeric between 2 and ${t.sequence}
      and (${t.payload} #>> '{response,snapshotRevision}')::numeric - (${t.payload} #>> '{response,contextStartSequence}')::numeric between 1 and 16
    ) is true)
  `
    ),
    check(
      "vertex_chat_message_ack",
      sql`
    (${t.request}->>'operation' = 'sendMessage' and
    ((jsonb_typeof(${t.response}) = 'object' and ${t.response}->>'schemaVersion' = '1.0.0' and ${t.response}->'executionAuthorized' = 'false'::jsonb and ${t.response}->'message' = ${t.payload} and ${t.response}->>'threadRevision' = (${t.sequence} + 1)::text and ${t.response}->'response' = case when jsonb_array_length(${t.request}->'input'->'requestedParticipantIds') = 0 then '{"status":"not-requested","runId":null,"jobId":null,"reasonCodes":[]}'::jsonb else '{"status":"unavailable","runId":null,"jobId":null,"reasonCodes":["research-chat-agent-admission-unavailable"]}'::jsonb end) is true)
    )
    or ((
      ${t.request}->>'operation' = 'appendResponse'
      and ${t.response} = jsonb_build_object('schemaVersion','1.0.0','executionAuthorized',false,'status','appended',
        'selector',jsonb_build_object('accountAlias',${t.accountAlias},'environment',${t.environment},'threadId',${t.threadId},'responseRequestId',${t.payload} #>> '{response,responseRequestId}'),
        'message',${t.payload},'threadRevision',(${t.sequence} + 1)::text)
    ) is true)
  `
    ),
  ]
);
