-- SOURCE ONLY. UNAPPLIED. Retains the existing immutable unavailable branch.
-- Apply only with research-chat-worker-origin.sql and source application owners.
ALTER TABLE vertex_command_receipts DROP CONSTRAINT vertex_chat_response_result;
ALTER TABLE vertex_command_receipts ADD CONSTRAINT vertex_chat_response_result CHECK(kind <> 'research-chat-response' OR (
  result = jsonb_build_object(
    'schemaVersion','1.0.0','executionAuthorized',false,
    'accountAlias',account_alias,'environment',environment,
    'threadId',command #> '{input,threadId}','ownerActorId',actor_id,
    'responseRequestId',idempotency_key,'parentMessageId',command #> '{input,parentMessageId}',
    'participantId',command #> '{input,participantId}','idempotencyKey',command #> '{input,idempotencyKey}',
    'requestSha256',request_hash,'recordedAt',committed_at,
    'snapshotRevision',command #> '{input,snapshotRevision}','contextStartSequence',command #> '{input,contextStartSequence}',
    'status',result->>'status',
    'reasonCodes',CASE WHEN result->>'status' = 'admitted' THEN '[]'::jsonb ELSE '["research-runtime-unavailable"]'::jsonb END,
    'admission',CASE WHEN result->>'status' = 'admitted' THEN result->'admission' ELSE 'null'::jsonb END,'jobId',NULL
  ) AND result->>'status' IN ('unavailable','admitted') AND
  (result->>'status' = 'unavailable' OR (
    result->'admission' = jsonb_build_object(
      'bindingSha256',result #> '{admission,bindingSha256}','contextSha256',result #> '{admission,contextSha256}',
      'participantConfigSha256',result #> '{admission,participantConfigSha256}','collectionId',result #> '{admission,collectionId}',
      'proposal',jsonb_build_object('artifactId',result #> '{admission,proposal,artifactId}','sha256',result #> '{admission,proposal,sha256}'),
      'runId',result #> '{admission,runId}','eventId',result #> '{admission,eventId}'
    ) AND
    (result #>> '{admission,bindingSha256}') ~ '^[0-9a-f]{64}$' AND
    (result #>> '{admission,contextSha256}') ~ '^[0-9a-f]{64}$' AND
    (result #>> '{admission,participantConfigSha256}') ~ '^[0-9a-f]{64}$' AND
    (result #>> '{admission,proposal,sha256}') ~ '^[0-9a-f]{64}$' AND
    (result #>> '{admission,proposal,artifactId}') ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' AND
    (result #>> '{admission,collectionId}') ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$' AND
    (result #>> '{admission,runId}') ~ '^chat-run-[0-9a-f]{64}$' AND
    (result #>> '{admission,eventId}') ~ '^event-[0-9a-f]{64}$'
  ))
) IS TRUE);
