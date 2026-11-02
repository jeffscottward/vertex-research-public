-- SOURCE ONLY. Explicit account-originated intent is not generic closure or
-- physical cleanup evidence. No grants, content I/O, jobs or runtime activation.
CREATE UNIQUE INDEX "vertex_copy_family_cleanup_owner" ON "vertex_research_chat_copy_families" ("account_alias", "environment", "response_request_id", "owner_actor_id", "thread_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_copy_closure_cleanup_link" ON "vertex_research_chat_copy_closures" ("account_alias", "environment", "response_request_id", "closure_id", "inventory_sha256");
--> statement-breakpoint
CREATE TABLE "vertex_research_chat_copy_cleanup_intents" (
  "account_alias" text NOT NULL,
  "environment" text NOT NULL,
  "response_request_id" text NOT NULL,
  "payload" jsonb NOT NULL,
  "record_hash" text NOT NULL,
  "owner_actor_id" text NOT NULL,
  "thread_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "cleanup_request_id" text NOT NULL,
  "request_sha256" text NOT NULL,
  "recorded_at" text NOT NULL,
  "recorded_at_ns" numeric(30,0) NOT NULL,
  "closure_id" text NOT NULL,
  "inventory_sha256" text NOT NULL,
  CONSTRAINT "vertex_copy_cleanup_pk" PRIMARY KEY ("cleanup_request_id"),
  CONSTRAINT "vertex_copy_cleanup_family" FOREIGN KEY ("account_alias", "environment", "response_request_id", "owner_actor_id", "thread_id") REFERENCES "vertex_research_chat_copy_families" ("account_alias", "environment", "response_request_id", "owner_actor_id", "thread_id") ON DELETE RESTRICT,
  CONSTRAINT "vertex_copy_cleanup_closure" FOREIGN KEY ("account_alias", "environment", "response_request_id", "closure_id", "inventory_sha256") REFERENCES "vertex_research_chat_copy_closures" ("account_alias", "environment", "response_request_id", "closure_id", "inventory_sha256") ON DELETE RESTRICT,
  CONSTRAINT "vertex_copy_cleanup_scope" CHECK ("environment" = 'research' and "account_alias" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and "account_alias" !~ '[^A-Za-z0-9_.:-]' and "owner_actor_id" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and "owner_actor_id" !~ '[^A-Za-z0-9_.:-]' and "thread_id" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and "thread_id" !~ '[^A-Za-z0-9_.:-]' and "idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and "idempotency_key" !~ '[^A-Za-z0-9_.:-]' and "response_request_id" ~ '^response-[0-9a-f]{64}$' and length("response_request_id") = 73),
  CONSTRAINT "vertex_copy_cleanup_identity" CHECK ("request_sha256" ~ '^[0-9a-f]{64}$' and length("request_sha256") = 64 and "cleanup_request_id" = 'copy-cleanup-' || "request_sha256" and "closure_id" ~ '^copy-closure-[0-9a-f]{64}$' and length("closure_id") = 77 and "inventory_sha256" ~ '^[0-9a-f]{64}$' and length("inventory_sha256") = 64 and "record_hash" ~ '^[0-9a-f]{64}$' and length("record_hash") = 64),
  CONSTRAINT "vertex_copy_cleanup_time" CHECK ("recorded_at" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,9})?Z$' and "recorded_at" !~ '[^0-9TZ.:-]'),
  CONSTRAINT "vertex_copy_cleanup_payload" CHECK (("payload" = jsonb_build_object('profile','vertex-research-chat-copy-explicit-cleanup-intent-v1','closureId',"closure_id",'inventorySha256',"inventory_sha256",'receipt',jsonb_build_object('schemaVersion','1.0.0','executionAuthorized',false,'status','requested','accountAlias',"account_alias",'environment',"environment",'threadId',"thread_id",'ownerActorId',"owner_actor_id",'responseRequestId',"response_request_id",'idempotencyKey',"idempotency_key",'cleanupRequestId',"cleanup_request_id",'requestSha256',"request_sha256",'recordedAt',"recorded_at",'targetKinds',jsonb_build_array('context','model-input','derived-output')))) is true)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_copy_cleanup_request" ON "vertex_research_chat_copy_cleanup_intents" ("account_alias", "environment", "owner_actor_id", "thread_id", "response_request_id", "idempotency_key");
--> statement-breakpoint
CREATE TRIGGER "vertex_copy_cleanup_immutable" BEFORE UPDATE OR DELETE ON "vertex_research_chat_copy_cleanup_intents" FOR EACH ROW EXECUTE FUNCTION "vertex_chat_copy_immutable"();
