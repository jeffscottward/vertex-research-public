-- Source-only forward extension; legacy receipt semantics and migration history are unchanged.
-- Canonical hashes/physical-key derivation and nanosecond time verification remain in the receipt owner.
ALTER TABLE "vertex_command_receipts" DROP CONSTRAINT "vertex_command_kind";
--> statement-breakpoint
ALTER TABLE "vertex_command_receipts" ADD CONSTRAINT "vertex_command_kind" CHECK ("kind" in ('review','research','simulation','research-chat-response'));
--> statement-breakpoint
ALTER TABLE "vertex_command_receipts" ADD CONSTRAINT "vertex_chat_response_scope" CHECK ("kind" <> 'research-chat-response' or (
    "environment" = 'research' and
    "account_alias" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and
    "actor_id" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and
    "idempotency_key" ~ '^response-[0-9a-f]{64}$' and
    "collection_key" = '' and "target_artifact_id" is null and
    "review_id" is null and "admission_id" is null
  ) is true);
--> statement-breakpoint
ALTER TABLE "vertex_command_receipts" ADD CONSTRAINT "vertex_chat_response_command" CHECK ("kind" <> 'research-chat-response' or (
    "command" = jsonb_build_object(
      'profile', 'vertex-research-chat-response-command-v1',
      'operation', 'requestResponse', 'actorId', "actor_id",
      'input', jsonb_build_object(
        'accountAlias', "account_alias", 'environment', "environment",
        'threadId', "command" #> '{input,threadId}',
        'parentMessageId', "command" #> '{input,parentMessageId}',
        'participantId', "command" #> '{input,participantId}',
        'snapshotRevision', "command" #> '{input,snapshotRevision}',
        'contextStartSequence', "command" #> '{input,contextStartSequence}',
        'idempotencyKey', "command" #> '{input,idempotencyKey}'
      )
    ) and
    jsonb_typeof("command" #> '{input,threadId}') = 'string' and
    ("command" #>> '{input,threadId}') ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and
    jsonb_typeof("command" #> '{input,parentMessageId}') = 'string' and
    ("command" #>> '{input,parentMessageId}') ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and
    jsonb_typeof("command" #> '{input,participantId}') = 'string' and
    ("command" #>> '{input,participantId}') ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and
    jsonb_typeof("command" #> '{input,idempotencyKey}') = 'string' and
    ("command" #>> '{input,idempotencyKey}') ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' and
    jsonb_typeof("command" #> '{input,snapshotRevision}') = 'string' and
    jsonb_typeof("command" #> '{input,contextStartSequence}') = 'string' and
    case when
      ("command" #>> '{input,snapshotRevision}') ~ '^[1-9][0-9]{0,29}$' and
      ("command" #>> '{input,contextStartSequence}') ~ '^[1-9][0-9]{0,29}$'
    then ("command" #>> '{input,snapshotRevision}')::numeric >= 2 and
      ("command" #>> '{input,snapshotRevision}')::numeric - ("command" #>> '{input,contextStartSequence}')::numeric between 1 and 16
    else false end
  ) is true);
--> statement-breakpoint
ALTER TABLE "vertex_command_receipts" ADD CONSTRAINT "vertex_chat_response_result" CHECK ("kind" <> 'research-chat-response' or (
    "result" = jsonb_build_object(
      'schemaVersion', '1.0.0', 'executionAuthorized', false,
      'accountAlias', "account_alias", 'environment', "environment",
      'threadId', "command" #> '{input,threadId}', 'ownerActorId', "actor_id",
      'responseRequestId', "idempotency_key",
      'parentMessageId', "command" #> '{input,parentMessageId}',
      'participantId', "command" #> '{input,participantId}',
      'idempotencyKey', "command" #> '{input,idempotencyKey}',
      'requestSha256', "request_hash", 'recordedAt', "committed_at",
      'snapshotRevision', "command" #> '{input,snapshotRevision}',
      'contextStartSequence', "command" #> '{input,contextStartSequence}',
      'status', 'unavailable', 'reasonCodes', '["research-runtime-unavailable"]'::jsonb,
      'admission', null, 'jobId', null
    )
  ) is true);
