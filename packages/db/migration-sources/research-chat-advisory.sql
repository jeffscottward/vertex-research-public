-- SOURCE ONLY / UNAPPLIED. No live database, migration, provider, or readiness claim.
CREATE TABLE vertex_research_chat_advisory_origins (
  account_alias text NOT NULL,
  environment text NOT NULL CHECK (environment = 'research'),
  response_request_id text NOT NULL,
  job_id text NOT NULL,
  run_id text NOT NULL,
  plan_sha256 text NOT NULL CHECK (plan_sha256 ~ '^[0-9a-f]{64}$'),
  copy_id text NOT NULL,
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  request_sha256 text NOT NULL CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
  response_sha256 text NOT NULL CHECK (response_sha256 ~ '^[0-9a-f]{64}$'),
  record_hash text NOT NULL CHECK (record_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb NOT NULL,
  PRIMARY KEY (account_alias, environment, response_request_id),
  UNIQUE (account_alias, environment, job_id),
  UNIQUE (account_alias, environment, copy_id),
  FOREIGN KEY (account_alias, environment, response_request_id)
    REFERENCES vertex_research_chat_worker_origins (account_alias, environment, response_request_id) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_advisory_bodyless CHECK ((
    jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 32768 AND
    payload->>'profile' = 'vertex-research-chat-advisory-origin-v1' AND
    payload->>'accountAlias' = account_alias AND payload->>'environment' = environment AND
    payload->>'responseRequestId' = response_request_id AND payload->>'jobId' = job_id AND payload->>'runId' = run_id AND
    payload->>'planSha256' = plan_sha256 AND payload->>'copyId' = copy_id AND payload->>'contentSha256' = content_sha256 AND
    payload->>'modelUseRequestSha256' = request_sha256 AND payload->>'responseSha256' = response_sha256 AND
    (payload->>'byteLength')::bigint BETWEEN 1 AND 262144 AND
    payload - ARRAY['profile','accountAlias','environment','responseRequestId','planId','planSha256','originalRequestSha256','jobId','runId','traceId','eventId','recipeSha256','copyId','contentSha256','byteLength','modelUseRequestId','modelUseRequestSha256','postProofSha256','postProofCheckedAt','firstDispatchProofSha256','dispatchSha256','budgetSha256','privacyReviewId','privacyReviewSha256','responseSha256','usage','boundAt'] = '{}'::jsonb AND
    jsonb_typeof(payload->'usage') = 'object' AND payload->'usage' - ARRAY['inputTokens','outputTokens','totalTokens','completionCostUsd'] = '{}'::jsonb
  ) IS TRUE)
);
CREATE FUNCTION vertex_research_chat_advisory_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'research chat advisory provenance is immutable';
END;
$$;
CREATE TRIGGER vertex_chat_advisory_no_change BEFORE UPDATE OR DELETE ON vertex_research_chat_advisory_origins
  FOR EACH ROW EXECUTE FUNCTION vertex_research_chat_advisory_immutable();
CREATE TRIGGER vertex_chat_advisory_no_truncate BEFORE TRUNCATE ON vertex_research_chat_advisory_origins
  FOR EACH STATEMENT EXECUTE FUNCTION vertex_research_chat_advisory_immutable();
