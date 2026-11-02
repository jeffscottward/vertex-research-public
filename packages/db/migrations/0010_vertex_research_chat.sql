CREATE TABLE "vertex_research_chat_threads" (
  "account_alias" text NOT NULL,
  "environment" text NOT NULL,
  "owner_actor_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "revision" numeric(30,0) NOT NULL,
  "last_sequence" numeric(30,0) NOT NULL,
  "created_at" text NOT NULL,
  "updated_at" text NOT NULL,
  "request" jsonb NOT NULL,
  "request_hash" text NOT NULL,
  "response" jsonb NOT NULL,
  "response_hash" text NOT NULL,
  "payload" jsonb NOT NULL,
  "record_hash" text NOT NULL,
  CONSTRAINT "vertex_chat_thread_identity" PRIMARY KEY ("account_alias", "environment", "owner_actor_id", "thread_id"),
  CONSTRAINT "vertex_chat_thread_account" FOREIGN KEY ("account_alias", "environment") REFERENCES "vertex_account_aliases" ("account_alias", "environment") ON DELETE RESTRICT,
  CONSTRAINT "vertex_chat_thread_scope" CHECK ("environment" = 'research' and "account_alias" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and "owner_actor_id" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and "thread_id" ~ '^chat-[0-9a-f]{64}$' and "idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
  CONSTRAINT "vertex_chat_thread_revision" CHECK ("revision" > 0 and "last_sequence" >= 0 and "revision" = "last_sequence" + 1),
  CONSTRAINT "vertex_chat_thread_hashes" CHECK ("request_hash" ~ '^[0-9a-f]{64}$' and "response_hash" ~ '^[0-9a-f]{64}$' and "record_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "vertex_chat_thread_request" CHECK ((jsonb_typeof("request") = 'object' and "request"->>'operation' = 'createThread' and "request"->>'actorId' = "owner_actor_id" and "request"->'input'->>'accountAlias' = "account_alias" and "request"->'input'->>'environment' = "environment" and "request"->'input'->>'idempotencyKey' = "idempotency_key") is true),
  CONSTRAINT "vertex_chat_thread_payload" CHECK ((jsonb_typeof("payload") = 'object' and "payload"->>'schemaVersion' = '1.0.0' and "payload"->'executionAuthorized' = 'false'::jsonb and "payload"->>'accountAlias' = "account_alias" and "payload"->>'environment' = "environment" and "payload"->>'ownerActorId' = "owner_actor_id" and "payload"->>'threadId' = "thread_id" and "payload"->>'revision' = "revision"::text and "payload"->>'createdAt' = "created_at" and "payload"->>'updatedAt' = "updated_at" and jsonb_typeof("payload"->'title') = 'string' and "payload"->'title' = "request"->'input'->'title' and jsonb_typeof("payload"->'participantIds') = 'array' and jsonb_array_length("payload"->'participantIds') between 1 and 16 and "payload"->'participantIds' = "request"->'input'->'participantIds') is true),
  CONSTRAINT "vertex_chat_thread_original" CHECK (("response" = jsonb_set(jsonb_set("payload", '{revision}', '"1"'::jsonb), '{updatedAt}', to_jsonb("created_at"))) is true)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_chat_thread_idempotency" ON "vertex_research_chat_threads" USING btree ("account_alias", "environment", "owner_actor_id", "idempotency_key");
--> statement-breakpoint
CREATE INDEX "vertex_chat_thread_order" ON "vertex_research_chat_threads" USING btree ("account_alias", "environment", "owner_actor_id", "thread_id" COLLATE "C");
--> statement-breakpoint
CREATE TABLE "vertex_research_chat_messages" (
  "account_alias" text NOT NULL,
  "environment" text NOT NULL,
  "owner_actor_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "message_id" text NOT NULL,
  "sequence" numeric(30,0) NOT NULL,
  "recorded_at" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "request" jsonb NOT NULL,
  "request_hash" text NOT NULL,
  "payload" jsonb NOT NULL,
  "record_hash" text NOT NULL,
  "response" jsonb NOT NULL,
  "response_hash" text NOT NULL,
  CONSTRAINT "vertex_chat_message_identity" PRIMARY KEY ("account_alias", "environment", "owner_actor_id", "thread_id", "message_id"),
  CONSTRAINT "vertex_chat_message_thread" FOREIGN KEY ("account_alias", "environment", "owner_actor_id", "thread_id") REFERENCES "vertex_research_chat_threads" ("account_alias", "environment", "owner_actor_id", "thread_id") ON DELETE RESTRICT,
  CONSTRAINT "vertex_chat_message_scope" CHECK ("environment" = 'research' and "message_id" ~ '^message-[0-9a-f]{64}$' and "idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
  CONSTRAINT "vertex_chat_message_sequence_bound" CHECK ("sequence" > 0 and "sequence" < 999999999999999999999999999999),
  CONSTRAINT "vertex_chat_message_hashes" CHECK ("request_hash" ~ '^[0-9a-f]{64}$' and "response_hash" ~ '^[0-9a-f]{64}$' and "record_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "vertex_chat_message_request" CHECK ((jsonb_typeof("request") = 'object' and "request"->>'operation' = 'sendMessage' and "request"->>'actorId' = "owner_actor_id" and "request"->'input'->>'accountAlias' = "account_alias" and "request"->'input'->>'environment' = "environment" and "request"->'input'->>'threadId' = "thread_id" and "request"->'input'->>'idempotencyKey' = "idempotency_key" and "request"->'input'->>'expectedRevision' = "sequence"::text and "request"->'input'->>'mode' in ('discuss','debate') and jsonb_typeof("request"->'input'->'requestedParticipantIds') = 'array' and jsonb_array_length("request"->'input'->'requestedParticipantIds') between 0 and 8) is true),
  CONSTRAINT "vertex_chat_message_payload" CHECK ((jsonb_typeof("payload") = 'object' and "payload"->>'schemaVersion' = '1.0.0' and "payload"->'executionAuthorized' = 'false'::jsonb and "payload"->>'threadId' = "thread_id" and "payload"->>'messageId' = "message_id" and "payload"->>'sequence' = "sequence"::text and "payload"->'author' = jsonb_build_object('kind','user','actorId',"owner_actor_id") and "payload"->>'kind' = 'statement' and jsonb_typeof("payload"->'body') = 'string' and "payload"->'body' = "request"->'input'->'body' and "payload"->'citations' = '[]'::jsonb and "payload"->>'recordedAt' = "recorded_at") is true),
  CONSTRAINT "vertex_chat_message_ack" CHECK ((jsonb_typeof("response") = 'object' and "response"->>'schemaVersion' = '1.0.0' and "response"->'executionAuthorized' = 'false'::jsonb and "response"->'message' = "payload" and "response"->>'threadRevision' = ("sequence" + 1)::text and "response"->'response' = case when jsonb_array_length("request"->'input'->'requestedParticipantIds') = 0 then '{"status":"not-requested","runId":null,"jobId":null,"reasonCodes":[]}'::jsonb else '{"status":"unavailable","runId":null,"jobId":null,"reasonCodes":["research-chat-agent-admission-unavailable"]}'::jsonb end) is true)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_chat_message_sequence" ON "vertex_research_chat_messages" USING btree ("account_alias", "environment", "owner_actor_id", "thread_id", "sequence");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_chat_message_idempotency" ON "vertex_research_chat_messages" USING btree ("account_alias", "environment", "owner_actor_id", "thread_id", "idempotency_key");
