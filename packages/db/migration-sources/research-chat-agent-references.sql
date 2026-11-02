-- AUTHORED SOURCE ONLY. UNAPPLIED. No migration runner/generator was invoked.
-- Extend the existing message table; do not create a second history/authority.
-- Original human predicates are retained verbatim in their human branches.
-- Cross-row chronology and immutable origin joins are enforced by the internal
-- transaction owner; CHECK constraints cannot assert other rows or authority.
BEGIN;

ALTER TABLE "vertex_research_chat_messages"
  DROP CONSTRAINT "vertex_chat_message_request",
  DROP CONSTRAINT "vertex_chat_message_payload",
  DROP CONSTRAINT "vertex_chat_message_ack";

ALTER TABLE "vertex_research_chat_messages"
  ADD CONSTRAINT "vertex_chat_message_request" CHECK (
    ((jsonb_typeof(request) = 'object' and request->>'operation' = 'sendMessage' and request->>'actorId' = owner_actor_id and request->'input'->>'accountAlias' = account_alias and request->'input'->>'environment' = environment and request->'input'->>'threadId' = thread_id and request->'input'->>'idempotencyKey' = idempotency_key and request->'input'->>'expectedRevision' = sequence::text and request->'input'->>'mode' in ('discuss','debate') and jsonb_typeof(request->'input'->'requestedParticipantIds') = 'array' and jsonb_array_length(request->'input'->'requestedParticipantIds') between 0 and 8) is true)
    or ((
      request = jsonb_build_object('operation','appendResponse','actorId',owner_actor_id,'input',
        jsonb_build_object('accountAlias',account_alias,'environment',environment,'threadId',thread_id,
          'responseRequestId',payload #>> '{response,responseRequestId}','expectedRevision',sequence::text))
      and idempotency_key = 'append-' || (payload #>> '{response,responseRequestId}')
      and payload #>> '{response,responseRequestId}' ~ '^response-[0-9a-f]{64}$'
    ) is true)
  ),
  ADD CONSTRAINT "vertex_chat_message_payload" CHECK (
    (request->>'operation' = 'sendMessage' and
    ((jsonb_typeof(payload) = 'object' and payload->>'schemaVersion' = '1.0.0' and payload->'executionAuthorized' = 'false'::jsonb and payload->>'threadId' = thread_id and payload->>'messageId' = message_id and payload->>'sequence' = sequence::text and payload->'author' = jsonb_build_object('kind','user','actorId',owner_actor_id) and payload->>'kind' = 'statement' and jsonb_typeof(payload->'body') = 'string' and payload->'body' = request->'input'->'body' and payload->'citations' = '[]'::jsonb and payload->>'recordedAt' = recorded_at) is true)
    )
    or ((
      request->>'operation' = 'appendResponse'
      and payload = jsonb_build_object(
        'schemaVersion','1.0.0','executionAuthorized',false,'threadId',thread_id,'messageId',message_id,
        'sequence',sequence::text,'recordedAt',recorded_at,'kind','advisory-reference',
        'author',jsonb_build_object('kind','agent','participantId',payload #>> '{author,participantId}','runId',payload #>> '{author,runId}'),
        'parentMessageId',payload->>'parentMessageId','replyToMessageId',payload->>'replyToMessageId',
        'response',jsonb_build_object(
          'responseRequestId',payload #>> '{response,responseRequestId}',
          'planId',payload #>> '{response,planId}','planSha256',payload #>> '{response,planSha256}',
          'requestSha256',payload #>> '{response,requestSha256}','contextSha256',payload #>> '{response,contextSha256}',
          'snapshotRevision',payload #>> '{response,snapshotRevision}','contextStartSequence',payload #>> '{response,contextStartSequence}',
          'jobId',payload #>> '{response,jobId}','traceId',payload #>> '{response,traceId}','eventId',payload #>> '{response,eventId}',
          'runArtifact',jsonb_build_object('artifactId',payload #>> '{author,runId}','artifactSha256',payload #>> '{response,runArtifact,artifactSha256}'),
          'advisoryArtifact',jsonb_build_object('artifactId',payload #>> '{response,advisoryArtifact,artifactId}','artifactSha256',payload #>> '{response,advisoryArtifact,artifactSha256}'),
          'fenceAcknowledgementsSha256',payload #>> '{response,fenceAcknowledgementsSha256}'))
      and sequence > 1
      and payload->>'parentMessageId' ~ '^message-[0-9a-f]{64}$'
      and payload->>'replyToMessageId' ~ '^message-[0-9a-f]{64}$'
      and payload->>'parentMessageId' <> message_id
      and payload->>'replyToMessageId' <> message_id
      and payload #>> '{author,participantId}' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      and payload #>> '{author,runId}' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      and payload #>> '{response,responseRequestId}' ~ '^response-[0-9a-f]{64}$'
      and payload #>> '{response,planId}' = 'chat-plan-' || (payload #>> '{response,planSha256}')
      and payload #>> '{response,planSha256}' ~ '^[0-9a-f]{64}$'
      and payload #>> '{response,requestSha256}' ~ '^[0-9a-f]{64}$'
      and payload #>> '{response,contextSha256}' ~ '^[0-9a-f]{64}$'
      and payload #>> '{response,jobId}' ~ '^job-[0-9a-f]{64}$'
      and payload #>> '{response,traceId}' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      and payload #>> '{response,eventId}' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      and payload #>> '{response,runArtifact,artifactSha256}' ~ '^[0-9a-f]{64}$'
      and payload #>> '{response,advisoryArtifact,artifactId}' ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'
      and payload #>> '{response,advisoryArtifact,artifactSha256}' ~ '^[0-9a-f]{64}$'
      and payload #>> '{response,fenceAcknowledgementsSha256}' ~ '^[0-9a-f]{64}$'
      and payload #>> '{response,snapshotRevision}' ~ '^[1-9][0-9]{0,29}$'
      and payload #>> '{response,contextStartSequence}' ~ '^[1-9][0-9]{0,29}$'
      and (payload #>> '{response,snapshotRevision}')::numeric between 2 and sequence
      and (payload #>> '{response,snapshotRevision}')::numeric - (payload #>> '{response,contextStartSequence}')::numeric between 1 and 16
    ) is true)
  ),
  ADD CONSTRAINT "vertex_chat_message_ack" CHECK (
    (request->>'operation' = 'sendMessage' and
    ((jsonb_typeof(response) = 'object' and response->>'schemaVersion' = '1.0.0' and response->'executionAuthorized' = 'false'::jsonb and response->'message' = payload and response->>'threadRevision' = (sequence + 1)::text and response->'response' = case when jsonb_array_length(request->'input'->'requestedParticipantIds') = 0 then '{"status":"not-requested","runId":null,"jobId":null,"reasonCodes":[]}'::jsonb else '{"status":"unavailable","runId":null,"jobId":null,"reasonCodes":["research-chat-agent-admission-unavailable"]}'::jsonb end) is true)
    )
    or ((
      request->>'operation' = 'appendResponse'
      and response = jsonb_build_object('schemaVersion','1.0.0','executionAuthorized',false,'status','appended',
        'selector',jsonb_build_object('accountAlias',account_alias,'environment',environment,'threadId',thread_id,'responseRequestId',payload #>> '{response,responseRequestId}'),
        'message',payload,'threadRevision',(sequence + 1)::text)
    ) is true)
  );

-- One actual original response in its account/environment, irrespective of the
-- supplied human idempotency key, thread selector or claimed origin.
CREATE UNIQUE INDEX "vertex_chat_message_original_response"
  ON "vertex_research_chat_messages" ("account_alias", "environment", (payload->'response'->>'responseRequestId'))
  WHERE request->>'operation' = 'appendResponse';

COMMIT;
