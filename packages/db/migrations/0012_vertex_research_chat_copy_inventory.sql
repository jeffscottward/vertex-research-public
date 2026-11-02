-- SOURCE ONLY: never applied as part of this slice. No grant is issued here.
-- Metadata is not body existence, content-I/O permission or physical cleanup.
-- Hash/key derivation, nanosecond equality, aggregate bounds and the complete
-- normalized DAG are checked by VertexStore under its existing scope locks.
ALTER TABLE "vertex_grant_actions" DROP CONSTRAINT "vertex_grant_action";
--> statement-breakpoint
ALTER TABLE "vertex_grant_actions" ADD CONSTRAINT "vertex_grant_action" CHECK ("action" in ('read','publish','review','admit-paper-simulation','project','manage-rights','dispatch-outbox','cleanup-chat-copies'));
--> statement-breakpoint
CREATE TABLE "vertex_research_chat_copy_families" (
  "account_alias" text NOT NULL, "environment" text NOT NULL, "response_request_id" text NOT NULL,
  "owner_actor_id" text NOT NULL, "thread_id" text NOT NULL, "request_idempotency_key" text NOT NULL,
  "request_sha256" text NOT NULL, "storage_profile_sha256" text NOT NULL,
  "created_at" text NOT NULL, "created_at_ns" numeric(30,0) NOT NULL,
  "payload" jsonb NOT NULL, "record_hash" text NOT NULL,
  CONSTRAINT "vertex_copy_family_pk" PRIMARY KEY ("response_request_id"),
  CONSTRAINT "vertex_copy_family_thread" FOREIGN KEY ("account_alias","environment","owner_actor_id","thread_id") REFERENCES "vertex_research_chat_threads" ("account_alias","environment","owner_actor_id","thread_id") ON DELETE RESTRICT,
  CONSTRAINT "vertex_copy_family_scope_check" CHECK ("environment" = 'research' and "response_request_id" ~ '^response-[0-9a-f]{64}$' and length("response_request_id") = 73 and "owner_actor_id" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and "owner_actor_id" !~ '[^A-Za-z0-9_.:-]' and "request_idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and "request_idempotency_key" !~ '[^A-Za-z0-9_.:-]'),
  CONSTRAINT "vertex_copy_family_hashes" CHECK ("request_sha256" ~ '^[0-9a-f]{64}$' and length("request_sha256") = 64 and "storage_profile_sha256" ~ '^[0-9a-f]{64}$' and length("storage_profile_sha256") = 64 and "record_hash" ~ '^[0-9a-f]{64}$' and length("record_hash") = 64),
  CONSTRAINT "vertex_copy_family_payload" CHECK (("payload" = jsonb_build_object(
    'profile','vertex-research-chat-copy-family-v1','accountAlias',"account_alias",'environment',"environment",'ownerActorId',"owner_actor_id",'threadId',"thread_id",'responseRequestId',"response_request_id",'requestSha256',"request_sha256",'storageProfileSha256',"storage_profile_sha256",'createdAt',"created_at",
    'requestMetadata',jsonb_build_object('accountAlias',"account_alias",'environment',"environment",'threadId',"thread_id",'idempotencyKey',"request_idempotency_key",'parentMessageId',"payload" #> '{requestMetadata,parentMessageId}','participantId',"payload" #> '{requestMetadata,participantId}','snapshotRevision',"payload" #> '{requestMetadata,snapshotRevision}','contextStartSequence',"payload" #> '{requestMetadata,contextStartSequence}'))
    and jsonb_typeof("payload" #> '{requestMetadata,parentMessageId}') = 'string'
    and ("payload" #>> '{requestMetadata,parentMessageId}') ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and ("payload" #>> '{requestMetadata,parentMessageId}') !~ '[^A-Za-z0-9_.:-]'
    and jsonb_typeof("payload" #> '{requestMetadata,participantId}') = 'string'
    and ("payload" #>> '{requestMetadata,participantId}') ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and ("payload" #>> '{requestMetadata,participantId}') !~ '[^A-Za-z0-9_.:-]'
    and jsonb_typeof("payload" #> '{requestMetadata,snapshotRevision}') = 'string' and jsonb_typeof("payload" #> '{requestMetadata,contextStartSequence}') = 'string'
    and case when ("payload" #>> '{requestMetadata,snapshotRevision}') ~ '^[1-9][0-9]{0,29}$' and ("payload" #>> '{requestMetadata,snapshotRevision}') !~ '[^0-9]' and ("payload" #>> '{requestMetadata,contextStartSequence}') ~ '^[1-9][0-9]{0,29}$' and ("payload" #>> '{requestMetadata,contextStartSequence}') !~ '[^0-9]'
      then ("payload" #>> '{requestMetadata,snapshotRevision}')::numeric >= 2 and ("payload" #>> '{requestMetadata,snapshotRevision}')::numeric - ("payload" #>> '{requestMetadata,contextStartSequence}')::numeric between 1 and 16 else false end) is true)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_copy_family_scope" ON "vertex_research_chat_copy_families" ("account_alias","environment","response_request_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_copy_family_owner" ON "vertex_research_chat_copy_families" ("account_alias","environment","response_request_id","owner_actor_id","thread_id","request_sha256","storage_profile_sha256");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_copy_family_request" ON "vertex_research_chat_copy_families" ("account_alias","environment","owner_actor_id","thread_id","request_idempotency_key");
--> statement-breakpoint
CREATE TABLE "vertex_research_chat_copy_allocations" (
  "account_alias" text NOT NULL, "environment" text NOT NULL, "response_request_id" text NOT NULL,
  "owner_actor_id" text NOT NULL, "thread_id" text NOT NULL, "request_sha256" text NOT NULL,
  "copy_id" text NOT NULL, "copy_idempotency_key" text NOT NULL, "kind" text NOT NULL,
  "storage_profile_sha256" text NOT NULL, "maximum_bytes" integer NOT NULL, "reservation_sha256" text NOT NULL,
  "object_key" text NOT NULL, "reserved_at" text NOT NULL, "reserved_at_ns" numeric(30,0) NOT NULL,
  "payload" jsonb NOT NULL, "record_hash" text NOT NULL,
  CONSTRAINT "vertex_copy_allocation_pk" PRIMARY KEY ("copy_id"),
  CONSTRAINT "vertex_copy_allocation_family" FOREIGN KEY ("account_alias","environment","response_request_id","owner_actor_id","thread_id","request_sha256","storage_profile_sha256") REFERENCES "vertex_research_chat_copy_families" ("account_alias","environment","response_request_id","owner_actor_id","thread_id","request_sha256","storage_profile_sha256") ON DELETE RESTRICT,
  CONSTRAINT "vertex_copy_allocation_shape" CHECK ("environment" = 'research' and "copy_id" ~ '^chat-copy-[0-9a-f]{64}$' and length("copy_id") = 74 and "copy_idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and "copy_idempotency_key" !~ '[^A-Za-z0-9_.:-]' and "kind" in ('context','model-input','derived-output') and "maximum_bytes" between 1 and 16777216 and octet_length("object_key") between 1 and 1024 and "object_key" like 'vertex/chat-copy/v1/%' and "reservation_sha256" ~ '^[0-9a-f]{64}$' and length("reservation_sha256") = 64 and "record_hash" ~ '^[0-9a-f]{64}$' and length("record_hash") = 64),
  CONSTRAINT "vertex_copy_allocation_payload" CHECK (("payload" = jsonb_build_object(
    'profile','vertex-research-chat-copy-allocation-v1','scope',jsonb_build_object('accountAlias',"account_alias",'environment',"environment"),'ownerActorId',"owner_actor_id",'threadId',"thread_id",'responseRequestId',"response_request_id",'requestSha256',"request_sha256",'copyId',"copy_id",'copyIdempotencyKey',"copy_idempotency_key",'kind',"kind",'storageProfileSha256',"storage_profile_sha256",'maximumBytes',"maximum_bytes",'parentCopyIds',"payload"->'parentCopyIds','reservationSha256',"reservation_sha256",'reservedAt',"reserved_at",'objectKey',"object_key",
    'binding',jsonb_build_object('scope',jsonb_build_object('accountAlias',"account_alias",'environment',"environment"),'ownerActorId',"owner_actor_id",'threadId',"thread_id",'responseRequestId',"response_request_id",'copyId',"copy_id",'kind',"kind",'reservationSha256',"reservation_sha256",'storageProfileSha256',"storage_profile_sha256",'maximumBytes',"maximum_bytes",'content',null))
    and jsonb_typeof("payload"->'parentCopyIds') = 'array' and jsonb_array_length("payload"->'parentCopyIds') between 0 and 63
    and (("kind" = 'context' and "payload"->'parentCopyIds' = '[]'::jsonb) or ("kind" <> 'context' and jsonb_array_length("payload"->'parentCopyIds') > 0))
    and not jsonb_path_exists("payload"->'parentCopyIds', '$[*] ? (@.type() != "string" || !(@ like_regex "^chat-copy-[0-9a-f]{64}$"))')) is true)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_copy_allocation_scope" ON "vertex_research_chat_copy_allocations" ("account_alias","environment","response_request_id","copy_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_copy_allocation_reservation" ON "vertex_research_chat_copy_allocations" ("account_alias","environment","response_request_id","copy_id","reservation_sha256");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_copy_allocation_logical" ON "vertex_research_chat_copy_allocations" ("account_alias","environment","owner_actor_id","thread_id","response_request_id","kind","copy_idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_copy_allocation_object" ON "vertex_research_chat_copy_allocations" ("object_key");
--> statement-breakpoint
CREATE TABLE "vertex_research_chat_copy_content_bindings" (
  "account_alias" text NOT NULL, "environment" text NOT NULL, "response_request_id" text NOT NULL,
  "copy_id" text NOT NULL, "reservation_sha256" text NOT NULL, "content_sha256" text NOT NULL,
  "byte_length" integer NOT NULL, "bound_at" text NOT NULL, "bound_at_ns" numeric(30,0) NOT NULL,
  "payload" jsonb NOT NULL, "record_hash" text NOT NULL,
  CONSTRAINT "vertex_copy_content_pk" PRIMARY KEY ("copy_id"),
  CONSTRAINT "vertex_copy_content_allocation" FOREIGN KEY ("account_alias","environment","response_request_id","copy_id","reservation_sha256") REFERENCES "vertex_research_chat_copy_allocations" ("account_alias","environment","response_request_id","copy_id","reservation_sha256") ON DELETE RESTRICT,
  CONSTRAINT "vertex_copy_content_shape" CHECK ("byte_length" between 1 and 16777216 and "content_sha256" ~ '^[0-9a-f]{64}$' and length("content_sha256") = 64 and "record_hash" ~ '^[0-9a-f]{64}$' and length("record_hash") = 64),
  CONSTRAINT "vertex_copy_content_payload" CHECK (("payload" = jsonb_build_object('profile','vertex-research-chat-copy-content-binding-v1','scope',jsonb_build_object('accountAlias',"account_alias",'environment',"environment"),'responseRequestId',"response_request_id",'copyId',"copy_id",'reservationSha256',"reservation_sha256",'content',jsonb_build_object('sha256',"content_sha256",'byteLength',"byte_length"),'boundAt',"bound_at")) is true)
);
--> statement-breakpoint
CREATE TABLE "vertex_research_chat_copy_dependencies" (
  "account_alias" text NOT NULL, "environment" text NOT NULL, "response_request_id" text NOT NULL,
  "child_copy_id" text NOT NULL, "parent_copy_id" text NOT NULL,
  CONSTRAINT "vertex_copy_dependency_pk" PRIMARY KEY ("account_alias","environment","response_request_id","child_copy_id","parent_copy_id"),
  CONSTRAINT "vertex_copy_dependency_child" FOREIGN KEY ("account_alias","environment","response_request_id","child_copy_id") REFERENCES "vertex_research_chat_copy_allocations" ("account_alias","environment","response_request_id","copy_id") ON DELETE RESTRICT,
  CONSTRAINT "vertex_copy_dependency_parent" FOREIGN KEY ("account_alias","environment","response_request_id","parent_copy_id") REFERENCES "vertex_research_chat_copy_allocations" ("account_alias","environment","response_request_id","copy_id") ON DELETE RESTRICT,
  CONSTRAINT "vertex_copy_dependency_distinct" CHECK ("child_copy_id" <> "parent_copy_id")
);
--> statement-breakpoint
CREATE TABLE "vertex_research_chat_copy_closures" (
  "account_alias" text NOT NULL, "environment" text NOT NULL, "response_request_id" text NOT NULL,
  "closure_id" text NOT NULL, "closed_by_actor_id" text NOT NULL, "closed_at" text NOT NULL,
  "closed_at_ns" numeric(30,0) NOT NULL, "inventory_sha256" text NOT NULL,
  "payload" jsonb NOT NULL, "record_hash" text NOT NULL,
  CONSTRAINT "vertex_copy_closure_pk" PRIMARY KEY ("account_alias","environment","response_request_id"),
  CONSTRAINT "vertex_copy_closure_family" FOREIGN KEY ("account_alias","environment","response_request_id") REFERENCES "vertex_research_chat_copy_families" ("account_alias","environment","response_request_id") ON DELETE RESTRICT,
  CONSTRAINT "vertex_copy_closure_shape" CHECK ("closure_id" ~ '^copy-closure-[0-9a-f]{64}$' and length("closure_id") = 77 and "closed_by_actor_id" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and "closed_by_actor_id" !~ '[^A-Za-z0-9_.:-]' and "inventory_sha256" ~ '^[0-9a-f]{64}$' and length("inventory_sha256") = 64 and "record_hash" ~ '^[0-9a-f]{64}$' and length("record_hash") = 64),
  CONSTRAINT "vertex_copy_closure_payload" CHECK (("payload" = jsonb_build_object('profile','vertex-research-chat-copy-closure-v1','scope',jsonb_build_object('accountAlias',"account_alias",'environment',"environment"),'responseRequestId',"response_request_id",'closureId',"closure_id",'closedByActorId',"closed_by_actor_id",'closedAt',"closed_at",'inventorySha256',"inventory_sha256",'copyIds',"payload"->'copyIds') and jsonb_typeof("payload"->'copyIds') = 'array' and jsonb_array_length("payload"->'copyIds') between 1 and 64 and not jsonb_path_exists("payload"->'copyIds', '$[*] ? (@.type() != "string" || !(@ like_regex "^chat-copy-[0-9a-f]{64}$"))')) is true)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "vertex_copy_closure_identity" ON "vertex_research_chat_copy_closures" ("closure_id");
--> statement-breakpoint
-- No ordinary UPDATE/DELETE path can rewrite an original ACK or remove closure.
-- This is not a superuser/restore/backup-erasure guarantee or backend qualification.
CREATE FUNCTION "vertex_chat_copy_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'immutable chat copy metadata' USING ERRCODE = '23514';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "vertex_copy_family_immutable" BEFORE UPDATE OR DELETE ON "vertex_research_chat_copy_families" FOR EACH ROW EXECUTE FUNCTION "vertex_chat_copy_immutable"();
--> statement-breakpoint
CREATE TRIGGER "vertex_copy_allocation_immutable" BEFORE UPDATE OR DELETE ON "vertex_research_chat_copy_allocations" FOR EACH ROW EXECUTE FUNCTION "vertex_chat_copy_immutable"();
--> statement-breakpoint
CREATE TRIGGER "vertex_copy_content_immutable" BEFORE UPDATE OR DELETE ON "vertex_research_chat_copy_content_bindings" FOR EACH ROW EXECUTE FUNCTION "vertex_chat_copy_immutable"();
--> statement-breakpoint
CREATE TRIGGER "vertex_copy_dependency_immutable" BEFORE UPDATE OR DELETE ON "vertex_research_chat_copy_dependencies" FOR EACH ROW EXECUTE FUNCTION "vertex_chat_copy_immutable"();
--> statement-breakpoint
CREATE TRIGGER "vertex_copy_closure_immutable" BEFORE UPDATE OR DELETE ON "vertex_research_chat_copy_closures" FOR EACH ROW EXECUTE FUNCTION "vertex_chat_copy_immutable"();
