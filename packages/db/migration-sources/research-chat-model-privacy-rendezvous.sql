-- SOURCE ONLY additive opt-in metadata. Adopt AFTER the existing chat execution
-- plan/privacy schema in a separately reviewed migration; nothing executes here.
-- No existing review/dispatch slot, journal, grant or copied-content table changes.
CREATE TABLE vertex_research_chat_model_privacy_candidates (
  account_alias text NOT NULL, environment text NOT NULL, response_request_id text NOT NULL, operation text NOT NULL,
  candidate_id text NOT NULL, plan_id text NOT NULL, plan_sha256 text NOT NULL,
  request_id text NOT NULL, request_sha256 text NOT NULL,
  submitted_at_ns numeric(30,0) NOT NULL, expires_at_ns numeric(30,0) NOT NULL,
  payload jsonb NOT NULL, record_hash text NOT NULL,
  PRIMARY KEY (account_alias, environment, response_request_id, operation),
  CONSTRAINT vertex_chat_model_candidate_plan_fk FOREIGN KEY (account_alias, environment, response_request_id, plan_id, plan_sha256)
    REFERENCES vertex_research_chat_execution_plans (account_alias, environment, response_request_id, plan_id, plan_sha256) ON DELETE RESTRICT,
  CONSTRAINT vertex_chat_model_candidate_scope CHECK (environment = 'research' AND operation IN ('model-tokenize','model-completion')),
  CONSTRAINT vertex_chat_model_candidate_window CHECK (expires_at_ns > submitted_at_ns AND expires_at_ns - submitted_at_ns <= 300000000000),
  CONSTRAINT vertex_chat_model_candidate_hashes CHECK (record_hash ~ '^[0-9a-f]{64}$' AND plan_sha256 ~ '^[0-9a-f]{64}$' AND request_sha256 ~ '^[0-9a-f]{64}$' AND candidate_id ~ '^chat-candidate-[0-9a-f]{64}$'),
  CONSTRAINT vertex_chat_model_candidate_payload CHECK ((
    jsonb_typeof(payload) = 'object' AND payload->>'profile' = 'vertex-first-mate-model-privacy-candidate-v1' AND
    payload->>'accountAlias' = account_alias AND payload->>'environment' = environment AND payload->>'candidateId' = candidate_id AND
    payload->>'responseRequestId' = response_request_id AND payload->>'planId' = plan_id AND payload->>'planSha256' = plan_sha256 AND
    payload->'request'->>'requestId' = request_id AND payload->'request'->>'requestSha256' = request_sha256 AND
    payload->'request'->>'accountAlias' = account_alias AND payload->'request'->>'environment' = environment AND payload->'request'->>'operation' = operation AND
    payload - ARRAY['profile','candidateId','accountAlias','environment','responseRequestId','planId','planSha256','request','submittedAt','expiresAt'] = '{}'::jsonb AND
    payload->'request' - ARRAY['schemaVersion','requestId','requestSha256','accountAlias','environment','researchPrincipalId','consumerServiceId','selectionId','selectionSha256','providerId','modelVersion','tokenizerArtifactId','tokenizerSha256','endpointReferenceId','endpointSha256','modelUsePolicyVersion','jobId','leaseId','leaseEpoch','grantId','grantVersion','operation','purpose','tools','evidence','inputSha256','inputBytes','inputTokens','maximumOutputTokens','maximumCostUsd','deadlineAt'] = '{}'::jsonb
  ) IS TRUE)
);
CREATE UNIQUE INDEX vertex_chat_model_candidate_id ON vertex_research_chat_model_privacy_candidates (account_alias, environment, candidate_id);
CREATE UNIQUE INDEX vertex_chat_model_candidate_request ON vertex_research_chat_model_privacy_candidates (account_alias, environment, request_id);
CREATE FUNCTION vertex_chat_model_candidate_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'chat model candidate metadata is immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER vertex_chat_model_candidate_no_update_delete
  BEFORE UPDATE OR DELETE ON vertex_research_chat_model_privacy_candidates
  FOR EACH ROW EXECUTE FUNCTION vertex_chat_model_candidate_immutable();
